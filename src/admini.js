import { io } from 'socket.io-client';
import { GameMap } from './game-map.js';
import { CHUNK_SIZE, chunkKey } from './chunk.js';
import { TILE_SIZE, TILE, TILE_META } from './config.js';
import { initAdminiRenderer, adminiRender, adminiRenderMother } from './admini-renderer.js';

const canvas = document.getElementById('admin-canvas');
const layerListEl = document.getElementById('layer-list');
const layerInfoEl = document.getElementById('layer-info');
const sidebarLayers = document.getElementById('sidebar-layers');
const sidebarEditor = document.getElementById('sidebar-editor');

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

// --- Edit mode state ---
let editMode = false;
let editingLayerId = null;
let currentTool = 'draw';
let selectedTiles = [TILE.WALL];
let brushSize = 1;
let isDrawing = false;
let pendingTiles = [];
let flushTimer = null;
let currentEntryUp = null;
let currentEntryDown = null;

// Door orientation for placement
let doorOrientation = 'horizontal';

// Mouse world position (for cursor preview)
let mouseWorldX = -1;
let mouseWorldY = -1;

// Input state
const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (editMode) handleEditKeydown(e);
});
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

// Mouse drag panning + edit mode painting
let dragging = false;
let dragStartX = 0, dragStartY = 0;
let camStartX = 0, camStartY = 0;

canvas.addEventListener('mousedown', (e) => {
  if (editMode) {
    if (e.button === 0) {
      // Left click: paint/fill/entry
      const { x: wx, y: wy } = canvasPosToTile(e.clientX, e.clientY);
      if (currentTool === 'fill') {
        floodFill(wx, wy);
      } else if (currentTool === 'entry-down' || currentTool === 'entry-up') {
        placeEntry(wx, wy, currentTool === 'entry-down' ? 'down' : 'up');
      } else if (currentTool === 'door-wood' || currentTool === 'door-metal') {
        placeDoor(wx, wy, currentTool === 'door-wood' ? 'wood' : 'metal');
      } else if (currentTool === 'info') {
        placeInfo(wx, wy);
      } else {
        isDrawing = true;
        paintBrush(wx, wy);
      }
      return;
    }
    // Middle or right click: pan
    if (e.button === 1 || e.button === 2) {
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      camStartX = cameraX;
      camStartY = cameraY;
      canvas.style.cursor = 'grabbing';
      return;
    }
  } else {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    camStartX = cameraX;
    camStartY = cameraY;
    canvas.style.cursor = 'grabbing';
  }
});

canvas.addEventListener('contextmenu', (e) => {
  if (editMode) e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  // Track mouse world position for cursor preview
  const pos = canvasPosToTile(e.clientX, e.clientY);
  mouseWorldX = pos.x;
  mouseWorldY = pos.y;

  if (dragging) {
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    cameraX = camStartX - dx / (TILE_SIZE * zoom);
    cameraY = camStartY - dy / (TILE_SIZE * zoom);
    return;
  }

  if (editMode && isDrawing) {
    paintBrush(pos.x, pos.y);
  }
});

window.addEventListener('mouseup', (e) => {
  if (dragging) {
    dragging = false;
    canvas.style.cursor = editMode ? 'crosshair' : '';
  }
  if (isDrawing) {
    isDrawing = false;
    flushPaintBatch();
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
  if (!editMode) renderSidebar();
});

socket.on('layerUpdate', (layers) => {
  cachedLayers = layers;
  if (!editMode) renderSidebar();
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

  // If in edit mode, update entry info
  if (editMode && layerId === editingLayerId) {
    currentEntryUp = meta.entryUp;
    currentEntryDown = meta.entryDown;
    updateEntryInfo();
  }
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
  alert(message);
});

// --- Editor events from server ---
socket.on('layerCreated', ({ id }) => {
  enterEditMode(id);
});

socket.on('layerDeleted', ({ id }) => {
  if (editMode && editingLayerId === id) {
    exitEditMode();
  }
});

socket.on('tilesUpdated', ({ layerId, tiles }) => {
  if (layerId !== activeLayerId) return;
  for (const { x, y, tile } of tiles) {
    gameMap.setTile(x, y, tile);
  }
});

socket.on('entryUpdated', ({ layerId, entryUp, entryDown }) => {
  if (layerId !== editingLayerId) return;
  currentEntryUp = entryUp;
  currentEntryDown = entryDown;
  updateEntryInfo();
  // Update tiles locally — reload layer to get tile changes
  socket.emit('loadLayer', { layerId });
});

socket.on('doorPlaced', ({ layerId, door }) => {
  if (layerId !== activeLayerId) return;
  gameMap._registerDoor(door);
  for (let i = 0; i < (door.length || 1); i++) {
    const tx = door.orientation === 'horizontal' ? door.x + i : door.x;
    const ty = door.orientation === 'vertical' ? door.y + i : door.y;
    gameMap.setTile(tx, ty, 3); // DOOR_CLOSED
  }
});

socket.on('doorRemoved', ({ layerId, doorIds }) => {
  if (layerId !== activeLayerId) return;
  for (const doorId of doorIds) {
    gameMap.removeDoor(doorId);
  }
});

socket.on('infoPlaced', ({ layerId, info }) => {
  if (layerId !== activeLayerId) return;
  gameMap._registerInfo(info);
  gameMap.setTile(info.x, info.y, 53); // INFO
});

socket.on('infoRemoved', ({ layerId, infoId }) => {
  if (layerId !== activeLayerId) return;
  gameMap.removeInfo(infoId);
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

    const rightSide = document.createElement('span');
    rightSide.style.display = 'flex';
    rightSide.style.alignItems = 'center';
    rightSide.style.gap = '4px';

    if (layer.playerCount > 0) {
      const count = document.createElement('span');
      count.className = 'player-count';
      count.textContent = `(${layer.playerCount})`;
      rightSide.appendChild(count);
    }

    // Edit button for static layers
    if (layer.type === 'static') {
      const editBtn = document.createElement('button');
      editBtn.className = 'edit-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        enterEditMode(layer.id);
      });
      rightSide.appendChild(editBtn);
    }

    header.appendChild(rightSide);
    li.appendChild(header);
    li.dataset.layerId = layer.id;

    if (layer.id === activeLayerId && viewMode !== 'player') {
      li.classList.add('active');
    }

    // Click layer header
    li.addEventListener('click', (e) => {
      // Don't trigger if clicking a player name or edit button
      if (e.target.closest('.player-list') || e.target.closest('.edit-btn')) return;
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
  let html =
    `<span class="label">ID:</span> ${meta.id}<br>` +
    `<span class="label">Type:</span> ${meta.type}<br>` +
    `<span class="label">Bounds:</span> ${b.maxX - b.minX}x${b.maxY - b.minY}`;
  if (meta.entryDown) html += `<br><span class="label">E↓:</span> ${meta.entryDown.x},${meta.entryDown.y}`;
  if (meta.entryUp) html += `<br><span class="label">E↑:</span> ${meta.entryUp.x},${meta.entryUp.y}`;
  layerInfoEl.innerHTML = html;
}

// ─── New Layer Dialog ────────────────────────────────────────────────────────

const btnNewLayer = document.getElementById('btn-new-layer');
const newLayerForm = document.getElementById('new-layer-form');
const btnCreateLayer = document.getElementById('btn-create-layer');
const btnCancelCreate = document.getElementById('btn-cancel-create');

btnNewLayer.addEventListener('click', () => {
  newLayerForm.style.display = newLayerForm.style.display === 'none' ? 'block' : 'none';
});

btnCancelCreate.addEventListener('click', () => {
  newLayerForm.style.display = 'none';
});

btnCreateLayer.addEventListener('click', () => {
  const id = parseInt(document.getElementById('new-layer-id').value);
  if (isNaN(id) || id < 0) return alert('Enter a valid layer ID');
  socket.emit('createStaticLayer', { id });
  newLayerForm.style.display = 'none';
});

// ─── Edit Mode ───────────────────────────────────────────────────────────────

function enterEditMode(layerId) {
  editMode = true;
  editingLayerId = layerId;
  currentTool = 'draw';
  selectedTiles = [TILE.WALL];
  brushSize = 1;
  pendingTiles = [];
  isDrawing = false;

  // Load the layer data
  activeLayerId = layerId;
  socket.emit('loadLayer', { layerId });

  // Switch sidebar
  sidebarLayers.style.display = 'none';
  sidebarEditor.style.display = 'block';

  // Find layer info
  const layer = cachedLayers.find(l => l.id === layerId);
  const dims = layer ? `${layer.bounds.maxX - layer.bounds.minX}x${layer.bounds.maxY - layer.bounds.minY}` : '';

  document.getElementById('editor-title').textContent = `Editing L${layerId}`;
  document.getElementById('editor-dims').textContent = dims;

  // Initialize entry info (will be updated when layer data arrives)
  currentEntryUp = null;
  currentEntryDown = null;
  updateEntryInfo();

  // Disable Entry-Up on L0 (makes no sense)
  const entryUpBtn = document.getElementById('tool-entry-up');
  if (entryUpBtn) {
    entryUpBtn.disabled = layerId === 0;
    entryUpBtn.style.opacity = layerId === 0 ? '0.3' : '';
  }

  // Build palette
  buildPalette();

  // Set active tool button
  updateToolButtons();

  canvas.style.cursor = 'crosshair';
}

function exitEditMode() {
  // Flush any pending paint
  flushPaintBatch();

  editMode = false;
  editingLayerId = null;
  isDrawing = false;
  canvas.style.cursor = '';

  // Switch sidebar
  sidebarEditor.style.display = 'none';
  sidebarLayers.style.display = 'block';

  // Refresh layer list
  socket.emit('getLayers');
}

// Palette tile categories
const PALETTE_CATEGORIES = [
  { name: 'Terrain', tiles: [TILE.WALL, TILE.FLOOR, TILE.GRASS, TILE.WALL_MOSSY, TILE.PATH, TILE.STONE, TILE.TREE] },
  { name: 'Furniture', tiles: [TILE.FURN_TL, TILE.FURN_TR, TILE.FURN_BL, TILE.FURN_BR, TILE.FURN_H, TILE.FURN_V] },
  { name: 'Beds', tiles: [TILE.FURN_DTL, TILE.FURN_DTR, TILE.FURN_DBL, TILE.FURN_DBR, TILE.FURN_DV, TILE.FURN_DH, TILE.FURN_SBT, TILE.FURN_SBB] },
  { name: 'Chairs', tiles: [TILE.CHAIR_S, TILE.CHAIR_W, TILE.CHAIR_N, TILE.CHAIR_E] },
  { name: 'Containers', tiles: [TILE.CHEST, TILE.BARREL, TILE.CRATE] },
  { name: 'Shelves', tiles: [TILE.SHELF_L, TILE.SHELF_R, TILE.SHELF_M] },
  { name: 'Decorative', tiles: [TILE.PILLAR, TILE.STATUE, TILE.TORCH, TILE.WATER, TILE.DIAMOND] },
  { name: 'Dungeon', tiles: [TILE.CAGE_TL, TILE.CAGE_TR, TILE.CAGE_BL, TILE.CAGE_BR, TILE.CAGE_H, TILE.CAGE_V, TILE.ALTAR_L, TILE.ALTAR_M] },
  { name: 'Throne', tiles: [TILE.THRONE_SIDE, TILE.THRONE_TOP, TILE.THRONE_SEAT] },
  { name: 'Workshop', tiles: [TILE.WEAPON_RACK, TILE.ANVIL] },
];

function buildPalette() {
  const paletteEl = document.getElementById('editor-palette');
  paletteEl.innerHTML = '';
  for (const cat of PALETTE_CATEGORIES) {
    const header = document.createElement('div');
    header.className = 'palette-category';
    header.textContent = cat.name;
    paletteEl.appendChild(header);

    const row = document.createElement('div');
    row.className = 'palette-row';
    for (const tile of cat.tiles) {
      const meta = TILE_META[tile];
      if (!meta) continue;
      const swatch = document.createElement('div');
      swatch.className = 'palette-swatch' + (selectedTiles.includes(tile) ? ' active' : '');
      swatch.style.color = meta.fg;
      swatch.textContent = meta.char;
      swatch.title = Object.keys(TILE).find(k => TILE[k] === tile);
      swatch.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          // Toggle in/out of multi-select (min 1)
          const idx = selectedTiles.indexOf(tile);
          if (idx >= 0 && selectedTiles.length > 1) {
            selectedTiles.splice(idx, 1);
          } else if (idx < 0) {
            selectedTiles.push(tile);
          }
        } else {
          selectedTiles = [tile];
        }
        buildPalette();
      });
      row.appendChild(swatch);
    }
    paletteEl.appendChild(row);
  }
}

function updateToolButtons() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === currentTool);
  });
}

function updateEntryInfo() {
  const downEl = document.getElementById('entry-down-pos');
  const upEl = document.getElementById('entry-up-pos');
  downEl.textContent = currentEntryDown ? `${currentEntryDown.x},${currentEntryDown.y}` : 'not set';
  upEl.textContent = currentEntryUp ? `${currentEntryUp.x},${currentEntryUp.y}` : 'not set';
}

// Tool buttons
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    currentTool = btn.dataset.tool;
    updateToolButtons();
  });
});

// Brush size
document.getElementById('brush-dec').addEventListener('click', () => {
  brushSize = Math.max(1, brushSize - 1);
  document.getElementById('brush-size').textContent = brushSize;
});
document.getElementById('brush-inc').addEventListener('click', () => {
  brushSize = Math.min(5, brushSize + 1);
  document.getElementById('brush-size').textContent = brushSize;
});

// Save & Exit
document.getElementById('btn-save-exit').addEventListener('click', exitEditMode);

// Delete layer
document.getElementById('btn-delete-layer').addEventListener('click', () => {
  if (!editingLayerId && editingLayerId !== 0) return;
  if (editingLayerId === 0) return alert('Cannot delete Layer 0');
  if (!confirm(`Delete layer L${editingLayerId}?`)) return;
  socket.emit('deleteStaticLayer', { id: editingLayerId });
});

// Edit mode keyboard shortcuts
function handleEditKeydown(e) {
  if (e.target.tagName === 'INPUT') return;
  switch (e.code) {
    case 'KeyD': currentTool = 'draw'; updateToolButtons(); break;
    case 'KeyF': currentTool = 'fill'; updateToolButtons(); break;
    case 'KeyX': currentTool = 'erase'; updateToolButtons(); break;
    case 'KeyI': currentTool = 'info'; updateToolButtons(); break;
    case 'KeyR':
      if (currentTool === 'door-wood' || currentTool === 'door-metal') {
        doorOrientation = doorOrientation === 'horizontal' ? 'vertical' : 'horizontal';
      }
      break;
    case 'BracketLeft':
      brushSize = Math.max(1, brushSize - 1);
      document.getElementById('brush-size').textContent = brushSize;
      break;
    case 'BracketRight':
      brushSize = Math.min(5, brushSize + 1);
      document.getElementById('brush-size').textContent = brushSize;
      break;
  }
}

// ─── Painting Functions ──────────────────────────────────────────────────────

function canvasPosToTile(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const x = Math.floor(Math.floor(cameraX) + mx / (TILE_SIZE * zoom));
  const y = Math.floor(Math.floor(cameraY) + my / (TILE_SIZE * zoom));
  return { x, y };
}

function paintAt(wx, wy) {
  const tile = currentTool === 'erase' ? TILE.VOID : selectedTiles[Math.floor(Math.random() * selectedTiles.length)];
  const currentTile = gameMap.getTile(wx, wy);
  if (currentTile === tile) return; // no change

  gameMap.setTile(wx, wy, tile);
  pendingTiles.push({ x: wx, y: wy, tile });

  // Debounced flush
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushPaintBatch();
    }, 50);
  }
}

function paintBrush(wx, wy) {
  const half = Math.floor(brushSize / 2);
  for (let dy = -half; dy < brushSize - half; dy++) {
    for (let dx = -half; dx < brushSize - half; dx++) {
      paintAt(wx + dx, wy + dy);
    }
  }
}

function floodFill(startX, startY) {
  const targetTile = gameMap.getTile(startX, startY);
  const pickTile = () => currentTool === 'erase' ? TILE.VOID : selectedTiles[Math.floor(Math.random() * selectedTiles.length)];
  // Check that at least one selected tile differs from target
  if (currentTool !== 'erase' && selectedTiles.length === 1 && selectedTiles[0] === targetTile) return;
  if (currentTool === 'erase' && targetTile === TILE.VOID) return;

  const MAX_RADIUS = 100;
  const visited = new Set();
  const queue = [{ x: startX, y: startY }];
  const maxFill = 10000; // safety limit
  let count = 0;

  while (queue.length > 0 && count < maxFill) {
    const { x, y } = queue.shift();
    const key = (x << 16) | (y & 0xFFFF);
    if (visited.has(key)) continue;
    if (Math.abs(x - startX) > MAX_RADIUS || Math.abs(y - startY) > MAX_RADIUS) continue;
    if (gameMap.getTile(x, y) !== targetTile) continue;

    visited.add(key);
    const fillTile = pickTile();
    gameMap.setTile(x, y, fillTile);
    pendingTiles.push({ x, y, tile: fillTile });
    count++;

    queue.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }

  flushPaintBatch();
}

function flushPaintBatch() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingTiles.length === 0) return;
  socket.emit('paintTiles', { layerId: editingLayerId, tiles: pendingTiles });
  pendingTiles = [];
}

function placeEntry(wx, wy, direction) {
  socket.emit('setEntry', { layerId: editingLayerId, direction, x: wx, y: wy });
}

function placeDoor(wx, wy, type) {
  socket.emit('placeDoor', {
    layerId: editingLayerId, x: wx, y: wy, type,
    length: brushSize, orientation: doorOrientation,
  });
}

function placeInfo(wx, wy) {
  const text = prompt('Info text:');
  if (!text || text.trim().length === 0) return;
  socket.emit('placeInfo', { layerId: editingLayerId, x: wx, y: wy, text: text.trim() });
}

// Pan speed: ~15 tiles/sec
const PAN_SPEED = 15;
let lastTime = performance.now();

function gameLoop(now) {
  const dt = (now - lastTime) / 1000;
  lastTime = now;

  // Camera panning (keyboard) — only when not typing in input
  if (document.activeElement?.tagName !== 'INPUT') {
    let dx = 0, dy = 0;
    if (keys['ArrowLeft'] || keys['KeyA']) dx -= 1;
    if (keys['ArrowRight'] || keys['KeyD']) dx += 1;
    if (keys['ArrowUp'] || keys['KeyW']) dy -= 1;
    if (keys['ArrowDown'] || keys['KeyS']) dy += 1;

    // In edit mode, only pan with arrow keys (WASD used for shortcuts)
    if (editMode) {
      dx = 0; dy = 0;
      if (keys['ArrowLeft']) dx -= 1;
      if (keys['ArrowRight']) dx += 1;
      if (keys['ArrowUp']) dy -= 1;
      if (keys['ArrowDown']) dy += 1;
    }

    cameraX += dx * PAN_SPEED * dt / zoom;
    cameraY += dy * PAN_SPEED * dt / zoom;
  }

  // Resize check
  if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
    resize();
  }

  const camX = Math.floor(cameraX);
  const camY = Math.floor(cameraY);

  // Build edit state for renderer
  const editState = editMode ? {
    mouseWorldX, mouseWorldY, brushSize, currentTool,
    entryUp: currentEntryUp, entryDown: currentEntryDown,
    doorOrientation,
  } : null;

  if (viewMode === 'mother') {
    adminiRenderMother(motherData, camX, camY, zoom);
  } else {
    adminiRender(gameMap, camX, camY, viewMode === 'player' || viewMode === 'static' ? adminPlayers : null, zoom, editState);
  }

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);
