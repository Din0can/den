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
import { loadItemRegistry, getAllItems, getItemDef, generateContainerLoot, createItemInstance, CONTAINER_TILES, CONTAINER_CHARS, EQUIP_SLOTS, setContainerConfig, getContainerConfig, setRarityWeights, getRarityWeights } from './src/items.js';
import { EnemyManager } from './enemy-manager.js';
import { getEnemyTypes, updateEnemyType, loadEnemyTypes } from './src/enemy-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

const PORT = 3000;

// --- Layer setup ---
const layerManager = new LayerManager();
const enemyManager = new EnemyManager();
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

// --- Item registry ---
const ITEMS_FILE = join(__dirname, 'data', 'items.json');
let itemSaveTimer = null;

async function loadItems() {
  try {
    const raw = await readFile(ITEMS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    loadItemRegistry(data);
    console.log(`Loaded ${Object.keys(data).length} items from items.json`);
  } catch {
    console.log('No items.json found, starting with empty registry');
    loadItemRegistry({});
  }
}

function debouncedItemSave() {
  if (itemSaveTimer) clearTimeout(itemSaveTimer);
  itemSaveTimer = setTimeout(async () => {
    itemSaveTimer = null;
    try {
      await writeFile(ITEMS_FILE, JSON.stringify(getAllItems(), null, 2));
      console.log('Items saved to disk');
    } catch (err) {
      console.error('Failed to save items:', err);
    }
  }, 1000);
}

// --- Container config ---
const CONTAINER_CONFIG_FILE = join(__dirname, 'data', 'container-config.json');

async function loadContainerConfig() {
  try {
    const raw = await readFile(CONTAINER_CONFIG_FILE, 'utf-8');
    const data = JSON.parse(raw);
    setContainerConfig(data);
    console.log('Loaded container config from container-config.json');
  } catch {
    console.log('No container-config.json found, using defaults');
  }
}

async function saveContainerConfig() {
  try {
    await writeFile(CONTAINER_CONFIG_FILE, JSON.stringify(getContainerConfig(), null, 2));
    console.log('Container config saved to disk');
  } catch (err) {
    console.error('Failed to save container config:', err);
  }
}

// --- Rarity weights ---
const RARITY_WEIGHTS_FILE = join(__dirname, 'data', 'rarity-weights.json');

async function loadRarityWeights() {
  try {
    const raw = await readFile(RARITY_WEIGHTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    // Convert null maxDepth to Infinity for runtime
    const weights = data.map(b => ({
      maxDepth: b.maxDepth === null ? Infinity : b.maxDepth,
      weights: b.weights,
    }));
    setRarityWeights(weights);
    console.log('Loaded rarity weights from rarity-weights.json');
  } catch {
    console.log('No rarity-weights.json found, using defaults');
  }
}

async function saveRarityWeightsFile() {
  try {
    // Convert Infinity to null for JSON
    const data = getRarityWeights().map(b => ({
      maxDepth: b.maxDepth === Infinity ? null : b.maxDepth,
      weights: b.weights,
    }));
    await writeFile(RARITY_WEIGHTS_FILE, JSON.stringify(data, null, 2));
    console.log('Rarity weights saved to disk');
  } catch (err) {
    console.error('Failed to save rarity weights:', err);
  }
}

// --- Enemy types persistence ---
const ENEMY_TYPES_FILE = join(__dirname, 'data', 'enemy-types.json');
let enemyTypeSaveTimer = null;

async function loadEnemyTypesFromDisk() {
  try {
    const raw = await readFile(ENEMY_TYPES_FILE, 'utf-8');
    const data = JSON.parse(raw);
    loadEnemyTypes(data);
    console.log('Loaded enemy types from enemy-types.json');
  } catch {
    console.log('No enemy-types.json found, using defaults');
  }
}

function debouncedEnemyTypeSave() {
  if (enemyTypeSaveTimer) clearTimeout(enemyTypeSaveTimer);
  enemyTypeSaveTimer = setTimeout(async () => {
    enemyTypeSaveTimer = null;
    try {
      await writeFile(ENEMY_TYPES_FILE, JSON.stringify(getEnemyTypes(), null, 2));
      console.log('Enemy types saved to disk');
    } catch (err) {
      console.error('Failed to save enemy types:', err);
    }
  }, 1000);
}

// Container state per session: "layerId:x,y" -> { items: [...], opened: true }
const containerState = new Map();

// Initialize: load from disk, create default L0 if missing
await mkdir(STATIC_LAYERS_DIR, { recursive: true });
await loadStaticLayers();
await loadItems();
await loadContainerConfig();
await loadRarityWeights();
await loadEnemyTypesFromDisk();

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

function createEmptyEquipment() {
  return { head: null, chest: null, legs: null, mainHand: null, offHand: null };
}

function addToInventory(player, item) {
  // Try to stack with existing item
  if (item.stackable) {
    const def = getItemDef(item.id);
    const maxStack = def ? def.maxStack : 1;
    for (let i = 0; i < 8; i++) {
      const slot = player.inventory[i];
      if (slot && slot.id === item.id && slot.count < maxStack) {
        slot.count = Math.min(slot.count + item.count, maxStack);
        return true;
      }
    }
  }
  // Find first empty slot
  for (let i = 0; i < 8; i++) {
    if (!player.inventory[i]) {
      player.inventory[i] = item;
      return true;
    }
  }
  return false;
}

function recomputeEquipment(player) {
  let totalArmor = 0;
  let activeDamage = 1; // base unarmed damage
  const effects = [];

  for (const key of EQUIP_SLOTS) {
    const item = player.equipment[key];
    if (!item) continue;
    if (item.armor) totalArmor += item.armor;
    if (key === 'mainHand' && item.damage) activeDamage += item.damage;
    if (key === 'offHand' && item.damage && !item.twoHanded) activeDamage += item.damage;
    if (item.effect) effects.push(item.effect);
  }

  player.totalArmor = totalArmor;
  player.activeDamage = activeDamage;
  player.equipEffects = effects;
  player.attackRange = player.equipment.mainHand?.attackRange || 1;
  player.attackSpeed = player.equipment.mainHand?.attackSpeed || 1000;
}

function getContainerType(layer, playerId, x, y) {
  // Check base tile
  let tile;
  if (layer.type === 'dynamic') {
    tile = layer.getCompositedTile(playerId, x, y);
  } else {
    tile = layer.getTile(x, y);
  }
  if (CONTAINER_TILES[tile]) return CONTAINER_TILES[tile];

  // Check overlay char — need to look in chunks
  // For static layers, check the chunk overlay
  const { cx, cy } = worldToChunk(x, y);
  const key = chunkKey(cx, cy);
  let chunks;
  if (layer.type === 'dynamic') {
    // Check bone chunks and player wing chunks
    chunks = [];
    const boneChunk = layer.bones.get(key);
    if (boneChunk && boneChunk.overlay) chunks.push(boneChunk);
    const pd = layer.playerDungeons.get(playerId);
    if (pd) {
      const wingChunk = pd.chunks.get(key);
      if (wingChunk && wingChunk.overlay) chunks.push(wingChunk);
    }
  } else {
    const chunk = layer.chunks.get(key);
    if (chunk && chunk.overlay) chunks = [chunk];
    else chunks = [];
  }
  for (const chunk of chunks) {
    if (!chunk.overlay) continue;
    for (const entry of chunk.overlay) {
      if (entry[0] === x && entry[1] === y) {
        const char = entry[2];
        if (CONTAINER_CHARS[char]) return CONTAINER_CHARS[char];
      }
    }
  }
  return null;
}

function sendInventoryUpdate(socket, player) {
  socket.emit('inventoryUpdate', {
    slots: player.inventory,
    equipment: player.equipment,
  });
}

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
      shops: data.shops || [],
      infoPoints: data.infoPoints || [],
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
  result.sort((a, b) => a.id - b.id);
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
  players.set(id, {
    id, color, x: spawn.x, y: spawn.y, name: '', facing: 'south',
    stats: createPlayerStats(),
    inventory: Array(8).fill(null),
    equipment: createEmptyEquipment(),
    totalArmor: 0,
    activeDamage: 1,
    equipEffects: [],
    attackRange: 1,
    attackSpeed: 1000,
    lastAttackTime: 0,
  });

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
    inventory: p.inventory,
    equipment: p.equipment,
    enemies: enemyManager.getSnapshotForPlayer(id, layerId),
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


  // --- Shared transition logic ---
  function executeTransition(targetLayerId) {
    const oldLayerId = layerManager.getPlayerLayerId(id);
    const oldLayer = layerManager.getLayer(oldLayerId);
    const oldRoom = `layer:${oldLayerId}`;

    // Remove wing exit before leaving dynamic layer
    if (oldLayer && oldLayer.type === 'dynamic') {
      removeWingExit(oldLayer, id);
    }

    // Despawn player's enemies on layer change (they'll respawn on new layer)
    enemyManager.despawnForPlayer(id);

    // Leave old layer
    socket.leave(oldRoom);
    socket.to(oldRoom).emit('playerLeft', { id });

    // Join new layer
    const newLayer = layerManager.assignPlayer(id, targetLayerId);
    const newRoom = `layer:${targetLayerId}`;
    socket.join(newRoom);

    // Delete old dynamic layer if now empty
    if (oldLayer && oldLayer.type === 'dynamic' && oldLayer.players.size === 0) {
      enemyManager.despawnForLayer(oldLayerId);
      layerManager.deleteLayer(oldLayerId);
      for (const key of containerState.keys()) {
        if (key.startsWith(`${oldLayerId}:`)) containerState.delete(key);
      }
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
      inventory: p?.inventory,
      equipment: p?.equipment,
      enemies: enemyManager.getSnapshotForPlayer(id, targetLayerId),
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

  // --- Inventory / Equipment / Container handlers ---

  socket.on('openContainer', (data) => {
    const p = players.get(id);
    if (!p) return;
    const { x, y } = data;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    const currentLayerId = layerManager.getPlayerLayerId(id);
    const currentLayer = layerManager.getLayer(currentLayerId);
    if (!currentLayer) return;

    // Validate adjacency (manhattan distance 1)
    if (Math.abs(p.x - x) + Math.abs(p.y - y) !== 1) return;

    const cType = getContainerType(currentLayer, id, x, y);
    if (!cType) return;

    const containerKey = `${currentLayerId}:${x},${y}`;
    let cState = containerState.get(containerKey);
    if (!cState) {
      // Generate loot on first open (lazy)
      const depth = currentLayerId;
      const items = generateContainerLoot(cType, depth);
      cState = { items, opened: true };
      containerState.set(containerKey, cState);
    }

    // Try to add items to player inventory
    const added = [];
    let full = false;
    for (const item of cState.items) {
      if (addToInventory(p, { ...item })) {
        added.push(item);
      } else {
        full = true;
      }
    }
    // Clear container after looting
    cState.items = [];

    let message = '';
    if (added.length === 0 && !full) {
      message = 'Empty container.';
    } else if (added.length > 0) {
      const names = added.map(i => i.name).join(', ');
      message = `Found: ${names}`;
      if (full) message += ' (Inventory full!)';
    } else {
      message = 'Inventory full!';
    }

    sendInventoryUpdate(socket, p);
    socket.emit('containerResult', { x, y, items: added, message });
  });

  socket.on('useItem', (data) => {
    const p = players.get(id);
    if (!p) return;
    const { slot } = data;
    if (typeof slot !== 'number' || slot < 0 || slot >= 8) return;
    const item = p.inventory[slot];
    if (!item || item.type !== 'consumable') return;

    // Process effect
    if (item.effect) {
      if (item.effect.removeBleed && p.stats) {
        p.stats.bleedStacks = Math.max(0, p.stats.bleedStacks - item.effect.removeBleed);
      }
    }

    // Decrement count or remove
    item.count--;
    if (item.count <= 0) {
      p.inventory[slot] = null;
    }

    sendInventoryUpdate(socket, p);
    // Also send updated stats if bleed changed
    if (item.effect && item.effect.removeBleed) {
      socket.emit('damage', { stats: p.stats });
    }
  });

  socket.on('equipItem', (data) => {
    const p = players.get(id);
    if (!p) return;
    const { slot } = data;
    if (typeof slot !== 'number' || slot < 0 || slot >= 8) return;
    const item = p.inventory[slot];
    if (!item || !item.slot) return;

    const targetSlot = item.slot;
    if (!EQUIP_SLOTS.includes(targetSlot)) return;

    if (item.twoHanded) {
      // Two-handed: need both mainHand and offHand empty (or swap)
      const mh = p.equipment.mainHand;
      const oh = p.equipment.offHand;
      if (mh || oh) {
        // Try to unequip existing items first
        if (mh && mh !== oh) {
          // Find empty slots for displaced items
          let slot1 = -1;
          for (let i = 0; i < 8; i++) {
            if (!p.inventory[i] || i === slot) { slot1 = i; break; }
          }
          if (slot1 < 0) return; // No room
          if (slot1 !== slot) p.inventory[slot1] = mh;
        }
        if (oh && oh !== mh) {
          let slot2 = -1;
          for (let i = 0; i < 8; i++) {
            if (!p.inventory[i] && i !== slot) { slot2 = i; break; }
          }
          if (slot2 < 0) return;
          p.inventory[slot2] = oh;
        }
      }
      p.inventory[slot] = null;
      p.equipment.mainHand = item;
      p.equipment.offHand = item; // Same reference, OH dimmed on client
    } else {
      // Single slot equip
      const existing = p.equipment[targetSlot];
      p.inventory[slot] = existing || null; // Swap back to hotbar slot
      p.equipment[targetSlot] = item;
    }

    recomputeEquipment(p);
    sendInventoryUpdate(socket, p);
  });

  socket.on('unequipItem', (data) => {
    const p = players.get(id);
    if (!p) return;
    const { slot: slotName } = data;
    if (!EQUIP_SLOTS.includes(slotName)) return;
    const item = p.equipment[slotName];
    if (!item) return;

    if (item.twoHanded) {
      // 2H: clear both slots, item goes to one hotbar slot
      let emptySlot = -1;
      for (let i = 0; i < 8; i++) {
        if (!p.inventory[i]) { emptySlot = i; break; }
      }
      if (emptySlot < 0) {
        socket.emit('containerResult', { message: 'Inventory full!' });
        return;
      }
      p.inventory[emptySlot] = item;
      p.equipment.mainHand = null;
      p.equipment.offHand = null;
    } else {
      let emptySlot = -1;
      for (let i = 0; i < 8; i++) {
        if (!p.inventory[i]) { emptySlot = i; break; }
      }
      if (emptySlot < 0) {
        socket.emit('containerResult', { message: 'Inventory full!' });
        return;
      }
      p.inventory[emptySlot] = item;
      p.equipment[slotName] = null;
    }

    recomputeEquipment(p);
    sendInventoryUpdate(socket, p);
  });

  socket.on('swapSlots', (data) => {
    const p = players.get(id);
    if (!p) return;
    const { a, b } = data;
    if (typeof a !== 'number' || typeof b !== 'number') return;
    if (a < 0 || a >= 8 || b < 0 || b >= 8 || a === b) return;
    const tmp = p.inventory[a];
    p.inventory[a] = p.inventory[b];
    p.inventory[b] = tmp;
    sendInventoryUpdate(socket, p);
  });

  // --- Shop handlers ---
  socket.on('openShop', (data) => {
    const p = players.get(id);
    if (!p) return;
    const { shopId } = data;
    if (typeof shopId !== 'number') return;

    const currentLayerId = layerManager.getPlayerLayerId(id);
    const currentLayer = layerManager.getLayer(currentLayerId);
    if (!currentLayer || currentLayer.type !== 'static') return;

    const shop = currentLayer.shops.find(s => s.id === shopId);
    if (!shop) return;

    // Validate adjacency
    if (Math.abs(p.x - shop.x) + Math.abs(p.y - shop.y) !== 1) return;

    // Refill stock
    for (const entry of shop.inventory) {
      if (entry.maxStock < 0 || entry.refillTime <= 0) continue;
      if (entry.stock >= entry.maxStock) continue;
      const now = Date.now();
      const elapsedHours = (now - (entry.lastRefill || now)) / 3600000;
      const refilled = Math.floor(elapsedHours / entry.refillTime);
      if (refilled > 0) {
        entry.stock = Math.min(entry.maxStock, entry.stock + refilled);
        entry.lastRefill = now;
      }
    }

    // Build priced inventory
    const pricedItems = shop.inventory.map(entry => {
      const def = getItemDef(entry.itemId);
      if (!def) return null;
      return {
        itemId: entry.itemId,
        name: def.name,
        char: def.char,
        rarity: def.rarity,
        buyPrice: Math.ceil((def.value || 0) * shop.buyMarkup),
        stock: entry.stock,
      };
    }).filter(Boolean);

    // Track open shop state
    p.openShopId = shopId;
    p.openShopLayerId = currentLayerId;

    socket.emit('shopData', {
      shopId: shop.id,
      shopName: shop.name,
      buyMarkup: shop.buyMarkup,
      sellMarkup: shop.sellMarkup,
      inventory: pricedItems,
    });
  });

  socket.on('buyFromShop', (data) => {
    const p = players.get(id);
    if (!p || p.openShopId === undefined) return;
    const { shopId, itemIndex } = data;
    if (shopId !== p.openShopId) return;
    if (typeof itemIndex !== 'number') return;

    const currentLayer = layerManager.getLayer(p.openShopLayerId);
    if (!currentLayer) return;

    const shop = currentLayer.shops.find(s => s.id === shopId);
    if (!shop) return;

    const entry = shop.inventory[itemIndex];
    if (!entry) return;
    if (entry.stock === 0) return;

    const def = getItemDef(entry.itemId);
    if (!def) return;

    const buyPrice = Math.ceil((def.value || 0) * shop.buyMarkup);
    if (p.stats.gold < buyPrice) return;

    // Create item instance and try to add to inventory
    const item = createItemInstance(def);
    if (!addToInventory(p, item)) {
      socket.emit('shopResult', { success: false, message: 'Inventory full!' });
      return;
    }

    // Deduct gold
    p.stats.gold -= buyPrice;

    // Decrement stock
    if (entry.stock > 0) {
      entry.stock--;
      if (!entry.lastRefill) entry.lastRefill = Date.now();
    }

    debouncedSave(currentLayer);
    sendInventoryUpdate(socket, p);

    // Resend shop data with updated stock
    const pricedItems = shop.inventory.map(e => {
      const d = getItemDef(e.itemId);
      if (!d) return null;
      return {
        itemId: e.itemId,
        name: d.name,
        char: d.char,
        rarity: d.rarity,
        buyPrice: Math.ceil((d.value || 0) * shop.buyMarkup),
        stock: e.stock,
      };
    }).filter(Boolean);

    socket.emit('shopResult', { success: true, gold: p.stats.gold });
    socket.emit('shopData', {
      shopId: shop.id,
      shopName: shop.name,
      buyMarkup: shop.buyMarkup,
      sellMarkup: shop.sellMarkup,
      inventory: pricedItems,
    });
  });

  socket.on('sellToShop', (data) => {
    const p = players.get(id);
    if (!p || p.openShopId === undefined) return;
    const { shopId, hotbarSlot } = data;
    if (shopId !== p.openShopId) return;
    if (typeof hotbarSlot !== 'number' || hotbarSlot < 0 || hotbarSlot >= 8) return;

    const item = p.inventory[hotbarSlot];
    if (!item) return;

    const currentLayer = layerManager.getLayer(p.openShopLayerId);
    if (!currentLayer) return;

    const shop = currentLayer.shops.find(s => s.id === shopId);
    if (!shop) return;

    const sellPrice = Math.floor((item.value || 0) * shop.sellMarkup);
    if (sellPrice <= 0) {
      socket.emit('shopResult', { success: false, message: 'Cannot sell this item.' });
      return;
    }

    // Remove item (handle stacks)
    if (item.count > 1) {
      item.count--;
    } else {
      p.inventory[hotbarSlot] = null;
    }

    // Add gold
    p.stats.gold += sellPrice;

    sendInventoryUpdate(socket, p);
    socket.emit('shopResult', { success: true, gold: p.stats.gold });
  });

  socket.on('closeShop', () => {
    const p = players.get(id);
    if (p) {
      delete p.openShopId;
      delete p.openShopLayerId;
    }
  });

  // Debug: set sanity (temporary, for testing enemies)
  socket.on('debugSanity', (data) => {
    const p = players.get(id);
    if (!p || typeof data.sanity !== 'number') return;
    p.stats.sanity = Math.max(0, Math.min(100, data.sanity));
    socket.emit('damage', { stats: p.stats });
    console.log(`[DEBUG] Player ${id} sanity set to ${p.stats.sanity}`);
  });

  socket.on('disconnect', () => {
    const playerLayerId = layerManager.getPlayerLayerId(id);
    const playerLayer = layerManager.getLayer(playerLayerId);

    // Remove wing exit before removing player
    if (playerLayer && playerLayer.type === 'dynamic') {
      removeWingExit(playerLayer, id);
    }

    // Despawn player's enemies
    enemyManager.despawnForPlayer(id);

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
      enemyManager.despawnForLayer(playerLayerId);
      layerManager.deleteLayer(playerLayerId);
      for (const key of containerState.keys()) {
        if (key.startsWith(`${playerLayerId}:`)) containerState.delete(key);
      }
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

    // Send enemy snapshot for this layer to admin
    const layerEnemies = enemyManager.getEnemiesOnLayer(layerId).map(e => ({
      id: e.id, type: e.type, x: e.x, y: e.y, facing: e.facing,
      hp: e.hp, maxHp: e.maxHp, char: e.char, color: e.color,
      name: e.name, state: e.state,
    }));
    socket.emit('adminEnemySnapshot', { enemies: layerEnemies });
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
    const removedShopIds = [];
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

      // Shop overwrite protection: remove shop if painting over it
      const shop = layer.getShopAt(x, y);
      if (shop) {
        layer.removeShop(shop.id);
        removedShopIds.push(shop.id);
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
    if (removedShopIds.length > 0) {
      for (const shopId of removedShopIds) {
        adminiNs.to(`admin:layer:${layerId}`).emit('shopRemoved', { layerId, shopId });
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

  // --- Editor: Place shop ---
  socket.on('placeShop', ({ layerId, x, y, name }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;

    // Don't place if there's already a shop here
    if (layer.getShopAt(x, y)) return;

    const shop = {
      id: layer.getNextShopId(),
      x, y,
      name: name || 'Shopkeeper',
      buyMarkup: 1.0,
      sellMarkup: 0.8,
      inventory: [],
    };

    layer.ensureChunkAt(x, y);
    layer.addShop(shop);
    debouncedSave(layer);

    adminiNs.to(`admin:layer:${layerId}`).emit('shopPlaced', { layerId, shop });
    console.log(`Shop placed at (${x},${y}) on layer ${layerId} — "${shop.name}"`);
  });

  // --- Editor: Remove shop ---
  socket.on('removeShop', ({ layerId, shopId }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;

    const shop = layer.removeShop(shopId);
    if (!shop) return;

    debouncedSave(layer);
    adminiNs.to(`admin:layer:${layerId}`).emit('shopRemoved', { layerId, shopId });
  });

  // --- Editor: Update shop ---
  socket.on('updateShop', ({ layerId, shopId, name, buyMarkup, sellMarkup, inventory }) => {
    const layer = layerManager.getLayer(layerId);
    if (!layer || layer.type !== 'static') return;

    const shop = layer.getShopById(shopId);
    if (!shop) return;

    if (name) shop.name = name;
    if (typeof buyMarkup === 'number') shop.buyMarkup = buyMarkup;
    if (typeof sellMarkup === 'number') shop.sellMarkup = sellMarkup;
    if (Array.isArray(inventory)) shop.inventory = inventory;

    debouncedSave(layer);
    adminiNs.to(`admin:layer:${layerId}`).emit('shopUpdated', { layerId, shop });
  });

  // --- Items CRUD ---
  socket.on('getItems', () => {
    socket.emit('itemList', { items: getAllItems() });
  });

  socket.on('saveItem', ({ item }) => {
    if (!item || !item.id || typeof item.id !== 'string') return;
    const items = getAllItems();
    items[item.id] = item;
    loadItemRegistry(items);
    debouncedItemSave();
    socket.emit('itemSaved', { item });
    socket.broadcast.emit('itemSaved', { item });
  });

  socket.on('deleteItem', ({ id: itemId }) => {
    if (!itemId) return;
    const items = getAllItems();
    delete items[itemId];
    loadItemRegistry(items);
    debouncedItemSave();
    socket.emit('itemDeleted', { id: itemId });
    socket.broadcast.emit('itemDeleted', { id: itemId });
  });

  // --- Enemy types ---
  socket.on('getEnemyTypes', () => {
    socket.emit('enemyTypeList', getEnemyTypes());
  });

  socket.on('saveEnemyType', ({ id, ...fields }) => {
    if (!id || typeof id !== 'string') return;
    const allowed = ['name', 'char', 'color', 'hp', 'damage', 'armor', 'moveSpeed', 'sightRange', 'ownership', 'attackRange', 'attackSpeed', 'incorporeal'];
    const changes = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        if (['hp', 'damage', 'armor', 'moveSpeed', 'sightRange', 'attackRange', 'attackSpeed'].includes(key)) {
          changes[key] = Number(fields[key]) || 0;
        } else if (key === 'incorporeal') {
          changes[key] = fields[key] === true || fields[key] === 'true';
        } else {
          changes[key] = fields[key];
        }
      }
    }
    if (!updateEnemyType(id, changes)) return;
    debouncedEnemyTypeSave();
    const updated = getEnemyTypes();
    socket.emit('enemyTypeSaved', { id, type: updated[id] });
    socket.broadcast.emit('enemyTypeSaved', { id, type: updated[id] });
  });

  // --- Container config ---
  socket.on('getContainerConfig', () => {
    socket.emit('containerConfig', getContainerConfig());
  });

  socket.on('saveContainerConfig', async (config) => {
    if (!config || typeof config !== 'object') return;
    setContainerConfig(config);
    await saveContainerConfig();
    socket.emit('containerConfigSaved', config);
  });

  // --- Rarity weights ---
  socket.on('getRarityWeights', () => {
    const data = getRarityWeights().map(b => ({
      maxDepth: b.maxDepth === Infinity ? null : b.maxDepth,
      weights: [...b.weights],
    }));
    socket.emit('rarityWeights', data);
  });

  socket.on('saveRarityWeights', async (brackets) => {
    if (!Array.isArray(brackets) || brackets.length === 0) return;
    // Validate each bracket
    for (const b of brackets) {
      if (!Array.isArray(b.weights) || b.weights.length !== 5) return;
      if (b.maxDepth !== null && (typeof b.maxDepth !== 'number' || b.maxDepth < 0)) return;
    }
    const weights = brackets.map(b => ({
      maxDepth: b.maxDepth === null ? Infinity : b.maxDepth,
      weights: b.weights.map(w => Number(w) || 0),
    }));
    setRarityWeights(weights);
    await saveRarityWeightsFile();
    const savedData = weights.map(b => ({
      maxDepth: b.maxDepth === Infinity ? null : b.maxDepth,
      weights: [...b.weights],
    }));
    socket.emit('rarityWeightsSaved', savedData);
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

// Enemy AI tick: every 200ms
setInterval(() => {
  const now = Date.now();
  enemyManager.tick(players, layerManager, io, now, adminiNs, {
    applyFlatDamage,
    getLayerBlood,
    dropBlood,
    splatter: bloodSplatter,
  });

  // Player auto-attack: each player attacks nearest enemy in range
  for (const [playerId, p] of players) {
    if (p.activeDamage <= 0) continue;
    if (now - p.lastAttackTime < p.attackSpeed) continue;

    const playerLayerId = layerManager.getPlayerLayerId(playerId);
    if (playerLayerId === undefined) continue;

    // Get all enemies on this layer (layer-based + player-owned)
    const layerEnemies = enemyManager.getEnemiesOnLayer(playerLayerId);
    const ownerEnemies = [];
    const ownerSet = enemyManager.byOwner.get(playerId);
    if (ownerSet) {
      for (const eid of ownerSet) {
        const e = enemyManager.enemies.get(eid);
        if (e && e.layerId === playerLayerId) ownerEnemies.push(e);
      }
    }

    // Combine and find closest in range
    const allEnemies = [...layerEnemies.filter(e => e.ownerType === 'layer'), ...ownerEnemies];
    let closest = null;
    let closestDist = Infinity;
    for (const e of allEnemies) {
      const d = Math.abs(e.x - p.x) + Math.abs(e.y - p.y);
      if (d <= p.attackRange && d < closestDist) {
        closest = e;
        closestDist = d;
      }
    }

    if (!closest) continue;

    // Apply damage
    const reducedDamage = Math.max(1, p.activeDamage - closest.armor);
    closest.hp -= reducedDamage;
    closest.bleedStacks += Math.floor(reducedDamage / 5);

    // Face player toward enemy
    const dx = closest.x - p.x;
    const dy = closest.y - p.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      p.facing = dx > 0 ? 'east' : 'west';
    } else {
      p.facing = dy > 0 ? 'south' : 'north';
    }
    p.lastAttackTime = now;

    // Generate blood at enemy position
    const blood = getLayerBlood(playerLayerId);
    const bloodUpdate = bloodSplatter(blood, closest.x, closest.y, 1);
    io.to(`layer:${playerLayerId}`).emit('bloodUpdate', { updates: [bloodUpdate] });

    // Emit attack event to player
    const sock = io.sockets.sockets.get(playerId);
    if (sock) {
      sock.emit('playerAttack', {
        enemyId: closest.id,
        damage: reducedDamage,
        enemyHp: closest.hp,
        enemyMaxHp: closest.maxHp,
      });
      // Also broadcast facing change
      sock.to(`layer:${playerLayerId}`).emit('playerState', { id: playerId, facing: p.facing });
    }

    // Kill enemy if dead
    if (closest.hp <= 0) {
      io.to(`layer:${playerLayerId}`).emit('enemyDied', { enemyId: closest.id, x: closest.x, y: closest.y });
      enemyManager.killEnemy(closest.id);
    }
  }
}, 200);

// Enemy bleed tick: every 2s
setInterval(() => {
  const toKill = [];
  for (const [eid, enemy] of enemyManager.enemies) {
    if (enemy.bleedStacks <= 0) continue;
    enemy.hp -= enemy.bleedStacks * 0.2;

    // Generate blood
    const blood = getLayerBlood(enemy.layerId);
    const bloodUpdate = dropBlood(blood, enemy.x, enemy.y);
    io.to(`layer:${enemy.layerId}`).emit('bloodUpdate', { updates: [bloodUpdate] });

    if (enemy.hp <= 0) {
      io.to(`layer:${enemy.layerId}`).emit('enemyDied', { enemyId: enemy.id, x: enemy.x, y: enemy.y });
      toKill.push(enemy.id);
    } else {
      // Broadcast HP update to layer
      io.to(`layer:${enemy.layerId}`).emit('enemyHpUpdate', {
        id: enemy.id,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
        bleedStacks: enemy.bleedStacks,
      });
    }
  }
  for (const eid of toKill) enemyManager.killEnemy(eid);
}, 2000);

http.listen(PORT, () => {
  console.log(`Den server running on http://localhost:${PORT}`);
});
