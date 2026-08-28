import express from "express";
import rateLimit from "express-rate-limit";
import fs from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  deleteUploadedFile,
  registerMusicFileRoutes,
  registerMusicRoutes,
} from "../../src/server/MusicRoute";
import { setNoStoreHeaders } from "../../src/server/NoStoreHeaders";

describe("MusicRoute", () => {
  let tempDir: string | null = null;
  let server: http.Server | null = null;

  async function createTempApp(maxUploadBytes?: number): Promise<string> {
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
    app.use(rateLimit({ windowMs: 1000, max: 100 }));
    app.use("/api", (_req, res, next) => {
      setNoStoreHeaders(res);
      next();
    });
    registerMusicRoutes(app, tempDir, maxUploadBytes);

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
      tracks: Array<{
        filename: string;
        url: string;
        source: "bundled" | "upload";
        deletable: boolean;
      }>;
    };

    expect(body.tracks).toEqual(
      expect.arrayContaining([
        {
          filename: "Song One.mp3",
          url: "/music/static/Song%20One.mp3",
          source: "bundled",
          deletable: false,
        },
        {
          filename: "Upload Song.mp3",
          url: "/music/uploads/Upload%20Song.mp3",
          source: "upload",
          deletable: true,
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

  test("deletes only MP3 files directly inside the uploads directory", async () => {
    const origin = await createTempApp();

    const deleteResponse = await fetch(
      `${origin}/api/music/uploads/Upload%20Song.mp3`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(204);

    const deletedFile = path.join(
      tempDir!,
      "uploads",
      "music",
      "Upload Song.mp3",
    );
    await expect(fs.stat(deletedFile)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const bundledDeleteResponse = await fetch(
      `${origin}/api/music/uploads/Song%20One.mp3`,
      { method: "DELETE" },
    );
    expect(bundledDeleteResponse.status).toBe(404);
    expect(
      await fs.readFile(
        path.join(tempDir!, "proprietary", "sounds", "music", "Song One.mp3"),
        "utf8",
      ),
    ).toBe("prop");

    const nonMp3 = path.join(tempDir!, "uploads", "music", "notes.txt");
    await fs.writeFile(nonMp3, "keep");
    const nonMp3DeleteResponse = await fetch(
      `${origin}/api/music/uploads/notes.txt`,
      { method: "DELETE" },
    );
    expect(nonMp3DeleteResponse.status).toBe(400);
    expect(await fs.readFile(nonMp3, "utf8")).toBe("keep");

    const outsideUploadDir = path.join(tempDir!, "uploads", "outside.mp3");
    await fs.writeFile(outsideUploadDir, "keep outside");
    const traversalResponse = await fetch(
      `${origin}/api/music/uploads/..%2Foutside.mp3`,
      { method: "DELETE" },
    );
    expect(traversalResponse.status).toBe(400);
    expect(await fs.readFile(outsideUploadDir, "utf8")).toBe("keep outside");
  });

  test("uploads an MP3 and returns a playable uploaded-track response", async () => {
    const origin = await createTempApp();
    const audio = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]);

    const response = await fetch(`${origin}/api/music/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/mpeg",
        "X-Filename": encodeURIComponent("New Track.mp3"),
      },
      body: audio,
    });

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({
      filename: "New Track.mp3",
      url: "/music/uploads/New%20Track.mp3",
      source: "upload",
      deletable: true,
    });
    expect(
      await fs.readFile(
        path.join(tempDir!, "uploads", "music", "New Track.mp3"),
      ),
    ).toEqual(audio);
  });

  test("rejects duplicate uploads without overwriting the existing track", async () => {
    const origin = await createTempApp();

    const response = await fetch(`${origin}/api/music/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/mpeg",
        "X-Filename": encodeURIComponent("Upload Song.mp3"),
      },
      body: Buffer.from("replacement"),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "duplicate_file",
      error: "A track with this filename already exists.",
    });
    expect(
      await fs.readFile(
        path.join(tempDir!, "uploads", "music", "Upload Song.mp3"),
        "utf8",
      ),
    ).toBe("upload");
  });

  test("returns a JSON error when an upload exceeds the size limit", async () => {
    const origin = await createTempApp(4);

    const response = await fetch(`${origin}/api/music/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/mpeg",
        "X-Filename": encodeURIComponent("Huge Song.mp3"),
      },
      body: Buffer.from("12345"),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      code: "file_too_large",
    });
    await expect(
      fs.stat(path.join(tempDir!, "uploads", "music", "Huge Song.mp3")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retries Windows file-lock errors before giving up", async () => {
    const busy = Object.assign(new Error("file is busy"), { code: "EBUSY" });
    const unlink = vi
      .fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockResolvedValue(undefined);
    const wait = vi.fn(async () => {});

    await expect(
      deleteUploadedFile("C:\\uploads\\music\\track.mp3", unlink, wait),
    ).resolves.toBeUndefined();
    expect(unlink).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenNthCalledWith(1, 75);
    expect(wait).toHaveBeenNthCalledWith(2, 150);
  });
});
