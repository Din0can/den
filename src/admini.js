import { io } from 'socket.io-client';
import { GameMap } from './game-map.js';
import { CHUNK_SIZE, chunkKey } from './chunk.js';
import { TILE_SIZE, TILE, TILE_META } from './config.js';
import { initAdminiRenderer, adminiRender, adminiRenderMother } from './admini-renderer.js';
import { initSpriteCache, SPRITE_CATALOG, renderSpriteToElement, getSpriteCanvas } from './sprites.js';

const canvas = document.getElementById('admin-canvas');
const layerListEl = document.getElementById('layer-list');
const layerInfoEl = document.getElementById('layer-info');
const sidebarLayers = document.getElementById('sidebar-layers');
const sidebarEditor = document.getElementById('sidebar-editor');
const sidebarItems = document.getElementById('sidebar-items');

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
let mouseWorldX = null;
let mouseWorldY = null;

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
      } else if (currentTool === 'shop') {
        placeOrEditShop(wx, wy);
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
  gm.initBounds(layerBounds || { maxX: 200, maxY: 160 });
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

socket.on('doorState', ({ layerId, doorId, isOpen, tiles }) => {
  if (layerId !== activeLayerId) return;
  gameMap.setDoorState(doorId, isOpen, tiles);
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

socket.on('shopPlaced', ({ layerId, shop }) => {
  if (layerId !== activeLayerId) return;
  gameMap._registerShop(shop);
});

socket.on('shopRemoved', ({ layerId, shopId }) => {
  if (layerId !== activeLayerId) return;
  gameMap.removeShop(shopId);
});

socket.on('shopUpdated', ({ layerId, shop }) => {
  if (layerId !== activeLayerId) return;
  // Remove old and re-register
  gameMap.removeShop(shop.id);
  gameMap._registerShop(shop);
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
  const showing = newLayerForm.style.display !== 'none';
  newLayerForm.style.display = showing ? 'none' : 'block';
  if (!showing) {
    activeLayerId = null;
    gameMap.initBounds({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    adminPlayers.clear();
    layerInfoEl.textContent = '';
    renderSidebar();
  }
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
  socket.emit('getItems');

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
    case 'KeyS': currentTool = 'shop'; updateToolButtons(); break;
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

function placeOrEditShop(wx, wy) {
  // Check if there's an existing shop at this position
  const existingShop = gameMap.getShopAt(wx, wy);
  if (existingShop) {
    openShopEditor(existingShop);
    return;
  }

  const name = prompt('Shop name:', 'Shopkeeper');
  if (!name || name.trim().length === 0) return;
  socket.emit('placeShop', { layerId: editingLayerId, x: wx, y: wy, name: name.trim() });
}

function openShopEditor(shop) {
  const panel = document.getElementById('shop-editor-panel');
  panel.style.display = 'block';
  panel.dataset.shopId = shop.id;

  document.getElementById('shop-name').value = shop.name || 'Shopkeeper';
  document.getElementById('shop-buy-markup').value = shop.buyMarkup ?? 1.0;
  document.getElementById('shop-sell-markup').value = shop.sellMarkup ?? 0.8;

  // Build inventory list
  renderShopInventoryEditor(shop.inventory || []);
}

function renderShopInventoryEditor(inventory) {
  const list = document.getElementById('shop-inv-list');
  list.innerHTML = '';

  for (let i = 0; i < inventory.length; i++) {
    const entry = inventory[i];
    const row = document.createElement('div');
    row.className = 'shop-inv-row';

    // Top line: item select + remove button
    const top = document.createElement('div');
    top.className = 'shop-inv-top';

    const select = document.createElement('select');
    select.className = 'shop-item-select';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '\u2014 item \u2014';
    select.appendChild(defaultOpt);
    for (const [id, item] of Object.entries(cachedItems)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${item.char} ${item.name}`;
      if (id === entry.itemId) opt.selected = true;
      select.appendChild(opt);
    }

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'x';
    removeBtn.addEventListener('click', () => row.remove());

    top.appendChild(select);
    top.appendChild(removeBtn);

    // Bottom line: stock, max, refill with labels
    const bottom = document.createElement('div');
    bottom.className = 'shop-inv-bottom';

    const mkLabel = (text) => { const l = document.createElement('label'); l.textContent = text; return l; };
    const mkInput = (val, min, title) => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = min; inp.value = val; inp.title = title;
      return inp;
    };

    bottom.appendChild(mkLabel('Stk'));
    bottom.appendChild(mkInput(entry.stock ?? -1, '-1', 'Current stock (-1=infinite)'));
    bottom.appendChild(mkLabel('Max'));
    bottom.appendChild(mkInput(entry.maxStock ?? -1, '-1', 'Max stock (-1=infinite)'));
    bottom.appendChild(mkLabel('Refill'));
    bottom.appendChild(mkInput(entry.refillTime ?? 0, '0', 'Refill interval in hours (0=none)'));

    row.appendChild(top);
    row.appendChild(bottom);
    list.appendChild(row);
  }
}

function getShopInvFromUI() {
  const rows = document.querySelectorAll('.shop-inv-row');
  const inv = [];
  for (const row of rows) {
    const itemId = row.querySelector('select').value;
    if (!itemId) continue;
    const inputs = row.querySelectorAll('input');
    inv.push({
      itemId,
      stock: parseInt(inputs[0].value) ?? -1,
      maxStock: parseInt(inputs[1].value) ?? -1,
      refillTime: parseInt(inputs[2].value) || 0,
    });
  }
  return inv;
}

// ─── Items Panel ──────────────────────────────────────────────────────────────

const KNOWN_EFFECTS = [
  { key: 'removeBleed', label: 'Remove Bleed', valueLabel: 'stacks' },
];

function addEffectRow(key = '', value = 1) {
  const list = document.getElementById('item-effects-list');
  const row = document.createElement('div');
  row.className = 'effect-row';

  // Top row: select + remove button
  const topRow = document.createElement('div');
  topRow.className = 'effect-row-top';

  const select = document.createElement('select');
  for (const eff of KNOWN_EFFECTS) {
    const opt = document.createElement('option');
    opt.value = eff.key;
    opt.textContent = eff.label;
    if (eff.key === key) opt.selected = true;
    select.appendChild(opt);
  }

  const removeBtn = document.createElement('button');
  removeBtn.textContent = 'x';
  removeBtn.addEventListener('click', () => row.remove());

  topRow.appendChild(select);
  topRow.appendChild(removeBtn);

  // Bottom row: label + value input
  const bottomRow = document.createElement('div');
  bottomRow.className = 'effect-row-bottom';

  const valLabel = document.createElement('label');
  const getValueLabel = (k) => {
    const eff = KNOWN_EFFECTS.find(e => e.key === k);
    return eff ? eff.valueLabel : 'value';
  };
  valLabel.textContent = getValueLabel(select.value);
  select.addEventListener('change', () => {
    valLabel.textContent = getValueLabel(select.value);
  });

  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.value = value;

  bottomRow.appendChild(valLabel);
  bottomRow.appendChild(input);

  row.appendChild(topRow);
  row.appendChild(bottomRow);
  list.appendChild(row);
}

document.getElementById('btn-add-effect').addEventListener('click', () => {
  addEffectRow();
});

function getEffectsFromUI() {
  const rows = document.querySelectorAll('.effect-row');
  if (rows.length === 0) return null;
  const effect = {};
  for (const row of rows) {
    const key = row.querySelector('select').value;
    const val = parseInt(row.querySelector('input').value) || 1;
    effect[key] = val;
  }
  return effect;
}

const RARITY_COLORS = {
  common: '#888888',
  uncommon: '#5a8a5a',
  rare: '#4a7a9a',
  epic: '#7a5a8a',
  legendary: '#9a7a3a',
};

// Init sprite cache at load
initSpriteCache();

let cachedItems = {};
let selectedItemId = null;
let selectedSprite = null; // currently selected sprite name for item form

// --- Sprite picker ---
function buildSpritePicker() {
  const picker = document.getElementById('sprite-picker');
  picker.innerHTML = '';
  const rarity = document.getElementById('item-rarity').value || 'common';

  for (const cat of SPRITE_CATALOG) {
    const header = document.createElement('div');
    header.className = 'sprite-category';
    header.textContent = cat.category;
    picker.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'sprite-grid';

    for (const sp of cat.sprites) {
      const swatch = document.createElement('button');
      swatch.className = 'sprite-swatch';
      swatch.title = sp.label;
      if (sp.name === selectedSprite) swatch.classList.add('active');

      const c = document.createElement('canvas');
      c.width = 24;
      c.height = 24;
      c.style.width = '24px';
      c.style.height = '24px';
      renderSpriteToElement(c, sp.name, rarity, 22);
      swatch.appendChild(c);

      swatch.addEventListener('click', () => {
        selectedSprite = sp.name;
        updateSpritePreview();
        // Update active state
        picker.querySelectorAll('.sprite-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
      });

      grid.appendChild(swatch);
    }
    picker.appendChild(grid);
  }
}

function updateSpritePreview() {
  const preview = document.getElementById('sprite-preview');
  const label = document.getElementById('sprite-name-label');
  if (selectedSprite) {
    const rarity = document.getElementById('item-rarity').value || 'common';
    renderSpriteToElement(preview, selectedSprite, rarity, 32);
    preview.classList.add('has-sprite');
    label.textContent = selectedSprite;
  } else {
    const ctx = preview.getContext('2d');
    ctx.clearRect(0, 0, preview.width, preview.height);
    preview.classList.remove('has-sprite');
    label.textContent = 'none';
  }
}

// Toggle sprite picker visibility
document.getElementById('sprite-preview').addEventListener('click', () => {
  const picker = document.getElementById('sprite-picker');
  if (picker.style.display === 'none') {
    buildSpritePicker();
    picker.style.display = 'block';
  } else {
    picker.style.display = 'none';
  }
});

// Clear sprite
document.getElementById('btn-clear-sprite').addEventListener('click', () => {
  selectedSprite = null;
  updateSpritePreview();
  document.getElementById('sprite-picker').querySelectorAll('.sprite-swatch').forEach(s => s.classList.remove('active'));
});

// Re-tint picker swatches when rarity changes
document.getElementById('item-rarity').addEventListener('change', () => {
  const picker = document.getElementById('sprite-picker');
  if (picker.style.display !== 'none') {
    buildSpritePicker();
  }
  updateSpritePreview();
});

document.getElementById('btn-items').addEventListener('click', () => {
  sidebarLayers.style.display = 'none';
  sidebarItems.style.display = 'block';
  socket.emit('getItems');
  socket.emit('getContainerConfig');
  socket.emit('getRarityWeights');
});

document.getElementById('btn-items-back').addEventListener('click', () => {
  sidebarItems.style.display = 'none';
  sidebarLayers.style.display = 'block';
});

document.getElementById('btn-new-item').addEventListener('click', () => {
  selectedItemId = null;
  clearItemForm();
  document.getElementById('item-form').style.display = 'block';
  document.getElementById('item-id').disabled = false;
  renderItemList();
});

socket.on('itemList', ({ items }) => {
  cachedItems = items || {};
  renderItemList();
});

socket.on('itemSaved', ({ item }) => {
  cachedItems[item.id] = item;
  selectedItemId = item.id;
  renderItemList();
  document.getElementById('item-form').style.display = 'none';
  // Flash saved item row
  const listEl = document.getElementById('item-list');
  for (const li of listEl.children) {
    if (li.classList.contains('active')) {
      li.classList.add('flash-save');
      setTimeout(() => li.classList.remove('flash-save'), 600);
      break;
    }
  }
});

socket.on('itemDeleted', ({ id: itemId }) => {
  delete cachedItems[itemId];
  if (selectedItemId === itemId) {
    selectedItemId = null;
    document.getElementById('item-form').style.display = 'none';
  }
  renderItemList();
});

function renderItemList() {
  const listEl = document.getElementById('item-list');
  listEl.innerHTML = '';
  for (const [id, item] of Object.entries(cachedItems)) {
    const li = document.createElement('li');
    if (id === selectedItemId) li.classList.add('active');

    if (item.sprite && getSpriteCanvas(item.sprite, item.rarity || 'common')) {
      const c = document.createElement('canvas');
      c.width = 18;
      c.height = 18;
      c.style.width = '18px';
      c.style.height = '18px';
      c.style.imageRendering = 'pixelated';
      c.style.flexShrink = '0';
      renderSpriteToElement(c, item.sprite, item.rarity || 'common', 14);
      li.appendChild(c);
    } else {
      const charSpan = document.createElement('span');
      charSpan.className = 'item-char';
      charSpan.style.color = RARITY_COLORS[item.rarity] || '#888';
      charSpan.textContent = item.char || '?';
      li.appendChild(charSpan);
    }

    const dot = document.createElement('span');
    dot.className = 'rarity-dot';
    dot.style.backgroundColor = RARITY_COLORS[item.rarity] || '#888';
    li.appendChild(dot);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = item.name || id;
    li.appendChild(nameSpan);

    li.addEventListener('click', () => {
      selectedItemId = id;
      populateItemForm(item);
      document.getElementById('item-form').style.display = 'block';
      document.getElementById('item-id').disabled = true; // Can't change ID of existing
      renderItemList();
    });
    listEl.appendChild(li);
  }
}

function clearItemForm() {
  document.getElementById('item-id').value = '';
  document.getElementById('item-name').value = '';
  document.getElementById('item-char').value = '';
  document.getElementById('item-type').value = 'weapon';
  document.getElementById('item-slot').value = '';
  document.getElementById('item-rarity').value = 'common';
  document.getElementById('item-min-layer').value = '0';
  document.getElementById('item-armor').value = '0';
  document.getElementById('item-damage').value = '0';
  document.getElementById('item-max-stack').value = '1';
  document.getElementById('item-stackable').checked = false;
  document.getElementById('item-two-handed').checked = false;
  document.getElementById('item-effects-list').innerHTML = '';
  document.getElementById('item-description').value = '';
  selectedSprite = null;
  updateSpritePreview();
  document.getElementById('sprite-picker').style.display = 'none';
}

function populateItemForm(item) {
  document.getElementById('item-id').value = item.id || '';
  document.getElementById('item-name').value = item.name || '';
  document.getElementById('item-char').value = item.char || '';
  document.getElementById('item-type').value = item.type || 'weapon';
  document.getElementById('item-slot').value = item.slot || '';
  document.getElementById('item-rarity').value = item.rarity || 'common';
  document.getElementById('item-min-layer').value = item.minLayer ?? 0;
  document.getElementById('item-armor').value = item.armor ?? 0;
  document.getElementById('item-damage').value = item.damage ?? 0;
  document.getElementById('item-max-stack').value = item.maxStack ?? 1;
  document.getElementById('item-stackable').checked = !!item.stackable;
  document.getElementById('item-two-handed').checked = !!item.twoHanded;
  document.getElementById('item-effects-list').innerHTML = '';
  if (item.effect) {
    for (const [key, val] of Object.entries(item.effect)) {
      addEffectRow(key, val);
    }
  }
  document.getElementById('item-description').value = item.description || '';
  selectedSprite = item.sprite || null;
  updateSpritePreview();
  document.getElementById('sprite-picker').style.display = 'none';
}

document.getElementById('btn-save-item').addEventListener('click', () => {
  const id = document.getElementById('item-id').value.trim();
  if (!id) return alert('Item ID is required');
  if (!/^[a-z0-9_]+$/.test(id)) return alert('ID must be lowercase alphanumeric with underscores');

  const effect = getEffectsFromUI();

  const item = {
    id,
    name: document.getElementById('item-name').value.trim() || id,
    char: document.getElementById('item-char').value || '?',
    type: document.getElementById('item-type').value,
    slot: document.getElementById('item-slot').value || null,
    rarity: document.getElementById('item-rarity').value,
    stackable: document.getElementById('item-stackable').checked,
    maxStack: parseInt(document.getElementById('item-max-stack').value) || 1,
    armor: parseInt(document.getElementById('item-armor').value) || 0,
    damage: parseInt(document.getElementById('item-damage').value) || 0,
    twoHanded: document.getElementById('item-two-handed').checked,
    minLayer: parseInt(document.getElementById('item-min-layer').value) || 0,
    effect,
    description: document.getElementById('item-description').value.trim(),
    sprite: selectedSprite || null,
  };

  selectedItemId = id;
  socket.emit('saveItem', { item });
});

document.getElementById('btn-delete-item').addEventListener('click', () => {
  if (!selectedItemId) return;
  if (!confirm(`Delete item "${selectedItemId}"?`)) return;
  socket.emit('deleteItem', { id: selectedItemId });
});

// Shop editor buttons
document.getElementById('btn-shop-add-item').addEventListener('click', () => {
  renderShopInventoryEditor([...getShopInvFromUI(), { itemId: '', stock: -1, maxStock: -1, refillTime: 0 }]);
});

document.getElementById('btn-shop-save').addEventListener('click', () => {
  const panel = document.getElementById('shop-editor-panel');
  const shopId = parseInt(panel.dataset.shopId);

  const name = document.getElementById('shop-name').value.trim() || 'Shopkeeper';
  const buyMarkup = parseFloat(document.getElementById('shop-buy-markup').value) || 1.0;
  const sellMarkup = parseFloat(document.getElementById('shop-sell-markup').value) || 0.8;
  const inventory = getShopInvFromUI();

  socket.emit('updateShop', { layerId: editingLayerId, shopId, name, buyMarkup, sellMarkup, inventory });
  panel.style.display = 'none';
});

document.getElementById('btn-shop-delete').addEventListener('click', () => {
  const panel = document.getElementById('shop-editor-panel');
  const shopId = parseInt(panel.dataset.shopId);
  if (!confirm('Delete this shop?')) return;
  socket.emit('removeShop', { layerId: editingLayerId, shopId });
  panel.style.display = 'none';
});

document.getElementById('btn-shop-cancel').addEventListener('click', () => {
  document.getElementById('shop-editor-panel').style.display = 'none';
});

// --- Container config ---
socket.on('containerConfig', (config) => {
  if (config.chest) document.getElementById('cc-chest').value = Math.round(config.chest.dropChance * 100);
  if (config.barrel) document.getElementById('cc-barrel').value = Math.round(config.barrel.dropChance * 100);
  if (config.crate) document.getElementById('cc-crate').value = Math.round(config.crate.dropChance * 100);
});

socket.on('containerConfigSaved', () => {
  const btn = document.getElementById('btn-save-containers');
  btn.textContent = 'Saved!';
  setTimeout(() => { btn.textContent = 'Save Containers'; }, 1000);
});

document.getElementById('btn-save-containers').addEventListener('click', () => {
  const config = {
    chest:  { dropChance: parseInt(document.getElementById('cc-chest').value) / 100, rolls: [1, 1] },
    barrel: { dropChance: parseInt(document.getElementById('cc-barrel').value) / 100, rolls: [1, 1] },
    crate:  { dropChance: parseInt(document.getElementById('cc-crate').value) / 100, rolls: [1, 1] },
  };
  socket.emit('saveContainerConfig', config);
});

// --- Rarity weights editor ---
const RARITY_LABELS = ['Com', 'Unc', 'Rar', 'Epi', 'Leg'];
let cachedBrackets = [];

function renderRarityBrackets(brackets) {
  cachedBrackets = brackets;
  const container = document.getElementById('rw-brackets');
  container.innerHTML = '';

  for (let i = 0; i < brackets.length; i++) {
    const b = brackets[i];
    const isLast = b.maxDepth === null;
    const prevMax = i > 0 ? brackets[i - 1].maxDepth : -1;
    const startLayer = prevMax + 1;

    const card = document.createElement('div');
    card.className = 'rw-bracket';
    card.dataset.index = i;

    // Header
    const header = document.createElement('div');
    header.className = 'rw-header';
    const label = document.createElement('span');
    label.className = 'rw-label';
    if (isLast) {
      label.textContent = `L ${startLayer}+`;
    } else {
      label.innerHTML = `L ${startLayer} – `;
      const depthInput = document.createElement('input');
      depthInput.type = 'number';
      depthInput.min = startLayer;
      depthInput.value = b.maxDepth;
      depthInput.dataset.field = 'maxDepth';
      depthInput.addEventListener('input', () => {
        const cards = document.querySelectorAll('.rw-bracket');
        let prevMax = -1;
        cards.forEach((card, idx) => {
          const isLastCard = idx === cards.length - 1;
          const labelEl = card.querySelector('.rw-label');
          const di = card.querySelector('input[data-field="maxDepth"]');
          const startLayer = prevMax + 1;
          if (isLastCard) {
            labelEl.childNodes[0].textContent = `L ${startLayer}+`;
          } else {
            labelEl.childNodes[0].textContent = `L ${startLayer} – `;
            prevMax = Number(di.value) || startLayer;
          }
        });
      });
      label.appendChild(depthInput);
    }
    header.appendChild(label);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'rw-remove';
    removeBtn.textContent = 'x';
    removeBtn.disabled = brackets.length <= 1;
    removeBtn.addEventListener('click', () => {
      const fresh = collectBracketsFromUI();
      fresh.splice(i, 1);
      renderRarityBrackets(fresh);
    });
    header.appendChild(removeBtn);
    card.appendChild(header);

    // Weight inputs
    const weightsDiv = document.createElement('div');
    weightsDiv.className = 'rw-weights';
    for (let w = 0; w < 5; w++) {
      const wDiv = document.createElement('span');
      wDiv.className = 'rw-w';
      const wLabel = document.createElement('label');
      wLabel.textContent = RARITY_LABELS[w];
      const wInput = document.createElement('input');
      wInput.type = 'number';
      wInput.min = 0;
      wInput.value = b.weights[w];
      wInput.dataset.field = 'weight';
      wInput.dataset.wi = w;
      wDiv.appendChild(wLabel);
      wDiv.appendChild(wInput);
      weightsDiv.appendChild(wDiv);
    }
    card.appendChild(weightsDiv);
    container.appendChild(card);
  }
}

function collectBracketsFromUI() {
  const cards = document.querySelectorAll('.rw-bracket');
  const brackets = [];
  cards.forEach((card, i) => {
    const isLast = i === cards.length - 1;
    const depthInput = card.querySelector('input[data-field="maxDepth"]');
    const maxDepth = isLast ? null : Number(depthInput?.value || 0);
    const weights = [];
    card.querySelectorAll('input[data-field="weight"]').forEach(inp => {
      weights[Number(inp.dataset.wi)] = Number(inp.value) || 0;
    });
    brackets.push({ maxDepth, weights });
  });
  return brackets;
}

socket.on('rarityWeights', (brackets) => {
  renderRarityBrackets(brackets);
});

document.getElementById('btn-add-bracket').addEventListener('click', () => {
  const brackets = collectBracketsFromUI();
  // Insert new bracket before the last (catch-all) one
  const lastIdx = brackets.length - 1;
  const prevMax = lastIdx > 0 ? (brackets[lastIdx - 1].maxDepth || 0) : 0;
  const newMax = prevMax + 2;
  brackets.splice(lastIdx, 0, { maxDepth: newMax, weights: [25, 25, 25, 15, 10] });
  renderRarityBrackets(brackets);
});

document.getElementById('btn-save-rarity').addEventListener('click', () => {
  const brackets = collectBracketsFromUI();
  socket.emit('saveRarityWeights', brackets);
});

socket.on('rarityWeightsSaved', (data) => {
  if (data) renderRarityBrackets(data);
  const btn = document.getElementById('btn-save-rarity');
  btn.textContent = 'Saved!';
  setTimeout(() => { btn.textContent = 'Save Drop Rates'; }, 1000);
});

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
    shops: gameMap._allShops,
    selectedTile: selectedTiles.length === 1 ? selectedTiles[0] : null,
  } : null;

  if (viewMode === 'mother') {
    adminiRenderMother(motherData, camX, camY, zoom);
  } else {
    adminiRender(gameMap, camX, camY, viewMode === 'player' || viewMode === 'static' ? adminPlayers : null, zoom, editState);
  }

  requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);
