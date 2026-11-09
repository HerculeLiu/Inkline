/**
 * PROTOTYPE — hierarchical coarse/fine fusion.
 *
 * The coarse layer owns cleanliness. The fine layer may only promote bounded,
 * well-supported features back into that layer. This file is intentionally
 * isolated until real-image comparison decides whether the idea is worth
 * absorbing into the stable pipeline.
 */

function labDistance(working, left, right) {
  return Math.hypot(
    working.L[left] - working.L[right],
    working.A[left] - working.A[right],
    working.B[left] - working.B[right]
  );
}

function collectRegionMeans(labels, regionCount, working, valid) {
  const area = new Int32Array(regionCount);
  const sumL = new Float64Array(regionCount); const sumA = new Float64Array(regionCount); const sumB = new Float64Array(regionCount);
  for (let pixel = 0; pixel < labels.length; pixel++) {
    if (!valid[pixel]) continue;
    const id = labels[pixel];
    area[id]++; sumL[id] += working.L[pixel]; sumA[id] += working.A[pixel]; sumB[id] += working.B[pixel];
  }
  const meanL = new Float32Array(regionCount); const meanA = new Float32Array(regionCount); const meanB = new Float32Array(regionCount);
  for (let id = 0; id < regionCount; id++) if (area[id]) {
    meanL[id] = sumL[id] / area[id]; meanA[id] = sumA[id] / area[id]; meanB[id] = sumB[id] / area[id];
  }
  return { meanL, meanA, meanB };
}

function collectFineEvidence(labels, regionCount, working, valid, width, height, coarseLabels, coarseMeans) {
  const area = new Int32Array(regionCount);
  const sumL = new Float64Array(regionCount); const sumA = new Float64Array(regionCount); const sumB = new Float64Array(regionCount);
  const coarseReferenceL = new Float64Array(regionCount); const coarseReferenceA = new Float64Array(regionCount); const coarseReferenceB = new Float64Array(regionCount);
  const touchesExterior = new Uint8Array(regionCount);
  const boundaryLength = new Int32Array(regionCount);
  const boundaryDifference = new Float64Array(regionCount);
  const neighbors = Array.from({ length: regionCount }, () => new Set());
  const pairs = new Map();
  const addBoundary = (leftPixel, rightPixel) => {
    const left = labels[leftPixel]; const right = labels[rightPixel];
    if (left < 0 || right < 0 || left === right) return;
    const difference = labDistance(working, leftPixel, rightPixel);
    boundaryLength[left]++; boundaryLength[right]++;
    boundaryDifference[left] += difference; boundaryDifference[right] += difference;
    neighbors[left].add(right); neighbors[right].add(left);
    const low = Math.min(left, right); const high = Math.max(left, right);
    const key = low * regionCount + high;
    let pair = pairs.get(key);
    if (!pair) { pair = { low, high, count: 0, difference: 0 }; pairs.set(key, pair); }
    pair.count++;
    pair.difference += difference;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x; const label = labels[pixel];
    if (label < 0) continue;
    area[label]++;
    sumL[label] += working.L[pixel]; sumA[label] += working.A[pixel]; sumB[label] += working.B[pixel];
    const coarseId = coarseLabels[pixel];
    coarseReferenceL[label] += coarseMeans.meanL[coarseId];
    coarseReferenceA[label] += coarseMeans.meanA[coarseId];
    coarseReferenceB[label] += coarseMeans.meanB[coarseId];
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesExterior[label] = 1;
    else if (!valid[pixel - 1] || !valid[pixel + 1] || !valid[pixel - width] || !valid[pixel + width]) touchesExterior[label] = 1;
    if (x + 1 < width && valid[pixel + 1]) addBoundary(pixel, pixel + 1);
    if (y + 1 < height && valid[pixel + width]) addBoundary(pixel, pixel + width);
  }
  return { area, sumL, sumA, sumB, coarseReferenceL, coarseReferenceA, coarseReferenceB, touchesExterior, boundaryLength, boundaryDifference, neighbors, pairs };
}

function addSelectedDetailBoundaries(mask, labels, selectedPairKeys, working, valid, width, height, regionCount) {
  let addedPixelCount = 0;
  const add = (leftPixel, rightPixel) => {
    const left = labels[leftPixel]; const right = labels[rightPixel];
    if (left < 0 || right < 0 || left === right) return;
    const low = Math.min(left, right); const high = Math.max(left, right);
    if (!selectedPairKeys.has(low * regionCount + high)) return;
    const chosen = working.L[leftPixel] <= working.L[rightPixel] ? leftPixel : rightPixel;
    if (!mask[chosen]) { mask[chosen] = 1; addedPixelCount++; }
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x;
    if (!valid[pixel]) continue;
    if (x + 1 < width && valid[pixel + 1]) add(pixel, pixel + 1);
    if (y + 1 < height && valid[pixel + width]) add(pixel, pixel + width);
  }
  return addedPixelCount;
}

export function fuseHierarchicalLayers({ coarse, fine, working, valid, width, height, params, computeBoundaryMask }) {
  const coarseMeans = collectRegionMeans(coarse.labels, coarse.regionCount, working, valid);
  const evidence = collectFineEvidence(fine.labels, fine.regionCount, working, valid, width, height, coarse.labels, coarseMeans);
  const selected = new Uint8Array(fine.regionCount);
  const pixelCount = width * height;
  const maximumFeatureArea = Math.max(512, Math.ceil(pixelCount * 0.04));
  const minimumBoundaryDifference = Math.max(params.localThreshold * 1.4, 0.025);
  const detailBoundaryDifference = Math.max(params.localThreshold * 1.1, 0.018);
  const minimumCoarseDeviation = Math.max(params.localThreshold * 2, 0.04);
  let selectedFeatureRegionCount = 0;
  for (let id = 0; id < fine.regionCount; id++) {
    const meanBoundaryDifference = evidence.boundaryLength[id]
      ? evidence.boundaryDifference[id] / evidence.boundaryLength[id]
      : 0;
    const meanL = evidence.area[id] ? evidence.sumL[id] / evidence.area[id] : 0;
    const meanA = evidence.area[id] ? evidence.sumA[id] / evidence.area[id] : 0;
    const meanB = evidence.area[id] ? evidence.sumB[id] / evidence.area[id] : 0;
    const referenceL = evidence.area[id] ? evidence.coarseReferenceL[id] / evidence.area[id] : 0;
    const referenceA = evidence.area[id] ? evidence.coarseReferenceA[id] / evidence.area[id] : 0;
    const referenceB = evidence.area[id] ? evidence.coarseReferenceB[id] / evidence.area[id] : 0;
    const coarseDeviation = Math.hypot(meanL - referenceL, meanA - referenceA, meanB - referenceB);
    const topologySupported = evidence.neighbors[id].size <= 4 && meanBoundaryDifference >= minimumBoundaryDifference;
    const coarseDifferenceSupported = coarseDeviation >= minimumCoarseDeviation * 1.5;
    if (
      !evidence.touchesExterior[id] &&
      evidence.area[id] >= 4 &&
      evidence.area[id] <= maximumFeatureArea &&
      (topologySupported || coarseDifferenceSupported)
    ) {
      selected[id] = 1;
      selectedFeatureRegionCount++;
    }
  }

  const selectedPairKeys = new Set();
  const detailSupportArea = maximumFeatureArea * 4;
  for (const [key, pair] of evidence.pairs) {
    const meanBoundaryDifference = pair.difference / pair.count;
    const hasBoundedSide = evidence.area[pair.low] <= detailSupportArea || evidence.area[pair.high] <= detailSupportArea;
    if (pair.count >= 2 && hasBoundedSide && meanBoundaryDifference >= detailBoundaryDifference) selectedPairKeys.add(key);
  }

  const fineToRaw = new Int32Array(fine.regionCount); fineToRaw.fill(-1);
  let nextRaw = coarse.regionCount;
  for (let id = 0; id < fine.regionCount; id++) if (selected[id]) fineToRaw[id] = nextRaw++;
  const rawToCompact = new Int32Array(nextRaw); rawToCompact.fill(-1);
  const labels = new Int32Array(width * height); labels.fill(-1);
  let regionCount = 0;
  for (let pixel = 0; pixel < labels.length; pixel++) {
    if (!valid[pixel]) continue;
    const fineId = fine.labels[pixel];
    const raw = selected[fineId] ? fineToRaw[fineId] : coarse.labels[pixel];
    if (rawToCompact[raw] < 0) rawToCompact[raw] = regionCount++;
    labels[pixel] = rawToCompact[raw];
  }
  const boundaryMask = computeBoundaryMask(coarse.labels, valid, width, height, params.outlineWidth);
  const addedDetailBoundaryPixelCount = addSelectedDetailBoundaries(
    boundaryMask,
    fine.labels,
    selectedPairKeys,
    working,
    valid,
    width,
    height,
    fine.regionCount
  );
  return {
    labels,
    regionCount,
    boundaryMask,
    diagnostics: {
      selectedFeatureRegionCount,
      selectedDetailPairCount: selectedPairKeys.size,
      addedDetailBoundaryPixelCount,
      coarseRegionCount: coarse.regionCount,
      fineRegionCount: fine.regionCount,
      fineGlobalThreshold: fine.globalThreshold,
      minimumBoundaryDifference,
      detailBoundaryDifference,
      minimumCoarseDeviation
    }
  };
}
