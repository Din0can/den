// Server-side dungeon generator: random rooms + L-shaped corridors
// Produces a Uint8Array of width*height tiles

const TILE = { VOID: 0, WALL: 1, FLOOR: 2, DOOR: 3 };

export function generateDungeon(width, height, roomCount = 20) {
  const map = new Uint8Array(width * height); // all VOID

  const set = (x, y, t) => {
    if (x >= 0 && x < width && y >= 0 && y < height) map[y * width + x] = t;
  };
  const get = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return TILE.VOID;
    return map[y * width + x];
  };

  const rooms = [];

  // Generate rooms
  for (let i = 0; i < roomCount * 5 && rooms.length < roomCount; i++) {
    const w = 5 + Math.floor(Math.random() * 10);
    const h = 4 + Math.floor(Math.random() * 8);
    const x = 2 + Math.floor(Math.random() * (width - w - 4));
    const y = 2 + Math.floor(Math.random() * (height - h - 4));

    // Check overlap with existing rooms (with 2-tile padding)
    let overlap = false;
    for (const r of rooms) {
      if (x - 2 < r.x + r.w && x + w + 2 > r.x && y - 2 < r.y + r.h && y + h + 2 > r.y) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;

    rooms.push({ x, y, w, h, cx: Math.floor(x + w / 2), cy: Math.floor(y + h / 2) });

    // Carve room: walls around, floor inside
    for (let ry = y - 1; ry <= y + h; ry++) {
      for (let rx = x - 1; rx <= x + w; rx++) {
        if (ry === y - 1 || ry === y + h || rx === x - 1 || rx === x + w) {
          if (get(rx, ry) === TILE.VOID) set(rx, ry, TILE.WALL);
        } else {
          set(rx, ry, TILE.FLOOR);
        }
      }
    }
  }

  // Connect rooms with L-shaped corridors
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1];
    const b = rooms[i];
    carveCorridor(map, width, height, a.cx, a.cy, b.cx, b.cy, set, get);
  }

  // Connect first and last room to make a loop
  if (rooms.length > 2) {
    const a = rooms[rooms.length - 1];
    const b = rooms[0];
    carveCorridor(map, width, height, a.cx, a.cy, b.cx, b.cy, set, get);
  }

  // Add some extra connections for variety
  for (let i = 0; i < Math.floor(rooms.length / 3); i++) {
    const a = rooms[Math.floor(Math.random() * rooms.length)];
    const b = rooms[Math.floor(Math.random() * rooms.length)];
    if (a !== b) {
      carveCorridor(map, width, height, a.cx, a.cy, b.cx, b.cy, set, get);
    }
  }

  return { map, rooms, width, height };
}

function carveCorridor(map, mapW, mapH, x1, y1, x2, y2, set, get) {
  // L-shaped: go horizontal first, then vertical (or vice versa randomly)
  const horizontalFirst = Math.random() > 0.5;

  if (horizontalFirst) {
    carveHLine(x1, x2, y1, set, get);
    carveVLine(y1, y2, x2, set, get);
  } else {
    carveVLine(y1, y2, x1, set, get);
    carveHLine(x1, x2, y2, set, get);
  }
}

function carveHLine(x1, x2, y, set, get) {
  const sx = Math.min(x1, x2);
  const ex = Math.max(x1, x2);
  for (let x = sx; x <= ex; x++) {
    carveTile(x, y, set, get);
    // Add walls around corridor
    if (get(x, y - 1) === TILE.VOID) set(x, y - 1, TILE.WALL);
    if (get(x, y + 1) === TILE.VOID) set(x, y + 1, TILE.WALL);
  }
}

function carveVLine(y1, y2, x, set, get) {
  const sy = Math.min(y1, y2);
  const ey = Math.max(y1, y2);
  for (let y = sy; y <= ey; y++) {
    carveTile(x, y, set, get);
    // Add walls around corridor
    if (get(x - 1, y) === TILE.VOID) set(x - 1, y, TILE.WALL);
    if (get(x + 1, y) === TILE.VOID) set(x + 1, y, TILE.WALL);
  }
}

function carveTile(x, y, set, get) {
  const current = get(x, y);
  if (current === TILE.WALL) {
    // Corridor hits a wall — make a door
    set(x, y, TILE.DOOR);
  } else if (current !== TILE.FLOOR && current !== TILE.DOOR) {
    set(x, y, TILE.FLOOR);
  }
}
