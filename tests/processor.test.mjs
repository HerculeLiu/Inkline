import test from "node:test";
import assert from "node:assert/strict";
import { analyzeImage, computeBoundaryMask, processImage, rgbToOklab } from "../src/processor.js";

function image(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = value[0]; data[offset + 1] = value[1]; data[offset + 2] = value[2]; data[offset + 3] = value[3] ?? 255;
    }
  }
  return { width, height, data };
}

const manual = {
  autoMode: false,
  localThreshold: 0.012,
  globalThreshold: 0.035,
  minRegionArea: 1,
  minInnerAreaRatio: 0,
  outlineWidth: 1,
  outlineColor: [7, 9, 11],
  preSmoothLevel: 0,
  connectivity: 4
};

test("sRGB to OKLab matches known white/black references", () => {
  const black = rgbToOklab(0, 0, 0);
  const white = rgbToOklab(255, 255, 255);
  assert.ok(Math.abs(black[0]) < 1e-8);
  assert.ok(Math.abs(white[0] - 1) < 1e-6);
  assert.ok(Math.abs(white[1]) < 1e-6);
  assert.ok(Math.abs(white[2]) < 1e-6);
});

test("two solid rectangles stay separate and share one deterministic boundary", () => {
  const input = image(12, 8, (x) => x < 6 ? [220, 45, 55] : [45, 70, 220]);
  const output = processImage(input, manual);
  assert.equal(output.stats.initialRegionCount, 2);
  assert.equal(output.stats.finalRegionCount, 2);
  assert.equal(output.stats.validation.passed, true);
  const centerBoundary = Array.from({ length: 8 }, (_, y) => output.boundaryMask[y * 12 + 5]);
  assert.ok(centerBoundary.every(Boolean));
  assert.ok(Array.from({ length: 8 }, (_, y) => output.boundaryMask[y * 12 + 6]).slice(1, -1).every((v) => v === 0));
});

test("global threshold prevents local-gradient chain drift", () => {
  const input = image(32, 5, (x) => {
    const value = 55 + x * 5;
    return [value, value, value];
  });
  const output = processImage(input, { ...manual, localThreshold: 0.035, globalThreshold: 0.08 });
  assert.ok(output.stats.finalRegionCount > 1, `expected gradient split, got ${output.stats.finalRegionCount}`);
  assert.ok(output.stats.finalRegionCount < 32, "local steps should still merge into bounded regions");
});

test("spatially disconnected identical colors retain independent labels", () => {
  const input = image(9, 3, (x) => x < 3 || x > 5 ? [180, 70, 60] : [35, 80, 200]);
  const output = processImage(input, manual);
  assert.equal(output.stats.finalRegionCount, 3);
  assert.notEqual(output.labels[1], output.labels[7]);
});

test("label boundaries are drawn even when region RGB could match", () => {
  const labels = new Int32Array([
    0, 0, 1, 1,
    0, 0, 1, 1,
    0, 0, 1, 1
  ]);
  const valid = new Uint8Array(12); valid.fill(1);
  const mask = computeBoundaryMask(labels, valid, 4, 3, 1);
  assert.equal(mask[5], 1);
  assert.equal(mask[6], 0);
});

test("transparent pixels never join regions or leak alpha", () => {
  const input = image(7, 7, (x, y) => (x >= 2 && x <= 4 && y >= 2 && y <= 4) ? [90, 190, 120, 180] : [255, 0, 255, 0]);
  const output = processImage(input, { ...manual, outlineWidth: 2 });
  assert.equal(output.labels[0], -1);
  assert.equal(output.outlinedRGBA[3], 0);
  assert.equal(output.stats.finalRegionCount, 1);
  assert.ok(output.stats.warnings.some((warning) => warning.includes("半透明")));
});

test("automatic estimation reacts to noise and produces finite thresholds", () => {
  let seed = 17;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const input = image(48, 32, () => {
    const noise = Math.round((random() - 0.5) * 8);
    return [120 + noise, 160 + noise, 205 + noise];
  });
  const analysis = analyzeImage(input);
  assert.ok(analysis.params.localThreshold > 0);
  assert.ok(analysis.params.globalThreshold >= analysis.params.localThreshold);
  assert.ok(Number.isFinite(analysis.metrics.mad));
  const output = processImage(input, { ...manual, autoMode: true });
  assert.ok(output.stats.finalRegionCount < 40, `auto mode left too many fragments: ${output.stats.finalRegionCount}`);
  assert.equal(output.stats.validation.passed, true);
});

test("same input and parameters are byte-for-byte deterministic", () => {
  const input = image(22, 14, (x, y) => [80 + ((x * 3 + y) % 5), 130 + ((x + y * 2) % 4), x < 11 ? 175 : 95]);
  const a = processImage(input, { ...manual, localThreshold: 0.02, globalThreshold: 0.05 });
  const b = processImage(input, { ...manual, localThreshold: 0.02, globalThreshold: 0.05 });
  assert.deepEqual(a.labels, b.labels);
  assert.deepEqual(a.outlinedRGBA, b.outlinedRGBA);
});

test("manual parameter validation rejects an inverted global threshold", () => {
  const input = image(2, 2, () => [80, 90, 100]);
  assert.throws(() => processImage(input, { ...manual, localThreshold: 0.08, globalThreshold: 0.02 }), /全局色差/);
});

test("experimental FH-RAG keeps a coherent row of hair highlights at a high global threshold", () => {
  const input = image(48, 24, (x, y) => {
    const inHighlight = y >= 8 && y <= 10 && (
      (x >= 7 && x <= 13) ||
      (x >= 19 && x <= 25) ||
      (x >= 31 && x <= 37)
    );
    const noise = ((x * 17 + y * 13) % 3) - 1;
    return inHighlight
      ? [205 + noise, 184 + noise, 164 + noise]
      : [104 + noise, 72 + noise, 66 + noise];
  });
  const output = processImage(input, {
    ...manual,
    segmentationMethod: "fh-rag",
    localThreshold: 0.02,
    globalThreshold: 0.6,
    minRegionArea: 32,
    minInnerAreaRatio: 0.8,
    outlineWidth: 2
  });
  const hairLabel = output.labels[2 * input.width + 2];
  for (const [x, y] of [[10, 9], [22, 9], [34, 9]]) {
    assert.notEqual(output.labels[y * input.width + x], hairLabel, `highlight at ${x},${y} was merged into hair`);
  }
  assert.ok(output.stats.finalRegionCount >= 4, `expected hair plus three highlights, got ${output.stats.finalRegionCount}`);
});

test("experimental FH-RAG preserves the enclosed counter of an O-shaped region", () => {
  const input = image(21, 21, (x, y) => {
    const inOuterSquare = x >= 4 && x <= 16 && y >= 4 && y <= 16;
    const inCounter = x >= 8 && x <= 12 && y >= 8 && y <= 12;
    return inOuterSquare && !inCounter ? [92, 104, 122] : [245, 245, 242];
  });
  const output = processImage(input, {
    ...manual,
    segmentationMethod: "fh-rag",
    localThreshold: 0.02,
    globalThreshold: 0.6,
    minRegionArea: 32,
    minInnerAreaRatio: 0.8,
    outlineWidth: 2
  });
  const outsideLabel = output.labels[1 * input.width + 1];
  const letterLabel = output.labels[5 * input.width + 5];
  const counterLabel = output.labels[10 * input.width + 10];
  assert.notEqual(counterLabel, letterLabel, "the O counter was filled into the letter body");
  assert.notEqual(counterLabel, outsideLabel, "the enclosed counter lost its topological identity");
  assert.equal(output.stats.finalRegionCount, 3);
});

test("automatic estimation does not silently switch off the experimental method", () => {
  const input = image(12, 12, (x, y) => x < 6 ? [90, 80, 75] : [210, 205, 195]);
  const output = processImage(input, {
    ...manual,
    autoMode: true,
    segmentationMethod: "fh-rag"
  });
  assert.equal(output.stats.segmentationMethod, "fh-rag");
  assert.equal(output.stats.effectiveParams.segmentationMethod, "fh-rag");
});

test("experimental FH-RAG recovers weak texture boundaries without losing highlights", () => {
  const input = image(96, 48, (x, y) => {
    const inHighlight = y >= 16 && y <= 19 && (
      (x >= 14 && x <= 24) ||
      (x >= 38 && x <= 48) ||
      (x >= 62 && x <= 72)
    );
    const texture = ((x * 19 + y * 23 + x * y * 3) % 13) - 6;
    return inHighlight
      ? [185 + texture, 162 + texture, 147 + texture]
      : [108 + texture, 82 + texture, 74 + texture];
  });
  const output = processImage(input, {
    ...manual,
    segmentationMethod: "fh-rag",
    localThreshold: 0.024,
    globalThreshold: 0.6,
    minRegionArea: 9,
    minInnerAreaRatio: 0.8,
    outlineWidth: 2
  });
  const hairLabel = output.labels[2 * input.width + 2];
  for (const [x, y] of [[19, 17], [43, 17], [67, 17]]) {
    assert.notEqual(output.labels[y * input.width + x], hairLabel);
  }
  assert.ok(output.stats.finalRegionCount <= 8, `weak texture remained fragmented into ${output.stats.finalRegionCount} regions`);
});

test("hierarchical fusion restores coherent highlights into a clean coarse layer", () => {
  const input = image(64, 32, (x, y) => {
    const inHighlight = y >= 10 && y <= 12 && (
      (x >= 8 && x <= 16) ||
      (x >= 27 && x <= 35) ||
      (x >= 46 && x <= 54)
    );
    const texture = ((x * 11 + y * 7) % 5) - 2;
    return inHighlight
      ? [190 + texture, 164 + texture, 145 + texture]
      : [105 + texture, 76 + texture, 68 + texture];
  });
  const output = processImage(input, {
    ...manual,
    segmentationMethod: "hierarchical-fusion",
    localThreshold: 0.024,
    globalThreshold: 0.6,
    minRegionArea: 40,
    minInnerAreaRatio: 0.8,
    outlineWidth: 2
  });
  const hairLabel = output.labels[2 * input.width + 2];
  for (const [x, y] of [[12, 11], [31, 11], [50, 11]]) {
    assert.notEqual(output.labels[y * input.width + x], hairLabel, `highlight at ${x},${y} was not promoted from the fine layer`);
  }
  assert.equal(output.stats.validation.passed, true);
});

test("hierarchical fusion keeps an O counter even when the coarse cleanup removes it", () => {
  const input = image(25, 25, (x, y) => {
    const inLetter = x >= 5 && x <= 19 && y >= 5 && y <= 19;
    const inCounter = x >= 10 && x <= 14 && y >= 10 && y <= 14;
    return inLetter && !inCounter ? [112, 122, 138] : [244, 244, 240];
  });
  const params = {
    ...manual,
    localThreshold: 0.024,
    globalThreshold: 0.6,
    minRegionArea: 32,
    minInnerAreaRatio: 0.8,
    outlineWidth: 2
  };
  const coarse = processImage(input, { ...params, segmentationMethod: "existing" });
  const fused = processImage(input, { ...params, segmentationMethod: "hierarchical-fusion" });
  assert.ok(coarse.stats.finalRegionCount < 3, "fixture must reproduce the coarse-layer topology loss");
  const outside = fused.labels[1 * input.width + 1];
  const stroke = fused.labels[6 * input.width + 6];
  const counter = fused.labels[12 * input.width + 12];
  assert.notEqual(stroke, outside);
  assert.notEqual(counter, stroke);
  assert.notEqual(counter, outside);
  assert.equal(fused.stats.validation.passed, true);
});

test("hierarchical fusion draws fewer gradient boundaries than its fine detail layer", () => {
  const input = image(96, 48, (x, y) => {
    const inLetter = x >= 10 && x <= 30 && y >= 11 && y <= 37;
    const inCounter = x >= 16 && x <= 24 && y >= 17 && y <= 31;
    if (inLetter && !inCounter) return [105, 112, 126];
    const value = 245 - Math.round(x * 100 / 95);
    return [value, value, value];
  });
  const params = {
    ...manual,
    localThreshold: 0.024,
    globalThreshold: 0.6,
    minRegionArea: 32,
    minInnerAreaRatio: 0.8,
    outlineWidth: 2
  };
  const fine = processImage(input, { ...params, globalThreshold: 0.204, segmentationMethod: "existing" });
  const fused = processImage(input, { ...params, segmentationMethod: "hierarchical-fusion" });
  const interiorBoundaryCount = (output, startX = 3) => {
    let count = 0;
    for (let y = 3; y < input.height - 3; y++) for (let x = startX; x < input.width - 3; x++) {
      count += output.boundaryMask[y * input.width + x];
    }
    return count;
  };
  const fineInterior = interiorBoundaryCount(fine, 40);
  const fusedInterior = interiorBoundaryCount(fused, 40);
  assert.ok(
    fusedInterior < fineInterior * 0.7,
    `expected fusion to suppress fine gradient boundaries (${fusedInterior} vs ${fineInterior})`
  );
  const outside = fused.labels[2 * input.width + 2];
  const stroke = fused.labels[12 * input.width + 12];
  const counter = fused.labels[24 * input.width + 20];
  assert.notEqual(stroke, outside);
  assert.notEqual(counter, stroke);
});

test("hierarchical fusion keeps a strong thin detail crossing several fine regions", () => {
  const input = image(420, 40, (x, y) => {
    if (y >= 18 && y <= 19 && x >= 8 && x <= 411) return [174, 38, 44];
    const value = 248 - Math.round(x * 158 / 419);
    return [value, value, value];
  });
  const output = processImage(input, {
    ...manual,
    segmentationMethod: "hierarchical-fusion",
    localThreshold: 0.024,
    globalThreshold: 0.6,
    minRegionArea: 32,
    minInnerAreaRatio: 0.8,
    outlineWidth: 2
  });
  let supportedColumns = 0;
  for (let x = 8; x <= 411; x++) {
    let hasBoundary = false;
    for (let y = 16; y <= 21; y++) hasBoundary ||= Boolean(output.boundaryMask[y * input.width + x]);
    if (hasBoundary) supportedColumns++;
  }
  assert.ok(supportedColumns >= 370, `thin detail broke into only ${supportedColumns} supported columns`);
});

test("hierarchical fusion restores a feature hidden behind a low-contrast antialias ramp", () => {
  const input = image(48, 48, (x, y) => {
    const dx = x < 22 ? 22 - x : x > 25 ? x - 25 : 0;
    const dy = y < 22 ? 22 - y : y > 25 ? y - 25 : 0;
    const value = Math.min(240, 100 + Math.max(dx, dy) * 6);
    return [value, value, value];
  });
  const output = processImage(input, {
    ...manual,
    segmentationMethod: "hierarchical-fusion",
    localThreshold: 0.024,
    globalThreshold: 0.6,
    minRegionArea: 32,
    minInnerAreaRatio: 0.8,
    outlineWidth: 2
  });
  const center = 23 * input.width + 23;
  const outside = 1 * input.width + 1;
  assert.notEqual(output.labels[center], output.labels[outside], "antialiased feature remained absorbed into the coarse layer");
  assert.ok(output.flatRGBA[center * 4] < 170, `feature color was not restored: ${output.flatRGBA[center * 4]}`);
});
