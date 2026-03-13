// Shared/isomorphic item module — used by both client and server

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const EQUIP_SLOTS = ['head', 'chest', 'legs', 'mainHand', 'offHand'];

export const CONTAINER_TILES = { 29: 'chest', 30: 'barrel', 31: 'crate' };
export const CONTAINER_CHARS = { '▣': 'chest', '◎': 'barrel', '▤': 'crate' };

let containerConfig = {
  chest:  { dropChance: 0.9, rolls: [1, 1] },
  barrel: { dropChance: 0.4, rolls: [1, 1] },
  crate:  { dropChance: 0.6, rolls: [1, 1] },
};

export function setContainerConfig(config) {
  containerConfig = config;
}

export function getContainerConfig() {
  return containerConfig;
}

// Rarity weights by depth bracket
let rarityWeights = [
  { maxDepth: 1, weights: [60, 30, 8, 2, 0] },
  { maxDepth: 3, weights: [40, 35, 18, 6, 1] },
  { maxDepth: 5, weights: [25, 30, 25, 15, 5] },
  { maxDepth: Infinity, weights: [15, 25, 30, 20, 10] },
];

export function setRarityWeights(weights) {
  rarityWeights = weights;
}

export function getRarityWeights() {
  return rarityWeights;
}

let registry = {};
let rarityIndex = null; // Map<rarity, itemDef[]>

function rebuildIndex() {
  rarityIndex = new Map();
  for (const r of RARITY_ORDER) rarityIndex.set(r, []);
  for (const def of Object.values(registry)) {
    const list = rarityIndex.get(def.rarity);
    if (list) list.push(def);
  }
}

export function loadItemRegistry(data) {
  registry = data;
  rebuildIndex();
}

export function getItemDef(id) {
  return registry[id] || null;
}

export function getAllItems() {
  return registry;
}

function getWeightsForDepth(depth) {
  for (const bracket of rarityWeights) {
    if (depth <= bracket.maxDepth) return bracket.weights;
  }
  return rarityWeights[rarityWeights.length - 1].weights;
}

function pickRarity(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return RARITY_ORDER[i];
  }
  return RARITY_ORDER[0];
}

export function createItemInstance(def) {
  return {
    id: def.id,
    name: def.name,
    char: def.char,
    sprite: def.sprite || null,
    rarity: def.rarity,
    type: def.type,
    slot: def.slot || null,
    armor: def.armor || 0,
    damage: def.damage || 0,
    attackRange: def.attackRange || 0,
    attackSpeed: def.attackSpeed || 0,
    twoHanded: def.twoHanded || false,
    effect: def.effect || null,
    stackable: def.stackable || false,
    count: 1,
    description: def.description || '',
    value: def.value || 0,
  };
}

export function generateContainerLoot(containerType, depth) {
  const cfg = containerConfig[containerType] || { dropChance: 1, rolls: [1, 1] };
  // Drop chance check — if failed, container is empty
  if (Math.random() > cfg.dropChance) return [];
  const rollRange = cfg.rolls || [1, 1];
  const numRolls = rollRange[0] + Math.floor(Math.random() * (rollRange[1] - rollRange[0] + 1));
  const weights = getWeightsForDepth(depth);
  const items = [];

  for (let i = 0; i < numRolls; i++) {
    let rarity = pickRarity(weights);

    // Try to find matching items, downgrade rarity if none found
    let candidates = null;
    for (let r = RARITY_ORDER.indexOf(rarity); r >= 0; r--) {
      const tryRarity = RARITY_ORDER[r];
      const list = rarityIndex ? rarityIndex.get(tryRarity) : null;
      candidates = list ? list.filter(d => d.minLayer <= depth) : [];
      if (candidates.length > 0) {
        rarity = tryRarity;
        break;
      }
    }

    if (!candidates || candidates.length === 0) continue;

    const def = candidates[Math.floor(Math.random() * candidates.length)];
    const instance = createItemInstance(def);

    // Try to stack with existing item
    if (instance.stackable) {
      const existing = items.find(it => it.id === instance.id && it.count < (def.maxStack || 1));
      if (existing) {
        existing.count = Math.min(existing.count + 1, def.maxStack || 1);
        continue;
      }
    }

    items.push(instance);
  }

  return items;
}
