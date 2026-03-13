// Server-side layer management — chunk-based storage, static + dynamic layers

import { CHUNK_SIZE, chunkKey, parseChunkKey, worldToChunk, chunkToWorld, chunkIndex } from './src/chunk.js';

const TILE_VOID = 0;
const TILE_WALL = 1;
const TILE_FLOOR = 2;
const TILE_DOOR_CLOSED = 3;
const TILE_DOOR_OPEN = 4;
const TILE_GRASS = 5;
const TILE_WALL_MOSSY = 6;
const TILE_ENTRY = 7;

// Tiles that are "sacred" in bone data — always shown, never overridden by wings
const BONE_SACRED = new Set([TILE_FLOOR, TILE_DOOR_CLOSED, TILE_DOOR_OPEN, TILE_GRASS, TILE_ENTRY]);

// ─── Static Layer ────────────────────────────────────────────────────────────
// Hand-crafted or BSP-generated map, identical for all players.

export class StaticLayer {
  constructor(id, dungeonData) {
    this.id = id;
    this.type = 'static';
    this.rooms = dungeonData.rooms;
    this.doors = dungeonData.doors;
    this.players = new Set();
    this.bounds = { minX: 0, minY: 0, maxX: dungeonData.width, maxY: dungeonData.height };

    // Entry points for inter-layer navigation
    this.entryUp = dungeonData.entryUp || null;     // {x,y} — sends players UP
    this.entryDown = dungeonData.entryDown || null;  // {x,y} — sends players DOWN

    // Info points: [{id, x, y, text}, ...]
    this.infoPoints = dungeonData.infoPoints || [];

    // Shops: [{id, x, y, name, buyMarkup, sellMarkup, inventory}, ...]
    this.shops = dungeonData.shops || [];

    // Chunk storage: chunkKey -> { tiles, overlay, doors, infoPoints, shops }
    this.chunks = new Map();
    this._chunkify(dungeonData.map, dungeonData.width, dungeonData.height);
    this._distributeOverlay(dungeonData.overlay);
    this._distributeDoors();
    this._distributeInfoPoints();
    this._distributeShops();
  }

  /** Convert flat map array to chunks */
  _chunkify(flatMap, width, height) {
    const chunksX = Math.ceil(width / CHUNK_SIZE);
    const chunksY = Math.ceil(height / CHUNK_SIZE);
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const wx = cx * CHUNK_SIZE + lx;
            const wy = cy * CHUNK_SIZE + ly;
            if (wx < width && wy < height) {
              tiles[ly * CHUNK_SIZE + lx] = flatMap[wy * width + wx];
            }
          }
        }
        this.chunks.set(chunkKey(cx, cy), { tiles, overlay: [], doors: [], infoPoints: [], shops: [] });
      }
    }
  }

  /** Assign overlay entries to their respective chunks */
  _distributeOverlay(overlay) {
    if (!overlay) return;
    for (const entry of overlay) {
      const [x, y] = entry;
      const { cx, cy } = worldToChunk(x, y);
      const key = chunkKey(cx, cy);
      const chunk = this.chunks.get(key);
      if (chunk) chunk.overlay.push(entry);
    }
  }

  /** Assign doors to chunks they touch */
  _distributeDoors() {
    if (!this.doors) return;
    for (const door of this.doors) {
      const touchedChunks = new Set();
      for (let i = 0; i < (door.length || 1); i++) {
        const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
        const ty = door.orientation === 'vertical' ? door.y + i : door.y;
        const { cx, cy } = worldToChunk(tx, ty);
        const key = chunkKey(cx, cy);
        if (!touchedChunks.has(key)) {
          touchedChunks.add(key);
          const chunk = this.chunks.get(key);
          if (chunk) chunk.doors.push(door);
        }
      }
    }
  }

  /** Assign info points to their respective chunks */
  _distributeInfoPoints() {
    if (!this.infoPoints) return;
    for (const info of this.infoPoints) {
      const { cx, cy } = worldToChunk(info.x, info.y);
      const key = chunkKey(cx, cy);
      const chunk = this.chunks.get(key);
      if (chunk) chunk.infoPoints.push(info);
    }
  }

  /** Assign shops to their respective chunks */
  _distributeShops() {
    if (!this.shops) return;
    for (const shop of this.shops) {
      const { cx, cy } = worldToChunk(shop.x, shop.y);
      const key = chunkKey(cx, cy);
      const chunk = this.chunks.get(key);
      if (chunk) chunk.shops.push(shop);
    }
  }

  /** Expand bounds to include position (x, y). Handles empty initial state. */
  _expandBounds(x, y) {
    if (this.bounds.minX === 0 && this.bounds.maxX === 0 && this.bounds.minY === 0 && this.bounds.maxY === 0) {
      // First tile placed on an empty layer
      this.bounds = { minX: x, minY: y, maxX: x + 1, maxY: y + 1 };
    } else {
      if (x < this.bounds.minX) this.bounds.minX = x;
      if (y < this.bounds.minY) this.bounds.minY = y;
      if (x + 1 > this.bounds.maxX) this.bounds.maxX = x + 1;
      if (y + 1 > this.bounds.maxY) this.bounds.maxY = y + 1;
    }
  }

  /** Serialize layer to JSON for persistence (chunk-based format) */
  toJSON() {
    const chunks = {};
    for (const [key, chunk] of this.chunks) {
      // Only save non-empty chunks
      let hasContent = false;
      for (let i = 0; i < chunk.tiles.length; i++) {
        if (chunk.tiles[i] !== TILE_VOID) { hasContent = true; break; }
      }
      if (!hasContent && (!chunk.overlay || chunk.overlay.length === 0)) continue;
      chunks[key] = {
        tiles: Array.from(chunk.tiles),
        overlay: chunk.overlay || [],
      };
    }

    return {
      format: 'chunks',
      bounds: this.bounds,
      chunks,
      rooms: this.rooms,
      doors: this.doors,
      infoPoints: this.infoPoints,
      shops: this.shops,
      entryUp: this.entryUp,
      entryDown: this.entryDown,
    };
  }

  getTile(x, y) {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (!chunk) return TILE_VOID;
    return chunk.tiles[chunkIndex(lx, ly)];
  }

  setTile(x, y, tile) {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (!chunk) return;
    chunk.tiles[chunkIndex(lx, ly)] = tile;
  }

  getSpawn() {
    if (this.rooms.length > 0) {
      const room = this.rooms[0];
      const cx = room.cx || Math.floor(room.x + room.w / 2);
      const cy = room.cy || Math.floor(room.y + room.h / 2);
      const ox = Math.floor(Math.random() * 5) - 2;
      const oy = Math.floor(Math.random() * 5) - 2;
      const x = Math.max(room.x + 1, Math.min(room.x + room.w - 2, cx + ox));
      const y = Math.max(room.y + 1, Math.min(room.y + room.h - 2, cy + oy));
      if (this.getTile(x, y) === TILE_FLOOR) return { x, y };
      return { x: cx, y: cy };
    }
    return { x: Math.floor(this.bounds.maxX / 2), y: Math.floor(this.bounds.maxY / 2) };
  }

  /** Get spawn point based on arrival direction */
  getSpawnForArrival(fromDirection) {
    if (fromDirection === 'above' && this.entryUp) return { ...this.entryUp };
    if (fromDirection === 'below' && this.entryDown) return { ...this.entryDown };
    return this.getSpawn();
  }

  /** Ensure chunk exists at given world position, creating if needed */
  ensureChunkAt(x, y) {
    const { cx, cy } = worldToChunk(x, y);
    const key = chunkKey(cx, cy);
    if (!this.chunks.has(key)) {
      this.chunks.set(key, { tiles: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE), overlay: [], doors: [], infoPoints: [], shops: [] });
    }
    return this.chunks.get(key);
  }

  /** Get serializable chunk data for a list of chunk keys */
  getChunksByKeys(keys) {
    const result = [];
    for (const key of keys) {
      const chunk = this.chunks.get(key);
      if (chunk) {
        const { cx, cy } = parseChunkKey(key);
        result.push({
          cx, cy,
          tiles: Array.from(chunk.tiles),
          overlay: chunk.overlay,
          doors: chunk.doors,
          infoPoints: chunk.infoPoints,
          shops: chunk.shops,
        });
      }
    }
    return result;
  }

  /** Get chunk keys within radius of a world position */
  getChunkKeysAround(wx, wy, radius) {
    const { cx: pcx, cy: pcy } = worldToChunk(wx, wy);
    const keys = [];
    for (let cy = pcy - radius; cy <= pcy + radius; cy++) {
      for (let cx = pcx - radius; cx <= pcx + radius; cx++) {
        const key = chunkKey(cx, cy);
        if (this.chunks.has(key)) keys.push(key);
      }
    }
    return keys;
  }

  /** Get layer metadata (sent to client on connect) */
  getMeta() {
    return {
      id: this.id,
      type: this.type,
      bounds: this.bounds,
      entryUp: this.entryUp,
      entryDown: this.entryDown,
    };
  }

  /** Add a door to the layer and distribute to chunks */
  addDoor(door) {
    this.doors.push(door);
    const touchedChunks = new Set();
    for (let i = 0; i < (door.length || 1); i++) {
      const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
      const ty = door.orientation === 'vertical' ? door.y + i : door.y;
      const { cx, cy } = worldToChunk(tx, ty);
      const key = chunkKey(cx, cy);
      if (!touchedChunks.has(key)) {
        touchedChunks.add(key);
        const chunk = this.chunks.get(key);
        if (chunk) chunk.doors.push(door);
      }
    }
  }

  /** Remove a door by ID, returns the removed door or null */
  removeDoor(doorId) {
    const idx = this.doors.findIndex(d => d.id === doorId);
    if (idx < 0) return null;
    const door = this.doors[idx];
    this.doors.splice(idx, 1);
    for (const [, chunk] of this.chunks) {
      const ci = chunk.doors.findIndex(d => d.id === doorId);
      if (ci >= 0) chunk.doors.splice(ci, 1);
    }
    return door;
  }

  /** Find door at world position */
  getDoorAt(x, y) {
    for (const door of this.doors) {
      for (let i = 0; i < (door.length || 1); i++) {
        const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
        const ty = door.orientation === 'vertical' ? door.y + i : door.y;
        if (tx === x && ty === y) return door;
      }
    }
    return null;
  }

  /** Get next available door ID */
  getNextDoorId() {
    let maxId = 0;
    for (const door of this.doors) {
      if (door.id > maxId) maxId = door.id;
    }
    return maxId + 1;
  }

  /** Add an info point to the layer and distribute to chunks */
  addInfoPoint(info) {
    this.infoPoints.push(info);
    const { cx, cy } = worldToChunk(info.x, info.y);
    const key = chunkKey(cx, cy);
    const chunk = this.chunks.get(key);
    if (chunk) chunk.infoPoints.push(info);
  }

  /** Remove an info point by ID, returns the removed info or null */
  removeInfoPoint(infoId) {
    const idx = this.infoPoints.findIndex(i => i.id === infoId);
    if (idx < 0) return null;
    const info = this.infoPoints[idx];
    this.infoPoints.splice(idx, 1);
    for (const [, chunk] of this.chunks) {
      const ci = chunk.infoPoints.findIndex(i => i.id === infoId);
      if (ci >= 0) chunk.infoPoints.splice(ci, 1);
    }
    return info;
  }

  /** Find info point at world position */
  getInfoAt(x, y) {
    return this.infoPoints.find(i => i.x === x && i.y === y) || null;
  }

  /** Get next available info point ID */
  getNextInfoId() {
    let maxId = 0;
    for (const info of this.infoPoints) {
      if (info.id > maxId) maxId = info.id;
    }
    return maxId + 1;
  }

  /** Add a shop to the layer and distribute to chunks */
  addShop(shop) {
    this.shops.push(shop);
    const { cx, cy } = worldToChunk(shop.x, shop.y);
    const key = chunkKey(cx, cy);
    const chunk = this.chunks.get(key);
    if (chunk) chunk.shops.push(shop);
  }

  /** Remove a shop by ID, returns the removed shop or null */
  removeShop(shopId) {
    const idx = this.shops.findIndex(s => s.id === shopId);
    if (idx < 0) return null;
    const shop = this.shops[idx];
    this.shops.splice(idx, 1);
    for (const [, chunk] of this.chunks) {
      const ci = chunk.shops.findIndex(s => s.id === shopId);
      if (ci >= 0) chunk.shops.splice(ci, 1);
    }
    return shop;
  }

  /** Find shop at world position */
  getShopAt(x, y) {
    return this.shops.find(s => s.x === x && s.y === y) || null;
  }

  /** Find shop by ID */
  getShopById(shopId) {
    return this.shops.find(s => s.id === shopId) || null;
  }

  /** Get next available shop ID */
  getNextShopId() {
    let maxId = 0;
    for (const shop of this.shops) {
      if (shop.id > maxId) maxId = shop.id;
    }
    return maxId + 1;
  }

  addPlayer(socketId) { this.players.add(socketId); }
  removePlayer(socketId) { this.players.delete(socketId); }
}

// ─── Dynamic Layer ───────────────────────────────────────────────────────────
// Procedurally generated from seed. Bones (shared) + Wings (per-player).

export class DynamicLayer {
  constructor(id, { seed, skeletonDensity, maxWidth, maxHeight, boneData }) {
    this.id = id;
    this.type = 'dynamic';
    this.seed = seed;
    this.skeletonDensity = skeletonDensity;
    this.bounds = { minX: 0, minY: 0, maxX: maxWidth, maxY: maxHeight };
    this.players = new Set();
    this.materialized = false;

    // Shared bone chunks
    this.bones = new Map();      // chunkKey -> { tiles, overlay, doors }
    this.boneRooms = [];
    this.boneDoors = [];

    // Per-player dungeons
    this.playerDungeons = new Map(); // socketId -> PlayerDungeon

    // Wing exits: playerId -> {x, y} — promoted ENTRY tiles in bones
    this.wingExits = new Map();

    // Load bone data if provided (eager mode — also sets materialized)
    if (boneData) {
      this._loadBoneData(boneData);
      this.materialized = true;
    }
  }

  /** Materialize the layer: load bone data, mark as materialized */
  materialize(boneData) {
    this._loadBoneData(boneData);
    this.materialized = true;
  }

  /** Dematerialize: clear bones, rooms, doors, and all player dungeons */
  dematerialize() {
    this.bones.clear();
    this.boneRooms = [];
    this.boneDoors = [];
    this.playerDungeons.clear();
    this.wingExits.clear();
    this.materialized = false;
  }

  _loadBoneData(boneData) {
    this.boneRooms = boneData.rooms || [];
    this.boneDoors = boneData.doors || [];

    // Store bone chunks
    if (boneData.chunks) {
      for (const [key, chunkData] of boneData.chunks) {
        this.bones.set(key, chunkData);
      }
    }
  }

  getTile(x, y) {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const key = chunkKey(cx, cy);
    const bone = this.bones.get(key);
    if (bone) {
      const t = bone.tiles[chunkIndex(lx, ly)];
      if (t !== TILE_VOID) return t;
    }
    return TILE_VOID;
  }

  /** Get composited tile for a specific player (bone wins over wing) */
  getCompositedTile(playerId, x, y) {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const key = chunkKey(cx, cy);
    const idx = chunkIndex(lx, ly);

    // Bone tile takes priority
    const bone = this.bones.get(key);
    if (bone) {
      const t = bone.tiles[idx];
      if (t !== TILE_VOID) return t;
    }

    // Fall back to player's wing
    const pd = this.playerDungeons.get(playerId);
    if (pd) {
      const wing = pd.chunks.get(key);
      if (wing) return wing.tiles[idx];
    }

    return TILE_VOID;
  }

  setTile(x, y, tile) {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const key = chunkKey(cx, cy);
    // Update bone chunk if the tile is there
    const bone = this.bones.get(key);
    if (bone) {
      bone.tiles[chunkIndex(lx, ly)] = tile;
    }
  }

  /** Composite a chunk for a specific player (bone + wing merge) */
  compositeChunk(playerId, cx, cy) {
    const key = chunkKey(cx, cy);
    const bone = this.bones.get(key);
    const pd = this.playerDungeons.get(playerId);
    const wing = pd?.chunks.get(key);

    if (!bone && !wing) return null;

    const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    const overlay = [];
    const doors = [];
    const seenDoorIds = new Set();

    // Compositing rule:
    // - Bone floor/door/grass/entry = sacred, always shown (shared structure)
    // - Wing can override bone walls (personal entry points into bones)
    // - Otherwise bone tile shown, then wing tile, then void
    for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
      const boneTile = bone?.tiles[i] ?? TILE_VOID;
      const wingTile = wing?.tiles[i] ?? TILE_VOID;

      if (BONE_SACRED.has(boneTile)) {
        tiles[i] = boneTile;                // bone floor is sacred
      } else if (wingTile !== TILE_VOID) {
        tiles[i] = wingTile;                // wing overrides bone walls/void
      } else {
        tiles[i] = boneTile;                // fall back to bone (WALL/VOID)
      }
    }

    // Merge overlay: bone overlay for sacred tiles, wing overlay elsewhere
    if (bone?.overlay) overlay.push(...bone.overlay);
    if (wing?.overlay) {
      for (const entry of wing.overlay) {
        const [ox, oy] = entry;
        const { lx, ly } = worldToChunk(ox, oy);
        const boneT = bone?.tiles[chunkIndex(lx, ly)] ?? TILE_VOID;
        if (!BONE_SACRED.has(boneT)) overlay.push(entry);
      }
    }

    // Merge doors (deduplicate by id)
    if (bone?.doors) {
      for (const d of bone.doors) {
        if (!seenDoorIds.has(d.id)) { seenDoorIds.add(d.id); doors.push(d); }
      }
    }
    if (wing?.doors) {
      for (const d of wing.doors) {
        if (!seenDoorIds.has(d.id)) { seenDoorIds.add(d.id); doors.push(d); }
      }
    }

    return { cx, cy, tiles: Array.from(tiles), overlay, doors };
  }

  getSpawn() {
    // Spawn in first bone room
    if (this.boneRooms.length > 0) {
      const room = this.boneRooms[0];
      const cx = room.cx || Math.floor(room.x + room.w / 2);
      const cy = room.cy || Math.floor(room.y + room.h / 2);
      return { x: cx, y: cy };
    }
    return { x: Math.floor(this.bounds.maxX / 2), y: Math.floor(this.bounds.maxY / 2) };
  }

  /** Get composited chunks for a player by key list */
  getChunksForPlayer(playerId, keys) {
    const result = [];
    for (const key of keys) {
      const { cx, cy } = parseChunkKey(key);
      const composited = this.compositeChunk(playerId, cx, cy);
      if (composited) result.push(composited);
    }
    return result;
  }

  /** Get chunk keys within radius of a world position (any non-empty composite) */
  getChunkKeysAround(wx, wy, radius) {
    const { cx: pcx, cy: pcy } = worldToChunk(wx, wy);
    const keys = [];
    for (let cy = pcy - radius; cy <= pcy + radius; cy++) {
      for (let cx = pcx - radius; cx <= pcx + radius; cx++) {
        keys.push(chunkKey(cx, cy));
      }
    }
    return keys;
  }

  getMeta() {
    return {
      id: this.id,
      type: this.type,
      bounds: this.bounds,
      skeletonDensity: this.skeletonDensity,
    };
  }

  addPlayer(socketId) { this.players.add(socketId); }
  removePlayer(socketId) {
    this.players.delete(socketId);
    this.playerDungeons.delete(socketId);
    this.wingExits.delete(socketId);
    return this.players.size;
  }
}

// ─── Player Dungeon (wing data for one player on a dynamic layer) ────────────

export class PlayerDungeon {
  constructor(playerId, seed) {
    this.playerId = playerId;
    this.seed = seed;
    this.chunks = new Map();  // chunkKey -> { tiles, overlay, doors }
    this.rooms = [];
    this.doors = [];
  }
}

// ─── Layer Manager ───────────────────────────────────────────────────────────

export class LayerManager {
  constructor() {
    this.layers = new Map();       // layerId -> StaticLayer | DynamicLayer
    this.playerLayers = new Map(); // socketId -> layerId
  }

  createStaticLayer(id, dungeonData) {
    const layer = new StaticLayer(id, dungeonData);
    this.layers.set(id, layer);
    if (dungeonData.width > 0 || dungeonData.height > 0) {
      console.log(`Layer ${id} created (static, ${dungeonData.width}x${dungeonData.height})`);
    }
    return layer;
  }

  createBlankStaticLayer(id) {
    const data = {
      map: new Uint8Array(0), width: 0, height: 0,
      rooms: [], doors: [], overlay: [],
      entryUp: null, entryDown: null,
    };
    return this.createStaticLayer(id, data);
  }

  /** Create a static layer from chunk-based saved data */
  createStaticLayerFromChunks(id, data) {
    const layer = this.createBlankStaticLayer(id);
    // Load chunks directly
    for (const [key, chunkData] of Object.entries(data.chunks)) {
      layer.chunks.set(key, {
        tiles: new Uint8Array(chunkData.tiles),
        overlay: chunkData.overlay || [],
        doors: [],
        infoPoints: [],
        shops: [],
      });
    }
    layer.bounds = data.bounds || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    layer.rooms = data.rooms || [];
    layer.doors = data.doors || [];
    layer.infoPoints = data.infoPoints || [];
    layer.shops = data.shops || [];
    layer.entryUp = data.entryUp || null;
    layer.entryDown = data.entryDown || null;
    layer._distributeDoors();
    layer._distributeInfoPoints();
    layer._distributeShops();
    const b = layer.bounds;
    console.log(`Layer ${id} restored (static chunks, ${b.maxX - b.minX}x${b.maxY - b.minY}, ${Object.keys(data.chunks).length} chunks)`);
    return layer;
  }

  createDynamicLayer(id, config) {
    const layer = new DynamicLayer(id, config);
    this.layers.set(id, layer);
    console.log(`Layer ${id} created (dynamic, ${config.maxWidth}x${config.maxHeight}, density=${config.skeletonDensity})`);
    return layer;
  }

  getLayer(id) {
    return this.layers.get(id) || null;
  }

  deleteLayer(id) {
    this.layers.delete(id);
    console.log(`Layer ${id} deleted`);
  }

  assignPlayer(socketId, layerId) {
    const oldLayerId = this.playerLayers.get(socketId);
    if (oldLayerId !== undefined) {
      const oldLayer = this.layers.get(oldLayerId);
      if (oldLayer) oldLayer.removePlayer(socketId);
    }
    const layer = this.layers.get(layerId);
    if (!layer) return null;
    layer.addPlayer(socketId);
    this.playerLayers.set(socketId, layerId);
    return layer;
  }

  removePlayer(socketId) {
    const layerId = this.playerLayers.get(socketId);
    if (layerId !== undefined) {
      const layer = this.layers.get(layerId);
      if (layer) layer.removePlayer(socketId);
      this.playerLayers.delete(socketId);
    }
    return layerId;
  }

  getPlayerLayer(socketId) {
    const layerId = this.playerLayers.get(socketId);
    if (layerId === undefined) return null;
    return this.layers.get(layerId) || null;
  }

  getPlayerLayerId(socketId) {
    return this.playerLayers.get(socketId);
  }

  getLayers() {
    const result = [];
    for (const [id, layer] of this.layers) {
      result.push({
        id,
        type: layer.type,
        bounds: layer.bounds,
        playerCount: layer.players.size,
      });
    }
    return result;
  }
}
