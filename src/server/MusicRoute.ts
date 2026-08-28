import type { Express } from "express";
import express from "express";
import fs from "fs";
import path from "path";
import { logger } from "./Logger";
import { getProprietaryDir, getResourcesDir } from "./PublicAssetManifest";

const log = logger.child({ comp: "music" });

const STATIC_MUSIC_ROUTE = "/music/static";
const UPLOADED_MUSIC_ROUTE = "/music/uploads";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const DELETE_RETRY_DELAYS_MS = [0, 75, 150, 300, 600] as const;
const RETRYABLE_DELETE_CODES = new Set(["EBUSY", "EPERM"]);

interface MusicTrackResponse {
  filename: string;
  url: string;
  source: "bundled" | "upload";
  deletable: boolean;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  const sanitized = base.replace(/[^a-zA-Z0-9 ._\-()]/g, "_");
  return sanitized.toLowerCase().endsWith(".mp3")
    ? sanitized
    : `${sanitized}.mp3`;
}

export function getUploadsDir(baseDir: string): string {
  return path.join(baseDir, "uploads", "music");
}

export async function deleteUploadedFile(
  target: string,
  unlink: (path: string) => Promise<void> = fs.promises.unlink,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  let lastError: unknown;
  for (const delay of DELETE_RETRY_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    try {
      await unlink(target);
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_DELETE_CODES.has(code)) throw err;
    }
  }
  throw lastError;
}

export function registerMusicFileRoutes(app: Express, baseDir: string): void {
  const resourcesDir = getResourcesDir(baseDir);
  const proprietaryDir = getProprietaryDir(baseDir);
  const uploadsDir = getUploadsDir(baseDir);

  fs.mkdirSync(uploadsDir, { recursive: true });

  // Serve static music directly from source directories. Proprietary tracks
  // take precedence when a resource track has the same filename.
  app.use(
    STATIC_MUSIC_ROUTE,
    express.static(path.join(proprietaryDir, "sounds", "music"), {
      maxAge: 0,
    }),
  );
  app.use(
    STATIC_MUSIC_ROUTE,
    express.static(path.join(resourcesDir, "sounds", "music"), { maxAge: 0 }),
  );

  // Serve uploaded files directly from the game server (not CDN). The
  // /uploads/music mount is kept as an alias for older responses/bookmarks.
  app.use(UPLOADED_MUSIC_ROUTE, express.static(uploadsDir, { maxAge: 0 }));
  app.use("/uploads/music", express.static(uploadsDir, { maxAge: 0 }));
}

export function registerMusicRoutes(
  app: Express,
  baseDir: string,
  maxUploadBytes = MAX_UPLOAD_BYTES,
): void {
  const resourcesDir = getResourcesDir(baseDir);
  const proprietaryDir = getProprietaryDir(baseDir);
  const uploadsDir = getUploadsDir(baseDir);

  fs.mkdirSync(uploadsDir, { recursive: true });

  // GET /api/music/tracks — list all available music tracks.
  // Returns server paths for both static and uploaded files.
  app.get("/api/music/tracks", (_req, res) => {
    try {
      const tracks: MusicTrackResponse[] = [];
      const seen = new Set<string>();

      // Static files — proprietary takes precedence over resources.
      for (const dir of [proprietaryDir, resourcesDir]) {
        if (!fs.existsSync(dir)) continue;
        const musicSubDir = path.join(dir, "sounds/music");
        if (!fs.existsSync(musicSubDir)) continue;
        const entries = fs
          .readdirSync(musicSubDir)
          .filter((f) => f.toLowerCase().endsWith(".mp3"));
        for (const relativePath of entries.map((f) => `sounds/music/${f}`)) {
          const filename = path.posix.basename(relativePath);
          if (seen.has(filename)) continue;
          seen.add(filename);
          tracks.push({
            filename,
            url: `${STATIC_MUSIC_ROUTE}/${encodeURIComponent(filename)}`,
            source: "bundled",
            deletable: false,
          });
        }
      }

      // Uploaded files.
      for (const file of fs.readdirSync(uploadsDir)) {
        if (!file.toLowerCase().endsWith(".mp3")) continue;
        if (seen.has(file)) continue;
        seen.add(file);
        tracks.push({
          filename: file,
          url: `${UPLOADED_MUSIC_ROUTE}/${encodeURIComponent(file)}`,
          source: "upload",
          deletable: true,
        });
      }

      // Fisher-Yates shuffle so every client gets a different play order.
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
      }

      res.json({ tracks });
    } catch (err) {
      log.error("GET /api/music/tracks failed:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Accept raw audio/mpeg body for upload — must be registered before the route.
  app.use(
    "/api/music/upload",
    express.raw({ type: "audio/mpeg", limit: maxUploadBytes }),
  );
  app.use(
    "/api/music/upload",
    (
      err: Error & { status?: number; type?: string },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (err.status === 413 || err.type === "entity.too.large") {
        res.status(413).json({
          code: "file_too_large",
          error: `The MP3 exceeds the ${Math.ceil(
            maxUploadBytes / 1024 / 1024,
          )} MB upload limit.`,
        });
        return;
      }
      next(err);
    },
  );

  // POST /api/music/upload — upload a new MP3 track.
  // Expects Content-Type: audio/mpeg and X-Filename header (URI-encoded).
  app.post("/api/music/upload", (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "No MP3 data received." });
      return;
    }

    const rawName = req.headers["x-filename"];
    let decodedName = "upload.mp3";
    if (typeof rawName === "string") {
      try {
        decodedName = decodeURIComponent(rawName);
      } catch {
        decodedName = rawName;
      }
    }

    const filename = sanitizeFilename(decodedName);

    try {
      fs.writeFileSync(path.join(uploadsDir, filename), req.body as Buffer, {
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        res.status(409).json({
          code: "duplicate_file",
          error: "A track with this filename already exists.",
        });
        return;
      }
      res.status(500).json({ error: "Failed to save file." });
      return;
    }

    res.json({
      url: `${UPLOADED_MUSIC_ROUTE}/${encodeURIComponent(filename)}`,
      filename,
      source: "upload",
      deletable: true,
    });
  });

  // DELETE /api/music/uploads/:filename — delete one uploaded MP3. This route
  // intentionally has no account gate, but its filesystem scope is strict:
  // only a regular .mp3 file directly inside uploads/music can be removed.
  app.delete("/api/music/uploads/:filename", async (req, res) => {
    const filename = req.params.filename;
    if (
      !filename ||
      path.basename(filename) !== filename ||
      !filename.toLowerCase().endsWith(".mp3")
    ) {
      res
        .status(400)
        .json({ error: "Only uploaded MP3 files can be deleted." });
      return;
    }

    const uploadsRoot = path.resolve(uploadsDir);
    const target = path.resolve(uploadsRoot, filename);
    if (path.dirname(target) !== uploadsRoot) {
      res.status(400).json({ error: "Invalid upload path." });
      return;
    }

    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        res
          .status(400)
          .json({ error: "Only uploaded MP3 files can be deleted." });
        return;
      }
      await deleteUploadedFile(target);
      res.status(204).end();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({ error: "Uploaded track not found." });
        return;
      }
      log.error("DELETE /api/music/uploads/:filename failed:", err);
      const fileError = err as NodeJS.ErrnoException;
      res.status(500).json({
        error: "Failed to delete uploaded track.",
        code: fileError.code ?? "UNKNOWN",
        attempts: DELETE_RETRY_DELAYS_MS.length,
        ...(process.env.GAME_ENV !== "prod"
          ? {
              details: {
                message: fileError.message,
                stack: fileError.stack,
                target,
              },
            }
          : {}),
      });
    }
  });
}
