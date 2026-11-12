// Rendering + interaction only. All packing/UV math comes from src/core.mjs.
import * as THREE from "three";
import {
  packAll,
  planStats,
  uvRectFor,
  remapUv,
  unmapUv,
  hashPack,
  mipSafeDepth,
} from "./src/core.mjs";

const $ = (id) => document.getElementById(id);
const manifest = await (await fetch("./data/manifest.json")).json();
const ref = await (await fetch("./data/ref.json")).json();

const images = new Map();
await Promise.all(
  manifest.textures.map(
    (t) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          images.set(t.id, img);
          resolve();
        };
        img.onerror = () => reject(new Error(`failed to load ${t.file}`));
        img.src = `./data/${t.file}`;
      })
  )
);

const state = {
  algo: "maxrects",
  binIndex: 0,
  binW: 1024,
  binH: 1024,
  padding: 2,
  highlightId: null,
};

// ------------------------------------------------------------------ three.js
const canvas3d = $("view");
const renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setClearColor(0x070a0e, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
const root = new THREE.Group();
scene.add(root);

let orbit = { yaw: 0.0, pitch: -0.12, radius: 15 };
function placeCamera() {
  const { yaw, pitch, radius } = orbit;
  camera.position.set(
    radius * Math.sin(yaw) * Math.cos(pitch),
    radius * Math.sin(pitch),
    radius * Math.cos(yaw) * Math.cos(pitch)
  );
  camera.lookAt(0, 0, 0);
}
placeCamera();

let dragging = false;
let last = { x: 0, y: 0 };
canvas3d.addEventListener("pointerdown", (e) => {
  dragging = true;
  last = { x: e.clientX, y: e.clientY };
  canvas3d.setPointerCapture(e.pointerId);
});
canvas3d.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  orbit.yaw += (e.clientX - last.x) * 0.006;
  orbit.pitch = Math.max(-1.2, Math.min(1.2, orbit.pitch + (e.clientY - last.y) * 0.006));
  last = { x: e.clientX, y: e.clientY };
  placeCamera();
});
canvas3d.addEventListener("pointerup", () => (dragging = false));
canvas3d.addEventListener("wheel", (e) => {
  e.preventDefault();
  orbit.radius = Math.max(6, Math.min(45, orbit.radius * (1 + Math.sign(e.deltaY) * 0.08)));
  placeCamera();
}, { passive: false });

function resize() {
  const w = canvas3d.clientWidth || 640;
  const h = canvas3d.clientHeight || 420;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas3d);
resize();

function tick() {
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// -------------------------------------------------------------------- atlas
const atlasCanvas = $("atlas");
const actx = atlasCanvas.getContext("2d");
let atlasTexture = null;

function drawAtlas(pack, bin) {
  atlasCanvas.width = bin.binW;
  atlasCanvas.height = bin.binH;
  actx.imageSmoothingEnabled = false;
  actx.fillStyle = "#070a0e";
  actx.fillRect(0, 0, bin.binW, bin.binH);
  for (const p of bin.placements) {
    const img = images.get(p.id);
    // Gutter first (edge-stretched), then the exact pixel-aligned blit.
    actx.drawImage(img, p.bx, p.by, p.bw, p.bh);
    actx.drawImage(img, p.x, p.y, p.w, p.h);
    actx.strokeStyle = p.id === state.highlightId ? "#5eead4" : "rgba(255,255,255,0.22)";
    actx.lineWidth = p.id === state.highlightId ? 3 : 1;
    actx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
  }
  if (atlasTexture) atlasTexture.dispose();
  atlasTexture = new THREE.CanvasTexture(atlasCanvas);
  atlasTexture.flipY = false; // image space: v grows downward
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.generateMipmaps = false;
  atlasTexture.minFilter = THREE.LinearFilter;
  atlasTexture.magFilter = THREE.LinearFilter;
}

// ------------------------------------------------------------------- scene
function clearRoot() {
  for (const child of [...root.children]) {
    root.remove(child);
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
    else child.material?.dispose?.();
  }
}

function buildScene(pack, bin) {
  clearRoot();
  const cols = 8;
  const rows = Math.ceil(bin.placements.length / cols);
  const step = 1.24;
  const ox = ((cols - 1) * step) / 2;
  const oy = ((rows - 1) * step) / 2;
  bin.placements.forEach((p, i) => {
    const geo = new THREE.PlaneGeometry(1, 1);
    const uv = geo.attributes.uv;
    const r = uvRectFor(p, bin.binW, bin.binH);
    uv.setXY(0, r.u0, r.v0);
    uv.setXY(1, r.u1, r.v0);
    uv.setXY(2, r.u0, r.v1);
    uv.setXY(3, r.u1, r.v1);
    uv.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: atlasTexture,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const col = i % cols;
    const row = Math.floor(i / cols);
    mesh.position.set(col * step - ox, oy - row * step, 0);
    mesh.scale.set(1, Math.min(1.6, p.h / p.w), 1);
    root.add(mesh);
    if (p.id === state.highlightId) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x5eead4 })
      );
      edges.position.copy(mesh.position);
      edges.scale.copy(mesh.scale);
      root.add(edges);
    }
  });
}

// ------------------------------------------------------------------- stats
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uvSelfCheck(pack) {
  const rnd = mulberry32(424242);
  let maxErr = 0;
  let maxDrift = 0;
  let samples = 0;
  for (const bin of pack.bins) {
    for (const p of bin.placements) {
      const rect = uvRectFor(p, bin.binW, bin.binH);
      for (let k = 0; k < 100; k++) {
        const u = rnd();
        const v = rnd();
        const [au, av] = remapUv(u, v, rect);
        const [bu, bv] = unmapUv(au, av, rect);
        maxErr = Math.max(maxErr, Math.abs(bu - u), Math.abs(bv - v));
        const px = Math.min(p.w - 1, Math.floor(rnd() * p.w));
        const py = Math.min(p.h - 1, Math.floor(rnd() * p.h));
        const [tu, tv] = remapUv((px + 0.5) / p.w, (py + 0.5) / p.h, rect);
        maxDrift = Math.max(
          maxDrift,
          Math.abs(Math.floor(tu * bin.binW) - (p.x + px)),
          Math.abs(Math.floor(tv * bin.binH) - (p.y + py))
        );
        samples++;
      }
    }
  }
  return { maxErr, maxDrift, samples };
}

function stat(k, v) {
  return `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

let currentPack = null;
let currentBin = null;

function rebuild() {
  const items = manifest.textures.map((t) => ({ id: t.id, w: t.w, h: t.h }));
  const opts = { binW: state.binW, binH: state.binH, padding: state.padding };
  const maxPack = packAll(items, { ...opts, algorithm: "maxrects" });
  const shelfPack = packAll(items, { ...opts, algorithm: "shelf" });
  const shown = state.algo === "maxrects" ? maxPack : shelfPack;
  state.binIndex = Math.max(0, Math.min(state.binIndex, shown.bins.length - 1));
  const bin = shown.bins[state.binIndex];
  currentPack = shown;
  currentBin = bin;
  const s = planStats(shown);
  const sMax = planStats(maxPack);
  const sShelf = planStats(shelfPack);

  const sel = $("bin-select");
  sel.innerHTML = shown.bins
    .map((b, i) => `<option value="${i}" ${i === state.binIndex ? "selected" : ""}>#${i + 1} / ${shown.bins.length}</option>`)
    .join("");

  drawAtlas(shown, bin);
  buildScene(shown, bin);

  const check = uvSelfCheck(shown);
  const refMatch =
    state.algo === "maxrects" &&
    state.binW === 1024 &&
    state.padding === 2 &&
    hashPack(shown) === ref.algo.maxrects.hash;

  $("stats").innerHTML =
    stat("图集张数 (本页算法)", `${s.bins} <small>vs 基线 ${sShelf.bins}</small>`) +
    stat("占用率", `${(s.occupancy * 100).toFixed(2)}% <small>vs ${(sShelf.occupancy * 100).toFixed(2)}%</small>`) +
    stat("padding 开销", `${(s.paddingWaste * 100).toFixed(2)}%`) +
    stat("显存 (RGBA)", `${((s.bins * state.binW * state.binH * 4) / 1048576).toFixed(1)} MB <small>vs ${((sShelf.bins * state.binW * state.binH * 4) / 1048576).toFixed(1)} MB</small>`) +
    stat("计划哈希", `<code>${hashPack(shown)}</code>`) +
    stat("UV 自检", `${check.samples} 样本 · 误差 ${check.maxErr.toExponential(1)} · 像素漂移 ${check.maxDrift}px`) +
    stat("安全 mip 层", `L${mipSafeDepth(shown).maxMipLevel} <small>padding=${state.padding}px, 规则 2^L≤padding</small>`);

  const el = $("verdict");
  el.innerHTML = refMatch
    ? `<span class="good">✓ 与 data/ref.json 的 node 烘焙值逐位一致（hash ${ref.algo.maxrects.hash}，占用率 ${(ref.algo.maxrects.occupancy * 100).toFixed(2)}%，${ref.algo.maxrects.bins} 张图集）</span>`
    : `<span class="warn">参数已改变：ref.json 只在 padding=2 / 1024² / MaxRects 时可直接对照；当前 hash ${hashPack(shown)}，算法 ${state.algo}，${s.bins} 张图集</span>`;
  if (state.algo === "maxrects") {
    el.innerHTML += ` <span class="${sMax.bins <= sShelf.bins ? "good" : "bad"}">MaxRects ${sMax.bins} 张 vs 货架 ${sShelf.bins} 张</span>`;
  }
}

// --------------------------------------------------------------- interaction
function setAlgo(algo) {
  state.algo = algo;
  state.binIndex = 0;
  $("algo-max").classList.toggle("on", algo === "maxrects");
  $("algo-shelf").classList.toggle("on", algo === "shelf");
  rebuild();
}
$("algo-max").addEventListener("click", () => setAlgo("maxrects"));
$("algo-shelf").addEventListener("click", () => setAlgo("shelf"));
$("pad").addEventListener("input", (e) => {
  state.padding = Number(e.target.value);
  $("pad-val").textContent = String(state.padding);
  rebuild();
});
$("size").addEventListener("change", (e) => {
  state.binW = Number(e.target.value);
  state.binH = state.binW;
  state.binIndex = 0;
  rebuild();
});
$("bin-select").addEventListener("change", (e) => {
  state.binIndex = Number(e.target.value);
  rebuild();
});

atlasCanvas.addEventListener("click", (e) => {
  if (!currentBin) return;
  const rect = atlasCanvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * atlasCanvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * atlasCanvas.height;
  const hit = currentBin.placements.find((p) => x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h);
  state.highlightId = hit ? (state.highlightId === hit.id ? null : hit.id) : null;
  rebuild();
});

rebuild();
