// Skeleton (Bone) generator — creates disconnected shared islands on dynamic layers
// Bones are anchor points in the void that all players share.

import { CHUNK_SIZE, chunkKey, worldToChunk, chunkIndex } from './chunk.js';
import { carveVariedCorridor, carveCorridorWithWaypoints } from './map-generator.js';

const TILE = {
  VOID: 0, WALL: 1, FLOOR: 2, DOOR_CLOSED: 3, DOOR_OPEN: 4,
  GRASS: 5, WALL_MOSSY: 6, ENTRY: 7, PATH: 8, STONE: 9,
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
  const clusterRoomSets = []; // track which rooms belong to which cluster
  for (const pos of bonePositions) {
    const regionX = Math.floor(pos.x - BONE_REGION_SIZE / 2);
    const regionY = Math.floor(pos.y - BONE_REGION_SIZE / 2);
    const rw = BONE_REGION_SIZE;
    const rh = BONE_REGION_SIZE;

    // Mini BSP within this region
    const boneRooms = generateBoneCluster(regionX, regionY, rw, rh, set, get, rng, maxWidth, maxHeight);
    clusterRoomSets.push(boneRooms);
    rooms.push(...boneRooms);

    // Connect rooms within this bone cluster
    for (let i = 1; i < boneRooms.length; i++) {
      const a = boneRooms[i - 1];
      const b = boneRooms[i];
      carveVariedCorridor(a.cx, a.cy, b.cx, b.cy, set, get, maxWidth, maxHeight, rng);
    }
  }

  // Inter-cluster spanning tree (Prim's nearest-neighbor)
  // Ensures all bone clusters are reachable from cluster 0 (spawn)
  if (clusterRoomSets.length > 1) {
    const connected = new Set([0]);
    while (connected.size < clusterRoomSets.length) {
      let bestDist = Infinity;
      let bestA = null, bestB = null, bestCluster = -1;

      for (const ci of connected) {
        for (let cj = 0; cj < clusterRoomSets.length; cj++) {
          if (connected.has(cj)) continue;
          for (const rA of clusterRoomSets[ci]) {
            for (const rB of clusterRoomSets[cj]) {
              const d = Math.abs(rA.cx - rB.cx) + Math.abs(rA.cy - rB.cy);
              if (d < bestDist) {
                bestDist = d;
                bestA = rA;
                bestB = rB;
                bestCluster = cj;
              }
            }
          }
        }
      }

      if (bestCluster < 0) break; // safety: no clusters left
      carveCorridorWithWaypoints(bestA.cx, bestA.cy, bestB.cx, bestB.cy, set, get, maxWidth, maxHeight, rng, rooms);
      connected.add(bestCluster);
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

  // Overgrown zones
  const zoneCount = 1 + Math.floor(rng() * 2); // 1-2
  const zones = [];
  for (let i = 0; i < zoneCount; i++) {
    zones.push({
      cx: Math.floor(rng() * maxWidth),
      cy: Math.floor(rng() * maxHeight),
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
  for (let y = 0; y < maxHeight; y++) {
    for (let x = 0; x < maxWidth; x++) {
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

  // Mark first bone room center as ENTRY (spawn point)
  if (rooms.length > 0) {
    set(rooms[0].cx, rooms[0].cy, TILE.ENTRY);
  }

  // Corridor decoration overlay (torches on corridor walls)
  const overlayMap = new Map();
  const isFloor = (t) => t === TILE.FLOOR || t === TILE.GRASS || t === TILE.STONE || t === TILE.ENTRY;
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
  const corridorWidth = (x, y) => {
    let hw = 1;
    for (let dx = 1; isCorridorFloor(x + dx, y); dx++) hw++;
    for (let dx = -1; isCorridorFloor(x + dx, y); dx--) hw++;
    let vw = 1;
    for (let dy = 1; isCorridorFloor(x, y + dy); dy++) vw++;
    for (let dy = -1; isCorridorFloor(x, y + dy); dy--) vw++;
    return Math.min(hw, vw);
  };
  // Find corridor FLOOR tiles adjacent to walls (edge of corridor)
  const torchCandidates = [];
  for (let y = 1; y < maxHeight - 1; y++) {
    for (let x = 1; x < maxWidth - 1; x++) {
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
  // Shuffle with rng
  for (let i = torchCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [torchCandidates[i], torchCandidates[j]] = [torchCandidates[j], torchCandidates[i]];
  }
  const torchInterval = 25 + Math.floor(rng() * 11);
  const placedPositions = [];
  for (const c of torchCandidates) {
    if (placedPositions.length >= 8) break;
    let tooClose = false;
    for (const p of placedPositions) {
      if (Math.abs(p.x - c.x) + Math.abs(p.y - c.y) < torchInterval) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const oKey = (c.x << 16) | (c.y & 0xFFFF);
    if (!overlayMap.has(oKey)) {
      overlayMap.set(oKey, { char: '¥', color: '#FF6600', passable: false });
      placedPositions.push(c);
    }
  }

  // Floor item positions (~5% per bone room)
  const floorItemPositions = [];
  for (const room of rooms) {
    if (rng() < 0.05) {
      const candidates = [];
      for (let ry = room.y + 1; ry < room.y + room.h - 1; ry++) {
        for (let rx = room.x + 1; rx < room.x + room.w - 1; rx++) {
          const t = get(rx, ry);
          if ((t === TILE.FLOOR || t === TILE.GRASS || t === TILE.STONE) && !overlayMap.has((rx << 16) | (ry & 0xFFFF))) {
            candidates.push({ x: rx, y: ry });
          }
        }
      }
      if (candidates.length > 0) {
        floorItemPositions.push(candidates[Math.floor(rng() * candidates.length)]);
      }
    }
  }

  // Build overlay array for chunk distribution
  const overlayArray = [];
  for (const [key, val] of overlayMap) {
    const ox = key >> 16;
    const oy = key & 0xFFFF;
    overlayArray.push([ox, oy, val.char, val.color, val.passable]);
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

  // Distribute overlay to chunks
  for (const entry of overlayArray) {
    const [ox, oy] = entry;
    const { cx, cy } = worldToChunk(ox, oy);
    const key = chunkKey(cx, cy);
    const chunk = chunks.get(key);
    if (chunk) chunk.overlay.push(entry);
  }

  console.log(`Skeleton generated: ${bonePositions.length} bones, ${rooms.length} rooms`);
  return { chunks, rooms, doors, floorItemPositions };
}

/** Generate a small cluster of rooms within a region */
function generateBoneCluster(rx, ry, rw, rh, set, get, rng, mapW, mapH) {
  const rooms = [];
  const pad = 2;

  // Place 2-4 rooms in this bone region
  const roomCount = 2 + Math.floor(rng() * 3);

  for (let i = 0; i < roomCount; i++) {
    const w = 6 + Math.floor(rng() * 7);  // 6-12
    const h = 5 + Math.floor(rng() * 6);  // 5-10

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


