import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchMusicTracks,
  MAX_MUSIC_UPLOAD_BYTES,
  MusicUploadError,
  normalizeMusicUploadFilename,
  uploadMusicTrack,
} from "../../src/client/MusicApi";

describe("MusicApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes legacy upload URLs when source flags are absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          tracks: [
            {
              filename: "Uploaded.mp3",
              url: "/music/uploads/Uploaded.mp3",
            },
            {
              filename: "Bundled.mp3",
              url: "/music/static/Bundled.mp3",
            },
          ],
        }),
      ),
    );

    await expect(fetchMusicTracks()).resolves.toEqual([
      {
        filename: "Uploaded.mp3",
        url: "/music/uploads/Uploaded.mp3",
        source: "upload",
        deletable: true,
      },
      {
        filename: "Bundled.mp3",
        url: "/music/static/Bundled.mp3",
        source: "bundled",
        deletable: false,
      },
    ]);
  });

  it("uploads the selected File with the settings-compatible request", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        filename: "New Song.mp3",
        url: "/music/uploads/New%20Song.mp3",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["mp3"], "New Song.mp3", { type: "audio/mpeg" });

    await expect(uploadMusicTrack(file)).resolves.toMatchObject({
      filename: "New Song.mp3",
      source: "upload",
      deletable: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/music/upload", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "audio/mpeg",
        "X-Filename": "New%20Song.mp3",
      },
      body: file,
    });
  });

  it.each([
    [409, "duplicate_file"],
    [413, "file_too_large"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ code, error: "Useful server error" }, { status }),
      ),
    );
    const file = new File(["mp3"], "Song.mp3", { type: "audio/mpeg" });

    await expect(uploadMusicTrack(file)).rejects.toMatchObject({
      name: "MusicUploadError",
      code,
      message: "Useful server error",
      status,
    } satisfies Partial<MusicUploadError>);
  });

  it("rejects oversized files without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["mp3"], "Huge Song.mp3", {
      type: "audio/mpeg",
    });
    Object.defineProperty(file, "size", {
      value: MAX_MUSIC_UPLOAD_BYTES + 1,
    });

    await expect(uploadMusicTrack(file)).rejects.toMatchObject({
      name: "MusicUploadError",
      code: "file_too_large",
      status: 413,
    } satisfies Partial<MusicUploadError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes upload names the same way as the server", () => {
    expect(normalizeMusicUploadFilename("Odd: Song?.MP3")).toBe(
      "Odd_ Song_.MP3",
    );
    expect(normalizeMusicUploadFilename("No Extension")).toBe(
      "No Extension.mp3",
    );
  });
});
