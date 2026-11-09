/**
 * Conservative old-outline reassignment inspired by Linework Studio's central
 * idea: exclude likely ink, then give those pixels back to neighbouring color
 * regions. Unlike the Python project, this browser implementation only removes
 * dark pixels when unlike colors are found on opposite sides of the band.
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function srgbToLinear(value) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function rgbToOklab(red, green, blue) {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lr = Math.cbrt(l);
  const mr = Math.cbrt(m);
  const sr = Math.cbrt(s);
  return [
    0.2104542553 * lr + 0.793617785 * mr - 0.0040720468 * sr,
    1.9779984951 * lr - 2.428592205 * mr + 0.4505937099 * sr,
    0.0259040371 * lr + 0.7827717662 * mr - 0.808675766 * sr
  ];
}

function maxFilter(source, width, height, radius) {
  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  const deque = new Int32Array(Math.max(width, height));
  for (let y = 0; y < height; y++) {
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let x = 0; x < width; x++) {
      const limit = Math.min(width - 1, x + radius);
      while (next <= limit) {
        const value = source[y * width + next];
        while (tail > head && source[y * width + deque[tail - 1]] <= value) tail--;
        deque[tail++] = next++;
      }
      while (tail > head && deque[head] < x - radius) head++;
      horizontal[y * width + x] = source[y * width + deque[head]];
    }
  }
  for (let x = 0; x < width; x++) {
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let y = 0; y < height; y++) {
      const limit = Math.min(height - 1, y + radius);
      while (next <= limit) {
        const value = horizontal[next * width + x];
        while (tail > head && horizontal[deque[tail - 1] * width + x] <= value) tail--;
        deque[tail++] = next++;
      }
      while (tail > head && deque[head] < y - radius) head++;
      result[y * width + x] = horizontal[deque[head] * width + x];
    }
  }
  return result;
}

function firstPercentile(lightness, valid) {
  const bins = new Int32Array(1024);
  let count = 0;
  for (let i = 0; i < lightness.length; i++) {
    if (!valid[i]) continue;
    bins[Math.min(1023, Math.floor(lightness[i] * 1023))]++;
    count++;
  }
  const target = Math.max(1, Math.ceil(count * 0.01));
  let seen = 0;
  for (let i = 0; i < bins.length; i++) {
    seen += bins[i];
    if (seen >= target) return i / 1023;
  }
  return 0;
}

function removeSmallComponents(mask, width, minArea) {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const component = new Int32Array(mask.length);
  const directions = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 1;
    let size = 0;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const pixel = queue[head++];
      component[size++] = pixel;
      const x = pixel % width;
      for (const delta of directions) {
        const next = pixel + delta;
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        if (Math.abs((next % width) - x) > 1) continue;
        visited[next] = 1;
        queue[tail++] = next;
      }
    }
    if (size < minArea) {
      for (let i = 0; i < size; i++) mask[component[i]] = 0;
    }
  }
}

export function detectLegacyInk(image, { radius = 4, minArea = 12 } = {}) {
  const { width, height, data } = image;
  const pixelCount = width * height;
  const valid = new Uint8Array(pixelCount);
  const lightness = new Float32Array(pixelCount);
  const channelA = new Float32Array(pixelCount);
  const channelB = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (data[i * 4 + 3] === 0) continue;
    valid[i] = 1;
    const [l, a, b] = rgbToOklab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    lightness[i] = l;
    channelA[i] = a;
    channelB[i] = b;
  }
  const localMax = maxFilter(lightness, width, height, radius);
  const darkReference = firstPercentile(lightness, valid);
  const coreLimit = clamp(darkReference + 0.075, 0.27, 0.38);
  const core = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (valid[i] && lightness[i] < coreLimit && localMax[i] - lightness[i] >= 0.09) core[i] = 1;
  }
  const mask = core.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (!valid[pixel] || core[pixel]) continue;
      let nearCore = false;
      for (let dy = -1; dy <= 1 && !nearCore; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && core[ny * width + nx]) {
            nearCore = true;
            break;
          }
        }
      }
      const edgeLimit = 0.5 * (coreLimit + localMax[pixel]);
      if (nearCore && lightness[pixel] < Math.min(0.58, edgeLimit)) mask[pixel] = 1;
    }
  }
  removeSmallComponents(mask, width, minArea);
  return { mask, valid, lightness, channelA, channelB };
}

export function classifySeparatorInk(detected, width, height, { searchRadius = 7, minimumAcrossDifference = 0.16 } = {}) {
  const { mask, valid, lightness, channelA, channelB } = detected;
  const separator = new Uint8Array(mask.length);
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const findSide = (x, y, dx, dy) => {
    for (let step = 1; step <= searchRadius; step++) {
      const nx = x + dx * step;
      const ny = y + dy * step;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) return -2;
      const pixel = ny * width + nx;
      if (!valid[pixel]) return -2;
      if (!mask[pixel]) return pixel;
    }
    return -1;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (!mask[pixel]) continue;
      let bestDifference = 0;
      let exteriorPair = false;
      for (const [dx, dy] of directions) {
        const left = findSide(x, y, -dx, -dy);
        const right = findSide(x, y, dx, dy);
        if ((left === -2 && right >= 0) || (right === -2 && left >= 0)) exteriorPair = true;
        if (left < 0 || right < 0) continue;
        bestDifference = Math.max(bestDifference, Math.hypot(
          lightness[left] - lightness[right],
          channelA[left] - channelA[right],
          channelB[left] - channelB[right]
        ));
      }
      if (exteriorPair || bestDifference >= minimumAcrossDifference) separator[pixel] = 1;
    }
  }
  return separator;
}

export function reassignLegacyInk(image, mask, valid) {
  const { width, height, data } = image;
  const pixelCount = width * height;
  const nearest = new Int32Array(pixelCount);
  nearest.fill(-1);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (!valid[i] || mask[i]) continue;
    nearest[i] = i;
    queue[tail++] = i;
  }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const neighbors = [
      x > 0 ? pixel - 1 : -1,
      x + 1 < width ? pixel + 1 : -1,
      y > 0 ? pixel - width : -1,
      y + 1 < height ? pixel + width : -1
    ];
    for (const next of neighbors) {
      if (next < 0 || !valid[next] || nearest[next] >= 0) continue;
      nearest[next] = nearest[pixel];
      queue[tail++] = next;
    }
  }
  const output = new Uint8ClampedArray(data);
  for (let i = 0; i < pixelCount; i++) {
    if (!mask[i] || nearest[i] < 0) continue;
    const source = nearest[i] * 4;
    const target = i * 4;
    output[target] = data[source];
    output[target + 1] = data[source + 1];
    output[target + 2] = data[source + 2];
  }
  return output;
}

export function removeLegacyInk(image) {
  const detected = detectLegacyInk(image);
  const separatorMask = classifySeparatorInk(detected, image.width, image.height);
  let reassignedPixels = 0;
  for (const value of separatorMask) reassignedPixels += value;
  return {
    image: { ...image, data: reassignLegacyInk(image, separatorMask, detected.valid) },
    reassignedPixels
  };
}
