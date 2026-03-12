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
  SHELF: {
    cells: [['╢', '╢']],
    passable: false, color: '#6B4423',
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
      { prop: ['BARREL', 'CRATE'], position: 'random', count: 5 },
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
    weight: 3,
    placements: [
      { prop: 'PILLAR', position: 'random', count: 1, chance: 0.5 },
    ],
  },
  forge: {
    weight: 1,
    minSize: { w: 8, h: 6 },
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
  library: {
    weight: 1,
    minSize: { w: 8, h: 6 },
    placements: [
      { prop: 'SHELF', position: 'wall-top', count: 1 },
      { prop: 'SHELF', position: 'wall-left', count: 1 },
      { prop: 'SHELF', position: 'wall-right', count: 1 },
      { prop: 'TABLE_2X2', position: 'center', count: 1 },
      { prop: 'CHAIR', position: 'random', count: 2 },
    ],
  },
  armory: {
    weight: 1,
    minSize: { w: 8, h: 6 },
    placements: [
      { prop: 'WEAPON_RACK', position: 'wall-top', count: 1 },
      { prop: 'WEAPON_RACK', position: 'wall-bottom', count: 1 },
      { prop: 'CRATE', position: 'random', count: 2 },
      { prop: 'BARREL', position: 'random', count: 1 },
    ],
  },
  prison: {
    weight: 1,
    minSize: { w: 10, h: 8 },
    placements: [
      { prop: 'CAGE', position: 'random', count: 3 },
      { prop: 'BARREL', position: 'random', count: 1 },
      { prop: 'TORCH_STAND', position: 'wall-left', count: 1 },
      { prop: 'TORCH_STAND', position: 'wall-right', count: 1 },
    ],
  },
  treasure: {
    weight: 0.5,
    minSize: { w: 8, h: 8 },
    placements: [
      { prop: 'CHEST', position: 'random', count: 3 },
      { prop: 'PILLAR', position: 'random', count: 4 },
    ],
  },
  barracks: {
    weight: 1,
    minSize: { w: 12, h: 8 },
    placements: [
      { prop: 'BED_SINGLE', position: 'wall-left', count: 2 },
      { prop: 'BED_SINGLE', position: 'wall-right', count: 2 },
      { prop: 'CHEST', position: 'random', count: 2 },
    ],
  },
  mess_hall: {
    weight: 1,
    minSize: { w: 14, h: 10 },
    placements: [
      { prop: 'TABLE_4X2', position: 'center', count: 1 },
      { prop: 'CHAIR', position: 'random', count: 8 },
      { prop: 'BARREL', position: 'wall-right', count: 2 },
    ],
  },
  workshop: {
    weight: 1,
    minSize: { w: 8, h: 6 },
    placements: [
      { prop: 'ANVIL', position: 'center', count: 1 },
      { prop: 'WEAPON_RACK', position: 'wall-top', count: 1 },
      { prop: 'BARREL', position: 'random', count: 1 },
      { prop: 'CRATE', position: 'random', count: 1 },
    ],
  },
  guard_room: {
    weight: 1,
    minSize: { w: 8, h: 6 },
    placements: [
      { prop: 'TABLE_2X2', position: 'center', count: 1 },
      { prop: 'CHAIR', position: 'random', count: 2 },
      { prop: 'WEAPON_RACK', position: 'wall-top', count: 1 },
      { prop: 'TORCH_STAND', position: 'wall-left', count: 1 },
      { prop: 'TORCH_STAND', position: 'wall-right', count: 1 },
    ],
  },
  crypt: {
    weight: 1,
    minSize: { w: 10, h: 8 },
    placements: [
      { prop: 'STATUE', position: 'wall-left', count: 1 },
      { prop: 'STATUE', position: 'wall-right', count: 1 },
      { prop: 'ALTAR', position: 'center', count: 1 },
      { prop: 'PILLAR', position: 'random', count: 2 },
      { prop: 'TORCH_STAND', position: 'wall-top', count: 1 },
      { prop: 'TORCH_STAND', position: 'wall-bottom', count: 1 },
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
    // Support fractional weights by scaling to integers (multiply by 2)
    const w = Math.round((tmpl.weight || 1) * 2);
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

// Check if an area is all FLOOR, has no overlay, and doesn't neighbor any doors
function areaFree(x, y, w, h, mapData, mapWidth, mapHeight, overlay) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || px >= mapWidth || py < 0 || py >= mapHeight) return false;
      const t = mapData[py * mapWidth + px];
      if (t !== 2 && t !== 5 && t !== 8 && t !== 9) return false; // FLOOR, GRASS, PATH, STONE
      if (overlay.has(overlayKey(px, py))) return false;
    }
  }
  // Check 1-tile buffer around the footprint for doors (DOOR_CLOSED=3, DOOR_OPEN=4)
  for (let dy = -1; dy <= h; dy++) {
    for (let dx = -1; dx <= w; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || px >= mapWidth || py < 0 || py >= mapHeight) continue;
      const t = mapData[py * mapWidth + px];
      if (t === 3 || t === 4) return false; // adjacent to door
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
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
    // For center position, no point retrying (same coords each time)
    if (position === 'center') return false;
  }
  return false;
}

function placeTorches(room, mapData, mapWidth, mapHeight, overlay) {
  if (Math.random() > 0.30) return; // 70% of rooms: no torches
  const walls = ['wall-top', 'wall-bottom', 'wall-left', 'wall-right'];
  const wall = walls[Math.floor(Math.random() * walls.length)];
  tryPlace('TORCH_STAND', room, mapData, mapWidth, mapHeight, overlay, wall);
}

export function furnishRoom(room, mapData, mapWidth, mapHeight, overlay) {
  // Skip tiny rooms
  if (room.w < 5 || room.h < 4) return;

  if (!weightedRoomTypes) buildWeightedTypes();
  if (weightedRoomTypes.length === 0) return;

  // Pick a template, falling back to empty/storage if room is too small for the chosen one
  let typeName, tmpl;
  for (let pick = 0; pick < 5; pick++) {
    typeName = weightedRoomTypes[Math.floor(Math.random() * weightedRoomTypes.length)];
    tmpl = roomTemplates[typeName];
    if (!tmpl) continue;
    if (tmpl.minSize && (room.w < tmpl.minSize.w || room.h < tmpl.minSize.h)) {
      tmpl = null;
      continue;
    }
    break;
  }
  if (!tmpl) {
    // Fall back to empty
    typeName = 'empty';
    tmpl = roomTemplates.empty;
    if (!tmpl) return;
  }

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

  // Pillar configurations for larger rooms (30% chance for eligible rooms)
  if (Math.random() < 0.30) {
    placePillarConfig(room, mapData, mapWidth, mapHeight, overlay);
  }

  placeTorches(room, mapData, mapWidth, mapHeight, overlay);
}

function placePillarConfig(room, mapData, mapWidth, mapHeight, overlay) {
  const tryPillar = (px, py) => {
    if (px < 0 || px >= mapWidth || py < 0 || py >= mapHeight) return;
    if (areaFree(px, py, 1, 1, mapData, mapWidth, mapHeight, overlay)) {
      placeObj('PILLAR', px, py, 0, overlay);
    }
  };

  const roll = Math.random();

  if (roll < 0.35 && room.w >= 10 && room.h >= 8) {
    // Corner pillars
    tryPillar(room.x + 2, room.y + 2);
    tryPillar(room.x + room.w - 3, room.y + 2);
    tryPillar(room.x + 2, room.y + room.h - 3);
    tryPillar(room.x + room.w - 3, room.y + room.h - 3);
  } else if (roll < 0.55 && room.w >= 16) {
    // Pillar rows: two parallel rows dividing the room
    const rowY1 = room.y + Math.floor(room.h * 0.33);
    const rowY2 = room.y + Math.floor(room.h * 0.67);
    const count = 2 + Math.floor(Math.random() * 2); // 2-3 pillars per row
    const spacing = Math.floor((room.w - 4) / (count + 1));
    for (let i = 1; i <= count; i++) {
      tryPillar(room.x + 2 + i * spacing, rowY1);
      tryPillar(room.x + 2 + i * spacing, rowY2);
    }
  } else if (roll < 0.80 && room.w >= 8) {
    // Wall-line pillars: 2-3 pillars along one wall, evenly spaced
    const count = 2 + Math.floor(Math.random() * 2);
    const side = Math.floor(Math.random() * 4);
    const spacing = Math.floor((side < 2 ? room.w : room.h) / (count + 1));
    for (let i = 1; i <= count; i++) {
      if (side === 0) tryPillar(room.x + i * spacing, room.y + 1);
      else if (side === 1) tryPillar(room.x + i * spacing, room.y + room.h - 2);
      else if (side === 2) tryPillar(room.x + 1, room.y + i * spacing);
      else tryPillar(room.x + room.w - 2, room.y + i * spacing);
    }
  } else if (room.w >= 8 && room.h >= 6) {
    // Entrance pillars: place pillars flanking doorways (1 tile into the room)
    // Scan perimeter for doors
    for (let rx = room.x; rx < room.x + room.w; rx++) {
      if (room.y > 0 && (mapData[(room.y - 1) * mapWidth + rx] === 3 || mapData[(room.y - 1) * mapWidth + rx] === 4)) {
        tryPillar(rx - 1, room.y + 1);
        tryPillar(rx + 1, room.y + 1);
        break;
      }
      if (room.y + room.h < mapHeight && (mapData[(room.y + room.h) * mapWidth + rx] === 3 || mapData[(room.y + room.h) * mapWidth + rx] === 4)) {
        tryPillar(rx - 1, room.y + room.h - 2);
        tryPillar(rx + 1, room.y + room.h - 2);
        break;
      }
    }
  }
}
