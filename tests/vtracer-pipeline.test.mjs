import test from "node:test";
import assert from "node:assert/strict";
import { buildVTracerOptions, countSvgPaths, outlineVTracerSvg } from "../src/vtracer-pipeline.js";

test("VTracer uses the real-image-tested shared-boundary spline preset", () => {
  assert.deepEqual(buildVTracerOptions({ vtracerColors: 16, minRegionArea: 12 }), {
    preset: "poster",
    hierarchical: "cutout",
    mode: "spline",
    maxColors: 16,
    filterSpeckle: 12,
    simplify: 1.5,
    optimize: 1
  });
});

test("outline styling is applied to every path without changing fills", () => {
  const source = '<svg><path fill="#f00" d="M0 0Z"/><path fill="#00f" d="M1 1Z"/></svg>';
  const outlined = outlineVTracerSvg(source, { outlineColor: [21, 21, 21], outlineWidth: 2 });
  assert.equal(countSvgPaths(outlined), 2);
  assert.match(outlined, /stroke="rgb\(21 21 21\)"/);
  assert.equal((outlined.match(/stroke-width="2"/g) || []).length, 2);
  assert.match(outlined, /fill="#f00"/);
});
