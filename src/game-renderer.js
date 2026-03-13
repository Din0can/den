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

export function render(gameMap, camera, localEntity, entities, fog, showEntryPrompt, nearbyInfos, showLootPrompt, containerFloatMsg, showShopPrompt, enemies, combatEffects) {
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

  // Draw enemies — only if visible in FOV
  const now = performance.now();
  if (enemies) {
    for (const [, enemy] of enemies) {
      if (!gameMap.isVisible(enemy.x, enemy.y)) continue;

      let sx = (enemy.x - camera.x) * TILE_SIZE;
      let sy = (enemy.y - camera.y) * TILE_SIZE;
      if (sx < -TILE_SIZE || sx >= viewport.gameWidth || sy < -TILE_SIZE || sy >= viewRows * TILE_SIZE) continue;

      // Apply wiggle offset for combat effects
      if (combatEffects) {
        for (const fx of combatEffects) {
          if (fx.type === 'wiggle' && fx.entityType === 'enemy' && fx.entityId === enemy.id) {
            const t = (now - fx.startTime) / fx.duration;
            const offset = Math.sin(t * Math.PI) * 4;
            const len = Math.sqrt(fx.dx * fx.dx + fx.dy * fx.dy) || 1;
            sx += (fx.dx / len) * offset;
            sy += (fx.dy / len) * offset;
          }
        }
      }

      ctx.font = FONT;
      drawRotatedChar(enemy.char, sx, sy, enemy.color, enemy.facing);

      // Red blink overlay for combat
      if (combatEffects) {
        for (const fx of combatEffects) {
          if (fx.type === 'blink' && fx.entityType === 'enemy' && fx.entityId === enemy.id) {
            const t = (now - fx.startTime) / fx.duration;
            ctx.fillStyle = `rgba(255, 0, 0, ${(1 - t) * 0.5})`;
            ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
          }
        }
      }

      // "!" alert indicator (yellow, above enemy) for 800ms
      if (enemy.state === 'alert') {
        const elapsed = now - (enemy.stateTime || 0);
        if (elapsed < 800) {
          ctx.font = `bold ${FONT_SIZE + 2}px 'JetBrains Mono', monospace`;
          ctx.fillStyle = '#ffff00';
          const tw = ctx.measureText('!').width;
          ctx.fillText('!', sx + TILE_SIZE / 2 - tw / 2, sy - 10);
          ctx.font = FONT;
        }
      }

      // HP bar below enemy (small, 2px tall)
      if (enemy.hp < enemy.maxHp) {
        const barW = TILE_SIZE - 4;
        const barH = 2;
        const barX = sx + 2;
        const barY = sy + TILE_SIZE - 1;
        const ratio = Math.max(0, enemy.hp / enemy.maxHp);
        // Background
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(barX, barY, barW, barH);
        // Fill
        ctx.fillStyle = ratio > 0.5 ? '#44aa44' : ratio > 0.25 ? '#aaaa44' : '#aa4444';
        ctx.fillRect(barX, barY, barW * ratio, barH);
      }
    }
  }

  // Draw shopkeepers
  for (const shop of gameMap._allShops) {
    const vis = gameMap.isVisible(shop.x, shop.y);
    if (!vis) continue;
    const sx = (shop.x - camera.x) * TILE_SIZE;
    const sy = (shop.y - camera.y) * TILE_SIZE;
    if (sx < -TILE_SIZE || sx >= viewport.gameWidth || sy < -TILE_SIZE || sy >= viewRows * TILE_SIZE) continue;

    ctx.font = FONT;
    drawRotatedChar('@', sx, sy, '#ccaa00', 'south');

    // Name label above
    if (shop.name) {
      ctx.font = NAME_FONT;
      ctx.fillStyle = '#ccaa00';
      const tw = ctx.measureText(shop.name).width;
      ctx.fillText(shop.name, sx + TILE_SIZE / 2 - tw / 2, sy - 12);
      ctx.font = FONT;
    }
  }

  // Draw local player (always visible)
  if (localEntity) {
    let sx = (localEntity.x - camera.x) * TILE_SIZE;
    let sy = (localEntity.y - camera.y) * TILE_SIZE;

    // Apply wiggle offset for combat
    if (combatEffects) {
      for (const fx of combatEffects) {
        if (fx.type === 'wiggle' && fx.entityType === 'player') {
          const t = (now - fx.startTime) / fx.duration;
          const offset = Math.sin(t * Math.PI) * 4;
          const len = Math.sqrt(fx.dx * fx.dx + fx.dy * fx.dy) || 1;
          sx += (fx.dx / len) * offset;
          sy += (fx.dy / len) * offset;
        }
      }
    }

    drawRotatedChar(localEntity.char, sx, sy, localEntity.color, localEntity.facing);

    // Red blink overlay for combat
    if (combatEffects) {
      for (const fx of combatEffects) {
        if (fx.type === 'blink' && fx.entityType === 'player') {
          const t = (now - fx.startTime) / fx.duration;
          ctx.fillStyle = `rgba(255, 0, 0, ${(1 - t) * 0.5})`;
          ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
        }
      }
    }
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

    // Draw enemies near torches (even if not in player FOV)
    if (enemies) {
      for (const [, enemy] of enemies) {
        if (gameMap.isVisible(enemy.x, enemy.y)) continue;
        let nearTorch = false;
        for (let j = 0; j < torchCount; j++) {
          const dx = enemy.x - _torchXs[j], dy = enemy.y - _torchYs[j];
          if (dx * dx + dy * dy <= TORCH_VISION_RADIUS * TORCH_VISION_RADIUS) { nearTorch = true; break; }
        }
        if (!nearTorch) continue;
        const esx = (enemy.x - camera.x) * TILE_SIZE;
        const esy = (enemy.y - camera.y) * TILE_SIZE;
        if (esx < -TILE_SIZE || esx >= viewport.gameWidth || esy < -TILE_SIZE || esy >= viewRows * TILE_SIZE) continue;
        ctx.font = FONT;
        drawRotatedChar(enemy.char, esx, esy, enemy.color, enemy.facing);
      }
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

  // "Loot (E)" floating prompt when facing a container
  if (showLootPrompt && localEntity) {
    const sx = (localEntity.x - camera.x) * TILE_SIZE;
    const sy = (localEntity.y - camera.y) * TILE_SIZE;
    const label = 'Loot (E)';
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

  // "Shop (E)" floating prompt when facing a shop
  if (showShopPrompt && localEntity) {
    const sx = (localEntity.x - camera.x) * TILE_SIZE;
    const sy = (localEntity.y - camera.y) * TILE_SIZE;
    const label = 'Shop (E)';
    ctx.font = NAME_FONT;
    const tw = ctx.measureText(label).width;
    const px = sx + TILE_SIZE / 2 - tw / 2;
    const py = sy - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(px - 4, py - 2, tw + 8, 14);
    ctx.fillStyle = '#ccaa00';
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

  // Container result floating message (above player, timed)
  if (containerFloatMsg && localEntity) {
    const sx = (localEntity.x - camera.x) * TILE_SIZE;
    const sy = (localEntity.y - camera.y) * TILE_SIZE;
    ctx.font = NAME_FONT;
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(containerFloatMsg).width;
    const px = sx + TILE_SIZE / 2 - tw / 2;
    const py = sy - 28;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(px - 5, py - 2, tw + 10, 14);
    ctx.fillStyle = '#ddcc88';
    ctx.fillText(containerFloatMsg, px, py);
    ctx.font = FONT;
  }

  // Floating combat text
  if (combatEffects) {
    ctx.font = `bold ${FONT_SIZE - 2}px 'JetBrains Mono', monospace`;
    ctx.textBaseline = 'top';
    let floatIndex = 0;
    for (const fx of combatEffects) {
      if (fx.type !== 'floatText') continue;
      const t = (now - fx.startTime) / fx.duration;
      const worldX = (fx.x - camera.x) * TILE_SIZE + TILE_SIZE / 2;
      const worldY = (fx.y - camera.y) * TILE_SIZE;
      const offsetY = -24 * t - floatIndex * 14;
      const alpha = Math.max(0, 1 - t);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fx.color;
      const tw = ctx.measureText(fx.text).width;
      ctx.fillText(fx.text, worldX - tw / 2, worldY + offsetY);
      floatIndex++;
    }
    ctx.globalAlpha = 1;
    ctx.font = FONT;
  }

}
