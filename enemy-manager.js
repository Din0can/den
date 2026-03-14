// Server-side enemy lifecycle — spawn, AI state machine, movement, despawn

import { ENEMY_TYPES, getSanityBracket, getTypesForDepth, MAX_ENEMIES_PER_LAYER } from './src/enemy-types.js';
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
const FLEE_DURATION = 5000;      // ms to flee before despawning (cowardly)
const RETREAT_DURATION = 2000;   // ms to pause after retreating (hitAndRun)
const RETREAT_DIST = 5;          // tiles to retreat before pausing
const STALK_DIST = 8;            // min distance stalkers keep from target
const AMBUSH_ALONE_RANGE = 8;    // no allies within this range = "alone"
const HORROR_SANITY_RANGE = 5;   // tiles within which horror drains sanity
const HORROR_SANITY_DRAIN = 2;   // sanity per tick when near horror
const COWARDLY_FLEE_THRESHOLD = 0.4; // HP ratio to trigger flee

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
  if (enemy.state === 'chase' || enemy.state === 'search' || enemy.state === 'flee' || enemy.state === 'retreat' || enemy.state === 'stalk') {
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
    this.posIndex = new Map();       // "layerId:x:y" -> enemyId
  }

  _posKey(layerId, x, y) { return `${layerId}:${x}:${y}`; }
  _posSet(layerId, x, y, enemyId) { this.posIndex.set(this._posKey(layerId, x, y), enemyId); }
  _posClear(layerId, x, y) { this.posIndex.delete(this._posKey(layerId, x, y)); }
  _posHasEnemy(layerId, x, y, excludeId) {
    const eid = this.posIndex.get(this._posKey(layerId, x, y));
    return eid !== undefined && eid !== excludeId;
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

      this._spawnCheck(player, playerId, layer, layerId, now, players);
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
  _spawnCheck(player, playerId, layer, layerId, now, players) {
    if (layer.type !== 'dynamic') return;

    const sanity = player.stats?.sanity ?? 100;
    const bracket = getSanityBracket(sanity);
    if (bracket.maxEnemies === 0) return;

    // Global per-layer cap
    const layerCapSet = this.byLayer.get(layerId);
    if (layerCapSet && layerCapSet.size >= MAX_ENEMIES_PER_LAYER) return;

    // Player-based enemies
    const lastCheck = this.lastSpawnCheck.get(playerId) || 0;
    if (now - lastCheck < bracket.spawnInterval) return;
    this.lastSpawnCheck.set(playerId, now);

    // Count player-based enemies for this player
    const ownerSet = this.byOwner.get(playerId);
    const playerEnemyCount = ownerSet ? ownerSet.size : 0;

    // Filter available types by depth and ownership
    const depthTypes = getTypesForDepth(bracket.types, layerId);
    const playerTypes = depthTypes.filter(t => ENEMY_TYPES[t].ownership === 'player');

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
      const p = players.get(pid);
      if (!p) continue;
      const ps = p.stats?.sanity ?? 100;
      if (ps < lowestSanity) {
        lowestSanity = ps;
        lowestPlayer = p;
        lowestPlayerId = pid;
      }
    }

    if (lowestPlayerId !== playerId) return; // Only spawn layer enemies from lowest sanity player

    this.layerSpawnCheck.set(layerId, now);
    const layerBracket = getSanityBracket(lowestSanity);
    const layerDepthTypes = getTypesForDepth(layerBracket.types, layerId);
    const layerTypes = layerDepthTypes.filter(t => ENEMY_TYPES[t].ownership === 'layer');

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
      behavior: typeDef.behavior || 'default',
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
    this._posSet(layerId, spawnPos.x, spawnPos.y, id);

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
        if (!this._posHasEnemy(layerId, pos.x, pos.y)) return pos;
      }
      // Try nearby tiles in the room
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = pos.x + dx;
          const ny = pos.y + dy;
          if (isPassableTile(getTile(nx, ny))) {
            if (!this._posHasEnemy(layerId, nx, ny)) return { x: nx, y: ny };
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
      case 'flee':
        this._tickFlee(enemy, getTile, now, players, layerPlayerIds);
        break;
      case 'retreat':
        this._tickRetreat(enemy, getTile, visiblePlayer, now, players, layerPlayerIds);
        break;
      case 'stalk':
        this._tickStalk(enemy, layer, players, visiblePlayer, now, layerPlayerIds);
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
      if (this._posHasEnemy(enemy.layerId, nextX, nextY, enemy.id)) {
        enemy.path = null;
        return false;
      }
    }
    enemy.facing = facingToward(enemy.x, enemy.y, nextX, nextY);
    this._posClear(enemy.layerId, enemy.x, enemy.y);
    enemy.x = nextX;
    enemy.y = nextY;
    this._posSet(enemy.layerId, nextX, nextY, enemy.id);
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
    this._posClear(enemy.layerId, enemy.x, enemy.y);
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
    // Ambush enemies stalk instead of alerting
    if (enemy.behavior === 'ambush') {
      enemy.state = 'stalk';
      enemy.stateTime = now;
      enemy.targetId = visiblePlayer.id;
      enemy.lastKnownX = visiblePlayer.x;
      enemy.lastKnownY = visiblePlayer.y;
      enemy.path = null;
      enemy._stateChanged = true;
      return;
    }

    enemy.state = 'alert';
    enemy.stateTime = now;
    enemy.targetId = visiblePlayer.id;
    enemy.lastKnownX = visiblePlayer.x;
    enemy.lastKnownY = visiblePlayer.y;
    enemy.facing = facingToward(enemy.x, enemy.y, visiblePlayer.x, visiblePlayer.y);
    enemy.visited.clear();
    enemy.path = null;
    enemy._stateChanged = true;
    enemy._moved = true;
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
      if (enemy.behavior === 'relentless') {
        // Relentless enemies never give up - keep chasing last known position
        enemy.lostTimer = 0;
      } else if (enemy.lostTimer === 0) {
        enemy.lostTimer = now;
      } else if (now - enemy.lostTimer >= (enemy.behavior === 'patrol' ? 1500 : CHASE_LOST_TIMEOUT)) {
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
              killed: result.killed,
              stats: targetPlayer.stats,
              bloodUpdate,
            });

            // Thorns: reflect damage back to enemy
            for (const eff of (targetPlayer.equipEffects || [])) {
              if (eff.thorns) {
                enemy.hp -= eff.thorns;
                enemy._moved = true;
              }
            }

            // Behavior: hitAndRun - retreat after attacking
            if (enemy.behavior === 'hitAndRun') {
              enemy.state = 'retreat';
              enemy.stateTime = now;
              enemy.path = null;
              enemy._stateChanged = true;
            }

            // Behavior: cowardly - flee if HP low (from thorns or just check)
            if (enemy.behavior === 'cowardly' && enemy.hp <= enemy.maxHp * COWARDLY_FLEE_THRESHOLD) {
              enemy.state = 'flee';
              enemy.stateTime = now;
              enemy.path = null;
              enemy._stateChanged = true;
            }

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

  // --- Behavioral state handlers ---

  _tickFlee(enemy, getTile, now, players, layerPlayerIds) {
    // Cowardly enemies run away then despawn
    if (now - enemy.stateTime >= FLEE_DURATION) {
      this.killEnemy(enemy.id);
      return;
    }

    if (now - enemy.lastMoveTime < enemy.moveSpeed) return;

    // Run away from target
    if (!enemy.path || enemy.pathIndex >= enemy.path.length) {
      const target = getRandomWalkable(getTile, enemy.x, enemy.y, WANDER_RADIUS, new Set());
      if (target) {
        enemy.path = findPath(getTile, enemy.x, enemy.y, target.x, target.y, 300);
        enemy.pathIndex = 1;
      }
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

  _tickRetreat(enemy, getTile, visiblePlayer, now, players, layerPlayerIds) {
    // Hit-and-run: move away from target, then pause, then re-engage
    if (now - enemy.stateTime >= RETREAT_DURATION) {
      // Re-engage: go back to chase if player visible, else search
      if (visiblePlayer) {
        enemy.state = 'chase';
        enemy.stateTime = now;
        enemy.lostTimer = 0;
        enemy.movesSinceRepath = 999;
        enemy.lastKnownX = visiblePlayer.x;
        enemy.lastKnownY = visiblePlayer.y;
      } else {
        enemy.state = 'search';
        enemy.stateTime = now;
      }
      enemy.path = null;
      enemy._stateChanged = true;
      return;
    }

    // Move away from last known player position
    if (now - enemy.lastMoveTime < enemy.moveSpeed) return;

    if (!enemy.path || enemy.pathIndex >= enemy.path.length) {
      // Pick a point away from player
      const dx = enemy.x - enemy.lastKnownX;
      const dy = enemy.y - enemy.lastKnownY;
      const len = Math.max(1, Math.abs(dx) + Math.abs(dy));
      const tx = enemy.x + Math.round((dx / len) * RETREAT_DIST);
      const ty = enemy.y + Math.round((dy / len) * RETREAT_DIST);
      enemy.path = findPath(getTile, enemy.x, enemy.y, tx, ty, 300);
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

  _tickStalk(enemy, layer, players, visiblePlayer, now, layerPlayerIds) {
    // Ambush enemies follow at distance, attack when target is alone or low sanity
    if (!visiblePlayer) {
      // Lost sight - go to search
      enemy.state = 'search';
      enemy.stateTime = now;
      enemy.path = null;
      enemy._stateChanged = true;
      return;
    }

    enemy.lastKnownX = visiblePlayer.x;
    enemy.lastKnownY = visiblePlayer.y;
    enemy.targetId = visiblePlayer.id;

    const d = dist(enemy.x, enemy.y, visiblePlayer.x, visiblePlayer.y);
    const targetPlayer = players.get(visiblePlayer.id);

    // Check if target is "alone" (no other players nearby)
    let targetAlone = true;
    if (targetPlayer) {
      for (const pid of layer.players) {
        if (pid === visiblePlayer.id) continue;
        const p = players.get(pid);
        if (p && dist(visiblePlayer.x, visiblePlayer.y, p.x, p.y) <= AMBUSH_ALONE_RANGE) {
          targetAlone = false;
          break;
        }
      }
    }

    const lowSanity = targetPlayer && (targetPlayer.stats?.sanity ?? 100) < 40;

    // Attack condition: target alone OR low sanity
    if (targetAlone || lowSanity) {
      enemy.state = 'alert';
      enemy.stateTime = now;
      enemy.facing = facingToward(enemy.x, enemy.y, visiblePlayer.x, visiblePlayer.y);
      enemy.path = null;
      enemy._stateChanged = true;
      enemy._moved = true;
      return;
    }

    // Otherwise keep distance - follow at STALK_DIST
    if (now - enemy.lastMoveTime < enemy.moveSpeed) return;

    if (d < STALK_DIST) {
      // Too close - move away slightly
      if (!enemy.path || enemy.pathIndex >= enemy.path.length) {
        const getTile = getPassableFn(enemy, layer);
        const dx = enemy.x - visiblePlayer.x;
        const dy = enemy.y - visiblePlayer.y;
        const len = Math.max(1, Math.abs(dx) + Math.abs(dy));
        const tx = enemy.x + Math.round((dx / len) * 3);
        const ty = enemy.y + Math.round((dy / len) * 3);
        enemy.path = findPath(getTile, enemy.x, enemy.y, tx, ty, 200);
        enemy.pathIndex = 1;
      }
    } else if (d > STALK_DIST + 3) {
      // Too far - close in
      if (!enemy.path || enemy.pathIndex >= enemy.path.length) {
        const getTile = getPassableFn(enemy, layer);
        enemy.path = findPath(getTile, enemy.x, enemy.y, visiblePlayer.x, visiblePlayer.y, 500);
        enemy.pathIndex = 1;
      }
    } else {
      return; // Good distance, hold position
    }

    if (enemy.path && enemy.pathIndex < enemy.path.length) {
      const next = enemy.path[enemy.pathIndex];
      if (next && this._tryMove(enemy, next.x, next.y, players, layerPlayerIds)) {
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
        this._posClear(enemy.layerId, enemy.x, enemy.y);
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
        this._posClear(enemy.layerId, enemy.x, enemy.y);
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
        // Broadcast remote combat hit for layer-based enemies
        if (enemy.ownerType === 'layer') {
          for (const evt of enemy._combatEvents) {
            const targetP = players.get(evt.targetId);
            const targetSock = io.sockets.sockets.get(evt.targetId);
            if (targetP && targetSock) {
              targetSock.to(`layer:${enemy.layerId}`).emit('remoteCombatHit', {
                targetId: evt.targetId,
                targetX: targetP.x,
                targetY: targetP.y,
                enemyId: enemy.id,
                damage: evt.damage,
              });
            }
          }
        }
        // Check for player deaths from this enemy's attacks
        for (const evt of enemy._combatEvents) {
          if (evt.killed && helpers?.handlePlayerDeath) {
            helpers.handlePlayerDeath(evt.targetId);
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
