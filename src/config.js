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
  VOID: 0,
  WALL: 1,
  FLOOR: 2,
  DOOR_CLOSED: 3,
  DOOR_OPEN: 4,
  GRASS: 5,
  WALL_MOSSY: 6,
  ENTRY: 7,
};

// Tile metadata lookup — { passable, blocksLight, char, fg, bg }
export const TILE_META = {
  [TILE.VOID]:        { passable: false, blocksLight: true,  char: ' ', fg: '#000000', bg: '#000000' },
  [TILE.WALL]:        { passable: false, blocksLight: true,  char: '#', fg: '#555555', bg: '#000000' },
  [TILE.FLOOR]:       { passable: true,  blocksLight: false, char: ' ', fg: '#3a3a3a', bg: '#000000' },
  [TILE.DOOR_CLOSED]: { passable: false, blocksLight: true,  char: '┃', fg: '#8B4513', bg: '#000000' },
  [TILE.DOOR_OPEN]:   { passable: true,  blocksLight: false, char: '▔', fg: '#8B4513', bg: '#000000' },
  [TILE.GRASS]:       { passable: true,  blocksLight: false, char: '.', fg: '#3a4a3a', bg: '#000000' },
  [TILE.WALL_MOSSY]:  { passable: false, blocksLight: true,  char: '#', fg: '#4a5a4a', bg: '#000000' },
  [TILE.ENTRY]:       { passable: true,  blocksLight: false, char: 'E', fg: '#7a7a7a', bg: '#000000' },
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
