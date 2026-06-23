import express from "express";
import fs from "fs";
import { globSync } from "glob";
import path from "path";
import type { Express } from "express";
import { buildAssetUrl } from "../core/AssetUrls";
import { logger } from "./Logger";
import { getProprietaryDir, getResourcesDir } from "./PublicAssetManifest";
import { getRuntimeAssetManifest } from "./RuntimeAssetManifest";

const log = logger.child({ comp: "music" });

const MUSIC_GLOB = "sounds/music/*.mp3";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

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

export function registerMusicRoutes(app: Express, baseDir: string): void {
  const resourcesDir = getResourcesDir(baseDir);
  const proprietaryDir = getProprietaryDir(baseDir);
  const uploadsDir = getUploadsDir(baseDir);

  fs.mkdirSync(uploadsDir, { recursive: true });

  // Serve uploaded files directly from the game server (not CDN).
  app.use("/uploads/music", express.static(uploadsDir, { maxAge: 0 }));

  // GET /api/music/tracks — list all available music tracks.
  // Returns relative asset paths for static files (client resolves via assetUrl())
  // and absolute server paths for uploaded files.
  app.get("/api/music/tracks", async (_req, res) => {
    try {
      const assetManifest = await getRuntimeAssetManifest();
      const cdnBase = process.env.CDN_BASE ?? "";
      const tracks: { filename: string; url: string }[] = [];
      const seen = new Set<string>();

      // Static files — proprietary takes precedence over resources.
      for (const dir of [proprietaryDir, resourcesDir]) {
        if (!fs.existsSync(dir)) continue;
        for (const relativePath of globSync(MUSIC_GLOB, {
          cwd: dir,
          nodir: true,
          posix: true,
        })) {
          const filename = path.posix.basename(relativePath);
          if (seen.has(filename)) continue;
          seen.add(filename);
          tracks.push({
            filename,
            url: buildAssetUrl(relativePath, assetManifest, cdnBase),
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
          url: `/uploads/music/${encodeURIComponent(file)}`,
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
    express.raw({ type: "audio/mpeg", limit: MAX_UPLOAD_BYTES }),
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
      fs.writeFileSync(path.join(uploadsDir, filename), req.body as Buffer);
    } catch {
      res.status(500).json({ error: "Failed to save file." });
      return;
    }

    res.json({
      url: `/uploads/music/${encodeURIComponent(filename)}`,
      filename,
    });
  });
}
