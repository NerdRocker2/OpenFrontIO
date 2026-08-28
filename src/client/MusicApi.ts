export interface MusicTrack {
  filename: string;
  url: string;
  source: "bundled" | "upload";
  deletable: boolean;
}

export const MAX_MUSIC_UPLOAD_BYTES = 50 * 1024 * 1024;

export type MusicUploadErrorCode =
  | "duplicate_file"
  | "file_too_large"
  | "upload_failed";

export class MusicUploadError extends Error {
  constructor(
    readonly code: MusicUploadErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MusicUploadError";
  }
}

export function normalizeMusicUploadFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const sanitized = base.replace(/[^a-zA-Z0-9 ._\-()]/g, "_");
  return sanitized.toLowerCase().endsWith(".mp3")
    ? sanitized
    : `${sanitized}.mp3`;
}

interface MusicTrackPayload {
  filename?: string;
  url?: string;
  source?: "bundled" | "upload";
  deletable?: boolean;
}

function normalizeMusicTrack(track: MusicTrackPayload): MusicTrack | null {
  if (!track.filename || !track.url) return null;
  const inferredUpload =
    track.url.startsWith("/music/uploads/") ||
    track.url.startsWith("/uploads/music/");
  const source = track.source ?? (inferredUpload ? "upload" : "bundled");
  return {
    filename: track.filename,
    url: track.url,
    source,
    deletable: source === "upload" && (track.deletable ?? true),
  };
}

export async function fetchMusicTracks(): Promise<MusicTrack[]> {
  const response = await fetch("/api/music/tracks");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { tracks?: MusicTrackPayload[] };
  if (!Array.isArray(body.tracks)) return [];
  return body.tracks
    .map(normalizeMusicTrack)
    .filter((track): track is MusicTrack => track !== null);
}

export async function uploadMusicTrack(file: File): Promise<MusicTrack> {
  if (file.size > MAX_MUSIC_UPLOAD_BYTES) {
    throw new MusicUploadError(
      "file_too_large",
      "The MP3 exceeds the 50 MB upload limit.",
      413,
    );
  }

  const response = await fetch("/api/music/upload", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "audio/mpeg",
      "X-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
    };
    const code: MusicUploadErrorCode =
      response.status === 413 || error.code === "file_too_large"
        ? "file_too_large"
        : response.status === 409 || error.code === "duplicate_file"
          ? "duplicate_file"
          : "upload_failed";
    throw new MusicUploadError(
      code,
      error.error ?? `Upload failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  const track = normalizeMusicTrack(
    (await response.json()) as MusicTrackPayload,
  );
  if (!track) {
    throw new Error("Upload response did not include a track.");
  }
  return {
    filename: track.filename,
    url: track.url,
    source: "upload",
    deletable: true,
  };
}

export async function deleteMusicTrack(filename: string): Promise<void> {
  const response = await fetch(
    `/api/music/uploads/${encodeURIComponent(filename)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(error.error ?? `HTTP ${response.status}`);
  }
}
