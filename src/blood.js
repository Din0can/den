// Shared blood utilities — stateless functions operating on a Map<packedKey, bitmask>

export function packCoord(x, y) {
  return (x << 16) | (y & 0xFFFF);
}

export function addBlood(bloodMap, x, y, quadrants) {
  const key = packCoord(x, y);
  const existing = bloodMap.get(key) || 0;
  bloodMap.set(key, existing | quadrants);
}

export function getBlood(bloodMap, x, y) {
  return bloodMap.get(packCoord(x, y)) || 0;
}

export function dropBlood(bloodMap, x, y) {
  // Single random quadrant for movement trails
  const q = 1 << (Math.floor(Math.random() * 4));
  addBlood(bloodMap, x, y, q);
  return { x, y, quadrants: q };
}

export function splatter(bloodMap, x, y, severity = 1) {
  let q = 0;
  if (severity >= 2) {
    // Full tile
    q = 0b1111;
  } else {
    // 2-3 random quadrants
    const count = 2 + Math.floor(Math.random() * 2);
    const indices = [0, 1, 2, 3];
    // Fisher-Yates partial shuffle
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    for (let i = 0; i < count; i++) {
      q |= (1 << indices[i]);
    }
  }
  addBlood(bloodMap, x, y, q);
  return { x, y, quadrants: q };
}
