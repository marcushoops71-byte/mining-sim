// ============================================================
//  WalkWorld 3D — network.js
// ============================================================

import { db, isConfigured } from './firebase-config.js';
import {
  ref, set, push, remove, update, onValue,
  onDisconnect, serverTimestamp, query, limitToLast, off,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

let _playerId      = null;
let _playerRef     = null;
let _unsubscribers = [];

const PATHS = {
  players: ()   => ref(db, 'players'),
  player:  (id) => ref(db, `players/${id}`),
  chat:    ()   => ref(db, 'chat'),
};

export async function joinGame(playerData) {
  if (!isConfigured) {
    console.warn('[Network] Firebase not configured — offline mode.');
    return 'offline-' + Math.random().toString(36).slice(2);
  }

  try {
    _playerRef = push(PATHS.players());
    _playerId  = _playerRef.key;

    // Race the Firebase write against a 3-second timeout so we never
    // hang indefinitely if the DB rules have expired or the network is flaky.
    const writeTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Firebase write timed out after 3 s')), 3000)
    );

    await Promise.race([
      set(_playerRef, {
        name:      playerData.name,
        colour:    playerData.colour,
        x:         playerData.x         ?? 0,
        y:         playerData.y         ?? 0,
        z:         playerData.z         ?? 0,
        rotationY: playerData.rotationY ?? 0,
        joinedAt:  serverTimestamp(),
      }),
      writeTimeout,
    ]);

    onDisconnect(_playerRef).remove();
    _pushSystemChat(`${playerData.name} joined the world`);
    return _playerId;

  } catch (err) {
    // Firebase is unreachable, rules expired, or timed out.
    // Fall back to a local-only session so the game still loads.
    console.warn('[Network] Firebase unavailable — offline mode:', err.message);
    _playerRef = null;
    _playerId  = 'offline-' + Math.random().toString(36).slice(2);
    return _playerId;
  }
}

export async function leaveGame(playerName) {
  if (!_playerRef) return;
  onDisconnect(_playerRef).cancel();
  _pushSystemChat(`${playerName} left the world`);
  await remove(_playerRef);
  _unsubscribers.forEach(fn => fn());
  _unsubscribers = [];
  _playerRef = null;
  _playerId  = null;
}

export function updatePosition(x, y, z, rotationY) {
  if (!_playerRef || !isConfigured) return;
  update(_playerRef, {
    x:         Math.round(x * 10) / 10,
    y:         Math.round(y * 10) / 10,
    z:         Math.round(z * 10) / 10,
    rotationY: Math.round(rotationY * 100) / 100,
  });
}

export function onPlayersUpdate(callback) {
  if (!isConfigured) { callback({}); return () => {}; }

  const playersRef = PATHS.players();
  const unsub = onValue(playersRef, snapshot => {
    const raw    = snapshot.val() || {};
    const others = {};
    for (const [id, data] of Object.entries(raw)) {
      if (id === _playerId) continue;
      others[id] = {
        name:      data.name      || 'Player',
        colour:    data.colour    || '#ffffff',
        x:         data.x         ?? 0,
        y:         data.y         ?? 0,
        z:         data.z         ?? 0,
        rotationY: data.rotationY ?? 0,
      };
    }
    callback(others);
  });

  const unsubFn = () => off(playersRef, 'value', unsub);
  _unsubscribers.push(unsubFn);
  return unsubFn;
}

export function getPlayerCount(callback) {
  if (!isConfigured) { callback(0); return () => {}; }

  const playersRef = PATHS.players();
  const unsub = onValue(playersRef, snapshot => {
    callback(snapshot.exists() ? Object.keys(snapshot.val()).length : 0);
  });

  const unsubFn = () => off(playersRef, 'value', unsub);
  _unsubscribers.push(unsubFn);
  return unsubFn;
}

export function sendChat(msg) {
  if (!isConfigured || !msg.text?.trim()) return;
  const newMsg = push(PATHS.chat());
  set(newMsg, {
    name:   msg.name,
    colour: msg.colour,
    text:   msg.text.trim().slice(0, 80),
    time:   serverTimestamp(),
    system: false,
  });
  _pruneChat(40);
}

export function onChat(callback) {
  if (!isConfigured) { callback([]); return () => {}; }

  const chatQuery = query(PATHS.chat(), limitToLast(40));
  const unsub = onValue(chatQuery, snapshot => {
    const raw  = snapshot.val() || {};
    const msgs = Object.values(raw).map(m => ({
      name:   m.name   || '',
      colour: m.colour || '#ffffff',
      text:   m.text   || '',
      system: m.system || false,
    }));
    callback(msgs);
  });

  const unsubFn = () => off(chatQuery, 'value', unsub);
  _unsubscribers.push(unsubFn);
  return unsubFn;
}

function _pushSystemChat(text) {
  if (!isConfigured) return;
  const newMsg = push(PATHS.chat());
  set(newMsg, { name: '', colour: '#6868a8', text, time: serverTimestamp(), system: true });
  _pruneChat(40);
}

async function _pruneChat(keep) {
  if (!isConfigured) return;
  onValue(PATHS.chat(), snapshot => {
    if (!snapshot.exists()) return;
    const keys = Object.keys(snapshot.val());
    if (keys.length > keep) {
      keys.slice(0, keys.length - keep).forEach(k => remove(ref(db, `chat/${k}`)));
    }
  }, { onlyOnce: true });
}
