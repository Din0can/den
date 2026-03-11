// Smooth fog of war overlay using offscreen canvas + radial gradient
// Ported from Kraken2004's fogCanvas approach, adapted for den's pipeline

import { TILE_SIZE, FOV_RADIUS, FOV_GRACE_RADIUS } from './config.js';

const FOG_FADE_DURATION = 2000; // ms to fade from clear to explored dimness
const EXPLORED_VISIBILITY = 0.3; // explored-but-not-visible tiles show at 30%
const TARGET_FOG_LEVEL = 1 - EXPLORED_VISIBILITY; // 0.7

export class Fog {
  constructor() {
    this._canvas = null;
    this._ctx = null;
    this._width = 0;
    this._height = 0;
    // Fade-in timers: integer key -> { startTime, fromLevel }
    this._fadeState = new Map();
    // Settled fog levels: integer key -> fogLevel (0 = clear, 0.7 = explored)
    this._settled = new Map();
  }

  _ensureCanvas(w, h) {
    if (this._width === w && this._height === h && this._canvas) return;
    this._width = w;
    this._height = h;
    if (typeof OffscreenCanvas !== 'undefined') {
      this._canvas = new OffscreenCanvas(w, h);
    } else {
      this._canvas = document.createElement('canvas');
      this._canvas.width = w;
      this._canvas.height = h;
    }
    this._ctx = this._canvas.getContext('2d');
  }

  _key(x, y) {
    return (x << 16) | (y & 0xFFFF);
  }

  /**
   * Start fade timers for tiles that just left FOV.
   * Call once after calculateFOV() when FOV changes.
   */
  updateFade(gameMap) {
    const now = performance.now();

    // Tiles that just left FOV need fade-in animation
    for (const key of gameMap.previousVisible) {
      const x = key >> 16;
      const y = (key << 16) >> 16;
      if (!gameMap.isVisible(x, y) && gameMap.isExplored(x, y)) {
        if (!this._fadeState.has(key)) {
          const currentLevel = this._settled.get(key) || 0;
          this._fadeState.set(key, { startTime: now, fromLevel: currentLevel });
          this._settled.delete(key);
        }
      }
    }

    // Tiles now visible: cancel fades, mark clear
    const w = gameMap.width;
    const h = gameMap.height;
    for (let i = 0; i < w * h; i++) {
      if (gameMap.visible[i]) {
        const x = i % w;
        const y = (i / w) | 0;
        const key = this._key(x, y);
        this._fadeState.delete(key);
        this._settled.set(key, 0);
      }
    }
  }

  /**
   * Get the current fog level for a tile, interpolating active fades.
   */
  _getFogLevel(key, now) {
    // Check active fade
    const fade = this._fadeState.get(key);
    if (fade) {
      const elapsed = now - fade.startTime;
      if (elapsed >= FOG_FADE_DURATION) {
        // Fade complete — settle
        this._fadeState.delete(key);
        this._settled.set(key, TARGET_FOG_LEVEL);
        return TARGET_FOG_LEVEL;
      }
      const t = elapsed / FOG_FADE_DURATION;
      return fade.fromLevel + (TARGET_FOG_LEVEL - fade.fromLevel) * t;
    }

    // Check settled
    const settled = this._settled.get(key);
    if (settled !== undefined) return settled;

    // Default: fully fogged explored tile
    return TARGET_FOG_LEVEL;
  }

  /**
   * Render fog overlay onto the game canvas.
   * Call after all tiles and entities are drawn.
   */
  render(gameCtx, gameMap, camera, playerX, playerY) {
    const w = gameCtx.canvas.width;
    const h = gameCtx.canvas.height;
    this._ensureCanvas(w, h);

    const fogCtx = this._ctx;
    const now = performance.now();

    // Fill fog canvas fully black (opaque fog)
    fogCtx.globalCompositeOperation = 'source-over';
    fogCtx.fillStyle = 'black';
    fogCtx.fillRect(0, 0, w, h);

    // Punch a smooth radial gradient hole at the player position
    fogCtx.globalCompositeOperation = 'destination-out';

    const playerScreenX = (playerX - camera.x + 0.5) * TILE_SIZE;
    const playerScreenY = (playerY - camera.y + 0.5) * TILE_SIZE;
    const gradientRadius = (FOV_RADIUS + FOV_GRACE_RADIUS) * TILE_SIZE;

    const gradient = fogCtx.createRadialGradient(
      playerScreenX, playerScreenY, 0,
      playerScreenX, playerScreenY, gradientRadius
    );
    gradient.addColorStop(0, 'rgba(0,0,0,1.0)');
    gradient.addColorStop(0.5, 'rgba(0,0,0,0.95)');
    gradient.addColorStop(0.75, 'rgba(0,0,0,0.7)');
    gradient.addColorStop(0.9, 'rgba(0,0,0,0.5)');
    gradient.addColorStop(1.0, 'rgba(0,0,0,0.35)');

    fogCtx.fillStyle = gradient;
    fogCtx.beginPath();
    fogCtx.arc(playerScreenX, playerScreenY, gradientRadius, 0, Math.PI * 2);
    fogCtx.fill();

    // For explored-but-not-visible tiles, punch partial holes (no blur — too expensive)
    const viewCols = Math.ceil(w / TILE_SIZE);
    const viewRows = Math.ceil(h / TILE_SIZE);

    for (let row = 0; row < viewRows; row++) {
      for (let col = 0; col < viewCols; col++) {
        const mx = camera.x + col;
        const my = camera.y + row;

        if (gameMap.isVisible(mx, my)) continue;
        if (!gameMap.isExplored(mx, my)) continue;

        const key = this._key(mx, my);
        const fogLevel = this._getFogLevel(key, now);
        const visibility = (1 - fogLevel) * EXPLORED_VISIBILITY;
        if (visibility <= 0) continue;

        const px = col * TILE_SIZE;
        const py = row * TILE_SIZE;

        fogCtx.fillStyle = `rgba(0,0,0,${visibility})`;
        fogCtx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
    }

    // Composite fog onto game canvas
    fogCtx.globalCompositeOperation = 'source-over';
    gameCtx.drawImage(this._canvas, 0, 0);
  }
}
