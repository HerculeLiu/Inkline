import { analyzeImage, processImage } from "./processor.js";

self.onmessage = (event) => {
  const { type, requestId, image, params } = event.data;
  try {
    if (type === "ANALYZE") {
      const analysis = analyzeImage(image);
      self.postMessage({ type: "ANALYZED", requestId, analysis });
      return;
    }
    if (type === "PROCESS") {
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
