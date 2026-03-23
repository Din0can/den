// Shared enemy type definitions - used by client + server

export const MAX_ENEMIES_PER_LAYER = 30;

export const ENEMY_TYPES = {
  rat:      { char: 'r', color: '#8a6a4a', name: 'Rat',      hp: 10,  damage: 2,  armor: 0, moveSpeed: 350, sightRange: 5,  ownership: 'player', attackRange: 1, attackSpeed: 800,  incorporeal: false, behavior: 'cowardly',   minLayer: 1, sprite: 'entity_rat' },
  spider:   { char: 's', color: '#5a5a5a', name: 'Spider',   hp: 20,  damage: 5,  armor: 1, moveSpeed: 450, sightRange: 6,  ownership: 'player', attackRange: 1, attackSpeed: 1000, incorporeal: false, behavior: 'default',    minLayer: 1, sprite: 'entity_spider' },
  crawler:  { char: 'c', color: '#6a5a3a', name: 'Crawler',  hp: 30,  damage: 4,  armor: 3, moveSpeed: 500, sightRange: 5,  ownership: 'player', attackRange: 1, attackSpeed: 1200, incorporeal: false, behavior: 'patrol',     minLayer: 2, sprite: 'entity_crawler' },
  stalker:  { char: 'K', color: '#2a3a2a', name: 'Stalker',  hp: 35,  damage: 8,  armor: 2, moveSpeed: 300, sightRange: 10, ownership: 'layer',  attackRange: 1, attackSpeed: 900,  incorporeal: false, behavior: 'ambush',     minLayer: 4, sprite: 'entity_stalker' },
  shadow:   { char: 'S', color: '#3a2a4a', name: 'Shadow',   hp: 40,  damage: 10, armor: 3, moveSpeed: 300, sightRange: 8,  ownership: 'layer',  attackRange: 1, attackSpeed: 1200, incorporeal: true,  behavior: 'hitAndRun',  minLayer: 5, sprite: 'entity_shadow' },
  wraith:   { char: 'W', color: '#4a4a6a', name: 'Wraith',   hp: 25,  damage: 12, armor: 0, moveSpeed: 250, sightRange: 8,  ownership: 'layer',  attackRange: 1, attackSpeed: 700,  incorporeal: true,  behavior: 'hitAndRun',  minLayer: 6, sprite: 'entity_wraith' },
  horror:   { char: 'H', color: '#4a1a1a', name: 'Horror',   hp: 80,  damage: 20, armor: 5, moveSpeed: 250, sightRange: 10, ownership: 'layer',  attackRange: 1, attackSpeed: 1500, incorporeal: true,  behavior: 'relentless', minLayer: 8, sprite: 'entity_horror' },
  devourer: { char: 'D', color: '#5a1a2a', name: 'Devourer', hp: 120, damage: 15, armor: 6, moveSpeed: 400, sightRange: 12, ownership: 'layer',  attackRange: 1, attackSpeed: 1400, incorporeal: false, behavior: 'relentless', minLayer: 8, sprite: 'entity_devourer' },
};

// All enemy type IDs for bracket reference
const ALL_TYPES = ['rat', 'spider', 'crawler', 'stalker', 'shadow', 'wraith', 'horror', 'devourer'];

// Sanity brackets: as sanity drops, more enemies spawn with shifting type weights
// Actual types filtered by minLayer at spawn time; weights control probability
export const SANITY_BRACKETS = [
  { min: 96, max: 100, maxEnemies: 0, types: [],        weights: {},                                                                                                          spawnInterval: Infinity },
  { min: 80, max: 95,  maxEnemies: 5, types: ALL_TYPES, weights: { rat: 20, spider: 1 },                                                                                     spawnInterval: 25000 },
  { min: 60, max: 79,  maxEnemies: 6, types: ALL_TYPES, weights: { rat: 12, spider: 6, crawler: 3 },                                                                         spawnInterval: 20000 },
  { min: 40, max: 59,  maxEnemies: 30, types: ALL_TYPES, weights: { rat: 5, spider: 7, crawler: 6, stalker: 5, shadow: 4, wraith: 3 },                                       spawnInterval: 15000 },
  { min: 20, max: 39,  maxEnemies: 30, types: ALL_TYPES, weights: { rat: 2, spider: 4, crawler: 4, stalker: 7, shadow: 8, wraith: 6, horror: 4, devourer: 3 },               spawnInterval: 12000 },
  { min: 0,  max: 19,  maxEnemies: 30, types: ALL_TYPES, weights: { rat: 1, spider: 2, crawler: 2, stalker: 5, shadow: 7, wraith: 7, horror: 10, devourer: 8 },              spawnInterval: 8000 },
];

/**
 * Get the sanity bracket for a given sanity value
 */
export function getSanityBracket(sanity) {
  for (const bracket of SANITY_BRACKETS) {
    if (sanity >= bracket.min && sanity <= bracket.max) return bracket;
  }
  return SANITY_BRACKETS[SANITY_BRACKETS.length - 1];
}

/**
 * Get available types for a depth, filtered by minLayer
 */
export function getTypesForDepth(bracketTypes, depth) {
  return bracketTypes.filter(t => {
    const def = ENEMY_TYPES[t];
    return def && def.minLayer <= depth;
  });
}

/**
 * Update a single enemy type's stats at runtime.
 */
export function updateEnemyType(id, changes) {
  if (!ENEMY_TYPES[id]) return false;
  Object.assign(ENEMY_TYPES[id], changes);
  return true;
}

/**
 * Get a plain copy of all enemy types (for serialization).
 */
export function getEnemyTypes() {
  return JSON.parse(JSON.stringify(ENEMY_TYPES));
}

/**
 * Bulk-load enemy types (from persisted JSON on startup).
 */
export function loadEnemyTypes(data) {
  for (const [id, props] of Object.entries(data)) {
    if (ENEMY_TYPES[id]) {
      Object.assign(ENEMY_TYPES[id], props);
    }
  }
}
