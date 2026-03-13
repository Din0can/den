import { io } from 'socket.io-client';

let socket = null;
let lastSendTime = 0;
const SEND_INTERVAL = 33; // ~30Hz

let lastItemAction = 0;
const ITEM_COOLDOWN = 100;

function throttledEmit(event, data) {
  if (!socket) return;
  const now = performance.now();
  if (now - lastItemAction < ITEM_COOLDOWN) return;
  lastItemAction = now;
  socket.emit(event, data);
}

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
  socket.on('damage', (data) => handlers.onDamage?.(data));
  socket.on('bloodUpdate', (data) => handlers.onBloodUpdate?.(data));
  socket.on('inventoryUpdate', (data) => handlers.onInventoryUpdate?.(data));
  socket.on('containerResult', (data) => handlers.onContainerResult?.(data));
  socket.on('shopData', (data) => handlers.onShopData?.(data));
  socket.on('shopResult', (data) => handlers.onShopResult?.(data));

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
export function onDamage(fn) { handlers.onDamage = fn; }
export function onBloodUpdate(fn) { handlers.onBloodUpdate = fn; }
export function onInventoryUpdate(fn) { handlers.onInventoryUpdate = fn; }
export function onContainerResult(fn) { handlers.onContainerResult = fn; }
export function onShopData(fn) { handlers.onShopData = fn; }
export function onShopResult(fn) { handlers.onShopResult = fn; }

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

export function sendOpenContainer(x, y) {
  throttledEmit('openContainer', { x, y });
}

export function sendUseItem(slot) {
  throttledEmit('useItem', { slot });
}

export function sendEquipItem(slot) {
  throttledEmit('equipItem', { slot });
}

export function sendUnequipItem(slotName) {
  throttledEmit('unequipItem', { slot: slotName });
}

export function sendSwapSlots(a, b) {
  if (!socket) return;
  socket.emit('swapSlots', { a, b });
}

export function sendOpenShop(shopId) {
  if (!socket) return;
  socket.emit('openShop', { shopId });
}

export function sendBuyFromShop(shopId, itemIndex) {
  throttledEmit('buyFromShop', { shopId, itemIndex });
}

export function sendSellToShop(shopId, hotbarSlot) {
  throttledEmit('sellToShop', { shopId, hotbarSlot });
}

export function sendCloseShop() {
  if (!socket) return;
  socket.emit('closeShop');
}


export function getId() {
  return socket?.id;
}
