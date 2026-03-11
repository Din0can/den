// Game constants
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 800;
export const TILE_SIZE = 20;
export const VIEWPORT_COLS = Math.floor(GAME_WIDTH / TILE_SIZE);   // 64
export const VIEWPORT_ROWS = Math.floor(GAME_HEIGHT / TILE_SIZE);  // 40
export const HUD_ROWS = 2;
export const MOVE_COOLDOWN = 150; // ms

// FOV settings
export const FOV_RADIUS = 10;
export const FOV_GRACE_RADIUS = 2;

// Tile types
export const TILE = {
  // Core (0-7)
  VOID: 0,
  WALL: 1,
  FLOOR: 2,
  DOOR_CLOSED: 3,
  DOOR_OPEN: 4,
  GRASS: 5,
  WALL_MOSSY: 6,
  ENTRY: 7,
  // Terrain (8-10)
  PATH: 8,
  STONE: 9,
  TREE: 10,
  // Furniture — single line (11-16)
  FURN_TL: 11,
  FURN_TR: 12,
  FURN_BL: 13,
  FURN_BR: 14,
  FURN_H: 15,
  FURN_V: 16,
  // Furniture — double line / beds (17-22)
  FURN_DTL: 17,
  FURN_DTR: 18,
  FURN_DBL: 19,
  FURN_DBR: 20,
  FURN_DV: 21,
  FURN_DH: 22,
  // Single bed (23-24)
  FURN_SBT: 23,
  FURN_SBB: 24,
  // Chairs — directional (25-28)
  CHAIR_S: 25,
  CHAIR_W: 26,
  CHAIR_N: 27,
  CHAIR_E: 28,
  // Containers (29-31)
  CHEST: 29,
  BARREL: 30,
  CRATE: 31,
  // Bookshelves (32-34)
  SHELF_L: 32,
  SHELF_R: 33,
  SHELF_M: 34,
  // Decorative (35-39)
  PILLAR: 35,
  STATUE: 36,
  TORCH: 37,
  WATER: 38,
  DIAMOND: 39,
  // Cage (40-45)
  CAGE_TL: 40,
  CAGE_TR: 41,
  CAGE_BL: 42,
  CAGE_BR: 43,
  CAGE_H: 44,
  CAGE_V: 45,
  // Altar (46-47)
  ALTAR_L: 46,
  ALTAR_M: 47,
  // Throne (48-50)
  THRONE_SIDE: 48,
  THRONE_TOP: 49,
  THRONE_SEAT: 50,
  // Workshop (51-52)
  WEAPON_RACK: 51,
  ANVIL: 52,
  // Info (53)
  INFO: 53,
};

// Tile metadata lookup — { passable, blocksLight, char, fg, bg }
export const TILE_META = {
  // Core
  [TILE.VOID]:        { passable: false, blocksLight: true,  char: ' ', fg: '#000000', bg: '#000000' },
  [TILE.WALL]:        { passable: false, blocksLight: true,  char: '#', fg: '#555555', bg: '#000000' },
  [TILE.FLOOR]:       { passable: true,  blocksLight: false, char: ' ', fg: '#3a3a3a', bg: '#000000' },
  [TILE.DOOR_CLOSED]: { passable: false, blocksLight: true,  char: '┃', fg: '#8B4513', bg: '#000000' },
  [TILE.DOOR_OPEN]:   { passable: true,  blocksLight: false, char: '▔', fg: '#8B4513', bg: '#000000' },
  [TILE.GRASS]:       { passable: true,  blocksLight: false, char: '.', fg: '#3a4a3a', bg: '#000000' },
  [TILE.WALL_MOSSY]:  { passable: false, blocksLight: true,  char: '#', fg: '#4a5a4a', bg: '#000000' },
  [TILE.ENTRY]:       { passable: true,  blocksLight: false, char: 'E', fg: '#7a7a7a', bg: '#000000' },
  // Terrain
  [TILE.PATH]:        { passable: true,  blocksLight: false, char: ' ', fg: '#3a3a3a', bg: '#000000' },
  [TILE.STONE]:       { passable: true,  blocksLight: false, char: ' ', fg: '#3a3a3a', bg: '#000000' },
  [TILE.TREE]:        { passable: false, blocksLight: true,  char: 'T', fg: '#4a4a3a', bg: '#000000' },
  // Furniture — single line
  [TILE.FURN_TL]:     { passable: false, blocksLight: false, char: '┌', fg: '#8B7355', bg: '#000000' },
  [TILE.FURN_TR]:     { passable: false, blocksLight: false, char: '┐', fg: '#8B7355', bg: '#000000' },
  [TILE.FURN_BL]:     { passable: false, blocksLight: false, char: '└', fg: '#8B7355', bg: '#000000' },
  [TILE.FURN_BR]:     { passable: false, blocksLight: false, char: '┘', fg: '#8B7355', bg: '#000000' },
  [TILE.FURN_H]:      { passable: false, blocksLight: false, char: '─', fg: '#8B7355', bg: '#000000' },
  [TILE.FURN_V]:      { passable: false, blocksLight: false, char: '│', fg: '#8B7355', bg: '#000000' },
  // Furniture — double line / beds
  [TILE.FURN_DTL]:    { passable: false, blocksLight: false, char: '╔', fg: '#8B0000', bg: '#000000' },
  [TILE.FURN_DTR]:    { passable: false, blocksLight: false, char: '╗', fg: '#8B0000', bg: '#000000' },
  [TILE.FURN_DBL]:    { passable: false, blocksLight: false, char: '╚', fg: '#8B0000', bg: '#000000' },
  [TILE.FURN_DBR]:    { passable: false, blocksLight: false, char: '╝', fg: '#8B0000', bg: '#000000' },
  [TILE.FURN_DV]:     { passable: false, blocksLight: false, char: '║', fg: '#8B0000', bg: '#000000' },
  [TILE.FURN_DH]:     { passable: false, blocksLight: false, char: '═', fg: '#8B0000', bg: '#000000' },
  // Single bed
  [TILE.FURN_SBT]:    { passable: false, blocksLight: false, char: '╓', fg: '#8B0000', bg: '#000000' },
  [TILE.FURN_SBB]:    { passable: false, blocksLight: false, char: '╙', fg: '#8B0000', bg: '#000000' },
  // Chairs
  [TILE.CHAIR_S]:     { passable: false, blocksLight: false, char: '╥', fg: '#6B4423', bg: '#000000' },
  [TILE.CHAIR_W]:     { passable: false, blocksLight: false, char: '╡', fg: '#6B4423', bg: '#000000' },
  [TILE.CHAIR_N]:     { passable: false, blocksLight: false, char: '╨', fg: '#6B4423', bg: '#000000' },
  [TILE.CHAIR_E]:     { passable: false, blocksLight: false, char: '╞', fg: '#6B4423', bg: '#000000' },
  // Containers
  [TILE.CHEST]:       { passable: false, blocksLight: false, char: '▣', fg: '#8B6914', bg: '#000000' },
  [TILE.BARREL]:      { passable: false, blocksLight: false, char: '◎', fg: '#8B4513', bg: '#000000' },
  [TILE.CRATE]:       { passable: false, blocksLight: false, char: '▤', fg: '#A0522D', bg: '#000000' },
  // Bookshelves
  [TILE.SHELF_L]:     { passable: false, blocksLight: false, char: '▐', fg: '#654321', bg: '#000000' },
  [TILE.SHELF_R]:     { passable: false, blocksLight: false, char: '▌', fg: '#654321', bg: '#000000' },
  [TILE.SHELF_M]:     { passable: false, blocksLight: false, char: '█', fg: '#654321', bg: '#000000' },
  // Decorative
  [TILE.PILLAR]:      { passable: false, blocksLight: false, char: '○', fg: '#808080', bg: '#000000' },
  [TILE.STATUE]:      { passable: false, blocksLight: false, char: '♠', fg: '#696969', bg: '#000000' },
  [TILE.TORCH]:       { passable: false, blocksLight: false, char: '¥', fg: '#FF6600', bg: '#000000' },
  [TILE.WATER]:       { passable: false, blocksLight: false, char: '~', fg: '#4682B4', bg: '#000000' },
  [TILE.DIAMOND]:     { passable: false, blocksLight: false, char: '◆', fg: '#4682B4', bg: '#000000' },
  // Cage
  [TILE.CAGE_TL]:     { passable: false, blocksLight: false, char: '┏', fg: '#4A4A4A', bg: '#000000' },
  [TILE.CAGE_TR]:     { passable: false, blocksLight: false, char: '┓', fg: '#4A4A4A', bg: '#000000' },
  [TILE.CAGE_BL]:     { passable: false, blocksLight: false, char: '┗', fg: '#4A4A4A', bg: '#000000' },
  [TILE.CAGE_BR]:     { passable: false, blocksLight: false, char: '┛', fg: '#4A4A4A', bg: '#000000' },
  [TILE.CAGE_H]:      { passable: false, blocksLight: false, char: '━', fg: '#4A4A4A', bg: '#000000' },
  [TILE.CAGE_V]:      { passable: false, blocksLight: false, char: '┃', fg: '#4A4A4A', bg: '#000000' },
  // Altar
  [TILE.ALTAR_L]:     { passable: false, blocksLight: false, char: '▄', fg: '#4B0082', bg: '#000000' },
  [TILE.ALTAR_M]:     { passable: false, blocksLight: false, char: '█', fg: '#4B0082', bg: '#000000' },
  // Throne
  [TILE.THRONE_SIDE]: { passable: false, blocksLight: false, char: '░', fg: '#FFD700', bg: '#000000' },
  [TILE.THRONE_TOP]:  { passable: false, blocksLight: false, char: '▲', fg: '#FFD700', bg: '#000000' },
  [TILE.THRONE_SEAT]: { passable: false, blocksLight: false, char: '╨', fg: '#FFD700', bg: '#000000' },
  // Workshop
  [TILE.WEAPON_RACK]: { passable: false, blocksLight: false, char: '╫', fg: '#708090', bg: '#000000' },
  [TILE.ANVIL]:       { passable: false, blocksLight: false, char: '╤', fg: '#2F4F4F', bg: '#000000' },
  // Info
  [TILE.INFO]:        { passable: true,  blocksLight: false, char: 'i', fg: '#00cccc', bg: '#000000' },
};

// Color palette (Kraken2004 gray/white/brown)
export const COLORS = {
  WALL_FG:        '#555555',
  FLOOR_FG:       '#3a3a3a',
  VOID_BG:        '#000000',
  PLAYER_LOCAL:   '#ffffff',
  DOOR_FG:        '#8B4513',
  HUD_FG:         '#cccccc',
  HUD_BG:         '#111111',
  HUD_FG_DIM:     '#666666',
  FURNITURE_FG:   '#8B7355',
  GRASS_FG:       '#3a4a3a',
  MOSSY_WALL_FG:  '#4a5a4a',
  CHEST_FG:       '#DAA520',
  TORCH_FG:       '#FF6600',
  WATER_FG:       '#4682B4',
  PILLAR_FG:      '#808080',
  BED_FG:         '#8B0000',
  CAGE_FG:        '#4A4A4A',
};

// Wall glyphs
export const WALL_CHARS = ['#', '#', '#', '#'];

// CRT shader params (tuned for Kraken dark palette)
export const CRT_PARAMS = {
  curvature: 2.0,
  chromatic: 0.8,
  scanlineCount: 400,
  scanlineIntensity: 0.08,
  bloomRadius: 2,
  bloomIntensity: 0.12,
  vignetteIntensity: 0.4,
  flickerIntensity: 0.01,
  noiseIntensity: 0.03,
  jitterIntensity: 0,
  jitterChance: 0,
  brightness: 0.05,
  contrast: 1.1,
  saturation: 0.9,
  glowColor: 0,
};
