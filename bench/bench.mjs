#!/usr/bin/env node
// Timing harness: 1 cold run, then 7 samples x 200 packs per algorithm.
// Reports min / median / p95 / stddev / relative stddev in bench/result.json.
import { writeFileSync, readFileSync } from "node:fs";
import { packAll, planStats } from "../src/core.mjs";

const BIN = 1024;
const PAD = 2;
const manifest = JSON.parse(readFileSync(new URL("../data/manifest.json", import.meta.url)));
const items = manifest.textures.map((t) => ({ id: t.id, w: t.w, h: t.h }));

const WARMUP = 20000;
const SAMPLES = 9;
const ITER = 5000;

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function measure(algorithm) {
  const opts = { algorithm, binW: BIN, binH: BIN, padding: PAD };
  // Cold start: the very first call in this process, measured alone.
  const t0 = process.hrtime.bigint();
  const coldPack = packAll(items, opts);
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const coldStats = planStats(coldPack);

  for (let i = 0; i < WARMUP; i++) packAll(items, opts);

  const perSample = [];
  for (let s = 0; s < SAMPLES; s++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < ITER; i++) packAll(items, opts);
    const ms = Number(process.hrtime.bigint() - start) / 1e6 / ITER;
    perSample.push(ms);
  }
  const sorted = [...perSample].sort((a, b) => a - b);
  const mean = perSample.reduce((a, b) => a + b, 0) / perSample.length;
  const variance = perSample.reduce((a, b) => a + (b - mean) ** 2, 0) / perSample.length;
  const stddev = Math.sqrt(variance);
  const stats = planStats(coldPack);
  return {
    samplesMs: perSample.map((x) => Number(x.toFixed(6))),
    iterationsPerSample: ITER,
    warmup: WARMUP,
    coldMs: Number(coldMs.toFixed(4)),
    minMs: Number(sorted[0].toFixed(6)),
    medianMs: Number(percentile(sorted, 50).toFixed(6)),
    p95Ms: Number(percentile(sorted, 95).toFixed(6)),
    stddevMs: Number(stddev.toFixed(6)),
    rsdPct: Number(((stddev / mean) * 100).toFixed(3)),
    bins: stats.bins,
    occupancy: Number(stats.occupancy.toFixed(6)),
    paddedOccupancy: Number(stats.paddedOccupancy.toFixed(6)),
    placed: stats.placed,
    unplaced: stats.unplaced,
    hash: stats.hash,
  };
}

const result = {
  generatedBy: "bench/bench.mjs",
  node: process.version,
  config: {
    textures: items.length,
    sourcePixels: items.reduce((a, t) => a + t.w * t.h, 0),
    bin: `${BIN}x${BIN}`,
    padding: PAD,
    warmup: WARMUP,
    samples: SAMPLES,
    iterationsPerSample: ITER,
  },
  algorithms: {
    maxrects: measure("maxrects"),
    shelf: measure("shelf"),
  },
  headline: {
    atlases: null,
    textureMemoryRatio: null,
    occupancyGainPct: null,
    speedRatio: null,
  },
};

const a = result.algorithms;
result.headline = {
  atlases: `${a.maxrects.bins} vs ${a.shelf.bins}`,
  atlasMemoryBytes: `${a.maxrects.bins * BIN * BIN * 4} vs ${a.shelf.bins * BIN * BIN * 4}`,
  occupancyGainPct: Number((((a.maxrects.occupancy - a.shelf.occupancy) / a.shelf.occupancy) * 100).toFixed(2)),
  speedRatio: Number((a.shelf.medianMs / a.maxrects.medianMs).toFixed(3)),
  note: "speedRatio > 1 means maxrects is slower than the shelf baseline",
};

writeFileSync(new URL("./result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
