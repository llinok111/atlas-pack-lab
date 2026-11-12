#!/usr/bin/env node
// Deterministic sample generator: 32 PNG textures + manifest + node-baked
// reference numbers. Same seed => byte-identical files.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { packAll, planStats, uvRectFor } from "../src/core.mjs";

const OUT = new URL("../data/", import.meta.url);
const BIN = 1024;
const PADDING = 2;

// Authored size mix. Total source area is deliberately close to one 1024^2
// atlas so the bin-count difference between the two packers is meaningful.
const SIZE_PLAN = [
  ...Array(8).fill([256, 128]),
  ...Array(8).fill([128, 256]),
  ...Array(10).fill([128, 128]),
  ...Array(6).fill([256, 64]),
];

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter none
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Small deterministic PRNG (mulberry32), used only to pick shades so the
// images do not look flat. Pattern geometry itself is seed-free.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paint(w, h, idx, seed) {
  const rnd = mulberry32(seed + idx * 7919);
  const hue = (idx * 47) % 360;
  const rgb = hsl(hue / 360, 0.62, 0.42);
  const rgb2 = hsl(((hue + 38) % 360) / 360, 0.7, 0.62);
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = ((x >> 3) ^ (y >> 3)) & 1;
      const stripe = ((x + y) >> 5) & 1;
      const tint = rnd() * 10;
      const c = cell ? rgb : rgb2;
      const k = stripe ? 0.82 : 1;
      const o = (y * w + x) * 3;
      buf[o] = Math.max(0, Math.min(255, Math.round(c[0] * k + tint)));
      buf[o + 1] = Math.max(0, Math.min(255, Math.round(c[1] * k + tint)));
      buf[o + 2] = Math.max(0, Math.min(255, Math.round(c[2] * k + tint)));
    }
  }
  // 6-bit index bar code along the top edge: white = 1, black = 0.
  for (let b = 0; b < 6; b++) {
    const on = (idx >> b) & 1;
    const x0 = 4 + b * 9;
    fillRect(buf, w, h, x0, 2, 7, 9, on ? [250, 250, 250] : [8, 8, 8]);
  }
  // Orientation marker: black square with a white L in the bottom-right corner.
  fillRect(buf, w, h, w - 14, h - 14, 12, 12, [0, 0, 0]);
  fillRect(buf, w, h, w - 12, h - 12, 8, 3, [255, 255, 255]);
  fillRect(buf, w, h, w - 12, h - 12, 3, 8, [255, 255, 255]);
  return buf;
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function fillRect(buf, w, h, x0, y0, rw, rh, color) {
  for (let y = Math.max(0, y0); y < Math.min(h, y0 + rh); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x0 + rw); x++) {
      const o = (y * w + x) * 3;
      buf[o] = color[0];
      buf[o + 1] = color[1];
      buf[o + 2] = color[2];
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const SEED = 0xc0ffee;
const rawById = new Map();
const textures = SIZE_PLAN.map(([w, h], i) => {
  const id = `tex-${String(i).padStart(2, "0")}`;
  const rgb = paint(w, h, i, SEED);
  const png = encodePng(w, h, rgb);
  writeFileSync(new URL(`${id}.png`, OUT), png);
  rawById.set(id, rgb);
  return {
    id, w, h, file: `${id}.png`, bytes: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
  };
});

const manifest = { seed: SEED, binW: BIN, binH: BIN, padding: PADDING, textures };
writeFileSync(new URL("manifest.json", OUT), JSON.stringify(manifest, null, 2) + "\n");

const items = textures.map((t) => ({ id: t.id, w: t.w, h: t.h }));
const byId = new Map(textures.map((t) => [t.id, t]));
const ref = { generatedBy: "tools/gen-sample.mjs", coreVersion: "1.0.0", binW: BIN, binH: BIN, padding: PADDING, algo: {} };

const packs = {};
for (const algorithm of ["maxrects", "shelf"]) {
  const pack = packAll(items, { algorithm, binW: BIN, binH: BIN, padding: PADDING });
  packs[algorithm] = pack;
  const stats = planStats(pack);
  ref.algo[algorithm] = {
    ...stats,
    perBin: pack.bins.map((b) => {
      const binStats = planStats({ ...pack, bins: [b] });
      return { occupancy: Number(binStats.occupancy.toFixed(6)), placed: b.placements.length };
    }),
    uvRect0: uvRectFor(pack.bins[0].placements[0], BIN, BIN),
  };
}

// Bake the MaxRects atlas to a real PNG. The gutter is filled by clamping to
// the nearest source texel (edge extension), so mip/bilinear taps stay inside
// the texture's own colours.
const atlas = Buffer.alloc(BIN * BIN * 3, 0);
for (const p of packs.maxrects.bins[0].placements) {
  const src = rawById.get(p.id);
  for (let y = -PADDING; y < p.h + PADDING; y++) {
    for (let x = -PADDING; x < p.w + PADDING; x++) {
      const sx = Math.min(p.w - 1, Math.max(0, x));
      const sy = Math.min(p.h - 1, Math.max(0, y));
      const di = ((p.y + y) * BIN + (p.x + x)) * 3;
      const si = (sy * p.w + sx) * 3;
      atlas[di] = src[si];
      atlas[di + 1] = src[si + 1];
      atlas[di + 2] = src[si + 2];
    }
  }
}
const atlasPng = encodePng(BIN, BIN, atlas);
writeFileSync(new URL("atlas-maxrects.png", OUT), atlasPng);
ref.atlas = {
  file: "atlas-maxrects.png",
  bin: `${BIN}x${BIN}`,
  bytes: atlasPng.length,
  sha256: createHash("sha256").update(atlasPng).digest("hex"),
  gutter: "edge-clamped, padding px",
};
writeFileSync(new URL("ref.json", OUT), JSON.stringify(ref, null, 2) + "\n");

console.log(`wrote ${textures.length} textures, total source ${textures.reduce((a, t) => a + t.w * t.h, 0)} px`);
for (const algorithm of ["maxrects", "shelf"]) {
  const s = ref.algo[algorithm];
  console.log(
    `${algorithm.padEnd(9)} bins=${s.bins} occupied=${(s.occupancy * 100).toFixed(2)}% ` +
      `padded=${(s.paddedOccupancy * 100).toFixed(2)}% hash=${s.hash}`
  );
}
console.log("bytes:", textures.reduce((a, t) => a + t.bytes, 0));
