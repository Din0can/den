import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { LayerManager, PlayerDungeon } from './layer-manager.js';
import { generateWing } from './src/map-generator.js';
import { generateSkeleton } from './src/skeleton-generator.js';
import { CHUNK_SIZE, CHUNK_VIEW_DIST, chunkKey, worldToChunk, chunkIndex } from './src/chunk.js';
import { nameToColor } from './src/name-color.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

const PORT = 3000;

// --- Layer setup ---
const layerManager = new LayerManager();

// Layer 0: Simple empty room
const L0_W = 30, L0_H = 20;
const l0Map = new Uint8Array(L0_W * L0_H);
for (let y = 0; y < L0_H; y++) {
  for (let x = 0; x < L0_W; x++) {
    if (x === 0 || x === L0_W - 1 || y === 0 || y === L0_H - 1) {
      l0Map[y * L0_W + x] = 1; // WALL
    } else {
      l0Map[y * L0_W + x] = 2; // FLOOR
    }
  }
}
const spawnX = Math.floor(L0_W / 2), spawnY = Math.floor(L0_H / 2);
l0Map[spawnY * L0_W + spawnX] = 7; // ENTRY
const l0Data = {
  map: l0Map, width: L0_W, height: L0_H,
  rooms: [{ x: 1, y: 1, w: L0_W - 2, h: L0_H - 2, cx: spawnX, cy: spawnY }],
  doors: [], overlay: [],
};
layerManager.createStaticLayer(0, l0Data);

// Dynamic layers created on-demand when players descend
const SERVER_SEED = Date.now();

function deriveLayerSeed(depth) {
  let s = SERVER_SEED;
  for (let i = 0; i < depth; i++) {
    s = ((s << 5) - s + 0x9E3779B9) | 0;
  }
  return s;
}

function ensureDynamicLayer(depth) {
  let layer = layerManager.getLayer(depth);
  if (!layer) {
    layer = layerManager.createDynamicLayer(depth, {
      seed: deriveLayerSeed(depth),
      skeletonDensity: 0.3,
      maxWidth: 160,
      maxHeight: 120,
    });
  }
  return layer;
}

// Player state
const players = new Map();

// Serve static files in production
app.use(express.static(join(__dirname, 'dist')));
app.get('/admini', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'admin.html'));
});
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

/** Materialize a dynamic layer if not already materialized */
function materializeLayer(layer) {
  if (layer.materialized) return;
  const boneData = generateSkeleton(layer.seed, layer.skeletonDensity, layer.bounds.maxX, layer.bounds.maxY);
  layer.materialize(boneData);
  console.log(`Layer ${layer.id} materialized`);
  // Notify admins
  adminiNs.emit('layerMaterialized', {
    layerId: layer.id,
    bones: serializeChunkMap(layer.bones),
  });
}

/** Dematerialize a dynamic layer */
function dematerializeLayer(layer) {
  if (!layer.materialized) return;
  layer.dematerialize();
  console.log(`Layer ${layer.id} dematerialized`);
  // Notify admins
  adminiNs.emit('layerDematerialized', { layerId: layer.id });
}

/** Serialize a chunk Map to array for network transfer */
function serializeChunkMap(chunkMap) {
  const chunks = [];
  for (const [key, data] of chunkMap) {
    const [cx, cy] = key.split(',').map(Number);
    chunks.push({
      cx, cy,
      tiles: Array.from(data.tiles),
      overlay: data.overlay || [],
      doors: data.doors || [],
    });
  }
  return chunks;
}

/** Get initial chunks for a player on a layer */
function getInitialChunks(layer, playerId, spawn) {
  const keys = layer.getChunkKeysAround(spawn.x, spawn.y, CHUNK_VIEW_DIST);
  if (layer.type === 'dynamic') {
    return layer.getChunksForPlayer(playerId, keys);
  }
  return layer.getChunksByKeys(keys);
}

/** Get requested chunks for a player */
function getRequestedChunks(layer, playerId, keys) {
  if (layer.type === 'dynamic') {
    return layer.getChunksForPlayer(playerId, keys);
  }
  return layer.getChunksByKeys(keys);
}

/** Notify admins that layer list changed (player join/leave/name/layer change) */
function broadcastLayerList() {
  adminiNs.emit('layerUpdate', getEnrichedLayers());
}

/** Get layers with player info for admin */
function getEnrichedLayers() {
  const result = [];
  for (const [id, layer] of layerManager.layers) {
    const layerPlayers = [];
    for (const pid of layer.players) {
      const p = players.get(pid);
      if (p) layerPlayers.push({ id: pid, name: p.name, color: p.color });
    }
    result.push({
      id,
      type: layer.type,
      bounds: layer.bounds,
      playerCount: layer.players.size,
      materialized: layer.type === 'dynamic' ? layer.materialized : undefined,
      players: layerPlayers,
    });
  }
  return result;
}

io.on('connection', (socket) => {
  const id = socket.id;
  let color = '#888888'; // Default until name is set

  // Assign to Layer 0
  const layerId = 0;
  const layer = layerManager.assignPlayer(id, layerId);
  const roomName = `layer:${layerId}`;
  socket.join(roomName);

  // Generate player wing for dynamic layers (materialize first if needed)
  if (layer.type === 'dynamic') {
    materializeLayer(layer);
    generatePlayerWing(layer, id);
  }

  const spawn = layer.getSpawn();
  players.set(id, { id, color, x: spawn.x, y: spawn.y, name: '', facing: 'south' });

  // Build same-layer player list
  const others = [];
  for (const [pid, p] of players) {
    if (pid !== id && layerManager.getPlayerLayerId(pid) === layerId) {
      others.push(p);
    }
  }

  // Send welcome with layer metadata + initial chunks
  const initialChunks = getInitialChunks(layer, id, spawn);
  socket.emit('welcome', {
    id,
    color,
    spawn,
    layerMeta: layer.getMeta(),
    initialChunks,
    players: others,
  });

  socket.to(roomName).emit('playerJoined', { id, color, spawn, name: '', facing: 'south' });
  console.log(`Player ${id} joined layer ${layerId} at (${spawn.x}, ${spawn.y})`);
  broadcastLayerList();

  // --- Chunk requests ---
  socket.on('requestChunks', (data) => {
    const playerLayer = layerManager.getPlayerLayer(id);
    if (!playerLayer) return;
    if (data.layerId !== layerManager.getPlayerLayerId(id)) return;

    const chunks = getRequestedChunks(playerLayer, id, data.keys);
    if (chunks.length > 0) {
      socket.emit('chunkData', { chunks });
    }
  });

  // --- Position updates (scoped to layer) ---
  socket.on('state', (data) => {
    const p = players.get(id);
    if (!p) return;

    if (data.x !== undefined) p.x = data.x;
    if (data.y !== undefined) p.y = data.y;
    if (data.facing) p.facing = data.facing;

    // Name-seeded color: compute on first name set
    if (data.name && data.name !== p.name) {
      p.name = data.name;
      color = nameToColor(data.name);
      p.color = color;
      broadcastLayerList();
    }

    data.id = id;
    data.color = color;
    const playerLayerId = layerManager.getPlayerLayerId(id);
    socket.to(`layer:${playerLayerId}`).volatile.emit('playerState', data);

    // Forward to admins watching this layer
    adminiNs.to(`admin:layer:${playerLayerId}`).volatile.emit('adminPlayerState', {
      id, x: p.x, y: p.y, name: p.name, color, facing: p.facing,
    });
  });

  // --- Door toggle (scoped to layer) ---
  socket.on('doorToggle', (data) => {
    const playerLayer = layerManager.getPlayerLayer(id);
    if (!playerLayer) return;

    let door = null;
    if (playerLayer.type === 'static') {
      door = playerLayer.doors?.find(d => d.id === data.doorId);
    } else {
      // Search bone doors first, then player's wing doors
      door = playerLayer.boneDoors?.find(d => d.id === data.doorId);
      if (!door) {
        const pd = playerLayer.playerDungeons.get(id);
        door = pd?.doors?.find(d => d.id === data.doorId);
      }
    }
    if (!door) return;

    const p = players.get(id);
    if (!p) return;

    // Check adjacency against ANY tile in the door group
    let adjacent = false;
    for (let i = 0; i < (door.length || 1); i++) {
      const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
      const ty = door.orientation === 'vertical' ? door.y + i : door.y;
      if (Math.abs(p.x - tx) + Math.abs(p.y - ty) <= 1) {
        adjacent = true;
        break;
      }
    }
    if (!adjacent) return;

    // Toggle door tiles in chunk storage
    door.isOpen = !door.isOpen;
    const tileType = door.isOpen ? 4 : 3; // DOOR_OPEN : DOOR_CLOSED
    const isWingDoor = door.id >= 10000; // wing doors have offset IDs

    for (let i = 0; i < (door.length || 1); i++) {
      const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
      const ty = door.orientation === 'vertical' ? door.y + i : door.y;

      if (playerLayer.type === 'static') {
        playerLayer.setTile(tx, ty, tileType);
      } else if (isWingDoor) {
        // Update wing chunk for this player
        const pd = playerLayer.playerDungeons.get(id);
        if (pd) {
          const { cx, cy, lx, ly } = worldToChunk(tx, ty);
          const chunk = pd.chunks.get(chunkKey(cx, cy));
          if (chunk) chunk.tiles[chunkIndex(lx, ly)] = tileType;
        }
      } else {
        // Update bone chunk (shared)
        playerLayer.setTile(tx, ty, tileType);
      }
    }

    const playerLayerId = layerManager.getPlayerLayerId(id);
    io.to(`layer:${playerLayerId}`).emit('doorState', { doorId: door.id, isOpen: door.isOpen });
  });

  // --- Shared transition logic ---
  function executeTransition(targetLayerId) {
    const oldLayerId = layerManager.getPlayerLayerId(id);
    const oldLayer = layerManager.getLayer(oldLayerId);
    const oldRoom = `layer:${oldLayerId}`;

    // Remove wing exit before leaving dynamic layer
    if (oldLayer && oldLayer.type === 'dynamic') {
      removeWingExit(oldLayer, id);
    }

    // Leave old layer
    socket.leave(oldRoom);
    socket.to(oldRoom).emit('playerLeft', { id });

    // Join new layer
    const newLayer = layerManager.assignPlayer(id, targetLayerId);
    const newRoom = `layer:${targetLayerId}`;
    socket.join(newRoom);

    // Delete old dynamic layer if now empty
    if (oldLayer && oldLayer.type === 'dynamic' && oldLayer.players.size === 0) {
      layerManager.deleteLayer(oldLayerId);
      adminiNs.emit('layerDematerialized', { layerId: oldLayerId });
    }

    // Generate wing + place exit for dynamic layers
    if (newLayer.type === 'dynamic') {
      materializeLayer(newLayer);
      generatePlayerWing(newLayer, id);
      placeWingExit(newLayer, id);
      // Notify admins about new wing
      const pd = newLayer.playerDungeons.get(id);
      if (pd) {
        const p = players.get(id);
        adminiNs.to(`admin:layer:${targetLayerId}`).emit('motherWingAdded', {
          playerId: id, name: p?.name || '', color,
          chunks: serializeChunkMap(pd.chunks),
        });
      }
    }

    const spawn = newLayer.getSpawn();
    const p = players.get(id);
    if (p) { p.x = spawn.x; p.y = spawn.y; }

    // Build player list for new layer
    const others = [];
    for (const [pid, pp] of players) {
      if (pid !== id && layerManager.getPlayerLayerId(pid) === targetLayerId) {
        others.push(pp);
      }
    }

    const initialChunks = getInitialChunks(newLayer, id, spawn);
    socket.emit('layerData', {
      spawn,
      layerMeta: newLayer.getMeta(),
      initialChunks,
      players: others,
    });

    socket.to(newRoom).emit('playerJoined', { id, color, spawn, name: p?.name || '', facing: 'south' });
    console.log(`Player ${id} moved to layer ${targetLayerId}`);
    broadcastLayerList();

    // Notify admins
    adminiNs.to(`admin:layer:${targetLayerId}`).emit('adminPlayerJoined', {
      id, x: spawn.x, y: spawn.y, name: p?.name || '', color, facing: 'south',
    });
    adminiNs.to(`admin:layer:${oldLayerId}`).emit('adminPlayerLeft', { id });
  }

  // --- Layer transition (admin/debug) ---
  socket.on('changeLayer', (data) => {
    const targetLayerId = data.layerId;
    // For dynamic layers, ensure they exist
    if (targetLayerId > 0) ensureDynamicLayer(targetLayerId);
    const targetLayer = layerManager.getLayer(targetLayerId);
    if (!targetLayer) return;
    executeTransition(targetLayerId);
  });

  // --- ENTRY tile transition (dungeon descent) ---
  socket.on('enterExit', () => {
    const p = players.get(id);
    if (!p) return;

    const currentLayerId = layerManager.getPlayerLayerId(id);
    const currentLayer = layerManager.getLayer(currentLayerId);
    if (!currentLayer) return;

    // Server-side validation: is the player on an ENTRY tile?
    let tileAtPlayer;
    if (currentLayer.type === 'dynamic') {
      tileAtPlayer = currentLayer.getCompositedTile(id, p.x, p.y);
    } else {
      tileAtPlayer = currentLayer.getTile(p.x, p.y);
    }
    if (tileAtPlayer !== 7) return; // Not on ENTRY tile

    // Determine direction
    let targetDepth;
    if (currentLayer.type === 'static') {
      // Static layer (L0) → always go DOWN
      targetDepth = currentLayerId + 1;
    } else {
      // Dynamic layer: check which exit we're on
      const boneSpawn = currentLayer.getSpawn();
      if (p.x === boneSpawn.x && p.y === boneSpawn.y) {
        // Bone spawn E → go UP
        targetDepth = currentLayerId - 1;
      } else {
        // Check if on any wing exit → go DOWN
        let onWingExit = false;
        for (const [, pos] of currentLayer.wingExits) {
          if (p.x === pos.x && p.y === pos.y) {
            onWingExit = true;
            break;
          }
        }
        if (onWingExit) {
          targetDepth = currentLayerId + 1;
        } else {
          return; // Not on a recognized exit
        }
      }
    }

    if (targetDepth < 0) return; // Can't go above L0

    // Ensure target layer exists (creates on-demand for descent)
    if (targetDepth > 0) ensureDynamicLayer(targetDepth);
    const targetLayer = layerManager.getLayer(targetDepth);
    if (!targetLayer) return;

    console.log(`Player ${id} entering exit: L${currentLayerId} → L${targetDepth}`);
    executeTransition(targetDepth);
  });

  socket.on('disconnect', () => {
    const playerLayerId = layerManager.getPlayerLayerId(id);
    const playerLayer = layerManager.getLayer(playerLayerId);

    // Remove wing exit before removing player
    if (playerLayer && playerLayer.type === 'dynamic') {
      removeWingExit(playerLayer, id);
    }

    layerManager.removePlayer(id);
    players.delete(id);
    if (playerLayerId !== undefined) {
      socket.to(`layer:${playerLayerId}`).emit('playerLeft', { id });
      // Notify admins
      adminiNs.to(`admin:layer:${playerLayerId}`).emit('adminPlayerLeft', { id });
      adminiNs.to(`admin:layer:${playerLayerId}`).emit('motherWingRemoved', { playerId: id });
    }
    // Delete dynamic layer if now empty
    if (playerLayer && playerLayer.type === 'dynamic' && playerLayer.players.size === 0) {
      layerManager.deleteLayer(playerLayerId);
      adminiNs.emit('layerDematerialized', { layerId: playerLayerId });
    }
    console.log(`Player ${id} left layer ${playerLayerId}`);
    broadcastLayerList();
  });
});

// --- Admini namespace (admin layer viewer) ---
const adminiNs = io.of('/admini');
adminiNs.on('connection', (socket) => {
  console.log(`Admini connected: ${socket.id}`);
  let currentAdminLayer = null;

  socket.on('getLayers', () => {
    socket.emit('layerList', getEnrichedLayers());
  });

  socket.on('loadLayer', ({ layerId, mode, playerId }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer) return socket.emit('layerError', { message: 'Not found' });

    // Leave previous admin room, join new one
    if (currentAdminLayer !== null) {
      socket.leave(`admin:layer:${currentAdminLayer}`);
    }
    currentAdminLayer = layerId;
    socket.join(`admin:layer:${layerId}`);

    const meta = { id: layer.id, type: layer.type, bounds: layer.bounds };

    // Gather current player positions on this layer
    const layerPlayers = [];
    for (const pid of layer.players) {
      const p = players.get(pid);
      if (p) layerPlayers.push({ id: pid, x: p.x, y: p.y, name: p.name, color: p.color, facing: p.facing });
    }

    if (layer.type === 'dynamic' && mode === 'mother') {
      // Mother view: bones + all wings
      const wings = [];
      for (const [pid, pd] of layer.playerDungeons) {
        const p = players.get(pid);
        wings.push({
          playerId: pid,
          name: p?.name || '',
          color: p?.color || '#888',
          chunks: serializeChunkMap(pd.chunks),
        });
      }
      socket.emit('motherView', {
        layerId, meta,
        materialized: layer.materialized,
        bones: layer.materialized ? serializeChunkMap(layer.bones) : [],
        wings,
        players: layerPlayers,
      });
    } else if (layer.type === 'dynamic' && mode === 'player' && playerId) {
      // Player view: composited bones + their wing
      const allKeys = [];
      for (const key of layer.bones.keys()) allKeys.push(key);
      const pd = layer.playerDungeons.get(playerId);
      if (pd) {
        for (const key of pd.chunks.keys()) {
          if (!allKeys.includes(key)) allKeys.push(key);
        }
      }
      socket.emit('playerView', {
        layerId, meta, playerId,
        chunks: layer.getChunksForPlayer(playerId, allKeys),
        players: layerPlayers,
      });
    } else {
      // Static layer or default: send chunks + player positions
      const store = layer.type === 'static' ? layer.chunks : layer.bones;
      socket.emit('layerChunks', {
        layerId, meta,
        chunks: serializeChunkMap(store),
        players: layerPlayers,
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Admini disconnected: ${socket.id}`);
  });
});

/** Generate personal wing dungeon for a player on a dynamic layer */
function generatePlayerWing(layer, playerId) {
  // Derive a unique seed for this player from the layer seed + player ID
  let playerSeed = layer.seed;
  for (let i = 0; i < playerId.length; i++) {
    playerSeed = ((playerSeed << 5) - playerSeed + playerId.charCodeAt(i)) | 0;
  }

  const wingData = generateWing(
    playerSeed,
    layer.boneRooms,
    layer.bones,
    layer.bounds.maxX,
    layer.bounds.maxY,
  );

  const pd = new PlayerDungeon(playerId, playerSeed);
  pd.chunks = wingData.chunks;
  pd.rooms = wingData.rooms;
  pd.doors = wingData.doors;
  layer.playerDungeons.set(playerId, pd);
}

/** Place a wing exit ENTRY tile for a player, promoted to bones for shared visibility */
function placeWingExit(layer, playerId) {
  const pd = layer.playerDungeons.get(playerId);
  if (!pd || pd.rooms.length === 0) return null;

  const boneSpawn = layer.getSpawn();
  const avoidPoints = [boneSpawn];
  for (const [, pos] of layer.wingExits) avoidPoints.push(pos);

  // Greedy max-min placement: pick wing room farthest from all avoid points
  let bestRoom = null, bestScore = -1;
  for (const room of pd.rooms) {
    const cx = room.cx || Math.floor(room.x + room.w / 2);
    const cy = room.cy || Math.floor(room.y + room.h / 2);
    let minDist = Infinity;
    for (const pt of avoidPoints) {
      minDist = Math.min(minDist, Math.abs(cx - pt.x) + Math.abs(cy - pt.y));
    }
    if (minDist > bestScore) { bestScore = minDist; bestRoom = room; }
  }
  if (!bestRoom) return null;

  const ex = bestRoom.cx || Math.floor(bestRoom.x + bestRoom.w / 2);
  const ey = bestRoom.cy || Math.floor(bestRoom.y + bestRoom.h / 2);
  const { cx, cy, lx, ly } = worldToChunk(ex, ey);
  const idx = chunkIndex(lx, ly);
  const key = chunkKey(cx, cy);

  // Write ENTRY into wing chunk
  const wingChunk = pd.chunks.get(key);
  if (wingChunk) wingChunk.tiles[idx] = 7; // TILE_ENTRY

  // PROMOTE to bones so all players see it (ENTRY is BONE_SACRED)
  let boneChunk = layer.bones.get(key);
  if (!boneChunk) {
    boneChunk = { tiles: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE), overlay: [], doors: [] };
    layer.bones.set(key, boneChunk);
  }
  boneChunk.tiles[idx] = 7; // TILE_ENTRY

  layer.wingExits.set(playerId, { x: ex, y: ey });
  console.log(`Wing exit placed for ${playerId} at (${ex}, ${ey}) on layer ${layer.id}`);
  return { x: ex, y: ey };
}

/** Remove a player's wing exit, reverting the promoted bone tile to VOID */
function removeWingExit(layer, playerId) {
  const pos = layer.wingExits.get(playerId);
  if (!pos) return;
  const { cx, cy, lx, ly } = worldToChunk(pos.x, pos.y);
  const boneChunk = layer.bones.get(chunkKey(cx, cy));
  if (boneChunk) boneChunk.tiles[chunkIndex(lx, ly)] = 0; // revert to VOID
  layer.wingExits.delete(playerId);
  console.log(`Wing exit removed for ${playerId} at (${pos.x}, ${pos.y}) on layer ${layer.id}`);
}

http.listen(PORT, () => {
  console.log(`Den server running on http://localhost:${PORT}`);
});
