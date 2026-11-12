// Pure ES module. No three.js, no DOM, no I/O. Safe to import from node.
//
// Texture-atlas packing core:
//   * packMaxRects  - MaxRects / best-short-side-fit packer (the tool)
//   * packShelf     - row-shelf packer (the baseline, also exported for the app)
//   * packAll       - repeat a single-bin packer over N bins
//   * validatePack  - independent structural check of a finished pack
//   * planStats     - occupancy / waste / bin count
//   * remapUv       - source-texture UV -> atlas UV, and its inverse
//
// Coordinate convention: image space, v grows DOWNWARD from the top-left of the
// atlas. Renderers that flip V must account for it (this repo uses flipY=false).

export const CORE_VERSION = "1.0.0";

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function hashString(s) {
  return fnv1a(String(s)).toString(16).padStart(8, "0");
}

function cmpIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortItems(items) {
  return [...items].sort(
    (a, b) =>
      Math.max(b.w, b.h) - Math.max(a.w, a.h) ||
      b.w * b.h - a.w * a.h ||
      cmpIds(String(a.id), String(b.id))
  );
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(a, b) {
  return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
}

function pruneFree(free) {
  const out = [];
  for (let i = 0; i < free.length; i++) {
    let keep = true;
    for (let j = 0; j < free.length; j++) {
      if (i === j) continue;
      if (contains(free[j], free[i])) {
        // On exact duplicates keep the lower index only.
        if (!(contains(free[i], free[j]) && j > i)) {
          keep = false;
          break;
        }
      }
    }
    if (keep) out.push(free[i]);
  }
  return out;
}

/**
 * MaxRects packer, one bin.
 * @param {{id:string,w:number,h:number}[]} items
 * @param {{binW:number,binH:number,padding?:number,sort?:boolean}} opts
 */
export function packMaxRects(items, opts = {}) {
  const binW = opts.binW ?? 1024;
  const binH = opts.binH ?? 1024;
  const padding = opts.padding ?? 0;
  const sorted = opts.sort === false ? [...items] : sortItems(items);
  const placements = [];
  const unplaced = [];
  let free = [{ x: 0, y: 0, w: binW, h: binH }];

  for (const it of sorted) {
    const w = it.w + 2 * padding;
    const h = it.h + 2 * padding;
    if (w > binW || h > binH) {
      unplaced.push({ ...it });
      continue;
    }
    let best = -1;
    let bestShort = Infinity;
    let bestLong = Infinity;
    for (let i = 0; i < free.length; i++) {
      const f = free[i];
      if (w > f.w || h > f.h) continue;
      const lw = f.w - w;
      const lh = f.h - h;
      const short = Math.min(lw, lh);
      const long = Math.max(lw, lh);
      if (short < bestShort || (short === bestShort && long < bestLong)) {
        best = i;
        bestShort = short;
        bestLong = long;
      }
    }
    if (best < 0) {
      unplaced.push({ ...it });
      continue;
    }
    const f = free[best];
    const bx = f.x;
    const by = f.y;
    placements.push({
      id: it.id,
      x: bx + padding,
      y: by + padding,
      w: it.w,
      h: it.h,
      bx,
      by,
      bw: w,
      bh: h,
    });
    const next = [];
    for (const fr of free) {
      if (!overlaps(fr, { x: bx, y: by, w, h })) {
        next.push(fr);
        continue;
      }
      if (bx > fr.x) next.push({ x: fr.x, y: fr.y, w: bx - fr.x, h: fr.h });
      if (bx + w < fr.x + fr.w) next.push({ x: bx + w, y: fr.y, w: fr.x + fr.w - (bx + w), h: fr.h });
      if (by > fr.y) next.push({ x: fr.x, y: fr.y, w: fr.w, h: by - fr.y });
      if (by + h < fr.y + fr.h) next.push({ x: fr.x, y: by + h, w: fr.w, h: fr.y + fr.h - (by + h) });
    }
    free = pruneFree(next);
  }
  return { algorithm: "maxrects", binW, binH, padding, placements, unplaced };
}

/**
 * Shelf/row packer, one bin. Baseline: sort by height, fill a row left to
 * right, start a new row when the current one overflows.
 */
export function packShelf(items, opts = {}) {
  const binW = opts.binW ?? 1024;
  const binH = opts.binH ?? 1024;
  const padding = opts.padding ?? 0;
  const sorted = [...items].sort(
    (a, b) => b.h - a.h || b.w - a.w || cmpIds(String(a.id), String(b.id))
  );
  const placements = [];
  const unplaced = [];
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const it of sorted) {
    const w = it.w + 2 * padding;
    const h = it.h + 2 * padding;
    if (w > binW || h > binH) {
      unplaced.push({ ...it });
      continue;
    }
    if (x + w > binW) {
      x = 0;
      y += shelfH;
      shelfH = 0;
    }
    if (y + h > binH) {
      unplaced.push({ ...it });
      continue;
    }
    placements.push({
      id: it.id,
      x: x + padding,
      y: y + padding,
      w: it.w,
      h: it.h,
      bx: x,
      by: y,
      bw: w,
      bh: h,
    });
    x += w;
    shelfH = Math.max(shelfH, h);
  }
  return { algorithm: "shelf", binW, binH, padding, placements, unplaced };
}

/**
 * Pack every item, opening a new bin whenever the current one cannot take
 * more. Items that the packer cannot place in an empty bin are reported.
 */
export function packAll(items, opts = {}) {
  const algorithm = opts.algorithm === "shelf" ? "shelf" : "maxrects";
  const binW = opts.binW ?? 1024;
  const binH = opts.binH ?? 1024;
  const padding = opts.padding ?? 0;
  const maxBins = opts.maxBins ?? 8;
  const packer = algorithm === "shelf" ? packShelf : packMaxRects;
  const byId = new Map(items.map((it) => [String(it.id), it]));
  let remaining = [...items];
  const bins = [];
  let unplaced = [];
  while (remaining.length && bins.length < maxBins) {
    const bin = packer(remaining, { binW, binH, padding, sort: opts.sort });
    if (bin.placements.length === 0) {
      unplaced = bin.unplaced.map((it) => ({ ...it }));
      break;
    }
    bins.push(bin);
    const placed = new Set(bin.placements.map((p) => String(p.id)));
    remaining = remaining.filter((it) => !placed.has(String(it.id)));
  }
  if (remaining.length && !unplaced.length) unplaced = remaining.map((it) => ({ ...it }));
  return {
    algorithm,
    binW,
    binH,
    padding,
    bins,
    unplaced,
    hash: hashPack({ bins, unplaced }),
    itemCount: items.length,
    byId,
  };
}

/**
 * Scale-normalised plan hash: coordinates are divided by the bin size before
 * hashing, so the same layout packed at 1e-3x or 1e3x yields the same id.
 */
export function normalizedHash(pack) {
  const bins = pack.bins.map((bin) =>
    bin.placements
      .map((p) =>
        [
          p.id,
          (p.x / bin.binW).toFixed(9),
          (p.y / bin.binH).toFixed(9),
          (p.w / bin.binW).toFixed(9),
          (p.h / bin.binH).toFixed(9),
        ].join(":")
      )
      .sort()
      .join(";")
  );
  return hashString(bins.join("|"));
}

export function hashPack(pack) {
  const parts = [];
  for (const bin of pack.bins) {
    const rows = bin.placements
      .map((p) => `${p.id}:${p.x},${p.y},${p.w},${p.h}`)
      .sort();
    parts.push(`[${rows.join(";")}]`);
  }
  const un = (pack.unplaced || []).map((p) => `${p.id}:${p.w}x${p.h}`).sort();
  return hashString(`${parts.join("|")}#u:${un.join(",")}`);
}

/**
 * Structural validator. Independent of the packers: it only reads finished
 * placements and re-checks bounds, duplicates, dimensions and pairwise overlap
 * of the padded boxes.
 */
export function validatePack(pack) {
  const errors = [];
  const seen = new Set();
  const ids = new Set();
  let placed = 0;
  for (let bi = 0; bi < pack.bins.length; bi++) {
    const bin = pack.bins[bi];
    const ps = bin.placements;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const id = String(p.id);
      if (seen.has(id)) errors.push(`duplicate placement: ${id}`);
      seen.add(id);
      ids.add(id);
      placed++;
      if (p.x < 0 || p.y < 0 || p.x + p.w > bin.binW || p.y + p.h > bin.binH) {
        errors.push(`out of bounds: ${id}`);
      }
      if (p.w <= 0 || p.h <= 0) errors.push(`non-positive size: ${id}`);
      if (p.bx !== p.x - pack.padding || p.by !== p.y - pack.padding) {
        errors.push(`bad padded origin: ${id}`);
      }
      if (p.bw !== p.w + 2 * pack.padding || p.bh !== p.h + 2 * pack.padding) {
        errors.push(`bad padded size: ${id}`);
      }
      for (let j = i + 1; j < ps.length; j++) {
        const q = ps[j];
        if (overlaps({ x: p.bx, y: p.by, w: p.bw, h: p.bh }, { x: q.bx, y: q.by, w: q.bw, h: q.bh })) {
          errors.push(`padded overlap: ${id} <-> ${q.id}`);
        }
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors: errors.slice(0, 20),
    placed,
    duplicateIds: seen.size !== placed,
    ids,
  };
}

/** Occupancy and waste. Occupancy counts source pixels only, so padding costs
 * show up as waste rather than as a free occupancy boost. */
export function planStats(pack) {
  let used = 0;
  let padded = 0;
  let binArea = 0;
  let placed = 0;
  for (const bin of pack.bins) {
    binArea += bin.binW * bin.binH;
    for (const p of bin.placements) {
      used += p.w * p.h;
      padded += p.bw * p.bh;
      placed++;
    }
  }
  const unplaced = pack.unplaced ? pack.unplaced.length : 0;
  return {
    algorithm: pack.algorithm,
    bins: pack.bins.length,
    placed,
    unplaced,
    usedArea: used,
    paddedArea: padded,
    binArea,
    occupancy: binArea ? used / binArea : 0,
    paddedOccupancy: binArea ? padded / binArea : 0,
    paddingWaste: binArea ? (padded - used) / binArea : 0,
    waste: binArea ? 1 - used / binArea : 0,
    hash: pack.hash ?? hashPack(pack),
  };
}

/** Atlas UV rect of a placement (inner texture box, gutter excluded). */
export function uvRectFor(p, binW, binH) {
  return {
    u0: p.x / binW,
    v0: p.y / binH,
    u1: (p.x + p.w) / binW,
    v1: (p.y + p.h) / binH,
  };
}

export function remapUv(u, v, rect) {
  return [rect.u0 + u * (rect.u1 - rect.u0), rect.v0 + v * (rect.v1 - rect.v0)];
}

export function unmapUv(u, v, rect) {
  return [(u - rect.u0) / (rect.u1 - rect.u0), (v - rect.v0) / (rect.v1 - rect.v0)];
}

export function findPlacement(pack, id) {
  for (let bi = 0; bi < pack.bins.length; bi++) {
    const p = pack.bins[bi].placements.find((q) => String(q.id) === String(id));
    if (p) return { binIndex: bi, placement: p };
  }
  return null;
}

export default {
  CORE_VERSION,
  packMaxRects,
  packShelf,
  packAll,
  validatePack,
  planStats,
  uvRectFor,
  remapUv,
  unmapUv,
  hashPack,
  normalizedHash,
  hashString,
  sortItems,
  findPlacement,
  mipSafeDepth,
};

/**
 * Mip-safe depth for a finished pack.
 *
 * Rule (conservative, absolute in atlas pixels): a texture may be mipped down
 * to level L while its bilinear footprint at that level, 2^L base texels, still
 * fits inside the padding gutter. padding=0 therefore allows only the base
 * level (-1), padding=2 allows level 1 (half resolution), padding=8 level 3.
 * This is a per-axis, isotropic budget; anisotropic filtering has a larger
 * footprint and is not covered.
 */
export function mipSafeDepth(pack) {
  let depth = -1;
  if (pack.padding >= 1) {
    depth = 0;
    while (Math.pow(2, depth + 1) <= pack.padding) depth++;
  }
  return {
    padding: pack.padding,
    maxMipLevel: depth,
    footprintTexels: depth < 0 ? 1 : Math.pow(2, depth),
    rule: "2^L <= padding",
  };
}
