#!/usr/bin/env node
// Baseline used in every comparison in this repo: row-shelf packing.
// Run: node baseline/shelf.mjs
import { readFileSync } from "node:fs";
import { packAll, planStats } from "../src/core.mjs";

const manifest = JSON.parse(readFileSync(new URL("../data/manifest.json", import.meta.url)));
const items = manifest.textures.map((t) => ({ id: t.id, w: t.w, h: t.h }));
const opts = { binW: 1024, binH: 1024, padding: 2 };

const shelf = packAll(items, { ...opts, algorithm: "shelf" });
const maxrects = packAll(items, { ...opts, algorithm: "maxrects" });
const s = planStats(shelf);
const m = planStats(maxrects);
console.log(`baseline (shelf) : ${s.bins} atlases, occupancy ${(s.occupancy * 100).toFixed(2)}%`);
console.log(`per-bin          : ${shelf.bins.map((b) => (planStats({ ...shelf, bins: [b] }).occupancy * 100).toFixed(2) + "%").join(", ")}`);
console.log(`tool (maxrects)  : ${m.bins} atlases, occupancy ${(m.occupancy * 100).toFixed(2)}%`);
console.log(`per-bin          : ${maxrects.bins.map((b) => (planStats({ ...maxrects, bins: [b] }).occupancy * 100).toFixed(2) + "%").join(", ")}`);
