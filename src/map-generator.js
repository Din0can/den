// Server-side BSP dungeon generator
// Produces a Uint8Array of width*height tiles + multi-tile doors + furniture overlay
// Also exports wing generator for dynamic layer per-player dungeons

import { furnishRoom } from './furniture.js';
import { CHUNK_SIZE, chunkKey, parseChunkKey, worldToChunk, chunkIndex } from './chunk.js';

const TILE = {
  VOID: 0, WALL: 1, FLOOR: 2, DOOR_CLOSED: 3, DOOR_OPEN: 4,
  GRASS: 5, WALL_MOSSY: 6, ENTRY: 7, PATH: 8, STONE: 9,
};

const MIN_CELL = 16;
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
  const extraCount = 4 + Math.floor(Math.random() * 4); // 4-7
  for (let i = 0; i < extraCount && rooms.length > 2; i++) {
    const a = rooms[Math.floor(Math.random() * rooms.length)];
    const b = rooms[Math.floor(Math.random() * rooms.length)];
    if (a !== b) {
      carveWideCorridor(a.cx, a.cy, b.cx, b.cy, set, get, width, height);
    }
  }

  // --- Dead-end branches ---
  const deadEndCount = 2 + Math.floor(Math.random() * 3); // 2-4
  const deadEnds = [];
  for (let attempt = 0; attempt < deadEndCount * 10 && deadEnds.length < deadEndCount; attempt++) {
    // Pick a random floor tile that's in a corridor (not inside any room)
    const sx = 3 + Math.floor(Math.random() * (width - 6));
    const sy = 3 + Math.floor(Math.random() * (height - 6));
    if (get(sx, sy) !== TILE.FLOOR) continue;

    let inRoom = false;
    for (const r of rooms) {
      if (sx >= r.x && sx < r.x + r.w && sy >= r.y && sy < r.y + r.h) {
        inRoom = true;
        break;
      }
    }
    if (inRoom) continue;

    // Pick a random cardinal direction
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const dir = dirs[Math.floor(Math.random() * dirs.length)];
    const branchLen = 4 + Math.floor(Math.random() * 5); // 4-8 tiles

    // Check if we can carve in that direction (all void)
    let canCarve = true;
    for (let step = 1; step <= branchLen + 2; step++) {
      const nx = sx + dir[0] * step;
      const ny = sy + dir[1] * step;
      if (nx < 2 || nx >= width - 2 || ny < 2 || ny >= height - 2) { canCarve = false; break; }
      // Check a 3-wide swath for void
      const perp = dir[0] === 0 ? [1, 0] : [0, 1];
      for (let p = -1; p <= 1; p++) {
        const t = get(nx + perp[0] * p, ny + perp[1] * p);
        if (step > 1 && t !== TILE.VOID) { canCarve = false; break; }
      }
      if (!canCarve) break;
    }
    if (!canCarve) continue;

    // Carve the branch (2-wide)
    for (let step = 1; step <= branchLen; step++) {
      const nx = sx + dir[0] * step;
      const ny = sy + dir[1] * step;
      set(nx, ny, TILE.FLOOR);
      // Make it 2-wide
      const perp = dir[0] === 0 ? [1, 0] : [0, 1];
      set(nx + perp[0], ny + perp[1], TILE.FLOOR);
    }

    // Carve 3×3 or 4×4 alcove at the end
    const endX = sx + dir[0] * branchLen;
    const endY = sy + dir[1] * branchLen;
    const alcoveSize = Math.random() > 0.5 ? 3 : 4;
    const ax = endX - Math.floor(alcoveSize / 2);
    const ay = endY - Math.floor(alcoveSize / 2);
    for (let dy = 0; dy < alcoveSize; dy++) {
      for (let dx = 0; dx < alcoveSize; dx++) {
        const px = ax + dx, py = ay + dy;
        if (px >= 1 && px < width - 1 && py >= 1 && py < height - 1) {
          set(px, py, TILE.FLOOR);
        }
      }
    }

    deadEnds.push({ x: endX, y: endY, alcoveSize });
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

  // --- Overgrown zones + stone floor variation ---
  // Pick 2-4 overgrown zone centers
  const zoneCount = 2 + Math.floor(Math.random() * 3);
  const zones = [];
  for (let i = 0; i < zoneCount; i++) {
    zones.push({
      cx: Math.floor(Math.random() * width),
      cy: Math.floor(Math.random() * height),
      radius: 20 + Math.floor(Math.random() * 11), // 20-30
    });
  }

  function inOvergrownZone(x, y) {
    for (const z of zones) {
      const dx = x - z.cx, dy = y - z.cy;
      if (dx * dx + dy * dy <= z.radius * z.radius) return true;
    }
    return false;
  }

  // Apply overgrown treatment to rooms
  for (const room of rooms) {
    const roomInZone = inOvergrownZone(room.cx, room.cy);

    if (roomInZone) {
      const roll = Math.random();
      let floorChance, wallChance;
      if (roll < 0.40) {
        floorChance = 0.45 + Math.random() * 0.20;
        wallChance = 0.40 + Math.random() * 0.20;
      } else {
        floorChance = 0.10 + Math.random() * 0.20;
        wallChance = 0.10 + Math.random() * 0.15;
      }

      for (let ry = room.y; ry < room.y + room.h; ry++) {
        for (let rx = room.x; rx < room.x + room.w; rx++) {
          if (get(rx, ry) === TILE.FLOOR && Math.random() < floorChance) {
            set(rx, ry, TILE.GRASS);
          }
        }
      }
      // Mossy walls around room
      for (let ry = room.y - 1; ry <= room.y + room.h; ry++) {
        for (let rx = room.x - 1; rx <= room.x + room.w; rx++) {
          if (get(rx, ry) === TILE.WALL && Math.random() < wallChance) {
            set(rx, ry, TILE.WALL_MOSSY);
          }
        }
      }
    } else if (Math.random() < 0.05) {
      // Outside zones: rare minor grass/moss (5% of rooms)
      const floorChance = 0.1 + Math.random() * 0.1;
      const wallChance = 0.1 + Math.random() * 0.1;
      for (let ry = room.y; ry < room.y + room.h; ry++) {
        for (let rx = room.x; rx < room.x + room.w; rx++) {
          if (get(rx, ry) === TILE.FLOOR && Math.random() < floorChance) {
            set(rx, ry, TILE.GRASS);
          }
        }
      }
      for (let ry = room.y - 1; ry <= room.y + room.h; ry++) {
        for (let rx = room.x - 1; rx <= room.x + room.w; rx++) {
          if (get(rx, ry) === TILE.WALL && Math.random() < wallChance) {
            set(rx, ry, TILE.WALL_MOSSY);
          }
        }
      }
    }
  }

  // Corridor overgrown: apply grass/moss to corridor tiles in overgrown zones
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inOvergrownZone(x, y)) continue;
      const t = get(x, y);
      // Only affect tiles not inside room bounding boxes (corridor tiles)
      let inRoom = false;
      for (const r of rooms) {
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
          inRoom = true;
          break;
        }
      }
      if (inRoom) continue;
      if (t === TILE.FLOOR && Math.random() < 0.4) {
        set(x, y, TILE.GRASS);
      } else if (t === TILE.WALL && Math.random() < 0.3) {
        set(x, y, TILE.WALL_MOSSY);
      }
    }
  }

  // Stone floor variation: 10% of rooms get STONE floors
  for (const room of rooms) {
    if (Math.random() < 0.10) {
      for (let ry = room.y; ry < room.y + room.h; ry++) {
        for (let rx = room.x; rx < room.x + room.w; rx++) {
          if (get(rx, ry) === TILE.FLOOR) {
            set(rx, ry, TILE.STONE);
          }
        }
      }
    }
  }

  // --- Furniture overlay (numeric keys) ---
  const overlay = new Map();
  for (const room of rooms) {
    furnishRoom(room, map, width, height, overlay);
  }

  // --- Corridor decoration pass (torches, pillar pairs, moss) ---
  decorateCorridors(map, width, height, rooms, overlay);

  // --- Dead-end loot ---
  for (const de of deadEnds) {
    if (Math.random() < 0.6) { // 60% chance of loot in dead ends
      const oKey = overlayKey(de.x, de.y);
      if (!overlay.has(oKey) && get(de.x, de.y) === TILE.FLOOR) {
        const loot = Math.random() < 0.4
          ? { char: '▣', color: '#DAA520', passable: false }  // chest
          : { char: '◎', color: '#8B4513', passable: false }; // barrel
        overlay.set(oKey, loot);
      }
    }
  }

  // --- Floor item positions (~5% per room) ---
  const floorItemPositions = [];
  for (const room of rooms) {
    if (Math.random() < 0.05) {
      const candidates = [];
      for (let ry = room.y + 1; ry < room.y + room.h - 1; ry++) {
        for (let rx = room.x + 1; rx < room.x + room.w - 1; rx++) {
          const t = get(rx, ry);
          if ((t === TILE.FLOOR || t === TILE.STONE) && !overlay.has(overlayKey(rx, ry))) {
            candidates.push({ x: rx, y: ry });
          }
        }
      }
      if (candidates.length > 0) {
        floorItemPositions.push(candidates[Math.floor(Math.random() * candidates.length)]);
      }
    }
  }

  const overlayArray = [];
  for (const [key, val] of overlay) {
    const x = key >> 16;
    const y = key & 0xFFFF;
    overlayArray.push([x, y, val.char, val.color, val.passable]);
  }

  console.log(`BSP generated: ${rooms.length} rooms, ${doors.length} doors`);

  return { map, rooms, doors, overlay: overlayArray, width, height, floorItemPositions };
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

  if (roll < 0.05 && maxW >= 20 && maxH >= 16) {
    // 5% grand room
    rw = 20 + Math.floor(Math.random() * Math.min(9, maxW - 19));
    rh = 16 + Math.floor(Math.random() * Math.min(7, maxH - 15));
  } else if (roll < 0.15 && maxW >= 16 && maxH >= 12) {
    // 10% large room
    rw = 16 + Math.floor(Math.random() * Math.min(9, maxW - 15));
    rh = 12 + Math.floor(Math.random() * Math.min(7, maxH - 11));
  } else if (roll < 0.30 && maxW >= 12 && maxH >= 9) {
    // 15% medium room
    rw = 12 + Math.floor(Math.random() * Math.min(7, maxW - 11));
    rh = 9 + Math.floor(Math.random() * Math.min(6, maxH - 8));
  } else if (roll < 0.50 && maxW >= 10 && maxH >= 8) {
    // 20% L-shaped room
    placeLShapedRoom(node, pad, maxW, maxH, rooms, set);
    return;
  } else {
    // 50% normal room
    rw = 8 + Math.floor(Math.random() * Math.min(9, maxW - 7));
    rh = 6 + Math.floor(Math.random() * Math.min(8, maxH - 5));
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
  const w1 = 8 + Math.floor(Math.random() * Math.min(7, maxW - 7));
  const h1 = 6 + Math.floor(Math.random() * Math.min(5, maxH - 5));
  const w2 = 5 + Math.floor(Math.random() * Math.min(5, maxW - 4));
  const h2 = 5 + Math.floor(Math.random() * Math.min(4, maxH - 4));

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

// --- Wide Corridor Carving (multiple styles) ---
export function carveVariedCorridor(x1, y1, x2, y2, set, get, mapW, mapH, rng = Math.random) {
  // Width variation: 2 (60%), 3 (30%), 4 (10%)
  const wRoll = rng();
  const corridorWidth = wRoll < 0.60 ? 2 : wRoll < 0.90 ? 3 : 4;
  const offsets = corridorWidth === 2 ? [0, 1] :
                  corridorWidth === 3 ? [-1, 0, 1] : [-1, 0, 1, 2];

  // Style selection
  const styleRoll = rng();

  if (styleRoll < 0.50) {
    carveLBend(x1, y1, x2, y2, offsets, corridorWidth, set, mapW, mapH, rng);
  } else if (styleRoll < 0.75) {
    carveSBend(x1, y1, x2, y2, offsets, corridorWidth, set, mapW, mapH, rng);
  } else if (styleRoll < 0.90) {
    carveDogLeg(x1, y1, x2, y2, offsets, corridorWidth, set, mapW, mapH, rng);
  } else {
    carveStraightWithAlcove(x1, y1, x2, y2, offsets, corridorWidth, set, mapW, mapH, rng);
  }
}

function carveWideCorridor(x1, y1, x2, y2, set, get, mapW, mapH) {
  carveVariedCorridor(x1, y1, x2, y2, set, get, mapW, mapH, Math.random);
}

/**
 * Carve a corridor with waypoint rooms for long distances.
 * For corridors > 40 Manhattan distance, places small rooms along the path
 * and connects them with carveVariedCorridor segments.
 * Waypoint rooms are pushed into the rooms array for furniture/decoration.
 */
export function carveCorridorWithWaypoints(x1, y1, x2, y2, set, get, mapW, mapH, rng, rooms) {
  const dist = Math.abs(x2 - x1) + Math.abs(y2 - y1);

  if (dist <= 40) {
    carveVariedCorridor(x1, y1, x2, y2, set, get, mapW, mapH, rng);
    return;
  }

  const waypointCount = Math.min(3, Math.floor(dist / 40));
  const points = [{ x: x1, y: y1 }];

  for (let i = 1; i <= waypointCount; i++) {
    const t = i / (waypointCount + 1);
    const baseX = Math.round(x1 + (x2 - x1) * t);
    const baseY = Math.round(y1 + (y2 - y1) * t);
    const jitterX = Math.floor((rng() - 0.5) * 16); // ±8
    const jitterY = Math.floor((rng() - 0.5) * 16);
    const wx = Math.max(3, Math.min(mapW - 4, baseX + jitterX));
    const wy = Math.max(3, Math.min(mapH - 4, baseY + jitterY));

    // Carve a small waypoint room (5-7 × 5-7)
    const rw = 5 + Math.floor(rng() * 3);
    const rh = 5 + Math.floor(rng() * 3);
    const rx = Math.max(1, Math.min(mapW - rw - 1, wx - Math.floor(rw / 2)));
    const ry = Math.max(1, Math.min(mapH - rh - 1, wy - Math.floor(rh / 2)));

    for (let dy = 0; dy < rh; dy++) {
      for (let dx = 0; dx < rw; dx++) {
        set(rx + dx, ry + dy, TILE.FLOOR);
      }
    }

    const room = {
      x: rx, y: ry, w: rw, h: rh,
      cx: Math.floor(rx + rw / 2),
      cy: Math.floor(ry + rh / 2),
    };
    if (rooms) rooms.push(room);
    points.push({ x: room.cx, y: room.cy });
  }

  points.push({ x: x2, y: y2 });

  // Connect waypoints sequentially
  for (let i = 0; i < points.length - 1; i++) {
    carveVariedCorridor(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, set, get, mapW, mapH, rng);
  }
}

function carveLBend(x1, y1, x2, y2, offsets, cw, set, mapW, mapH, rng) {
  const horizontalFirst = rng() > 0.5;
  if (horizontalFirst) {
    carveHWide(x1, x2, y1, offsets, set, mapW, mapH);
    carveVWide(y1, y2, x2, offsets, set, mapW, mapH);
    fillCorner(x2, y1, cw, set, mapW, mapH);
  } else {
    carveVWide(y1, y2, x1, offsets, set, mapW, mapH);
    carveHWide(x1, x2, y2, offsets, set, mapW, mapH);
    fillCorner(x1, y2, cw, set, mapW, mapH);
  }
}

function carveSBend(x1, y1, x2, y2, offsets, cw, set, mapW, mapH, rng) {
  const midX = Math.floor((x1 + x2) / 2) + Math.floor((rng() - 0.5) * 6);
  const midY = Math.floor((y1 + y2) / 2) + Math.floor((rng() - 0.5) * 6);

  if (rng() > 0.5) {
    // H-V-H: horizontal to midX, vertical to midY, horizontal to x2
    carveHWide(x1, midX, y1, offsets, set, mapW, mapH);
    carveVWide(y1, midY, midX, offsets, set, mapW, mapH);
    carveHWide(midX, x2, midY, offsets, set, mapW, mapH);
    carveVWide(midY, y2, x2, offsets, set, mapW, mapH);
    fillCorner(midX, y1, cw, set, mapW, mapH);
    fillCorner(midX, midY, cw, set, mapW, mapH);
    fillCorner(x2, midY, cw, set, mapW, mapH);
  } else {
    // V-H-V: vertical to midY, horizontal to midX, vertical to y2
    carveVWide(y1, midY, x1, offsets, set, mapW, mapH);
    carveHWide(x1, midX, midY, offsets, set, mapW, mapH);
    carveVWide(midY, y2, midX, offsets, set, mapW, mapH);
    carveHWide(midX, x2, y2, offsets, set, mapW, mapH);
    fillCorner(x1, midY, cw, set, mapW, mapH);
    fillCorner(midX, midY, cw, set, mapW, mapH);
    fillCorner(midX, y2, cw, set, mapW, mapH);
  }
}

function carveDogLeg(x1, y1, x2, y2, offsets, cw, set, mapW, mapH, rng) {
  // Mostly straight with a short perpendicular jog in the middle
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  const jogOffset = 3 + Math.floor(rng() * 4); // 3-6 tile jog

  if (dx >= dy) {
    // Primarily horizontal — add a vertical jog at midpoint
    const midX = Math.floor((x1 + x2) / 2);
    const jogDir = rng() > 0.5 ? jogOffset : -jogOffset;
    carveHWide(x1, midX, y1, offsets, set, mapW, mapH);
    carveVWide(y1, y1 + jogDir, midX, offsets, set, mapW, mapH);
    carveHWide(midX, x2, y1 + jogDir, offsets, set, mapW, mapH);
    carveVWide(y1 + jogDir, y2, x2, offsets, set, mapW, mapH);
    fillCorner(midX, y1, cw, set, mapW, mapH);
    fillCorner(midX, y1 + jogDir, cw, set, mapW, mapH);
    fillCorner(x2, y1 + jogDir, cw, set, mapW, mapH);
  } else {
    // Primarily vertical — add a horizontal jog at midpoint
    const midY = Math.floor((y1 + y2) / 2);
    const jogDir = rng() > 0.5 ? jogOffset : -jogOffset;
    carveVWide(y1, midY, x1, offsets, set, mapW, mapH);
    carveHWide(x1, x1 + jogDir, midY, offsets, set, mapW, mapH);
    carveVWide(midY, y2, x1 + jogDir, offsets, set, mapW, mapH);
    carveHWide(x1 + jogDir, x2, y2, offsets, set, mapW, mapH);
    fillCorner(x1, midY, cw, set, mapW, mapH);
    fillCorner(x1 + jogDir, midY, cw, set, mapW, mapH);
    fillCorner(x1 + jogDir, y2, cw, set, mapW, mapH);
  }
}

function carveStraightWithAlcove(x1, y1, x2, y2, offsets, cw, set, mapW, mapH, rng) {
  // L-bend base + 3×3 alcove at the bend point
  const horizontalFirst = rng() > 0.5;
  let alcoveX, alcoveY;

  if (horizontalFirst) {
    carveHWide(x1, x2, y1, offsets, set, mapW, mapH);
    carveVWide(y1, y2, x2, offsets, set, mapW, mapH);
    fillCorner(x2, y1, cw, set, mapW, mapH);
    alcoveX = Math.floor((x1 + x2) / 2);
    alcoveY = y1;
  } else {
    carveVWide(y1, y2, x1, offsets, set, mapW, mapH);
    carveHWide(x1, x2, y2, offsets, set, mapW, mapH);
    fillCorner(x1, y2, cw, set, mapW, mapH);
    alcoveX = x1;
    alcoveY = Math.floor((y1 + y2) / 2);
  }

  // Carve 3×3 alcove at midpoint
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ax = alcoveX + dx, ay = alcoveY + dy;
      if (ax >= 1 && ax < mapW - 1 && ay >= 1 && ay < mapH - 1) {
        set(ax, ay, TILE.FLOOR);
      }
    }
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
  const offsets = size === 2 ? [0, 1] : size === 4 ? [-1, 0, 1, 2] : [-1, 0, 1];
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

// --- Corridor Decoration ---
function decorateCorridors(map, width, height, rooms, overlay) {
  const get = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return TILE.VOID;
    return map[y * width + x];
  };

  const isFloor = (t) => t === TILE.FLOOR || t === TILE.GRASS || t === TILE.STONE || t === TILE.ENTRY;

  // Build set of room tiles for fast lookup
  const roomTileSet = new Set();
  for (const r of rooms) {
    for (let ry = r.y; ry < r.y + r.h; ry++) {
      for (let rx = r.x; rx < r.x + r.w; rx++) {
        roomTileSet.add((rx << 16) | (ry & 0xFFFF));
      }
    }
  }

  const isCorridorFloor = (x, y) => {
    if (!isFloor(get(x, y))) return false;
    return !roomTileSet.has((x << 16) | (y & 0xFFFF));
  };

  // Measure corridor width at each point (count perpendicular floor neighbors)
  const corridorWidth = (x, y) => {
    // Check horizontal span
    let hw = 1;
    for (let dx = 1; isCorridorFloor(x + dx, y); dx++) hw++;
    for (let dx = -1; isCorridorFloor(x + dx, y); dx--) hw++;
    // Check vertical span
    let vw = 1;
    for (let dy = 1; isCorridorFloor(x, y + dy); dy++) vw++;
    for (let dy = -1; isCorridorFloor(x, y + dy); dy--) vw++;
    return Math.min(hw, vw);
  };

  // Find corridor FLOOR tiles adjacent to walls (edge of corridor)
  const torchCandidates = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!isCorridorFloor(x, y)) continue;
      // Must touch at least one wall (cardinal)
      let adjWall = false;
      for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
        const t = get(x + dx, y + dy);
        if (t === TILE.WALL || t === TILE.WALL_MOSSY) { adjWall = true; break; }
      }
      if (!adjWall) continue;
      // Corridor must be 3+ wide so torch doesn't block passage
      if (corridorWidth(x, y) < 3) continue;
      torchCandidates.push({ x, y });
    }
  }

  // Place torches at intervals of 25-35 tiles along corridor edges
  let lastTorchDist = 0;
  const torchInterval = 25 + Math.floor(Math.random() * 11);
  // Shuffle candidates for variety
  for (let i = torchCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [torchCandidates[i], torchCandidates[j]] = [torchCandidates[j], torchCandidates[i]];
  }

  let placedTorches = 0;
  for (const c of torchCandidates) {
    if (placedTorches >= 8) break;
    // Check spacing from previously placed corridor torches
    let tooClose = false;
    for (const [key] of overlay) {
      const ox = key >> 16;
      const oy = key & 0xFFFF;
      if (Math.abs(ox - c.x) + Math.abs(oy - c.y) < torchInterval) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const oKey = (c.x << 16) | (c.y & 0xFFFF);
    if (!overlay.has(oKey)) {
      overlay.set(oKey, { char: '¥', color: '#FF6600', passable: false });
      placedTorches++;
    }
  }

  // Pillar pairs in 4+ wide corridors (occasional)
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      if (!isCorridorFloor(x, y)) continue;
      if (Math.random() > 0.003) continue; // very rare
      const cw = corridorWidth(x, y);
      if (cw < 4) continue;

      // Place a pair of pillars flanking the passage
      const oKey1 = (x << 16) | (y & 0xFFFF);
      const oKey2 = ((x + 1) << 16) | (y & 0xFFFF);
      if (!overlay.has(oKey1) && !overlay.has(oKey2) &&
          isCorridorFloor(x, y) && isCorridorFloor(x + 1, y)) {
        overlay.set(oKey1, { char: '○', color: '#808080', passable: false });
        overlay.set(oKey2, { char: '○', color: '#808080', passable: false });
      }
    }
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

  // Snapshot original room count — waypoint rooms pushed during corridor carving
  // must NOT be iterated for bone/chain connections (causes runaway explosion).
  const wingRoomCount = rooms.length;

  // Connect each wing room to the nearest bone room (personal path into bones)
  for (let i = 0; i < wingRoomCount; i++) {
    const wRoom = rooms[i];
    let nearest = null;
    let bestDist = Infinity;
    for (const bRoom of boneRooms) {
      const d = Math.abs(wRoom.cx - bRoom.cx) + Math.abs(wRoom.cy - bRoom.cy);
      if (d < bestDist) { bestDist = d; nearest = bRoom; }
    }
    if (nearest) {
      carveCorridorWithWaypoints(wRoom.cx, wRoom.cy, nearest.cx, nearest.cy, set, get, layerWidth, layerHeight, rng, rooms);
    }
  }

  // Connect wing rooms to each other (chain) — only original rooms
  for (let i = 1; i < wingRoomCount; i++) {
    carveCorridorWithWaypoints(rooms[i - 1].cx, rooms[i - 1].cy, rooms[i].cx, rooms[i].cy, set, get, layerWidth, layerHeight, rng, rooms);
  }

  // Extra random corridors for loops
  const extraCount = 2 + Math.floor(rng() * 3); // 2-4
  for (let i = 0; i < extraCount && rooms.length > 2; i++) {
    const a = rooms[Math.floor(rng() * rooms.length)];
    const b = rooms[Math.floor(rng() * rooms.length)];
    if (a !== b) carveVariedCorridor(a.cx, a.cy, b.cx, b.cy, set, get, layerWidth, layerHeight, rng);
  }

  // Dead-end branches off corridors
  const deadEndCount = 1 + Math.floor(rng() * 3); // 1-3
  const deadEnds = [];
  for (let attempt = 0; attempt < deadEndCount * 10 && deadEnds.length < deadEndCount; attempt++) {
    const sx = 3 + Math.floor(rng() * (layerWidth - 6));
    const sy = 3 + Math.floor(rng() * (layerHeight - 6));
    if (get(sx, sy) !== TILE.FLOOR) continue;

    // Skip if inside a room
    let inRoom = false;
    for (const r of rooms) {
      if (sx >= r.x && sx < r.x + r.w && sy >= r.y && sy < r.y + r.h) { inRoom = true; break; }
    }
    if (inRoom) continue;

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const dir = dirs[Math.floor(rng() * dirs.length)];
    const branchLen = 4 + Math.floor(rng() * 5); // 4-8

    let canCarve = true;
    for (let step = 1; step <= branchLen + 2; step++) {
      const nx = sx + dir[0] * step;
      const ny = sy + dir[1] * step;
      if (nx < 2 || nx >= layerWidth - 2 || ny < 2 || ny >= layerHeight - 2) { canCarve = false; break; }
      const perp = dir[0] === 0 ? [1, 0] : [0, 1];
      for (let p = -1; p <= 1; p++) {
        const t = get(nx + perp[0] * p, ny + perp[1] * p);
        if (step > 1 && t !== TILE.VOID) { canCarve = false; break; }
      }
      if (!canCarve) break;
    }
    if (!canCarve) continue;

    for (let step = 1; step <= branchLen; step++) {
      const nx = sx + dir[0] * step;
      const ny = sy + dir[1] * step;
      set(nx, ny, TILE.FLOOR);
      const perp = dir[0] === 0 ? [1, 0] : [0, 1];
      set(nx + perp[0], ny + perp[1], TILE.FLOOR);
    }

    const endX = sx + dir[0] * branchLen;
    const endY = sy + dir[1] * branchLen;
    const alcoveSize = rng() > 0.5 ? 3 : 4;
    const ax = endX - Math.floor(alcoveSize / 2);
    const ay = endY - Math.floor(alcoveSize / 2);
    for (let dy = 0; dy < alcoveSize; dy++) {
      for (let dx = 0; dx < alcoveSize; dx++) {
        const px = ax + dx, py = ay + dy;
        if (px >= 1 && px < layerWidth - 1 && py >= 1 && py < layerHeight - 1) {
          set(px, py, TILE.FLOOR);
        }
      }
    }
    deadEnds.push({ x: endX, y: endY, alcoveSize });
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

  // Overgrown zones + stone floor variation
  const zoneCount = 1 + Math.floor(rng() * 2); // 1-2
  const zones = [];
  for (let i = 0; i < zoneCount; i++) {
    zones.push({
      cx: Math.floor(rng() * layerWidth),
      cy: Math.floor(rng() * layerHeight),
      radius: 20 + Math.floor(rng() * 11),
    });
  }
  function inOvergrownZone(x, y) {
    for (const z of zones) {
      const dx = x - z.cx, dy = y - z.cy;
      if (dx * dx + dy * dy <= z.radius * z.radius) return true;
    }
    return false;
  }
  for (const room of rooms) {
    if (inOvergrownZone(room.cx, room.cy)) {
      const roll = rng();
      let floorChance, wallChance;
      if (roll < 0.40) { floorChance = 0.45 + rng() * 0.20; wallChance = 0.40 + rng() * 0.20; }
      else { floorChance = 0.10 + rng() * 0.20; wallChance = 0.10 + rng() * 0.15; }
      for (let ry = room.y; ry < room.y + room.h; ry++) {
        for (let rx = room.x; rx < room.x + room.w; rx++) {
          if (get(rx, ry) === TILE.FLOOR && rng() < floorChance) set(rx, ry, TILE.GRASS);
        }
      }
      for (let ry = room.y - 1; ry <= room.y + room.h; ry++) {
        for (let rx = room.x - 1; rx <= room.x + room.w; rx++) {
          if (get(rx, ry) === TILE.WALL && rng() < wallChance) set(rx, ry, TILE.WALL_MOSSY);
        }
      }
    }
  }
  // Corridor overgrown
  for (let y = 0; y < layerHeight; y++) {
    for (let x = 0; x < layerWidth; x++) {
      if (!inOvergrownZone(x, y)) continue;
      let inRoom = false;
      for (const r of rooms) {
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) { inRoom = true; break; }
      }
      if (inRoom) continue;
      const t = get(x, y);
      if (t === TILE.FLOOR && rng() < 0.4) set(x, y, TILE.GRASS);
      else if (t === TILE.WALL && rng() < 0.3) set(x, y, TILE.WALL_MOSSY);
    }
  }
  // Stone floor variation: 10% of rooms
  for (const room of rooms) {
    if (rng() < 0.10) {
      for (let ry = room.y; ry < room.y + room.h; ry++) {
        for (let rx = room.x; rx < room.x + room.w; rx++) {
          if (get(rx, ry) === TILE.FLOOR) set(rx, ry, TILE.STONE);
        }
      }
    }
  }

  const doors = [];

  // Furniture overlay
  const overlay = new Map();
  for (const room of rooms) {
    furnishRoom(room, map, layerWidth, layerHeight, overlay);
  }

  // Corridor decoration (torches, pillar pairs)
  decorateCorridors(map, layerWidth, layerHeight, rooms, overlay);

  // Dead-end loot
  for (const de of deadEnds) {
    if (rng() < 0.6) {
      const oKey = overlayKey(de.x, de.y);
      if (!overlay.has(oKey) && (get(de.x, de.y) === TILE.FLOOR || get(de.x, de.y) === TILE.GRASS)) {
        const loot = rng() < 0.4
          ? { char: '▣', color: '#DAA520', passable: false }
          : { char: '◎', color: '#8B4513', passable: false };
        overlay.set(oKey, loot);
      }
    }
  }

  // Floor item positions (~5% per room)
  const floorItemPositions = [];
  for (const room of rooms) {
    if (rng() < 0.05) {
      const candidates = [];
      for (let ry = room.y + 1; ry < room.y + room.h - 1; ry++) {
        for (let rx = room.x + 1; rx < room.x + room.w - 1; rx++) {
          const t = get(rx, ry);
          if ((t === TILE.FLOOR || t === TILE.GRASS || t === TILE.STONE) && !overlay.has(overlayKey(rx, ry))) {
            candidates.push({ x: rx, y: ry });
          }
        }
      }
      if (candidates.length > 0) {
        floorItemPositions.push(candidates[Math.floor(rng() * candidates.length)]);
      }
    }
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
  return { chunks, rooms, doors, floorItemPositions };
}

function packCoord(x, y) {
  return (x + 10000) * 100000 + (y + 10000);
}

