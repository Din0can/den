// HUD info container — updated each frame, read by game-renderer
export const hudInfo = {
  name: '',
  x: 0,
  y: 0,
  playerCount: 1,
  layer: 0,
};

export function updateHUD(name, x, y, playerCount, layer) {
  hudInfo.name = name;
  hudInfo.x = x;
  hudInfo.y = y;
  hudInfo.playerCount = playerCount;
  hudInfo.layer = layer;
}
