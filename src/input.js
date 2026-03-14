import { selectSlot, cycleSlot, selectEquipSlot, startDrag, updateDrag, endDrag, cancelDrag, getState as getHotbarState, cycleShopSlot, switchShopBrowsing, exitShopMode, selectShopSlot, setShopBrowsingPlayer } from './hotbar.js';
import { hitTestSlot, hitTestEquipSlot, hitTestShopSlot } from './hotbar-renderer.js';
import { sendEquipItem, sendUnequipItem, sendUseItem, sendSwapSlots, sendCloseShop } from './network.js';

const keys = {};
let interactPressed = false;
let escapePressed = false;
let dropPressed = false;
let lastClickTime = 0;
let lastClickSlot = -1;
let lastClickEquip = null;

// Shop canvas input listener refs (for cleanup)
let _shopCanvas = null;
let _shopClickHandler = null;
let _shopDblClickHandler = null;
let _shopContextHandler = null;

export function initInput() {
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'KeyE') {
      interactPressed = true;
    }
    if (e.code === 'Escape') {
      escapePressed = true;
    }
    if (e.code === 'KeyX') {
      dropPressed = true;
    }
    // Shop mode navigation
    const shopState = getHotbarState();
    if (shopState.shopMode) {
      if (e.code === 'KeyW' || e.code === 'KeyS' || e.code === 'Tab') {
        e.preventDefault();
        switchShopBrowsing();
      }
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
        cycleShopSlot(-1);
      }
      if (e.code === 'KeyD' || e.code === 'ArrowRight') {
        cycleShopSlot(1);
      }
      if (e.code === 'Escape' || e.code === 'KeyI') {
        exitShopMode();
        sendCloseShop();
      }
    }
    // Number keys 1-8 select hotbar slot
    if (!e.shiftKey && e.code >= 'Digit1' && e.code <= 'Digit8') {
      selectSlot(parseInt(e.code.charAt(5)) - 1);
    }
    // Shift+1-5 select equipment slot
    if (e.shiftKey && e.code >= 'Digit1' && e.code <= 'Digit5') {
      const equipSlots = ['head', 'chest', 'legs', 'mainHand', 'offHand'];
      selectEquipSlot(equipSlots[parseInt(e.code.charAt(5)) - 1]);
    }
  });
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
}

export function initHotbarInput(hudCanvas) {
  // Mouse wheel — cycle selected slot (shop-aware)
  window.addEventListener('wheel', (e) => {
    const s = getHotbarState();
    if (s.shopMode) {
      cycleShopSlot(e.deltaY > 0 ? 1 : -1);
    } else {
      cycleSlot(e.deltaY > 0 ? 1 : -1);
    }
  }, { passive: true });

  // Prevent context menu on HUD canvas
  hudCanvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // Right-click on hotbar slot → use consumable (skip in shop mode)
  hudCanvas.addEventListener('mousedown', (e) => {
    if (e.button === 2) {
      // Right click — no-op in shop mode
      const state = getHotbarState();
      if (state.shopMode) return;

      const rect = hudCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const w = rect.width;
      const h = rect.height;
      const slot = hitTestSlot(mx, my, w, h);
      if (slot >= 0) {
        const item = state.slots[slot];
        if (item && item.type === 'consumable') {
          sendUseItem(slot);
        }
      }
      return;
    }

    if (e.button !== 0) return;

    const rect = hudCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;

    // Shop mode: clicking hotbar/equip → select for sell
    const state = getHotbarState();
    if (state.shopMode) {
      // Check equip slot click first
      const equipSlot = hitTestEquipSlot(mx, my, w, h);
      if (equipSlot) {
        const now = Date.now();
        if (lastClickEquip === equipSlot && now - lastClickTime < 350) {
          // Double-click equip slot in shop → sell
          selectEquipSlot(equipSlot);
          setShopBrowsingPlayer();
          triggerInteract();
          lastClickEquip = null;
          lastClickTime = 0;
        } else {
          selectEquipSlot(equipSlot);
          setShopBrowsingPlayer();
          lastClickEquip = equipSlot;
          lastClickTime = now;
        }
        lastClickSlot = -1;
        return;
      }

      // Check hotbar slot click
      const slot = hitTestSlot(mx, my, w, h);
      if (slot >= 0) {
        const now = Date.now();
        if (lastClickSlot === slot && now - lastClickTime < 350) {
          // Double-click hotbar slot in shop → sell
          selectSlot(slot);
          setShopBrowsingPlayer();
          triggerInteract();
          lastClickSlot = -1;
          lastClickTime = 0;
        } else {
          selectSlot(slot);
          setShopBrowsingPlayer();
          lastClickSlot = slot;
          lastClickTime = now;
        }
        lastClickEquip = null;
      }
      return; // Skip drag and equip logic in shop mode
    }

    // Check equipment slot click
    const equipSlot = hitTestEquipSlot(mx, my, w, h);
    if (equipSlot) {
      const now = Date.now();
      if (lastClickEquip === equipSlot && now - lastClickTime < 350) {
        // Double-click on equipment slot → unequip
        sendUnequipItem(equipSlot);
        lastClickEquip = null;
        lastClickTime = 0;
      } else {
        selectEquipSlot(equipSlot);
        lastClickEquip = equipSlot;
        lastClickTime = now;
      }
      lastClickSlot = -1;
      return;
    }

    // Check hotbar slot click
    const slot = hitTestSlot(mx, my, w, h);
    if (slot >= 0) {
      const now = Date.now();
      if (lastClickSlot === slot && now - lastClickTime < 350) {
        // Double-click on hotbar slot
        const item = state.slots[slot];
        if (item) {
          if (item.slot) {
            // Equippable → equip
            sendEquipItem(slot);
          } else if (item.type === 'consumable') {
            // Consumable → use
            sendUseItem(slot);
          }
        }
        lastClickSlot = -1;
        lastClickTime = 0;
      } else {
        selectSlot(slot);
        startDrag(slot, mx, my);
        lastClickSlot = slot;
        lastClickTime = now;
      }
      lastClickEquip = null;
      return;
    }

    // Click outside both → clear
    lastClickSlot = -1;
    lastClickEquip = null;
  });

  window.addEventListener('mousemove', (e) => {
    const rect = hudCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    updateDrag(mx, my);
  });

  window.addEventListener('mouseup', (e) => {
    const rect = hudCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const slot = hitTestSlot(mx, my, w, h);
    const swapResult = endDrag(slot);
    if (swapResult) {
      sendSwapSlots(swapResult.a, swapResult.b);
    }
    if (!swapResult && slot < 0) {
      cancelDrag();
    }
  });
}

export function triggerInteract() {
  interactPressed = true;
}

export function initShopInput(shopCanvas) {
  _shopCanvas = shopCanvas;

  _shopClickHandler = (e) => {
    const rect = shopCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const state = getHotbarState();
    const itemCount = state.shopData ? (state.shopData.inventory || []).length : 0;
    const slot = hitTestShopSlot(mx, my, w, h, itemCount);
    if (slot >= 0) {
      selectShopSlot(slot);
    }
  };

  _shopDblClickHandler = (e) => {
    const rect = shopCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const state = getHotbarState();
    const itemCount = state.shopData ? (state.shopData.inventory || []).length : 0;
    const slot = hitTestShopSlot(mx, my, w, h, itemCount);
    if (slot >= 0) {
      selectShopSlot(slot);
      triggerInteract();
    }
  };

  _shopContextHandler = (e) => {
    e.preventDefault();
  };

  shopCanvas.addEventListener('click', _shopClickHandler);
  shopCanvas.addEventListener('dblclick', _shopDblClickHandler);
  shopCanvas.addEventListener('contextmenu', _shopContextHandler);
}

export function destroyShopInput() {
  if (_shopCanvas) {
    if (_shopClickHandler) _shopCanvas.removeEventListener('click', _shopClickHandler);
    if (_shopDblClickHandler) _shopCanvas.removeEventListener('dblclick', _shopDblClickHandler);
    if (_shopContextHandler) _shopCanvas.removeEventListener('contextmenu', _shopContextHandler);
  }
  _shopCanvas = null;
  _shopClickHandler = null;
  _shopDblClickHandler = null;
  _shopContextHandler = null;
}

export function isKeyDown(code) {
  return !!keys[code];
}

/** Returns {dx, dy} from WASD/arrow keys, or null if no movement key pressed */
export function getMovementDir() {
  if (getHotbarState().shopMode) return null;
  if (isKeyDown('KeyW') || isKeyDown('ArrowUp'))    return { dx: 0, dy: -1 };
  if (isKeyDown('KeyS') || isKeyDown('ArrowDown'))   return { dx: 0, dy: 1 };
  if (isKeyDown('KeyA') || isKeyDown('ArrowLeft'))   return { dx: -1, dy: 0 };
  if (isKeyDown('KeyD') || isKeyDown('ArrowRight'))  return { dx: 1, dy: 0 };
  return null;
}

/** Returns true once per E key press */
export function consumeInteract() {
  if (interactPressed) {
    interactPressed = false;
    return true;
  }
  return false;
}

/** Returns true once per Escape key press */
export function consumeEscape() {
  if (escapePressed) {
    escapePressed = false;
    return true;
  }
  return false;
}

/** Returns true once per X key press */
export function consumeDrop() {
  if (dropPressed) {
    dropPressed = false;
    return true;
  }
  return false;
}
