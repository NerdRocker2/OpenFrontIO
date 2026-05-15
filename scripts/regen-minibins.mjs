/**
 * regen-minibins.mjs
 * Regenerates map4x.bin and map16x.bin from map.bin, matching the current
 * Go map-generator pipeline exactly (createMiniMap → removeSmallIslands →
 * processWater). Fixes maps made with an older generator whose mini-bins
 * are out of sync with their full-scale map.bin.
 *
 * Usage:
 *   node scripts/regen-minibins.mjs <map-name>
 *   node scripts/regen-minibins.mjs aintnobodyherebutuschickens
 */

import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const MIN_ISLAND_SIZE = 30; // matches Go's minIslandSize
const MIN_LAKE_SIZE = 200; // matches Go's minLakeSize (unused here, removeSmall=false for mini)

const mapName = process.argv[2];
if (!mapName) {
  console.error("Usage: node scripts/regen-minibins.mjs <map-name>");
  process.exit(1);
}

const mapDir = join(repoRoot, "resources", "maps", mapName);
const manifestPath = join(mapDir, "manifest.json");

console.log(`Reading manifest: ${manifestPath}`);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const { width: FW, height: FH } = manifest.map;
console.log(`Full map: ${FW}x${FH}`);

const fullBin = await readFile(join(mapDir, "map.bin"));
if (fullBin.length !== FW * FH) {
  console.error(`map.bin size ${fullBin.length} != ${FW * FH}`);
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * 2:1 downscale following Go's createMiniMap rule:
 *   - Mini tile starts as Land (Go zero-value).
 *   - Source tiles are scanned in row-major order; each updates the mini tile
 *     unless the mini tile is already Water.
 *   - First Water source tile encountered sets mini tile to Water permanently.
 * Clears shoreline (bit 6) and ocean (bit 5) – processWater recomputes them.
 */
function createMiniMap(src, srcW, srcH) {
  const dstW = Math.floor(srcW / 2);
  const dstH = Math.floor(srcH / 2);
  // Initialise to Land (bit 7 set), magnitude 0, no flags
  const dst = new Uint8Array(dstW * dstH).fill(0x80);

  for (let sy = 0; sy < srcH; sy++) {
    for (let sx = 0; sx < srcW; sx++) {
      const mx = Math.floor(sx / 2);
      const my = Math.floor(sy / 2);
      if (mx >= dstW || my >= dstH) continue;

      const srcByte = src[sy * srcW + sx];
      const dstIdx = my * dstW + mx;

      // Only update if the mini tile is still Land
      if (dst[dstIdx] & 0x80) {
        // Copy land-bit + magnitude; clear shoreline/ocean (recomputed later)
        dst[dstIdx] = (srcByte & 0x80) | (srcByte & 0x1f);
      }
      // If srcByte is Water (bit 7 = 0), the assignment above sets the mini
      // tile to Water (0x00 | 0x00 = 0x00).  Subsequent updates are blocked
      // by the `dst[dstIdx] & 0x80` guard.
    }
  }

  return dst;
}

/**
 * Removes connected land bodies smaller than minSize tiles, converting them
 * to Water (mirrors Go's removeSmallIslands).  Called only when removeSmall
 * is true (non-test maps).
 */
function removeSmallIslands(data, width, height, minSize) {
  const n = width * height;
  const visited = new Uint8Array(n);

  for (let start = 0; start < n; start++) {
    if (!(data[start] & 0x80) || visited[start]) continue; // water or done

    // BFS – collect the whole connected land body
    const body = [start];
    visited[start] = 1;
    let qi = 0;
    while (qi < body.length) {
      const pos = body[qi++];
      const x = pos % width;
      const y = Math.floor(pos / width);
      if (x > 0) checkNeighbor(pos - 1);
      if (x < width - 1) checkNeighbor(pos + 1);
      if (y > 0) checkNeighbor(pos - width);
      if (y < height - 1) checkNeighbor(pos + width);
    }

    if (body.length < minSize) {
      for (const pos of body) data[pos] = 0x00; // land → water
    }

    function checkNeighbor(npos) {
      if (data[npos] & 0x80 && !visited[npos]) {
        visited[npos] = 1;
        body.push(npos);
      }
    }
  }
}

/**
 * Mirrors Go's processWater:
 *   1. Clears Ocean + Shoreline bits.
 *   2. BFS-floods all water bodies; marks the largest as Ocean.
 *   3. Marks Shoreline on every tile (land or water) adjacent to a tile of
 *      the other type.
 *   4. BFS from coast-adjacent water tiles to assign Water magnitude
 *      (= distance / 2, capped at 31, matching packTerrain).
 * @returns {number} count of land tiles (for manifest update)
 */
function processWater(data, width, height) {
  const n = width * height;

  // 1. Clear ocean (bit 5) and shoreline (bit 6) – recomputed below
  for (let i = 0; i < n; i++) data[i] &= 0x9f; // ~0x60

  // 2. Find water bodies
  const visited = new Uint8Array(n);
  const waterBodies = [];

  for (let start = 0; start < n; start++) {
    if (data[start] & 0x80 || visited[start]) continue; // land or visited

    const body = [start];
    visited[start] = 1;
    let qi = 0;
    while (qi < body.length) {
      const pos = body[qi++];
      const x = pos % width;
      const y = Math.floor(pos / width);
      if (x > 0) flood(pos - 1);
      if (x < width - 1) flood(pos + 1);
      if (y > 0) flood(pos - width);
      if (y < height - 1) flood(pos + width);
    }
    waterBodies.push(body);

    function flood(npos) {
      if (!(data[npos] & 0x80) && !visited[npos]) {
        visited[npos] = 1;
        body.push(npos);
      }
    }
  }

  // Sort largest first; mark largest as ocean
  waterBodies.sort((a, b) => b.length - a.length);
  if (waterBodies.length > 0) {
    for (const pos of waterBodies[0]) data[pos] |= 0x20; // set ocean bit
    console.log(
      `  Ocean: ${waterBodies[0].length} tiles, ${waterBodies.length} water bodies total`,
    );
  }

  // 3. Mark shoreline + collect coast-adjacent water tiles for BFS
  const dist = new Int32Array(n).fill(-1);
  const queue = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pos = y * width + x;
      const isLand = !!(data[pos] & 0x80);

      let adjacentToOther = false;
      let isShoreWater = false;

      if (x > 0) check(pos - 1);
      if (x < width - 1) check(pos + 1);
      if (y > 0) check(pos - width);
      if (y < height - 1) check(pos + width);

      if (adjacentToOther) data[pos] |= 0x40; // set shoreline bit
      if (isShoreWater && dist[pos] === -1) {
        dist[pos] = 0;
        queue.push(pos);
      }

      function check(npos) {
        const nIsLand = !!(data[npos] & 0x80);
        if (nIsLand !== isLand) adjacentToOther = true;
        if (!isLand && nIsLand) isShoreWater = true;
      }
    }
  }

  // 4. BFS outward from coast to assign water magnitudes
  let qi = 0;
  while (qi < queue.length) {
    const pos = queue[qi++];
    const x = pos % width;
    const y = Math.floor(pos / width);
    const d = dist[pos];

    if (x > 0) expand(pos - 1);
    if (x < width - 1) expand(pos + 1);
    if (y > 0) expand(pos - width);
    if (y < height - 1) expand(pos + width);

    function expand(npos) {
      if (!(data[npos] & 0x80) && dist[npos] === -1) {
        dist[npos] = d + 1;
        queue.push(npos);
      }
    }
  }

  // Write water magnitudes (Go: packed = min(ceil(dist/2), 31))
  for (let i = 0; i < n; i++) {
    if (!(data[i] & 0x80)) {
      const d = dist[i] < 0 ? 0 : dist[i];
      const mag = Math.min(Math.ceil(d / 2), 31);
      data[i] = (data[i] & 0xe0) | mag; // keep bits 7,6,5; replace magnitude
    }
  }

  // Count land tiles
  let landCount = 0;
  for (let i = 0; i < n; i++) if (data[i] & 0x80) landCount++;
  return landCount;
}

// ── pipeline ─────────────────────────────────────────────────────────────────

console.log("Generating map4x...");
const map4xData = createMiniMap(fullBin, FW, FH);
const W4 = Math.floor(FW / 2),
  H4 = Math.floor(FH / 2);
removeSmallIslands(map4xData, W4, H4, Math.floor(MIN_ISLAND_SIZE / 2));
const land4x = processWater(map4xData, W4, H4);
console.log(`  Dimensions: ${W4}x${H4}, land tiles: ${land4x}`);

console.log("Generating map16x...");
const map16xData = createMiniMap(map4xData, W4, H4);
const W16 = Math.floor(W4 / 2),
  H16 = Math.floor(H4 / 2);
// No removeSmallIslands for 16x (matches current Go pipeline)
const land16x = processWater(map16xData, W16, H16);
console.log(`  Dimensions: ${W16}x${H16}, land tiles: ${land16x}`);

// ── verify port tile ──────────────────────────────────────────────────────────
const portTile = 7230297;
const pfx = portTile % FW,
  pfy = Math.floor(portTile / FW);
const pmx = Math.floor(pfx / 2),
  pmy = Math.floor(pfy / 2);
const miniIdx = pmy * W4 + pmx;
const miniIsWater = !(map4xData[miniIdx] & 0x80);
// Check 2-hop radius
let foundWater = false;
outer: for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) {
    const nx = pmx + dx,
      ny = pmy + dy;
    if (nx < 0 || nx >= W4 || ny < 0 || ny >= H4) continue;
    if (!(map4xData[ny * W4 + nx] & 0x80)) {
      foundWater = true;
      break outer;
    }
  }
}
console.log(
  `\nPort tile ${portTile} (${pfx},${pfy}) → mini (${pmx},${pmy}): ${miniIsWater ? "water" : "land"}, water within 2 hops: ${foundWater}`,
);

// ── write files ───────────────────────────────────────────────────────────────
await writeFile(join(mapDir, "map4x.bin"), map4xData);
console.log(`\nWritten map4x.bin (${map4xData.length} bytes)`);

await writeFile(join(mapDir, "map16x.bin"), map16xData);
console.log(`Written map16x.bin (${map16xData.length} bytes)`);

// Update manifest
manifest.map4x = { width: W4, height: H4, num_land_tiles: land4x };
manifest.map16x = { width: W16, height: H16, num_land_tiles: land16x };
const updatedManifest = JSON.stringify(manifest, null, 2) + "\n";
await writeFile(manifestPath, updatedManifest);
console.log("Updated manifest.json");

console.log("\nDone! Run `npm run format` to re-prettify manifest.json.");
