// ============================================================
//  WalkWorld 3D — objects.js
// ============================================================

import { scene, HALF, WATER_Y, getHeightAt, getZoneName, isBlocked } from './world.js';

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

const _m4  = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _rot = new THREE.Euler();
const _scl = new THREE.Vector3();
const _q   = new THREE.Quaternion();

function setMatrix(mesh, idx, x, y, z, ry, sx, sy, sz) {
  _pos.set(x, y, z); _rot.set(0, ry, 0); _scl.set(sx, sy, sz);
  _q.setFromEuler(_rot); _m4.compose(_pos, _q, _scl);
  mesh.setMatrixAt(idx, _m4);
}

const MAT = {
  foliageDark:  new THREE.MeshLambertMaterial({ color: 0x1a4a10 }),
  foliageMid:   new THREE.MeshLambertMaterial({ color: 0x265c17 }),
  foliageLight: new THREE.MeshLambertMaterial({ color: 0x2e7020 }),
  trunk:        new THREE.MeshLambertMaterial({ color: 0x5c3d1e }),
  rockGrey:     new THREE.MeshLambertMaterial({ color: 0x707880 }),
  rockBrown:    new THREE.MeshLambertMaterial({ color: 0x6a5545 }),
  petalRed:     new THREE.MeshLambertMaterial({ color: 0xe03030 }),
  petalYellow:  new THREE.MeshLambertMaterial({ color: 0xe0c020 }),
  petalWhite:   new THREE.MeshLambertMaterial({ color: 0xe8e8e0 }),
  stem:         new THREE.MeshLambertMaterial({ color: 0x3a6010 }),
  cap:          new THREE.MeshLambertMaterial({ color: 0xb03018 }),
  stalk:        new THREE.MeshLambertMaterial({ color: 0xd0c8a8 }),
  wood:         new THREE.MeshLambertMaterial({ color: 0x8b5e2e }),
  roof:         new THREE.MeshLambertMaterial({ color: 0x4a2010 }),
  window_:      new THREE.MeshLambertMaterial({ color: 0x9adcf0, transparent: true, opacity: 0.7 }),
  door:         new THREE.MeshLambertMaterial({ color: 0x5a3010 }),
  chimney:      new THREE.MeshLambertMaterial({ color: 0x6a6060 }),
  signPost:     new THREE.MeshLambertMaterial({ color: 0x9a7040 }),
  signBoard:    new THREE.MeshLambertMaterial({ color: 0xc8a060 }),
};

const GEO = {
  coneTop: new THREE.ConeGeometry(1.3, 2.2, 7),
  coneMid: new THREE.ConeGeometry(1.7, 2.0, 7),
  coneBot: new THREE.ConeGeometry(2.1, 1.8, 7),
  trunky:  new THREE.CylinderGeometry(0.18, 0.26, 2.0, 6),
  rock:    new THREE.IcosahedronGeometry(0.8, 0),
  petal:   new THREE.CylinderGeometry(0.28, 0.18, 0.12, 5),
  stemG:   new THREE.CylinderGeometry(0.05, 0.05, 0.55, 4),
  mCap:    new THREE.CylinderGeometry(0.55, 0.10, 0.50, 7),
  mStalk:  new THREE.CylinderGeometry(0.16, 0.20, 0.55, 6),
  box:     new THREE.BoxGeometry(1, 1, 1),
};

const MAX_FOREST_TREES = 220;
const MAX_PLAIN_TREES  = 130;
const MAX_ALL_TREES    = MAX_FOREST_TREES + MAX_PLAIN_TREES;

function buildTrees() {
  const meshTop   = new THREE.InstancedMesh(GEO.coneTop, MAT.foliageDark,  MAX_ALL_TREES);
  const meshMid   = new THREE.InstancedMesh(GEO.coneMid, MAT.foliageMid,   MAX_ALL_TREES);
  const meshBot   = new THREE.InstancedMesh(GEO.coneBot, MAT.foliageLight, MAX_ALL_TREES);
  const meshTrunk = new THREE.InstancedMesh(GEO.trunky,  MAT.trunk,        MAX_ALL_TREES);
  meshTop.castShadow = meshMid.castShadow = meshBot.castShadow = true;

  let idx = 0;

  function placeTree(x, z, sc, ry) {
    const ground = getHeightAt(x, z);
    const trunkH = 2.0 * sc;
    setMatrix(meshTrunk, idx, x, ground + trunkH * 0.5, z, ry, sc, sc, sc);
    const base = ground + trunkH;
    setMatrix(meshBot, idx, x, base + 0.80 * sc, z, ry, sc, sc, sc);
    setMatrix(meshMid, idx, x, base + 1.90 * sc, z, ry, sc, sc, sc);
    setMatrix(meshTop, idx, x, base + 2.90 * sc, z, ry, sc, sc, sc);
    idx++;
  }

  const rngF = makeRng(0xF0AE5700);
  const FSTEP = 5.5;
  for (let fx = -HALF + 3; fx < -22; fx += FSTEP) {
    for (let fz = -HALF + 3; fz < 20; fz += FSTEP) {
      if (idx >= MAX_FOREST_TREES) break;
      const jx = fx + (rngF() - 0.5) * 4.0;
      const jz = fz + (rngF() - 0.5) * 4.0;
      if (isBlocked(jx, jz) || getZoneName(jx, jz) !== 'Forest') continue;
      placeTree(jx, jz, 0.65 + rngF() * 0.60, rngF() * Math.PI * 2);
    }
    if (idx >= MAX_FOREST_TREES) break;
  }

  const rngP = makeRng(0xA1A1A100);
  let plainCount = 0;
  while (plainCount < MAX_PLAIN_TREES) {
    const x = (rngP() * 2 - 1) * (HALF - 4);
    const z = (rngP() * 2 - 1) * (HALF - 4);
    if (isBlocked(x, z)) { plainCount++; continue; }
    const zone = getZoneName(x, z);
    if (zone === 'Forest' || zone === 'Plaza' || zone === 'Lake') { plainCount++; continue; }
    if (zone === 'Cabin' && rngP() > 0.15) { plainCount++; continue; }
    if (idx >= MAX_ALL_TREES) break;
    placeTree(x, z, 0.55 + rngP() * 0.75, rngP() * Math.PI * 2);
    plainCount++;
  }

  [meshTrunk, meshTop, meshMid, meshBot].forEach(m => {
    m.count = idx;
    m.instanceMatrix.needsUpdate = true;
  });
  scene.add(meshTrunk, meshTop, meshMid, meshBot);
}

const MAX_ROCKS = 140;

function buildRocks() {
  const meshGrey  = new THREE.InstancedMesh(GEO.rock, MAT.rockGrey,  MAX_ROCKS);
  const meshBrown = new THREE.InstancedMesh(GEO.rock, MAT.rockBrown, MAX_ROCKS);
  let ig = 0, ib = 0;
  const rng = makeRng(0xA0C05500);

  function placeRock(x, z, useBrown) {
    const ground = getHeightAt(x, z);
    const sx = 0.4 + rng() * 1.0, sy = 0.3 + rng() * 0.7, sz = 0.4 + rng() * 0.9;
    const ry = rng() * Math.PI * 2;
    if (useBrown && ib < MAX_ROCKS) { setMatrix(meshBrown, ib++, x, ground + sy * 0.4, z, ry, sx, sy, sz); }
    else if (!useBrown && ig < MAX_ROCKS) { setMatrix(meshGrey,  ig++, x, ground + sy * 0.4, z, ry, sx, sy, sz); }
  }

  for (let i = 0; i < 300; i++) {
    const x = (rng() * 2 - 1) * (HALF - 5);
    const z = (rng() * 2 - 1) * (HALF - 5);
    if (isBlocked(x, z)) continue;
    const zone = getZoneName(x, z);
    if (zone === 'Plaza') continue;
    placeRock(x, z, zone === 'Forest' || zone === 'Cabin');
  }

  meshGrey.count  = ig; meshBrown.count = ib;
  meshGrey.instanceMatrix.needsUpdate  = true;
  meshBrown.instanceMatrix.needsUpdate = true;
  scene.add(meshGrey, meshBrown);
}

function buildFlowers() {
  const petalMats = [MAT.petalRed, MAT.petalYellow, MAT.petalWhite];
  const MAX_F = 180;
  const meshPetals = petalMats.map(m => new THREE.InstancedMesh(GEO.petal, m, MAX_F));
  const meshStems  = new THREE.InstancedMesh(GEO.stemG, MAT.stem, MAX_F * 3);
  let counts = [0, 0, 0], is = 0;
  const rng = makeRng(0xF10E5A00);

  for (let i = 0; i < 600 && counts.every(c => c < MAX_F); i++) {
    const x = (rng() * 2 - 1) * (HALF - 4);
    const z = (rng() * 2 - 1) * (HALF - 4);
    if (isBlocked(x, z)) continue;
    const zone = getZoneName(x, z);
    if (zone === 'Plaza' || zone === 'Lake' || zone === 'Cabin') continue;
    const t   = Math.floor(rng() * 3);
    const idx = counts[t];
    if (idx >= MAX_F) continue;
    const ground = getHeightAt(x, z);
    setMatrix(meshPetals[t], idx, x, ground + 0.57, z, rng() * Math.PI * 2, 1, 1, 1);
    if (is < MAX_F * 3) setMatrix(meshStems, is++, x, ground + 0.28, z, 0, 1, 1, 1);
    counts[t]++;
  }

  meshPetals.forEach((m, i) => { m.count = counts[i]; m.instanceMatrix.needsUpdate = true; });
  meshStems.count = is; meshStems.instanceMatrix.needsUpdate = true;
  scene.add(...meshPetals, meshStems);
}

function buildMushrooms() {
  const MAX_M = 60;
  const meshCap   = new THREE.InstancedMesh(GEO.mCap,   MAT.cap,   MAX_M);
  const meshStalk = new THREE.InstancedMesh(GEO.mStalk, MAT.stalk, MAX_M);
  let im = 0;
  const rng = makeRng(0xA4570000);

  for (let i = 0; i < 200 && im < MAX_M; i++) {
    const x = (rng() * 2 - 1) * (HALF - 4);
    const z = (rng() * 2 - 1) * (HALF - 4);
    if (isBlocked(x, z) || getZoneName(x, z) !== 'Forest') continue;
    const ground = getHeightAt(x, z);
    const sc = 0.5 + rng() * 0.8;
    setMatrix(meshStalk, im, x, ground + 0.28 * sc, z, 0,  sc, sc, sc);
    setMatrix(meshCap,   im, x, ground + 0.60 * sc, z, 0,  sc, sc, sc);
    im++;
  }

  meshCap.count = meshStalk.count = im;
  meshCap.instanceMatrix.needsUpdate = meshStalk.instanceMatrix.needsUpdate = true;
  scene.add(meshCap, meshStalk);
}

function addBox(mat, x, y, z, sx, sy, sz) {
  const m = new THREE.Mesh(GEO.box, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y + sy * 0.5, z);
  scene.add(m);
  return m;
}

function buildCabin() {
  const CX = 55, CZ = -62;
  const DW = 9, DH = 7;
  const ground = getHeightAt(CX, CZ);

  // Walls
  addBox(MAT.wood, CX, ground, CZ, DW, 4.5, DH);

  // Windows
  [[-2.5, 0], [2.5, 0]].forEach(([ox]) => {
    addBox(MAT.window_, CX + ox, ground + 2.0, CZ - DH * 0.5 - 0.01, 1.4, 1.2, 0.1);
    addBox(MAT.window_, CX + ox, ground + 2.0, CZ + DH * 0.5 + 0.01, 1.4, 1.2, 0.1);
  });

  // Door
  addBox(MAT.door, CX, ground, CZ + DH * 0.5 - 0.01, 1.6, 2.8, 0.12);

  // Roof
  const wallTopY = ground + 4.5;
  const halfW    = DW * 0.5;
  const rise     = 3.2;
  const ridgeY   = wallTopY + rise;
  const panelDepth = DH + 0.4;
  const angle    = Math.atan2(rise, halfW);
  const pLen     = Math.sqrt(halfW * halfW + rise * rise) + 0.3;

  [-1, 1].forEach(side => {
    const mesh = new THREE.Mesh(GEO.box, MAT.roof);
    mesh.scale.set(pLen, 0.28, panelDepth);
    mesh.position.set(CX + side * (halfW * 0.5), wallTopY + rise * 0.5 + 0.14, CZ);
    mesh.rotation.z = side * (-angle);
    scene.add(mesh);
  });

  addBox(MAT.roof, CX, ridgeY + 0.10, CZ, 0.38, 0.28, panelDepth);

  // Chimney
  const chX = CX - 4, chZ = CZ - 3.5;
  addBox(MAT.chimney, chX, getHeightAt(chX, chZ), chZ, 0.90, ridgeY + 1.4 - getHeightAt(chX, chZ), 0.90);

  // Porch step
  addBox(MAT.wood, CX, ground, CZ + DH * 0.5 + 0.60, DW + 0.6 - (DW - 1), 0.22, 1.2);
}

function buildFence() {
  const fenceMat = new THREE.MeshLambertMaterial({ color: 0xb09060 });
  const MAX_P    = 70;
  const meshPost = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.08, 1.4, 5), fenceMat, MAX_P);
  const meshRail = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 3.5, 4), fenceMat, MAX_P);
  let ip = 0;
  const FCX = 55, FCZ = -62, FW = 26, FH = 20, PS = 3.5;

  function fencePost(x, z, ry) {
    if (ip >= MAX_P) return;
    const g = getHeightAt(x, z);
    setMatrix(meshPost, ip, x, g + 0.70, z, 0, 1, 1, 1);
    setMatrix(meshRail, ip, x + Math.cos(ry) * 1.75, g + 0.80, z + Math.sin(ry) * 1.75, ry + Math.PI * 0.5, 1, 1, 1);
    ip++;
  }

  for (let x = FCX - FW*0.5; x <= FCX + FW*0.5; x += PS) fencePost(x, FCZ + FH*0.5, 0);
  for (let x = FCX - FW*0.5; x <= FCX + FW*0.5; x += PS) fencePost(x, FCZ - FH*0.5, 0);
  for (let z = FCZ - FH*0.5; z <= FCZ + FH*0.5; z += PS) fencePost(FCX + FW*0.5, z, Math.PI*0.5);
  for (let z = FCZ - FH*0.5; z <= FCZ + FH*0.5; z += PS) fencePost(FCX - FW*0.5, z, Math.PI*0.5);

  meshPost.count = meshRail.count = ip;
  meshPost.instanceMatrix.needsUpdate = meshRail.instanceMatrix.needsUpdate = true;
  scene.add(meshPost, meshRail);
}

function buildSigns() {
  const signs = [
    [-22, 10, 'Forest', Math.PI * 0.75],
    [ 38, 18, 'Lake',   Math.PI * 1.5 ],
    [ 32,-28, 'Cabin',  0             ],
    [  0,-16, 'Plaza',  Math.PI       ],
  ];
  signs.forEach(([sx, sz,, ry]) => {
    const ground = getHeightAt(sx, sz);
    const post = new THREE.Mesh(GEO.box, MAT.signPost);
    post.scale.set(0.16, 2.2, 0.16);
    post.position.set(sx, ground + 1.1, sz);
    scene.add(post);
    const board = new THREE.Mesh(GEO.box, MAT.signBoard);
    board.scale.set(1.6, 0.65, 0.12);
    board.position.set(sx, ground + 2.2, sz);
    board.rotation.y = ry;
    scene.add(board);
  });
}

function buildReeds() {
  const MAX_R  = 90;
  const meshR  = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.05, 0.08, 1.8, 4),
    new THREE.MeshLambertMaterial({ color: 0x5a7a30 }),
    MAX_R
  );
  let ir = 0;
  const rng = makeRng(0xAEED0550);
  for (let i = 0; i < 300 && ir < MAX_R; i++) {
    const a = rng() * Math.PI * 2;
    const r = 17 + rng() * 6;
    const x = 60 + Math.cos(a) * r;
    const z = 50 + Math.sin(a) * r;
    if (Math.abs(x) >= HALF-2 || Math.abs(z) >= HALF-2) continue;
    if (getZoneName(x, z) === 'Lake' || isBlocked(x, z)) continue;
    const sc = 0.6 + rng() * 0.8;
    setMatrix(meshR, ir++, x, getHeightAt(x, z) + 0.9*sc, z, rng()*Math.PI*2, sc, sc, sc);
  }
  meshR.count = ir; meshR.instanceMatrix.needsUpdate = true;
  scene.add(meshR);
}

function buildPlaza() {
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x8888a0 });
  function addWall(x, z, sx, sz) {
    const m = new THREE.Mesh(GEO.box, wallMat);
    m.scale.set(sx, 0.60, sz);
    m.position.set(x, getHeightAt(x, z) + 0.30, z);
    scene.add(m);
  }
  addWall( 0,-18, 44, 0.5); addWall( 0, 18, 44, 0.5);
  addWall(-22, 0, 0.5, 36); addWall(22,  0, 0.5, 36);

  const fMat  = new THREE.MeshLambertMaterial({ color: 0x9090b0 });
  const wMat2 = new THREE.MeshLambertMaterial({ color: 0x40a0e0, transparent: true, opacity: 0.75 });
  const baseY = getHeightAt(0, 0);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 0.70, 12), fMat);
  base.position.set(0, baseY + 0.35, 0); scene.add(base);
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 0.20, 12), wMat2);
  pool.position.set(0, baseY + 0.68, 0); scene.add(pool);
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 2.0, 8), fMat);
  pillar.position.set(0, baseY + 1.8, 0); scene.add(pillar);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.22, 0.30, 8), fMat);
  cap.position.set(0, baseY + 2.95, 0); scene.add(cap);
}

function buildBoulders() {
  const rng = makeRng(0xB0DEED00);
  const mat = new THREE.MeshLambertMaterial({ color: 0x60606a });
  [[-65,-5],[-48,12],[10,45],[-30,55],[72,-25]].forEach(([bx, bz]) => {
    const geo  = new THREE.IcosahedronGeometry(1.8 + rng() * 1.4, 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(1 + rng()*0.4, 0.7 + rng()*0.5, 1 + rng()*0.4);
    mesh.position.set(bx, getHeightAt(bx, bz) + 0.8, bz);
    mesh.rotation.y = rng() * Math.PI * 2;
    scene.add(mesh);
  });
}

export function initObjects() {
  buildTrees();
  buildRocks();
  buildFlowers();
  buildMushrooms();
  buildCabin();
  buildFence();
  buildSigns();
  buildReeds();
  buildPlaza();
  buildBoulders();
}
