// HUD info container — updated each frame, read by game-renderer
export const hudInfo = {
  name: '',
  x: 0,
  y: 0,
  playerCount: 1,
  layer: 0,
  limbs: [],
  hp: 0,
  maxHp: 0,
  sanity: 0,
  maxSanity: 0,
  bleedStacks: 0,
  gold: 0,
  hotbar: null,
  equipHint: null,
};

export function updateHUD(name, x, y, playerCount, layer, stats, hotbar) {
  hudInfo.name = name;
  hudInfo.x = x;
  hudInfo.y = y;
  hudInfo.playerCount = playerCount;
  hudInfo.layer = layer;
  if (stats) {
    hudInfo.limbs = stats.limbs;
    hudInfo.sanity = stats.sanity;
    hudInfo.maxSanity = stats.maxSanity;
    hudInfo.bleedStacks = stats.bleedStacks;
    hudInfo.gold = stats.gold;
    let hp = 0, maxHp = 0;
    for (const limb of stats.limbs) {
      hp += limb.hp;
      maxHp += limb.maxHp;
    }
    hudInfo.hp = Math.floor(hp);
    hudInfo.maxHp = maxHp;
  }
  hudInfo.hotbar = hotbar || null;
}
