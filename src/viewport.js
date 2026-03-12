import { TILE_SIZE } from './config.js';

const MIN_COLS = 40;
const MIN_ROWS = 21;

export const viewport = {
  cols: MIN_COLS,
  rows: MIN_ROWS,
  hudHeight: 48,
  gameWidth: MIN_COLS * TILE_SIZE,
  gameHeight: MIN_ROWS * TILE_SIZE,
};

export function recalcViewport(w, h) {
  viewport.cols = Math.max(MIN_COLS, Math.floor(w / TILE_SIZE));
  viewport.rows = Math.max(MIN_ROWS, Math.floor((h - viewport.hudHeight) / TILE_SIZE));
  viewport.gameWidth = viewport.cols * TILE_SIZE;
  viewport.gameHeight = viewport.rows * TILE_SIZE;
}
