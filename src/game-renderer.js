import { TILE_SIZE, TILE, TILE_META, COLORS, TORCH_VISION_RADIUS } from './config.js';
import { viewport } from './viewport.js';

let ctx;
const FONT_SIZE = TILE_SIZE;
const FONT = `${FONT_SIZE}px 'JetBrains Mono', monospace`;
const NAME_FONT = `${FONT_SIZE - 6}px 'JetBrains Mono', monospace`;

// Pre-rendered torch glow stamp (same pattern as fog.js offscreen canvas)
let _torchGlowCanvas = null;
let _torchGlowSize = 0;

function getTorchGlowCanvas() {
  const size = TORCH_VISION_RADIUS * TILE_SIZE * 2;
  if (_torchGlowCanvas && _torchGlowSize === size) return _torchGlowCanvas;
  _torchGlowSize = size;
  _torchGlowCanvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(size, size)
    : (() => { const c = document.createElement('canvas'); c.width = size; c.height = size; return c; })();
  const g = _torchGlowCanvas.getContext('2d');
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255, 102, 0, 0.12)');
  grad.addColorStop(0.4, 'rgba(255, 80, 0, 0.06)');
  grad.addColorStop(1.0, 'rgba(255, 60, 0, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return _torchGlowCanvas;
}

// Zero-alloc torch collection buffers
const _torchXs = new Int32Array(16);
const _torchYs = new Int32Array(16);

export function initRenderer(canvas) {
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
}

/** Facing rotation angles */
const FACING_ROTATION = {
  south: 0,
  west: Math.PI / 2,
  north: Math.PI,
  east: -Math.PI / 2,
};

/** Draw a character rotated based on facing direction */
function drawRotatedChar(char, px, py, color, facing) {
  const rotation = FACING_ROTATION[facing] || 0;
  ctx.fillStyle = color;
  if (rotation === 0) {
    ctx.fillText(char, px + 2, py + 1);
  } else {
    ctx.save();
    ctx.translate(px + TILE_SIZE / 2, py + TILE_SIZE / 2);
    ctx.rotate(rotation);
    ctx.fillText(char, -TILE_SIZE / 2 + 2, -TILE_SIZE / 2 + 1);
    ctx.restore();
  }
}

/** Draw a door tile using Kraken2004-style characters and thin bars */
function drawDoor(px, py, door) {
  const typeColor = door.type === 'metal' ? '#708090' : '#8B4513';
  ctx.fillStyle = typeColor;

  if (door.isOpen) {
    if (door.orientation === 'horizontal') {
      ctx.fillText('┃', px + 2, py + 1);
    } else {
      ctx.fillText('━', px + 2, py + 1);
    }
  } else {
    const swing = door.swingDirection;
    if (door.orientation === 'horizontal') {
      if (swing === 'south') {
        ctx.fillText('▔', px + 2, py + 1);
      } else {
        ctx.fillRect(px, py + TILE_SIZE - 2, TILE_SIZE, 2);
      }
    } else {
      if (swing === 'east') {
        ctx.fillRect(px, py, 2, TILE_SIZE);
      } else {
        ctx.fillRect(px + TILE_SIZE - 2, py, 2, TILE_SIZE);
      }
    }
  }
}

export function render(gameMap, camera, localEntity, entities, fog, showEntryPrompt, nearbyInfos) {
  const entityArray = Array.from(entities);
  const viewRows = viewport.rows;

  // Clear to black
  ctx.fillStyle = COLORS.VOID_BG;
  ctx.fillRect(0, 0, viewport.gameWidth, viewport.gameHeight);

  ctx.font = FONT;
  ctx.textBaseline = 'top';

  // Draw tiles at full brightness (fog overlay handles dimming)
  for (let row = 0; row < viewRows; row++) {
    for (let col = 0; col < viewport.cols; col++) {
      const mx = camera.x + col;
      const my = camera.y + row;

      const px = col * TILE_SIZE;
      const py = row * TILE_SIZE;

      // FOV check
      const vis = gameMap.isVisible(mx, my);
      const explored = gameMap.isExplored(mx, my);

      if (!explored) continue; // Leave black

      const tile = gameMap.getTile(mx, my);
      const meta = TILE_META[tile];
      if (!meta) continue;

      // Door tiles — canvas-drawn
      if (tile === TILE.DOOR_CLOSED || tile === TILE.DOOR_OPEN) {
        const door = gameMap.getDoorAt(mx, my);
        if (door) {
          drawDoor(px, py, door);
          continue;
        }
      }

      // Blood layer (under overlay/entities)
      const blood = gameMap.getBlood(mx, my);
      if (blood) {
        ctx.fillStyle = '#440808';
        const half = TILE_SIZE / 2;
        if (blood & 1) ctx.fillRect(px, py, half, half);
        if (blood & 2) ctx.fillRect(px + half, py, half, half);
        if (blood & 4) ctx.fillRect(px, py + half, half, half);
        if (blood & 8) ctx.fillRect(px + half, py + half, half, half);
      }

      // Check overlay first
      const ov = gameMap.getOverlay(mx, my);
      if (ov) {
        // Draw base bg, then overlay char
        ctx.fillStyle = ov.color;
        ctx.fillText(ov.char, px + 2, py + 1);
      } else {
        // Draw tile char
        let ch = meta.char;
        let fg = meta.fg;

        ctx.fillStyle = fg;
        ctx.fillText(ch, px + 2, py + 1);
      }
    }
  }

  // Draw entities (remote players) — only if visible
  for (const ent of entityArray) {
    if (!gameMap.isVisible(ent.x, ent.y)) continue;

    const sx = (ent.x - camera.x) * TILE_SIZE;
    const sy = (ent.y - camera.y) * TILE_SIZE;
    if (sx < -TILE_SIZE || sx >= viewport.gameWidth || sy < -TILE_SIZE || sy >= viewRows * TILE_SIZE) continue;

    ctx.font = FONT;
    drawRotatedChar(ent.char, sx, sy, ent.color, ent.facing);

    // Name label above entity
    if (ent.name) {
      ctx.font = NAME_FONT;
      ctx.fillStyle = ent.color;
      if (ent._nameWidth === undefined) {
        ent._nameWidth = ctx.measureText(ent.name).width;
      }
      const tw = ent._nameWidth;
      ctx.fillText(ent.name, sx + TILE_SIZE / 2 - tw / 2, sy - 12);
      ctx.font = FONT;
    }
  }

  // Draw local player (always visible)
  if (localEntity) {
    const sx = (localEntity.x - camera.x) * TILE_SIZE;
    const sy = (localEntity.y - camera.y) * TILE_SIZE;
    drawRotatedChar(localEntity.char, sx, sy, localEntity.color, localEntity.facing);
  }

  // Apply smooth fog overlay
  if (fog) {
    fog.render(ctx, gameMap, camera, localEntity.x, localEntity.y);
  }

  // --- Torch vision: glow, chars, and entity reveal on top of fog ---
  let torchCount = 0;
  for (const [key] of gameMap.torchOverlay) {
    const tx = key >> 16;
    const ty = key & 0xFFFF;
    const margin = TORCH_VISION_RADIUS + 2;
    if (tx >= camera.x - margin && tx < camera.x + viewport.cols + margin &&
        ty >= camera.y - margin && ty < camera.y + viewport.rows + margin) {
      _torchXs[torchCount] = tx;
      _torchYs[torchCount] = ty;
      torchCount++;
      if (torchCount >= _torchXs.length) break;
    }
  }

  if (torchCount > 0) {
    // Torch glow (pre-rendered stamp blitted with 'screen' compositing)
    ctx.globalCompositeOperation = 'screen';
    const glowCanvas = getTorchGlowCanvas();
    const glowR = TORCH_VISION_RADIUS * TILE_SIZE;
    for (let i = 0; i < torchCount; i++) {
      const sx = (_torchXs[i] - camera.x + 0.5) * TILE_SIZE - glowR;
      const sy = (_torchYs[i] - camera.y + 0.5) * TILE_SIZE - glowR;
      ctx.drawImage(glowCanvas, sx, sy);
    }
    ctx.globalCompositeOperation = 'source-over';

    // Always draw torch character on top of fog
    ctx.font = FONT;
    for (let i = 0; i < torchCount; i++) {
      const sx = (_torchXs[i] - camera.x) * TILE_SIZE;
      const sy = (_torchYs[i] - camera.y) * TILE_SIZE;
      if (sx < -TILE_SIZE || sx >= viewport.gameWidth || sy < -TILE_SIZE || sy >= viewRows * TILE_SIZE) continue;
      ctx.fillStyle = '#FF6600';
      ctx.fillText('¥', sx + 2, sy + 1);
    }

    // Draw entities near torches (even if not in player FOV)
    for (const ent of entityArray) {
      if (gameMap.isVisible(ent.x, ent.y)) continue;
      let nearTorch = false;
      for (let j = 0; j < torchCount; j++) {
        const dx = ent.x - _torchXs[j], dy = ent.y - _torchYs[j];
        if (dx * dx + dy * dy <= TORCH_VISION_RADIUS * TORCH_VISION_RADIUS) { nearTorch = true; break; }
      }
      if (!nearTorch) continue;
      const sx = (ent.x - camera.x) * TILE_SIZE;
      const sy = (ent.y - camera.y) * TILE_SIZE;
      if (sx < -TILE_SIZE || sx >= viewport.gameWidth || sy < -TILE_SIZE || sy >= viewRows * TILE_SIZE) continue;
      ctx.font = FONT;
      drawRotatedChar(ent.char, sx, sy, ent.color, ent.facing);
    }
  }

  // "Enter (E)" floating prompt above player on ENTRY tiles
  if (showEntryPrompt && localEntity) {
    const sx = (localEntity.x - camera.x) * TILE_SIZE;
    const sy = (localEntity.y - camera.y) * TILE_SIZE;
    const label = 'Enter (E)';
    ctx.font = NAME_FONT;
    const tw = ctx.measureText(label).width;
    const px = sx + TILE_SIZE / 2 - tw / 2;
    const py = sy - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(px - 4, py - 2, tw + 8, 14);
    ctx.fillStyle = '#cccccc';
    ctx.fillText(label, px, py);
    ctx.font = FONT;
  }

  // Info point hologram text
  if (nearbyInfos && nearbyInfos.length > 0) {
    ctx.font = NAME_FONT;
    ctx.textBaseline = 'top';
    for (const info of nearbyInfos) {
      const ix = (info.x - camera.x) * TILE_SIZE;
      const iy = (info.y - camera.y) * TILE_SIZE;
      const tw = ctx.measureText(info.text).width;
      const px = ix + TILE_SIZE / 2 - tw / 2;
      const py = iy - 16;
      // Dark background pill
      ctx.fillStyle = 'rgba(0,20,20,0.75)';
      ctx.fillRect(px - 5, py - 2, tw + 10, 15);
      ctx.strokeStyle = 'rgba(0,204,204,0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px - 5, py - 2, tw + 10, 15);
      // Cyan text
      ctx.fillStyle = '#00cccc';
      ctx.fillText(info.text, px, py);
    }
    ctx.font = FONT;
  }
}
