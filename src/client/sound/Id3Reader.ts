/**
 * Minimal ID3v2.3/v2.4 reader using partial HTTP Range fetches.
 * Returns an empty object on any failure because metadata is best-effort.
 */

const INITIAL_RANGE_BYTES = 65536;
const MAX_TAG_BYTES = 2 * 1024 * 1024;

export interface Id3Artwork {
  mimeType: string;
  data: Uint8Array;
}

export interface Id3Metadata {
  title?: string;
  artist?: string;
  year?: string;
  duration?: number;
  artwork?: Id3Artwork;
}

export async function fetchId3Metadata(
  url: string,
  { includeArtwork = false }: { includeArtwork?: boolean } = {},
): Promise<Id3Metadata> {
  const durationPromise = readAudioDuration(url);
  let metadata: Id3Metadata = {};
  try {
    const initialResponse = await fetch(url, {
      headers: { Range: `bytes=0-${INITIAL_RANGE_BYTES - 1}` },
    });
    if (initialResponse.ok || initialResponse.status === 206) {
      let buffer = new Uint8Array(await initialResponse.arrayBuffer());

      const declaredSize = getDeclaredTagBytes(buffer);
      if (
        includeArtwork &&
        initialResponse.status === 206 &&
        declaredSize > buffer.length &&
        declaredSize <= MAX_TAG_BYTES
      ) {
        const fullTagResponse = await fetch(url, {
          headers: { Range: `bytes=0-${declaredSize - 1}` },
        });
        if (fullTagResponse.ok || fullTagResponse.status === 206) {
          buffer = new Uint8Array(await fullTagResponse.arrayBuffer());
        }
      }

      metadata = parseId3v2(buffer);
    }
  } catch {
    // Metadata is best-effort; duration may still be available to the browser.
  }
  const duration = await durationPromise;
  if (duration !== undefined) metadata.duration = duration;
  return metadata;
}

function readAudioDuration(url: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    let settled = false;
    const finish = (duration?: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("error", onError);
      audio.removeAttribute("src");
      audio.load();
      resolve(duration);
    };
    const onLoadedMetadata = () => {
      finish(
        Number.isFinite(audio.duration) && audio.duration >= 0
          ? audio.duration
          : undefined,
      );
    };
    const onError = () => finish();
    const timeout = window.setTimeout(() => finish(), 10_000);

    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("error", onError);
    audio.src = url;
    audio.load();
  });
}

/** Derive best-effort metadata from "Artist - Title.mp3" filenames. */
export function metadataFromFilename(url: string): {
  title: string;
  artist: string;
  year: string;
} {
  const raw = decodeURIComponent((url.split("/").pop() ?? url).split("?")[0]);
  const noExt = raw
    .replace(/\.[^.]+$/, "")
    .replace(/\.[0-9a-f]{12}$/i, "")
    .trim();
  const idx = noExt.indexOf(" - ");
  if (idx !== -1) {
    const afterFirst = noExt.slice(idx + 3);
    const lastIdx = noExt.lastIndexOf(" - ");
    return {
      artist: noExt.slice(0, idx).trim(),
      title: noExt.slice(lastIdx + 3).trim() || afterFirst.trim(),
      year: noExt.match(/(?:^| - )(\d{4})(?: - |$)/)?.[1] ?? "",
    };
  }
  return { title: noExt, artist: "", year: "" };
}

function synchsafeToInt(
  b0: number,
  b1: number,
  b2: number,
  b3: number,
): number {
  return (
    ((b0 & 0x7f) << 21) | ((b1 & 0x7f) << 14) | ((b2 & 0x7f) << 7) | (b3 & 0x7f)
  );
}

function getDeclaredTagBytes(data: Uint8Array): number {
  if (
    data.length < 10 ||
    data[0] !== 0x49 ||
    data[1] !== 0x44 ||
    data[2] !== 0x33
  ) {
    return 0;
  }
  return 10 + synchsafeToInt(data[6], data[7], data[8], data[9]);
}

export function parseId3v2(data: Uint8Array): Id3Metadata {
  if (
    data.length < 10 ||
    data[0] !== 0x49 ||
    data[1] !== 0x44 ||
    data[2] !== 0x33
  ) {
    return {};
  }

  const version = data[3];
  if (version !== 3 && version !== 4) return {};

  const flags = data[5];
  const tagSize = synchsafeToInt(data[6], data[7], data[8], data[9]);
  const end = Math.min(10 + tagSize, data.length);
  let pos = 10;

  if ((flags & 0x40) !== 0 && pos + 4 <= end) {
    const extSize =
      version === 4
        ? synchsafeToInt(data[pos], data[pos + 1], data[pos + 2], data[pos + 3])
        : (((data[pos] << 24) >>> 0) |
            (data[pos + 1] << 16) |
            (data[pos + 2] << 8) |
            data[pos + 3]) >>>
          0;
    pos += version === 3 ? 4 + extSize : extSize;
  }

  const result: Id3Metadata = {};

  while (pos + 10 <= end) {
    const frameId = String.fromCharCode(
      data[pos],
      data[pos + 1],
      data[pos + 2],
      data[pos + 3],
    );
    if (frameId === "\0\0\0\0") break;

    const frameSize =
      version === 4
        ? synchsafeToInt(
            data[pos + 4],
            data[pos + 5],
            data[pos + 6],
            data[pos + 7],
          )
        : (((data[pos + 4] << 24) >>> 0) |
            (data[pos + 5] << 16) |
            (data[pos + 6] << 8) |
            data[pos + 7]) >>>
          0;
    pos += 10;

    if (frameSize <= 0 || pos + frameSize > end) break;

    if (
      frameId === "TIT2" ||
      frameId === "TPE1" ||
      frameId === "TDRC" ||
      frameId === "TYER"
    ) {
      const value = decodeTextFrame(data, pos, frameSize);
      if (frameId === "TIT2") result.title = value;
      else if (frameId === "TPE1") result.artist = value;
      else {
        const year = value.match(/^\s*(\d{4})(?:\D|$)/)?.[1];
        if (year) result.year = year;
      }
    } else if (frameId === "APIC" && result.artwork === undefined) {
      result.artwork = decodeAttachedPicture(data, pos, frameSize);
    }

    pos += frameSize;
  }

  return result;
}

function decodeAttachedPicture(
  data: Uint8Array,
  start: number,
  size: number,
): Id3Artwork | undefined {
  const end = start + size;
  if (size < 5 || end > data.length) return undefined;

  const encoding = data[start];
  let pos = start + 1;
  const mimeEnd = data.indexOf(0, pos);
  if (mimeEnd === -1 || mimeEnd >= end) return undefined;
  const mimeType = new TextDecoder("latin1")
    .decode(data.subarray(pos, mimeEnd))
    .toLowerCase();
  if (!mimeType.startsWith("image/")) return undefined;

  pos = mimeEnd + 1;
  if (pos >= end) return undefined;
  pos += 1; // picture type

  if (encoding === 1 || encoding === 2) {
    while (pos + 1 < end && (data[pos] !== 0 || data[pos + 1] !== 0)) {
      pos += 2;
    }
    pos += 2;
  } else {
    while (pos < end && data[pos] !== 0) pos += 1;
    pos += 1;
  }

  if (pos >= end) return undefined;
  return { mimeType, data: data.slice(pos, end) };
}

function decodeTextFrame(
  data: Uint8Array,
  start: number,
  size: number,
): string {
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
