import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioMixer } from "../../../src/client/sound/AudioMixer";
import {
  MUSIC_DUCK_DB,
  MusicLibraryPlayer,
} from "../../../src/client/sound/MusicLibraryPlayer";
import {
  AddMusicTrackEvent,
  MusicNextTrackEvent,
} from "../../../src/client/sound/Sounds";

vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));

let bus: EventBus;
let player: MusicLibraryPlayer;
let output: number;
let cues: boolean;
let changed: () => void;
let unsubscribe: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function audio(): HTMLAudioElement {
  return (player as unknown as { musicAudio: HTMLAudioElement }).musicAudio;
}

beforeEach(() => {
  output = 1;
  cues = false;
  unsubscribe = vi.fn();
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ tracks: [] }),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  bus = new EventBus();
  const mixer = {
    musicOutputVolume: () => output,
    hasAudibleCues: () => cues,
    onChange: (fn: () => void) => {
      changed = fn;
      return unsubscribe;
    },
  } as unknown as AudioMixer;
  player = new MusicLibraryPlayer(bus, mixer, true);
});

afterEach(() => {
  player.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("music library integration", () => {
  it("follows the mixer's combined master, music, and focus gain", () => {
    player.addTrack("/music/static/one.mp3", false);
    output = 0.125;
    changed();
    expect(audio().volume).toBe(0.125);
    output = 0;
    changed();
    expect(audio().volume).toBe(0);
  });

  it("defers playback while muted and starts when the mixer becomes audible", () => {
    player.addTrack("/music/static/one.mp3", false);
    output = 0;
    changed();
    player.playBackgroundMusic();
    expect(audio().play).not.toHaveBeenCalled();
    output = 0.5;
    changed();
    expect(audio().play).toHaveBeenCalledOnce();
    player.stopBackgroundMusic();
    changed();
    expect(audio().play).toHaveBeenCalledOnce();
  });

  it("applies ReplayGain before the mixer output gain", async () => {
    player.addTrack("/music/static/one.mp3", false);
    await Promise.resolve();
    const internals = player as unknown as {
      backgroundMusic: { replayGainTrackGainDb?: number }[];
    };
    internals.backgroundMusic[0].replayGainTrackGainDb = -6;
    output = 0.5;
    changed();
    expect(audio().volume).toBeCloseTo(0.5 * 10 ** (-6 / 20));
  });

  it("ducks by 3 dB for audible cues and restores gain when they end", () => {
    cues = true;
    changed();
    expect(audio().volume).toBeCloseTo(10 ** (MUSIC_DUCK_DB / 20));
    cues = false;
    changed();
    expect(audio().volume).toBe(1);
  });

  it("accepts uploads and advances with the existing music controls", () => {
    bus.emit(new AddMusicTrackEvent("/music/uploads/one.mp3", true, "one.mp3"));
    bus.emit(
      new AddMusicTrackEvent("/music/uploads/two.mp3", false, "two.mp3"),
    );
    bus.emit(new MusicNextTrackEvent());
    expect(audio().getAttribute("src")).toBe("/music/uploads/two.mp3");
  });

  it("deletes the current upload and continues to the next track", async () => {
    player.addTrack("/music/uploads/one.mp3", true, "one.mp3", true);
    player.addTrack("/music/uploads/two.mp3", false, "two.mp3", true);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Delete", ctrlKey: true }),
    );
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/music/uploads/one.mp3", {
        method: "DELETE",
      }),
    );
    expect(audio().getAttribute("src")).toBe("/music/uploads/two.mp3");
  });

  it("protects bundled tracks and ignores shortcuts in text inputs", async () => {
    player.addTrack("/music/static/one.mp3", true, "one.mp3");
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Delete", ctrlKey: true }),
    );
    player.addTrack("/music/uploads/two.mp3", true, "two.mp3", true);
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Delete",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    input.remove();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("restores the current track when deletion fails", async () => {
    player.addTrack("/music/uploads/one.mp3", true, "one.mp3", true);
    const normalFetch = fetchMock.getMockImplementation()! as typeof fetch;
    fetchMock.mockImplementation((url, init) =>
      init?.method === "DELETE"
        ? Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ error: "failed" }),
          })
        : normalFetch(url, init),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const message = vi.fn();
    window.addEventListener("show-message", message);
    try {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Delete", ctrlKey: true }),
      );
      await vi.waitFor(() =>
        expect(message).toHaveBeenCalledWith(
          expect.objectContaining({
            detail: expect.objectContaining({
              message: "music_page.delete_error",
            }),
          }),
        ),
      );
      expect(audio().getAttribute("src")).toBe("/music/uploads/one.mp3");
    } finally {
      window.removeEventListener("show-message", message);
    }
  });

  it("releases audio and unsubscribes uploads and controls on disposal", () => {
    player.addTrack("/music/static/one.mp3", true);
    player.dispose();
    expect(audio().hasAttribute("src")).toBe(false);
    expect(unsubscribe).toHaveBeenCalled();
    bus.emit(new AddMusicTrackEvent("/music/uploads/two.mp3", true));
    expect(audio().hasAttribute("src")).toBe(false);
  });
});
