import { processWithFhRagPrototype } from "./prototype-fh-rag.js";
import { fuseHierarchicalLayers } from "./prototype-hierarchical-fusion.js";

export const DEFAULT_PARAMS = Object.freeze({
  autoMode: true,
  segmentationMethod: "existing",
  localThreshold: 0.024,
  globalThreshold: 0.06,
  minRegionArea: 9,
  minInnerAreaRatio: 0.8,
  outlineWidth: 2,
  outlineColor: [21, 21, 21],
  preSmoothLevel: 0,
  connectivity: 4
});

const EPSILON = 1e-9;
const MAX_PROCESS_PIXELS = 4_194_304;
const EDGE_QUANT_SCALE = 32768;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function assertImage(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || !image.data) {
    throw new Error("图片像素数据无效。");
  }
  if (image.width < 1 || image.height < 1) throw new Error("图片尺寸必须大于 0。");
  if (image.width > 4096 || image.height > 4096) throw new Error("图片边长超过 4096 像素的安全上限。");
  if (image.width * image.height > MAX_PROCESS_PIXELS) {
    throw new Error("图片总像素超过 419 万；为避免浏览器内存耗尽，请裁剪后重试。原图不会被静默缩放。");
  }
  if (image.data.length !== image.width * image.height * 4) throw new Error("RGBA 数据长度与图片尺寸不一致。");
}

export function validateParams(input) {
  const p = { ...DEFAULT_PARAMS, ...input };
  const numeric = [
    ["localThreshold", p.localThreshold, 0, 1],
    ["globalThreshold", p.globalThreshold, 0, 1.5],
    ["minRegionArea", p.minRegionArea, 1, 1_000_000],
    ["minInnerAreaRatio", p.minInnerAreaRatio, 0, 1],
    ["outlineWidth", p.outlineWidth, 1, 8],
    ["preSmoothLevel", p.preSmoothLevel, 0, 5]
  ];
  for (const [name, value, min, max] of numeric) {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`参数 ${name} 超出允许范围。`);
  }
  if (p.globalThreshold + EPSILON < p.localThreshold) throw new Error("全局色差阈值必须大于或等于局部色差阈值。");
  if (![4, 8].includes(Number(p.connectivity))) throw new Error("邻接方式只能是 4 或 8。");
  if (!["existing", "fh-rag", "hierarchical-fusion"].includes(p.segmentationMethod)) throw new Error("未知的分割方法。");
  if (!Array.isArray(p.outlineColor) || p.outlineColor.length !== 3 || p.outlineColor.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
    throw new Error("描边颜色必须是有效的 RGB 三元组。");
  }
  p.minRegionArea = Math.round(p.minRegionArea);
  p.outlineWidth = Math.round(p.outlineWidth);
  p.preSmoothLevel = Math.round(p.preSmoothLevel);
  p.connectivity = Number(p.connectivity);
  return p;
}

function srgbChannelToLinear(value) {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function rgbToOklab(r, g, b) {
  const lr = srgbChannelToLinear(r);
  const lg = srgbChannelToLinear(g);
  const lb = srgbChannelToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  return [
    0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
  ];
}

function labDistance(L, A, B, i, j) {
  const dl = L[i] - L[j];
  const da = A[i] - A[j];
  const db = B[i] - B[j];
  return Math.sqrt(dl * dl + da * da + db * db);
}

function preparePixels(image) {
  assertImage(image);
  const count = image.width * image.height;
  const valid = new Uint8Array(count);
  const L = new Float32Array(count);
  const A = new Float32Array(count);
  const B = new Float32Array(count);
  let validCount = 0;
  let semiTransparentCount = 0;
  for (let i = 0; i < count; i++) {
    const alpha = image.data[i * 4 + 3];
    if (alpha === 0) continue;
    valid[i] = 1;
    validCount++;
    if (alpha < 255) semiTransparentCount++;
    const [l, a, b] = rgbToOklab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]);
    L[i] = l;
    A[i] = a;
    B[i] = b;
  }
  if (validCount === 0) throw new Error("图片没有可见像素。");
  return { valid, L, A, B, validCount, semiTransparentCount };
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * ratio;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] * (high - index) + sorted[high] * (index - low);
}

function collectNeighborSample(prepared, width, height, limit = 120_000) {
  const { valid, L, A, B } = prepared;
  let edgeCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      if (x + 1 < width && valid[i + 1]) edgeCount++;
      if (y + 1 < height && valid[i + width]) edgeCount++;
    }
  }
  if (!edgeCount) return { values: [0], edgeCount: 0 };
  const stride = Math.max(1, Math.floor(edgeCount / limit));
  const values = [];
  let seen = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      if (x + 1 < width && valid[i + 1]) {
        if (seen % stride === 0 && values.length < limit) values.push(labDistance(L, A, B, i, i + 1));
        seen++;
      }
      if (y + 1 < height && valid[i + width]) {
        if (seen % stride === 0 && values.length < limit) values.push(labDistance(L, A, B, i, i + width));
        seen++;
      }
    }
  }
  return { values, edgeCount };
}

function estimateFromPrepared(prepared, width, height) {
  const { values, edgeCount } = collectNeighborSample(prepared, width, height);
  const sorted = values.slice().sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = percentile(deviations, 0.5);
  const nonZero = sorted.filter((v) => v > 0.00002);
  const nonZeroMedian = nonZero.length ? percentile(nonZero, 0.5) : 0;
  const p75 = percentile(sorted, 0.75);
  const p90 = percentile(sorted, 0.9);
  const robust = median + 2 * 1.4826 * mad;
  let localThreshold;
  let reason;
  if (mad < 0.00002 && median < 0.00002) {
    localThreshold = nonZero.length ? clamp(nonZeroMedian * 0.72, 0.0012, 0.035) : 0.001;
    reason = nonZero.length ? "零差占比较高，改用非零色差子集" : "输入本身为精确纯色";
  } else {
    // P90 is allowed to raise the gate enough for bounded sensor/AI texture noise;
    // prominent object boundaries normally live well above this robust tail.
    const distributionCap = Math.max(0.004, p90 * 1.12);
    localThreshold = clamp(Math.min(robust, distributionCap), 0.0015, 0.08);
    reason = "中位数 + 2 × 1.4826 × MAD";
  }
  const globalThreshold = clamp(localThreshold * 2.5, localThreshold, 0.22);
  const noiseRatio = sorted.length ? sorted.filter((v) => v > 0.002 && v < 0.025).length / sorted.length : 0;
  const preSmoothLevel = median > 0.0025 && p75 < 0.03 && noiseRatio > 0.42 ? 1 : 0;
  const minRegionArea = Math.max(9, Math.round(prepared.validCount * 0.00005));
  return {
    params: {
      ...DEFAULT_PARAMS,
      autoMode: true,
      localThreshold,
      globalThreshold,
      minRegionArea,
      preSmoothLevel
    },
    metrics: { median, mad, p75, p90, sampledEdges: sorted.length, edgeCount, reason }
  };
}

export function analyzeImage(image) {
  const prepared = preparePixels(image);
  const analysis = estimateFromPrepared(prepared, image.width, image.height);
  const warnings = [];
  if (prepared.semiTransparentCount) warnings.push(`检测到 ${prepared.semiTransparentCount.toLocaleString()} 个半透明像素；输出会按二值透明策略硬化。`);
  if (analysis.metrics.edgeCount === 0) warnings.push("可见区域之间没有可统计的相邻边，已使用保守阈值。");
  return { ...analysis, warnings, validCount: prepared.validCount, semiTransparentCount: prepared.semiTransparentCount };
}

function smoothWorkingLab(prepared, width, height, level, localThreshold) {
  if (!level) return { L: prepared.L, A: prepared.A, B: prepared.B };
  let sourceL = prepared.L.slice();
  let sourceA = prepared.A.slice();
  let sourceB = prepared.B.slice();
  const valid = prepared.valid;
  const gate = Math.max(0.012, localThreshold * 1.35);
  const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let pass = 0; pass < level; pass++) {
    const targetL = sourceL.slice();
    const targetA = sourceA.slice();
    const targetB = sourceB.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!valid[i]) continue;
        let sumL = sourceL[i];
        let sumA = sourceA[i];
        let sumB = sourceB[i];
        let weight = 1;
        for (const [dx, dy] of offsets) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const j = ny * width + nx;
          if (!valid[j]) continue;
          const dl = sourceL[i] - sourceL[j];
          const da = sourceA[i] - sourceA[j];
          const db = sourceB[i] - sourceB[j];
          if (Math.sqrt(dl * dl + da * da + db * db) > gate) continue;
          sumL += sourceL[j]; sumA += sourceA[j]; sumB += sourceB[j]; weight++;
        }
        targetL[i] = sumL / weight;
        targetA[i] = sumA / weight;
        targetB[i] = sumB / weight;
      }
    }
    sourceL = targetL; sourceA = targetA; sourceB = targetB;
  }
  return { L: sourceL, A: sourceA, B: sourceB };
}

function createEdges(working, valid, width, height, connectivity) {
  const directions = connectivity === 8
    ? [[1, 0], [0, 1], [1, 1], [-1, 1]]
    : [[1, 0], [0, 1]];
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      for (const [dx, dy] of directions) {
        const nx = x + dx; const ny = y + dy;
        if (nx >= 0 && nx < width && ny < height && valid[ny * width + nx]) count++;
      }
    }
  }
  const from = new Int32Array(count);
  const to = new Int32Array(count);
  const weight = new Float32Array(count);
  const bucket = new Uint16Array(count);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      for (const [dx, dy] of directions) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (!valid[j]) continue;
        const d = labDistance(working.L, working.A, working.B, i, j);
        from[cursor] = Math.min(i, j);
        to[cursor] = Math.max(i, j);
        weight[cursor] = d;
        bucket[cursor] = Math.min(65535, Math.round(d * EDGE_QUANT_SCALE));
        cursor++;
      }
    }
  }
  const counts = new Int32Array(65536);
  for (let i = 0; i < count; i++) counts[bucket[i]]++;
  const offsets = new Int32Array(65536);
  let total = 0;
  for (let i = 0; i < counts.length; i++) { offsets[i] = total; total += counts[i]; }
  const writeOffsets = offsets.slice();
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[writeOffsets[bucket[i]]++] = i;
  return { from, to, weight, bucket, order };
}

function segmentPixels(working, valid, width, height, params, emit) {
  const count = width * height;
  const parent = new Int32Array(count);
  const size = new Int32Array(count);
  const minL = new Float32Array(count); const maxL = new Float32Array(count);
  const minA = new Float32Array(count); const maxA = new Float32Array(count);
  const minB = new Float32Array(count); const maxB = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    if (!valid[i]) { parent[i] = -1; continue; }
    parent[i] = i; size[i] = 1;
    minL[i] = maxL[i] = working.L[i];
    minA[i] = maxA[i] = working.A[i];
    minB[i] = maxB[i] = working.B[i];
  }
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) { const next = parent[value]; parent[value] = root; value = next; }
    return root;
  };
  emit("建立像素邻接图", 25);
  const edges = createEdges(working, valid, width, height, params.connectivity);
  emit("按色差稳定排序", 36);
  const localBucketLimit = Math.ceil(params.localThreshold * EDGE_QUANT_SCALE) + 1;
  for (let rank = 0; rank < edges.order.length; rank++) {
    const edgeIndex = edges.order[rank];
    if (edges.bucket[edgeIndex] > localBucketLimit) break;
    if (edges.weight[edgeIndex] > params.localThreshold + EPSILON) continue;
    let ra = find(edges.from[edgeIndex]);
    let rb = find(edges.to[edgeIndex]);
    if (ra === rb) continue;
    const nextMinL = Math.min(minL[ra], minL[rb]); const nextMaxL = Math.max(maxL[ra], maxL[rb]);
    const nextMinA = Math.min(minA[ra], minA[rb]); const nextMaxA = Math.max(maxA[ra], maxA[rb]);
    const nextMinB = Math.min(minB[ra], minB[rb]); const nextMaxB = Math.max(maxB[ra], maxB[rb]);
    const dl = nextMaxL - nextMinL; const da = nextMaxA - nextMinA; const db = nextMaxB - nextMinB;
    if (Math.sqrt(dl * dl + da * da + db * db) > params.globalThreshold + EPSILON) continue;
    if (size[ra] < size[rb] || (size[ra] === size[rb] && ra > rb)) [ra, rb] = [rb, ra];
    parent[rb] = ra; size[ra] += size[rb];
    minL[ra] = nextMinL; maxL[ra] = nextMaxL;
    minA[ra] = nextMinA; maxA[ra] = nextMaxA;
    minB[ra] = nextMinB; maxB[ra] = nextMaxB;
    if ((rank & 65535) === 0) emit("受约束区域合并", 36 + Math.round(24 * rank / Math.max(1, edges.order.length)));
  }
  const rootToLabel = new Int32Array(count); rootToLabel.fill(-1);
  const labels = new Int32Array(count); labels.fill(-1);
  let regionCount = 0;
  for (let i = 0; i < count; i++) {
    if (!valid[i]) continue;
    const root = find(i);
    if (rootToLabel[root] < 0) rootToLabel[root] = regionCount++;
    labels[i] = rootToLabel[root];
  }
  return { labels, regionCount };
}

export function computeBoundaryMask(labels, valid, width, height, outlineWidth) {
  const mask = new Uint8Array(width * height);
  const lineWidth = clamp(Math.round(outlineWidth), 1, 8);
  const mark = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = y * width + x;
    if (valid[i]) mask[i] = 1;
  };
  const leftExtent = Math.floor((lineWidth - 1) / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x + 1 < width; x++) {
      const i = y * width + x; const j = i + 1;
      if (!valid[i] && !valid[j]) continue;
      if (valid[i] && valid[j] && labels[i] === labels[j]) continue;
      if (valid[i] && valid[j]) {
        const start = x - leftExtent;
        for (let k = 0; k < lineWidth; k++) mark(start + k, y);
      } else if (valid[i]) {
        for (let k = 0; k < lineWidth; k++) mark(x - k, y);
      } else {
        for (let k = 0; k < lineWidth; k++) mark(x + 1 + k, y);
      }
    }
  }
  for (let y = 0; y + 1 < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x; const j = i + width;
      if (!valid[i] && !valid[j]) continue;
      if (valid[i] && valid[j] && labels[i] === labels[j]) continue;
      if (valid[i] && valid[j]) {
        const start = y - leftExtent;
        for (let k = 0; k < lineWidth; k++) mark(x, start + k);
      } else if (valid[i]) {
        for (let k = 0; k < lineWidth; k++) mark(x, y - k);
      } else {
        for (let k = 0; k < lineWidth; k++) mark(x, y + 1 + k);
      }
    }
  }
  for (let x = 0; x < width; x++) {
    if (valid[x]) for (let k = 0; k < lineWidth; k++) mark(x, k);
    const bottom = (height - 1) * width + x;
    if (valid[bottom]) for (let k = 0; k < lineWidth; k++) mark(x, height - 1 - k);
  }
  for (let y = 0; y < height; y++) {
    const left = y * width;
    if (valid[left]) for (let k = 0; k < lineWidth; k++) mark(k, y);
    const right = y * width + width - 1;
    if (valid[right]) for (let k = 0; k < lineWidth; k++) mark(width - 1 - k, y);
  }
  return mask;
}

function regionStats(labels, regionCount, working) {
  const area = new Int32Array(regionCount);
  const sumL = new Float64Array(regionCount); const sumA = new Float64Array(regionCount); const sumB = new Float64Array(regionCount);
  const minL = new Float32Array(regionCount); minL.fill(Infinity);
  const maxL = new Float32Array(regionCount); maxL.fill(-Infinity);
  const minA = new Float32Array(regionCount); minA.fill(Infinity);
  const maxA = new Float32Array(regionCount); maxA.fill(-Infinity);
  const minB = new Float32Array(regionCount); minB.fill(Infinity);
  const maxB = new Float32Array(regionCount); maxB.fill(-Infinity);
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i]; if (id < 0) continue;
    area[id]++; sumL[id] += working.L[i]; sumA[id] += working.A[i]; sumB[id] += working.B[i];
    minL[id] = Math.min(minL[id], working.L[i]); maxL[id] = Math.max(maxL[id], working.L[i]);
    minA[id] = Math.min(minA[id], working.A[i]); maxA[id] = Math.max(maxA[id], working.A[i]);
    minB[id] = Math.min(minB[id], working.B[i]); maxB[id] = Math.max(maxB[id], working.B[i]);
  }
  return { area, sumL, sumA, sumB, minL, maxL, minA, maxA, minB, maxB };
}

function buildAdjacency(labels, valid, width, height, regionCount) {
  const pairs = new Map();
  const add = (a, b) => {
    if (a === b || a < 0 || b < 0) return;
    const low = Math.min(a, b); const high = Math.max(a, b);
    const key = low * regionCount + high;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      if (x + 1 < width && valid[i + 1]) add(labels[i], labels[i + 1]);
      if (y + 1 < height && valid[i + width]) add(labels[i], labels[i + width]);
    }
  }
  return pairs;
}

function cleanupRegions(initialLabels, initialCount, working, valid, width, height, params, emit) {
  let labels = initialLabels;
  let regionCount = initialCount;
  let mergedTotal = 0;
  for (let pass = 0; pass < 5; pass++) {
    const stats = regionStats(labels, regionCount, working);
    const boundary = computeBoundaryMask(labels, valid, width, height, params.outlineWidth);
    const inner = stats.area.slice();
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 0 && boundary[i]) inner[labels[i]]--;
    const candidate = new Uint8Array(regionCount);
    const candidateIds = [];
    for (let id = 0; id < regionCount; id++) {
      const ratio = stats.area[id] ? inner[id] / stats.area[id] : 0;
      if (stats.area[id] < params.minRegionArea || ratio + EPSILON < params.minInnerAreaRatio) {
        candidate[id] = 1; candidateIds.push(id);
      }
    }
    if (!candidateIds.length) break;
    candidateIds.sort((a, b) => stats.area[a] - stats.area[b] || a - b);
    const pairs = buildAdjacency(labels, valid, width, height, regionCount);
    const neighborLists = new Map();
    const push = (id, neighbor, shared) => {
      if (!candidate[id]) return;
      if (!neighborLists.has(id)) neighborLists.set(id, []);
      neighborLists.get(id).push({ neighbor, shared });
    };
    for (const [key, shared] of pairs) {
      const low = Math.floor(key / regionCount); const high = key - low * regionCount;
      push(low, high, shared); push(high, low, shared);
    }
    const parent = new Int32Array(regionCount);
    for (let i = 0; i < regionCount; i++) parent[i] = i;
    const find = (id) => {
      let root = id;
      while (parent[root] !== root) root = parent[root];
      while (parent[id] !== id) { const next = parent[id]; parent[id] = root; id = next; }
      return root;
    };
    let mergedThisPass = 0;
    for (const id of candidateIds) {
      const source = find(id);
      if (source !== id || stats.area[source] === 0) continue;
      const options = neighborLists.get(id) || [];
      let best = null;
      for (const option of options) {
        const target = find(option.neighbor);
        if (target === source || stats.area[target] === 0) continue;
        const nextMinL = Math.min(stats.minL[source], stats.minL[target]); const nextMaxL = Math.max(stats.maxL[source], stats.maxL[target]);
        const nextMinA = Math.min(stats.minA[source], stats.minA[target]); const nextMaxA = Math.max(stats.maxA[source], stats.maxA[target]);
        const nextMinB = Math.min(stats.minB[source], stats.minB[target]); const nextMaxB = Math.max(stats.maxB[source], stats.maxB[target]);
        const dl = nextMaxL - nextMinL; const da = nextMaxA - nextMinA; const db = nextMaxB - nextMinB;
        if (Math.sqrt(dl * dl + da * da + db * db) > params.globalThreshold + EPSILON) continue;
        const sourceMeanL = stats.sumL[source] / stats.area[source]; const targetMeanL = stats.sumL[target] / stats.area[target];
        const sourceMeanA = stats.sumA[source] / stats.area[source]; const targetMeanA = stats.sumA[target] / stats.area[target];
        const sourceMeanB = stats.sumB[source] / stats.area[source]; const targetMeanB = stats.sumB[target] / stats.area[target];
        const colorDiff = Math.hypot(sourceMeanL - targetMeanL, sourceMeanA - targetMeanA, sourceMeanB - targetMeanB);
        const score = colorDiff - Math.log2(option.shared + 1) * 0.002;
        if (!best || score < best.score || (score === best.score && target < best.target)) {
          best = { target, score, nextMinL, nextMaxL, nextMinA, nextMaxA, nextMinB, nextMaxB };
        }
      }
      if (!best) continue;
      const target = best.target;
      parent[source] = target;
      stats.area[target] += stats.area[source]; stats.area[source] = 0;
      stats.sumL[target] += stats.sumL[source]; stats.sumA[target] += stats.sumA[source]; stats.sumB[target] += stats.sumB[source];
      stats.minL[target] = best.nextMinL; stats.maxL[target] = best.nextMaxL;
      stats.minA[target] = best.nextMinA; stats.maxA[target] = best.nextMaxA;
      stats.minB[target] = best.nextMinB; stats.maxB[target] = best.nextMaxB;
      mergedThisPass++;
    }
    if (!mergedThisPass) break;
    const rootToNew = new Int32Array(regionCount); rootToNew.fill(-1);
    let nextCount = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] < 0) continue;
      const root = find(labels[i]);
      if (rootToNew[root] < 0) rootToNew[root] = nextCount++;
      labels[i] = rootToNew[root];
    }
    regionCount = nextCount;
    mergedTotal += mergedThisPass;
    emit(`清理细碎区域 · 第 ${pass + 1} 轮`, 64 + pass * 3);
  }
  const finalStats = regionStats(labels, regionCount, working);
  const finalBoundary = computeBoundaryMask(labels, valid, width, height, params.outlineWidth);
  const inner = finalStats.area.slice();
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0 && finalBoundary[i]) inner[labels[i]]--;
  let unresolved = 0;
  for (let id = 0; id < regionCount; id++) {
    const ratio = finalStats.area[id] ? inner[id] / finalStats.area[id] : 0;
    if (finalStats.area[id] < params.minRegionArea || ratio + EPSILON < params.minInnerAreaRatio) unresolved++;
  }
  return { labels, regionCount, mergedTotal, unresolved };
}

function renderImages(image, labels, regionCount, valid, boundaryMask, outlineColor) {
  const sumR = new Float64Array(regionCount); const sumG = new Float64Array(regionCount); const sumB = new Float64Array(regionCount);
  const counts = new Int32Array(regionCount);
  for (let i = 0; i < labels.length; i++) {
    const id = labels[i]; if (id < 0) continue;
    counts[id]++; sumR[id] += image.data[i * 4]; sumG[id] += image.data[i * 4 + 1]; sumB[id] += image.data[i * 4 + 2];
  }
  const palette = new Uint8Array(regionCount * 3);
  for (let id = 0; id < regionCount; id++) {
    palette[id * 3] = Math.round(sumR[id] / counts[id]);
    palette[id * 3 + 1] = Math.round(sumG[id] / counts[id]);
    palette[id * 3 + 2] = Math.round(sumB[id] / counts[id]);
  }
  const flatRGBA = new Uint8ClampedArray(labels.length * 4);
  const outlinedRGBA = new Uint8ClampedArray(labels.length * 4);
  let boundaryPixelCount = 0;
  for (let i = 0; i < labels.length; i++) {
    if (!valid[i]) continue;
    const id = labels[i]; const offset = i * 4;
    flatRGBA[offset] = outlinedRGBA[offset] = palette[id * 3];
    flatRGBA[offset + 1] = outlinedRGBA[offset + 1] = palette[id * 3 + 1];
    flatRGBA[offset + 2] = outlinedRGBA[offset + 2] = palette[id * 3 + 2];
    flatRGBA[offset + 3] = outlinedRGBA[offset + 3] = 255;
    if (boundaryMask[i]) {
      boundaryPixelCount++;
      outlinedRGBA[offset] = outlineColor[0]; outlinedRGBA[offset + 1] = outlineColor[1]; outlinedRGBA[offset + 2] = outlineColor[2];
    }
  }
  return { flatRGBA, outlinedRGBA, palette, boundaryPixelCount };
}

export function validateOutput({ labels, valid, flatRGBA, boundaryMask, outlinedRGBA, outlineColor, regionCount }) {
  const seen = new Int16Array(regionCount * 3); seen.fill(-1);
  const errors = [];
  for (let i = 0; i < labels.length; i++) {
    const offset = i * 4;
    if (!valid[i]) {
      if (flatRGBA[offset + 3] !== 0 || outlinedRGBA[offset + 3] !== 0) errors.push(`透明像素 ${i} 的 alpha 泄漏`);
      if (errors.length > 20) break;
      continue;
    }
    if (boundaryMask[i]) {
      if (outlinedRGBA[offset] !== outlineColor[0] || outlinedRGBA[offset + 1] !== outlineColor[1] || outlinedRGBA[offset + 2] !== outlineColor[2] || outlinedRGBA[offset + 3] !== 255) {
        errors.push(`边界像素 ${i} 未使用精确描边色`);
      }
      continue;
    }
    const id = labels[i]; const paletteOffset = id * 3;
    if (seen[paletteOffset] < 0) {
      seen[paletteOffset] = flatRGBA[offset]; seen[paletteOffset + 1] = flatRGBA[offset + 1]; seen[paletteOffset + 2] = flatRGBA[offset + 2];
    } else if (seen[paletteOffset] !== flatRGBA[offset] || seen[paletteOffset + 1] !== flatRGBA[offset + 1] || seen[paletteOffset + 2] !== flatRGBA[offset + 2]) {
      errors.push(`区域 ${id} 的非边界像素颜色不一致`);
    }
    if (outlinedRGBA[offset] !== flatRGBA[offset] || outlinedRGBA[offset + 1] !== flatRGBA[offset + 1] || outlinedRGBA[offset + 2] !== flatRGBA[offset + 2]) {
      errors.push(`非边界像素 ${i} 被额外混色`);
    }
    if (errors.length > 20) break;
  }
  return { passed: errors.length === 0, errors };
}

export function processImage(image, inputParams = {}, progress = () => {}) {
  const startedAt = performance.now();
  const emit = (stage, percent) => progress({ stage, percent: clamp(Math.round(percent), 0, 100) });
  emit("读取并转换 OKLab", 4);
  const prepared = preparePixels(image);
  emit("分析相邻色差分布", 12);
  const analysis = estimateFromPrepared(prepared, image.width, image.height);
  const baseParams = validateParams(inputParams);
  const params = baseParams.autoMode
    ? validateParams({ ...baseParams, ...analysis.params, segmentationMethod: baseParams.segmentationMethod, outlineWidth: baseParams.outlineWidth, outlineColor: baseParams.outlineColor, minInnerAreaRatio: baseParams.minInnerAreaRatio, connectivity: baseParams.connectivity })
    : baseParams;
  const working = smoothWorkingLab(prepared, image.width, image.height, params.preSmoothLevel, params.localThreshold);
  emit("保边预处理完成", 20);
  let segmented;
  let cleaned;
  let prototypeDiagnostics = null;
  let customBoundaryMask = null;
  if (params.segmentationMethod === "fh-rag") {
    const prototype = processWithFhRagPrototype({
      working,
      valid: prepared.valid,
      width: image.width,
      height: image.height,
      params,
      computeBoundaryMask,
      emit
    });
    segmented = { labels: prototype.labels, regionCount: prototype.initialRegionCount };
    cleaned = {
      labels: prototype.labels,
      regionCount: prototype.regionCount,
      mergedTotal: prototype.mergedTotal,
      unresolved: prototype.unresolved
    };
    prototypeDiagnostics = {
      protectedFeatureCount: prototype.protectedFeatureCount,
      rejectedMergeCount: prototype.rejectedMergeCount,
      recoveredWeakBoundaryCount: prototype.recoveredWeakBoundaryCount
    };
  } else if (params.segmentationMethod === "hierarchical-fusion") {
    const coarseSegmented = segmentPixels(working, prepared.valid, image.width, image.height, params, (stage, percent) => emit(`粗层 · ${stage}`, 20 + percent * 0.35));
    const coarseCleaned = cleanupRegions(coarseSegmented.labels, coarseSegmented.regionCount, working, prepared.valid, image.width, image.height, params, (stage, percent) => emit(`粗层 · ${stage}`, 20 + percent * 0.35));
    const fineGlobalThreshold = clamp(params.globalThreshold * 0.34, Math.max(params.localThreshold, 0.04), Math.min(params.globalThreshold, 0.22));
    const fineParams = { ...params, globalThreshold: fineGlobalThreshold };
    const fineSegmented = segmentPixels(working, prepared.valid, image.width, image.height, fineParams, (stage, percent) => emit(`细层 · ${stage}`, 48 + percent * 0.32));
    const fusion = fuseHierarchicalLayers({
      coarse: { labels: coarseCleaned.labels, regionCount: coarseCleaned.regionCount },
      fine: { labels: fineSegmented.labels, regionCount: fineSegmented.regionCount, globalThreshold: fineGlobalThreshold },
      working,
      valid: prepared.valid,
      width: image.width,
      height: image.height,
      params,
      computeBoundaryMask
    });
    segmented = coarseSegmented;
    cleaned = {
      labels: fusion.labels,
      regionCount: fusion.regionCount,
      mergedTotal: coarseCleaned.mergedTotal,
      unresolved: coarseCleaned.unresolved
    };
    customBoundaryMask = fusion.boundaryMask;
    prototypeDiagnostics = fusion.diagnostics;
  } else {
    segmented = segmentPixels(working, prepared.valid, image.width, image.height, params, emit);
    emit("构建区域邻接关系", 62);
    cleaned = cleanupRegions(segmented.labels, segmented.regionCount, working, prepared.valid, image.width, image.height, params, emit);
  }
  emit("生成纯色色板", 82);
  const boundaryMask = customBoundaryMask || computeBoundaryMask(cleaned.labels, prepared.valid, image.width, image.height, params.outlineWidth);
  const rendered = renderImages(image, cleaned.labels, cleaned.regionCount, prepared.valid, boundaryMask, params.outlineColor);
  emit("校验像素不变量", 94);
  const validation = validateOutput({
    labels: cleaned.labels,
    valid: prepared.valid,
    flatRGBA: rendered.flatRGBA,
    boundaryMask,
    outlinedRGBA: rendered.outlinedRGBA,
    outlineColor: params.outlineColor,
    regionCount: cleaned.regionCount
  });
  const warnings = [];
  if (prepared.semiTransparentCount) warnings.push(`${prepared.semiTransparentCount.toLocaleString()} 个半透明像素已按前景硬化为 alpha=255。`);
  if (cleaned.unresolved) warnings.push(`${cleaned.unresolved.toLocaleString()} 个小/细区域因全局色差约束未被强行合并。`);
  if (cleaned.regionCount > 3000) warnings.push("最终区域数量较多；可提高阈值或平滑强度以减少碎片。");
  if (params.segmentationMethod === "fh-rag") warnings.push("当前结果来自 FH + RAG 实验方法，用于与现有方法对比，尚未替换稳定管线。");
  if (params.segmentationMethod === "hierarchical-fusion") warnings.push("当前结果来自多尺度融合实验：粗层负责干净，细层只提升有边界证据的封闭特征。");
  warnings.push("全局跨度使用 OKLab 边界盒上界，可能保守拒绝部分合并。");
  if (!validation.passed) warnings.unshift(`像素校验失败：${validation.errors[0]}`);
  const stats = {
    width: image.width,
    height: image.height,
    effectiveParams: params,
    estimatedParams: analysis.params,
    autoMetrics: analysis.metrics,
    segmentationMethod: params.segmentationMethod,
    prototypeDiagnostics,
    initialRegionCount: segmented.regionCount,
    finalRegionCount: cleaned.regionCount,
    mergedSmallRegionCount: cleaned.mergedTotal,
    unresolvedSmallRegionCount: cleaned.unresolved,
    boundaryPixelCount: rendered.boundaryPixelCount,
    validPixelCount: prepared.validCount,
    elapsedMs: Math.round(performance.now() - startedAt),
    warnings,
    validation
  };
  emit("处理完成", 100);
  return {
    width: image.width,
    height: image.height,
    flatRGBA: rendered.flatRGBA,
    boundaryMask,
    outlinedRGBA: rendered.outlinedRGBA,
    labels: cleaned.labels,
    stats
  };
}
