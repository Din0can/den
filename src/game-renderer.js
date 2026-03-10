import {
  GAME_WIDTH, GAME_HEIGHT, TILE_SIZE, VIEWPORT_COLS, VIEWPORT_ROWS, HUD_ROWS,
  TILE, COLORS, WALL_CHARS, FLOOR_CHARS
} from './config.js';

let ctx;
const FONT_SIZE = TILE_SIZE;
const FONT = `${FONT_SIZE}px 'JetBrains Mono', monospace`;

export function initRenderer(canvas) {
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
}

/** Simple seeded hash for floor variety */
function tileHash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h ^ (h >> 16)) >>> 0;
}

export function render(gameMap, camera, localEntity, entities, hudInfo) {
  const viewRows = VIEWPORT_ROWS - HUD_ROWS;

  // Clear to black
  ctx.fillStyle = COLORS.VOID_BG;
  ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  ctx.font = FONT;
  ctx.textBaseline = 'top';

  // Draw visible tiles
  for (let row = 0; row < viewRows; row++) {
    for (let col = 0; col < VIEWPORT_COLS; col++) {
      const mx = camera.x + col;
      const my = camera.y + row;
      const tile = gameMap.getTile(mx, my);

      const px = col * TILE_SIZE;
      const py = row * TILE_SIZE;

      if (tile === TILE.WALL) {
        ctx.fillStyle = COLORS.WALL_BG;
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        ctx.fillStyle = COLORS.WALL_FG;
        const ch = WALL_CHARS[tileHash(mx, my) % WALL_CHARS.length];
        ctx.fillText(ch, px + 2, py + 1);
      } else if (tile === TILE.FLOOR) {
        ctx.fillStyle = COLORS.FLOOR_BG;
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        ctx.fillStyle = COLORS.FLOOR_FG;
        const ch = FLOOR_CHARS[tileHash(mx, my) % FLOOR_CHARS.length];
        ctx.fillText(ch, px + 2, py + 1);
      } else if (tile === TILE.DOOR) {
        ctx.fillStyle = COLORS.FLOOR_BG;
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        ctx.fillStyle = COLORS.DOOR_FG;
        ctx.fillText('+', px + 2, py + 1);
      }
      // VOID: already cleared to black
    }
  }

  // Draw entities (remote players)
  for (const ent of entities) {
    const sx = (ent.x - camera.x) * TILE_SIZE;
    const sy = (ent.y - camera.y) * TILE_SIZE;
    if (sx < -TILE_SIZE || sx >= GAME_WIDTH || sy < -TILE_SIZE || sy >= viewRows * TILE_SIZE) continue;

    ctx.fillStyle = ent.color;
    ctx.fillText(ent.char, sx + 2, sy + 1);

    // Name label above entity
    if (ent.name) {
      ctx.font = `${FONT_SIZE - 6}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = ent.color;
      const tw = ctx.measureText(ent.name).width;
      ctx.fillText(ent.name, sx + TILE_SIZE / 2 - tw / 2, sy - 12);
      ctx.font = FONT;
    }
  }

  // Draw local player
  if (localEntity) {
    const sx = (localEntity.x - camera.x) * TILE_SIZE;
    const sy = (localEntity.y - camera.y) * TILE_SIZE;
    ctx.fillStyle = localEntity.color;
    ctx.fillText(localEntity.char, sx + 2, sy + 1);
  }

  // Draw HUD
  drawHUD(hudInfo, viewRows);
}

function drawHUD(info, viewRows) {
  const hudY = viewRows * TILE_SIZE;
  const hudH = HUD_ROWS * TILE_SIZE;

  // HUD background
  ctx.fillStyle = COLORS.HUD_BG;
  ctx.fillRect(0, hudY, GAME_WIDTH, hudH);

  // Top border line
  ctx.fillStyle = COLORS.HUD_FG;
  ctx.fillRect(0, hudY, GAME_WIDTH, 1);

  ctx.font = `${FONT_SIZE - 4}px 'JetBrains Mono', monospace`;
  ctx.fillStyle = COLORS.HUD_FG;
  ctx.textBaseline = 'top';

  const pad = 10;
  const lineH = TILE_SIZE;

  // Line 1: player name and coords
  const name = info.name || 'unknown';
  const coords = info.x !== undefined ? `(${info.x}, ${info.y})` : '';
  ctx.fillText(`${name}  ${coords}`, pad, hudY + 6);

  // Line 2: player count
  const count = info.playerCount || 1;
  ctx.fillText(`Players: ${count}`, pad, hudY + 6 + lineH);

  // Right side: game title
  const title = 'DEN';
  const tw = ctx.measureText(title).width;
  ctx.fillText(title, GAME_WIDTH - tw - pad, hudY + 6);
}
