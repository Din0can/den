import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { LayerManager, PlayerDungeon } from './layer-manager.js';
import { generateWing } from './src/map-generator.js';
import { generateSkeleton } from './src/skeleton-generator.js';
import { CHUNK_SIZE, CHUNK_VIEW_DIST, chunkKey, worldToChunk, chunkIndex } from './src/chunk.js';
import { nameToColor } from './src/name-color.js';
import { createPlayerStats, applyFlatDamage, tickBleed } from './src/stats.js';
import { splatter as bloodSplatter, dropBlood, packCoord } from './src/blood.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

const PORT = 3000;

// --- Layer setup ---
const layerManager = new LayerManager();
const STATIC_LAYERS_DIR = join(__dirname, 'data', 'static-layers');

// Persistence: save/load static layers to disk
const saveTimers = new Map();

async function saveStaticLayer(layer) {
  const data = layer.toJSON();
  const filePath = join(STATIC_LAYERS_DIR, `layer-${layer.id}.json`);
  await writeFile(filePath, JSON.stringify(data));
  console.log(`Static layer ${layer.id} saved to disk`);
}

function debouncedSave(layer) {
  if (saveTimers.has(layer.id)) clearTimeout(saveTimers.get(layer.id));
  saveTimers.set(layer.id, setTimeout(() => {
    saveTimers.delete(layer.id);
    saveStaticLayer(layer).catch(err => console.error(`Save failed for layer ${layer.id}:`, err));
  }, 1000));
}

async function loadStaticLayers() {
  let files;
  try {
    files = await readdir(STATIC_LAYERS_DIR);
  } catch {
    return; // directory doesn't exist yet
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(STATIC_LAYERS_DIR, file), 'utf-8');
      const data = JSON.parse(raw);
      const idMatch = file.match(/layer-(\d+)\.json/);
      if (!idMatch) continue;
      const id = Number(idMatch[1]);

      if (data.format === 'chunks') {
        // New chunk-based format
        layerManager.createStaticLayerFromChunks(id, data);
      } else {
        // Old flat-map format
        data.map = new Uint8Array(data.map);
        layerManager.createStaticLayer(id, data);
      }
      console.log(`Loaded static layer ${id} from disk`);
    } catch (err) {
      console.error(`Failed to load ${file}:`, err);
    }
  }
}

// Initialize: load from disk, create default L0 if missing
await mkdir(STATIC_LAYERS_DIR, { recursive: true });
await loadStaticLayers();

if (!layerManager.getLayer(0)) {
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
    entryUp: null, entryDown: { x: spawnX, y: spawnY },
  };
  layerManager.createStaticLayer(0, l0Data);
  await saveStaticLayer(layerManager.getLayer(0));
}

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
      maxWidth: 200,
      maxHeight: 160,
    });
  }
  return layer;
}

// Player state
const players = new Map();

// Blood storage per layer: layerId -> Map<packedCoord, bitmask>
const layerBlood = new Map();

function getLayerBlood(layerId) {
  let blood = layerBlood.get(layerId);
  if (!blood) {
    blood = new Map();
    layerBlood.set(layerId, blood);
  }
  return blood;
}

function serializeBlood(bloodMap) {
  const result = [];
  for (const [key, bitmask] of bloodMap) {
    const x = key >> 16;
    const y = (key << 16) >> 16; // sign-extend
    result.push([x, y, bitmask]);
  }
  return result;
}

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

  let spawn = layer.getSpawn();
  spawn = offsetSpawn(layer, id, spawn);
  players.set(id, { id, color, x: spawn.x, y: spawn.y, name: '', facing: 'south', stats: createPlayerStats() });

  // Build same-layer player list
  const others = [];
  for (const [pid, p] of players) {
    if (pid !== id && layerManager.getPlayerLayerId(pid) === layerId) {
      others.push(p);
    }
  }

  // Send welcome with layer metadata + initial chunks
  const initialChunks = getInitialChunks(layer, id, spawn);
  const p = players.get(id);
  socket.emit('welcome', {
    id,
    color,
    spawn,
    layerMeta: layer.getMeta(),
    initialChunks,
    players: others,
    stats: p.stats,
    blood: serializeBlood(getLayerBlood(layerId)),
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

    // Check adjacency against ANY tile in the door group (including swung positions when open)
    let adjacent = false;
    const doorLen = door.length || 1;
    // Always check original positions
    for (let i = 0; i < doorLen; i++) {
      const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
      const ty = door.orientation === 'vertical' ? door.y + i : door.y;
      if (Math.abs(p.x - tx) + Math.abs(p.y - ty) <= 1) {
        adjacent = true;
        break;
      }
    }
    // Also check swung positions when open (multi-tile)
    if (!adjacent && door.isOpen && doorLen > 1) {
      for (let i = 1; i < doorLen; i++) {
        let sx, sy;
        switch (door.swingDirection) {
          case 'south': sx = door.x; sy = door.y + i; break;
          case 'north': sx = door.x; sy = door.y - i; break;
          case 'east':  sx = door.x + i; sy = door.y; break;
          case 'west':  sx = door.x - i; sy = door.y; break;
        }
        if (Math.abs(p.x - sx) + Math.abs(p.y - sy) <= 1) {
          adjacent = true;
          break;
        }
      }
    }
    if (!adjacent) return;

    const isWingDoor = door.id >= 10000; // wing doors have offset IDs
    const len = door.length || 1;
    const newOpen = !door.isOpen;
    const tileChanges = [];

    /** Set a tile in the appropriate chunk storage */
    function setDoorTile(tx, ty, tileVal) {
      if (playerLayer.type === 'static') {
        playerLayer.setTile(tx, ty, tileVal);
      } else if (isWingDoor) {
        const pd = playerLayer.playerDungeons.get(id);
        if (pd) {
          const { cx, cy, lx, ly } = worldToChunk(tx, ty);
          const chunk = pd.chunks.get(chunkKey(cx, cy));
          if (chunk) chunk.tiles[chunkIndex(lx, ly)] = tileVal;
        }
      } else {
        playerLayer.setTile(tx, ty, tileVal);
      }
      tileChanges.push({ x: tx, y: ty, tile: tileVal });
    }

    if (len <= 1) {
      // Single-tile door: simple toggle at same position
      door.isOpen = newOpen;
      const tileType = newOpen ? 4 : 3;
      setDoorTile(door.x, door.y, tileType);
    } else {
      // Multi-tile door: swing mechanics
      // Compute swung positions (for i=1..len-1, hinge stays at door.x, door.y)
      const swungPositions = [];
      for (let i = 1; i < len; i++) {
        let sx, sy;
        switch (door.swingDirection) {
          case 'south': sx = door.x; sy = door.y + i; break;
          case 'north': sx = door.x; sy = door.y - i; break;
          case 'east':  sx = door.x + i; sy = door.y; break;
          case 'west':  sx = door.x - i; sy = door.y; break;
        }
        swungPositions.push({ x: sx, y: sy });
      }

      if (newOpen) {
        // Opening: validate swung positions are passable (not wall/door)
        for (const pos of swungPositions) {
          const t = playerLayer.type === 'static'
            ? playerLayer.getTile(pos.x, pos.y)
            : (isWingDoor
              ? (() => { const pd = playerLayer.playerDungeons.get(id); if (!pd) return 0; const c = worldToChunk(pos.x, pos.y); const ch = pd.chunks.get(chunkKey(c.cx, c.cy)); return ch ? ch.tiles[chunkIndex(c.lx, c.ly)] : 0; })()
              : playerLayer.getTile(pos.x, pos.y));
          // Block if wall (1), wall_mossy (6), or door (3,4)
          if (t === 1 || t === 6 || t === 3 || t === 4) return;
        }

        door.isOpen = true;
        // Hinge tile → DOOR_OPEN
        setDoorTile(door.x, door.y, 4);
        // Original non-hinge tiles → FLOOR
        for (let i = 1; i < len; i++) {
          const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
          const ty = door.orientation === 'vertical' ? door.y + i : door.y;
          setDoorTile(tx, ty, 2); // FLOOR
        }
        // Swung positions → DOOR_OPEN
        for (const pos of swungPositions) {
          setDoorTile(pos.x, pos.y, 4);
        }
      } else {
        // Closing: revert swung → FLOOR, original → DOOR_CLOSED
        door.isOpen = false;
        for (const pos of swungPositions) {
          setDoorTile(pos.x, pos.y, 2); // FLOOR
        }
        for (let i = 0; i < len; i++) {
          const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
          const ty = door.orientation === 'vertical' ? door.y + i : door.y;
          setDoorTile(tx, ty, 3); // DOOR_CLOSED
        }
      }
    }

    if (playerLayer.type === 'static') debouncedSave(playerLayer);

    const playerLayerId = layerManager.getPlayerLayerId(id);
    io.to(`layer:${playerLayerId}`).emit('doorState', {
      doorId: door.id,
      isOpen: door.isOpen,
      tiles: tileChanges,
    });
    adminiNs.to(`admin:layer:${playerLayerId}`).emit('doorState', {
      layerId: playerLayerId,
      doorId: door.id,
      isOpen: door.isOpen,
      tiles: tileChanges,
    });
  });

  // --- Debug hurt command ---
  socket.on('hurt', (data) => {
    const p = players.get(id);
    if (!p || !p.stats) return;
    const { limbId, amount, type } = data;
    if (!limbId || !amount) return;

    const playerLayerId = layerManager.getPlayerLayerId(id);
    const blood = getLayerBlood(playerLayerId);
    const result = applyFlatDamage(p.stats, limbId, amount);

    // Splatter blood at player position
    const severity = amount >= 10 ? 2 : 1;
    const splatResult = bloodSplatter(blood, p.x, p.y, severity);

    // Send damage to the hurt player
    socket.emit('damage', { limbId, amount: result.damage, stats: p.stats });

    // Send blood update to entire layer
    io.to(`layer:${playerLayerId}`).emit('bloodUpdate', { updates: [splatResult] });
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

    // Direction-aware spawn for static layers
    let spawn;
    if (newLayer.type === 'static' && newLayer.getSpawnForArrival) {
      const fromDir = targetLayerId > oldLayerId ? 'above' : 'below';
      spawn = newLayer.getSpawnForArrival(fromDir);
    } else {
      spawn = newLayer.getSpawn();
    }
    // Offset spawn so player lands near the exit, not on top of it
    spawn = offsetSpawn(newLayer, id, spawn);
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
      stats: p?.stats,
      blood: serializeBlood(getLayerBlood(targetLayerId)),
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
      // Check which entry the player is on
      if (currentLayer.entryDown && p.x === currentLayer.entryDown.x && p.y === currentLayer.entryDown.y) {
        targetDepth = currentLayerId + 1;
      } else if (currentLayer.entryUp && p.x === currentLayer.entryUp.x && p.y === currentLayer.entryUp.y) {
        targetDepth = currentLayerId - 1;
      } else {
        return; // Not on a recognized entry
      }
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

    const meta = layer.getMeta();

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

  // --- Editor: Create static layer ---
  socket.on('createStaticLayer', ({ id }) => {
    if (typeof id !== 'number' || id < 0) return socket.emit('layerError', { message: 'Invalid layer ID' });
    if (layerManager.getLayer(id)) return socket.emit('layerError', { message: `Layer ${id} already exists` });

    layerManager.createBlankStaticLayer(id);
    const layer = layerManager.getLayer(id);
    debouncedSave(layer);
    broadcastLayerList();
    socket.emit('layerCreated', { id });
    console.log(`Admin created empty static layer ${id}`);
  });

  // --- Editor: Delete static layer ---
  socket.on('deleteStaticLayer', ({ id }) => {
    const layer = layerManager.getLayer(id);
    if (!layer) return socket.emit('layerError', { message: 'Layer not found' });
    if (layer.type !== 'static') return socket.emit('layerError', { message: 'Can only delete static layers' });
    if (layer.players.size > 0) return socket.emit('layerError', { message: 'Layer has active players' });

    layerManager.deleteLayer(id);
    const filePath = join(STATIC_LAYERS_DIR, `layer-${id}.json`);
    unlink(filePath).catch(() => {});
    broadcastLayerList();
    socket.emit('layerDeleted', { id });
    console.log(`Admin deleted static layer ${id}`);
  });

  // --- Editor: Paint tiles ---
  socket.on('paintTiles', ({ layerId, tiles }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;
    if (!Array.isArray(tiles) || tiles.length === 0) return;

    const removedDoorIds = [];
    const removedInfoIds = [];
    for (const { x, y, tile } of tiles) {
      layer.ensureChunkAt(x, y);
      layer.setTile(x, y, tile);
      layer._expandBounds(x, y);

      // Entry overwrite protection: if painting over an entry position with non-ENTRY tile
      if (tile !== 7) {
        if (layer.entryDown && layer.entryDown.x === x && layer.entryDown.y === y) {
          layer.entryDown = null;
        }
        if (layer.entryUp && layer.entryUp.x === x && layer.entryUp.y === y) {
          layer.entryUp = null;
        }
      }

      // Door overwrite protection: remove door if painting non-door tile over it
      if (tile !== 3 && tile !== 4) { // DOOR_CLOSED / DOOR_OPEN
        const door = layer.getDoorAt(x, y);
        if (door) {
          layer.removeDoor(door.id);
          removedDoorIds.push(door.id);
        }
      }

      // Info overwrite protection: remove info point if painting non-INFO tile over it
      if (tile !== 53) {
        const info = layer.getInfoAt(x, y);
        if (info) {
          layer.removeInfoPoint(info.id);
          removedInfoIds.push(info.id);
        }
      }
    }

    debouncedSave(layer);
    // Broadcast to other admins watching this layer
    socket.to(`admin:layer:${layerId}`).emit('tilesUpdated', { layerId, tiles });
    if (removedDoorIds.length > 0) {
      adminiNs.to(`admin:layer:${layerId}`).emit('doorRemoved', { layerId, doorIds: removedDoorIds });
    }
    if (removedInfoIds.length > 0) {
      for (const infoId of removedInfoIds) {
        adminiNs.to(`admin:layer:${layerId}`).emit('infoRemoved', { layerId, infoId });
      }
    }
  });

  // --- Editor: Set entry point ---
  socket.on('setEntry', ({ layerId, direction, x, y }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;
    if (direction !== 'up' && direction !== 'down') return;

    // Clear old entry tile
    const entryKey = direction === 'up' ? 'entryUp' : 'entryDown';
    const old = layer[entryKey];
    if (old) {
      layer.setTile(old.x, old.y, 2); // revert to FLOOR
    }

    // Set new entry
    layer[entryKey] = { x, y };
    layer.ensureChunkAt(x, y);
    layer.setTile(x, y, 7); // TILE_ENTRY
    layer._expandBounds(x, y);
    debouncedSave(layer);

    adminiNs.to(`admin:layer:${layerId}`).emit('entryUpdated', {
      layerId, direction, x, y,
      entryUp: layer.entryUp,
      entryDown: layer.entryDown,
    });
  });

  // --- Editor: Remove entry point ---
  socket.on('removeEntry', ({ layerId, direction }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;

    const entryKey = direction === 'up' ? 'entryUp' : 'entryDown';
    const old = layer[entryKey];
    if (old) {
      layer.setTile(old.x, old.y, 2); // revert to FLOOR
      layer[entryKey] = null;
      debouncedSave(layer);
    }

    adminiNs.to(`admin:layer:${layerId}`).emit('entryUpdated', {
      layerId, direction: null,
      entryUp: layer.entryUp,
      entryDown: layer.entryDown,
    });
  });

  // --- Editor: Place door ---
  socket.on('placeDoor', ({ layerId, x, y, type, length, orientation }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;
    if (type !== 'wood' && type !== 'metal') return;

    const len = Math.max(1, Math.min(5, length || 1));
    const orient = orientation === 'vertical' ? 'vertical' : 'horizontal';

    // Validate all positions are door-free
    for (let i = 0; i < len; i++) {
      const tx = orient === 'horizontal' ? x + i : x;
      const ty = orient === 'vertical' ? y + i : y;
      if (layer.getDoorAt(tx, ty)) return;
    }

    // Auto-detect swing direction from perpendicular neighbors of first tile
    let swingDirection;
    if (orient === 'horizontal') {
      const below = layer.getTile(x, y + 1);
      swingDirection = (below === 2 || below === 5) ? 'south' : 'north'; // FLOOR or GRASS
    } else {
      const right = layer.getTile(x + 1, y);
      swingDirection = (right === 2 || right === 5) ? 'east' : 'west'; // FLOOR or GRASS
    }

    const door = {
      id: layer.getNextDoorId(),
      x, y,
      orientation: orient,
      length: len,
      type,
      isOpen: false,
      swingDirection,
    };

    for (let i = 0; i < len; i++) {
      const tx = orient === 'horizontal' ? x + i : x;
      const ty = orient === 'vertical' ? y + i : y;
      layer.ensureChunkAt(tx, ty);
      layer.setTile(tx, ty, 3); // DOOR_CLOSED
      layer._expandBounds(tx, ty);
    }
    layer.addDoor(door);
    debouncedSave(layer);

    adminiNs.to(`admin:layer:${layerId}`).emit('doorPlaced', { layerId, door });
    console.log(`Door placed at (${x},${y}) len=${len} on layer ${layerId} — ${type} ${orient}`);
  });

  // --- Editor: Remove door ---
  socket.on('removeDoor', ({ layerId, doorId }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;

    const door = layer.removeDoor(doorId);
    if (!door) return;

    // Revert door tiles to floor
    for (let i = 0; i < (door.length || 1); i++) {
      const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
      const ty = door.orientation === 'vertical' ? door.y + i : door.y;
      layer.setTile(tx, ty, 2); // FLOOR
    }
    debouncedSave(layer);

    adminiNs.to(`admin:layer:${layerId}`).emit('doorRemoved', { layerId, doorIds: [doorId] });
  });

  // --- Editor: Place info point ---
  socket.on('placeInfo', ({ layerId, x, y, text }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;
    if (typeof text !== 'string' || text.trim().length === 0) return;

    // Don't place if there's already an info point here
    if (layer.getInfoAt(x, y)) return;

    const info = {
      id: layer.getNextInfoId(),
      x, y,
      text: text.trim(),
    };

    layer.ensureChunkAt(x, y);
    layer.setTile(x, y, 53); // INFO tile
    layer._expandBounds(x, y);
    layer.addInfoPoint(info);
    debouncedSave(layer);

    adminiNs.to(`admin:layer:${layerId}`).emit('infoPlaced', { layerId, info });
    console.log(`Info placed at (${x},${y}) on layer ${layerId} — "${info.text}"`);
  });

  // --- Editor: Remove info point ---
  socket.on('removeInfo', ({ layerId, infoId }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;

    const info = layer.removeInfoPoint(infoId);
    if (!info) return;

    layer.setTile(info.x, info.y, 2); // revert to FLOOR
    debouncedSave(layer);

    adminiNs.to(`admin:layer:${layerId}`).emit('infoRemoved', { layerId, infoId });
  });

  socket.on('disconnect', () => {
    console.log(`Admini disconnected: ${socket.id}`);
  });
});

/**
 * Offset a spawn point so the player lands 1-2 tiles away from the entry,
 * on a passable, non-entry tile. Shuffled random order so it's never predictable.
 */
function offsetSpawn(layer, playerId, spawn) {
  // Valid spawn tiles: walkable AND not a transition tile
  // FLOOR=2, GRASS=5, PATH=8, STONE=9
  const validSpawn = new Set([2, 5, 8, 9]);

  function getTileAt(x, y) {
    if (layer.type === 'dynamic') {
      return layer.getCompositedTile(playerId, x, y);
    }
    return layer.getTile(x, y);
  }

  // Check that a position has at least one adjacent passable neighbor
  // so the player won't be stuck
  function hasExit(x, y) {
    const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
    for (const [ddx, ddy] of dirs) {
      const t = getTileAt(x + ddx, y + ddy);
      if (validSpawn.has(t) || t === 7) return true; // can walk to floor or entry
    }
    return false;
  }

  // Collect candidate offsets at distance 1-3 (manhattan), shuffled
  const offsets = [];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const dist = Math.abs(dx) + Math.abs(dy);
      if (dist >= 1 && dist <= 3) {
        offsets.push({ dx, dy, dist });
      }
    }
  }
  // Fisher-Yates shuffle
  for (let i = offsets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [offsets[i], offsets[j]] = [offsets[j], offsets[i]];
  }
  // Prefer closer distances first
  offsets.sort((a, b) => a.dist - b.dist);

  for (const { dx, dy } of offsets) {
    const nx = spawn.x + dx;
    const ny = spawn.y + dy;
    const t = getTileAt(nx, ny);
    if (validSpawn.has(t) && hasExit(nx, ny)) {
      return { x: nx, y: ny };
    }
  }
  // Last resort: if original spawn is at least passable (even entry), use it
  // This should rarely happen — rooms always have floor tiles nearby
  return spawn;
}

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
  if (wingChunk) {
    wingChunk.tiles[idx] = 7; // TILE_ENTRY
    // Clear overlay (furniture) at exit position so E is visible and passable
    wingChunk.overlay = wingChunk.overlay.filter(([ox, oy]) => !(ox === ex && oy === ey));
  }

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

// Bleed tick: every 2s, process all bleeding players
setInterval(() => {
  for (const [id, p] of players) {
    if (!p.stats || p.stats.bleedStacks <= 0) continue;
    const { totalDamage, killed } = tickBleed(p.stats);
    if (totalDamage <= 0) continue;

    const playerLayerId = layerManager.getPlayerLayerId(id);
    const blood = getLayerBlood(playerLayerId);
    const drops = Math.min(4, Math.ceil(p.stats.bleedStacks / 3));
    const updates = [];
    for (let i = 0; i < drops; i++) {
      updates.push(dropBlood(blood, p.x, p.y));
    }

    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit('damage', { stats: p.stats });
    io.to(`layer:${playerLayerId}`).emit('bloodUpdate', { updates });
  }
}, 5000);

http.listen(PORT, () => {
  console.log(`Den server running on http://localhost:${PORT}`);
});
