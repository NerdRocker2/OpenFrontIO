/**
 * Minimal ID3v2.3/v2.4 tag reader using a partial HTTP Range fetch.
 * Only reads TIT2 (title) and TPE1 (artist) frames.
 * Returns an empty object on any failure — purely best-effort.
 */

const RANGE_BYTES = 65536; // 64 KB — sufficient for any reasonable ID3 header

export async function fetchId3Metadata(
  url: string,
): Promise<{ title?: string; artist?: string }> {
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
    });
    if (!response.ok && response.status !== 206) return {};
    const buffer = new Uint8Array(await response.arrayBuffer());
    return parseId3v2(buffer);
  } catch {
    return {};
  }
}

/**
 * Derive a best-effort title and artist from a URL or filename.
 * Pattern: "Artist - Title.mp3" → {artist, title}. Single-segment → {title}.
 */
export function metadataFromFilename(url: string): {
  title: string;
  artist: string;
} {
  const raw = decodeURIComponent((url.split("/").pop() ?? url).split("?")[0]);
  const noExt = raw.replace(/\.[^.]+$/, "").trim();
  const idx = noExt.indexOf(" - ");
  if (idx !== -1) {
    const afterFirst = noExt.slice(idx + 3);
    // Use last " - " segment as title so "Artist - Album - Title" works.
    const lastIdx = noExt.lastIndexOf(" - ");
    return {
      artist: noExt.slice(0, idx).trim(),
      title: noExt.slice(lastIdx + 3).trim() || afterFirst.trim(),
    };
  }
  return { title: noExt, artist: "" };
}

// ---------------------------------------------------------------------------
// ID3v2 parser (v2.3 and v2.4 only — v2.2 falls through to empty result)
// ---------------------------------------------------------------------------

function synchsafeToInt(b0: number, b1: number, b2: number, b3: number): number {
  return ((b0 & 0x7f) << 21) | ((b1 & 0x7f) << 14) | ((b2 & 0x7f) << 7) | (b3 & 0x7f);
}

function parseId3v2(data: Uint8Array): { title?: string; artist?: string } {
  // Magic "ID3"
  if (data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return {};

  const version = data[3]; // 3 = v2.3, 4 = v2.4 (v2.2 not supported)
  if (version !== 3 && version !== 4) return {};

  const flags = data[5];
  const tagSize = synchsafeToInt(data[6], data[7], data[8], data[9]);
  const end = Math.min(10 + tagSize, data.length);

  let pos = 10;

  // Skip extended header if present (flag bit 6).
  if (flags & 0x40) {
    const extSize =
      version === 4
        ? synchsafeToInt(data[pos], data[pos + 1], data[pos + 2], data[pos + 3])
        : ((data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]);
    pos += extSize;
  }

  const result: { title?: string; artist?: string } = {};

  while (pos + 10 < end) {
    const frameId = String.fromCharCode(
      data[pos],
      data[pos + 1],
      data[pos + 2],
      data[pos + 3],
    );
    if (frameId === "\0\0\0\0") break; // padding

    const frameSize =
      (data[pos + 4] << 24) |
      (data[pos + 5] << 16) |
      (data[pos + 6] << 8) |
      data[pos + 7];
    pos += 10; // 4 ID + 4 size + 2 flags

    if (frameSize <= 0 || pos + frameSize > end) break;

    if (frameId === "TIT2" || frameId === "TPE1") {
      const text = decodeTextFrame(data, pos, frameSize);
      if (frameId === "TIT2") result.title = text;
      else result.artist = text;
    }

    pos += frameSize;
    if (result.title !== undefined && result.artist !== undefined) break;
  }

  return result;
}

function decodeTextFrame(data: Uint8Array, start: number, size: number): string {
  if (size < 2) return "";
  const encoding = data[start];
  const raw = data.subarray(start + 1, start + size);
  try {
    let charset: string;
    switch (encoding) {
      case 1:
      case 2:
        charset = "utf-16";
        break;
      case 3:
        charset = "utf-8";
        break;
      default:
        charset = "latin1";
    }
    return new TextDecoder(charset).decode(raw).replace(/\0+$/, "").trim();
  } catch {
    return "";
  }
}
