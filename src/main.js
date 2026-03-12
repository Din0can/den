import { MOVE_COOLDOWN, COLORS, FOV_RADIUS, FOV_GRACE_RADIUS, TILE } from './config.js';
import { CHUNK_VIEW_DIST, chunkKey, worldToChunk } from './chunk.js';
import { init as initCRT, resize as resizeCRT, resizeTexture } from './crt-renderer.js';
import { GameMap } from './game-map.js';
import { Entity } from './entity.js';
import { Camera } from './camera.js';
import { initInput, getMovementDir, consumeInteract, consumeHurt } from './input.js';
import { initRenderer, render } from './game-renderer.js';
import { initHudRenderer, resizeHud, renderHud } from './hud-renderer.js';
import { hudInfo, updateHUD } from './hud.js';
import { calculateFOV } from './fov.js';
import { viewport, recalcViewport } from './viewport.js';
import { Fog } from './fog.js';
import * as network from './network.js';

// Facing direction -> interaction offset
const FACING_OFFSET = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  east:  { dx: 1, dy: 0 },
  west:  { dx: -1, dy: 0 },
};

function dirToFacing(dx, dy) {
  if (dy < 0) return 'north';
  if (dy > 0) return 'south';
  if (dx > 0) return 'east';
  if (dx < 0) return 'west';
  return 'south';
}

// State
const gameMap = new GameMap();
const camera = new Camera();
const fog = new Fog();
let localEntity = null;
const remotePlayers = new Map();
let lastMoveTime = 0;
let playerName = '';
let connected = false;
let fovDirty = true;
let currentLayerId = null;
let onEntryTile = false;
let localStats = null;
let gameCanvas;
let hudCanvas;

// Chunk tracking
let lastChunkX = -999;
let lastChunkY = -999;
function handleResize() {
  recalcViewport(window.innerWidth, window.innerHeight);
  gameCanvas.width = viewport.gameWidth;
  gameCanvas.height = viewport.gameHeight;
  initRenderer(gameCanvas);
  resizeTexture();
  resizeCRT(window.innerHeight - viewport.hudHeight);
  resizeHud(window.innerWidth, viewport.hudHeight);
  fovDirty = true;
}

let resizeTimer;
function debouncedResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(handleResize, 100);
}

function loadLayer(meta, initialChunks) {
  currentLayerId = meta.id;
  gameMap.initBounds(meta.bounds);
  gameMap.loadChunks(initialChunks);
  lastChunkX = -999;
  lastChunkY = -999;
  fovDirty = true;
}

function checkChunkBoundary() {
  if (!localEntity || currentLayerId === null) return;
  const { cx, cy } = worldToChunk(localEntity.x, localEntity.y);
  if (cx === lastChunkX && cy === lastChunkY) return;

  lastChunkX = cx;
  lastChunkY = cy;

  // Find chunks we need but don't have
  const missing = [];
  for (let dy = -CHUNK_VIEW_DIST; dy <= CHUNK_VIEW_DIST; dy++) {
    for (let dx = -CHUNK_VIEW_DIST; dx <= CHUNK_VIEW_DIST; dx++) {
      const key = chunkKey(cx + dx, cy + dy);
      if (!gameMap.chunks.has(key)) {
        missing.push(key);
      }
    }
  }

  if (missing.length > 0) {
    network.requestChunks(currentLayerId, missing);
  }
}

function init() {
  gameCanvas = document.getElementById('game-canvas');
  hudCanvas = document.getElementById('hud-canvas');
  recalcViewport(window.innerWidth, window.innerHeight);
  gameCanvas.width = viewport.gameWidth;
  gameCanvas.height = viewport.gameHeight;
  initRenderer(gameCanvas);
  initHudRenderer(hudCanvas);
  resizeHud(window.innerWidth, viewport.hudHeight);
  initInput();
  window.addEventListener('resize', debouncedResize);

  playerName = generateName();
  network.connect();

  network.onWelcome((data) => {
    connected = true;
    loadLayer(data.layerMeta, data.initialChunks);
    if (data.stats) localStats = data.stats;
    if (data.blood) gameMap.loadBlood(data.blood);

    localEntity = new Entity(data.id, data.spawn.x, data.spawn.y, '@', COLORS.PLAYER_LOCAL, playerName, 'south');

    for (const p of data.players) {
      remotePlayers.set(p.id, new Entity(p.id, p.x, p.y, '@', p.color || '#888888', p.name || '', p.facing || 'south'));
    }

    // Send name to server to trigger color computation
    network.sendName(playerName);

    const bounds = gameMap.getLoadedBounds();
    camera.follow(localEntity, bounds);
    checkChunkBoundary();
    fovDirty = true;
  });

  network.onPlayerJoined((data) => {
    remotePlayers.set(data.id, new Entity(data.id, data.spawn.x, data.spawn.y, '@', data.color || '#888888', data.name || '', data.facing || 'south'));
  });

  network.onPlayerLeft((data) => {
    remotePlayers.delete(data.id);
  });

  network.onPlayerState((data) => {
    const ent = remotePlayers.get(data.id);
    if (ent) {
      if (data.x !== undefined) ent.x = data.x;
      if (data.y !== undefined) ent.y = data.y;
      if (data.color) ent.color = data.color;
      if (data.name) ent.name = data.name;
      if (data.facing) ent.facing = data.facing;
    }
  });

  network.onDoorState((data) => {
    gameMap.setDoorState(data.doorId, data.isOpen, data.tiles);
    fovDirty = true;
  });

  network.onChunkData((data) => {
    gameMap.loadChunks(data.chunks);
    fovDirty = true;
  });

  network.onLayerData((data) => {
    loadLayer(data.layerMeta, data.initialChunks);
    if (data.stats) localStats = data.stats;
    if (data.blood) gameMap.loadBlood(data.blood);
    remotePlayers.clear();
    if (data.players) {
      for (const p of data.players) {
        remotePlayers.set(p.id, new Entity(p.id, p.x, p.y, '@', p.color || '#888888', p.name || '', p.facing || 'south'));
      }
    }
    if (data.spawn && localEntity) {
      localEntity.x = data.spawn.x;
      localEntity.y = data.spawn.y;
    }
    fovDirty = true;
  });

  network.onDamage((data) => {
    if (data.stats) localStats = data.stats;
  });

  network.onBloodUpdate((data) => {
    if (data.updates) {
      for (const u of data.updates) {
        gameMap.setBlood(u.x, u.y, u.quadrants);
      }
    }
  });

  initCRT(gameLoop);
}

function gameLoop(now) {
  if (!localEntity) return;

  // Movement with cooldown
  const dir = getMovementDir();
  if (dir && now - lastMoveTime >= MOVE_COOLDOWN) {
    const newFacing = dirToFacing(dir.dx, dir.dy);
    const facingChanged = localEntity.facing !== newFacing;
    localEntity.facing = newFacing;

    const nx = localEntity.x + dir.dx;
    const ny = localEntity.y + dir.dy;
    if (gameMap.isPassable(nx, ny)) {
      localEntity.x = nx;
      localEntity.y = ny;
      lastMoveTime = now;
      fovDirty = true;
      network.sendState(localEntity.x, localEntity.y, localEntity.facing);
      checkChunkBoundary();
    } else if (facingChanged) {
      network.sendFacing(localEntity.facing);
    }
  }

  // Detect ENTRY tile under player
  onEntryTile = gameMap.getTile(localEntity.x, localEntity.y) === TILE.ENTRY;

  // Debug hurt (H key) — damage a random non-severed limb
  if (consumeHurt() && localStats) {
    const alive = localStats.limbs.filter(l => l.hp > 0);
    if (alive.length > 0) {
      const limb = alive[Math.floor(Math.random() * alive.length)];
      network.sendHurt(limb.id, 5, 'flat');
    }
  }

  // Interact (E key) — ENTRY takes priority over doors
  if (consumeInteract()) {
    if (onEntryTile) {
      network.sendEnterExit();
    } else {
      const offset = FACING_OFFSET[localEntity.facing];
      const tx = localEntity.x + offset.dx;
      const ty = localEntity.y + offset.dy;
      const door = gameMap.getDoorAt(tx, ty);
      if (door) {
        network.sendDoorToggle(door.id);
      } else {
        const standDoor = gameMap.getDoorAt(localEntity.x, localEntity.y);
        if (standDoor) {
          network.sendDoorToggle(standDoor.id);
        }
      }
    }
  }

  // FOV
  if (fovDirty) {
    calculateFOV(gameMap, localEntity.x, localEntity.y, FOV_RADIUS, FOV_GRACE_RADIUS);
    fog.updateFade(gameMap);
    fovDirty = false;
  }

  // Camera
  const bounds = gameMap.getLoadedBounds();
  camera.follow(localEntity, bounds);

  // HUD
  updateHUD(playerName, localEntity.x, localEntity.y, remotePlayers.size + 1, currentLayerId, localStats);

  // Gather nearby info hologram text
  const nearbyInfos = gameMap.getInfoNear(localEntity.x, localEntity.y, 1);

  // Render
  render(gameMap, camera, localEntity, remotePlayers.values(), fog, onEntryTile, nearbyInfos);
  renderHud(hudInfo);
}

function generateName() {
  const adjectives = ['Swift', 'Dark', 'Pale', 'Lost', 'Wild', 'Grim', 'Cold', 'Deep'];
  const nouns = ['Rogue', 'Ghost', 'Shade', 'Wolf', 'Crow', 'Viper', 'Wraith', 'Fox'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}${noun}`;
}

document.fonts.ready.then(init);
