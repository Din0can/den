import { MOVE_COOLDOWN, COLORS, FOV_RADIUS, FOV_GRACE_RADIUS, TILE } from './config.js';
import { getSpeedMultiplier } from './stats.js';
import { CHUNK_VIEW_DIST, chunkKey, worldToChunk } from './chunk.js';
import { init as initCRT, resize as resizeCRT, resizeTexture } from './crt-renderer.js';
import { GameMap } from './game-map.js';
import { Entity } from './entity.js';
import { Camera } from './camera.js';
import { initInput, initHotbarInput, getMovementDir, consumeInteract, consumeDrop, initShopInput, destroyShopInput } from './input.js';
import { initHotbar, getState as getHotbarState, setAllSlots, setEquipment, setEquipAnim, getEquipAnim, enterShopMode, exitShopMode, updateShopData, getShopState, selectSlot, selectEquipSlot } from './hotbar.js';
import { getSlotCenter, getEquipSlotCenter, renderShopOverlay, SHOP_CANVAS_H, hitTestSlot, hitTestEquipSlot } from './hotbar-renderer.js';
import { initMobileControls, initHudTouch } from './mobile.js';
import { initRenderer, render } from './game-renderer.js';
import { initHudRenderer, resizeHud, renderHud } from './hud-renderer.js';
import { hudInfo, updateHUD } from './hud.js';
import { calculateFOV } from './fov.js';
import { viewport, recalcViewport } from './viewport.js';
import { Fog } from './fog.js';
import { CONTAINER_TILES, CONTAINER_CHARS } from './items.js';
import { initSpriteCache } from './sprites.js';
import * as network from './network.js';
import { initMenu, hideMenu, showMenu, showMenuError, setSessionToken, clearSessionToken, showRegisterPrompt, hideRegisterPrompt, showRegisterPromptError, showDeathOverlay } from './menu.js';

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
const enemies = new Map(); // id -> { id, type, x, y, facing, hp, maxHp, char, color, name, state, stateTime }
let lastMoveTime = 0;
let playerName = '';
let connected = false;
let isGuest = false;
let fovDirty = true;
let currentLayerId = null;
let layerEntryUp = null;
let layerEntryDown = null;
let onEntryTile = false;
let localStats = null;
let gameCanvas;
let hudCanvas;
let shopCanvas;
let shopCtx;

// Container result message
let containerMsg = null;
let containerMsgTime = 0;

// Combat visual effects
const combatEffects = []; // { type, entityType, entityId, startTime, duration, text, color, x, y, dx, dy }

// Containers the local player has already opened (cleared on layer change)
const openedContainers = new Set();

// Cached HUD dimensions (avoid DOM read on every inventory update)
let cachedHudW = 0;
let cachedHudH = 0;

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
  cachedHudW = window.innerWidth;
  cachedHudH = viewport.hudHeight;
  // Resize shop overlay canvas
  if (shopCanvas) {
    const dpr = window.devicePixelRatio || 1;
    shopCanvas.style.bottom = viewport.hudHeight + 'px';
    shopCanvas.style.width = window.innerWidth + 'px';
    shopCanvas.width = window.innerWidth * dpr;
    shopCanvas.height = SHOP_CANVAS_H * dpr;
    shopCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    shopCtx.imageSmoothingEnabled = false;
  }
  fovDirty = true;
}

let resizeTimer;
function debouncedResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(handleResize, 100);
}

function loadLayer(meta, initialChunks) {
  openedContainers.clear();
  currentLayerId = meta.id;
  layerEntryUp = meta.entryUp || null;
  layerEntryDown = meta.entryDown || null;
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

function syncInventory(data) {
  if (data.inventory) setAllSlots(data.inventory);
  if (data.slots) setAllSlots(data.slots);
  if (data.equipment) setEquipment(data.equipment);
}

/** Check if a tile or overlay at a position is a container */
function isContainerAt(x, y) {
  const tile = gameMap.getTile(x, y);
  if (CONTAINER_TILES[tile]) return true;
  // Check overlay chars
  const overlay = gameMap.getOverlay(x, y);
  if (overlay && CONTAINER_CHARS[overlay.char]) return true;
  return false;
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
  cachedHudW = window.innerWidth;
  cachedHudH = viewport.hudHeight;
  // Create shop overlay canvas
  const dpr = window.devicePixelRatio || 1;
  shopCanvas = document.createElement('canvas');
  shopCanvas.id = 'shop-canvas';
  shopCanvas.style.cssText = `position:fixed; bottom:${viewport.hudHeight}px; left:0; width:${window.innerWidth}px; height:${SHOP_CANVAS_H}px; display:none; z-index:10; pointer-events:auto;`;
  shopCanvas.width = window.innerWidth * dpr;
  shopCanvas.height = SHOP_CANVAS_H * dpr;
  document.body.appendChild(shopCanvas);
  shopCtx = shopCanvas.getContext('2d');
  shopCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  shopCtx.imageSmoothingEnabled = false;

  initSpriteCache();
  initInput();
  initHotbar();
  initHotbarInput(hudCanvas);
  initMobileControls();
  initHudTouch(hudCanvas, hitTestSlot, hitTestEquipSlot, selectSlot, selectEquipSlot, getHotbarState);
  window.addEventListener('resize', debouncedResize);

  // Set up network event handlers before connecting
  setupNetworkHandlers();

  // Initialize menu — it will call network.connect() with auth data
  initMenu((authData) => {
    network.connect(authData);
  });

  initCRT(gameLoop);
}

function setupNetworkHandlers() {
  network.onWelcome((data) => {
    connected = true;
    hideMenu();
    playerName = data.name || '';
    isGuest = !!data.guest;
    if (data.sessionToken) setSessionToken(data.sessionToken);

    loadLayer(data.layerMeta, data.initialChunks);
    if (data.stats) localStats = data.stats;
    if (data.blood) gameMap.loadBlood(data.blood);
    if (data.floorItems) gameMap.loadFloorItems(data.floorItems);
    syncInventory(data);

    const color = data.color || COLORS.PLAYER_LOCAL;
    localEntity = new Entity(data.id, data.spawn.x, data.spawn.y, '@', color, playerName, data.facing || 'south');

    remotePlayers.clear();
    for (const p of data.players) {
      const ent = new Entity(p.id, p.x, p.y, '@', p.color || '#888888', p.name || '', p.facing || 'south');
      ent.lightRadius = p.lightRadius || 0;
      remotePlayers.set(p.id, ent);
    }

    enemies.clear();
    if (data.enemies) {
      for (const e of data.enemies) {
        enemies.set(e.id, { ...e, stateTime: performance.now() });
      }
    }

    const bounds = gameMap.getLoadedBounds();
    camera.follow(localEntity, bounds);
    checkChunkBoundary();
    fovDirty = true;
  });

  network.onAuthFailed((data) => {
    clearSessionToken();
    showMenu();
    showMenuError(data.error || 'Authentication failed');
  });

  network.onPromptRegister(() => {
    const guestColor = localEntity?.color || null;
    showRegisterPrompt(
      (username, password, color) => {
        network.sendRegisterFromGame(username, password, color);
      },
      () => { /* dismissed */ },
      guestColor
    );
  });

  network.onRegisterResult((data) => {
    if (data.success) {
      hideRegisterPrompt();
      setSessionToken(data.sessionToken);
      playerName = data.username;
      isGuest = false;
      if (localEntity) {
        localEntity.name = playerName;
        localEntity.color = data.color || localEntity.color;
      }
    } else {
      showRegisterPromptError(data.error || 'Registration failed');
    }
  });

  network.onPlayerDied((data) => {
    const msg = isGuest ? 'no save. restarting fresh.' : 'returning to last save...';
    showDeathOverlay(msg);
    // Server will send layerData to transition us — handled by onLayerData
  });

  network.onDisconnect((reason) => {
    connected = false;
    localEntity = null;
    // If kicked while playing (e.g. logged in elsewhere), show menu
    // Don't show menu if we're already on it (auth failure case)
    const menuVisible = !document.getElementById('menu-overlay').classList.contains('hidden');
    if (reason === 'io server disconnect' && !menuVisible) {
      showMenu();
    }
  });

  network.onConnectError(() => {
    showMenu();
    showMenuError('Connection failed. Try again.');
  });

  network.onPlayerJoined((data) => {
    const ent = new Entity(data.id, data.spawn.x, data.spawn.y, '@', data.color || '#888888', data.name || '', data.facing || 'south');
    ent.lightRadius = data.lightRadius || 0;
    remotePlayers.set(data.id, ent);
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
      if (data.lightRadius !== undefined) ent.lightRadius = data.lightRadius;
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
    if (data.floorItems) gameMap.loadFloorItems(data.floorItems);
    syncInventory(data);
    remotePlayers.clear();
    if (data.players) {
      for (const p of data.players) {
        const ent = new Entity(p.id, p.x, p.y, '@', p.color || '#888888', p.name || '', p.facing || 'south');
        ent.lightRadius = p.lightRadius || 0;
        remotePlayers.set(p.id, ent);
      }
    }
    // Load enemy snapshot for new layer
    enemies.clear();
    if (data.enemies) {
      for (const e of data.enemies) {
        enemies.set(e.id, { ...e, stateTime: performance.now() });
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

  network.onInventoryUpdate((data) => {
    const oldState = getHotbarState();
    const oldEquip = { ...oldState.equipment };
    const oldSlots = [...oldState.slots];
    syncInventory(data);

    // Trigger equip animation if equipment changed
    const newState = getHotbarState();
    const w = cachedHudW;
    const h = cachedHudH;
    for (const key of ['head', 'chest', 'legs', 'mainHand', 'offHand']) {
      if (!oldEquip[key] && newState.equipment[key]) {
        // Item appeared in equipment — animate from hotbar
        // Find which hotbar slot lost an item (first null that was non-null)
        let fromSlot = newState.selectedIndex >= 0 ? newState.selectedIndex : 0;
        const from = getSlotCenter(fromSlot, w, h);
        const to = getEquipSlotCenter(key, w, h);
        if (from && to) {
          setEquipAnim({
            item: newState.equipment[key],
            fromX: from.x, fromY: from.y,
            toX: to.x, toY: to.y,
            startTime: performance.now(),
            duration: 200,
          });
        }
        break;
      }
    }

    // Trigger unequip animation (item left equipment → went to hotbar)
    if (!getEquipAnim()) {
      for (const key of ['head', 'chest', 'legs', 'mainHand', 'offHand']) {
        if (oldEquip[key] && !newState.equipment[key]) {
          let toSlot = 0;
          for (let i = 0; i < 8; i++) {
            if (!oldSlots[i] && newState.slots[i]) { toSlot = i; break; }
          }
          const from = getEquipSlotCenter(key, w, h);
          const to = getSlotCenter(toSlot, w, h);
          if (from && to) {
            setEquipAnim({
              item: oldEquip[key],
              fromX: from.x, fromY: from.y,
              toX: to.x, toY: to.y,
              startTime: performance.now(),
              duration: 200,
            });
          }
          break;
        }
      }
    }

    // Re-check FOV if equipment with lightRadius changed
    for (const key of ['head', 'chest', 'legs', 'mainHand', 'offHand']) {
      const oldEff = oldEquip[key]?.effect?.lightRadius;
      const newEff = newState.equipment[key]?.effect?.lightRadius;
      if (oldEff !== newEff) { fovDirty = true; break; }
    }
  });

  network.onContainerResult((data) => {
    if (data.x !== undefined && data.y !== undefined) {
      openedContainers.add(`${data.x},${data.y}`);
    }
    if (data.message) {
      containerMsg = data.message;
      containerMsgTime = performance.now();
    }
  });

  network.onShopData((data) => {
    updateShopData(data);
    if (!getShopState().shopMode) {
      enterShopMode(data);
      shopCanvas.style.display = 'block';
      initShopInput(shopCanvas);
    }
  });

  network.onShopResult((data) => {
    if (data.gold !== undefined && localStats) {
      localStats.gold = data.gold;
    }
  });

  network.onEnemyUpdate((data) => {
    if (data.spawned) {
      for (const e of data.spawned) {
        enemies.set(e.id, { ...e, stateTime: performance.now() });
      }
    }
    if (data.moved) {
      for (const m of data.moved) {
        const e = enemies.get(m.id);
        if (e) {
          e.x = m.x;
          e.y = m.y;
          e.facing = m.facing;
        }
      }
    }
    if (data.stateChanged) {
      for (const s of data.stateChanged) {
        const e = enemies.get(s.id);
        if (e) {
          e.state = s.state;
          e.stateTime = performance.now();
        }
      }
    }
    if (data.despawned) {
      for (const id of data.despawned) {
        enemies.delete(id);
      }
    }
  });

  // --- Combat event handlers ---

  network.onCombatHit((data) => {
    // Enemy struck the player
    if (data.stats) localStats = data.stats;
    const enemy = enemies.get(data.enemyId);
    const now = performance.now();

    if (enemy && localEntity) {
      // Wiggle effect on attacking enemy (toward player)
      combatEffects.push({
        type: 'wiggle', entityType: 'enemy', entityId: data.enemyId,
        startTime: now, duration: 200,
        dx: localEntity.x - enemy.x, dy: localEntity.y - enemy.y,
      });
      // Red blink on player
      combatEffects.push({
        type: 'blink', entityType: 'player', entityId: null,
        startTime: now, duration: 200,
      });
    }

    // Floating damage text above player
    if (localEntity) {
      combatEffects.push({
        type: 'floatText', entityType: 'player', entityId: null,
        startTime: now, duration: 1500,
        text: `-${data.damage}`, color: '#ff4444',
        x: localEntity.x, y: localEntity.y,
      });
      if (data.bleedAdded) {
        combatEffects.push({
          type: 'floatText', entityType: 'player', entityId: null,
          startTime: now, duration: 1500,
          text: 'Bleed!', color: '#aa2222',
          x: localEntity.x, y: localEntity.y,
        });
      }
    }
  });

  network.onPlayerAttack((data) => {
    const enemy = enemies.get(data.enemyId);
    const now = performance.now();

    if (enemy) {
      // Wiggle effect on local player (toward enemy)
      combatEffects.push({
        type: 'wiggle', entityType: 'player', entityId: null,
        startTime: now, duration: 200,
        dx: enemy.x - (localEntity?.x || 0), dy: enemy.y - (localEntity?.y || 0),
      });
      // Red blink on target enemy
      combatEffects.push({
        type: 'blink', entityType: 'enemy', entityId: data.enemyId,
        startTime: now, duration: 200,
      });
      // Floating damage text above enemy
      combatEffects.push({
        type: 'floatText', entityType: 'enemy', entityId: data.enemyId,
        startTime: now, duration: 1500,
        text: `-${data.damage}`, color: '#ffcc44',
        x: enemy.x, y: enemy.y,
      });
      // Update enemy HP locally
      enemy.hp = data.enemyHp;
      enemy.maxHp = data.enemyMaxHp;
    }
  });

  network.onEnemyDied((data) => {
    const enemy = enemies.get(data.enemyId);
    const now = performance.now();
    const x = enemy ? enemy.x : data.x;
    const y = enemy ? enemy.y : data.y;
    combatEffects.push({
      type: 'floatText', entityType: 'enemy', entityId: data.enemyId,
      startTime: now, duration: 1500,
      text: 'Killed!', color: '#ff8844',
      x, y,
    });
    enemies.delete(data.enemyId);
  });

  network.onEnemyHpUpdate((data) => {
    const enemy = enemies.get(data.id);
    if (enemy) {
      enemy.hp = data.hp;
      enemy.maxHp = data.maxHp;
      enemy.bleedStacks = data.bleedStacks;
    }
  });

  // --- Remote combat event handlers (other players' combat visible to us) ---

  network.onRemoteAttack((data) => {
    const enemy = enemies.get(data.enemyId);
    const now = performance.now();
    if (enemy) {
      // Red blink on enemy
      combatEffects.push({
        type: 'blink', entityType: 'enemy', entityId: data.enemyId,
        startTime: now, duration: 200,
      });
      // Floating damage text above enemy (yellow)
      combatEffects.push({
        type: 'floatText', entityType: 'enemy', entityId: data.enemyId,
        startTime: now, duration: 1500,
        text: `-${data.damage}`, color: '#ffcc44',
        x: enemy.x, y: enemy.y,
      });
      // Update enemy HP locally
      enemy.hp = data.enemyHp;
      enemy.maxHp = data.enemyMaxHp;
    }
  });

  network.onRemoteCombatHit((data) => {
    const enemy = enemies.get(data.enemyId);
    const now = performance.now();
    if (enemy) {
      // Wiggle effect on enemy (toward remote player position)
      combatEffects.push({
        type: 'wiggle', entityType: 'enemy', entityId: data.enemyId,
        startTime: now, duration: 200,
        dx: data.targetX - enemy.x, dy: data.targetY - enemy.y,
      });
    }
    // Float damage text at remote player position (red)
    combatEffects.push({
      type: 'floatText', entityType: 'world', entityId: null,
      startTime: now, duration: 1500,
      text: `-${data.damage}`, color: '#ff4444',
      x: data.targetX, y: data.targetY,
    });
  });

  network.onFloorItemAdded((data) => {
    gameMap.setFloorItem(data.x, data.y, data.item);
  });

  network.onFloorItemRemoved((data) => {
    gameMap.removeFloorItem(data.x, data.y);
  });

}

function buildHintLine2(item) {
  return item.description || '';
}

function gameLoop(now) {
  if (!localEntity) return;

  // Movement with cooldown (slowed by low health and bleed)
  const dir = getMovementDir();
  const shopActive = getShopState().shopMode;
  let speedMult = 1;
  const eqState = getHotbarState();
  for (const key of ['head', 'chest', 'legs', 'mainHand', 'offHand']) {
    const eq = eqState.equipment[key];
    if (eq?.effect?.speedBoost) speedMult *= eq.effect.speedBoost;
  }
  const moveCooldown = localStats ? MOVE_COOLDOWN / getSpeedMultiplier(localStats) / speedMult : MOVE_COOLDOWN;
  if (dir && !shopActive && now - lastMoveTime >= moveCooldown) {
    const newFacing = dirToFacing(dir.dx, dir.dy);
    const facingChanged = localEntity.facing !== newFacing;
    localEntity.facing = newFacing;

    const nx = localEntity.x + dir.dx;
    const ny = localEntity.y + dir.dy;
    // Check enemy collision (all enemies block player movement)
    let enemyBlocking = false;
    for (const [, enemy] of enemies) {
      if (enemy.x === nx && enemy.y === ny) {
        enemyBlocking = true;
        break;
      }
    }
    if (gameMap.isPassable(nx, ny) && !enemyBlocking) {
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

  // Clear equip animation when done
  const anim = getEquipAnim();
  if (anim && now - anim.startTime >= anim.duration) {
    setEquipAnim(null);
  }

  // Interact (E key) — priority: shop mode > pickup > entry > world interactions > unequip > equip/use > door
  if (consumeInteract()) {
    const hotbar = getHotbarState();
    const shopState = getShopState();

    if (shopState.shopMode) {
      // Shop mode interactions (top priority when shop is open)
      if (shopState.shopBrowsing === 'shop' && shopState.shopData) {
        const item = shopState.shopData.inventory[shopState.shopSelectedIndex];
        if (item && item.stock !== 0) {
          network.sendBuyFromShop(shopState.shopData.shopId, shopState.shopSelectedIndex);
        }
      } else if (shopState.shopBrowsing === 'player') {
        if (hotbar.selectedIndex >= 0) {
          network.sendSellToShop(shopState.shopData.shopId, hotbar.selectedIndex);
        } else if (hotbar.selectedEquipSlot) {
          network.sendSellEquipped(shopState.shopData.shopId, hotbar.selectedEquipSlot);
        }
      }
    } else if (gameMap.getFloorItem(localEntity.x, localEntity.y)) {
      // Pick up floor item (world interaction - high priority)
      network.sendPickupItem();
    } else if (onEntryTile) {
      // Enter/exit (world interaction)
      network.sendEnterExit();
    } else {
      const offset = FACING_OFFSET[localEntity.facing];
      const tx = localEntity.x + offset.dx;
      const ty = localEntity.y + offset.dy;

      const shopAtFacing = gameMap.getShopAt(tx, ty);
      if (shopAtFacing) {
        network.sendOpenShop(shopAtFacing.id);
      } else if (isContainerAt(tx, ty) && !openedContainers.has(`${tx},${ty}`)) {
        network.sendOpenContainer(tx, ty);
      } else if (hotbar.selectedEquipSlot && hotbar.equipment[hotbar.selectedEquipSlot]) {
        // Unequip (only after all world interactions checked)
        network.sendUnequipItem(hotbar.selectedEquipSlot);
      } else if (hotbar.selectedIndex >= 0 && hotbar.slots[hotbar.selectedIndex] && hotbar.slots[hotbar.selectedIndex].slot) {
        network.sendEquipItem(hotbar.selectedIndex);
      } else if (hotbar.selectedIndex >= 0 && hotbar.slots[hotbar.selectedIndex] && hotbar.slots[hotbar.selectedIndex].type === 'consumable') {
        network.sendUseItem(hotbar.selectedIndex);
      } else {
        // Door logic (lowest priority world interaction)
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
  }

  // Drop item (X key)
  if (consumeDrop()) {
    const dropHotbar = getHotbarState();
    const dropShopActive = getShopState().shopMode;
    if (!dropShopActive) {
      if (gameMap.getFloorItem(localEntity.x, localEntity.y)) {
        containerMsg = "Can't drop here!";
        containerMsgTime = performance.now();
      } else if (dropHotbar.selectedEquipSlot && dropHotbar.equipment[dropHotbar.selectedEquipSlot]) {
        network.sendDropItem(dropHotbar.selectedEquipSlot, true);
        selectSlot(0); // reset selection to hotbar after dropping equipment
      } else if (dropHotbar.selectedIndex >= 0 && dropHotbar.slots[dropHotbar.selectedIndex]) {
        network.sendDropItem(dropHotbar.selectedIndex, false);
      }
    }
  }

  // FOV
  if (fovDirty) {
    let fovBonus = 0;
    const fovHotbar = getHotbarState();
    for (const key of ['head', 'chest', 'legs', 'mainHand', 'offHand']) {
      const eq = fovHotbar.equipment[key];
      if (eq?.effect?.lightRadius) fovBonus += eq.effect.lightRadius;
    }
    localEntity.lightRadius = fovBonus;
    calculateFOV(gameMap, localEntity.x, localEntity.y, FOV_RADIUS + fovBonus, FOV_GRACE_RADIUS);
    fog.updateFade(gameMap);
    fovDirty = false;
  }

  // Camera
  const bounds = gameMap.getLoadedBounds();
  camera.follow(localEntity, bounds);

  // HUD
  updateHUD(playerName, localEntity.x, localEntity.y, remotePlayers.size + 1, currentLayerId, localStats, getHotbarState());

  // Compute equip/use hint for HUD
  const hotbarForHint = getHotbarState();
  let equipHint = null;
  if (hotbarForHint.selectedEquipSlot && hotbarForHint.equipment[hotbarForHint.selectedEquipSlot]) {
    const eqItem = hotbarForHint.equipment[hotbarForHint.selectedEquipSlot];
    const line2 = buildHintLine2(eqItem);
    equipHint = { line1: `${eqItem.name} | Unequip (E) | Drop (X)`, line2 };
  } else if (hotbarForHint.selectedIndex >= 0) {
    const item = hotbarForHint.slots[hotbarForHint.selectedIndex];
    if (item) {
      let line1;
      if (item.slot) line1 = `${item.name} | Equip (E) | Drop (X)`;
      else if (item.type === 'consumable') line1 = `${item.name} | Use (E) | Drop (X)`;
      else line1 = `${item.name} | Drop (X)`;
      const line2 = buildHintLine2(item);
      equipHint = { line1, line2 };
    }
  }
  hudInfo.equipHint = equipHint;
  hudInfo.shopState = getShopState();

  // Detect floor item at player position (for "Pick up (E)" prompt)
  const standingOnFloorItem = !!gameMap.getFloorItem(localEntity.x, localEntity.y);

  // Detect container in facing direction (for "Loot (E)" prompt)
  // Only show if E wouldn't be consumed by equip/unequip or entry
  let facingContainer = false;
  if (!onEntryTile && !standingOnFloorItem) {
    const offset = FACING_OFFSET[localEntity.facing];
    const tx = localEntity.x + offset.dx;
    const ty = localEntity.y + offset.dy;
    facingContainer = isContainerAt(tx, ty) && !openedContainers.has(`${tx},${ty}`);
  }

  // Detect shop in facing direction (for "Shop (E)" prompt)
  let facingShop = false;
  if (!onEntryTile && !shopActive) {
    const offset = FACING_OFFSET[localEntity.facing];
    const tx = localEntity.x + offset.dx;
    const ty = localEntity.y + offset.dy;
    facingShop = !!gameMap.getShopAt(tx, ty);
  }

  // Container result floating message
  let containerFloatMsg = null;
  if (containerMsg && performance.now() - containerMsgTime < 2000) {
    containerFloatMsg = containerMsg;
  } else if (containerMsg) {
    containerMsg = null;
  }

  // Gather nearby info hologram text
  const nearbyInfos = gameMap.getInfoNear(localEntity.x, localEntity.y, 1);

  // Render shop overlay on dedicated canvas
  if (shopActive) {
    renderShopOverlay(shopCtx, getShopState(), getHotbarState(), window.innerWidth, SHOP_CANVAS_H);
  } else if (shopCanvas.style.display !== 'none') {
    // Shop just closed — hide canvas and clean up input
    shopCanvas.style.display = 'none';
    destroyShopInput();
  }

  // Cleanup expired combat effects
  for (let i = combatEffects.length - 1; i >= 0; i--) {
    if (now - combatEffects[i].startTime >= combatEffects[i].duration) {
      combatEffects.splice(i, 1);
    }
  }

  // Check if player has a map in inventory
  const hasMap = hotbarForHint.slots.some(s => s?.effect?.minimap);

  // Render
  render(gameMap, camera, localEntity, remotePlayers.values(), fog, onEntryTile, nearbyInfos, facingContainer, containerFloatMsg, facingShop, enemies, combatEffects, standingOnFloorItem, hasMap, layerEntryDown);
  renderHud(hudInfo);
}

document.fonts.ready.then(init);
