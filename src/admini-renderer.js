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
    if (door.orientation === 'horizontal') {
      ctx.fillText('\u2503', px + 2, py + 1);
    } else {
      ctx.fillText('\u2501', px + 2, py + 1);
    }
  } else {
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

/** Draw grid lines at tile boundaries (edit mode) */
function adminiRenderGrid(cameraX, cameraY, zoom, cols, rows) {
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1 / zoom; // thin regardless of zoom

  ctx.beginPath();
  for (let col = 0; col <= cols; col++) {
    const px = col * TILE_SIZE;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, rows * TILE_SIZE);
  }
  for (let row = 0; row <= rows; row++) {
    const py = row * TILE_SIZE;
    ctx.moveTo(0, py);
    ctx.lineTo(cols * TILE_SIZE, py);
  }
  ctx.stroke();
}

/** Draw brush cursor preview */
function adminiRenderCursor(editState, cameraX, cameraY) {
  const { mouseWorldX, mouseWorldY, brushSize, currentTool, doorOrientation } = editState;
  if (mouseWorldX == null || mouseWorldY == null) return;

  const isDoorTool = currentTool === 'door-wood' || currentTool === 'door-metal';
  const half = Math.floor(brushSize / 2);
  const showBrush = currentTool === 'draw' || currentTool === 'erase';

  if (isDoorTool) {
    // Multi-tile door cursor preview
    const len = brushSize;
    const orient = doorOrientation || 'horizontal';
    const color = currentTool === 'door-wood' ? 'rgba(139,69,19,0.6)' : 'rgba(112,128,144,0.6)';
    const glyph = orient === 'horizontal' ? '\u2503' : '\u2501'; // ┃ or ━

    for (let i = 0; i < len; i++) {
      const tx = orient === 'horizontal' ? mouseWorldX + i : mouseWorldX;
      const ty = orient === 'vertical' ? mouseWorldY + i : mouseWorldY;
      const px = (tx - cameraX) * TILE_SIZE;
      const py = (ty - cameraY) * TILE_SIZE;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);

      ctx.fillStyle = color;
      ctx.fillText(glyph, px + 2, py + 1);
    }
  } else if (showBrush) {
    // Brush preview rectangle
    const startX = (mouseWorldX - half - cameraX) * TILE_SIZE;
    const startY = (mouseWorldY - half - cameraY) * TILE_SIZE;
    const size = brushSize * TILE_SIZE;

    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(startX, startY, size, size);

    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(startX, startY, size, size);
  } else {
    // Single tile cursor for fill/entry tools
    const px = (mouseWorldX - cameraX) * TILE_SIZE;
    const py = (mouseWorldY - cameraY) * TILE_SIZE;

    ctx.strokeStyle = currentTool === 'fill' ? 'rgba(100,200,255,0.5)' :
                      currentTool === 'entry-down' ? 'rgba(0,255,255,0.5)' :
                      currentTool === 'info' ? 'rgba(0,204,204,0.6)' :
                      currentTool === 'shop' ? 'rgba(204,170,0,0.6)' :
                      'rgba(255,165,0,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);

    if (currentTool === 'shop') {
      ctx.fillStyle = 'rgba(204,170,0,0.6)';
      ctx.fillText('@', px + 2, py + 1);
    }
  }
}

/** Draw entry markers on the map */
function adminiRenderEntryMarkers(entryUp, entryDown, cameraX, cameraY) {
  ctx.font = SMALL_FONT;
  ctx.textBaseline = 'top';

  if (entryDown) {
    const px = (entryDown.x - cameraX) * TILE_SIZE;
    const py = (entryDown.y - cameraY) * TILE_SIZE;
    // Cyan background highlight
    ctx.fillStyle = 'rgba(0,255,255,0.15)';
    ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    // Label
    ctx.fillStyle = '#00cccc';
    ctx.fillText('E\u2193', px + 1, py + 1);
  }

  if (entryUp) {
    const px = (entryUp.x - cameraX) * TILE_SIZE;
    const py = (entryUp.y - cameraY) * TILE_SIZE;
    // Orange background highlight
    ctx.fillStyle = 'rgba(255,165,0,0.15)';
    ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    // Label
    ctx.fillStyle = '#cc8800';
    ctx.fillText('E\u2191', px + 1, py + 1);
  }

  ctx.font = FONT;
}

/** Draw info point text labels above their tiles */
function adminiRenderInfoLabels(gameMap, cameraX, cameraY, cols, rows) {
  if (!gameMap._allInfos || gameMap._allInfos.length === 0) return;

  ctx.font = SMALL_FONT;
  ctx.textBaseline = 'top';

  for (const info of gameMap._allInfos) {
    // Only render if on screen
    const sx = info.x - cameraX;
    const sy = info.y - cameraY;
    if (sx < -5 || sx > cols + 5 || sy < -5 || sy > rows + 5) continue;

    const px = sx * TILE_SIZE;
    const py = sy * TILE_SIZE;
    const tw = ctx.measureText(info.text).width;
    const lx = px + TILE_SIZE / 2 - tw / 2;
    const ly = py - FONT_SIZE * 0.55;

    // Background pill
    ctx.fillStyle = 'rgba(0,20,20,0.7)';
    ctx.fillRect(lx - 3, ly - 1, tw + 6, FONT_SIZE * 0.55 + 2);
    // Text
    ctx.fillStyle = '#00cccc';
    ctx.fillText(info.text, lx, ly);
  }

  ctx.font = FONT;
}

/** Draw shop markers and name labels */
function adminiRenderShops(gameMap, cameraX, cameraY, cols, rows, editState) {
  if (!gameMap._allShops || gameMap._allShops.length === 0) {
    return;
  }

  ctx.font = FONT;
  ctx.textBaseline = 'top';

  for (const shop of gameMap._allShops) {
    const sx = shop.x - cameraX;
    const sy = shop.y - cameraY;
    if (sx < -5 || sx > cols + 5 || sy < -5 || sy > rows + 5) continue;

    const px = sx * TILE_SIZE;
    const py = sy * TILE_SIZE;

    // Gold @ character
    ctx.fillStyle = '#ccaa00';
    ctx.fillText('@', px + 2, py + 1);

    // Name label above
    ctx.font = SMALL_FONT;
    const tw = ctx.measureText(shop.name).width;
    const lx = px + TILE_SIZE / 2 - tw / 2;
    const ly = py - FONT_SIZE * 0.55;

    ctx.fillStyle = 'rgba(20,16,0,0.7)';
    ctx.fillRect(lx - 3, ly - 1, tw + 6, FONT_SIZE * 0.55 + 2);
    ctx.fillStyle = '#ccaa00';
    ctx.fillText(shop.name, lx, ly);

    ctx.font = FONT;
  }
}

/** Standard render: static layers or player composited view + player markers */
export function adminiRender(gameMap, cameraX, cameraY, playersMap, zoom = 1, editState = null) {
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

      // Subtle highlight for tiles matching the selected palette tile
      if (editState && editState.selectedTile != null && tile === editState.selectedTile) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  // Draw player markers
  drawPlayers(playersMap, cameraX, cameraY);

  // Draw info point labels (always in edit mode, or when viewing statics)
  adminiRenderInfoLabels(gameMap, cameraX, cameraY, cols, rows);

  // Draw shops
  adminiRenderShops(gameMap, cameraX, cameraY, cols, rows, editState);

  // Edit mode overlays
  if (editState) {
    adminiRenderGrid(cameraX, cameraY, zoom, cols, rows);
    adminiRenderEntryMarkers(editState.entryUp, editState.entryDown, cameraX, cameraY);
    adminiRenderCursor(editState, cameraX, cameraY);
  }
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
