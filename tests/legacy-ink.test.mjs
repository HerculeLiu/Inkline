import test from "node:test";
import assert from "node:assert/strict";
import { classifySeparatorInk, detectLegacyInk, removeLegacyInk } from "../src/legacy-ink.js";

function makeImage(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [red, green, blue, alpha = 255] = pixel(x, y);
      const offset = (y * width + x) * 4;
      data.set([red, green, blue, alpha], offset);
    }
  }
  return { width, height, data };
}

test("a dark band between unlike colors is reassigned to its neighbours", () => {
  const input = makeImage(25, 11, (x) => {
    if (x < 11) return [150, 82, 44];
    if (x < 14) return [28, 30, 32];
    return [78, 142, 204];
  });
  const detected = detectLegacyInk(input, { minArea: 1 });
  const separator = classifySeparatorInk(detected, input.width, input.height);
  const centerBand = [11, 12, 13].map((x) => separator[5 * input.width + x]);
  assert.ok(centerBand.some(Boolean), "expected the old outline band to be classified");

  const { image: cleaned, reassignedPixels } = removeLegacyInk(input);
  assert.ok(reassignedPixels > 0);
  const centerOffset = (5 * input.width + 12) * 4;
  assert.notDeepEqual(Array.from(cleaned.data.slice(centerOffset, centerOffset + 3)), [28, 30, 32]);
});

test("a dark structural line with the same color on both sides is preserved", () => {
  const input = makeImage(25, 11, (x) => x >= 11 && x < 14 ? [28, 30, 32] : [224, 168, 116]);
  const detected = detectLegacyInk(input, { minArea: 1 });
  const separator = classifySeparatorInk(detected, input.width, input.height);
  assert.equal(separator[5 * input.width + 12], 0);
});

test("large dark fills do not become ink merely because they are dark", () => {
  const input = makeImage(25, 25, () => [34, 36, 40]);
  const detected = detectLegacyInk(input, { minArea: 1 });
  assert.equal(detected.mask[12 * input.width + 12], 0);
});
