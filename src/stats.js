// Shared stats module — used by both client and server

export const LIMB_STATUS = {
  HEALTHY: 'healthy',
  DAMAGED: 'damaged',
  CRIPPLED: 'crippled',
  SEVERED: 'severed',
};

export const HUMANOID_LIMBS = [
  { id: 'head',  name: 'Head',      hpPercent: 15, vital: true,  movementPercent: 0  },
  { id: 'torso', name: 'Torso',     hpPercent: 41, vital: true,  movementPercent: 0  },
  { id: 'arm_l', name: 'Left Arm',  hpPercent: 10, vital: false, movementPercent: 0  },
  { id: 'arm_r', name: 'Right Arm', hpPercent: 10, vital: false, movementPercent: 0  },
  { id: 'leg_l', name: 'Left Leg',  hpPercent: 12, vital: false, movementPercent: 50 },
  { id: 'leg_r', name: 'Right Leg', hpPercent: 12, vital: false, movementPercent: 50 },
];

export function createPlayerStats(maxHp = 100) {
  const limbs = HUMANOID_LIMBS.map(def => ({
    id: def.id,
    name: def.name,
    maxHp: Math.round(def.hpPercent / 100 * maxHp),
    hp: Math.round(def.hpPercent / 100 * maxHp),
    vital: def.vital,
    movementPercent: def.movementPercent,
  }));
  return {
    limbs,
    sanity: 100,
    maxSanity: 100,
    bleedStacks: 0,
  };
}

export function getLimbStatus(limb) {
  if (limb.hp <= 0) return LIMB_STATUS.SEVERED;
  const ratio = limb.hp / limb.maxHp;
  if (ratio > 0.5) return LIMB_STATUS.HEALTHY;
  if (ratio > 0.25) return LIMB_STATUS.DAMAGED;
  return LIMB_STATUS.CRIPPLED;
}

export function getCurrentHp(stats) {
  let total = 0;
  for (const limb of stats.limbs) total += limb.hp;
  return Math.floor(total);
}

export function getMaxHp(stats) {
  let total = 0;
  for (const limb of stats.limbs) total += limb.maxHp;
  return total;
}

export function getSpeedMultiplier(stats) {
  const cur = getCurrentHp(stats);
  const max = getMaxHp(stats);
  const healthPct = max > 0 ? cur / max : 0;
  const healthFactor = healthPct >= 0.9 ? 1.0 : healthPct / 0.9;
  const bleedFactor = Math.max(0, 1 - stats.bleedStacks * 0.1);
  return Math.max(0.1, healthFactor * bleedFactor);
}

export function applyDamageToLimb(stats, limbId, amount) {
  const limb = stats.limbs.find(l => l.id === limbId);
  if (!limb) return { damage: 0, severed: false, killed: false };
  const actual = Math.min(limb.hp, amount);
  limb.hp = Math.max(0, limb.hp - amount);
  const severed = limb.hp <= 0;
  const killed = severed && limb.vital;
  return { damage: actual, severed, killed };
}

export function applyFlatDamage(stats, limbId, amount) {
  const result = applyDamageToLimb(stats, limbId, amount);
  stats.bleedStacks += Math.floor(amount / 5);
  return { ...result, bleedStacks: stats.bleedStacks };
}

export function tickBleed(stats) {
  if (stats.bleedStacks <= 0) return { totalDamage: 0, killed: false };
  const alive = stats.limbs.filter(l => l.hp > 0);
  if (alive.length === 0) return { totalDamage: 0, killed: false };
  const totalDmg = stats.bleedStacks * 0.2;
  const perLimb = totalDmg / alive.length;
  let totalDamage = 0;
  let killed = false;
  for (const limb of alive) {
    limb.hp -= perLimb;
    totalDamage += perLimb;
    if (limb.hp <= 0 && limb.vital) killed = true;
  }
  return { totalDamage, killed };
}
