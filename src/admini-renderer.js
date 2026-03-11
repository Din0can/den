import { TILE_SIZE, TILE, TILE_META, COLORS } from './config.js';
import { CHUNK_SIZE, chunkKey, chunkIndex } from './chunk.js';

let ctx;
const FONT_SIZE = TILE_SIZE;
const FONT = `${FONT_SIZE}px 'JetBrains Mono', monospace`;
const SMALL_FONT = `${Math.floor(FONT_SIZE * 0.55)}px 'JetBrains Mono', monospace`;

// Bone-sacred tiles (same as server): floor, doors, grass, entry
const BONE_SACRED = new Set([TILE.FLOOR, TILE.DOOR_CLOSED, TILE.DOOR_OPEN, TILE.GRASS, TILE.ENTRY]);

export function initAdminiRenderer(canvas) {
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
}

/** Draw a door tile (same logic as game-renderer) */
function drawDoor(px, py, door) {
  const typeColor = door.type === 'metal' ? '#708090' : '#8B4513';
  ctx.fillStyle = typeColor;

  if (door.isOpen) {
    const swing = door.swingDirection;
    if (door.orientation === 'horizontal') {
      if (swing === 'south') {
        ctx.fillText('\u2594', px + 2, py + 1);
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
  } else {
    if (door.orientation === 'horizontal') {
      ctx.fillText('\u2503', px + 2, py + 1);
    } else {
      ctx.fillText('\u2501', px + 2, py + 1);
    }
  }
}

/** Draw player markers on the map (coordinates in tile-space, pre-transform) */
function drawPlayers(playersMap, cameraX, cameraY) {
  if (!playersMap || playersMap.size === 0) return;

  ctx.font = FONT;
  ctx.textBaseline = 'top';

  for (const [, p] of playersMap) {
    const px = (p.x - cameraX) * TILE_SIZE;
    const py = (p.y - cameraY) * TILE_SIZE;

    // Draw @ marker
    ctx.fillStyle = p.color || '#888';
    ctx.fillText('@', px + 2, py + 1);

    // Draw name label above
    if (p.name) {
      ctx.font = SMALL_FONT;
      ctx.fillStyle = p.color || '#888';
      ctx.fillText(p.name, px + 2, py - FONT_SIZE * 0.5);
      ctx.font = FONT;
    }
  }
}

/** Standard render: static layers or player composited view + player markers */
export function adminiRender(gameMap, cameraX, cameraY, playersMap, zoom = 1) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // Clear at identity transform
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.VOID_BG;
  ctx.fillRect(0, 0, w, h);

  // Apply zoom
  ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

  const vw = w / zoom;
  const vh = h / zoom;
  const cols = Math.ceil(vw / TILE_SIZE) + 1;
  const rows = Math.ceil(vh / TILE_SIZE) + 1;

  ctx.font = FONT;
  ctx.textBaseline = 'top';

  // Draw all tiles unconditionally — no FOV, no fog
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const mx = cameraX + col;
      const my = cameraY + row;
      const px = col * TILE_SIZE;
      const py = row * TILE_SIZE;

      const tile = gameMap.getTile(mx, my);
      if (tile === TILE.VOID) continue;

      const meta = TILE_META[tile];
      if (!meta) continue;

      // Door tiles
      if (tile === TILE.DOOR_CLOSED || tile === TILE.DOOR_OPEN) {
        const door = gameMap.getDoorAt(mx, my);
        if (door) {
          drawDoor(px, py, door);
          continue;
        }
      }

      // Overlay (furniture)
      const ov = gameMap.getOverlay(mx, my);
      if (ov) {
        ctx.fillStyle = ov.color;
        ctx.fillText(ov.char, px + 2, py + 1);
      } else {
        ctx.fillStyle = meta.fg;
        ctx.fillText(meta.char, px + 2, py + 1);
      }
    }
  }

  // Draw player markers
  drawPlayers(playersMap, cameraX, cameraY);
}

/** Mother view: bones in white, each player's wing in their color, player markers */
export function adminiRenderMother(motherData, cameraX, cameraY, zoom = 1) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // Clear at identity transform
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.VOID_BG;
  ctx.fillRect(0, 0, w, h);

  // If not materialized, show awaiting message (at identity)
  if (!motherData.materialized) {
    ctx.font = '14px "JetBrains Mono", monospace';
    ctx.fillStyle = '#444';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Awaiting players...', w / 2, h / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    return;
  }

  // Apply zoom
  ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

  const vw = w / zoom;
  const vh = h / zoom;
  const cols = Math.ceil(vw / TILE_SIZE) + 1;
  const rows = Math.ceil(vh / TILE_SIZE) + 1;

  ctx.font = FONT;
  ctx.textBaseline = 'top';

  // Build a per-tile wing color lookup for visible area
  // We iterate per-tile: first check bones, then check wings
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const mx = cameraX + col;
      const my = cameraY + row;
      const px = col * TILE_SIZE;
      const py = row * TILE_SIZE;

      // Check bone tile
      const boneTile = motherData.boneMap.getTile(mx, my);

      // Check wing tiles (last wing wins for overlap)
      let wingTile = TILE.VOID;
      let wingColor = null;
      for (const [, wing] of motherData.wings) {
        const wt = wing.gameMap.getTile(mx, my);
        if (wt !== TILE.VOID) {
          wingTile = wt;
          wingColor = wing.color;
        }
      }

      // Compositing: bone sacred always shows, wing overrides non-sacred
      let tile, color;
      if (BONE_SACRED.has(boneTile)) {
        tile = boneTile;
        color = '#ffffff'; // bones in white
      } else if (wingTile !== TILE.VOID) {
        tile = wingTile;
        color = wingColor;
      } else if (boneTile !== TILE.VOID) {
        tile = boneTile;
        color = '#777777'; // bone walls in dim white
      } else {
        continue; // void, skip
      }

      const meta = TILE_META[tile];
      if (!meta) continue;

      ctx.fillStyle = color;
      ctx.fillText(meta.char, px + 2, py + 1);
    }
  }

  // Draw player markers
  drawPlayers(motherData.players, cameraX, cameraY);
}
