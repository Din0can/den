import { GAME_WIDTH, GAME_HEIGHT, MOVE_COOLDOWN, PLAYER_COLORS, COLORS } from './config.js';
import { init as initCRT } from './crt-renderer.js';
import { GameMap } from './game-map.js';
import { Entity } from './entity.js';
import { Camera } from './camera.js';
import { initInput, getMovementDir } from './input.js';
import { initRenderer, render } from './game-renderer.js';
import { hudInfo, updateHUD } from './hud.js';
import * as network from './network.js';

// State
const gameMap = new GameMap();
const camera = new Camera();
let localEntity = null;
const remotePlayers = new Map(); // id -> Entity
let lastMoveTime = 0;
let playerName = '';
let colorIndex = 0;
let connected = false;

function init() {
  const gameCanvas = document.getElementById('game-canvas');
  gameCanvas.width = GAME_WIDTH;
  gameCanvas.height = GAME_HEIGHT;
  initRenderer(gameCanvas);
  initInput();

  // Ask for player name
  playerName = generateName();

  // Connect to server
  network.connect();

  network.onWelcome((data) => {
    connected = true;
    // Load map from server
    gameMap.load(data.map, data.mapWidth, data.mapHeight);

    // Create local player entity
    localEntity = new Entity(data.id, data.spawn.x, data.spawn.y, '@', COLORS.PLAYER_LOCAL, playerName);

    // Add existing players
    for (const p of data.players) {
      const color = PLAYER_COLORS[colorIndex++ % PLAYER_COLORS.length];
      remotePlayers.set(p.id, new Entity(p.id, p.x, p.y, '@', p.color || color, p.name || ''));
    }

    camera.follow(localEntity, gameMap.width, gameMap.height);
  });

  network.onPlayerJoined((data) => {
    const color = data.color || PLAYER_COLORS[colorIndex++ % PLAYER_COLORS.length];
    remotePlayers.set(data.id, new Entity(data.id, data.spawn.x, data.spawn.y, '@', color, data.name || ''));
  });

  network.onPlayerLeft((data) => {
    remotePlayers.delete(data.id);
  });

  network.onPlayerState((data) => {
    const ent = remotePlayers.get(data.id);
    if (ent) {
      ent.x = data.x;
      ent.y = data.y;
      if (data.color) ent.color = data.color;
      if (data.name) ent.name = data.name;
    }
  });

  // Start CRT renderer with game render callback
  initCRT(gameLoop);
}

function gameLoop(now) {
  if (!localEntity) return;

  // Movement with cooldown
  const dir = getMovementDir();
  if (dir && now - lastMoveTime >= MOVE_COOLDOWN) {
    const nx = localEntity.x + dir.dx;
    const ny = localEntity.y + dir.dy;
    if (gameMap.isPassable(nx, ny)) {
      localEntity.x = nx;
      localEntity.y = ny;
      lastMoveTime = now;
      network.sendState(localEntity.x, localEntity.y);
    }
  }

  // Update camera
  camera.follow(localEntity, gameMap.width, gameMap.height);

  // Update HUD
  updateHUD(playerName, localEntity.x, localEntity.y, remotePlayers.size + 1);

  // Render
  render(gameMap, camera, localEntity, [...remotePlayers.values()], hudInfo);
}

function generateName() {
  const adjectives = ['Swift', 'Dark', 'Pale', 'Lost', 'Wild', 'Grim', 'Cold', 'Deep'];
  const nouns = ['Rogue', 'Ghost', 'Shade', 'Wolf', 'Crow', 'Viper', 'Wraith', 'Fox'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}${noun}`;
}

// Wait for fonts to load, then init
document.fonts.ready.then(init);
