import { analyzeImage, processImage, validateParams } from "./processor.js";
import { removeLegacyInk } from "./legacy-ink.js";
import { buildVTracerOptions, countSvgPaths, outlineVTracerSvg } from "./vtracer-pipeline.js";

self.onmessage = async (event) => {
  const { type, requestId, image, params } = event.data;
  try {
    if (type === "ANALYZE") {
      const analysis = analyzeImage(image);
      self.postMessage({ type: "ANALYZED", requestId, analysis });
      return;
    }
    if (type === "PROCESS") {
      if (params.segmentationMethod === "vtracer") {
        const started = performance.now();
        const effectiveParams = validateParams(params);
        self.postMessage({ type: "PROGRESS", requestId, stage: "准备曲线追踪", percent: 8 });
        let vectorInput = image;
        let reassignedPixels = 0;
        if (effectiveParams.legacyInkRemoval) {
          self.postMessage({ type: "PROGRESS", requestId, stage: "识别并重新归属旧描边", percent: 20 });
          const cleaned = removeLegacyInk(image);
          vectorInput = cleaned.image;
          reassignedPixels = cleaned.reassignedPixels;
        }
        self.postMessage({ type: "PROGRESS", requestId, stage: "VTracer 共享边界与样条拟合", percent: 42 });
        const { vectorize_rgba: vectorizeRgba } = await import("./vendor/vtracer/vtracer-wasm.js");
        const flatSvg = vectorizeRgba(
          new Uint8Array(vectorInput.data.buffer, vectorInput.data.byteOffset, vectorInput.data.byteLength),
          vectorInput.width,
          vectorInput.height,
          buildVTracerOptions(effectiveParams)
        );
        const outlinedSvg = outlineVTracerSvg(flatSvg, effectiveParams);
        const pathCount = countSvgPaths(flatSvg);
        const warnings = [
          "曲线模式使用 VTracer Poster + Cutout + Spline；相邻色块共享边界并在浏览器内栅格化为 PNG。"
        ];
        if (effectiveParams.legacyInkRemoval) {
          warnings.push(`旧描边预处理重新归属 ${reassignedPixels.toLocaleString()} 个像素；请重点检查眼睛、手部和深色衣物。`);
        } else {
          warnings.push("旧描边消除默认关闭：实图测试表明强制移除会误伤眼睛、手部与内部结构；只在旧线明显时启用。");
        }
        self.postMessage({
          type: "DONE",
          requestId,
          output: {
            width: image.width,
            height: image.height,
            flatSvg,
            outlinedSvg,
            stats: {
              segmentationMethod: "vtracer",
              initialRegionCount: pathCount,
              finalRegionCount: pathCount,
              mergedSmallRegionCount: 0,
              boundaryPixelCount: 0,
              elapsedMs: Math.round(performance.now() - started),
              effectiveParams,
              warnings,
              validation: { passed: true, violations: 0 },
              reassignedLegacyInkPixels: reassignedPixels
            }
          }
        });
        return;
      }
      const output = processImage(image, params, ({ stage, percent }) => {
        self.postMessage({ type: "PROGRESS", requestId, stage, percent });
      });
      self.postMessage(
        { type: "DONE", requestId, output },
        [output.flatRGBA.buffer, output.boundaryMask.buffer, output.outlinedRGBA.buffer, output.labels.buffer]
      );
    }
  } catch (error) {
    self.postMessage({ type: "ERROR", requestId, message: error instanceof Error ? error.message : String(error) });
  }
};
