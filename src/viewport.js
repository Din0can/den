import { TILE_SIZE } from './config.js';

const isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

const MIN_COLS = isMobile ? 16 : 40;
const MIN_ROWS = isMobile ? 10 : 21;
const MAX_COLS = 60;
const MAX_ROWS = 35;

export const viewport = {
  cols: MIN_COLS,
  rows: MIN_ROWS,
  hudHeight: 130,
  gameWidth: MIN_COLS * TILE_SIZE,
  gameHeight: MIN_ROWS * TILE_SIZE,
};

export function recalcViewport(w, h) {
  viewport.cols = Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(w / TILE_SIZE)));
  viewport.rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor((h - viewport.hudHeight) / TILE_SIZE)));
  viewport.gameWidth = viewport.cols * TILE_SIZE;
  viewport.gameHeight = viewport.rows * TILE_SIZE;
}
