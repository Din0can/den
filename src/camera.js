import { VIEWPORT_COLS, VIEWPORT_ROWS, HUD_ROWS } from './config.js';

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
  }

  /** Center on entity, clamped to map edges */
  follow(entity, mapWidth, mapHeight) {
    const viewRows = VIEWPORT_ROWS - HUD_ROWS;
    this.x = Math.max(0, Math.min(entity.x - Math.floor(VIEWPORT_COLS / 2), mapWidth - VIEWPORT_COLS));
    this.y = Math.max(0, Math.min(entity.y - Math.floor(viewRows / 2), mapHeight - viewRows));
  }
}
