// Server-side enemy lifecycle — spawn, AI state machine, movement, despawn

import { ENEMY_TYPES, getSanityBracket } from './src/enemy-types.js';
import { findPath, hasLineOfSight, getRandomWalkable } from './src/pathfinding.js';
import { TILE_META } from './src/config.js';

let nextEnemyId = 1;

// AI timing constants
const ALERT_DURATION = 800;      // ms to show "!" before chasing
const CHASE_LOST_TIMEOUT = 4000; // ms before giving up chase after losing LOS
const SEARCH_DURATION = 6000;    // ms to search around last known position
const RETURN_PROXIMITY = 3;      // tiles from spawn to consider "returned"
const CHASE_REPATH_INTERVAL = 3; // re-pathfind every N moves
const CHASE_SPEED_MULT = 1.5;    // speed multiplier during chase
const SPAWN_MIN_DIST = 12;       // minimum distance from player to spawn
const WANDER_RADIUS = 8;         // tile radius for wander target selection
const SEARCH_RADIUS = 5;         // tile radius for search wandering

function isPassableTile(tileId) {
  const meta = TILE_META[tileId];
  return meta ? meta.passable : false;
}

/**
 * Get the right getTile function based on enemy ownership and state.
 */
function getPassableFn(enemy, layer) {
  if (enemy.ownerType === 'player') {
    // Always use owner's composited view
    return (x, y) => layer.getCompositedTile(enemy.ownerId, x, y);
  }
  if (enemy.state === 'chase' || enemy.state === 'search') {
    // During chase/search: use target player's composited view
    if (enemy.targetId) {
      return (x, y) => layer.getCompositedTile(enemy.targetId, x, y);
    }
  }
  // Idle/wander: bone-only
  return (x, y) => layer.getTile(x, y);
}

/**
 * Get distance between two points (Manhattan)
 */
function dist(x1, y1, x2, y2) {
  return Math.abs(x2 - x1) + Math.abs(y2 - y1);
}

/**
 * Facing direction from (x1,y1) toward (x2,y2)
 */
function facingToward(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'east' : 'west';
  }
  return dy > 0 ? 'south' : 'north';
}

export class EnemyManager {
  constructor() {
    this.enemies = new Map();        // id -> EnemyInstance
    this.byLayer = new Map();        // layerId -> Set<id>
    this.byOwner = new Map();        // playerId -> Set<id>
    this.lastSpawnCheck = new Map();  // playerId -> timestamp
    this.layerSpawnCheck = new Map(); // layerId -> timestamp
  }

  /**
   * Main AI loop — called every 200ms from server.
   * @param {Map} players
   * @param {LayerManager} layerManager
   * @param {Server} io - main socket.io server
   * @param {number} now
   * @param {Namespace} [adminiNs] - admin namespace (optional)
   */
  tick(players, layerManager, io, now, adminiNs, { applyFlatDamage, getLayerBlood, dropBlood, splatter } = {}) {
    // Spawn checks for each player
    for (const [playerId, player] of players) {
      const layerId = layerManager.getPlayerLayerId(playerId);
      if (layerId === undefined) continue;
      const layer = layerManager.getLayer(layerId);
      if (!layer) continue;

      this._spawnCheck(player, playerId, layer, layerId, now);
    }

    // Tick each enemy
    for (const [enemyId, enemy] of this.enemies) {
      const layer = layerManager.getLayer(enemy.layerId);
      if (!layer) continue;
      this._tickEnemy(enemy, players, layer, layerManager, now, { applyFlatDamage, getLayerBlood, dropBlood, splatter, io });
    }

    // Broadcast updates (including combat events)
    this._broadcastUpdates(io, layerManager, players, adminiNs);
  }

  /**
   * Check if we should spawn enemies for a player based on sanity.
   */
  _spawnCheck(player, playerId, layer, layerId, now) {
    if (layer.type !== 'dynamic') return;

    const sanity = player.stats?.sanity ?? 100;
    const bracket = getSanityBracket(sanity);
    if (bracket.maxEnemies === 0) return;

    // Player-based enemies
    const lastCheck = this.lastSpawnCheck.get(playerId) || 0;
    if (now - lastCheck < bracket.spawnInterval) return;
    this.lastSpawnCheck.set(playerId, now);

    // Count player-based enemies for this player
    const ownerSet = this.byOwner.get(playerId);
    const playerEnemyCount = ownerSet ? ownerSet.size : 0;

    // Filter available types to player-based only
    const playerTypes = bracket.types.filter(t => ENEMY_TYPES[t].ownership === 'player');

    if (playerEnemyCount < bracket.maxEnemies && playerTypes.length > 0) {
      const type = playerTypes[Math.floor(Math.random() * playerTypes.length)];
      this._spawnEnemy(type, 'player', playerId, null, player, layer, layerId);
    }

    // Layer-based enemies (spawn from lowest-sanity player)
    const layerLastCheck = this.layerSpawnCheck.get(layerId) || 0;
    if (now - layerLastCheck < bracket.spawnInterval) return;

    // Find lowest sanity player on this layer
    let lowestSanity = 100;
    let lowestPlayer = null;
    let lowestPlayerId = null;
    for (const pid of layer.players) {
      const p = player.id === playerId ? player : null;
      // We need to check all players — but we only have the current one here.
      // This is called per-player, so just check if this player is the lowest.
      const ps = player.stats?.sanity ?? 100;
      if (ps < lowestSanity) {
        lowestSanity = ps;
        lowestPlayer = player;
        lowestPlayerId = playerId;
      }
    }

    if (lowestPlayerId !== playerId) return; // Only spawn layer enemies from lowest sanity player

    this.layerSpawnCheck.set(layerId, now);
    const layerBracket = getSanityBracket(lowestSanity);
    const layerTypes = layerBracket.types.filter(t => ENEMY_TYPES[t].ownership === 'layer');

    // Count layer-based enemies on this layer
    const layerSet = this.byLayer.get(layerId);
    let layerEnemyCount = 0;
    if (layerSet) {
      for (const eid of layerSet) {
        const e = this.enemies.get(eid);
        if (e && e.ownerType === 'layer') layerEnemyCount++;
      }
    }

    if (layerEnemyCount < layerBracket.maxEnemies && layerTypes.length > 0) {
      const type = layerTypes[Math.floor(Math.random() * layerTypes.length)];
      this._spawnEnemy(type, 'layer', null, null, lowestPlayer, layer, layerId);
    }
  }

  /**
   * Spawn a single enemy.
   */
  _spawnEnemy(typeName, ownerType, ownerId, targetId, playerRef, layer, layerId) {
    const typeDef = ENEMY_TYPES[typeName];
    if (!typeDef) return null;

    // Pick spawn position: room center >12 tiles from the owner/player
    const spawnPos = this._findSpawnPosition(ownerType, ownerId, playerRef, layer, layerId);
    if (!spawnPos) return null;

    const id = nextEnemyId++;
    const enemy = {
      id,
      type: typeName,
      char: typeDef.char,
      color: typeDef.color,
      name: typeDef.name,
      hp: typeDef.hp,
      maxHp: typeDef.hp,
      damage: typeDef.damage,
      armor: typeDef.armor,
      moveSpeed: typeDef.moveSpeed,
      sightRange: typeDef.sightRange,
      ownerType,           // 'player' or 'layer'
      ownerId: ownerId,    // playerId for player-based, null for layer-based
      targetId: null,      // current chase target
      layerId,
      x: spawnPos.x,
      y: spawnPos.y,
      spawnX: spawnPos.x,
      spawnY: spawnPos.y,
      facing: 'south',
      state: 'wander',     // wander | alert | chase | search | return
      stateTime: Date.now(),
      path: null,
      pathIndex: 0,
      movesSinceRepath: 0,
      lastMoveTime: 0,
      lastKnownX: 0,
      lastKnownY: 0,
      lostTimer: 0,
      visited: new Set(),   // exploration memory
      wanderTarget: null,
      // Combat fields
      attackRange: typeDef.attackRange || 1,
      attackSpeed: typeDef.attackSpeed || 1000,
      incorporeal: typeDef.incorporeal || false,
      lastAttackTime: 0,
      bleedStacks: 0,
      _combatEvents: [],
      // Change tracking for network
      _spawned: true,
      _moved: false,
      _stateChanged: false,
      _despawned: false,
    };

    this.enemies.set(id, enemy);

    // Track by layer
    if (!this.byLayer.has(layerId)) this.byLayer.set(layerId, new Set());
    this.byLayer.get(layerId).add(id);

    // Track by owner
    if (ownerType === 'player' && ownerId) {
      if (!this.byOwner.has(ownerId)) this.byOwner.set(ownerId, new Set());
      this.byOwner.get(ownerId).add(id);
    }

    return enemy;
  }

  /**
   * Find a valid spawn position for an enemy.
   */
  _findSpawnPosition(ownerType, ownerId, playerRef, layer, layerId) {
    const px = playerRef.x;
    const py = playerRef.y;

    // Collect candidate rooms
    let rooms = [];
    if (layer.type === 'dynamic') {
      // Bone rooms always available
      if (layer.boneRooms) rooms.push(...layer.boneRooms);
      // For player-based: also include wing rooms
      if (ownerType === 'player' && ownerId) {
        const pd = layer.playerDungeons.get(ownerId);
        if (pd && pd.rooms) rooms.push(...pd.rooms);
      }
    } else if (layer.type === 'static') {
      if (layer.rooms) rooms.push(...layer.rooms);
    }

    // Filter rooms by distance from player
    const candidates = [];
    for (const room of rooms) {
      const rcx = room.cx || Math.floor(room.x + room.w / 2);
      const rcy = room.cy || Math.floor(room.y + room.h / 2);
      if (dist(rcx, rcy, px, py) >= SPAWN_MIN_DIST) {
        candidates.push({ x: rcx, y: rcy });
      }
    }

    if (candidates.length === 0) return null;

    // Shuffle and try candidates
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    const getTile = ownerType === 'player' && ownerId
      ? (x, y) => layer.getCompositedTile(ownerId, x, y)
      : (x, y) => layer.getTile(x, y);

    for (const pos of candidates) {
      const tile = getTile(pos.x, pos.y);
      if (isPassableTile(tile)) {
        // Check not occupied by another enemy
        let occupied = false;
        for (const [, e] of this.enemies) {
          if (e.x === pos.x && e.y === pos.y && e.layerId === layerId) {
            occupied = true;
            break;
          }
        }
        if (!occupied) return pos;
      }
      // Try nearby tiles in the room
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = pos.x + dx;
          const ny = pos.y + dy;
          if (isPassableTile(getTile(nx, ny))) {
            let occupied = false;
            for (const [, e] of this.enemies) {
              if (e.x === nx && e.y === ny && e.layerId === layerId) {
                occupied = true;
                break;
              }
            }
            if (!occupied) return { x: nx, y: ny };
          }
        }
      }
    }

    return null;
  }

  /**
   * Per-enemy AI state update.
   */
  _tickEnemy(enemy, players, layer, layerManager, now, helpers) {
    let getTile = getPassableFn(enemy, layer);
    const layerPlayerIds = layer.players; // Set of player IDs on this layer

    // Determine which player(s) this enemy can detect
    const visiblePlayer = this._findVisiblePlayer(enemy, players, layer, layerManager);

    switch (enemy.state) {
      case 'wander':
        this._tickWander(enemy, getTile, visiblePlayer, now, players, layerPlayerIds);
        break;
      case 'alert':
        this._tickAlert(enemy, visiblePlayer, now);
        break;
      case 'chase':
        this._tickChase(enemy, layer, players, visiblePlayer, now, helpers, layerPlayerIds);
        break;
      case 'search':
        this._tickSearch(enemy, getTile, visiblePlayer, now, players, layerPlayerIds);
        break;
      case 'return':
        this._tickReturn(enemy, getTile, visiblePlayer, now, players, layerPlayerIds);
        break;
    }
  }

  /**
   * Find the closest visible player this enemy can target.
   */
  _findVisiblePlayer(enemy, players, layer, layerManager) {
    const getTile = getPassableFn(enemy, layer);
    let closest = null;
    let closestDist = Infinity;

    // For player-based enemies, only target owner
    if (enemy.ownerType === 'player') {
      const owner = players.get(enemy.ownerId);
      if (!owner) return null;
      const d = dist(enemy.x, enemy.y, owner.x, owner.y);
      if (d <= enemy.sightRange && hasLineOfSight(getTile, enemy.x, enemy.y, owner.x, owner.y)) {
        return { id: enemy.ownerId, x: owner.x, y: owner.y };
      }
      return null;
    }

    // For layer-based enemies: check all players on same layer
    for (const pid of layer.players) {
      const p = players.get(pid);
      if (!p) continue;
      const d = dist(enemy.x, enemy.y, p.x, p.y);
      if (d <= enemy.sightRange && d < closestDist) {
        // Always use the checked player's composited view for LOS —
        // this lets the enemy see into a player's wing tiles
        const losTile = (x, y) => layer.getCompositedTile(pid, x, y);
        if (hasLineOfSight(losTile, enemy.x, enemy.y, p.x, p.y)) {
          closest = { id: pid, x: p.x, y: p.y };
          closestDist = d;
        }
      }
    }

    return closest;
  }

  // --- Collision helper ---

  /**
   * Try to move an enemy to (nextX, nextY). All enemies are blocked by players.
   * Incorporeal enemies pass through other enemies; non-incorporeal are blocked.
   * @param {object} enemy
   * @param {number} nextX
   * @param {number} nextY
   * @param {Map} players - full players Map (id -> player)
   * @param {Set} [layerPlayerIds] - Set of player IDs on this enemy's layer
   * Returns true on success, false on block.
   */
  _tryMove(enemy, nextX, nextY, players, layerPlayerIds) {
    // ALL enemies are blocked by players (even incorporeal)
    if (layerPlayerIds) {
      for (const pid of layerPlayerIds) {
        const p = players.get(pid);
        if (p && p.x === nextX && p.y === nextY) {
          enemy.path = null;
          return false;
        }
      }
    } else {
      // Fallback: check all players
      for (const [, p] of players) {
        if (p.x === nextX && p.y === nextY) {
          enemy.path = null;
          return false;
        }
      }
    }
    // Only non-incorporeal enemies are blocked by other enemies
    if (!enemy.incorporeal) {
      const layerSet = this.byLayer.get(enemy.layerId);
      if (layerSet) {
        for (const eid of layerSet) {
          if (eid === enemy.id) continue;
          const e = this.enemies.get(eid);
          if (e && e.x === nextX && e.y === nextY) {
            enemy.path = null;
            return false;
          }
        }
      }
    }
    enemy.facing = facingToward(enemy.x, enemy.y, nextX, nextY);
    enemy.x = nextX;
    enemy.y = nextY;
    enemy._moved = true;
    return true;
  }

  // --- Kill enemy ---

  /**
   * Kill and remove an enemy immediately.
   */
  killEnemy(enemyId) {
    const enemy = this.enemies.get(enemyId);
    if (!enemy) return;
    enemy._despawned = true;
    const layerSet = this.byLayer.get(enemy.layerId);
    if (layerSet) layerSet.delete(enemyId);
    if (enemy.ownerType === 'player' && enemy.ownerId) {
      const ownerSet = this.byOwner.get(enemy.ownerId);
      if (ownerSet) ownerSet.delete(enemyId);
    }
    this.enemies.delete(enemyId);
  }

  // --- State handlers ---

  _tickWander(enemy, getTile, visiblePlayer, now, players, layerPlayerIds) {
    // Check for player detection
    if (visiblePlayer) {
      this._enterAlert(enemy, visiblePlayer, now);
      return;
    }

    // Move along wander path
    if (now - enemy.lastMoveTime < enemy.moveSpeed) return;

    // Need a new wander target?
    if (!enemy.path || enemy.pathIndex >= enemy.path.length) {
      const target = getRandomWalkable(getTile, enemy.x, enemy.y, WANDER_RADIUS, enemy.visited);
      if (!target) {
        // All nearby visited — reset memory
        enemy.visited.clear();
        return;
      }
      enemy.wanderTarget = target;
      enemy.path = findPath(getTile, enemy.x, enemy.y, target.x, target.y, 500);
      enemy.pathIndex = 1; // skip start position
      if (!enemy.path) return;
    }

    // Move to next tile
    const next = enemy.path[enemy.pathIndex];
    if (next) {
      if (this._tryMove(enemy, next.x, next.y, players, layerPlayerIds)) {
        enemy.visited.add(`${next.x},${next.y}`);
        enemy.pathIndex++;
        enemy.lastMoveTime = now;
      }
    }
  }

  _enterAlert(enemy, visiblePlayer, now) {
    enemy.state = 'alert';
    enemy.stateTime = now;
    enemy.targetId = visiblePlayer.id;
    enemy.lastKnownX = visiblePlayer.x;
    enemy.lastKnownY = visiblePlayer.y;
    enemy.facing = facingToward(enemy.x, enemy.y, visiblePlayer.x, visiblePlayer.y);
    enemy.visited.clear(); // Reset exploration memory
    enemy.path = null;
    enemy._stateChanged = true;
    enemy._moved = true; // facing changed
  }

  _tickAlert(enemy, visiblePlayer, now) {
    // Don't move during alert — just wait 800ms
    if (now - enemy.stateTime >= ALERT_DURATION) {
      enemy.state = 'chase';
      enemy.stateTime = now;
      enemy.lostTimer = 0;
      enemy.movesSinceRepath = CHASE_REPATH_INTERVAL; // force immediate pathfind
      enemy._stateChanged = true;

      // Update target position if still visible
      if (visiblePlayer) {
        enemy.lastKnownX = visiblePlayer.x;
        enemy.lastKnownY = visiblePlayer.y;
      }
    }
  }

  _tickChase(enemy, layer, players, visiblePlayer, now, helpers, layerPlayerIds) {
    const chaseSpeed = enemy.moveSpeed / CHASE_SPEED_MULT;

    if (visiblePlayer) {
      // Can see player — update last known, reset lost timer
      enemy.lastKnownX = visiblePlayer.x;
      enemy.lastKnownY = visiblePlayer.y;
      enemy.lostTimer = 0;

      // For layer-based: lock to this player's composited view
      if (enemy.ownerType === 'layer' && enemy.targetId !== visiblePlayer.id) {
        enemy.targetId = visiblePlayer.id;
      }
    } else {
      // Lost LOS
      if (enemy.lostTimer === 0) {
        enemy.lostTimer = now;
      } else if (now - enemy.lostTimer >= CHASE_LOST_TIMEOUT) {
        // Give up — transition to search
        enemy.state = 'search';
        enemy.stateTime = now;
        enemy.path = null;
        enemy._stateChanged = true;
        return;
      }
    }

    // Attack if in range
    if (visiblePlayer && helpers?.applyFlatDamage) {
      const targetPlayer = players.get(visiblePlayer.id);
      if (targetPlayer && targetPlayer.stats) {
        const d = dist(enemy.x, enemy.y, targetPlayer.x, targetPlayer.y);
        if (d <= enemy.attackRange && now - enemy.lastAttackTime >= enemy.attackSpeed) {
          // Pick random limb
          const limbs = targetPlayer.stats.limbs.filter(l => l.hp > 0);
          if (limbs.length > 0) {
            const limb = limbs[Math.floor(Math.random() * limbs.length)];
            const result = helpers.applyFlatDamage(targetPlayer.stats, limb.id, enemy.damage, targetPlayer.totalArmor);
            enemy.facing = facingToward(enemy.x, enemy.y, targetPlayer.x, targetPlayer.y);
            enemy.lastAttackTime = now;
            enemy._moved = true; // facing changed

            // Generate blood at player position
            const blood = helpers.getLayerBlood(enemy.layerId);
            const bloodUpdate = helpers.splatter(blood, targetPlayer.x, targetPlayer.y, 1);

            // Push combat event
            enemy._combatEvents.push({
              targetId: visiblePlayer.id,
              damage: Math.max(1, enemy.damage - targetPlayer.totalArmor),
              limbId: limb.id,
              limbName: limb.name,
              bleedAdded: result.bleedStacks > 0,
              stats: targetPlayer.stats,
              bloodUpdate,
            });

            return; // Attack replaces movement for this tick
          }
        }
      }
    }

    // Move toward target
    if (now - enemy.lastMoveTime < chaseSpeed) return;

    // Recompute getTile with updated targetId so A* uses the correct composited view
    const getTile = getPassableFn(enemy, layer);

    // Re-pathfind periodically or if we need a new path
    if (!enemy.path || enemy.pathIndex >= enemy.path.length || enemy.movesSinceRepath >= CHASE_REPATH_INTERVAL) {
      enemy.path = findPath(getTile, enemy.x, enemy.y, enemy.lastKnownX, enemy.lastKnownY, 1000);
      enemy.pathIndex = 1;
      enemy.movesSinceRepath = 0;
      if (!enemy.path) return;
    }

    const next = enemy.path[enemy.pathIndex];
    if (next) {
      if (this._tryMove(enemy, next.x, next.y, players, layerPlayerIds)) {
        enemy.pathIndex++;
        enemy.movesSinceRepath++;
        enemy.lastMoveTime = now;
      }
    }
  }

  _tickSearch(enemy, getTile, visiblePlayer, now, players, layerPlayerIds) {
    // Spotted player during search → alert
    if (visiblePlayer) {
      this._enterAlert(enemy, visiblePlayer, now);
      return;
    }

    // Search timeout → return
    if (now - enemy.stateTime >= SEARCH_DURATION) {
      enemy.state = 'return';
      enemy.stateTime = now;
      enemy.path = null;
      // Release target lock for layer-based enemies
      if (enemy.ownerType === 'layer') {
        enemy.targetId = null;
      }
      enemy._stateChanged = true;
      return;
    }

    // Move
    if (now - enemy.lastMoveTime < enemy.moveSpeed) return;

    // If no path, go to last known position or wander nearby
    if (!enemy.path || enemy.pathIndex >= enemy.path.length) {
      if (dist(enemy.x, enemy.y, enemy.lastKnownX, enemy.lastKnownY) > 1) {
        // Go to last known position first
        enemy.path = findPath(getTile, enemy.x, enemy.y, enemy.lastKnownX, enemy.lastKnownY, 500);
      } else {
        // Wander around the last known position
        const target = getRandomWalkable(getTile, enemy.lastKnownX, enemy.lastKnownY, SEARCH_RADIUS, new Set());
        if (target) {
          enemy.path = findPath(getTile, enemy.x, enemy.y, target.x, target.y, 500);
        }
      }
      enemy.pathIndex = 1;
      if (!enemy.path) return;
    }

    const next = enemy.path[enemy.pathIndex];
    if (next) {
      if (this._tryMove(enemy, next.x, next.y, players, layerPlayerIds)) {
        enemy.pathIndex++;
        enemy.lastMoveTime = now;
      }
    }
  }

  _tickReturn(enemy, getTile, visiblePlayer, now, players, layerPlayerIds) {
    // Spotted player during return → alert
    if (visiblePlayer) {
      this._enterAlert(enemy, visiblePlayer, now);
      return;
    }

    // Check if close enough to spawn
    if (dist(enemy.x, enemy.y, enemy.spawnX, enemy.spawnY) <= RETURN_PROXIMITY) {
      enemy.state = 'wander';
      enemy.stateTime = now;
      enemy.path = null;
      enemy.visited.clear();
      enemy._stateChanged = true;
      return;
    }

    // Move toward spawn
    if (now - enemy.lastMoveTime < enemy.moveSpeed) return;

    if (!enemy.path || enemy.pathIndex >= enemy.path.length) {
      enemy.path = findPath(getTile, enemy.x, enemy.y, enemy.spawnX, enemy.spawnY, 1000);
      enemy.pathIndex = 1;
      if (!enemy.path) {
        // Can't reach spawn — just wander
        enemy.state = 'wander';
        enemy.stateTime = now;
        enemy.path = null;
        enemy._stateChanged = true;
        return;
      }
    }

    const next = enemy.path[enemy.pathIndex];
    if (next) {
      if (this._tryMove(enemy, next.x, next.y, players, layerPlayerIds)) {
        enemy.pathIndex++;
        enemy.lastMoveTime = now;
      }
    }
  }

  /**
   * Despawn all enemies owned by a player (player disconnect or layer change).
   */
  despawnForPlayer(playerId) {
    const ownerSet = this.byOwner.get(playerId);
    if (!ownerSet) return;

    for (const eid of ownerSet) {
      const enemy = this.enemies.get(eid);
      if (enemy) {
        enemy._despawned = true;
        // Remove from layer tracking
        const layerSet = this.byLayer.get(enemy.layerId);
        if (layerSet) layerSet.delete(eid);
      }
      this.enemies.delete(eid);
    }
    this.byOwner.delete(playerId);
    this.lastSpawnCheck.delete(playerId);
  }

  /**
   * Despawn all enemies on a layer.
   */
  despawnForLayer(layerId) {
    const layerSet = this.byLayer.get(layerId);
    if (!layerSet) return;

    for (const eid of layerSet) {
      const enemy = this.enemies.get(eid);
      if (enemy) {
        enemy._despawned = true;
        if (enemy.ownerType === 'player' && enemy.ownerId) {
          const ownerSet = this.byOwner.get(enemy.ownerId);
          if (ownerSet) ownerSet.delete(eid);
        }
      }
      this.enemies.delete(eid);
    }
    this.byLayer.delete(layerId);
    this.layerSpawnCheck.delete(layerId);
  }

  /**
   * Get all enemies on a layer (for snapshot on player join).
   */
  getEnemiesOnLayer(layerId) {
    const result = [];
    const layerSet = this.byLayer.get(layerId);
    if (!layerSet) return result;

    for (const eid of layerSet) {
      const e = this.enemies.get(eid);
      if (e) result.push(e);
    }
    return result;
  }

  /**
   * Broadcast batched enemy updates to clients.
   */
  _broadcastUpdates(io, layerManager, players, adminiNs) {
    // Group updates by layer and by specific player (for player-based enemies)
    const layerUpdates = new Map();  // layerId -> { spawned, moved, stateChanged, despawned }
    const playerUpdates = new Map(); // playerId -> { spawned, moved, stateChanged, despawned }
    // Also track ALL updates per layer for admini (both player-based and layer-based)
    const adminLayerUpdates = new Map(); // layerId -> { spawned, moved, stateChanged, despawned }

    for (const [eid, enemy] of this.enemies) {
      if (!enemy._spawned && !enemy._moved && !enemy._stateChanged && !enemy._despawned) continue;

      const serialized = this._serializeEnemy(enemy);

      if (enemy.ownerType === 'player') {
        // Player-based: only send to owner
        if (!playerUpdates.has(enemy.ownerId)) {
          playerUpdates.set(enemy.ownerId, { spawned: [], moved: [], stateChanged: [], despawned: [] });
        }
        const update = playerUpdates.get(enemy.ownerId);
        this._addToUpdate(update, enemy, serialized);
      } else {
        // Layer-based: send to all on layer
        if (!layerUpdates.has(enemy.layerId)) {
          layerUpdates.set(enemy.layerId, { spawned: [], moved: [], stateChanged: [], despawned: [] });
        }
        const update = layerUpdates.get(enemy.layerId);
        this._addToUpdate(update, enemy, serialized);
      }

      // Admin: aggregate ALL enemy updates per layer
      if (adminiNs) {
        if (!adminLayerUpdates.has(enemy.layerId)) {
          adminLayerUpdates.set(enemy.layerId, { spawned: [], moved: [], stateChanged: [], despawned: [] });
        }
        this._addToUpdate(adminLayerUpdates.get(enemy.layerId), enemy, serialized);
      }

      // Emit combat events per-player
      if (enemy._combatEvents.length > 0) {
        for (const evt of enemy._combatEvents) {
          const sock = io.sockets.sockets.get(evt.targetId);
          if (sock) {
            sock.emit('combatHit', {
              enemyId: enemy.id,
              damage: evt.damage,
              limbId: evt.limbId,
              limbName: evt.limbName,
              bleedAdded: evt.bleedAdded,
              stats: evt.stats,
            });
            // Send blood to entire layer
            const playerLayerId = enemy.layerId;
            io.to(`layer:${playerLayerId}`).emit('bloodUpdate', { updates: [evt.bloodUpdate] });
          }
        }
        enemy._combatEvents = [];
      }

      // Reset change flags
      enemy._spawned = false;
      enemy._moved = false;
      enemy._stateChanged = false;
      enemy._despawned = false;
    }

    // Send layer-based updates
    for (const [layerId, update] of layerUpdates) {
      if (update.spawned.length || update.moved.length || update.stateChanged.length || update.despawned.length) {
        io.to(`layer:${layerId}`).emit('enemyUpdate', update);
      }
    }

    // Send player-based updates
    for (const [playerId, update] of playerUpdates) {
      if (update.spawned.length || update.moved.length || update.stateChanged.length || update.despawned.length) {
        const sock = io.sockets.sockets.get(playerId);
        if (sock) sock.emit('enemyUpdate', update);
      }
    }

    // Send admin updates (all enemies on layer, regardless of ownership)
    if (adminiNs) {
      for (const [layerId, update] of adminLayerUpdates) {
        if (update.spawned.length || update.moved.length || update.stateChanged.length || update.despawned.length) {
          adminiNs.to(`admin:layer:${layerId}`).emit('adminEnemyUpdate', update);
        }
      }
    }
  }

  _addToUpdate(update, enemy, serialized) {
    if (enemy._despawned) {
      update.despawned.push(enemy.id);
    } else if (enemy._spawned) {
      update.spawned.push(serialized);
    } else {
      if (enemy._moved) {
        update.moved.push({ id: enemy.id, x: enemy.x, y: enemy.y, facing: enemy.facing });
      }
      if (enemy._stateChanged) {
        update.stateChanged.push({ id: enemy.id, state: enemy.state });
      }
    }
  }

  _serializeEnemy(enemy) {
    return {
      id: enemy.id,
      type: enemy.type,
      x: enemy.x,
      y: enemy.y,
      facing: enemy.facing,
      hp: enemy.hp,
      maxHp: enemy.maxHp,
      char: enemy.char,
      color: enemy.color,
      name: enemy.name,
      state: enemy.state,
      attackRange: enemy.attackRange,
      attackSpeed: enemy.attackSpeed,
      incorporeal: enemy.incorporeal,
    };
  }

  /**
   * Get snapshot of all enemies visible to a player (for welcome event).
   */
  getSnapshotForPlayer(playerId, layerId) {
    const result = [];
    // Layer-based enemies on same layer
    const layerSet = this.byLayer.get(layerId);
    if (layerSet) {
      for (const eid of layerSet) {
        const e = this.enemies.get(eid);
        if (e && e.ownerType === 'layer') {
          result.push(this._serializeEnemy(e));
        }
      }
    }
    // Player-based enemies owned by this player
    const ownerSet = this.byOwner.get(playerId);
    if (ownerSet) {
      for (const eid of ownerSet) {
        const e = this.enemies.get(eid);
        if (e) result.push(this._serializeEnemy(e));
      }
    }
    return result;
  }
}
