import { randomBytes, scrypt, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SAVES_DIR = join(import.meta.dirname, 'data', 'saves');
const SESSIONS_FILE = join(SAVES_DIR, '_sessions.json');

// In-memory stores
const saves = new Map();       // usernameLower -> saveData
const sessions = new Map();    // sessionToken -> usernameLower
const connectedUsers = new Map(); // usernameLower -> socketId (for duplicate detection)

// Debounced writes
const pendingWrites = new Map(); // usernameLower -> timeout

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

function validateUsername(name) {
  if (!name || typeof name !== 'string') return 'Username is required';
  if (name.length < 2) return 'Username must be at least 2 characters';
  if (name.length > 16) return 'Username must be 16 characters or fewer';
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return 'Username can only contain letters, numbers, _ and -';
  return null;
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 4) return 'Password must be at least 4 characters';
  return null;
}

export async function init() {
  await mkdir(SAVES_DIR, { recursive: true });

  // Load all save files
  const files = await readdir(SAVES_DIR);
  for (const file of files) {
    if (file.startsWith('_') || !file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(await readFile(join(SAVES_DIR, file), 'utf8'));
      if (data.username) {
        saves.set(data.username.toLowerCase(), data);
      }
    } catch (e) {
      console.error(`Failed to load save ${file}:`, e.message);
    }
  }
  console.log(`Loaded ${saves.size} player saves`);

  // Load sessions
  try {
    if (existsSync(SESSIONS_FILE)) {
      const sessionData = JSON.parse(await readFile(SESSIONS_FILE, 'utf8'));
      for (const [token, username] of Object.entries(sessionData)) {
        if (saves.has(username)) sessions.set(token, username);
      }
    }
  } catch (e) {
    console.error('Failed to load sessions:', e.message);
  }
  console.log(`Loaded ${sessions.size} sessions`);
}

async function writeSave(usernameLower) {
  const data = saves.get(usernameLower);
  if (!data) return;
  try {
    await writeFile(join(SAVES_DIR, `${usernameLower}.json`), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Failed to write save for ${usernameLower}:`, e.message);
  }
}

function debouncedWriteSave(usernameLower) {
  clearTimeout(pendingWrites.get(usernameLower));
  pendingWrites.set(usernameLower, setTimeout(() => {
    pendingWrites.delete(usernameLower);
    writeSave(usernameLower);
  }, 1000));
}

async function writeSessions() {
  try {
    const obj = {};
    for (const [token, username] of sessions) obj[token] = username;
    await writeFile(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Failed to write sessions:', e.message);
  }
}

export function isNameTaken(username) {
  return saves.has(username.toLowerCase());
}

export async function register(username, password) {
  const nameErr = validateUsername(username);
  if (nameErr) return { success: false, error: nameErr };
  const passErr = validatePassword(password);
  if (passErr) return { success: false, error: passErr };

  const lower = username.toLowerCase();
  if (saves.has(lower)) return { success: false, error: 'Username already taken' };

  const salt = randomBytes(16).toString('hex');
  const passwordHash = await hashPassword(password, salt);

  const saveData = {
    username,
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
    lastSaveAt: null,
    lastLayerId: null,
    x: null,
    y: null,
    facing: 'south',
    stats: null,
    inventory: null,
    equipment: null,
    totalArmor: 0,
    activeDamage: 1,
    attackRange: 1,
    attackSpeed: 1000,
    lightRadius: 0,
  };

  saves.set(lower, saveData);
  await writeSave(lower);

  const token = randomUUID();
  sessions.set(token, lower);
  writeSessions();

  return { success: true, token, username };
}

export async function login(username, password) {
  if (!username || !password) return { success: false, error: 'Username and password required' };

  const lower = username.toLowerCase();
  const save = saves.get(lower);
  if (!save) return { success: false, error: 'Invalid username or password' };

  const hash = await hashPassword(password, save.salt);
  if (hash !== save.passwordHash) return { success: false, error: 'Invalid username or password' };

  const token = randomUUID();
  sessions.set(token, lower);
  writeSessions();

  return { success: true, token, username: save.username, saveData: getSafeData(save) };
}

export function loginByToken(token) {
  if (!token) return null;
  const lower = sessions.get(token);
  if (!lower) return null;
  const save = saves.get(lower);
  if (!save) return null;
  return { username: save.username, saveData: getSafeData(save) };
}

export function updateSave(username, playerState) {
  const lower = username.toLowerCase();
  const save = saves.get(lower);
  if (!save) return;

  save.lastSaveAt = new Date().toISOString();
  save.lastLayerId = playerState.layerId;
  save.x = playerState.x;
  save.y = playerState.y;
  save.facing = playerState.facing;
  save.stats = playerState.stats;
  save.inventory = playerState.inventory;
  save.equipment = playerState.equipment;
  save.totalArmor = playerState.totalArmor;
  save.activeDamage = playerState.activeDamage;
  save.attackRange = playerState.attackRange;
  save.attackSpeed = playerState.attackSpeed;
  save.lightRadius = playerState.lightRadius;

  debouncedWriteSave(lower);
}

export function getSave(username) {
  const lower = username.toLowerCase();
  const save = saves.get(lower);
  return save ? getSafeData(save) : null;
}

export function hasSavePoint(username) {
  const lower = username.toLowerCase();
  const save = saves.get(lower);
  return save && save.lastLayerId !== null;
}

// Strip password fields before sending to client or using externally
function getSafeData(save) {
  const { passwordHash, salt, ...safe } = save;
  return safe;
}

// Track connected users for duplicate detection
export function setConnected(username, socketId) {
  connectedUsers.set(username.toLowerCase(), socketId);
}

export function getConnectedSocketId(username) {
  return connectedUsers.get(username.toLowerCase());
}

export function removeConnected(username) {
  connectedUsers.delete(username.toLowerCase());
}

export function removeConnectedBySocket(socketId) {
  for (const [user, sid] of connectedUsers) {
    if (sid === socketId) {
      connectedUsers.delete(user);
      return user;
    }
  }
  return null;
}

// Save on disconnect (flush immediately)
export async function saveOnDisconnect(username, playerState) {
  const lower = username.toLowerCase();
  const save = saves.get(lower);
  if (!save || save.lastLayerId === null) return; // never saved before, don't create save point on disconnect

  save.lastSaveAt = new Date().toISOString();
  // Only update position/stats, don't change lastLayerId (keep last checkpoint)
  save.stats = playerState.stats;
  save.inventory = playerState.inventory;
  save.equipment = playerState.equipment;
  save.totalArmor = playerState.totalArmor;
  save.activeDamage = playerState.activeDamage;
  save.attackRange = playerState.attackRange;
  save.attackSpeed = playerState.attackSpeed;
  save.lightRadius = playerState.lightRadius;

  clearTimeout(pendingWrites.get(lower));
  pendingWrites.delete(lower);
  await writeSave(lower);
}
