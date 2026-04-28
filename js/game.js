// ============================================================
//  WalkWorld 3D — game.js
//  Main entry point.
//  Orchestrates: settings → init → world → network → game loop
//                → HUD → compass → minimap → chat → cleanup
//
//  New HTML elements expected in game.html:
//    #compassCanvas   — horizontal CoD-style compass strip (top-centre)
//    #minimapCanvas   — top-down minimap canvas (top-right)
//    #settingsPanel   — hidden settings overlay
//    #settingsBtn     — HUD button that opens settings
//    #sensSlider      — <input type="range"> for mouse sensitivity
//    #sensValue       — <span> showing current sensitivity value
//    [data-bind="X"]  — buttons for remapping each action key
//    #settingsClose   — button inside settings panel to close it
// ============================================================

import { Player, camera, requestPointerLock, isPointerLocked } from './player.js';
import { Renderer }   from './renderer.js';
import { initWorld, getZoneName } from './world.js';
import { initObjects } from './objects.js';
import {
  joinGame,
  leaveGame,
  updatePosition,
  onPlayersUpdate,
  getPlayerCount,
  sendChat,
  onChat,
} from './network.js';
import {
  buildCharacter,
  getLocalCharConfig,
  saveLocalCharConfig,
  DEFAULT_CHAR_CONFIG,
} from './character.js';

// ============================================================
//  SETTINGS
//  Stored in sessionStorage so they persist across page reloads
//  but are wiped when the browser session ends.
//  Exposed on window so player.js can read them live.
// ============================================================
const DEFAULT_SENS  = 0.0022;
const DEFAULT_BINDS = {
  forward : 'KeyW',
  back    : 'KeyS',
  left    : 'KeyA',
  right   : 'KeyD',
  jump    : 'Space',
  sprint  : 'ShiftLeft',
  chat    : 'KeyT',
  map     : 'KeyM',
};

// Pretty-print a KeyboardEvent.code string for UI labels
function prettyCode(code) {
  const MAP = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Space: 'Space', ShiftLeft: 'L.Shift', ShiftRight: 'R.Shift',
    ControlLeft: 'L.Ctrl', ControlRight: 'R.Ctrl',
    AltLeft: 'L.Alt', AltRight: 'R.Alt',
  };
  return MAP[code] ?? code.replace('Key', '').replace('Digit', '');
}

function loadSettings() {
  try {
    const stored = JSON.parse(sessionStorage.getItem('ww_settings') || '{}');
    window.WALKWORLD_SENS  = stored.sens  ?? DEFAULT_SENS;
    window.WALKWORLD_BINDS = { ...DEFAULT_BINDS, ...(stored.binds || {}) };
  } catch {
    window.WALKWORLD_SENS  = DEFAULT_SENS;
    window.WALKWORLD_BINDS = { ...DEFAULT_BINDS };
  }
}

function saveSettings() {
  sessionStorage.setItem('ww_settings', JSON.stringify({
    sens:  window.WALKWORLD_SENS,
    binds: window.WALKWORLD_BINDS,
  }));
}

// ============================================================
//  DOM REFS
// ============================================================

// Overlays
const loadingOverlay      = document.getElementById('loadingOverlay');
const loadBar             = document.getElementById('loadBar');
const loadStatus          = document.getElementById('loadStatus');
const disconnectedOverlay = document.getElementById('disconnectedOverlay');
const gameWrapper         = document.getElementById('gameWrapper');
const gameCanvas          = document.getElementById('gameCanvas');

// HUD
const hudAvatar  = document.getElementById('hudAvatar');
const hudName    = document.getElementById('hudName');
const hudPos     = document.getElementById('hudPos');
const hudZone    = document.getElementById('hudZone');
const hudCount   = document.getElementById('hudCount');

// Compass — CoD canvas strip + fallback text label
const compassCanvas = document.getElementById('compassCanvas');
const compassCtx    = compassCanvas?.getContext('2d') ?? null;
const compassDir    = document.getElementById('compassDir'); // existing text span

// Minimap
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx    = minimapCanvas?.getContext('2d') ?? null;

// Chat
const chatMessages = document.getElementById('chatMessages');
const chatForm     = document.getElementById('chatForm');
const chatInput    = document.getElementById('chatInput');

// Pause menu
const pauseMenu  = document.getElementById('pauseMenu');
const btnSettings = document.getElementById('btnSettings');
const btnCharacter = document.getElementById('btnCharacter');
const sensSlider  = document.getElementById('spSensSlider');
const sensValueEl = document.getElementById('spSensVal');

// ============================================================
//  RUNTIME STATE
// ============================================================
let player        = null;
let renderer      = null;
let remotePlayers = {};
let lastTime      = 0;
let rafId         = null;
let isChatOpen    = false;
let isPauseOpen   = false;
let isMapOpen     = false;

let _lastPosSend = 0;
const POS_INTERVAL = 100; // ms between Firebase position writes (~10 Hz)

// ── Map overlay ──────────────────────────────────────────────
const MAP_ZOOM_MIN  = 1;
const MAP_ZOOM_MAX  = 8;
let   mapZoom       = 1;
let   _mapWorldCanvas = null; // cached background (one pixel per world unit)

const MAP_ZONE_COLS = {
  Forest: '#1a3a10',
  Plains: '#2d6b22',
  Lake:   '#1a5fa8',
  Cabin:  '#7a5428',
  Plaza:  '#606070',
};
const MAP_ZONE_LABELS = [
  { name: 'FOREST', wx: -60, wz: -40 },
  { name: 'PLAINS', wx:  28, wz:  30 },
  { name: 'LAKE',   wx:  62, wz:  55 },
  { name: 'CABIN',  wx:  55, wz: -62 },
  { name: 'PLAZA',  wx:   0, wz:   0 },
];

// ============================================================
//  BOOT
// ============================================================
async function init() {
  loadSettings();

  // Redirect to lobby if the player skipped name entry
  const name   = sessionStorage.getItem('playerName');
  const colour = sessionStorage.getItem('playerColour');
  if (!name) { window.location.href = 'index.html'; return; }

  setLoad(10, 'Building world…');
  await tick();

  // Build the 3D world (terrain, lighting, fog, water)
  initWorld();
  // Populate the scene (trees, rocks, cabin, plaza, etc.)
  initObjects();

  setLoad(30, 'Spawning player…');
  await tick();

  player   = new Player(name, colour);
  renderer = new Renderer(gameCanvas);

  // HUD identity chip
  hudAvatar.style.background = colour;
  hudName.textContent        = name;

  setLoad(50, 'Connecting to server…');
  await tick();

  // Firebase join
  try {
    await joinGame({
      name,
      colour,
      x:         player.x,
      y:         player.y,
      z:         player.z,
      rotationY: player.rotationY,
    });
  } catch (err) {
    console.error('[Game] joinGame failed:', err);
    showDisconnected();
    return;
  }

  setLoad(70, 'Syncing players…');
  await tick();

  onPlayersUpdate(players => {
    remotePlayers = players;
    // +1 to include the local player in the count
    hudCount.textContent = Object.keys(players).length + 1;
  });

  getPlayerCount(n => { hudCount.textContent = n; });

  setLoad(85, 'Loading chat…');
  await tick();

  onChat(msgs => renderChat(msgs));
  setupChat(name, colour);
  setupPointerLock();
  setupPauseMenu();
  buildMinimapCache();
  buildMapWorldCanvas();
  setupMap();
  initAvatarPreview();

  setLoad(100, 'Ready!');
  await delay(300);

  loadingOverlay.classList.add('hidden');
  gameWrapper.classList.remove('hidden');
  // Pointer lock will be acquired on first canvas click (no "click to play" overlay)

  lastTime = performance.now();
  rafId    = requestAnimationFrame(gameLoop);

  // Cleanup on page leave / tab close
  window.addEventListener('beforeunload', () => {
    leaveGame(name);
    if (rafId) cancelAnimationFrame(rafId);
  });

  // Pause / resume when tab is hidden / visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      // Open pause menu when tab loses focus (if gameplay is active)
      if (!isPauseOpen && !isChatOpen && !isMapOpen) {
        openPauseMenu();
      }
    } else {
      lastTime = performance.now();
      rafId = requestAnimationFrame(gameLoop);
    }
  });
}

// ============================================================
//  GAME LOOP
// ============================================================
function gameLoop(timestamp) {
  // Cap dt at 100 ms so a frozen tab doesn't cause a physics explosion
  const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime  = timestamp;

  // Only update player physics when gameplay is active
  if (!isChatOpen && !isPauseOpen) {
    player.update(dt);
  }

  // Network: throttled position sync
  if (timestamp - _lastPosSend > POS_INTERVAL) {
    updatePosition(player.x, player.y, player.z, player.rotationY);
    _lastPosSend = timestamp;
  }

  updateHUD();
  updateCompass();
  updateMinimap();
  if (isMapOpen) drawMap();

  renderer.draw(player, remotePlayers, timestamp);

  rafId = requestAnimationFrame(gameLoop);
}

// ============================================================
//  HUD
// ============================================================
function updateHUD() {
  hudPos.textContent  = `${player.x.toFixed(1)}, ${player.z.toFixed(1)}`;
  if (hudZone) hudZone.textContent = getZoneName(player.x, player.z);
}

// ============================================================
//  COD-STYLE COMPASS
//
//  Draws a horizontal scrolling strip showing degree marks and
//  cardinal/intercardinal labels (N NE E SE S SW W NW).
//  A downward triangle at the centre marks the current heading.
//
//  Falls back to updating the existing #compassDir text span
//  if no #compassCanvas element is present in the DOM.
// ============================================================
const CARDINAL = [
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'], [360, 'N'],
];

function updateCompass() {
  // Convert yaw (radians, left = positive) → compass bearing (0–360°, clockwise)
  const bearing = (((-player.yaw * 180) / Math.PI) % 360 + 360) % 360;

  // ── Text fallback (existing HUD span) ──
  if (compassDir) {
    const nearest = CARDINAL.reduce((best, cur) =>
      Math.abs(cur[0] - bearing) < Math.abs(best[0] - bearing) ? cur : best
    );
    compassDir.textContent = `${nearest[1]}  ${Math.round(bearing)}°`;
  }

  // ── Canvas compass strip ──
  if (!compassCtx || !compassCanvas) return;

  const W      = compassCanvas.width;
  const H      = compassCanvas.height;
  const DEG_PX = W / 90; // pixels per degree (90° visible range)

  compassCtx.clearRect(0, 0, W, H);

  // Background
  compassCtx.fillStyle = 'rgba(10,10,22,0.92)';
  compassCtx.fillRect(0, 0, W, H);

  // Accent border along the bottom edge
  compassCtx.fillStyle = 'rgba(0,245,196,0.55)';
  compassCtx.fillRect(0, H - 2, W, 2);

  // ── Minor / mid ticks at every integer offset from centre ──
  // These give the visual texture of the scrolling strip.
  for (let offset = -90; offset <= 90; offset++) {
    const sx = Math.round(W / 2 + offset * DEG_PX);
    // Classify tick by rounding the degree value at this integer offset.
    // We round bearing so that minor tick spacing stays consistent.
    const deg = ((Math.round(bearing) + offset) % 360 + 360) % 360;
    const isMajor = deg % 45 === 0;
    const isMid   = !isMajor && deg % 15 === 0;
    const isMinor = !isMajor && !isMid && deg % 5 === 0;

    if (isMajor) {
      // Drawn separately below using float positions — skip here
    } else if (isMid) {
      compassCtx.fillStyle = 'rgba(255,255,255,0.45)';
      const th = H * 0.30;
      compassCtx.fillRect(sx, (H - th) * 0.45, 1, th);
    } else if (isMinor) {
      compassCtx.fillStyle = 'rgba(255,255,255,0.18)';
      const th = H * 0.18;
      compassCtx.fillRect(sx, (H - th) * 0.5, 1, th);
    }
  }

  // ── Cardinal / intercardinal labels at their REAL fractional positions ──
  // By computing offset as a float we avoid the "only shows at 0°" bug where
  // integer iteration never lands exactly on a non-integer offset.
  compassCtx.font         = 'bold 10px "Courier New", monospace';
  compassCtx.textAlign    = 'center';
  compassCtx.textBaseline = 'bottom';

  CARDINAL.forEach(([cardDeg, label]) => {
    if (cardDeg === 360) return; // skip duplicate N
    // Float offset of this cardinal from the current bearing
    let offset = cardDeg - bearing;
    // Normalise to (−180, +180] so we pick the nearest crossing
    if (offset >  180) offset -= 360;
    if (offset < -180) offset += 360;
    if (Math.abs(offset) > 90) return; // outside visible window

    const sx = W / 2 + offset * DEG_PX;

    // Bold bright tick
    compassCtx.fillStyle = 'rgba(0,245,196,1)';
    compassCtx.fillRect(Math.round(sx) - 1, 2, 2, H * 0.55);

    // Label
    compassCtx.fillStyle = '#00f5c4';
    compassCtx.fillText(label, sx, H - 4);
  });

  // Centre marker — downward-pointing triangle at top edge
  compassCtx.fillStyle = '#ffffff';
  compassCtx.beginPath();
  compassCtx.moveTo(W / 2 - 6, 0);
  compassCtx.lineTo(W / 2 + 6, 0);
  compassCtx.lineTo(W / 2,     8);
  compassCtx.closePath();
  compassCtx.fill();

  // Degree readout in the centre notch area
  compassCtx.font      = 'bold 9px "Courier New", monospace';
  compassCtx.fillStyle = 'rgba(255,255,255,0.70)';
  compassCtx.textAlign = 'center';
  compassCtx.textBaseline = 'top';
  compassCtx.fillText(Math.round(bearing) + '°', W / 2, 10);
}

// ============================================================
//  MINIMAP
//  2D top-down overview using coloured zone rectangles.
//  The static background is rendered once to an OffscreenCanvas
//  and composited each frame — player/remote dots drawn on top.
// ============================================================
const MINI_COLOURS = {
  Forest: '#1a3a10',
  Plains: '#2d6b22',
  Lake:   '#1a5fa8',
  Cabin:  '#7a5428',
  Plaza:  '#606070',
};

// Zone rectangles in world-space (world centre = 0,0, range ±100)
const MINI_ZONES = [
  { x: -100, z: -100, w: 75,  h: 118, zone: 'Forest' },
  { x: -25,  z: -100, w: 125, h: 200, zone: 'Plains' },
  { x:  40,  z:  16,  w: 60,  h: 84,  zone: 'Lake'   },
  { x:  30,  z: -100, w: 70,  h: 70,  zone: 'Cabin'  },
  { x: -22,  z: -18,  w: 44,  h: 36,  zone: 'Plaza'  },
];

let _minimapBg = null; // cached ImageBitmap of the static background

function buildMinimapCache() {
  if (!minimapCtx || !minimapCanvas) return;

  const W    = minimapCanvas.width;
  const H    = minimapCanvas.height;
  const WORLD = 200;
  const off   = new OffscreenCanvas(W, H);
  const ctx   = off.getContext('2d');

  MINI_ZONES.forEach(({ x, z, w, h, zone }) => {
    ctx.fillStyle = MINI_COLOURS[zone];
    ctx.fillRect(
      ((x + 100) / WORLD) * W,
      ((z + 100) / WORLD) * H,
      (w / WORLD) * W,
      (h / WORLD) * H,
    );
  });

  // Border
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  _minimapBg = off.transferToImageBitmap();
}

function updateMinimap() {
  if (!minimapCtx || !minimapCanvas || !_minimapBg) return;

  const W     = minimapCanvas.width;
  const H     = minimapCanvas.height;
  const WORLD = 200;

  // Composite static background
  minimapCtx.drawImage(_minimapBg, 0, 0);

  // World-space → minimap pixel
  const toM = (wx, wz) => ({
    mx: ((wx + 100) / WORLD) * W,
    mz: ((wz + 100) / WORLD) * H,
  });

  // Remote player dots (colour-coded)
  for (const p of Object.values(remotePlayers)) {
    const { mx, mz } = toM(p.x, p.z);
    minimapCtx.fillStyle = p.colour || '#ffffff';
    minimapCtx.beginPath();
    minimapCtx.arc(mx, mz, 2.5, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  // Local player — white dot with player-colour ring + heading tick
  const { mx: lx, mz: lz } = toM(player.x, player.z);

  minimapCtx.fillStyle   = '#ffffff';
  minimapCtx.strokeStyle = player.colour;
  minimapCtx.lineWidth   = 1.5;
  minimapCtx.beginPath();
  minimapCtx.arc(lx, lz, 3.5, 0, Math.PI * 2);
  minimapCtx.fill();
  minimapCtx.stroke();

  // Heading tick (7 px line in facing direction)
  const bearing = -player.yaw; // world-space bearing (radians, CW from -Z)
  minimapCtx.strokeStyle = '#ffffff';
  minimapCtx.lineWidth   = 1.5;
  minimapCtx.beginPath();
  minimapCtx.moveTo(lx, lz);
  minimapCtx.lineTo(lx + Math.sin(bearing) * 7, lz - Math.cos(bearing) * 7);
  minimapCtx.stroke();
}

// ============================================================
//  WORLD MAP  (M key — expandable fullscreen overlay)
//
//  _mapWorldCanvas  — 200×200 px canvas, one px per world unit,
//                     baked once with zone colours.
//  openMap()        — sizes the overlay canvas, shows the modal
//  closeMap()       — hides modal, re-acquires pointer lock
//  drawMap()        — called every frame when map is open;
//                     draws zones → labels → remote dots → local
//  setupMap()       — wires up buttons and scroll-wheel zoom
// ============================================================

function buildMapWorldCanvas() {
  const SIZE = 200; // 1 px per world unit (world is ±100 on each axis)
  _mapWorldCanvas = document.createElement('canvas');
  _mapWorldCanvas.width  = SIZE;
  _mapWorldCanvas.height = SIZE;
  const ctx = _mapWorldCanvas.getContext('2d');

  // Sample every 2 world units (100×100 cells, each 2 px)
  for (let iz = 0; iz < SIZE; iz += 2) {
    for (let ix = 0; ix < SIZE; ix += 2) {
      const wx = ix - 100;
      const wz = iz - 100;
      ctx.fillStyle = MAP_ZONE_COLS[getZoneName(wx, wz)] || '#1a3a10';
      ctx.fillRect(ix, iz, 2, 2);
    }
  }

  // World border
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
}

function openMap() {
  const mapCanvas = document.getElementById('mapCanvas');
  if (!mapCanvas) return;

  // Size the canvas to ~80 % of the smaller screen dimension, max 700 px
  const sz = Math.min(Math.floor(window.innerWidth * 0.78),
                      Math.floor(window.innerHeight * 0.75), 700);
  mapCanvas.width  = sz;
  mapCanvas.height = sz;

  mapZoom = 1;
  _updateMapZoomUI();

  isMapOpen = true;
  document.getElementById('mapOverlay')?.classList.remove('hidden');
  if (isPointerLocked()) document.exitPointerLock();
}

function closeMap() {
  isMapOpen = false;
  document.getElementById('mapOverlay')?.classList.add('hidden');
  // Re-acquire pointer lock automatically
  requestPointerLock(gameCanvas);
}

function _updateMapZoomUI() {
  const el = document.getElementById('mapZoomDisplay');
  if (el) el.textContent = mapZoom.toFixed(1) + '×';
}

function drawMap() {
  const mapCanvas = document.getElementById('mapCanvas');
  if (!mapCanvas || !_mapWorldCanvas) return;
  const ctx = mapCanvas.getContext('2d');
  if (!ctx) return;

  const W = mapCanvas.width;
  const H = mapCanvas.height;

  // ── Background ──────────────────────────────────────────
  ctx.fillStyle = '#0a0a16';
  ctx.fillRect(0, 0, W, H);

  // ── World image: scale+pan via drawImage source rect ────
  //
  // At zoom=1  → full 200×200 world fits the canvas.
  //   srcW = srcH = 200,  srcX = srcY = 0
  // At zoom>1  → we see only (200/zoom) world units.
  //   We centre on the player.
  //
  const WORLD = 200;
  const srcSide = WORLD / mapZoom;
  // Centre of view in world-canvas pixels (0…200)
  const cx = mapZoom > 1.2 ? (player.x + 100) : WORLD / 2;
  const cz = mapZoom > 1.2 ? (player.z + 100) : WORLD / 2;
  const srcX = Math.max(0, Math.min(WORLD - srcSide, cx - srcSide / 2));
  const srcZ = Math.max(0, Math.min(WORLD - srcSide, cz - srcSide / 2));

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(_mapWorldCanvas, srcX, srcZ, srcSide, srcSide, 0, 0, W, H);

  // ── Grid lines every 25 world units (major zones) ───────
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = 1;
  const gridStep  = 25; // world units
  const scale     = W / srcSide;
  for (let gw = Math.ceil((srcX - srcX % gridStep) / gridStep) * gridStep;
       gw <= srcX + srcSide; gw += gridStep) {
    const sx = (gw - srcX) * scale;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
  }
  for (let gz = Math.ceil((srcZ - srcZ % gridStep) / gridStep) * gridStep;
       gz <= srcZ + srcSide; gz += gridStep) {
    const sy = (gz - srcZ) * scale;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
  }

  // ── Helper: world → canvas px ───────────────────────────
  // wx/wz in world coords (±100).  srcX/srcZ are in world-canvas px (0…200).
  const toC = (wx, wz) => ({
    cx: ((wx + 100) - srcX) * scale,
    cy: ((wz + 100) - srcZ) * scale,
  });

  // ── Zone labels ──────────────────────────────────────────
  const labelSize = Math.max(8, Math.min(12, 9 * mapZoom * 0.5));
  ctx.font        = `bold ${labelSize}px "Courier New", monospace`;
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';
  MAP_ZONE_LABELS.forEach(({ name, wx, wz }) => {
    const { cx: lx, cy: ly } = toC(wx, wz);
    if (lx < -30 || lx > W + 30 || ly < -20 || ly > H + 20) return;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(name, lx, ly);
  });

  // ── Remote player dots ───────────────────────────────────
  const dotR = Math.max(3, 3.5 * Math.min(mapZoom, 3) * 0.5);
  ctx.textBaseline = 'bottom';
  ctx.font = `${Math.max(10, 11 * mapZoom * 0.4)}px "VT323", monospace`;
  for (const p of Object.values(remotePlayers)) {
    const { cx: px, cy: py } = toC(p.x ?? 0, p.z ?? 0);
    if (px < -12 || px > W + 12 || py < -12 || py > H + 12) continue;
    ctx.fillStyle = p.colour || '#ffffff';
    ctx.beginPath();
    ctx.arc(px, py, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.80)';
    ctx.textAlign = 'center';
    ctx.fillText(p.name || '?', px, py - dotR - 1);
  }

  // ── Local player ─────────────────────────────────────────
  const { cx: lx, cy: ly } = toC(player.x, player.z);

  // Pulse ring
  ctx.strokeStyle = 'rgba(0,245,196,0.40)';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.arc(lx, ly, 11, 0, Math.PI * 2);
  ctx.stroke();

  // Filled dot
  ctx.fillStyle   = '#ffffff';
  ctx.strokeStyle = '#00f5c4';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.arc(lx, ly, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Direction arrow
  const bearing  = -player.yaw;
  const arrowLen = Math.max(14, 14 * Math.min(mapZoom, 3) * 0.5);
  ctx.strokeStyle = '#00f5c4';
  ctx.lineWidth   = 2.5;
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(lx + Math.sin(bearing) * arrowLen, ly - Math.cos(bearing) * arrowLen);
  ctx.stroke();

  // Player name
  ctx.font        = `bold 10px "Courier New", monospace`;
  ctx.fillStyle   = '#00f5c4';
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(player.name, lx, ly - 13);

  // ── HUD overlay (zoom level, coords, hint) ───────────────
  ctx.textBaseline = 'top';
  ctx.textAlign    = 'left';
  ctx.fillStyle    = 'rgba(0,245,196,0.90)';
  ctx.font         = 'bold 11px "Courier New", monospace';
  ctx.fillText(`${mapZoom.toFixed(1)}×`, 10, 10);

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font      = '10px "Courier New", monospace';
  ctx.fillText(`${Math.round(player.x)}, ${Math.round(player.z)}`, 10, 28);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText('M · Close  |  Scroll · Zoom', W - 10, 10);
}

function setupMap() {
  document.getElementById('mapClose')?.addEventListener('click', closeMap);

  document.getElementById('mapZoomIn')?.addEventListener('click', () => {
    mapZoom = Math.min(MAP_ZOOM_MAX, parseFloat((mapZoom * 1.5).toFixed(2)));
    _updateMapZoomUI();
  });

  document.getElementById('mapZoomOut')?.addEventListener('click', () => {
    mapZoom = Math.max(MAP_ZOOM_MIN, parseFloat((mapZoom / 1.5).toFixed(2)));
    _updateMapZoomUI();
  });

  // Scroll-wheel zoom on the overlay
  document.getElementById('mapOverlay')?.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    mapZoom = Math.max(MAP_ZOOM_MIN, Math.min(MAP_ZOOM_MAX,
      parseFloat((mapZoom * factor).toFixed(2))
    ));
    _updateMapZoomUI();
  }, { passive: false });
}
function setupPointerLock() {
  // Clicking the canvas captures the mouse (no "click to play" overlay needed)
  gameCanvas.addEventListener('click', () => {
    if (!isPointerLocked()) requestPointerLock(gameCanvas);
  });

  // pointerlockchange: open the pause menu whenever the browser releases
  // pointer lock.  Chrome intercepts the FIRST ESC to show its
  // "press and hold ESC to exit" notification (consuming that keydown),
  // so the keydown handler alone requires two ESC presses.  Hooking
  // pointerlockchange means we react the instant the lock drops —
  // regardless of whether Chrome swallowed the keydown or not.
  document.addEventListener('pointerlockchange', () => {
    if (!isPointerLocked() && !isChatOpen && !isMapOpen && !isPauseOpen) {
      openPauseMenu();
    }
  });

  document.addEventListener('pointerlockerror', () => {
    console.warn('[Game] Pointer lock request denied.');
  });
}

// ============================================================
//  CHAT
// ============================================================
function setupChat(name, colour) {
  document.addEventListener('keydown', e => {
    const binds  = window.WALKWORLD_BINDS || DEFAULT_BINDS;
    const chatKey = binds.chat;
    const mapKey  = binds.map || 'KeyM';

    // Map toggle — works whenever gameplay is live (not in chat/pause)
    if (e.code === mapKey && !isChatOpen && !isPauseOpen) {
      e.preventDefault();
      isMapOpen ? closeMap() : openMap();
      return;
    }

    if (e.code === chatKey && !isChatOpen && !isPauseOpen && isPointerLocked()) {
      e.preventDefault();
      openChat();
      return;
    }

    if (e.code === 'Escape') {
      e.preventDefault();
      if (isMapOpen)   { closeMap();       return; }
      if (isChatOpen)  { closeChat();      return; }
      if (isPauseOpen) { closePauseMenu(); return; }
      // Always open the menu on ESC — whether pointer is locked or not.
      // (Previously this only opened when !isPointerLocked(), which caused the
      // menu to not open when Chrome released the lock before the keydown fired.)
      openPauseMenu();
      return;
    }
  });

  chatForm.addEventListener('submit', e => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    sendChat({ name, colour, text });
    renderer.addBubble('local', text);
    chatInput.value = '';
    closeChat();
  });
}

function openChat() {
  isChatOpen = true;
  chatInput.disabled = false;
  chatInput.focus();
  if (isPointerLocked()) document.exitPointerLock();
}

function closeChat() {
  isChatOpen = false;
  chatInput.disabled = true;
  chatInput.blur();
  // Re-acquire pointer lock so user can look around immediately
  requestPointerLock(gameCanvas);
}

function renderChat(messages) {
  chatMessages.innerHTML = '';

  messages.forEach(m => {
    const div = document.createElement('div');
    div.className = 'chat-msg' + (m.system ? ' sys-msg' : '');

    if (m.name && !m.system) {
      const nameSpan = document.createElement('span');
      nameSpan.className   = 'msg-name';
      nameSpan.style.color = m.colour || '#ffffff';
      nameSpan.textContent = m.name;
      div.appendChild(nameSpan);
    }

    const textSpan = document.createElement('span');
    textSpan.className   = 'msg-text';
    textSpan.textContent = m.text;
    div.appendChild(textSpan);

    // Trigger a bubble on the matching remote player
    if (!m.system && m.name) {
      for (const [id, p] of Object.entries(remotePlayers)) {
        if (p.name === m.name) { renderer.addBubble(id, m.text); break; }
      }
    }

    chatMessages.appendChild(div);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ============================================================
//  PAUSE MENU
// ============================================================

function setupPauseMenu() {
  if (!pauseMenu) return;

  // ── HUD buttons ──────────────────────────────────────────
  btnSettings?.addEventListener('click', () => {
    isPauseOpen ? closePauseMenu() : openPauseMenu('main');
  });

  btnCharacter?.addEventListener('click', () => {
    openPauseMenu('avatar');
  });

  // ── Nav items (Settings / Avatar) ────────────────────────
  pauseMenu.querySelectorAll('[data-pm-tab]').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.pmTab));
  });

  // ── Back buttons (return to main screen) ─────────────────
  pauseMenu.querySelectorAll('[data-pm-back]').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.pmBack));
  });

  // ── Resume ───────────────────────────────────────────────
  document.getElementById('pmResume')?.addEventListener('click', closePauseMenu);

  // ── Leave ────────────────────────────────────────────────
  document.getElementById('pmLeave')?.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  // ── Reset Character ──────────────────────────────────────
  document.getElementById('pmResetChar')?.addEventListener('click', () => {
    if (player) {
      player.x = 0;
      player.y = 2.0;
      player.z = 5;
      player.vy = 0;
      player.onGround = false;
    }
    closePauseMenu();
  });

  // ── Sensitivity slider ───────────────────────────────────
  if (sensSlider) {
    sensSlider.value = String(window.WALKWORLD_SENS);
    if (sensValueEl) sensValueEl.textContent = Number(window.WALKWORLD_SENS).toFixed(4);

    sensSlider.addEventListener('input', () => {
      window.WALKWORLD_SENS = parseFloat(sensSlider.value);
      if (sensValueEl) sensValueEl.textContent = parseFloat(sensSlider.value).toFixed(4);
      saveSettings();
    });
  }

  // ── Key bind buttons ─────────────────────────────────────
  document.querySelectorAll('[data-bind]').forEach(btn => {
    const action = btn.dataset.bind;
    btn.textContent = prettyCode((window.WALKWORLD_BINDS || {})[action] || action);

    btn.addEventListener('click', () => {
      const prev = btn.textContent;
      btn.textContent = '…';
      btn.classList.add('sp-listening');

      const capture = e => {
        e.preventDefault(); e.stopImmediatePropagation();
        window.WALKWORLD_BINDS[action] = e.code;
        btn.textContent = prettyCode(e.code);
        btn.classList.remove('sp-listening');
        saveSettings();
        window.removeEventListener('keydown', capture, true);
        window.removeEventListener('keydown', cancel,  true);
      };
      const cancel = e => {
        if (e.code !== 'Escape') return;
        btn.textContent = prev;
        btn.classList.remove('sp-listening');
        window.removeEventListener('keydown', capture, true);
        window.removeEventListener('keydown', cancel,  true);
      };
      window.addEventListener('keydown', capture, true);
      window.addEventListener('keydown', cancel,  true);
    });
  });

  // ── Reset defaults ───────────────────────────────────────
  document.getElementById('spReset')?.addEventListener('click', () => {
    window.WALKWORLD_SENS  = DEFAULT_SENS;
    window.WALKWORLD_BINDS = { ...DEFAULT_BINDS };
    saveSettings();
    if (sensSlider)   sensSlider.value = String(DEFAULT_SENS);
    if (sensValueEl)  sensValueEl.textContent = DEFAULT_SENS.toFixed(4);
    document.querySelectorAll('[data-bind]').forEach(b => {
      b.textContent = prettyCode(DEFAULT_BINDS[b.dataset.bind]);
    });
  });
}

function _switchTab(tabName) {
  const pmMain         = document.getElementById('pmMain');
  const pmTabSettings  = document.getElementById('pmTabSettings');
  const pmTabAvatar    = document.getElementById('pmTabAvatar');

  // Show/hide panels based on which tab is active
  pmMain?.classList.toggle('pm-hidden', tabName !== 'main');
  pmTabSettings?.classList.toggle('pm-hidden', tabName !== 'settings');
  pmTabAvatar?.classList.toggle('pm-hidden', tabName !== 'avatar');

  // Kick off avatar preview spin when avatar tab opens
  if (tabName === 'avatar') _tickAvatarPreview();
}

function openPauseMenu(tab = 'main') {
  isPauseOpen = true;
  pauseMenu.classList.remove('hidden');
  btnSettings?.classList.add('active');
  if (isPointerLocked()) document.exitPointerLock();
  _switchTab(tab);
  if (sensSlider)  sensSlider.value = String(window.WALKWORLD_SENS);
  if (sensValueEl) sensValueEl.textContent = Number(window.WALKWORLD_SENS).toFixed(4);
}

function closePauseMenu() {
  isPauseOpen = false;
  pauseMenu?.classList.add('hidden');
  btnSettings?.classList.remove('active');
  // Re-acquire pointer lock automatically.
  // We use a short timeout because browsers block requestPointerLock()
  // when it's called in the same event tick that ESC released the lock.
  // Giving the browser one frame to clear that block makes it reliable.
  gameCanvas.focus();
  setTimeout(() => {
    if (!isPauseOpen && !isChatOpen && !isMapOpen) {
      requestPointerLock(gameCanvas);
    }
  }, 80);
}

// ============================================================
//  AVATAR PREVIEW (inside pause menu Avatar tab)
// ============================================================
const SKIN_PRESETS  = ['#f0c890','#d4956a','#a0643a','#7a3f20','#4a2010','#ffe0d0'];
const SHIRT_PRESETS = ['#1e90ff','#e03030','#2ed573','#ffa502','#a29bfe','#fd79a8','#ffffff','#333355'];
const PANTS_PRESETS = ['#2c2c3a','#1a3a6a','#3a2010','#2a4a2a','#555555','#8b6914','#000000','#4a0a0a'];
const HAIR_PRESETS  = ['#3a2010','#1a1a1a','#c8a020','#e08030','#a0a0a0','#ffffff','#e03030','#4060c0'];
const HAIR_STYLES   = ['none','straight','afro','spiky','bun'];

let _avPrevRenderer = null;
let _avPrevScene    = null;
let _avPrevCam      = null;
let _avPrevGroup    = null;
let _avSpinning     = false;

function initAvatarPreview() {
  const canvas = document.getElementById('pmPreviewCanvas');
  if (!canvas || typeof THREE === 'undefined') return;

  const W = 110, H = 160;
  _avPrevRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  _avPrevRenderer.setSize(W, H);
  _avPrevRenderer.setClearColor(0x000000, 0);

  _avPrevScene = new THREE.Scene();
  _avPrevScene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dl = new THREE.DirectionalLight(0xfff0cc, 0.9);
  dl.position.set(2, 4, 3);
  _avPrevScene.add(dl);

  _avPrevCam = new THREE.PerspectiveCamera(42, W / H, 0.1, 50);
  _avPrevCam.position.set(0, 1.0, 3.5);
  _avPrevCam.lookAt(0, 1.0, 0);

  // Build swatch grids + hair buttons
  _buildSwatches('pmSwatchSkin',  SKIN_PRESETS,  'skinColour');
  _buildSwatches('pmSwatchShirt', SHIRT_PRESETS, 'shirtColour');
  _buildSwatches('pmSwatchPants', PANTS_PRESETS, 'pantsColour');
  _buildSwatches('pmSwatchHair',  HAIR_PRESETS,  'hairColour');
  _buildHairBtns();

  // Height slider
  const hSlider = document.getElementById('pmHeightSlider');
  const hVal    = document.getElementById('pmHeightVal');
  if (hSlider) {
    const cfg = getLocalCharConfig();
    hSlider.value = cfg.height;
    if (hVal) hVal.textContent = Number(cfg.height).toFixed(2) + '×';
    hSlider.addEventListener('input', () => {
      const cfg2 = getLocalCharConfig();
      cfg2.height = parseFloat(hSlider.value);
      if (hVal) hVal.textContent = cfg2.height.toFixed(2) + '×';
      saveLocalCharConfig(cfg2);
      _rebuildAvPreview();
    });
  }

  // Avatar reset
  document.getElementById('pmAvatarReset')?.addEventListener('click', () => {
    saveLocalCharConfig({ ...DEFAULT_CHAR_CONFIG });
    _syncAvSwatches();
    const hSl = document.getElementById('pmHeightSlider');
    const hV  = document.getElementById('pmHeightVal');
    if (hSl) hSl.value = DEFAULT_CHAR_CONFIG.height;
    if (hV)  hV.textContent = DEFAULT_CHAR_CONFIG.height.toFixed(2) + '×';
    _rebuildAvPreview();
  });

  _rebuildAvPreview();
  _syncAvSwatches();
}

function _buildSwatches(containerId, presets, field) {
  const el = document.getElementById(containerId);
  if (!el) return;
  presets.forEach(colour => {
    const btn = document.createElement('button');
    btn.className = 'pm-av-swatch';
    btn.style.background = colour;
    btn.dataset.field  = field;
    btn.dataset.colour = colour;
    btn.setAttribute('aria-label', colour);
    btn.addEventListener('click', () => {
      const cfg = getLocalCharConfig();
      cfg[field] = colour;
      saveLocalCharConfig(cfg);
      _syncAvSwatches();
      _rebuildAvPreview();
    });
    el.appendChild(btn);
  });
}

function _buildHairBtns() {
  const el = document.getElementById('pmHairBtns');
  if (!el) return;
  HAIR_STYLES.forEach(style => {
    const btn = document.createElement('button');
    btn.className = 'pm-av-hair-btn';
    btn.textContent = style;
    btn.dataset.hair = style;
    btn.addEventListener('click', () => {
      const cfg = getLocalCharConfig();
      cfg.hairStyle = style;
      saveLocalCharConfig(cfg);
      document.querySelectorAll('.pm-av-hair-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.hair === style)
      );
      _rebuildAvPreview();
    });
    el.appendChild(btn);
  });
}

function _syncAvSwatches() {
  const cfg = getLocalCharConfig();
  document.querySelectorAll('.pm-av-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.colour === cfg[btn.dataset.field]);
  });
  document.querySelectorAll('.pm-av-hair-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.hair === cfg.hairStyle);
  });
}

function _rebuildAvPreview() {
  if (!_avPrevScene) return;
  if (_avPrevGroup) _avPrevScene.remove(_avPrevGroup);
  _avPrevGroup = buildCharacter(getLocalCharConfig());
  _avPrevScene.add(_avPrevGroup);
  _renderAvPreview();
}

function _renderAvPreview() {
  if (!_avPrevRenderer || !_avPrevScene) return;
  if (_avPrevGroup) _avPrevGroup.rotation.y += 0.015;
  _avPrevRenderer.render(_avPrevScene, _avPrevCam);
}

function _tickAvatarPreview() {
  if (_avSpinning) return;
  _avSpinning = true;
  const tick = () => {
    const avatarTabVisible = !document.getElementById('pmTabAvatar')?.classList.contains('pm-hidden');
    if (!isPauseOpen || !avatarTabVisible) { _avSpinning = false; return; }
    _renderAvPreview();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ============================================================
//  HELPERS
// ============================================================
function setLoad(pct, msg) {
  loadBar.style.width    = pct + '%';
  loadStatus.textContent = msg;
}

function showDisconnected() {
  loadingOverlay.classList.add('hidden');
  disconnectedOverlay.classList.remove('hidden');
}

const tick  = () => new Promise(r => requestAnimationFrame(r));
const delay = ms  => new Promise(r => setTimeout(r, ms));

// ============================================================
//  START
// ============================================================
init().catch(err => {
  console.error('[Game] Fatal init error:', err);
  showDisconnected();
});
