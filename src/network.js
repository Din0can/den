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
  socket.on('doorState', (data) => handlers.onDoorState?.(data));
  socket.on('layerData', (data) => handlers.onLayerData?.(data));
  socket.on('chunkData', (data) => handlers.onChunkData?.(data));

  socket.on('connect', () => console.log('Connected:', socket.id));
  socket.on('disconnect', () => console.log('Disconnected'));
}

export function onWelcome(fn) { handlers.onWelcome = fn; }
export function onPlayerJoined(fn) { handlers.onPlayerJoined = fn; }
export function onPlayerLeft(fn) { handlers.onPlayerLeft = fn; }
export function onPlayerState(fn) { handlers.onPlayerState = fn; }
export function onDoorState(fn) { handlers.onDoorState = fn; }
export function onLayerData(fn) { handlers.onLayerData = fn; }
export function onChunkData(fn) { handlers.onChunkData = fn; }

export function sendState(x, y, facing) {
  if (!socket) return;
  const now = performance.now();
  if (now - lastSendTime < SEND_INTERVAL) return;
  lastSendTime = now;
  socket.volatile.emit('state', { x, y, facing });
}

export function sendFacing(facing) {
  if (!socket) return;
  socket.volatile.emit('state', { facing });
}

export function sendDoorToggle(doorId) {
  if (!socket) return;
  socket.emit('doorToggle', { doorId });
}

export function requestChunks(layerId, keys) {
  if (!socket) return;
  socket.emit('requestChunks', { layerId, keys });
}

export function sendName(name) {
  if (!socket) return;
  socket.emit('state', { name });
}

export function sendChangeLayer(layerId) {
  if (!socket) return;
  socket.emit('changeLayer', { layerId });
}

export function sendEnterExit() {
  if (!socket) return;
  socket.emit('enterExit');
}

export function getId() {
  return socket?.id;
}
