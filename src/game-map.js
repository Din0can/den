import { TILE, MAP_WIDTH, MAP_HEIGHT } from './config.js';

export class GameMap {
  constructor(width = MAP_WIDTH, height = MAP_HEIGHT) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height); // all VOID by default
  }

  /** Load from flat array (server sends Uint8Array) */
  load(data, width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(data);
  }

  getTile(x, y) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return TILE.VOID;
    return this.data[y * this.width + x];
  }

  setTile(x, y, tile) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.data[y * this.width + x] = tile;
  }

  isPassable(x, y) {
    const t = this.getTile(x, y);
    return t === TILE.FLOOR || t === TILE.DOOR;
  }
}
