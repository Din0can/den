export const RARITY = {
  COMMON:    { name: 'common',    color: '#888888' },
  UNCOMMON:  { name: 'uncommon',  color: '#5a8a5a' },
  RARE:      { name: 'rare',      color: '#4a7a9a' },
  EPIC:      { name: 'epic',      color: '#7a5a8a' },
  LEGENDARY: { name: 'legendary', color: '#9a7a3a' },
};

const RARITY_MAP = {};
for (const r of Object.values(RARITY)) {
  RARITY_MAP[r.name] = r;
}

// Item shape: { id, name, char, rarity, stackable, count, type, slot, armor, damage, twoHanded, effect }

const state = {
  slots: Array(8).fill(null),
  selectedIndex: 0,
  selectedEquipSlot: null,  // null or 'head'/'chest'/'legs'/'mainHand'/'offHand'
  equipment: { head: null, chest: null, legs: null, mainHand: null, offHand: null },
  drag: null,  // { fromIndex, item, mouseX, mouseY }
  equipAnim: null, // { item, fromX, fromY, toX, toY, startTime, duration }
  shopMode: false,
  shopData: null,
  shopSelectedIndex: 0,
  shopBrowsing: 'shop',  // 'shop' or 'player'
};

function mapRarity(item) {
  if (!item) return null;
  if (item.rarity && typeof item.rarity === 'string') {
    item.rarity = RARITY_MAP[item.rarity] || RARITY.COMMON;
  }
  return item;
}

export function initHotbar() {
  state.slots.fill(null);
  state.selectedIndex = 0;
  state.selectedEquipSlot = null;
  state.equipment = { head: null, chest: null, legs: null, mainHand: null, offHand: null };
  state.drag = null;
  state.equipAnim = null;
  state.shopMode = false;
  state.shopData = null;
  state.shopSelectedIndex = 0;
  state.shopBrowsing = 'shop';
}

export function selectSlot(i) {
  if (i >= 0 && i < 8) {
    state.selectedIndex = i;
    state.selectedEquipSlot = null;
  }
}

export function selectEquipSlot(name) {
  const valid = ['head', 'chest', 'legs', 'mainHand', 'offHand'];
  if (valid.includes(name)) {
    state.selectedEquipSlot = name;
    state.selectedIndex = -1;
  }
}

export function cycleSlot(delta) {
  // Build ordered list: hotbar 0-7, then occupied equip slots
  const positions = [];
  for (let i = 0; i < 8; i++) positions.push({ type: 'hotbar', index: i });
  for (const key of ['head', 'chest', 'legs', 'mainHand', 'offHand']) {
    if (state.equipment[key]) positions.push({ type: 'equip', key });
  }

  // Find current position in list
  let current = 0;
  if (state.selectedEquipSlot) {
    current = positions.findIndex(p => p.type === 'equip' && p.key === state.selectedEquipSlot);
    if (current < 0) current = 0;
  } else {
    current = state.selectedIndex;
  }

  // Cycle with wrapping
  const next = ((current + delta) % positions.length + positions.length) % positions.length;
  const pos = positions[next];
  if (pos.type === 'equip') {
    state.selectedEquipSlot = pos.key;
    state.selectedIndex = -1;
  } else {
    state.selectedEquipSlot = null;
    state.selectedIndex = pos.index;
  }
}

export function setSlotItem(i, item) {
  if (i >= 0 && i < 8) state.slots[i] = item;
}

export function clearSlot(i) {
  if (i >= 0 && i < 8) state.slots[i] = null;
}

export function swapSlots(a, b) {
  if (a < 0 || a >= 8 || b < 0 || b >= 8) return;
  const tmp = state.slots[a];
  state.slots[a] = state.slots[b];
  state.slots[b] = tmp;
}

export function startDrag(i, mx, my) {
  if (i < 0 || i >= 8 || !state.slots[i]) return;
  state.drag = { fromIndex: i, item: state.slots[i], mouseX: mx, mouseY: my };
}

export function updateDrag(mx, my) {
  if (state.drag) {
    state.drag.mouseX = mx;
    state.drag.mouseY = my;
  }
}

export function endDrag(targetIndex) {
  if (!state.drag) return null;
  const fromIndex = state.drag.fromIndex;
  state.drag = null;
  if (targetIndex >= 0 && targetIndex < 8 && targetIndex !== fromIndex) {
    return { a: fromIndex, b: targetIndex };
  }
  return null;
}

export function cancelDrag() {
  state.drag = null;
}

export function setAllSlots(slots) {
  for (let i = 0; i < 8; i++) {
    state.slots[i] = mapRarity(slots[i] || null);
  }
}

export function setEquipment(equipment) {
  if (!equipment) return;
  for (const key of ['head', 'chest', 'legs', 'mainHand', 'offHand']) {
    state.equipment[key] = mapRarity(equipment[key] || null);
  }
}

export function getEquipAnim() {
  return state.equipAnim;
}

export function setEquipAnim(anim) {
  state.equipAnim = anim;
}

export function getState() {
  return state;
}

export function enterShopMode(data) {
  state.shopMode = true;
  state.shopData = data;
  state.shopSelectedIndex = 0;
  state.shopBrowsing = 'shop';
}

export function exitShopMode() {
  state.shopMode = false;
  state.shopData = null;
  state.shopSelectedIndex = 0;
  state.shopBrowsing = 'shop';
}

export function updateShopData(data) {
  state.shopData = data;
}

export function getShopState() {
  return {
    shopMode: state.shopMode,
    shopData: state.shopData,
    shopSelectedIndex: state.shopSelectedIndex,
    shopBrowsing: state.shopBrowsing,
  };
}

export function cycleShopSlot(delta) {
  if (!state.shopData) return;
  const inv = state.shopData.inventory || [];

  // Build unified position list: shop items → hotbar slots → occupied equip slots
  const positions = [];
  for (let i = 0; i < inv.length; i++) positions.push({ type: 'shop', index: i });
  for (let i = 0; i < 8; i++) positions.push({ type: 'hotbar', index: i });
  for (const key of ['head', 'chest', 'legs', 'mainHand', 'offHand']) {
    if (state.equipment[key]) positions.push({ type: 'equip', key });
  }

  if (positions.length === 0) return;

  // Find current position
  let current = 0;
  if (state.shopBrowsing === 'shop') {
    current = positions.findIndex(p => p.type === 'shop' && p.index === state.shopSelectedIndex);
  } else if (state.selectedEquipSlot) {
    current = positions.findIndex(p => p.type === 'equip' && p.key === state.selectedEquipSlot);
  } else {
    current = positions.findIndex(p => p.type === 'hotbar' && p.index === state.selectedIndex);
  }
  if (current < 0) current = 0;

  // Advance with wrapping
  const next = ((current + delta) % positions.length + positions.length) % positions.length;
  const pos = positions[next];

  if (pos.type === 'shop') {
    state.shopBrowsing = 'shop';
    state.shopSelectedIndex = pos.index;
    state.selectedEquipSlot = null;
  } else if (pos.type === 'hotbar') {
    state.shopBrowsing = 'player';
    state.selectedIndex = pos.index;
    state.selectedEquipSlot = null;
  } else if (pos.type === 'equip') {
    state.shopBrowsing = 'player';
    state.selectedEquipSlot = pos.key;
    state.selectedIndex = -1;
  }
}

export function switchShopBrowsing() {
  state.shopBrowsing = state.shopBrowsing === 'shop' ? 'player' : 'shop';
  state.shopSelectedIndex = 0;
}

export function selectShopSlot(index) {
  state.shopBrowsing = 'shop';
  state.shopSelectedIndex = index;
}

export function setShopBrowsingPlayer() {
  state.shopBrowsing = 'player';
}
