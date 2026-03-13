// A* pathfinding and line-of-sight — pure functions, server-side
// getTile callback: (x, y) => tileId, used for any tile source

import { TILE_META } from './config.js';

/** Check if a tile ID is walkable */
function isPassableTile(tileId) {
  const meta = TILE_META[tileId];
  return meta ? meta.passable : false;
}

/**
 * A* pathfinding with Manhattan heuristic, cardinal moves only.
 * @param {Function} getTile - (x, y) => tileId
 * @param {number} startX
 * @param {number} startY
 * @param {number} endX
 * @param {number} endY
 * @param {number} maxIter - max iterations to prevent runaway (default 1000)
 * @returns {Array<{x,y}>|null} - path including start and end, or null if unreachable
 */
export function findPath(getTile, startX, startY, endX, endY, maxIter = 1000) {
  if (startX === endX && startY === endY) return [{ x: startX, y: startY }];

  // Check if end tile is passable
  if (!isPassableTile(getTile(endX, endY))) return null;

  const openSet = new Map(); // key -> { x, y, g, f, parent }
  const closedSet = new Set();

  const startKey = `${startX},${startY}`;
  const h = Math.abs(endX - startX) + Math.abs(endY - startY);
  openSet.set(startKey, { x: startX, y: startY, g: 0, f: h, parent: null });

  const dirs = [
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
  ];

  let iterations = 0;
  while (openSet.size > 0 && iterations < maxIter) {
    iterations++;

    // Find node with lowest f in open set
    let bestKey = null;
    let bestF = Infinity;
    for (const [key, node] of openSet) {
      if (node.f < bestF) {
        bestF = node.f;
        bestKey = key;
      }
    }

    const current = openSet.get(bestKey);
    openSet.delete(bestKey);
    closedSet.add(bestKey);

    // Check if we reached the goal
    if (current.x === endX && current.y === endY) {
      // Reconstruct path
      const path = [];
      let node = current;
      while (node) {
        path.push({ x: node.x, y: node.y });
        node = node.parent;
      }
      path.reverse();
      return path;
    }

    // Explore neighbors
    for (const { dx, dy } of dirs) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const nKey = `${nx},${ny}`;

      if (closedSet.has(nKey)) continue;

      const tile = getTile(nx, ny);
      if (!isPassableTile(tile)) continue;

      const g = current.g + 1;
      const existing = openSet.get(nKey);

      if (!existing || g < existing.g) {
        const hN = Math.abs(endX - nx) + Math.abs(endY - ny);
        openSet.set(nKey, { x: nx, y: ny, g, f: g + hN, parent: current });
      }
    }
  }

  return null; // No path found
}

/**
 * Bresenham line-of-sight check.
 * Returns true if there is a clear line from (x1,y1) to (x2,y2).
 * Checks that no tile along the line blocks light.
 * @param {Function} getTile - (x, y) => tileId
 */
export function hasLineOfSight(getTile, x1, y1, x2, y2) {
  let dx = Math.abs(x2 - x1);
  let dy = Math.abs(y2 - y1);
  let sx = x1 < x2 ? 1 : -1;
  let sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;

  let cx = x1;
  let cy = y1;

  while (true) {
    // Skip the start position
    if (cx !== x1 || cy !== y1) {
      // If we reached the end, LOS is clear
      if (cx === x2 && cy === y2) return true;

      // Check if this tile blocks light
      const tile = getTile(cx, cy);
      const meta = TILE_META[tile];
      if (!meta || meta.blocksLight) return false;
    }

    if (cx === x2 && cy === y2) return true;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
}

/**
 * Get a random walkable tile within radius, preferring unvisited tiles.
 * @param {Function} getTile - (x, y) => tileId
 * @param {number} cx - center x
 * @param {number} cy - center y
 * @param {number} radius
 * @param {Set} visited - set of "x,y" strings that have been visited
 * @returns {{x,y}|null}
 */
export function getRandomWalkable(getTile, cx, cy, radius, visited) {
  const unvisited = [];
  const any = [];

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!isPassableTile(getTile(x, y))) continue;
      const key = `${x},${y}`;
      any.push({ x, y });
      if (!visited.has(key)) unvisited.push({ x, y });
    }
  }

  const pool = unvisited.length > 0 ? unvisited : any;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
