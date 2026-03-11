import { viewport } from './viewport.js';

export class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
  }

  /** Center on entity, clamped to map bounds */
  follow(entity, bounds) {
    const halfCols = Math.floor(viewport.cols / 2);
    const halfRows = Math.floor(viewport.rows / 2);

    const mapW = bounds.maxX - bounds.minX;
    const mapH = bounds.maxY - bounds.minY;

    if (mapW <= viewport.cols) {
      this.x = bounds.minX + Math.floor(mapW / 2) - halfCols;
    } else {
      this.x = Math.max(bounds.minX, Math.min(entity.x - halfCols, bounds.maxX - viewport.cols));
    }

    if (mapH <= viewport.rows) {
      this.y = bounds.minY + Math.floor(mapH / 2) - halfRows;
    } else {
      this.y = Math.max(bounds.minY, Math.min(entity.y - halfRows, bounds.maxY - viewport.rows));
    }
  }
}
