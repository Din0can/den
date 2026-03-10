import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateDungeon } from './src/map-generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

const PORT = 3000;
const MAP_WIDTH = 120;
const MAP_HEIGHT = 80;

// Generate dungeon on startup
console.log('Generating dungeon...');
const dungeon = generateDungeon(MAP_WIDTH, MAP_HEIGHT, 22);
console.log(`Dungeon generated: ${dungeon.rooms.length} rooms`);

// Player state
const players = new Map();
const PLAYER_COLORS = [
  '#00ffff', '#ff00ff', '#ffd700', '#ff6600',
  '#ff4444', '#44ff44', '#ffff00', '#88aaff',
];
let colorIndex = 0;

function randomFloorSpawn() {
  // Pick a random room and find a floor tile in it
  const room = dungeon.rooms[Math.floor(Math.random() * dungeon.rooms.length)];
  const x = room.x + 1 + Math.floor(Math.random() * (room.w - 2));
  const y = room.y + 1 + Math.floor(Math.random() * (room.h - 2));
  return { x, y };
}

// Serve static files in production
app.use(express.static(join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

io.on('connection', (socket) => {
  const id = socket.id;
  const color = PLAYER_COLORS[colorIndex++ % PLAYER_COLORS.length];
  const spawn = randomFloorSpawn();
  const name = '';

  players.set(id, { id, color, x: spawn.x, y: spawn.y, name });

  // Send welcome: map data + existing players
  const others = [];
  for (const [pid, p] of players) {
    if (pid !== id) others.push(p);
  }

  socket.emit('welcome', {
    id,
    color,
    spawn,
    map: Array.from(dungeon.map),
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    players: others,
  });

  // Broadcast new player to others
  socket.broadcast.emit('playerJoined', { id, color, spawn, name });

  console.log(`Player ${id} joined at (${spawn.x}, ${spawn.y})`);

  // Relay position updates
  socket.on('state', (data) => {
    const p = players.get(id);
    if (p) {
      p.x = data.x;
      p.y = data.y;
      if (data.name) p.name = data.name;
    }
    socket.broadcast.volatile.emit('playerState', { id, color, ...data });
  });

  socket.on('disconnect', () => {
    players.delete(id);
    socket.broadcast.emit('playerLeft', { id });
    console.log(`Player ${id} left`);
  });
});

http.listen(PORT, () => {
  console.log(`Den server running on http://localhost:${PORT}`);
});
