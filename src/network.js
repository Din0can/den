import { io } from 'socket.io-client';

let socket = null;
let lastSendTime = 0;
const SEND_INTERVAL = 33; // ~30Hz

const handlers = {};

export function connect() {
  socket = io({ transports: ['websocket'] });

  socket.on('welcome', (data) => handlers.onWelcome?.(data));
  socket.on('playerJoined', (data) => handlers.onPlayerJoined?.(data));
  socket.on('playerLeft', (data) => handlers.onPlayerLeft?.(data));
  socket.on('playerState', (data) => handlers.onPlayerState?.(data));

  socket.on('connect', () => console.log('Connected:', socket.id));
  socket.on('disconnect', () => console.log('Disconnected'));
}

export function onWelcome(fn) { handlers.onWelcome = fn; }
export function onPlayerJoined(fn) { handlers.onPlayerJoined = fn; }
export function onPlayerLeft(fn) { handlers.onPlayerLeft = fn; }
export function onPlayerState(fn) { handlers.onPlayerState = fn; }

export function sendState(x, y) {
  if (!socket) return;
  const now = performance.now();
  if (now - lastSendTime < SEND_INTERVAL) return;
  lastSendTime = now;
  socket.volatile.emit('state', { x, y });
}

export function getId() {
  return socket?.id;
}
