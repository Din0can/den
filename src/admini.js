import { io } from 'socket.io-client';
import { GameMap } from './game-map.js';
import { CHUNK_SIZE, chunkKey } from './chunk.js';
import { TILE_SIZE } from './config.js';
import { initAdminiRenderer, adminiRender, adminiRenderMother } from './admini-renderer.js';

const canvas = document.getElementById('admin-canvas');
const layerListEl = document.getElementById('layer-list');
const layerInfoEl = document.getElementById('layer-info');

const gameMap = new GameMap();
let activeLayerId = null;

// View mode: 'static' | 'mother' | 'player'
let viewMode = 'static';
let activePlayerId = null; // for player view mode

// Mother view data
const motherData = {
  materialized: false,
  boneMap: new GameMap(),
  wings: new Map(), // playerId -> { name, color, gameMap: GameMap }
  players: new Map(), // playerId -> { x, y, name, color, facing }
};

// Player positions for static/player views
const adminPlayers = new Map();

// Camera state (world coordinates of top-left visible tile)
let cameraX = 0;
let cameraY = 0;
let zoom = 1.0;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3.0;
let layerBounds = null;

// Cached layer list from server
let cachedLayers = [];

// Input state
const keys = {};
window.addEventListener('keydown', (e) => { keys[e.code] = true; });
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

// Resize canvas to fill available space
function resize() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}
window.addEventListener('resize', resize);
resize();

// Mouse wheel zoom (centered on cursor)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const oldZoom = zoom;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));

  // Keep world point under cursor stable
  cameraX += mx / (TILE_SIZE * oldZoom) - mx / (TILE_SIZE * zoom);
  cameraY += my / (TILE_SIZE * oldZoom) - my / (TILE_SIZE * zoom);
}, { passive: false });

// Mouse drag panning
let dragging = false;
let dragStartX = 0, dragStartY = 0;
let camStartX = 0, camStartY = 0;

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  camStartX = cameraX;
  camStartY = cameraY;
  canvas.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  cameraX = camStartX - dx / (TILE_SIZE * zoom);
  cameraY = camStartY - dy / (TILE_SIZE * zoom);
});

window.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    canvas.style.cursor = '';
  }
});

initAdminiRenderer(canvas);

// Connect to /admini namespace
const socket = io('/admini', { transports: ['websocket'] });

socket.on('connect', () => {
  socket.emit('getLayers');
});

socket.on('layerList', (layers) => {
  cachedLayers = layers;
  renderSidebar();
});

socket.on('layerUpdate', (layers) => {
  cachedLayers = layers;
  renderSidebar();
});

// --- Static / default layer view ---
socket.on('layerChunks', ({ layerId, meta, chunks, players: layerPlayers }) => {
  if (layerId !== activeLayerId) return;
  viewMode = 'static';
  gameMap.loadChunks(chunks);
  adminPlayers.clear();
  if (layerPlayers) {
    for (const p of layerPlayers) {
      adminPlayers.set(p.id, p);
    }
  }
  centerCamera(meta.bounds);
  updateLayerInfo(meta);
});

// --- Mother view ---
socket.on('motherView', ({ layerId, meta, materialized, bones, wings, players: layerPlayers }) => {
  if (layerId !== activeLayerId) return;
  viewMode = 'mother';

  motherData.materialized = materialized;
  motherData.boneMap = new GameMap();
  motherData.boneMap.initBounds(meta.bounds);
  if (bones.length > 0) motherData.boneMap.loadChunks(bones);

  motherData.wings.clear();
  for (const wing of wings) {
    const gm = new GameMap();
    gm.initBounds(meta.bounds);
    gm.loadChunks(wing.chunks);
    motherData.wings.set(wing.playerId, { name: wing.name, color: wing.color, gameMap: gm });
  }

  motherData.players.clear();
  if (layerPlayers) {
    for (const p of layerPlayers) {
      motherData.players.set(p.id, p);
    }
  }

  centerCamera(meta.bounds);
  updateLayerInfo(meta);
});

// --- Player view ---
socket.on('playerView', ({ layerId, meta, playerId, chunks, players: layerPlayers }) => {
  if (layerId !== activeLayerId) return;
  viewMode = 'player';
  activePlayerId = playerId;

  gameMap.initBounds(meta.bounds);
  gameMap.loadChunks(chunks);

  adminPlayers.clear();
  if (layerPlayers) {
    for (const p of layerPlayers) {
      adminPlayers.set(p.id, p);
    }
  }

  centerCamera(meta.bounds);
  updateLayerInfo(meta);
});

// --- Real-time admin events ---
socket.on('adminPlayerState', (data) => {
  if (viewMode === 'mother') {
    const p = motherData.players.get(data.id);
    if (p) {
      p.x = data.x; p.y = data.y;
      p.name = data.name; p.color = data.color; p.facing = data.facing;
    } else {
      motherData.players.set(data.id, { ...data });
    }
  } else {
    const p = adminPlayers.get(data.id);
    if (p) {
      p.x = data.x; p.y = data.y;
      p.name = data.name; p.color = data.color; p.facing = data.facing;
    } else {
      adminPlayers.set(data.id, { ...data });
    }
  }
});

socket.on('adminPlayerJoined', (data) => {
  if (viewMode === 'mother') {
    motherData.players.set(data.id, data);
  } else {
    adminPlayers.set(data.id, data);
  }
});

socket.on('adminPlayerLeft', ({ id }) => {
  motherData.players.delete(id);
  adminPlayers.delete(id);
});

socket.on('motherWingAdded', ({ playerId, name, color, chunks }) => {
  if (viewMode !== 'mother') return;
  const gm = new GameMap();
  gm.initBounds(layerBounds || { maxX: 160, maxY: 120 });
  gm.loadChunks(chunks);
  motherData.wings.set(playerId, { name, color, gameMap: gm });
});

socket.on('motherWingRemoved', ({ playerId }) => {
  motherData.wings.delete(playerId);
});

socket.on('layerMaterialized', ({ layerId, bones }) => {
  if (activeLayerId !== layerId || viewMode !== 'mother') return;
  motherData.materialized = true;
  motherData.boneMap.loadChunks(bones);
});

socket.on('layerDematerialized', ({ layerId }) => {
  if (activeLayerId !== layerId) return;
  if (viewMode === 'mother') {
    motherData.materialized = false;
    motherData.boneMap = new GameMap();
    motherData.wings.clear();
    motherData.players.clear();
  }
});

socket.on('layerError', ({ message }) => {
  layerInfoEl.textContent = `Error: ${message}`;
});

function centerCamera(bounds) {
  const b = bounds;
  const cols = canvas.width / (TILE_SIZE * zoom);
  const rows = canvas.height / (TILE_SIZE * zoom);
  cameraX = (b.minX + b.maxX) / 2 - cols / 2;
  cameraY = (b.minY + b.maxY) / 2 - rows / 2;
  layerBounds = b;
}

function renderSidebar() {
  layerListEl.innerHTML = '';
  for (const layer of cachedLayers) {
    const li = document.createElement('li');

    // Layer header
    const header = document.createElement('div');
    header.className = 'layer-header';
    const label = document.createElement('span');
    label.textContent = `L${layer.id} — ${layer.type}`;
    header.appendChild(label);

    if (layer.playerCount > 0) {
      const count = document.createElement('span');
      count.className = 'player-count';
      count.textContent = `(${layer.playerCount})`;
      header.appendChild(count);
    }

    li.appendChild(header);
    li.dataset.layerId = layer.id;

    if (layer.id === activeLayerId && viewMode !== 'player') {
      li.classList.add('active');
    }

    // Click layer header
    li.addEventListener('click', (e) => {
      // Don't trigger if clicking a player name
      if (e.target.closest('.player-list')) return;
      loadLayerView(layer);
    });

    // Player names under dynamic layers
    if (layer.players && layer.players.length > 0) {
      const playerUl = document.createElement('ul');
      playerUl.className = 'player-list';
      for (const p of layer.players) {
        const pLi = document.createElement('li');
        if (activeLayerId === layer.id && viewMode === 'player' && activePlayerId === p.id) {
          pLi.classList.add('active');
        }
        pLi.style.color = p.color || '#888';

        const dot = document.createElement('span');
        dot.className = 'player-dot';
        dot.style.backgroundColor = p.color || '#888';
        pLi.appendChild(dot);

        const nameSpan = document.createElement('span');
        nameSpan.textContent = p.name || p.id.slice(0, 8);
        pLi.appendChild(nameSpan);

        pLi.addEventListener('click', (e) => {
          e.stopPropagation();
          loadPlayerView(layer, p.id);
        });
        playerUl.appendChild(pLi);
      }
      li.appendChild(playerUl);
    }

    layerListEl.appendChild(li);
  }
}

function loadLayerView(layer) {
  activeLayerId = layer.id;
  activePlayerId = null;
  gameMap.initBounds(layer.bounds);
  adminPlayers.clear();
  renderSidebar();

  layerInfoEl.textContent = 'Loading...';

  if (layer.type === 'dynamic') {
    // Mother view for dynamic layers
    socket.emit('loadLayer', { layerId: layer.id, mode: 'mother' });
  } else {
    socket.emit('loadLayer', { layerId: layer.id });
  }
}

function loadPlayerView(layer, playerId) {
  activeLayerId = layer.id;
  activePlayerId = playerId;
  gameMap.initBounds(layer.bounds);
  adminPlayers.clear();
  renderSidebar();

  layerInfoEl.textContent = 'Loading player view...';
  socket.emit('loadLayer', { layerId: layer.id, mode: 'player', playerId });
}

function updateLayerInfo(meta) {
  const b = meta.bounds;
  layerInfoEl.innerHTML =
    `<span class="label">ID:</span> ${meta.id}<br>` +
    `<span class="label">Type:</span> ${meta.type}<br>` +
    `<span class="label">Bounds:</span> ${b.maxX - b.minX}x${b.maxY - b.minY}`;
}

// Pan speed: ~15 tiles/sec
const PAN_SPEED = 15;
let lastTime = performance.now();

function gameLoop(now) {
  const dt = (now - lastTime) / 1000;
  lastTime = now;

  // Camera panning (keyboard)
  let dx = 0, dy = 0;
  if (keys['ArrowLeft'] || keys['KeyA']) dx -= 1;
  if (keys['ArrowRight'] || keys['KeyD']) dx += 1;
  if (keys['ArrowUp'] || keys['KeyW']) dy -= 1;
  if (keys['ArrowDown'] || keys['KeyS']) dy += 1;
  cameraX += dx * PAN_SPEED * dt / zoom;
  cameraY += dy * PAN_SPEED * dt / zoom;

  // Resize check
  if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
    resize();
  }

  const camX = Math.floor(cameraX);
  const camY = Math.floor(cameraY);

  if (viewMode === 'mother') {
    adminiRenderMother(motherData, camX, camY, zoom);
  } else {
    adminiRender(gameMap, camX, camY, viewMode === 'player' || viewMode === 'static' ? adminPlayers : null, zoom);
  }

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);
