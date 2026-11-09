/**
 * PROTOTYPE — FH + boundary-aware RAG experiment.
 *
 * This module is deliberately isolated from the stable pipeline. It answers one
 * question: can an adaptive graph segmentation plus evidence-based cleanup keep
 * coherent small features (hair highlights / counters) while still flattening
 * low-amplitude noise? Absorb or delete it after the comparison is evaluated.
 */

const EPSILON = 1e-9;
const EDGE_QUANT_SCALE = 32768;

function distance(l, a, b, i, j) {
  return Math.hypot(l[i] - l[j], a[i] - a[j], b[i] - b[j]);
}

function createSortedEdges(working, valid, width, height, connectivity) {
  const directions = connectivity === 8
    ? [[1, 0], [0, 1], [1, 1], [-1, 1]]
    : [[1, 0], [0, 1]];
  let edgeCount = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!valid[i]) continue;
    for (const [dx, dy] of directions) {
      const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && nx < width && ny < height && valid[ny * width + nx]) edgeCount++;
    }
  }
  const from = new Int32Array(edgeCount);
  const to = new Int32Array(edgeCount);
  const weight = new Float32Array(edgeCount);
  const bucket = new Uint16Array(edgeCount);
  let cursor = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!valid[i]) continue;
    for (const [dx, dy] of directions) {
      const nx = x + dx; const ny = y + dy;
      if (nx < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (!valid[j]) continue;
      const edgeWeight = distance(working.L, working.A, working.B, i, j);
      from[cursor] = Math.min(i, j);
      to[cursor] = Math.max(i, j);
      weight[cursor] = edgeWeight;
      bucket[cursor] = Math.min(65535, Math.round(edgeWeight * EDGE_QUANT_SCALE));
      cursor++;
    }
  }
  const counts = new Int32Array(65536);
  for (let i = 0; i < edgeCount; i++) counts[bucket[i]]++;
  const offsets = new Int32Array(65536);
  let total = 0;
  for (let i = 0; i < offsets.length; i++) { offsets[i] = total; total += counts[i]; }
  const write = offsets.slice();
  const order = new Int32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) order[write[bucket[i]]++] = i;
  return { from, to, weight, order };
}

function segmentFH(working, valid, width, height, params, emit) {
  const pixelCount = width * height;
  const parent = new Int32Array(pixelCount);
  const size = new Int32Array(pixelCount);
  const internalDifference = new Float32Array(pixelCount);
  const minL = new Float32Array(pixelCount); const maxL = new Float32Array(pixelCount);
  const minA = new Float32Array(pixelCount); const maxA = new Float32Array(pixelCount);
  const minB = new Float32Array(pixelCount); const maxB = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
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
  emit("实验方法 · 建立 FH 像素图", 25);
  const edges = createSortedEdges(working, valid, width, height, params.connectivity);
  const scaleK = Math.max(params.globalThreshold, params.localThreshold * 12, 0.08);
  for (let rank = 0; rank < edges.order.length; rank++) {
    const edgeIndex = edges.order[rank];
    let rootA = find(edges.from[edgeIndex]);
    let rootB = find(edges.to[edgeIndex]);
    if (rootA === rootB) continue;
    const thresholdA = internalDifference[rootA] + scaleK / size[rootA];
    const thresholdB = internalDifference[rootB] + scaleK / size[rootB];
    const edgeWeight = edges.weight[edgeIndex];
    if (edgeWeight > Math.min(thresholdA, thresholdB) + EPSILON) continue;
    const nextMinL = Math.min(minL[rootA], minL[rootB]); const nextMaxL = Math.max(maxL[rootA], maxL[rootB]);
    const nextMinA = Math.min(minA[rootA], minA[rootB]); const nextMaxA = Math.max(maxA[rootA], maxA[rootB]);
    const nextMinB = Math.min(minB[rootA], minB[rootB]); const nextMaxB = Math.max(maxB[rootA], maxB[rootB]);
    if (Math.hypot(nextMaxL - nextMinL, nextMaxA - nextMinA, nextMaxB - nextMinB) > params.globalThreshold + EPSILON) continue;
    if (size[rootA] < size[rootB] || (size[rootA] === size[rootB] && rootA > rootB)) [rootA, rootB] = [rootB, rootA];
    parent[rootB] = rootA;
    size[rootA] += size[rootB];
    internalDifference[rootA] = Math.max(edgeWeight, internalDifference[rootA], internalDifference[rootB]);
    minL[rootA] = nextMinL; maxL[rootA] = nextMaxL;
    minA[rootA] = nextMinA; maxA[rootA] = nextMaxA;
    minB[rootA] = nextMinB; maxB[rootA] = nextMaxB;
    if ((rank & 65535) === 0) emit("实验方法 · FH 自适应分割", 34 + Math.round(25 * rank / Math.max(1, edges.order.length)));
  }
  const rootToLabel = new Int32Array(pixelCount); rootToLabel.fill(-1);
  const labels = new Int32Array(pixelCount); labels.fill(-1);
  let regionCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (!valid[i]) continue;
    const root = find(i);
    if (rootToLabel[root] < 0) rootToLabel[root] = regionCount++;
    labels[i] = rootToLabel[root];
  }
  return { labels, regionCount };
}

function collectRegionStats(labels, regionCount, working, valid, width, height) {
  const area = new Int32Array(regionCount);
  const sumL = new Float64Array(regionCount); const sumA = new Float64Array(regionCount); const sumB = new Float64Array(regionCount);
  const minL = new Float32Array(regionCount); minL.fill(Infinity);
  const maxL = new Float32Array(regionCount); maxL.fill(-Infinity);
  const minA = new Float32Array(regionCount); minA.fill(Infinity);
  const maxA = new Float32Array(regionCount); maxA.fill(-Infinity);
  const minB = new Float32Array(regionCount); minB.fill(Infinity);
  const maxB = new Float32Array(regionCount); maxB.fill(-Infinity);
  const touchesExterior = new Uint8Array(regionCount);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x; const id = labels[i];
    if (id < 0) continue;
    area[id]++; sumL[id] += working.L[i]; sumA[id] += working.A[i]; sumB[id] += working.B[i];
    minL[id] = Math.min(minL[id], working.L[i]); maxL[id] = Math.max(maxL[id], working.L[i]);
    minA[id] = Math.min(minA[id], working.A[i]); maxA[id] = Math.max(maxA[id], working.A[i]);
    minB[id] = Math.min(minB[id], working.B[i]); maxB[id] = Math.max(maxB[id], working.B[i]);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesExterior[id] = 1;
    else if (!valid[i - 1] || !valid[i + 1] || !valid[i - width] || !valid[i + width]) touchesExterior[id] = 1;
  }
  return { area, sumL, sumA, sumB, minL, maxL, minA, maxA, minB, maxB, touchesExterior };
}

function collectAdjacency(labels, valid, working, width, height, regionCount, localThreshold) {
  const pairs = new Map();
  const add = (i, j) => {
    const a = labels[i]; const b = labels[j];
    if (a < 0 || b < 0 || a === b) return;
    const low = Math.min(a, b); const high = Math.max(a, b);
    const key = low * regionCount + high;
    let pair = pairs.get(key);
    if (!pair) { pair = { low, high, count: 0, sumDiff: 0, maxDiff: 0, strongCount: 0 }; pairs.set(key, pair); }
    const diff = distance(working.L, working.A, working.B, i, j);
    pair.count++; pair.sumDiff += diff; pair.maxDiff = Math.max(pair.maxDiff, diff);
    if (diff > localThreshold * 1.5) pair.strongCount++;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!valid[i]) continue;
    if (x + 1 < width && valid[i + 1]) add(i, i + 1);
    if (y + 1 < height && valid[i + width]) add(i, i + width);
  }
  return pairs;
}

function buildTopology(stats, adjacency, regionCount, params, pixelCount) {
  const degree = new Int32Array(regionCount);
  const neighbors = new Map();
  const push = (id, pair, neighbor) => {
    degree[id]++;
    if (!neighbors.has(id)) neighbors.set(id, []);
    neighbors.get(id).push({ pair, neighbor });
  };
  for (const pair of adjacency.values()) { push(pair.low, pair, pair.high); push(pair.high, pair, pair.low); }
  const protectedFeature = new Uint8Array(regionCount);
  const minProtectedArea = Math.max(4, Math.ceil(pixelCount * 0.000002));
  const meaningfulBoundary = Math.max(params.localThreshold * 1.5, 0.018);
  for (let id = 0; id < regionCount; id++) {
    if (stats.touchesExterior[id] || degree[id] !== 1 || stats.area[id] < minProtectedArea) continue;
    const onlyBoundary = neighbors.get(id)?.[0]?.pair;
    if (!onlyBoundary) continue;
    const meanBoundaryDiff = onlyBoundary.sumDiff / onlyBoundary.count;
    const strongRatio = onlyBoundary.strongCount / onlyBoundary.count;
    if (meanBoundaryDiff >= meaningfulBoundary || strongRatio >= 0.55) protectedFeature[id] = 1;
  }
  return { degree, neighbors, protectedFeature };
}

function recoverWeakBoundaries(labels, initialCount, working, valid, width, height, params, emit) {
  let regionCount = initialCount;
  let mergedTotal = 0;
  for (let pass = 0; pass < 5; pass++) {
    const stats = collectRegionStats(labels, regionCount, working, valid, width, height);
    const adjacency = collectAdjacency(labels, valid, working, width, height, regionCount, params.localThreshold);
    const { protectedFeature } = buildTopology(stats, adjacency, regionCount, params, width * height);
    const parent = new Int32Array(regionCount);
    for (let i = 0; i < regionCount; i++) parent[i] = i;
    const find = (id) => {
      let root = id;
      while (parent[root] !== root) root = parent[root];
      while (parent[id] !== id) { const next = parent[id]; parent[id] = root; id = next; }
      return root;
    };
    const recoveryLimit = Math.max(params.localThreshold * 1.45, 0.008);
    const pairs = [...adjacency.values()].sort((left, right) => {
      const leftMean = left.sumDiff / left.count;
      const rightMean = right.sumDiff / right.count;
      return leftMean - rightMean || right.count - left.count || left.low - right.low || left.high - right.high;
    });
    let mergedThisPass = 0;
    for (const pair of pairs) {
      const meanBoundaryDiff = pair.sumDiff / pair.count;
      const strongRatio = pair.strongCount / pair.count;
      if (meanBoundaryDiff > recoveryLimit || strongRatio > 0.35) continue;
      let rootA = find(pair.low); let rootB = find(pair.high);
      if (rootA === rootB || protectedFeature[rootA] || protectedFeature[rootB]) continue;
      const nextMinL = Math.min(stats.minL[rootA], stats.minL[rootB]); const nextMaxL = Math.max(stats.maxL[rootA], stats.maxL[rootB]);
      const nextMinA = Math.min(stats.minA[rootA], stats.minA[rootB]); const nextMaxA = Math.max(stats.maxA[rootA], stats.maxA[rootB]);
      const nextMinB = Math.min(stats.minB[rootA], stats.minB[rootB]); const nextMaxB = Math.max(stats.maxB[rootA], stats.maxB[rootB]);
      if (Math.hypot(nextMaxL - nextMinL, nextMaxA - nextMinA, nextMaxB - nextMinB) > params.globalThreshold + EPSILON) continue;
      if (stats.area[rootA] < stats.area[rootB] || (stats.area[rootA] === stats.area[rootB] && rootA > rootB)) [rootA, rootB] = [rootB, rootA];
      parent[rootB] = rootA;
      stats.area[rootA] += stats.area[rootB]; stats.area[rootB] = 0;
      stats.sumL[rootA] += stats.sumL[rootB]; stats.sumA[rootA] += stats.sumA[rootB]; stats.sumB[rootA] += stats.sumB[rootB];
      stats.minL[rootA] = nextMinL; stats.maxL[rootA] = nextMaxL;
      stats.minA[rootA] = nextMinA; stats.maxA[rootA] = nextMaxA;
      stats.minB[rootA] = nextMinB; stats.maxB[rootA] = nextMaxB;
      mergedThisPass++;
    }
    if (!mergedThisPass) break;
    const rootToLabel = new Int32Array(regionCount); rootToLabel.fill(-1);
    let nextCount = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] < 0) continue;
      const root = find(labels[i]);
      if (rootToLabel[root] < 0) rootToLabel[root] = nextCount++;
      labels[i] = rootToLabel[root];
    }
    regionCount = nextCount;
    mergedTotal += mergedThisPass;
    emit(`实验方法 · 恢复弱边界 ${pass + 1}/5`, 58 + pass);
  }
  return { labels, regionCount, mergedTotal };
}

function cleanupRAG(labels, initialCount, working, valid, width, height, params, computeBoundaryMask, emit) {
  let regionCount = initialCount;
  let mergedTotal = 0;
  let protectedFeatureCount = 0;
  let rejectedMergeCount = 0;
  for (let pass = 0; pass < 5; pass++) {
    const stats = collectRegionStats(labels, regionCount, working, valid, width, height);
    const boundaryMask = computeBoundaryMask(labels, valid, width, height, params.outlineWidth);
    const innerArea = stats.area.slice();
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 0 && boundaryMask[i]) innerArea[labels[i]]--;
    const adjacency = collectAdjacency(labels, valid, working, width, height, regionCount, params.localThreshold);
    const { neighbors, protectedFeature } = buildTopology(stats, adjacency, regionCount, params, width * height);
    protectedFeatureCount = protectedFeature.reduce((sum, value) => sum + value, 0);
    const candidates = [];
    for (let id = 0; id < regionCount; id++) {
      const ratio = stats.area[id] ? innerArea[id] / stats.area[id] : 0;
      if (stats.area[id] < params.minRegionArea || ratio + EPSILON < params.minInnerAreaRatio) candidates.push(id);
    }
    candidates.sort((a, b) => stats.area[a] - stats.area[b] || a - b);
    const parent = new Int32Array(regionCount);
    for (let i = 0; i < regionCount; i++) parent[i] = i;
    const find = (id) => {
      let root = id;
      while (parent[root] !== root) root = parent[root];
      while (parent[id] !== id) { const next = parent[id]; parent[id] = root; id = next; }
      return root;
    };
    const cleanupBoundaryLimit = Math.max(params.localThreshold * 2.25, 0.018);
    let mergedThisPass = 0;
    for (const candidate of candidates) {
      const source = find(candidate);
      if (source !== candidate || stats.area[source] === 0 || protectedFeature[source]) continue;
      let best = null;
      for (const option of neighbors.get(candidate) || []) {
        const target = find(option.neighbor);
        if (target === source || stats.area[target] === 0) continue;
        const pair = option.pair;
        const meanBoundaryDiff = pair.sumDiff / pair.count;
        const strongRatio = pair.strongCount / pair.count;
        if (meanBoundaryDiff > cleanupBoundaryLimit || strongRatio > 0.55) { rejectedMergeCount++; continue; }
        const meanSource = [stats.sumL[source] / stats.area[source], stats.sumA[source] / stats.area[source], stats.sumB[source] / stats.area[source]];
        const meanTarget = [stats.sumL[target] / stats.area[target], stats.sumA[target] / stats.area[target], stats.sumB[target] / stats.area[target]];
        const meanDistanceSquared = (meanSource[0] - meanTarget[0]) ** 2 + (meanSource[1] - meanTarget[1]) ** 2 + (meanSource[2] - meanTarget[2]) ** 2;
        const reconstructionLossPerSourcePixel = stats.area[target] / (stats.area[source] + stats.area[target]) * meanDistanceSquared;
        if (reconstructionLossPerSourcePixel > (cleanupBoundaryLimit * 1.75) ** 2) { rejectedMergeCount++; continue; }
        const nextMinL = Math.min(stats.minL[source], stats.minL[target]); const nextMaxL = Math.max(stats.maxL[source], stats.maxL[target]);
        const nextMinA = Math.min(stats.minA[source], stats.minA[target]); const nextMaxA = Math.max(stats.maxA[source], stats.maxA[target]);
        const nextMinB = Math.min(stats.minB[source], stats.minB[target]); const nextMaxB = Math.max(stats.maxB[source], stats.maxB[target]);
        if (Math.hypot(nextMaxL - nextMinL, nextMaxA - nextMinA, nextMaxB - nextMinB) > params.globalThreshold + EPSILON) continue;
        const score = meanBoundaryDiff + reconstructionLossPerSourcePixel - Math.log2(pair.count + 1) * 0.001;
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
    const rootToLabel = new Int32Array(regionCount); rootToLabel.fill(-1);
    let nextCount = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] < 0) continue;
      const root = find(labels[i]);
      if (rootToLabel[root] < 0) rootToLabel[root] = nextCount++;
      labels[i] = rootToLabel[root];
    }
    regionCount = nextCount;
    mergedTotal += mergedThisPass;
    emit(`实验方法 · RAG 证据清理 ${pass + 1}/5`, 64 + pass * 3);
  }
  const finalStats = collectRegionStats(labels, regionCount, working, valid, width, height);
  const finalBoundary = computeBoundaryMask(labels, valid, width, height, params.outlineWidth);
  const finalInner = finalStats.area.slice();
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0 && finalBoundary[i]) finalInner[labels[i]]--;
  let unresolved = 0;
  for (let id = 0; id < regionCount; id++) {
    const ratio = finalStats.area[id] ? finalInner[id] / finalStats.area[id] : 0;
    if (finalStats.area[id] < params.minRegionArea || ratio + EPSILON < params.minInnerAreaRatio) unresolved++;
  }
  return { labels, regionCount, mergedTotal, unresolved, protectedFeatureCount, rejectedMergeCount };
}

export function processWithFhRagPrototype({ working, valid, width, height, params, computeBoundaryMask, emit }) {
  const segmented = segmentFH(working, valid, width, height, params, emit);
  const recovered = recoverWeakBoundaries(segmented.labels, segmented.regionCount, working, valid, width, height, params, emit);
  emit("实验方法 · 构建区域邻接图", 62);
  const cleaned = cleanupRAG(recovered.labels, recovered.regionCount, working, valid, width, height, params, computeBoundaryMask, emit);
  return {
    ...cleaned,
    mergedTotal: cleaned.mergedTotal + recovered.mergedTotal,
    recoveredWeakBoundaryCount: recovered.mergedTotal,
    initialRegionCount: segmented.regionCount
  };
}
