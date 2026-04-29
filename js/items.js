// ============================================================
//  WalkWorld 3D — items.js
//
//  Shovel (slot 1):
//    Left-click while holding → dig animation, spawn dirt
//    particles, chance to find a buried item nearby.
//
//  Item Detector (slot 2):
//    Must be held (slot 2 active) to scan.
//    Reads distance to nearest buried item and drives the
//    right-side signal-meter HUD + beep sound.
//
//  Exports:
//    setupItems(player, gameCanvas, wrapper)
//    tickItems(timestamp)   ← call from game loop every frame
// ============================================================

// ── Seeded RNG (same as world.js so positions are consistent) ──
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ── Buried item catalogue ─────────────────────────────────────
const ITEM_TYPES = [
  { name: 'Ancient Coin',  icon: '🪙', rarity: 'common'   },
  { name: 'Crystal Gem',   icon: '💎', rarity: 'rare'     },
  { name: 'Gold Nugget',   icon: '🏅', rarity: 'uncommon' },
  { name: 'Old Skeleton Key', icon: '🗝️', rarity: 'uncommon' },
  { name: 'Strange Fossil', icon: '🦴', rarity: 'rare'    },
  { name: 'Magic Orb',     icon: '🔮', rarity: 'rare'     },
  { name: 'Iron Sword',    icon: '⚔️', rarity: 'uncommon' },
  { name: 'Seashell',      icon: '🐚', rarity: 'common'   },
  { name: 'Ruby Ring',     icon: '💍', rarity: 'rare'     },
  { name: 'Copper Coin',   icon: '🟤', rarity: 'common'   },
];

// Generate fixed buried-item positions (seeded so they never move)
function generateBuriedItems() {
  const rng   = makeRng(0xB04E1D00); // was 0xB0RIED00 — R and I are not valid hex digits
  const items = [];
  for (let i = 0; i < 45; i++) {
    const x    = (rng() * 2 - 1) * 88;
    const z    = (rng() * 2 - 1) * 88;
    // Avoid lake zone (roughly x>40,z>16)
    if (x > 40 && z > 16) { i--; continue; }
    const type = ITEM_TYPES[Math.floor(rng() * ITEM_TYPES.length)];
    items.push({ id: i, x, z, ...type });
  }
  return items;
}

const BURIED_ITEMS = generateBuriedItems();

// ── Persistence: remember which items have been found ─────────
function getFoundIds() {
  try { return new Set(JSON.parse(sessionStorage.getItem('ww_found') || '[]')); }
  catch { return new Set(); }
}
function saveFoundIds(set) {
  try { sessionStorage.setItem('ww_found', JSON.stringify([...set])); } catch {}
}

let _foundIds = getFoundIds();

// ── Dig radius: must be within this distance to find an item ──
const DIG_RADIUS        = 4.5;   // world units
const DETECT_RANGE      = 22;    // detector max effective range

// ── State ─────────────────────────────────────────────────────
let _player     = null;
let _canvas     = null;
let _wrapper    = null;
let _detHud     = null;
let _detBar     = null;
let _detValue   = null;
let _foundNotif = null;
let _heldWrap   = null;

let _lastDigTime      = 0;
const DIG_COOLDOWN_MS = 700;  // prevent spam-clicking

let _notifTimeout = null;

// AudioContext for beeps (created lazily on first user gesture)
let _audioCtx = null;
function _getAudio() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  return _audioCtx;
}

function _beep(freq = 880, dur = 0.07, vol = 0.25) {
  const ctx = _getAudio();
  if (!ctx) return;
  try {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch {}
}

// ── PUBLIC: initialise ────────────────────────────────────────
export function setupItems(player, gameCanvas, wrapper) {
  _player  = player;
  _canvas  = gameCanvas;
  _wrapper = wrapper;

  _heldWrap   = document.getElementById('heldItemWrap');
  _detHud     = document.getElementById('detectorHud');
  _detBar     = document.getElementById('detBar');
  _detValue   = document.getElementById('detValue');
  _foundNotif = document.getElementById('foundNotif');

  // ── Left-click = dig (when pointer is locked, slot 1 active) ──
  gameCanvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const slot = window.HOTBAR_SLOT || '1';
    if (slot !== '1') return;                   // shovel must be held
    if (!document.pointerLockElement) return;   // must be in game
    _doDigAction();
  });
}

// ── PUBLIC: call every frame from the game loop ───────────────
export function tickItems(timestamp) {
  if (!_player) return;

  const slot = window.HOTBAR_SLOT || '1';
  const isDetector = slot === '2';

  // Show / hide detector HUD
  if (_detHud) {
    if (isDetector) {
      _detHud.classList.remove('hidden');
      _updateDetector();
    } else {
      _detHud.classList.add('hidden');
      _detHud.classList.remove('strong');
    }
  }
}

// ── Detector: scan nearest unfound buried item ────────────────
let _lastBeepTime = 0;

function _updateDetector() {
  if (!_player || !_detBar || !_detValue) return;

  // Find nearest unfound item
  let nearestDist = Infinity;
  for (const item of BURIED_ITEMS) {
    if (_foundIds.has(item.id)) continue;
    const dx = item.x - _player.x;
    const dz = item.z - _player.z;
    const d  = Math.sqrt(dx * dx + dz * dz);
    if (d < nearestDist) nearestDist = d;
  }

  // Map distance → signal strength 0–100
  const strength = nearestDist > DETECT_RANGE
    ? 0
    : Math.round((1 - nearestDist / DETECT_RANGE) * 100);

  // Update bar height and colour
  _detBar.style.height = strength + '%';

  const isStrong = strength >= 70;
  const isMed    = strength >= 35;

  _detBar.style.background = isStrong
    ? '#ff4757'
    : isMed
    ? '#ffa502'
    : '#00f5c4';

  // Update label
  if (nearestDist > DETECT_RANGE) {
    _detValue.textContent = 'NO\nSIGNAL';
  } else if (isStrong) {
    _detValue.textContent = 'STRONG\n' + Math.round(nearestDist) + 'm';
  } else if (isMed) {
    _detValue.textContent = 'MED\n' + Math.round(nearestDist) + 'm';
  } else {
    _detValue.textContent = 'WEAK\n' + Math.round(nearestDist) + 'm';
  }

  // Pulse hud border on strong signal
  if (_detHud) {
    _detHud.classList.toggle('strong', isStrong);
  }

  // Beep — rate tied to signal strength
  const now = performance.now();
  const beepInterval = isStrong ? 400 : isMed ? 900 : 2000;
  if (strength > 5 && now - _lastBeepTime > beepInterval) {
    _lastBeepTime = now;
    const freq = 400 + strength * 6;
    _beep(freq, 0.05, 0.15);
  }
}

// ── Shovel dig action ─────────────────────────────────────────
function _doDigAction() {
  const now = Date.now();
  if (now - _lastDigTime < DIG_COOLDOWN_MS) return;
  _lastDigTime = now;

  // Play dig animation on held item
  if (_heldWrap) {
    _heldWrap.classList.remove('digging');
    void _heldWrap.offsetWidth;             // force reflow to restart animation
    _heldWrap.classList.add('digging');
    _heldWrap.addEventListener('animationend', () => {
      _heldWrap.classList.remove('digging');
    }, { once: true });
  }

  // Dirt particle burst on screen
  _spawnDirtParticles();

  // Check for nearby buried item
  _beep(220, 0.12, 0.3);

  let found = null;
  let foundDist = Infinity;
  for (const item of BURIED_ITEMS) {
    if (_foundIds.has(item.id)) continue;
    const dx = item.x - _player.x;
    const dz = item.z - _player.z;
    const d  = Math.sqrt(dx * dx + dz * dz);
    if (d < DIG_RADIUS && d < foundDist) {
      found = item;
      foundDist = d;
    }
  }

  if (found) {
    _foundIds.add(found.id);
    saveFoundIds(_foundIds);
    setTimeout(() => _showFoundItem(found), 300);
  }
}

// ── Screen dirt particles ─────────────────────────────────────
function _spawnDirtParticles() {
  if (!_wrapper) return;
  const emojis = ['🪨', '🌱', '💨', '🪨', '🌿'];
  for (let i = 0; i < 5; i++) {
    const el       = document.createElement('div');
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    el.style.cssText = `
      position: absolute;
      font-size: ${14 + Math.random() * 12}px;
      left: ${46 + (Math.random() - 0.5) * 22}%;
      top: ${50 + (Math.random() - 0.5) * 15}%;
      pointer-events: none;
      z-index: 11;
      animation: digPart ${0.5 + Math.random() * 0.3}s ease-out both;
      transform-origin: center;
    `;
    _wrapper.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }
}

// ── Found-item notification ───────────────────────────────────
function _showFoundItem(item) {
  if (!_foundNotif) return;

  const icon  = _foundNotif.querySelector('.found-icon');
  const label = _foundNotif.querySelector('.found-label');
  const text  = _foundNotif.querySelector('.found-text');

  if (icon)  icon.textContent  = item.icon;
  if (label) label.textContent = item.rarity.toUpperCase() + ' ITEM FOUND!';
  if (text)  text.textContent  = item.name;

  // Colour the border by rarity
  const rareColour = {
    common:   '#00f5c4',
    uncommon: '#ffa502',
    rare:     '#a29bfe',
  }[item.rarity] || '#00f5c4';
  _foundNotif.style.borderColor = rareColour;
  _foundNotif.style.boxShadow   = `0 0 32px ${rareColour}55`;

  _foundNotif.classList.remove('hidden');

  // Success beep melody
  _beep(523, 0.1, 0.3);
  setTimeout(() => _beep(659, 0.1, 0.3), 120);
  setTimeout(() => _beep(784, 0.18, 0.35), 240);

  // Auto-hide after 3 seconds
  clearTimeout(_notifTimeout);
  _notifTimeout = setTimeout(() => {
    _foundNotif.classList.add('hidden');
  }, 3000);
}
