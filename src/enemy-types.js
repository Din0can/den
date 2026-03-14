// Shared enemy type definitions — used by client + server

export const MAX_ENEMIES_PER_LAYER = 30;

export const ENEMY_TYPES = {
  rat:    { char: 'r', color: '#8a6a4a', name: 'Rat',    hp: 10, damage: 2,  armor: 0, moveSpeed: 350, sightRange: 5, ownership: 'player', attackRange: 1, attackSpeed: 800,  incorporeal: false },
  spider: { char: 's', color: '#5a5a5a', name: 'Spider', hp: 20, damage: 5,  armor: 1, moveSpeed: 450, sightRange: 6, ownership: 'player', attackRange: 1, attackSpeed: 1000, incorporeal: false },
  shadow: { char: 'S', color: '#3a2a4a', name: 'Shadow', hp: 40, damage: 10, armor: 3, moveSpeed: 300, sightRange: 8, ownership: 'layer',  attackRange: 1, attackSpeed: 1200, incorporeal: true  },
  horror: { char: 'H', color: '#4a1a1a', name: 'Horror', hp: 80, damage: 20, armor: 5, moveSpeed: 250, sightRange: 10, ownership: 'layer', attackRange: 1, attackSpeed: 1500, incorporeal: true  },
};

// Sanity brackets: as sanity drops, more enemies spawn
export const SANITY_BRACKETS = [
  { min: 80, max: 100, maxEnemies: 0, types: [],                                  spawnInterval: Infinity },
  { min: 60, max: 79,  maxEnemies: 2, types: ['rat'],                             spawnInterval: 15000 },
  { min: 40, max: 59,  maxEnemies: 3, types: ['rat', 'spider'],                   spawnInterval: 10000 },
  { min: 20, max: 39,  maxEnemies: 4, types: ['rat', 'spider', 'shadow'],         spawnInterval: 8000 },
  { min: 0,  max: 19,  maxEnemies: 6, types: ['rat', 'spider', 'shadow', 'horror'], spawnInterval: 5000 },
];

/**
 * Get the sanity bracket for a given sanity value
 */
export function getSanityBracket(sanity) {
  for (const bracket of SANITY_BRACKETS) {
    if (sanity >= bracket.min && sanity <= bracket.max) return bracket;
  }
  return SANITY_BRACKETS[SANITY_BRACKETS.length - 1]; // fallback to worst
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
