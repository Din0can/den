// Skeleton (Bone) generator — creates disconnected shared islands on dynamic layers
// Bones are anchor points in the void that all players share.

import { CHUNK_SIZE, chunkKey, worldToChunk, chunkIndex } from './chunk.js';

const TILE = {
  VOID: 0, WALL: 1, FLOOR: 2, DOOR_CLOSED: 3, DOOR_OPEN: 4,
  GRASS: 5, WALL_MOSSY: 6, ENTRY: 7,
};

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

/**
 * Generate bone islands for a dynamic layer.
 * @param {number} seed - Layer seed
 * @param {number} skeletonDensity - 0 to 1 (0 = no bones, 1 = full skeleton)
 * @param {number} maxWidth - Layer width in tiles
 * @param {number} maxHeight - Layer height in tiles
 * @returns {{ chunks: Map, rooms: Array, doors: Array }}
 */
export function generateSkeleton(seed, skeletonDensity, maxWidth, maxHeight) {
  const rng = mulberry32(seed);
  const rooms = [];
  const doors = [];
  const chunks = new Map(); // chunkKey -> { tiles, overlay, doors }

  if (skeletonDensity <= 0) {
    return { chunks, rooms, doors };
  }

  // Scratch buffer for bone generation (flat map)
  const map = new Uint8Array(maxWidth * maxHeight);
  const set = (x, y, t) => {
    if (x >= 0 && x < maxWidth && y >= 0 && y < maxHeight) map[y * maxWidth + x] = t;
  };
  const get = (x, y) => {
    if (x < 0 || x >= maxWidth || y < 0 || y >= maxHeight) return TILE.VOID;
    return map[y * maxWidth + x];
  };

  // Calculate bone count and spacing
  const BONE_REGION_SIZE = 30; // each bone occupies a ~30x30 region
  const boneSpacing = BONE_REGION_SIZE + 10; // gap between bone centers
  const maxBonesX = Math.floor(maxWidth / boneSpacing);
  const maxBonesY = Math.floor(maxHeight / boneSpacing);
  const maxBones = maxBonesX * maxBonesY;
  const boneCount = Math.max(1, Math.round(maxBones * skeletonDensity));

  // Distribute bone positions with grid-jitter
  const bonePositions = [];
  const allSlots = [];
  for (let gy = 0; gy < maxBonesY; gy++) {
    for (let gx = 0; gx < maxBonesX; gx++) {
      allSlots.push({
        x: Math.floor(gx * boneSpacing + boneSpacing / 2 + (rng() - 0.5) * 10),
        y: Math.floor(gy * boneSpacing + boneSpacing / 2 + (rng() - 0.5) * 10),
      });
    }
  }

  // Fisher-Yates shuffle, take first boneCount
  for (let i = allSlots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [allSlots[i], allSlots[j]] = [allSlots[j], allSlots[i]];
  }
  for (let i = 0; i < Math.min(boneCount, allSlots.length); i++) {
    const pos = allSlots[i];
    // Clamp to valid region
    pos.x = Math.max(BONE_REGION_SIZE / 2, Math.min(maxWidth - BONE_REGION_SIZE / 2, pos.x));
    pos.y = Math.max(BONE_REGION_SIZE / 2, Math.min(maxHeight - BONE_REGION_SIZE / 2, pos.y));
    bonePositions.push(pos);
  }

  // Generate each bone island as a small BSP cluster
  for (const pos of bonePositions) {
    const regionX = Math.floor(pos.x - BONE_REGION_SIZE / 2);
    const regionY = Math.floor(pos.y - BONE_REGION_SIZE / 2);
    const rw = BONE_REGION_SIZE;
    const rh = BONE_REGION_SIZE;

    // Mini BSP within this region
    const boneRooms = generateBoneCluster(regionX, regionY, rw, rh, set, get, rng, maxWidth, maxHeight);
    rooms.push(...boneRooms);

    // Connect rooms within this bone cluster
    for (let i = 1; i < boneRooms.length; i++) {
      const a = boneRooms[i - 1];
      const b = boneRooms[i];
      carveCorridor(a.cx, a.cy, b.cx, b.cy, set, maxWidth, maxHeight, rng);
    }
  }

  // Wall derivation pass
  for (let y = 0; y < maxHeight; y++) {
    for (let x = 0; x < maxWidth; x++) {
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

  // Mark first bone room center as ENTRY (spawn point)
  if (rooms.length > 0) {
    set(rooms[0].cx, rooms[0].cy, TILE.ENTRY);
  }

  // Convert to chunks (only store non-void chunks)
  const chunksX = Math.ceil(maxWidth / CHUNK_SIZE);
  const chunksY = Math.ceil(maxHeight / CHUNK_SIZE);
  for (let cy = 0; cy < chunksY; cy++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
      let hasContent = false;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const wx = cx * CHUNK_SIZE + lx;
          const wy = cy * CHUNK_SIZE + ly;
          if (wx < maxWidth && wy < maxHeight) {
            const t = map[wy * maxWidth + wx];
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

  console.log(`Skeleton generated: ${bonePositions.length} bones, ${rooms.length} rooms`);
  return { chunks, rooms, doors };
}

/** Generate a small cluster of rooms within a region */
function generateBoneCluster(rx, ry, rw, rh, set, get, rng, mapW, mapH) {
  const rooms = [];
  const pad = 2;

  // Place 2-4 rooms in this bone region
  const roomCount = 2 + Math.floor(rng() * 3);

  for (let i = 0; i < roomCount; i++) {
    const w = 5 + Math.floor(rng() * 6);  // 5-10
    const h = 4 + Math.floor(rng() * 5);  // 4-8

    // Random position within region with padding
    const maxX = rx + rw - w - pad;
    const maxY = ry + rh - h - pad;
    const minX = rx + pad;
    const minY = ry + pad;
    if (maxX <= minX || maxY <= minY) continue;

    const roomX = minX + Math.floor(rng() * (maxX - minX));
    const roomY = minY + Math.floor(rng() * (maxY - minY));

    // Clamp to map bounds
    if (roomX < 1 || roomY < 1 || roomX + w >= mapW - 1 || roomY + h >= mapH - 1) continue;

    // Carve room
    for (let y = roomY; y < roomY + h; y++) {
      for (let x = roomX; x < roomX + w; x++) {
        set(x, y, TILE.FLOOR);
      }
    }

    rooms.push({
      x: roomX, y: roomY, w, h,
      cx: Math.floor(roomX + w / 2),
      cy: Math.floor(roomY + h / 2),
    });
  }

  return rooms;
}

/** Carve a 2-wide L-shaped corridor between two points */
function carveCorridor(x1, y1, x2, y2, set, mapW, mapH, rng) {
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

