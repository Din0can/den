let ctx;
let canvas;
const FONT_SIZE = 14;
const FONT = "'Kraken-Primary', 'Courier New', monospace";

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

export function renderHud(info) {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);

  // Black background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);

  ctx.font = `${FONT_SIZE}px ${FONT}`;
  ctx.textBaseline = 'middle';

  const pad = 16;
  const y = h / 2;

  // Player name + coords
  const name = info.name || 'unknown';
  const coords = info.x !== undefined ? `(${info.x}, ${info.y})` : '';
  const nameText = `${name} ${coords}`;
  ctx.fillStyle = '#888888';
  ctx.fillText(nameText, pad, y);

  // Connected count + layer — muted
  const nameWidth = ctx.measureText(nameText).width;
  const count = info.playerCount || 1;
  const layer = info.layer !== undefined ? info.layer : 0;
  ctx.fillStyle = '#444444';
  ctx.fillText(`Connected: ${count}   L${layer}`, pad + nameWidth + 24, y);
}
