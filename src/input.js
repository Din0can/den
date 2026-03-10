const keys = {};

export function initInput() {
  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
  });
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
}

export function isKeyDown(code) {
  return !!keys[code];
}

/** Returns {dx, dy} from WASD/arrow keys, or null if no movement key pressed */
export function getMovementDir() {
  if (isKeyDown('KeyW') || isKeyDown('ArrowUp'))    return { dx: 0, dy: -1 };
  if (isKeyDown('KeyS') || isKeyDown('ArrowDown'))   return { dx: 0, dy: 1 };
  if (isKeyDown('KeyA') || isKeyDown('ArrowLeft'))   return { dx: -1, dy: 0 };
  if (isKeyDown('KeyD') || isKeyDown('ArrowRight'))  return { dx: 1, dy: 0 };
  return null;
}
