// Mobile virtual controls - d-pad + action buttons

import { keys, triggerInteract, triggerDrop, triggerEscape } from './input.js';
import { getShopState, cycleShopSlot, switchShopBrowsing, exitShopMode } from './hotbar.js';
import { sendCloseShop } from './network.js';

export const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

const DIR_MAP = {
  up:    'ArrowUp',
  down:  'ArrowDown',
  left:  'ArrowLeft',
  right: 'ArrowRight',
};

export function initMobileControls() {
  if (!isTouchDevice) return;

  const controls = document.getElementById('mobile-controls');
  if (!controls) return;
  controls.style.display = 'block';

  // D-pad buttons - repurposed in shop mode
  const dpadBtns = controls.querySelectorAll('.dpad-btn');
  for (const btn of dpadBtns) {
    const dir = btn.dataset.dir;
    const keyCode = DIR_MAP[dir];
    if (!keyCode) continue;

    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      btn.classList.add('pressed');

      const shopActive = getShopState().shopMode;
      if (shopActive) {
        // Shop mode: d-pad cycles items and switches browsing
        if (dir === 'left') cycleShopSlot(-1);
        else if (dir === 'right') cycleShopSlot(1);
        else if (dir === 'up' || dir === 'down') switchShopBrowsing();
      } else {
        // Normal mode: movement
        keys[keyCode] = true;
      }
    }, { passive: false });

    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      keys[keyCode] = false;
      btn.classList.remove('pressed');
    }, { passive: false });

    btn.addEventListener('touchcancel', (e) => {
      keys[keyCode] = false;
      btn.classList.remove('pressed');
    });
  }

  // Action buttons - X closes shop when in shop mode
  const actionBtns = controls.querySelectorAll('.action-btn');
  for (const btn of actionBtns) {
    const action = btn.dataset.action;

    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      btn.classList.add('pressed');

      const shopActive = getShopState().shopMode;

      if (action === 'interact') {
        triggerInteract();
      } else if (action === 'drop') {
        if (shopActive) {
          exitShopMode();
          sendCloseShop();
        } else {
          triggerDrop();
        }
      } else if (action === 'escape') {
        triggerEscape();
      }
    }, { passive: false });

    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      btn.classList.remove('pressed');
    }, { passive: false });

    btn.addEventListener('touchcancel', () => {
      btn.classList.remove('pressed');
    });
  }

  // Clear all keys on blur (prevent stuck keys when browser loses focus)
  window.addEventListener('blur', () => {
    for (const key of Object.keys(keys)) keys[key] = false;
    controls.querySelectorAll('.pressed').forEach(el => el.classList.remove('pressed'));
  });

  // Prevent default on game canvases to stop scroll/bounce
  for (const id of ['game-canvas', 'crt-canvas', 'hud-canvas']) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    }
  }
}

// HUD touch support - tap hotbar slots
export function initHudTouch(hudCanvas, hitTestSlot, hitTestEquipSlot, selectSlot, selectEquipSlot, getHotbarState) {
  if (!isTouchDevice) return;

  hudCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    if (!touch) return;
    const rect = hudCanvas.getBoundingClientRect();
    const mx = touch.clientX - rect.left;
    const my = touch.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;

    // Check equip slot
    const equipSlot = hitTestEquipSlot(mx, my, w, h);
    if (equipSlot && getHotbarState().equipment[equipSlot]) {
      selectEquipSlot(equipSlot);
      return;
    }

    // Check hotbar slot
    const slot = hitTestSlot(mx, my, w, h);
    if (slot >= 0) {
      selectSlot(slot);
    }
  }, { passive: false });
}
