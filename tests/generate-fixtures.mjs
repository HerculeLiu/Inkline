import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { processImage } from "../src/processor.js";

const outputDir = fileURLToPath(new URL("../fixtures/generated/", import.meta.url));
mkdirSync(outputDir, { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1); rows[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, rowStart + 1);
  }
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function makeImage(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = pixel(x, y); const offset = (y * width + x) * 4;
    data[offset] = value[0]; data[offset + 1] = value[1]; data[offset + 2] = value[2]; data[offset + 3] = value[3] ?? 255;
  }
  return { width, height, data };
}

let seed = 91;
const random = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const fixtures = {
  "01-two-regions": makeImage(120, 80, (x, y) => {
    const base = x < 62 ? [224, 92, 76] : [80, 112, 214];
    const noise = Math.round((random() - .5) * 6);
    return [base[0] + noise, base[1] + noise, base[2] + noise];
  }),
  "02-gradient-span": makeImage(120, 80, (x, y) => {
    const t = x / 119;
    return [Math.round(45 + t * 190), Math.round(80 + t * 95), Math.round(190 - t * 115)];
  }),
  "03-transparent-island": makeImage(120, 80, (x, y) => {
    const dx = x - 60; const dy = y - 40;
    if (dx * dx / 2100 + dy * dy / 900 > 1) return [255, 0, 255, 0];
    if (x > 48 && x < 72 && y > 26 && y < 54) return [245, 204, 72, 220];
    return [67, 157, 116, 255];
  })
};

const params = {
  autoMode: true,
  localThreshold: 0.02,
  globalThreshold: 0.05,
  minRegionArea: 9,
  minInnerAreaRatio: 0.8,
  outlineWidth: 2,
  outlineColor: [18, 20, 18],
  preSmoothLevel: 0,
  connectivity: 4
};

for (const [name, input] of Object.entries(fixtures)) {
  const result = processImage(input, params);
  writeFileSync(`${outputDir}/${name}-input.png`, encodePng(input.width, input.height, input.data));
  writeFileSync(`${outputDir}/${name}-flat.png`, encodePng(input.width, input.height, result.flatRGBA));
  writeFileSync(`${outputDir}/${name}-outlined.png`, encodePng(input.width, input.height, result.outlinedRGBA));
  console.log(`${name}: ${result.stats.initialRegionCount} → ${result.stats.finalRegionCount} regions, ${result.stats.elapsedMs} ms`);
}
