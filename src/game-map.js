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
    this.torchOverlay = new Map();  // packed coord -> overlay entry (char === '¥')
    this.infoPoints = new Map();    // packed coord -> info object
    this._allInfos = [];            // flat list
    this.blood = new Map();         // packed coord -> bitmask (quadrants)
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
    this.torchOverlay = new Map();
    this.doors = new Map();
    this._allDoors = [];
    this.infoPoints = new Map();
    this._allInfos = [];
    this.blood = new Map();
  }

  /** Load from flat array (backward-compat: converts to chunks internally) */
  load(data, width, height) {
    this._initArrays(width, height);
    this.chunks.clear();
    this.overlay = new Map();
    this.torchOverlay = new Map();
    this.doors = new Map();
    this._allDoors = [];
    this.infoPoints = new Map();
    this._allInfos = [];
    this.blood = new Map();

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
          const key = this._overlayKey(x, y);
          const entry = { char, color, passable };
          this.overlay.set(key, entry);
          if (char === '¥') this.torchOverlay.set(key, entry);
        }
      }
      if (chunk.doors) {
        for (const door of chunk.doors) {
          this._registerDoor(door);
        }
      }
      if (chunk.infoPoints) {
        for (const info of chunk.infoPoints) {
          this._registerInfo(info);
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
    const len = ref.length || 1;
    // Hinge is always registered at (door.x, door.y)
    this.doors.set(this._doorKey(ref.x, ref.y), ref);
    if (ref.isOpen && len > 1) {
      // Open multi-tile: register swung positions (not original non-hinge)
      for (let i = 1; i < len; i++) {
        let sx, sy;
        switch (ref.swingDirection) {
          case 'south': sx = ref.x; sy = ref.y + i; break;
          case 'north': sx = ref.x; sy = ref.y - i; break;
          case 'east':  sx = ref.x + i; sy = ref.y; break;
          case 'west':  sx = ref.x - i; sy = ref.y; break;
        }
        this.doors.set(this._doorKey(sx, sy), ref);
      }
    } else {
      // Closed (or single-tile): register at original positions
      for (let i = 1; i < len; i++) {
        const tx = ref.orientation === 'horizontal' ? ref.x + i : ref.x;
        const ty = ref.orientation === 'vertical' ? ref.y + i : ref.y;
        this.doors.set(this._doorKey(tx, ty), ref);
      }
    }
  }

  getTile(x, y) {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const chunk = this.chunks.get(chunkKey(cx, cy));
    if (!chunk) return TILE.VOID;
    return chunk[chunkIndex(lx, ly)];
  }

  setTile(x, y, tile) {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      // Auto-create chunk (admin painting beyond loaded area)
      chunk = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
      this.chunks.set(key, chunk);
    }
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
    const key = this._overlayKey(x, y);
    this.overlay.set(key, data);
    if (data.char === '¥') this.torchOverlay.set(key, data);
    else this.torchOverlay.delete(key);
  }

  loadOverlay(overlayArray) {
    this.overlay = new Map();
    this.torchOverlay = new Map();
    if (!overlayArray) return;
    for (const [x, y, char, color, passable] of overlayArray) {
      const key = this._overlayKey(x, y);
      const entry = { char, color, passable };
      this.overlay.set(key, entry);
      if (char === '¥') this.torchOverlay.set(key, entry);
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

  removeDoor(doorId) {
    const door = this._allDoors.find(d => d.id === doorId);
    if (!door) return;
    for (let i = 0; i < (door.length || 1); i++) {
      const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
      const ty = door.orientation === 'vertical' ? door.y + i : door.y;
      this.doors.delete(this._doorKey(tx, ty));
    }
    this._allDoors = this._allDoors.filter(d => d.id !== doorId);
  }

  setDoorState(doorId, isOpen, tileChanges) {
    const door = this._allDoors.find(d => d.id === doorId);
    if (!door) return;
    door.isOpen = isOpen;

    if (tileChanges && tileChanges.length > 0) {
      // Server provided explicit tile changes (multi-tile swing)
      for (const { x, y, tile } of tileChanges) {
        this.setTile(x, y, tile);
      }
      this._updateDoorPositions(door, isOpen);
    } else {
      // Single-tile fallback (current behavior)
      const tileType = isOpen ? TILE.DOOR_OPEN : TILE.DOOR_CLOSED;
      for (let i = 0; i < (door.length || 1); i++) {
        const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
        const ty = door.orientation === 'vertical' ? door.y + i : door.y;
        this.setTile(tx, ty, tileType);
      }
    }
  }

  /** Update door position registrations for swing open/close */
  _updateDoorPositions(door, isOpen) {
    const len = door.length || 1;
    if (len <= 1) return;

    if (isOpen) {
      // Unregister non-hinge original positions, register swung positions
      for (let i = 1; i < len; i++) {
        const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
        const ty = door.orientation === 'vertical' ? door.y + i : door.y;
        this.doors.delete(this._doorKey(tx, ty));
      }
      for (let i = 1; i < len; i++) {
        let sx, sy;
        switch (door.swingDirection) {
          case 'south': sx = door.x; sy = door.y + i; break;
          case 'north': sx = door.x; sy = door.y - i; break;
          case 'east':  sx = door.x + i; sy = door.y; break;
          case 'west':  sx = door.x - i; sy = door.y; break;
        }
        this.doors.set(this._doorKey(sx, sy), door);
      }
    } else {
      // Unregister swung positions, re-register original positions
      for (let i = 1; i < len; i++) {
        let sx, sy;
        switch (door.swingDirection) {
          case 'south': sx = door.x; sy = door.y + i; break;
          case 'north': sx = door.x; sy = door.y - i; break;
          case 'east':  sx = door.x + i; sy = door.y; break;
          case 'west':  sx = door.x - i; sy = door.y; break;
        }
        this.doors.delete(this._doorKey(sx, sy));
      }
      for (let i = 1; i < len; i++) {
        const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
        const ty = door.orientation === 'vertical' ? door.y + i : door.y;
        this.doors.set(this._doorKey(tx, ty), door);
      }
    }
  }

  // --- Info points ---
  _infoKey(x, y) {
    return (x << 16) | (y & 0xFFFF);
  }

  _registerInfo(info) {
    if (this._allInfos.find(i => i.id === info.id)) return;
    this._allInfos.push(info);
    this.infoPoints.set(this._infoKey(info.x, info.y), info);
  }

  getInfoAt(x, y) {
    return this.infoPoints.get(this._infoKey(x, y)) || null;
  }

  /** Get all info points within manhattan distance of (px, py) */
  getInfoNear(px, py, dist = 1) {
    const result = [];
    for (const info of this._allInfos) {
      if (Math.abs(info.x - px) + Math.abs(info.y - py) <= dist) {
        result.push(info);
      }
    }
    return result;
  }

  removeInfo(infoId) {
    const info = this._allInfos.find(i => i.id === infoId);
    if (!info) return;
    this.infoPoints.delete(this._infoKey(info.x, info.y));
    this._allInfos = this._allInfos.filter(i => i.id !== infoId);
  }

  // --- Blood ---
  getBlood(x, y) {
    return this.blood.get(this._overlayKey(x, y)) || 0;
  }

  setBlood(x, y, quadrants) {
    const key = this._overlayKey(x, y);
    const existing = this.blood.get(key) || 0;
    this.blood.set(key, existing | quadrants);
  }

  loadBlood(bloodArray) {
    this.blood = new Map();
    if (!bloodArray) return;
    for (const [x, y, bitmask] of bloodArray) {
      this.blood.set(this._overlayKey(x, y), bitmask);
    }
  }

  /** Get bounds of the map in world coordinates */
  getLoadedBounds() {
    return { minX: 0, minY: 0, maxX: this.width, maxY: this.height };
  }
}
