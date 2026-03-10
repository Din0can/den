// Game constants
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 800;
export const TILE_SIZE = 20;
export const VIEWPORT_COLS = Math.floor(GAME_WIDTH / TILE_SIZE);   // 64
export const VIEWPORT_ROWS = Math.floor(GAME_HEIGHT / TILE_SIZE);  // 40
export const HUD_ROWS = 2;
export const MAP_WIDTH = 120;
export const MAP_HEIGHT = 80;
export const MOVE_COOLDOWN = 150; // ms

// Tile types
export const TILE = {
  VOID: 0,
  WALL: 1,
  FLOOR: 2,
  DOOR: 3,
};

// Color palette
export const COLORS = {
  WALL_FG: '#00aa2a',
  WALL_BG: '#0a2a0a',
  FLOOR_FG: '#1a3a1a',
  FLOOR_BG: '#0a0a0a',
  VOID_BG: '#000000',
  PLAYER_LOCAL: '#00ff41',
  DOOR_FG: '#ffd700',
  HUD_FG: '#00ff41',
  HUD_BG: '#0a1a0a',
};

export const PLAYER_COLORS = [
  '#00ffff', '#ff00ff', '#ffd700', '#ff6600',
  '#ff4444', '#44ff44', '#ffff00', '#88aaff',
];

// Wall glyphs
export const WALL_CHARS = ['#', '#', '#', '#'];
// Floor glyphs (seeded by position)
export const FLOOR_CHARS = ['.', '.', '.', ',', '`', '.'];

// CRT shader params (tuned down for game readability)
export const CRT_PARAMS = {
  curvature: 2.0,
  chromatic: 0.8,
  scanlineCount: 400,
  scanlineIntensity: 0.08,
  bloomRadius: 2,
  bloomIntensity: 0.15,
  vignetteIntensity: 0.4,
  flickerIntensity: 0.01,
  noiseIntensity: 0.03,
  jitterIntensity: 0,
  jitterChance: 0,
  brightness: 0.05,
  contrast: 1.1,
  saturation: 1.0,
  glowColor: 0,
};
