import express from "express";
import rateLimit from "express-rate-limit";
import fs from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
  registerMusicFileRoutes,
  registerMusicRoutes,
} from "../../src/server/MusicRoute";
import { setNoStoreHeaders } from "../../src/server/NoStoreHeaders";

describe("MusicRoute", () => {
  let tempDir: string | null = null;
  let server: http.Server | null = null;

  async function createTempApp(): Promise<string> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "music-route-"));

    const proprietaryMusicDir = path.join(
      tempDir,
      "proprietary",
      "sounds",
      "music",
    );
    const resourcesMusicDir = path.join(
      tempDir,
      "resources",
      "sounds",
      "music",
    );
    const uploadsMusicDir = path.join(tempDir, "uploads", "music");
    await fs.mkdir(proprietaryMusicDir, { recursive: true });
    await fs.mkdir(resourcesMusicDir, { recursive: true });
    await fs.mkdir(uploadsMusicDir, { recursive: true });
    await fs.writeFile(path.join(proprietaryMusicDir, "Song One.mp3"), "prop");
    await fs.writeFile(path.join(resourcesMusicDir, "Song One.mp3"), "res");
    await fs.writeFile(path.join(uploadsMusicDir, "Upload Song.mp3"), "upload");

    const app = express();
    registerMusicFileRoutes(app, tempDir);
    app.use(rateLimit({ windowMs: 1000, max: 1 }));
    app.use("/api", (_req, res, next) => {
      setNoStoreHeaders(res);
      next();
    });
    registerMusicRoutes(app, tempDir);

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected server to listen on a TCP port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("returns source-served URLs for static music", async () => {
    const origin = await createTempApp();

    const tracksResponse = await fetch(`${origin}/api/music/tracks`);
    expect(tracksResponse.ok).toBe(true);
    const body = (await tracksResponse.json()) as {
      tracks: Array<{ filename: string; url: string }>;
    };

    expect(body.tracks).toEqual(
      expect.arrayContaining([
        {
          filename: "Song One.mp3",
          url: "/music/static/Song%20One.mp3",
        },
        {
          filename: "Upload Song.mp3",
          url: "/music/uploads/Upload%20Song.mp3",
        },
      ]),
    );

    const staticTrackResponse = await fetch(
      `${origin}/music/static/Song%20One.mp3`,
    );
    expect(staticTrackResponse.ok).toBe(true);
    expect(staticTrackResponse.headers.has("x-ratelimit-limit")).toBe(false);
    expect(staticTrackResponse.headers.get("cache-control")).toBe(
      "public, max-age=0",
    );
    expect(await staticTrackResponse.text()).toBe("prop");

    const uploadTrackResponse = await fetch(
      `${origin}/music/uploads/Upload%20Song.mp3`,
    );
    expect(uploadTrackResponse.ok).toBe(true);
    expect(uploadTrackResponse.headers.has("x-ratelimit-limit")).toBe(false);
    expect(uploadTrackResponse.headers.get("cache-control")).toBe(
      "public, max-age=0",
    );
    expect(await uploadTrackResponse.text()).toBe("upload");
  });
});
