/**
 * bin-to-png.mjs
 * Reconstructs a source PNG (in map-generator input format) from a map.bin file.
 *
 * Usage:
 *   node scripts/bin-to-png.mjs <map-name>
 *   node scripts/bin-to-png.mjs aintnobodyherebutuschickens
 *
 * Output: resources/maps/<map-name>/image.png
 *
 * Binary format (one byte per tile, row-major y*width+x):
 *   Bit 7: Land=1 / Water=0
 *   Bit 6: Shoreline
 *   Bit 5: Ocean
 *   Bits 0-4: Magnitude (land 0-30, water = distance/2)
 *
 * PNG reconstruction:
 *   Land:  R=0 G=0 B=(magnitude*2 + 140) A=255
 *   Water: R=0 G=0 B=106               A=255
 *   (matches map-generator pixel interpretation exactly)
 */

import { createWriteStream } from "fs";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import zlib from "zlib";
import { promisify } from "util";

const deflate = promisify(zlib.deflate);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const mapName = process.argv[2];
if (!mapName) {
  console.error("Usage: node scripts/bin-to-png.mjs <map-name>");
  process.exit(1);
}

const mapDir = join(repoRoot, "resources", "maps", mapName);
const manifestPath = join(mapDir, "manifest.json");
const binPath = join(mapDir, "map.bin");
const outPath = join(mapDir, "image.png");

console.log(`Reading manifest: ${manifestPath}`);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const { width, height } = manifest.map;
console.log(`Map dimensions: ${width}x${height}`);

console.log(`Reading binary: ${binPath}`);
const bin = await readFile(binPath);

if (bin.length !== width * height) {
  console.error(
    `Size mismatch: expected ${width * height} bytes, got ${bin.length}`,
  );
  process.exit(1);
}

// Build raw RGBA pixel data (row by row, left to right)
// Tile at logical (x, y) is stored at bin[y * width + x]
console.log("Converting terrain to RGBA...");
const rgba = Buffer.allocUnsafe(width * height * 4);

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const byte = bin[y * width + x];
    const isLand = (byte & 0b10000000) !== 0;
    const magnitude = byte & 0b00011111;
    const blue = isLand ? magnitude * 2 + 140 : 106;
    const idx = (y * width + x) * 4;
    rgba[idx] = 0; // R
    rgba[idx + 1] = 0; // G
    rgba[idx + 2] = blue; // B
    rgba[idx + 3] = 255; // A
  }
}

// Encode as PNG (no external deps — manual PNG encoding)
console.log("Encoding PNG...");

function writeUint32BE(buf, offset, value) {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function crc32(buf) {
  const table = crc32.table;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
crc32.table = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.allocUnsafe(4);
  writeUint32BE(len, 0, data.length);
  const crcBuf = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.allocUnsafe(4);
  writeUint32BE(crcVal, 0, crc32(crcBuf));
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

// IHDR
const ihdr = Buffer.allocUnsafe(13);
writeUint32BE(ihdr, 0, width);
writeUint32BE(ihdr, 4, height);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: RGB (no alpha — saves ~25% file size, map generator only reads blue anyway)
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// Build filtered scanlines (filter byte 0 = None, then RGB)
const scanlineSize = 1 + width * 3;
const raw = Buffer.allocUnsafe(height * scanlineSize);
for (let y = 0; y < height; y++) {
  raw[y * scanlineSize] = 0; // filter type None
  for (let x = 0; x < width; x++) {
    const srcIdx = (y * width + x) * 4;
    const dstIdx = y * scanlineSize + 1 + x * 3;
    raw[dstIdx] = rgba[srcIdx]; // R
    raw[dstIdx + 1] = rgba[srcIdx + 1]; // G
    raw[dstIdx + 2] = rgba[srcIdx + 2]; // B
  }
}

const compressed = await deflate(raw, { level: 6 });

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.concat([
  pngSignature,
  chunk("IHDR", ihdr),
  chunk("IDAT", compressed),
  chunk("IEND", Buffer.alloc(0)),
]);

await new Promise((resolve, reject) => {
  const ws = createWriteStream(outPath);
  ws.on("finish", resolve);
  ws.on("error", reject);
  ws.end(png);
});

console.log(
  `Done! Written to ${outPath} (${(png.length / 1024 / 1024).toFixed(1)} MB)`,
);
