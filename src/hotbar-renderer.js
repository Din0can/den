import { drawSprite } from './sprites.js';

const SLOT_SIZE = 36;
const SLOT_GAP = 4;
const SLOT_COUNT = 8;
const TOTAL_W = SLOT_COUNT * SLOT_SIZE + (SLOT_COUNT - 1) * SLOT_GAP; // 316

const EQUIP_SIZE = 24;
const EQUIP_GAP = 3;
const EQUIP_COUNT = 5;
const EQUIP_TOTAL_W = EQUIP_COUNT * EQUIP_SIZE + (EQUIP_COUNT - 1) * EQUIP_GAP; // 132
const EQUIP_LABELS = ['Hd', 'Ch', 'Lg', 'MH', 'OH'];
const EQUIP_KEYS = ['head', 'chest', 'legs', 'mainHand', 'offHand'];

const FONT = "'JetBrains Mono', 'Courier New', monospace";

// Shop overlay constants
const SHOP_SLOT = 44;
const SHOP_GAP = 5;
export const SHOP_CANVAS_H = 100;

export function renderHotbar(ctx, state, w, h, shopMode = false, hideSelection = false) {
  if (!state) return;

  const startX = (w - TOTAL_W) / 2;
  const startY = (h - SLOT_SIZE) / 2;

  for (let i = 0; i < SLOT_COUNT; i++) {
    const sx = startX + i * (SLOT_SIZE + SLOT_GAP);
    const isDraggingFrom = state.drag && state.drag.fromIndex === i;

    // Slot background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(sx, startY, SLOT_SIZE, SLOT_SIZE);

    // Border — gold if selected in shop mode, silver if selected, dim otherwise
    const isSelected = !hideSelection && state.selectedEquipSlot === null && i === state.selectedIndex;
    ctx.strokeStyle = isSelected ? (shopMode ? '#ccaa00' : '#c0c0c0') : '#333333';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, startY + 0.5, SLOT_SIZE - 1, SLOT_SIZE - 1);

    // Slot number (top-left corner)
    ctx.font = `8px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#333333';
    ctx.fillText(String(i + 1), sx + 3, startY + 2);

    // Item contents (dimmed if being dragged from)
    const item = state.slots[i];
    if (item) {
      const alpha = isDraggingFrom ? 0.3 : 1;
      ctx.globalAlpha = alpha;

      // Item sprite or char centered
      if (!item.sprite || !drawSprite(ctx, item.sprite, item.rarity || 'common', sx + SLOT_SIZE / 2, startY + SLOT_SIZE / 2, 24)) {
        ctx.font = `16px ${FONT}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillStyle = item.rarity ? item.rarity.color : '#888888';
        ctx.fillText(item.char, sx + SLOT_SIZE / 2, startY + SLOT_SIZE / 2);
      }

      // Stack count (bottom-right, only if >1)
      if (item.count > 1) {
        ctx.font = `9px ${FONT}`;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'right';
        ctx.fillStyle = '#aaaaaa';
        ctx.fillText(String(item.count), sx + SLOT_SIZE - 3, startY + SLOT_SIZE - 2);
      }

      ctx.globalAlpha = 1;
    }
  }

  // Draw ghost item at cursor when dragging
  if (state.drag) {
    const item = state.drag.item;
    ctx.globalAlpha = 0.7;
    if (!item.sprite || !drawSprite(ctx, item.sprite, item.rarity || 'common', state.drag.mouseX, state.drag.mouseY, 24)) {
      ctx.font = `16px ${FONT}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = item.rarity ? item.rarity.color : '#888888';
      ctx.fillText(item.char, state.drag.mouseX, state.drag.mouseY);
    }
    ctx.globalAlpha = 1;
  }
}

export function renderEquipment(ctx, state, w, h, shopMode = false, hideSelection = false) {
  if (!state || !state.equipment) return;

  // Check if any equipment slot is occupied
  const hasAny = EQUIP_KEYS.some(k => state.equipment[k] !== null);
  // Also render if an equipment slot is selected (even if empty, for visual feedback)
  if (!hasAny && !state.selectedEquipSlot) return;

  const hotbarStartY = (h - SLOT_SIZE) / 2;
  const equipStartY = hotbarStartY - EQUIP_SIZE - 4;
  const equipStartX = (w - EQUIP_TOTAL_W) / 2;

  for (let i = 0; i < EQUIP_COUNT; i++) {
    const key = EQUIP_KEYS[i];
    const item = state.equipment[key];

    // Only draw slot if occupied or selected
    if (!item && state.selectedEquipSlot !== key) continue;

    const sx = equipStartX + i * (EQUIP_SIZE + EQUIP_GAP);

    // Slot background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(sx, equipStartY, EQUIP_SIZE, EQUIP_SIZE);

    // Border — gold if selected in shop mode, silver if selected, dim otherwise
    const isSelected = !hideSelection && state.selectedEquipSlot === key;
    ctx.strokeStyle = isSelected ? (shopMode ? '#ccaa00' : '#c0c0c0') : '#333333';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, equipStartY + 0.5, EQUIP_SIZE - 1, EQUIP_SIZE - 1);

    // Label (tiny text above or inside top)
    ctx.font = `7px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#333333';
    ctx.fillText(EQUIP_LABELS[i], sx + EQUIP_SIZE / 2, equipStartY + 1);

    if (item) {
      // Check if this is the offHand showing a 2H weapon's dimmed copy
      const isTwoHandedOH = key === 'offHand' && item.twoHanded;

      ctx.globalAlpha = isTwoHandedOH ? 0.5 : 1;
      if (!item.sprite || !drawSprite(ctx, item.sprite, item.rarity || 'common', sx + EQUIP_SIZE / 2, equipStartY + EQUIP_SIZE / 2 + 2, 16)) {
        ctx.font = `12px ${FONT}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillStyle = item.rarity ? item.rarity.color : '#888888';
        ctx.fillText(item.char, sx + EQUIP_SIZE / 2, equipStartY + EQUIP_SIZE / 2 + 2);
      }
      ctx.globalAlpha = 1;
    }
  }
}

export function renderEquipAnim(ctx, state) {
  if (!state || !state.equipAnim) return;
  const anim = state.equipAnim;
  const elapsed = performance.now() - anim.startTime;
  const t = Math.min(1, elapsed / anim.duration);
  // Ease-out: 1 - (1-t)^2
  const eased = 1 - (1 - t) * (1 - t);
  const x = anim.fromX + (anim.toX - anim.fromX) * eased;
  const y = anim.fromY + (anim.toY - anim.fromY) * eased;

  ctx.globalAlpha = 1 - t * 0.3;
  if (!anim.item.sprite || !drawSprite(ctx, anim.item.sprite, anim.item.rarity || 'common', x, y, 20)) {
    ctx.font = `14px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = anim.item.rarity ? anim.item.rarity.color : '#888888';
    ctx.fillText(anim.item.char, x, y);
  }
  ctx.globalAlpha = 1;
}

export function renderShopOverlay(ctx, shopState, hotbarState, w, h) {
  if (!shopState || !shopState.shopData) return;

  const data = shopState.shopData;
  const inv = data.inventory || [];

  // Opaque black background — no game bleed
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);

  // Shop name: 12px, centered, gold, Y=8
  ctx.font = `12px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ccaa00';
  ctx.fillText(data.shopName || 'Shop', w / 2, 8);

  // ESC hint (top-right, dim)
  ctx.font = `9px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#555555';
  ctx.fillText('ESC to close', w - 8, 10);

  // Item slots starting at Y=22
  const slotY = 22;
  const maxVisible = Math.min(inv.length, 8);
  const shopTotalW = maxVisible * SHOP_SLOT + (maxVisible - 1) * SHOP_GAP;
  const shopStartX = (w - shopTotalW) / 2;

  const RARITY_COLORS = { common: '#888888', uncommon: '#5a8a5a', rare: '#4a7a9a', epic: '#7a5a8a', legendary: '#9a7a3a' };

  for (let i = 0; i < maxVisible; i++) {
    const item = inv[i];
    const sx = shopStartX + i * (SHOP_SLOT + SHOP_GAP);

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(sx, slotY, SHOP_SLOT, SHOP_SLOT);

    const isSelected = shopState.shopBrowsing === 'shop' && i === shopState.shopSelectedIndex;
    ctx.strokeStyle = isSelected ? '#ccaa00' : '#333333';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, slotY + 0.5, SHOP_SLOT - 1, SHOP_SLOT - 1);

    if (item) {
      // Item sprite or char — 32px sprite / 20px char
      if (!item.sprite || !drawSprite(ctx, item.sprite, item.rarity || 'common', sx + SHOP_SLOT / 2, slotY + SHOP_SLOT / 2 - 4, 32)) {
        ctx.font = `20px ${FONT}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillStyle = RARITY_COLORS[item.rarity] || '#888888';
        ctx.fillText(item.char, sx + SHOP_SLOT / 2, slotY + SHOP_SLOT / 2 - 4);
      }

      // Price — 10px
      ctx.font = `10px ${FONT}`;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'center';
      ctx.fillStyle = item.stock === 0 ? '#553333' : '#ccaa00';
      ctx.fillText(`${item.buyPrice}g`, sx + SHOP_SLOT / 2, slotY + SHOP_SLOT - 1);

      // Stock indicator (top-right) — 9px
      if (item.stock >= 0) {
        ctx.font = `9px ${FONT}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'right';
        ctx.fillStyle = item.stock === 0 ? '#553333' : '#666';
        ctx.fillText(String(item.stock), sx + SHOP_SLOT - 2, slotY + 1);
      }
    }
  }

  // Hint text — 12px, Y=72
  let hint = '';
  if (shopState.shopBrowsing === 'shop' && inv.length > 0) {
    const item = inv[shopState.shopSelectedIndex];
    if (item) {
      if (item.stock === 0) hint = `${item.name} | Out of stock`;
      else hint = `${item.name} | Buy ${item.buyPrice}g (E)`;
    }
  } else if (shopState.shopBrowsing === 'player' && hotbarState) {
    let item = null;
    if (hotbarState.selectedEquipSlot) {
      item = hotbarState.equipment[hotbarState.selectedEquipSlot];
    } else if (hotbarState.selectedIndex >= 0) {
      item = hotbarState.slots[hotbarState.selectedIndex];
    }
    if (item) {
      const sellPrice = Math.floor((item.value || 0) * (data.sellMarkup || 0.8));
      if (sellPrice <= 0) hint = `${item.name} | Cannot sell`;
      else hint = `${item.name} | Sell ${sellPrice}g (E)`;
    }
  }

  if (hint) {
    ctx.font = `12px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(hint).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(w / 2 - tw / 2 - 4, 70, tw + 8, 16);
    ctx.fillStyle = '#ccaa00';
    ctx.fillText(hint, w / 2, 72);
  }

  ctx.textAlign = 'left';

  return hint;
}

export function hitTestShopSlot(mx, my, w, h, itemCount) {
  const slotY = 22;
  const maxVisible = Math.min(itemCount, 8);
  const shopTotalW = maxVisible * SHOP_SLOT + (maxVisible - 1) * SHOP_GAP;
  const shopStartX = (w - shopTotalW) / 2;

  for (let i = 0; i < maxVisible; i++) {
    const sx = shopStartX + i * (SHOP_SLOT + SHOP_GAP);
    if (mx >= sx && mx < sx + SHOP_SLOT && my >= slotY && my < slotY + SHOP_SLOT) {
      return i;
    }
  }
  return -1;
}

export function hitTestSlot(mx, my, w, h) {
  const startX = (w - TOTAL_W) / 2;
  const startY = (h - SLOT_SIZE) / 2;

  for (let i = 0; i < SLOT_COUNT; i++) {
    const sx = startX + i * (SLOT_SIZE + SLOT_GAP);
    if (mx >= sx && mx < sx + SLOT_SIZE && my >= startY && my < startY + SLOT_SIZE) {
      return i;
    }
  }
  return -1;
}

export function hitTestEquipSlot(mx, my, w, h) {
  const hotbarStartY = (h - SLOT_SIZE) / 2;
  const equipStartY = hotbarStartY - EQUIP_SIZE - 4;
  const equipStartX = (w - EQUIP_TOTAL_W) / 2;

  for (let i = 0; i < EQUIP_COUNT; i++) {
    const sx = equipStartX + i * (EQUIP_SIZE + EQUIP_GAP);
    if (mx >= sx && mx < sx + EQUIP_SIZE && my >= equipStartY && my < equipStartY + EQUIP_SIZE) {
      return EQUIP_KEYS[i];
    }
  }
  return null;
}

// Export layout constants for overlap guard
export const HOTBAR_TOTAL_W = TOTAL_W;

// Export equipment layout info for animation calculations
export function getSlotCenter(slotIndex, w, h) {
  const startX = (w - TOTAL_W) / 2;
  const startY = (h - SLOT_SIZE) / 2;
  return {
    x: startX + slotIndex * (SLOT_SIZE + SLOT_GAP) + SLOT_SIZE / 2,
    y: startY + SLOT_SIZE / 2,
  };
}

export function getEquipSlotCenter(slotName, w, h) {
  const idx = EQUIP_KEYS.indexOf(slotName);
  if (idx < 0) return null;
  const hotbarStartY = (h - SLOT_SIZE) / 2;
  const equipStartY = hotbarStartY - EQUIP_SIZE - 4;
  const equipStartX = (w - EQUIP_TOTAL_W) / 2;
  return {
    x: equipStartX + idx * (EQUIP_SIZE + EQUIP_GAP) + EQUIP_SIZE / 2,
    y: equipStartY + EQUIP_SIZE / 2,
  };
}
