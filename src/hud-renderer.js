import { renderHotbar, renderEquipment, renderEquipAnim, HOTBAR_TOTAL_W } from './hotbar-renderer.js';

let ctx;
let canvas;
const FONT_SIZE = 14;
const FONT = "'Kraken-Primary', 'Courier New', monospace";
const SMALL_FONT_SIZE = 10;
const FIGURE_FONT_SIZE = 10;

export function initHudRenderer(c) {
  canvas = c;
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
}

export function resizeHud(width, hudHeight) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = hudHeight * dpr;
  canvas.style.width = width + 'px';
  canvas.style.height = hudHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function limbColor(hp, maxHp) {
  if (hp <= 0) return '#333333';
  const ratio = hp / maxHp;
  const r = 0xcc;
  const g = Math.floor(0xcc * ratio);
  const b = Math.floor(0xcc * ratio);
  return `rgb(${r},${g},${b})`;
}

function getLimb(limbs, id) {
  if (!limbs) return null;
  return limbs.find(l => l.id === id) || null;
}

function drawStickFigure(x, y, limbs) {
  // ASCII stick figure:
  //  O     ← head
  // /|\    ← arm_l, torso, arm_r
  // / \    ← leg_l, leg_r
  const head = getLimb(limbs, 'head');
  const torso = getLimb(limbs, 'torso');
  const armL = getLimb(limbs, 'arm_l');
  const armR = getLimb(limbs, 'arm_r');
  const legL = getLimb(limbs, 'leg_l');
  const legR = getLimb(limbs, 'leg_r');

  ctx.font = `${FIGURE_FONT_SIZE}px 'JetBrains Mono', 'Courier New', monospace`;
  ctx.textBaseline = 'top';

  const charW = 6;
  const lineH = 10;

  // Row 0: head " O "
  if (head) {
    ctx.fillStyle = limbColor(head.hp, head.maxHp);
    ctx.fillText('O', x + charW, y);
  }

  // Row 1: "/|\"
  const row1Y = y + lineH;
  if (armL) {
    ctx.fillStyle = limbColor(armL.hp, armL.maxHp);
    ctx.fillText('/', x, row1Y);
  }
  if (torso) {
    ctx.fillStyle = limbColor(torso.hp, torso.maxHp);
    ctx.fillText('|', x + charW, row1Y);
  }
  if (armR) {
    ctx.fillStyle = limbColor(armR.hp, armR.maxHp);
    ctx.fillText('\\', x + charW * 2, row1Y);
  }

  // Row 2: "/ \"
  const row2Y = y + lineH * 2;
  if (legL) {
    ctx.fillStyle = limbColor(legL.hp, legL.maxHp);
    ctx.fillText('/', x, row2Y);
  }
  if (legR) {
    ctx.fillStyle = limbColor(legR.hp, legR.maxHp);
    ctx.fillText('\\', x + charW * 2, row2Y);
  }
}

export function renderHud(info) {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);

  // Black background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);

  // Render equipment slots (above hotbar) — gold selection in shop mode
  const shopMode = !!(info.shopState && info.shopState.shopMode);
  const browsingShop = shopMode && info.shopState.shopBrowsing === 'shop';
  renderEquipment(ctx, info.hotbar, w, h, shopMode, browsingShop);
  // Render hotbar (centered)
  renderHotbar(ctx, info.hotbar, w, h, shopMode, browsingShop);
  // Render equip animation
  renderEquipAnim(ctx, info.hotbar);

  // Equip/Use hint between equipment row and hotbar
  if (info.equipHint && !(info.shopState && info.shopState.shopMode)) {
    const hint = typeof info.equipHint === 'string'
      ? { line1: info.equipHint, line2: '' }
      : info.equipHint;
    const SLOT_SIZE = 36;
    const hotbarStartY = (h - SLOT_SIZE) / 2;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';

    // Line 1
    ctx.font = `10px ${FONT}`;
    const tw1 = ctx.measureText(hint.line1).width;
    let hintY = hotbarStartY - 8;
    if (hint.line2) hintY -= 16;
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(w / 2 - tw1 / 2 - 4, hintY - 2, tw1 + 8, 13);
    ctx.fillStyle = '#cccccc';
    ctx.fillText(hint.line1, w / 2, hintY);

    // Line 2 (description + effects)
    if (hint.line2) {
      ctx.font = `10px ${FONT}`;
      const tw2 = ctx.measureText(hint.line2).width;
      const line2Y = hintY + 16;
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(w / 2 - tw2 / 2 - 4, line2Y - 2, tw2 + 8, 13);
      ctx.fillStyle = '#999999';
      ctx.fillText(hint.line2, w / 2, line2Y);
    }

    ctx.textAlign = 'left';
  }

  ctx.font = `${FONT_SIZE}px ${FONT}`;
  ctx.textBaseline = 'middle';

  const pad = 16;
  const y = h / 2;

  // Hotbar left edge for overlap guard
  const hotbarLeft = (w - HOTBAR_TOTAL_W) / 2;

  // Player name + coords
  const name = info.name || 'unknown';
  const coords = info.x !== undefined ? `(${info.x}, ${info.y})` : '';
  const nameText = `${name} ${coords}`;
  ctx.fillStyle = '#888888';
  ctx.fillText(nameText, pad, y);

  // Connected count + layer — muted (only if it fits before hotbar)
  const nameWidth = ctx.measureText(nameText).width;
  const count = info.playerCount || 1;
  const layer = info.layer !== undefined ? info.layer : 0;
  const connectedText = `Connected: ${count}   L${layer}`;
  const connectedX = pad + nameWidth + 24;
  const connectedRight = connectedX + ctx.measureText(connectedText).width;
  if (connectedRight < hotbarLeft - 8) {
    ctx.fillStyle = '#444444';
    ctx.fillText(connectedText, connectedX, y);
  }

  // Right side: horizontal stats + ASCII figure
  if (info.limbs && info.limbs.length > 0) {
    // Figure at far right
    const figureW = 18;
    const figureX = w - figureW - 8;
    const figureY = (h - 30) / 2;
    drawStickFigure(figureX, figureY, info.limbs);

    // Stats on one horizontal line to the left of figure
    ctx.font = `${FONT_SIZE}px ${FONT}`;
    ctx.textBaseline = 'middle';

    // Measure from right to left
    let cursor = figureX - 12;

    // BLD (only if bleeding)
    if (info.bleedStacks > 0) {
      const bldText = `BLD ${info.bleedStacks}`;
      const bldW = ctx.measureText(bldText).width;
      cursor -= bldW;
      ctx.fillStyle = '#880000';
      ctx.fillText(bldText, cursor, y);
      cursor -= 12;
    }

    // SAN
    const sanText = `SAN ${info.sanity || 0}`;
    const sanW = ctx.measureText(sanText).width;
    cursor -= sanW;
    ctx.fillStyle = '#666688';
    ctx.fillText(sanText, cursor, y);
    cursor -= 12;

    // HP with color based on ratio
    const hpText = `HP ${Math.floor(info.hp)}/${info.maxHp}`;
    const hpW = ctx.measureText(hpText).width;
    cursor -= hpW;
    const hpRatio = info.maxHp > 0 ? info.hp / info.maxHp : 0;
    if (hpRatio > 0.5) ctx.fillStyle = '#888888';
    else if (hpRatio > 0.25) ctx.fillStyle = '#cc6600';
    else ctx.fillStyle = '#cc0000';
    ctx.fillText(hpText, cursor, y);
    cursor -= 12;

    // GOLD
    const goldText = `GOLD ${info.gold || 0}`;
    const goldW = ctx.measureText(goldText).width;
    cursor -= goldW;
    ctx.fillStyle = '#ccaa00';
    ctx.fillText(goldText, cursor, y);
  }
}
