// Chunk system — shared between client and server
// All maps stored as 16x16 tile chunks

export const CHUNK_SIZE = 16;
export const CHUNK_VIEW_DIST = 3; // chunks in each direction to keep loaded

/** Create a chunk key string from chunk coordinates */
export function chunkKey(cx, cy) {
  return `${cx},${cy}`;
}

/** Parse a chunk key back to coordinates */
export function parseChunkKey(key) {
  const [cx, cy] = key.split(',').map(Number);
  return { cx, cy };
}

/** Convert world coordinates to chunk coordinates + local offset */
export function worldToChunk(x, y) {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const ly = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return { cx, cy, lx, ly };
}

/** Convert chunk coordinates to world coordinates (top-left corner) */
export function chunkToWorld(cx, cy) {
  return { x: cx * CHUNK_SIZE, y: cy * CHUNK_SIZE };
}

/** Get the tile index within a chunk from local coordinates */
export function chunkIndex(lx, ly) {
  return ly * CHUNK_SIZE + lx;
}
