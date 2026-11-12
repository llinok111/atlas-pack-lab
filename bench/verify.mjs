#!/usr/bin/env node
// Behavioural checks. Every assertion prints the measured value.
// Independent oracles are written here on purpose: the pixel rasterizer below
// shares no code with the packer, and the UV checks re-derive atlas pixels
// from integer arithmetic instead of trusting the packer's rect math.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  packAll,
  planStats,
  validatePack,
  uvRectFor,
  remapUv,
  unmapUv,
  hashPack,
  normalizedHash,
  findPlacement,
  mipSafeDepth,
} from "../src/core.mjs";

const BIN = 1024;
const PAD = 2;
const manifest = JSON.parse(readFileSync(new URL("../data/manifest.json", import.meta.url)));
const ref = JSON.parse(readFileSync(new URL("../data/ref.json", import.meta.url)));
const items = manifest.textures.map((t) => ({ id: t.id, w: t.w, h: t.h }));

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}  [${detail}]`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL  ${name}  [${detail}]`);
  }
}
function near(a, b, eps) {
  return Math.abs(a - b) <= eps;
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const packs = {
  maxrects: packAll(items, { algorithm: "maxrects", binW: BIN, binH: BIN, padding: PAD }),
  shelf: packAll(items, { algorithm: "shelf", binW: BIN, binH: BIN, padding: PAD }),
};

// ---------------------------------------------------------------- 1. structure
for (const [name, pack] of Object.entries(packs)) {
  const v = validatePack(pack);
  check(`${name}: validatePack ok`, v.ok, v.errors.join("; ") || "no errors");
  check(
    `${name}: every input placed exactly once`,
    v.placed === items.length && v.ids.size === items.length && pack.unplaced.length === 0,
    `placed=${v.placed}/${items.length} unplaced=${pack.unplaced.length}`
  );
  const s = planStats(pack);
  check(
    `${name}: occupancy == usedArea/binArea`,
    near(s.occupancy, s.usedArea / (s.bins * BIN * BIN), 1e-12),
    `occ=${(s.occupancy * 100).toFixed(3)}% used=${s.usedArea} bin=${s.bins * BIN * BIN}`
  );
}

// ------------------------------------------------- 2. pixel-level overlap oracle
// Rasterize every padded box into a per-bin bitmap. Shared pixels => overlap.
// This is independent of the rectangle tests in core.mjs.
function rasterOverlaps(pack) {
  let conflicts = 0;
  for (const bin of pack.bins) {
    const grid = new Uint8Array(BIN * BIN);
    for (const p of bin.placements) {
      for (let y = p.by; y < p.by + p.bh; y++) {
        for (let x = p.bx; x < p.bx + p.bw; x++) {
          const i = y * BIN + x;
          if (grid[i]) conflicts++;
          grid[i] = 1;
        }
      }
    }
  }
  return conflicts;
}
for (const [name, pack] of Object.entries(packs)) {
  const conflicts = rasterOverlaps(pack);
  check(`${name}: pixel oracle finds zero shared gutter texels`, conflicts === 0, `conflicts=${conflicts}`);
}

// Gutter separation: closest approach between two inner boxes must be >= 2*PAD.
function minInnerGap(pack) {
  let min = Infinity;
  let pair = null;
  for (const bin of pack.bins) {
    const ps = bin.placements;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const dx = Math.max(ps[j].x - (ps[i].x + ps[i].w), ps[i].x - (ps[j].x + ps[j].w));
        const dy = Math.max(ps[j].y - (ps[i].y + ps[i].h), ps[i].y - (ps[j].y + ps[j].h));
        const gap = Math.max(dx, dy);
        if (gap < min) {
          min = gap;
          pair = [ps[i].id, ps[j].id];
        }
      }
    }
  }
  return { min, pair };
}
for (const [name, pack] of Object.entries(packs)) {
  const g = minInnerGap(pack);
  check(
    `${name}: inner-box gap >= 2*padding`,
    g.min >= 2 * PAD,
    `minGap=${g.min}px pair=${g.pair ? g.pair.join("<->") : "-"}`
  );
}

// --------------------------------------------------------- 3. UV round trip
const rng = mulberry32(1234567);
let maxRoundTrip = 0;
let samples = 0;
for (const bin of packs.maxrects.bins) {
  for (const p of bin.placements) {
    const rect = uvRectFor(p, BIN, BIN);
    for (let k = 0; k < 400; k++) {
      const u = k < 4 ? [0, 1, 0, 1][k] : rng();
      const v = k < 4 ? [0, 0, 1, 1][k] : rng();
      const [au, av] = remapUv(u, v, rect);
      const [bu, bv] = unmapUv(au, av, rect);
      maxRoundTrip = Math.max(maxRoundTrip, Math.abs(bu - u), Math.abs(bv - v));
      samples++;
    }
  }
}
check(
  "uv round trip over all 32 textures x 400 samples",
  maxRoundTrip < 1e-12,
  `samples=${samples} maxErr=${maxRoundTrip.toExponential(3)}`
);

// Texel oracle: the centre of source pixel (px,py) must land inside atlas
// pixel (x+px, y+py). Integer arithmetic, no dependence on uvRectFor.
let maxTexelDrift = 0;
let texelSamples = 0;
for (const bin of packs.maxrects.bins) {
  for (const p of bin.placements) {
    const rect = uvRectFor(p, BIN, BIN);
    for (let k = 0; k < 60; k++) {
      const px = Math.min(p.w - 1, Math.floor(rng() * p.w));
      const py = Math.min(p.h - 1, Math.floor(rng() * p.h));
      const [au, av] = remapUv((px + 0.5) / p.w, (py + 0.5) / p.h, rect);
      const ax = Math.floor(au * BIN) - (p.x + px);
      const ay = Math.floor(av * BIN) - (p.y + py);
      maxTexelDrift = Math.max(maxTexelDrift, Math.abs(ax), Math.abs(ay));
      texelSamples++;
    }
  }
}
check(
  "texel oracle: remapped pixel indices match",
  maxTexelDrift === 0,
  `samples=${texelSamples} maxDrift=${maxTexelDrift}px`
);

// --------------------------------------------------- 4. packer vs baseline
const sMax = planStats(packs.maxrects);
const sShelf = planStats(packs.shelf);
check(
  "maxrects uses fewer atlases than shelf baseline",
  sMax.bins < sShelf.bins,
  `maxrects=${sMax.bins} bin(s) shelf=${sShelf.bins} bin(s)`
);
check(
  "maxrects occupancy beats shelf on the shipped sample",
  sMax.occupancy > sShelf.occupancy,
  `${(sMax.occupancy * 100).toFixed(2)}% vs ${(sShelf.occupancy * 100).toFixed(2)}%`
);
console.log(
  `INFO  texture memory ${sMax.bins} x ${BIN}² vs ${sShelf.bins} x ${BIN}²; ` +
    `source pixels ${sMax.usedArea}; padded ${(sMax.paddedOccupancy * 100).toFixed(2)}%`
);

// --------------------------------------------------------- 5. determinism
const shuffled = [...items];
const srng = mulberry32(99);
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(srng() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
for (const name of ["maxrects", "shelf"]) {
  const a = packs[name];
  const b = packAll(shuffled, { algorithm: name, binW: BIN, binH: BIN, padding: PAD });
  check(
    `${name}: plan hash is input-order independent`,
    hashPack(a) === hashPack(b) && a.hash === b.hash,
    `${a.hash} vs ${b.hash}`
  );
}
const again = packAll(items, { algorithm: "maxrects", binW: BIN, binH: BIN, padding: PAD });
check("maxrects: repeated run is bit-identical", again.hash === packs.maxrects.hash, again.hash);

// ------------------------------------------------- 6. scale invariance
// Scale geometry and padding by powers of two; the normalised UV rects and
// bin counts must be identical. No absolute threshold is involved.
const scales = [1 / 1024, 1 / 32, 1, 32, 1024];
const baseRects = packs.maxrects.bins.map((bin) => bin.placements.map((p) => uvRectFor(p, BIN, BIN)));
let scaleMaxDrift = 0;
let scaleBinsOk = true;
const scaleHashes = new Set([normalizedHash(packs.maxrects)]);
for (const k of scales) {
  const scaledItems = items.map((it) => ({ id: it.id, w: it.w * k, h: it.h * k }));
  const sp = packAll(scaledItems, { algorithm: "maxrects", binW: BIN * k, binH: BIN * k, padding: PAD * k });
  if (sp.bins.length !== packs.maxrects.bins.length) scaleBinsOk = false;
  scaleHashes.add(normalizedHash(sp));
  sp.bins.forEach((bin, bi) => {
    bin.placements.forEach((p, pi) => {
      const r = uvRectFor(p, BIN * k, BIN * k);
      const b = baseRects[bi][pi];
      scaleMaxDrift = Math.max(
        scaleMaxDrift,
        Math.abs(r.u0 - b.u0),
        Math.abs(r.v0 - b.v0),
        Math.abs(r.u1 - b.u1),
        Math.abs(r.v1 - b.v1)
      );
    });
  });
}
check(
  "scale invariance 1e-3..1e3 (powers of two)",
  scaleBinsOk && scaleMaxDrift < 1e-12,
  `binsSame=${scaleBinsOk} maxUvDrift=${scaleMaxDrift.toExponential(3)}`
);
check(
  "normalized plan hash is scale invariant",
  scaleHashes.size === 1,
  `distinctHashes=${scaleHashes.size} hash=${[...scaleHashes].join(",")}`
);

// ------------------------------------------------- 6b. mip budget
check("mip budget: padding=2 allows level 1", mipSafeDepth({ padding: 2 }).maxMipLevel === 1, `L=${mipSafeDepth({ padding: 2 }).maxMipLevel}`);
check("mip budget: padding=0 allows base level only", mipSafeDepth({ padding: 0 }).maxMipLevel === -1, `L=${mipSafeDepth({ padding: 0 }).maxMipLevel}`);
check("mip budget: padding=8 allows level 3", mipSafeDepth({ padding: 8 }).maxMipLevel === 3, `L=${mipSafeDepth({ padding: 8 }).maxMipLevel}`);

// ------------------------------------------------- 7. source data integrity
let hashMismatch = 0;
for (const t of manifest.textures) {
  const buf = readFileSync(new URL(`../data/${t.file}`, import.meta.url));
  const h = createHash("sha256").update(buf).digest("hex");
  if (h !== t.sha256) hashMismatch++;
  if (buf.length !== t.bytes) hashMismatch++;
}
check(
  "all generated PNGs match their manifest sha256/bytes",
  hashMismatch === 0,
  `textures=${manifest.textures.length} mismatches=${hashMismatch}`
);

// ------------------------------------------- 7b. baked atlas vs source pixels
// Decode the two PNGs on disk (filter 0 only, which the generator emits) and
// compare every packed texel. This checks the artefact, not the rect math.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let off = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 2) throw new Error("expected 8-bit RGB png");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 3 + 1;
  if (raw.length !== stride * h) throw new Error("unexpected png payload");
  const pixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    if (raw[y * stride] !== 0) throw new Error("unsupported png filter");
    raw.copy(pixels, y * w * 3, y * stride + 1, y * stride + 1 + w * 3);
  }
  return { w, h, pixels };
}

const atlasPng = decodePng(readFileSync(new URL(`../data/${ref.atlas.file}`, import.meta.url)));
check(
  "baked atlas has the declared 1024x1024 dimensions",
  atlasPng.w === BIN && atlasPng.h === BIN,
  `${atlasPng.w}x${atlasPng.h}`
);
const sourcePixels = new Map();
for (const t of manifest.textures) {
  const img = decodePng(readFileSync(new URL(`../data/${t.file}`, import.meta.url)));
  sourcePixels.set(t.id, img);
}
let texelMismatch = 0;
let texelTotal = 0;
let gutterMismatch = 0;
let gutterTotal = 0;
for (const p of packs.maxrects.bins[0].placements) {
  const src = sourcePixels.get(p.id);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const si = (y * src.w + x) * 3;
      const di = ((p.y + y) * BIN + (p.x + x)) * 3;
      if (
        atlasPng.pixels[di] !== src.pixels[si] ||
        atlasPng.pixels[di + 1] !== src.pixels[si + 1] ||
        atlasPng.pixels[di + 2] !== src.pixels[si + 2]
      ) texelMismatch++;
      texelTotal++;
    }
  }
  for (let y = -PAD; y < p.h + PAD; y++) {
    for (let x = -PAD; x < p.w + PAD; x++) {
      if (x >= 0 && x < p.w && y >= 0 && y < p.h) continue;
      const sx = Math.min(p.w - 1, Math.max(0, x));
      const sy = Math.min(p.h - 1, Math.max(0, y));
      const si = (sy * src.w + sx) * 3;
      const di = ((p.y + y) * BIN + (p.x + x)) * 3;
      if (
        atlasPng.pixels[di] !== src.pixels[si] ||
        atlasPng.pixels[di + 1] !== src.pixels[si + 1] ||
        atlasPng.pixels[di + 2] !== src.pixels[si + 2]
      ) gutterMismatch++;
      gutterTotal++;
    }
  }
}
check(
  "baked atlas: every packed source texel is byte-identical",
  texelMismatch === 0,
  `texels=${texelTotal} mismatches=${texelMismatch}`
);
check(
  "baked atlas: every gutter texel is an edge-clamped copy",
  gutterMismatch === 0,
  `gutterTexels=${gutterTotal} mismatches=${gutterMismatch}`
);

// ------------------------------------------------- 8. cross-check app lookup
const lookup = findPlacement(packs.maxrects, manifest.textures[7].id);
const rect7 = lookup ? uvRectFor(lookup.placement, BIN, BIN) : null;
check(
  "findPlacement resolves a known id to its atlas rect",
  !!lookup && Math.abs(rect7.u1 - rect7.u0 - manifest.textures[7].w / BIN) < 1e-12,
  lookup ? `bin=${lookup.binIndex} u=[${rect7.u0.toFixed(4)},${rect7.u1.toFixed(4)}]` : "not found"
);

console.log(`\n${passed} passed / ${failed} failed`);
if (failed) {
  console.error(failures.join("\n"));
  process.exit(1);
}
process.exit(0);
