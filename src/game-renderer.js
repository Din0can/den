import { TILE_SIZE, TILE, TILE_META, COLORS } from './config.js';
import { viewport } from './viewport.js';

let ctx;
const FONT_SIZE = TILE_SIZE;
const FONT = `${FONT_SIZE}px 'JetBrains Mono', monospace`;
const NAME_FONT = `${FONT_SIZE - 6}px 'JetBrains Mono', monospace`;

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
    const swing = door.swingDirection;
    if (door.orientation === 'horizontal') {
      if (swing === 'south') {
        // Top-edge bar character
        ctx.fillText('▔', px + 2, py + 1);
      } else {
        // Bottom-edge thin bar
        ctx.fillRect(px, py + TILE_SIZE - 2, TILE_SIZE, 2);
      }
    } else {
      if (swing === 'east') {
        // Left-edge thin bar
        ctx.fillRect(px, py, 2, TILE_SIZE);
      } else {
        // Right-edge thin bar
        ctx.fillRect(px + TILE_SIZE - 2, py, 2, TILE_SIZE);
      }
    }
  } else {
    if (door.orientation === 'horizontal') {
      ctx.fillText('┃', px + 2, py + 1);
    } else {
      ctx.fillText('━', px + 2, py + 1);
    }
  }
}

export function render(gameMap, camera, localEntity, entities, fog, showEntryPrompt) {
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
  for (const ent of entities) {
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

  // "Enter (E)" floating prompt above player on ENTRY tiles
  if (showEntryPrompt && localEntity) {
    const sx = (localEntity.x - camera.x) * TILE_SIZE;
    const sy = (localEntity.y - camera.y) * TILE_SIZE;
    const label = 'Enter (E)';
    ctx.font = NAME_FONT;
    const tw = ctx.measureText(label).width;
    const px = sx + TILE_SIZE / 2 - tw / 2;
    const py = sy - 14;
    // Dark background pill
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(px - 4, py - 2, tw + 8, 14);
    // Text
    ctx.fillStyle = '#cccccc';
    ctx.fillText(label, px, py);
    ctx.font = FONT;
  }
}
