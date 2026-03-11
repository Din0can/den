// Server-side BSP dungeon generator
// Produces a Uint8Array of width*height tiles + multi-tile doors + furniture overlay
// Also exports wing generator for dynamic layer per-player dungeons

import { furnishRoom } from './furniture.js';
import { CHUNK_SIZE, chunkKey, parseChunkKey, worldToChunk, chunkIndex } from './chunk.js';

const TILE = {
  VOID: 0, WALL: 1, FLOOR: 2, DOOR_CLOSED: 3, DOOR_OPEN: 4,
  GRASS: 5, WALL_MOSSY: 6, ENTRY: 7,
};

const MIN_CELL = 18;
const MAX_DEPTH = 6;

function overlayKey(x, y) {
  return (x << 16) | (y & 0xFFFF);
}

export function generateDungeon(width, height, roomCount = 35) {
  const map = new Uint8Array(width * height); // all VOID

  const set = (x, y, t) => {
    if (x >= 0 && x < width && y >= 0 && y < height) map[y * width + x] = t;
  };
  const get = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return TILE.VOID;
    return map[y * width + x];
  };

  // --- BSP Partition ---
  const root = { x: 1, y: 1, w: width - 2, h: height - 2 };
  splitBSP(root, 0);

  // --- Place rooms in leaf cells ---
  const rooms = [];
  placeRooms(root, rooms, set, width, height);

  // --- Connect BSP siblings with wide corridors ---
  connectBSP(root, rooms, set, get, width, height);

  // --- Add extra random corridors for loops ---
  const extraCount = 2 + Math.floor(Math.random() * 3); // 2-4
  for (let i = 0; i < extraCount && rooms.length > 2; i++) {
    const a = rooms[Math.floor(Math.random() * rooms.length)];
    const b = rooms[Math.floor(Math.random() * rooms.length)];
    if (a !== b) {
      carveWideCorridor(a.cx, a.cy, b.cx, b.cy, set, get, width, height);
    }
  }

  // --- Wall derivation pass ---
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (get(x, y) !== TILE.VOID) continue;
      // Check 8 neighbors
      let hasFloor = false;
      for (let dy = -1; dy <= 1 && !hasFloor; dy++) {
        for (let dx = -1; dx <= 1 && !hasFloor; dx++) {
          if (dx === 0 && dy === 0) continue;
          const t = get(x + dx, y + dy);
          if (t === TILE.FLOOR || t === TILE.ENTRY || t === TILE.GRASS) {
            hasFloor = true;
          }
        }
      }
      if (hasFloor) set(x, y, TILE.WALL);
    }
  }

  // --- Smart door placement (multi-tile groups) ---
  const doors = [];
  const doorTiles = new Set(); // track which tiles already have doors

  for (const room of rooms) {
    placeDoorsForRoom(room, get, set, doors, doorTiles, width, height);
  }

  // --- Mark first room center as ENTRY ---
  if (rooms.length > 0) {
    set(rooms[0].cx, rooms[0].cy, TILE.ENTRY);
  }

  // --- Grass + mossy walls ---
  const grassRooms = new Set();
  for (let ri = 0; ri < rooms.length; ri++) {
    if (Math.random() < 0.15) {
      grassRooms.add(ri);
      const room = rooms[ri];
      for (let ry = room.y; ry < room.y + room.h; ry++) {
        for (let rx = room.x; rx < room.x + room.w; rx++) {
          if (get(rx, ry) === TILE.FLOOR && Math.random() < 0.4) {
            set(rx, ry, TILE.GRASS);
          }
        }
      }
    }
  }

  for (const ri of grassRooms) {
    const room = rooms[ri];
    for (let ry = room.y - 1; ry <= room.y + room.h; ry++) {
      for (let rx = room.x - 1; rx <= room.x + room.w; rx++) {
        if (get(rx, ry) === TILE.WALL && Math.random() < 0.3) {
          set(rx, ry, TILE.WALL_MOSSY);
        }
      }
    }
  }

  // --- Furniture overlay (numeric keys) ---
  const overlay = new Map();
  for (const room of rooms) {
    furnishRoom(room, map, width, height, overlay);
  }

  const overlayArray = [];
  for (const [key, val] of overlay) {
    const x = key >> 16;
    const y = key & 0xFFFF;
    overlayArray.push([x, y, val.char, val.color, val.passable]);
  }

  console.log(`BSP generated: ${rooms.length} rooms, ${doors.length} doors`);

  return { map, rooms, doors, overlay: overlayArray, width, height };
}

// --- BSP Split ---
function splitBSP(node, depth) {
  if (depth >= MAX_DEPTH) return;
  if (node.w < MIN_CELL * 2 && node.h < MIN_CELL * 2) return;

  let direction;
  if (node.w > node.h * 1.25) direction = 'vertical';
  else if (node.h > node.w * 1.25) direction = 'horizontal';
  else direction = Math.random() > 0.5 ? 'vertical' : 'horizontal';

  // Can't split if too small in chosen direction
  if (direction === 'vertical' && node.w < MIN_CELL * 2) direction = 'horizontal';
  if (direction === 'horizontal' && node.h < MIN_CELL * 2) direction = 'vertical';
  if (direction === 'vertical' && node.w < MIN_CELL * 2) return;
  if (direction === 'horizontal' && node.h < MIN_CELL * 2) return;

  const splitRatio = 0.4 + Math.random() * 0.2; // 40-60%

  if (direction === 'vertical') {
    const splitX = Math.floor(node.x + node.w * splitRatio);
    node.left = { x: node.x, y: node.y, w: splitX - node.x, h: node.h };
    node.right = { x: splitX, y: node.y, w: node.x + node.w - splitX, h: node.h };
  } else {
    const splitY = Math.floor(node.y + node.h * splitRatio);
    node.left = { x: node.x, y: node.y, w: node.w, h: splitY - node.y };
    node.right = { x: node.x, y: splitY, w: node.w, h: node.y + node.h - splitY };
  }

  splitBSP(node.left, depth + 1);
  splitBSP(node.right, depth + 1);
}

// --- Room Placement ---
function placeRooms(node, rooms, set, mapW, mapH) {
  if (node.left || node.right) {
    // Internal node — recurse
    if (node.left) placeRooms(node.left, rooms, set, mapW, mapH);
    if (node.right) placeRooms(node.right, rooms, set, mapW, mapH);
    return;
  }

  // Leaf node — place one room with 3-tile padding from cell edges
  const pad = 3;
  const maxW = node.w - pad * 2;
  const maxH = node.h - pad * 2;
  if (maxW < 5 || maxH < 4) return; // cell too small

  let rw, rh;
  const roll = Math.random();

  if (roll < 0.10 && maxW >= 14 && maxH >= 12) {
    // 10% large room
    rw = 14 + Math.floor(Math.random() * Math.min(7, maxW - 13));
    rh = 12 + Math.floor(Math.random() * Math.min(7, maxH - 11));
  } else if (roll < 0.30 && maxW >= 10 && maxH >= 8) {
    // 20% L-shaped room
    placeLShapedRoom(node, pad, maxW, maxH, rooms, set);
    return;
  } else {
    // 70% normal room
    rw = 6 + Math.floor(Math.random() * Math.min(9, maxW - 5));
    rh = 5 + Math.floor(Math.random() * Math.min(7, maxH - 4));
  }

  rw = Math.min(rw, maxW);
  rh = Math.min(rh, maxH);

  const rx = node.x + pad + Math.floor(Math.random() * (maxW - rw + 1));
  const ry = node.y + pad + Math.floor(Math.random() * (maxH - rh + 1));

  carveRoom(rx, ry, rw, rh, set);
  rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: Math.floor(rx + rw / 2), cy: Math.floor(ry + rh / 2) });
}

function placeLShapedRoom(node, pad, maxW, maxH, rooms, set) {
  // Two overlapping rectangles forming an L
  const w1 = 6 + Math.floor(Math.random() * Math.min(5, maxW - 5));
  const h1 = 5 + Math.floor(Math.random() * Math.min(4, maxH - 4));
  const w2 = 4 + Math.floor(Math.random() * Math.min(4, maxW - 3));
  const h2 = 4 + Math.floor(Math.random() * Math.min(3, maxH - 3));

  const rx = node.x + pad + Math.floor(Math.random() * Math.max(1, maxW - Math.max(w1, w2) + 1));
  const ry = node.y + pad + Math.floor(Math.random() * Math.max(1, maxH - (h1 + h2) + 1));

  // Carve main body
  carveRoom(rx, ry, w1, h1, set);
  // Carve extension (aligned to left or right side)
  const extX = Math.random() > 0.5 ? rx : rx + w1 - w2;
  carveRoom(extX, ry + h1, w2, h2, set);

  // Store as bounding box for furniture
  rooms.push({ x: rx, y: ry, w: w1, h: h1, cx: Math.floor(rx + w1 / 2), cy: Math.floor(ry + h1 / 2) });
}

function carveRoom(x, y, w, h, set) {
  for (let ry = y; ry < y + h; ry++) {
    for (let rx = x; rx < x + w; rx++) {
      set(rx, ry, TILE.FLOOR);
    }
  }
}

// --- BSP Corridor Connection ---
function connectBSP(node, rooms, set, get, mapW, mapH) {
  if (!node.left || !node.right) return;

  // Recurse into children first
  connectBSP(node.left, rooms, set, get, mapW, mapH);
  connectBSP(node.right, rooms, set, get, mapW, mapH);

  // Get a room from each subtree and connect them
  const leftRooms = getLeafRooms(node.left, rooms);
  const rightRooms = getLeafRooms(node.right, rooms);
  if (leftRooms.length === 0 || rightRooms.length === 0) return;

  // Pick the closest pair
  let bestDist = Infinity;
  let bestA = null, bestB = null;
  for (const a of leftRooms) {
    for (const b of rightRooms) {
      const d = Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
      if (d < bestDist) {
        bestDist = d;
        bestA = a;
        bestB = b;
      }
    }
  }

  if (bestA && bestB) {
    carveWideCorridor(bestA.cx, bestA.cy, bestB.cx, bestB.cy, set, get, mapW, mapH);
  }
}

function getLeafRooms(node, allRooms) {
  if (!node.left && !node.right) {
    // Leaf — find rooms within this cell's bounds
    return allRooms.filter(r =>
      r.cx >= node.x && r.cx < node.x + node.w &&
      r.cy >= node.y && r.cy < node.y + node.h
    );
  }
  const result = [];
  if (node.left) result.push(...getLeafRooms(node.left, allRooms));
  if (node.right) result.push(...getLeafRooms(node.right, allRooms));
  return result;
}

// --- Wide Corridor Carving ---
function carveWideCorridor(x1, y1, x2, y2, set, get, mapW, mapH) {
  const corridorWidth = 2 + Math.floor(Math.random() * 2); // 2 or 3
  const offsets = corridorWidth === 2 ? [0, 1] : [-1, 0, 1];

  const horizontalFirst = Math.random() > 0.5;

  if (horizontalFirst) {
    // Horizontal from x1 to x2 at y1
    carveHWide(x1, x2, y1, offsets, set, mapW, mapH);
    // Vertical from y1 to y2 at x2
    carveVWide(y1, y2, x2, offsets, set, mapW, mapH);
    // Fill corner
    fillCorner(x2, y1, corridorWidth, set, mapW, mapH);
  } else {
    // Vertical from y1 to y2 at x1
    carveVWide(y1, y2, x1, offsets, set, mapW, mapH);
    // Horizontal from x1 to x2 at y2
    carveHWide(x1, x2, y2, offsets, set, mapW, mapH);
    // Fill corner
    fillCorner(x1, y2, corridorWidth, set, mapW, mapH);
  }
}

function carveHWide(x1, x2, y, offsets, set, mapW, mapH) {
  const sx = Math.min(x1, x2);
  const ex = Math.max(x1, x2);
  for (let x = sx; x <= ex; x++) {
    for (const off of offsets) {
      const ty = y + off;
      if (ty >= 0 && ty < mapH && x >= 0 && x < mapW) {
        set(x, ty, TILE.FLOOR);
      }
    }
  }
}

function carveVWide(y1, y2, x, offsets, set, mapW, mapH) {
  const sy = Math.min(y1, y2);
  const ey = Math.max(y1, y2);
  for (let y = sy; y <= ey; y++) {
    for (const off of offsets) {
      const tx = x + off;
      if (tx >= 0 && tx < mapW && y >= 0 && y < mapH) {
        set(tx, y, TILE.FLOOR);
      }
    }
  }
}

function fillCorner(cx, cy, size, set, mapW, mapH) {
  const offsets = size === 2 ? [0, 1] : [-1, 0, 1];
  for (const dx of offsets) {
    for (const dy of offsets) {
      const tx = cx + dx;
      const ty = cy + dy;
      if (tx >= 0 && tx < mapW && ty >= 0 && ty < mapH) {
        set(tx, ty, TILE.FLOOR);
      }
    }
  }
}

// --- Multi-Tile Door Placement ---
function placeDoorsForRoom(room, get, set, doors, doorTiles, mapW, mapH) {
  // Scan each edge of the room for entrances (contiguous FLOOR runs in the wall ring)
  const edges = [
    { edge: 'top',    scanY: room.y - 1, xStart: room.x, xEnd: room.x + room.w - 1, dir: 'h' },
    { edge: 'bottom', scanY: room.y + room.h, xStart: room.x, xEnd: room.x + room.w - 1, dir: 'h' },
    { edge: 'left',   scanX: room.x - 1, yStart: room.y, yEnd: room.y + room.h - 1, dir: 'v' },
    { edge: 'right',  scanX: room.x + room.w, yStart: room.y, yEnd: room.y + room.h - 1, dir: 'v' },
  ];

  for (const e of edges) {
    if (e.dir === 'h') {
      // Horizontal scan
      const y = e.scanY;
      if (y < 0 || y >= mapH) continue;

      let runStart = -1;
      for (let x = e.xStart; x <= e.xEnd + 1; x++) {
        const t = (x <= e.xEnd) ? get(x, y) : TILE.WALL; // sentinel
        const isFloor = (t === TILE.FLOOR || t === TILE.ENTRY || t === TILE.GRASS);

        if (isFloor && runStart < 0) {
          runStart = x;
        } else if (!isFloor && runStart >= 0) {
          // Found a contiguous FLOOR run from runStart to x-1
          const len = x - runStart;
          // Check if any tile already has a door (deduplication)
          let alreadyHasDoor = false;
          for (let i = 0; i < len; i++) {
            if (doorTiles.has(`${runStart + i},${y}`)) {
              alreadyHasDoor = true;
              break;
            }
          }
          if (!alreadyHasDoor) {
            // Determine swing direction based on which side has floor
            const swingDir = determineSwing(runStart, y, 'horizontal', get);
            createDoorGroup(runStart, y, len, 'horizontal', swingDir, doors, doorTiles, set);
          }
          runStart = -1;
        }
      }
    } else {
      // Vertical scan
      const x = e.scanX;
      if (x < 0 || x >= mapW) continue;

      let runStart = -1;
      for (let y = e.yStart; y <= e.yEnd + 1; y++) {
        const t = (y <= e.yEnd) ? get(x, y) : TILE.WALL;
        const isFloor = (t === TILE.FLOOR || t === TILE.ENTRY || t === TILE.GRASS);

        if (isFloor && runStart < 0) {
          runStart = y;
        } else if (!isFloor && runStart >= 0) {
          const len = y - runStart;
          let alreadyHasDoor = false;
          for (let i = 0; i < len; i++) {
            if (doorTiles.has(`${x},${runStart + i}`)) {
              alreadyHasDoor = true;
              break;
            }
          }
          if (!alreadyHasDoor) {
            const swingDir = determineSwing(x, runStart, 'vertical', get);
            createDoorGroup(x, runStart, len, 'vertical', swingDir, doors, doorTiles, set);
          }
          runStart = -1;
        }
      }
    }
  }
}

function determineSwing(x, y, orientation, get) {
  const isFloorTile = (t) => t === TILE.FLOOR || t === TILE.GRASS || t === TILE.ENTRY;
  if (orientation === 'horizontal') {
    // Check south vs north
    return isFloorTile(get(x, y + 1)) ? 'south' : 'north';
  } else {
    // Check east vs west
    return isFloorTile(get(x + 1, y)) ? 'east' : 'west';
  }
}

function createDoorGroup(x, y, length, orientation, swingDirection, doors, doorTiles, set) {
  const type = Math.random() < 0.2 ? 'metal' : 'wood';
  const door = {
    id: doors.length,
    x, y,
    length,
    orientation,
    isOpen: false,
    type,
    swingDirection,
  };
  doors.push(door);

  // Mark all tiles as DOOR_CLOSED and register in doorTiles set
  for (let i = 0; i < length; i++) {
    const tx = orientation === 'horizontal' ? x + i : x;
    const ty = orientation === 'vertical' ? y + i : y;
    set(tx, ty, TILE.DOOR_CLOSED);
    doorTiles.add(`${tx},${ty}`);
  }
}

// ─── Wing Generator ──────────────────────────────────────────────────────────
// Generates a player's personal dungeon that connects to nearby bones.

// Seeded PRNG (mulberry32)
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WING_DOOR_ID_OFFSET = 10000; // wing door IDs start at 10000 to avoid bone collisions

/**
 * Generate a personal wing dungeon for a player on a dynamic layer.
 * Wings fill the void between bones with personal rooms + corridors.
 * Wing corridors connect to bone rooms (punching through bone walls via compositing).
 *
 * @param {number} playerSeed - Unique seed for this player's dungeon
 * @param {Array} boneRooms - Bone room definitions [{x,y,w,h,cx,cy}, ...]
 * @param {Map} boneChunks - Bone chunk data (chunkKey -> {tiles, ...})
 * @param {number} layerWidth - Layer width in tiles
 * @param {number} layerHeight - Layer height in tiles
 * @returns {{ chunks: Map, rooms: Array, doors: Array }}
 */
export function generateWing(playerSeed, boneRooms, boneChunks, layerWidth, layerHeight) {
  const rng = mulberry32(playerSeed);
  const map = new Uint8Array(layerWidth * layerHeight);

  const set = (x, y, t) => {
    if (x >= 0 && x < layerWidth && y >= 0 && y < layerHeight) map[y * layerWidth + x] = t;
  };
  const get = (x, y) => {
    if (x < 0 || x >= layerWidth || y < 0 || y >= layerHeight) return TILE.VOID;
    return map[y * layerWidth + x];
  };

  // Build bone mask: bone tile positions + 2-tile buffer (for room placement avoidance)
  const boneMask = new Set();
  for (const [key, chunk] of boneChunks) {
    const { cx, cy } = parseChunkKey(key);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        if (chunk.tiles[ly * CHUNK_SIZE + lx] !== TILE.VOID) {
          const wx = cx * CHUNK_SIZE + lx;
          const wy = cy * CHUNK_SIZE + ly;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              boneMask.add(packCoord(wx + dx, wy + dy));
            }
          }
        }
      }
    }
  }

  // Place wing rooms — scatter approach with bone avoidance
  const rooms = [];
  const ROOM_ATTEMPTS = 60;
  const WING_ROOM_COUNT = 6 + Math.floor(rng() * 6); // 6-11 rooms

  for (let attempt = 0; attempt < ROOM_ATTEMPTS && rooms.length < WING_ROOM_COUNT; attempt++) {
    const w = 5 + Math.floor(rng() * 8);   // 5-12
    const h = 4 + Math.floor(rng() * 6);   // 4-9
    const x = 3 + Math.floor(rng() * Math.max(1, layerWidth - w - 6));
    const y = 3 + Math.floor(rng() * Math.max(1, layerHeight - h - 6));

    // Check bone mask conflict (sample corners + center + edges)
    let conflict = false;
    const checkPoints = [
      [x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1],
      [(x + w / 2) | 0, (y + h / 2) | 0],
    ];
    for (const [sx, sy] of checkPoints) {
      if (boneMask.has(packCoord(sx, sy))) { conflict = true; break; }
    }
    if (conflict) continue;

    // Check wing room overlap (3-tile spacing)
    let overlap = false;
    for (const r of rooms) {
      if (x < r.x + r.w + 3 && x + w + 3 > r.x && y < r.y + r.h + 3 && y + h + 3 > r.y) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;

    // Carve room
    for (let ry = y; ry < y + h; ry++) {
      for (let rx = x; rx < x + w; rx++) {
        set(rx, ry, TILE.FLOOR);
      }
    }
    rooms.push({ x, y, w, h, cx: (x + w / 2) | 0, cy: (y + h / 2) | 0 });
  }

  if (rooms.length === 0) {
    console.log('Wing generation: no rooms placed (all conflicted with bones)');
    return { chunks: new Map(), rooms: [], doors: [] };
  }

  // Connect each wing room to the nearest bone room (personal path into bones)
  for (const wRoom of rooms) {
    let nearest = null;
    let bestDist = Infinity;
    for (const bRoom of boneRooms) {
      const d = Math.abs(wRoom.cx - bRoom.cx) + Math.abs(wRoom.cy - bRoom.cy);
      if (d < bestDist) { bestDist = d; nearest = bRoom; }
    }
    if (nearest) {
      carveSeededCorridor(wRoom.cx, wRoom.cy, nearest.cx, nearest.cy, set, rng, layerWidth, layerHeight);
    }
  }

  // Connect wing rooms to each other (chain)
  for (let i = 1; i < rooms.length; i++) {
    carveSeededCorridor(rooms[i - 1].cx, rooms[i - 1].cy, rooms[i].cx, rooms[i].cy, set, rng, layerWidth, layerHeight);
  }

  // Wall derivation
  for (let y = 0; y < layerHeight; y++) {
    for (let x = 0; x < layerWidth; x++) {
      if (get(x, y) !== TILE.VOID) continue;
      let hasFloor = false;
      for (let dy = -1; dy <= 1 && !hasFloor; dy++) {
        for (let dx = -1; dx <= 1 && !hasFloor; dx++) {
          if (dx === 0 && dy === 0) continue;
          const t = get(x + dx, y + dy);
          if (t === TILE.FLOOR || t === TILE.GRASS) hasFloor = true;
        }
      }
      if (hasFloor) set(x, y, TILE.WALL);
    }
  }

  const doors = [];

  // Furniture overlay
  const overlay = new Map();
  for (const room of rooms) {
    furnishRoom(room, map, layerWidth, layerHeight, overlay);
  }

  const overlayArray = [];
  for (const [key, val] of overlay) {
    const ox = key >> 16;
    const oy = key & 0xFFFF;
    overlayArray.push([ox, oy, val.char, val.color, val.passable]);
  }

  // Convert to chunks (only non-void chunks)
  const chunks = new Map();
  const chunksX = Math.ceil(layerWidth / CHUNK_SIZE);
  const chunksY = Math.ceil(layerHeight / CHUNK_SIZE);
  for (let cy = 0; cy < chunksY; cy++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
      let hasContent = false;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const wx = cx * CHUNK_SIZE + lx;
          const wy = cy * CHUNK_SIZE + ly;
          if (wx < layerWidth && wy < layerHeight) {
            const t = map[wy * layerWidth + wx];
            tiles[ly * CHUNK_SIZE + lx] = t;
            if (t !== TILE.VOID) hasContent = true;
          }
        }
      }
      if (hasContent) {
        chunks.set(chunkKey(cx, cy), { tiles, overlay: [], doors: [] });
      }
    }
  }

  // Distribute overlay to chunks
  for (const entry of overlayArray) {
    const [ox, oy] = entry;
    const { cx, cy } = worldToChunk(ox, oy);
    const key = chunkKey(cx, cy);
    const chunk = chunks.get(key);
    if (chunk) chunk.overlay.push(entry);
  }

  console.log(`Wing generated: ${rooms.length} rooms`);
  return { chunks, rooms, doors };
}

function packCoord(x, y) {
  return (x + 10000) * 100000 + (y + 10000);
}

/** Carve a 2-wide L-shaped corridor using seeded RNG */
function carveSeededCorridor(x1, y1, x2, y2, set, rng, mapW, mapH) {
  const horizontalFirst = rng() > 0.5;

  const carveH = (fromX, toX, y) => {
    const sx = Math.min(fromX, toX);
    const ex = Math.max(fromX, toX);
    for (let x = sx; x <= ex; x++) {
      for (let dy = 0; dy <= 1; dy++) {
        if (x >= 1 && x < mapW - 1 && y + dy >= 1 && y + dy < mapH - 1) {
          set(x, y + dy, TILE.FLOOR);
        }
      }
    }
  };

  const carveV = (fromY, toY, x) => {
    const sy = Math.min(fromY, toY);
    const ey = Math.max(fromY, toY);
    for (let y = sy; y <= ey; y++) {
      for (let dx = 0; dx <= 1; dx++) {
        if (x + dx >= 1 && x + dx < mapW - 1 && y >= 1 && y < mapH - 1) {
          set(x + dx, y, TILE.FLOOR);
        }
      }
    }
  };

  if (horizontalFirst) {
    carveH(x1, x2, y1);
    carveV(y1, y2, x2);
  } else {
    carveV(y1, y2, x1);
    carveH(x1, x2, y2);
  }
}
