// Furniture system — data-driven from config
// Produces overlay data (sparse layer on top of base tiles)

const CHAR_ROTATE_90 = {
  '\u250C': '\u2510', '\u2510': '\u2518', '\u2518': '\u2514', '\u2514': '\u250C',  // ┌┐┘└
  '\u2500': '\u2502', '\u2502': '\u2500',                                          // ─│
  '\u251C': '\u252C', '\u252C': '\u2524', '\u2524': '\u2534', '\u2534': '\u251C',  // ├┬┤┴
  '\u2554': '\u2557', '\u2557': '\u255D', '\u255D': '\u255A', '\u255A': '\u2554',  // ╔╗╝╚
  '\u2550': '\u2551', '\u2551': '\u2550',                                          // ═║
  '\u256D': '\u256E', '\u256E': '\u256F', '\u256F': '\u2570', '\u2570': '\u256D',  // ╭╮╯╰
  '\u2565': '\u2561', '\u2561': '\u2568', '\u2568': '\u255E', '\u255E': '\u2565',  // ╥╡╨╞
  '\u250F': '\u2513', '\u2513': '\u251B', '\u251B': '\u2517', '\u2517': '\u250F',  // ┏┓┛┗
  '\u2553': '\u2556', '\u2556': '\u2559', '\u2559': '\u255C', '\u255C': '\u2553',  // ╓╖╙╜ (bed single corners)
  '\u25B2': '\u25B6', '\u25B6': '\u25BC', '\u25BC': '\u25C0', '\u25C0': '\u25B2',  // ▲▶▼◀ (throne arrows)
};

function rotateChar(char, times) {
  times = ((times % 4) + 4) % 4;
  let result = char;
  for (let i = 0; i < times; i++) {
    result = CHAR_ROTATE_90[result] || result;
  }
  return result;
}

function rotateGrid90(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  const rotated = [];
  for (let x = 0; x < cols; x++) {
    rotated[x] = [];
    for (let y = rows - 1; y >= 0; y--) {
      rotated[x][rows - 1 - y] = rotateChar(grid[y][x], 1);
    }
  }
  return rotated;
}

function rotateGrid(grid, times) {
  times = ((times % 4) + 4) % 4;
  let result = grid;
  for (let i = 0; i < times; i++) {
    result = rotateGrid90(result);
  }
  return result;
}

// --- Default prop definitions (used as fallback) ---
const DEFAULT_OBJECTS = {
  TABLE_2X2: {
    cells: [['┌', '┐'], ['└', '┘']],
    passable: false, color: '#8B7355',
  },
  TABLE_3X2: {
    cells: [['┌', '─', '┐'], ['└', '─', '┘']],
    passable: false, color: '#8B7355',
  },
  CHAIR: {
    cells: [['╥']],
    passable: false, color: '#6B4423',
  },
  CHEST: {
    cells: [['▣']],
    passable: false, color: '#DAA520',
  },
  BARREL: {
    cells: [['◎']],
    passable: false, color: '#8B4513',
  },
  CRATE: {
    cells: [['▤']],
    passable: false, color: '#A0522D',
  },
  BED: {
    cells: [['╔', '╗'], ['║', '║'], ['╚', '╝']],
    passable: false, color: '#8B0000',
  },
  PILLAR: {
    cells: [['○']],
    passable: false, color: '#808080',
  },
  TORCH_STAND: {
    cells: [['¥']],
    passable: false, color: '#FF6600',
  },
  CAGE: {
    cells: [['┏', '┓'], ['┗', '┛']],
    passable: false, color: '#4A4A4A',
  },
  WEAPON_RACK: {
    cells: [['╫', '╫']],
    passable: false, color: '#708090',
  },
  TABLE_4X2: {
    cells: [['┌', '─', '─', '┐'], ['└', '─', '─', '┘']],
    passable: false, color: '#8B7355',
  },
  CHEST_LARGE: {
    cells: [['▣', '▣']],
    passable: false, color: '#DAA520',
  },
  BED_SINGLE: {
    cells: [['╓'], ['║'], ['╙']],
    passable: false, color: '#8B0000',
  },
  STATUE: {
    cells: [['♠']],
    passable: false, color: '#696969',
  },
  FOUNTAIN: {
    cells: [['┌', '~', '┐'], ['│', '◆', '│'], ['└', '~', '┘']],
    passable: false, color: '#4682B4',
  },
  ALTAR: {
    cells: [['▄', '█', '▄']],
    passable: false, color: '#4B0082',
  },
  THRONE: {
    cells: [['░', '▲', '░'], [' ', '╨', ' ']],
    passable: false, color: '#FFD700',
  },
  ANVIL: {
    cells: [['╤']],
    passable: false, color: '#2F4F4F',
  },
};

const DEFAULT_ROOM_TEMPLATES = {
  bedroom: {
    weight: 1,
    placements: [
      { prop: 'BED', position: 'wall-left', count: 1 },
      { prop: 'CHEST', position: 'wall-right', count: 1 },
    ],
  },
  dining: {
    weight: 1,
    placements: [
      { prop: 'TABLE_3X2', position: 'center', count: 1 },
      { prop: 'CHAIR', position: 'random', count: 4 },
    ],
  },
  storage: {
    weight: 1,
    placements: [
      { prop: ['BARREL', 'CRATE'], position: 'random', count: 3 },
    ],
  },
  dungeon: {
    weight: 1,
    placements: [
      { prop: 'CAGE', position: 'center', count: 1 },
      { prop: 'WEAPON_RACK', position: 'wall-top', count: 1 },
    ],
  },
  empty: {
    weight: 2,
    placements: [
      { prop: 'PILLAR', position: 'random', count: 1, chance: 0.5 },
    ],
  },
  forge: {
    weight: 1,
    placements: [
      { prop: 'ANVIL', position: 'center', count: 1 },
      { prop: 'WEAPON_RACK', position: 'wall-top', count: 1 },
      { prop: 'BARREL', position: 'random', count: 1 },
    ],
  },
  throne_room: {
    weight: 1,
    placements: [
      { prop: 'THRONE', position: 'center', count: 1 },
      { prop: 'PILLAR', position: 'random', count: 2 },
      { prop: 'TORCH_STAND', position: 'wall-left', count: 1 },
      { prop: 'TORCH_STAND', position: 'wall-right', count: 1 },
    ],
  },
  chapel: {
    weight: 1,
    placements: [
      { prop: 'ALTAR', position: 'center', count: 1 },
      { prop: 'STATUE', position: 'wall-left', count: 1 },
      { prop: 'STATUE', position: 'wall-right', count: 1 },
    ],
  },
  grand_dining: {
    weight: 1,
    placements: [
      { prop: 'TABLE_4X2', position: 'center', count: 1 },
      { prop: 'CHAIR', position: 'random', count: 6 },
    ],
  },
};

const DEFAULT_TORCHES = { min: 1, max: 2 };

// --- Active config (mutable) ---
let objects = { ...DEFAULT_OBJECTS };
let roomTemplates = { ...DEFAULT_ROOM_TEMPLATES };
let torchConfig = { ...DEFAULT_TORCHES };
let weightedRoomTypes = null; // lazily built

function buildWeightedTypes() {
  const types = [];
  for (const [name, tmpl] of Object.entries(roomTemplates)) {
    const w = tmpl.weight || 1;
    for (let i = 0; i < w; i++) types.push(name);
  }
  weightedRoomTypes = types;
}

// --- Public config API ---
export function loadConfig(config) {
  if (config.props) {
    objects = {};
    for (const [key, val] of Object.entries(config.props)) {
      objects[key] = { cells: val.cells, passable: val.passable, color: val.color };
    }
  }
  if (config.roomTemplates) {
    roomTemplates = config.roomTemplates;
  }
  if (config.torches) {
    torchConfig = config.torches;
  }
  weightedRoomTypes = null; // rebuild on next use
}

export function getConfig() {
  return {
    props: objects,
    roomTemplates,
    torches: torchConfig,
  };
}

export function getDefaultConfig() {
  return {
    props: DEFAULT_OBJECTS,
    roomTemplates: DEFAULT_ROOM_TEMPLATES,
    torches: DEFAULT_TORCHES,
  };
}

// --- Overlay helpers (numeric keys) ---
function overlayKey(x, y) {
  return (x << 16) | (y & 0xFFFF);
}

export function stampObject(objKey, x, y, rotation = 0) {
  const obj = objects[objKey];
  if (!obj) return [];

  const cells = rotation === 0 ? obj.cells : rotateGrid(obj.cells, rotation);
  const stamps = [];

  for (let dy = 0; dy < cells.length; dy++) {
    for (let dx = 0; dx < cells[dy].length; dx++) {
      const ch = cells[dy][dx];
      if (ch === ' ' || ch === null) continue;
      stamps.push({ x: x + dx, y: y + dy, char: ch, color: obj.color, passable: obj.passable });
    }
  }
  return stamps;
}

function getObjDims(objKey, rotation = 0) {
  const obj = objects[objKey];
  if (!obj) return { w: 0, h: 0 };
  const cells = rotation === 0 ? obj.cells : rotateGrid(obj.cells, rotation);
  return { w: cells[0].length, h: cells.length };
}

// Check if an area is all FLOOR and has no overlay
function areaFree(x, y, w, h, mapData, mapWidth, mapHeight, overlay) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || px >= mapWidth || py < 0 || py >= mapHeight) return false;
      if (mapData[py * mapWidth + px] !== 2) return false; // TILE.FLOOR = 2
      if (overlay.has(overlayKey(px, py))) return false;
    }
  }
  return true;
}

function placeObj(objKey, x, y, rot, overlay) {
  const stamps = stampObject(objKey, x, y, rot);
  for (const s of stamps) {
    overlay.set(overlayKey(s.x, s.y), { char: s.char, color: s.color, passable: s.passable });
  }
  return stamps.length > 0;
}

function tryPlace(objKey, room, mapData, mapWidth, mapHeight, overlay, position) {
  const rot = Math.floor(Math.random() * 4);
  const dims = getObjDims(objKey, rot);
  let x, y;

  if (position === 'center') {
    x = room.x + Math.floor((room.w - dims.w) / 2);
    y = room.y + Math.floor((room.h - dims.h) / 2);
  } else if (position === 'wall-top') {
    x = room.x + 1 + Math.floor(Math.random() * Math.max(1, room.w - dims.w - 2));
    y = room.y;
  } else if (position === 'wall-bottom') {
    x = room.x + 1 + Math.floor(Math.random() * Math.max(1, room.w - dims.w - 2));
    y = room.y + room.h - dims.h;
  } else if (position === 'wall-left') {
    x = room.x;
    y = room.y + 1 + Math.floor(Math.random() * Math.max(1, room.h - dims.h - 2));
  } else if (position === 'wall-right') {
    x = room.x + room.w - dims.w;
    y = room.y + 1 + Math.floor(Math.random() * Math.max(1, room.h - dims.h - 2));
  } else {
    // Random interior
    x = room.x + 1 + Math.floor(Math.random() * Math.max(1, room.w - dims.w - 2));
    y = room.y + 1 + Math.floor(Math.random() * Math.max(1, room.h - dims.h - 2));
  }

  if (areaFree(x, y, dims.w, dims.h, mapData, mapWidth, mapHeight, overlay)) {
    placeObj(objKey, x, y, rot, overlay);
    return true;
  }
  return false;
}

function placeTorches(room, mapData, mapWidth, mapHeight, overlay) {
  const count = torchConfig.min + Math.floor(Math.random() * (torchConfig.max - torchConfig.min + 1));
  const walls = ['wall-top', 'wall-bottom', 'wall-left', 'wall-right'];
  for (let i = 0; i < count; i++) {
    const wall = walls[Math.floor(Math.random() * walls.length)];
    tryPlace('TORCH_STAND', room, mapData, mapWidth, mapHeight, overlay, wall);
  }
}

export function furnishRoom(room, mapData, mapWidth, mapHeight, overlay) {
  // Skip tiny rooms
  if (room.w < 5 || room.h < 4) return;

  if (!weightedRoomTypes) buildWeightedTypes();
  if (weightedRoomTypes.length === 0) return;

  const typeName = weightedRoomTypes[Math.floor(Math.random() * weightedRoomTypes.length)];
  const tmpl = roomTemplates[typeName];
  if (!tmpl) return;

  for (const placement of tmpl.placements) {
    // Optional placement (chance)
    if (placement.chance !== undefined && Math.random() > placement.chance) continue;

    const count = placement.count || 1;
    for (let i = 0; i < count; i++) {
      // Resolve prop — support array for random choice
      let propKey;
      if (Array.isArray(placement.prop)) {
        propKey = placement.prop[Math.floor(Math.random() * placement.prop.length)];
      } else {
        propKey = placement.prop;
      }
      tryPlace(propKey, room, mapData, mapWidth, mapHeight, overlay, placement.position || 'random');
    }
  }

  placeTorches(room, mapData, mapWidth, mapHeight, overlay);
}
