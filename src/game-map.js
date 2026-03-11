import { TILE, TILE_META } from './config.js';
import { CHUNK_SIZE, chunkKey, worldToChunk, chunkIndex } from './chunk.js';

export class GameMap {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.chunks = new Map();        // chunkKey -> Uint8Array(CHUNK_SIZE²)
    this.visible = new Uint8Array(0);
    this.explored = new Uint8Array(0);
    this.previousVisible = new Set();
    this.overlay = new Map();       // packed coord -> {char, color, passable}
    this.doors = new Map();         // packed coord -> door object
    this._allDoors = [];            // flat list for setDoorState lookup
  }

  /** Initialize map dimensions and allocate visibility arrays */
  _initArrays(width, height) {
    this.width = width;
    this.height = height;
    this.visible = new Uint8Array(width * height);
    this.explored = new Uint8Array(width * height);
    this.previousVisible = new Set();
  }

  /** Initialize from layer metadata bounds (call before loadChunks) */
  initBounds(bounds) {
    this._initArrays(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    this.chunks.clear();
    this.overlay = new Map();
    this.doors = new Map();
    this._allDoors = [];
  }

  /** Load from flat array (backward-compat: converts to chunks internally) */
  load(data, width, height) {
    this._initArrays(width, height);
    this.chunks.clear();
    this.overlay = new Map();
    this.doors = new Map();
    this._allDoors = [];

    // Convert flat array to chunks
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
              tiles[ly * CHUNK_SIZE + lx] = data[wy * width + wx];
            }
          }
        }
        this.chunks.set(chunkKey(cx, cy), tiles);
      }
    }
  }

  /** Load chunks from server chunk data array */
  loadChunks(chunksArray) {
    for (const chunk of chunksArray) {
      this.chunks.set(chunkKey(chunk.cx, chunk.cy), new Uint8Array(chunk.tiles));
      if (chunk.overlay) {
        for (const [x, y, char, color, passable] of chunk.overlay) {
          this.overlay.set(this._overlayKey(x, y), { char, color, passable });
        }
      }
      if (chunk.doors) {
        for (const door of chunk.doors) {
          this._registerDoor(door);
        }
      }
    }
  }

  /** Register a door into the lookup maps */
  _registerDoor(door) {
    // Deduplicate: if this door ID is already registered, reuse the existing
    // object so all tile mappings share the same reference (important for setDoorState)
    let ref = this._allDoors.find(d => d.id === door.id);
    if (!ref) {
      this._allDoors.push(door);
      ref = door;
    }
    for (let i = 0; i < (ref.length || 1); i++) {
      const tx = ref.orientation === 'horizontal' ? ref.x + i : ref.x;
      const ty = ref.orientation === 'vertical' ? ref.y + i : ref.y;
      this.doors.set(this._doorKey(tx, ty), ref);
    }
  }

  getTile(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return TILE.VOID;
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (!chunk) return TILE.VOID;
    return chunk[chunkIndex(lx, ly)];
  }

  setTile(x, y, tile) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (!chunk) return;
    chunk[chunkIndex(lx, ly)] = tile;
  }

  isPassable(x, y) {
    const t = this.getTile(x, y);
    const meta = TILE_META[t];
    if (!meta || !meta.passable) return false;
    const ov = this.getOverlay(x, y);
    if (ov && !ov.passable) return false;
    return true;
  }

  blocksLight(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return true;
    const t = this.getTile(x, y);
    const meta = TILE_META[t];
    return meta ? meta.blocksLight : true;
  }

  // --- Visibility ---
  setVisible(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const idx = y * this.width + x;
    this.visible[idx] = 1;
    this.explored[idx] = 1;
  }

  isVisible(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    return this.visible[y * this.width + x] === 1;
  }

  isExplored(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    return this.explored[y * this.width + x] === 1;
  }

  resetVisibility() {
    this.previousVisible.clear();
    for (let i = 0; i < this.visible.length; i++) {
      if (this.visible[i]) {
        const x = i % this.width;
        const y = (i / this.width) | 0;
        this.previousVisible.add((x << 16) | (y & 0xFFFF));
      }
    }
    this.visible.fill(0);
  }

  // --- Overlay (furniture) ---
  _overlayKey(x, y) {
    return (x << 16) | (y & 0xFFFF);
  }

  getOverlay(x, y) {
    return this.overlay.get(this._overlayKey(x, y)) || null;
  }

  setOverlay(x, y, data) {
    this.overlay.set(this._overlayKey(x, y), data);
  }

  loadOverlay(overlayArray) {
    this.overlay = new Map();
    if (!overlayArray) return;
    for (const [x, y, char, color, passable] of overlayArray) {
      this.overlay.set(this._overlayKey(x, y), { char, color, passable });
    }
  }

  // --- Doors (multi-tile) ---
  _doorKey(x, y) {
    return (x << 16) | (y & 0xFFFF);
  }

  getDoorAt(x, y) {
    return this.doors.get(this._doorKey(x, y)) || null;
  }

  loadDoors(doorsArray) {
    this.doors = new Map();
    this._allDoors = [];
    if (!doorsArray) return;
    for (const door of doorsArray) {
      this._registerDoor(door);
    }
  }

  setDoorState(doorId, isOpen) {
    const door = this._allDoors.find(d => d.id === doorId);
    if (!door) return;
    door.isOpen = isOpen;
    const tileType = isOpen ? TILE.DOOR_OPEN : TILE.DOOR_CLOSED;
    for (let i = 0; i < (door.length || 1); i++) {
      const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
      const ty = door.orientation === 'vertical' ? door.y + i : door.y;
      this.setTile(tx, ty, tileType);
    }
  }

  /** Get bounds of the map in world coordinates */
  getLoadedBounds() {
    return { minX: 0, minY: 0, maxX: this.width, maxY: this.height };
  }
}
