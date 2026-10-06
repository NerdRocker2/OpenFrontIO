import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Silence fetch — loadTracksFromServer() and fetchId3Metadata() both call it.
// Return an empty track list for the tracks endpoint and an empty buffer
// for any Range/ID3 request so the parser returns {} without throwing.
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ tracks: [] }),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  }),
);

// Mock howler before importing SoundManager
const howlCtor = vi.fn();
const howlInstances: any[] = [];
let nextPlayId = 1;
vi.mock("howler", () => {
  class MockHowl {
    play = vi.fn(() => nextPlayId++);
    stop = vi.fn((id?: number) => {
      if (id !== undefined) {
        this._fireEvent("stop", id);
      }
    });
    volume = vi.fn();
    playing = vi.fn().mockReturnValue(false);
    unload = vi.fn();
    once = vi.fn((event: string, callback: () => void, id?: number) => {
      if (id !== undefined) {
        if (!this._listeners.has(event)) {
          this._listeners.set(event, new Map());
        }
        this._listeners.get(event)!.set(id, callback);
      }
    });
    _listeners: Map<string, Map<number, () => void>> = new Map();
    _fireEvent(event: string, id: number) {
      const cb = this._listeners.get(event)?.get(id);
      if (cb) {
        cb();
        this._listeners.get(event)?.delete(id);
      }
    }
    constructor(_opts: any) {
      howlCtor(_opts);
      howlInstances.push(this);
    }
  }
  return { Howl: MockHowl };
});

// Mock the Sounds module so tests don't depend on actual asset paths
vi.mock("../../../src/client/sound/Sounds", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/client/sound/Sounds")>();
  return {
    ...actual,
    soundEffectUrls: new Map([
      ["click", "mock/click.mp3"],
      ["atom-hit", "mock/atom-hit.mp3"],
      ["atom-launch", "mock/atom-launch.mp3"],
      ["hydrogen-hit", "mock/hydrogen-hit.mp3"],
      ["hydrogen-launch", "mock/hydrogen-launch.mp3"],
      ["mirv-launch", "mock/mirv-launch.mp3"],
      ["ka-ching", "mock/ka-ching.mp3"],
      ["message", "mock/message.mp3"],
      ["build-city", "mock/build-city.mp3"],
    ]),
  };
});

import {
  MAX_CONCURRENT_SOUNDS,
  MUSIC_DUCK_DB,
  SoundManager,
} from "../../../src/client/sound/SoundManager";
import {
  PlaySoundEffectEvent,
  SetBackgroundMusicVolumeEvent,
  SetSoundEffectsVolumeEvent,
} from "../../../src/client/sound/Sounds";
import { EventBus } from "../../../src/core/EventBus";
import { UserSettings } from "../../../src/core/game/UserSettings";

function createUserSettings(musicVolume = 0, sfxVolume = 1): UserSettings {
  const settings = new UserSettings();
  settings.setBackgroundMusicVolume(musicVolume);
  settings.setSoundEffectsVolume(sfxVolume);
  return settings;
}

describe("SoundManager", () => {
  let eventBus: EventBus;
  let userSettings: UserSettings;
  let soundManager: SoundManager;

  beforeAll(() => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  beforeEach(() => {
    howlCtor.mockClear();
    howlInstances.length = 0;
    nextPlayId = 1;
    eventBus = new EventBus();
    userSettings = createUserSettings();
    soundManager = new SoundManager(eventBus, userSettings);
    // Seed three background tracks synchronously (server fetch is async/mocked).
    soundManager.addTrack("mock/bg1.mp3", false);
    soundManager.addTrack("mock/bg2.mp3", false);
    soundManager.addTrack("mock/bg3.mp3", false);
  });

  it("lazy-loads a sound effect once and reuses it", () => {
    eventBus.emit(new PlaySoundEffectEvent("click"));
    eventBus.emit(new PlaySoundEffectEvent("click"));
    expect(howlCtor).toHaveBeenCalledTimes(1);
  });

  it("plays a sound effect when PlaySoundEffectEvent is emitted", () => {
    eventBus.emit(new PlaySoundEffectEvent("atom-hit"));
    const effectHowl = howlInstances[howlInstances.length - 1];
    expect(effectHowl.play).toHaveBeenCalledTimes(1);
  });

  it("applies bootstrap volume from UserSettings to background music", () => {
    const settings = createUserSettings(0.5, 1);
    const bus = new EventBus();
    howlCtor.mockClear();
    howlInstances.length = 0;
    const sm = new SoundManager(bus, settings);
    sm.addTrack("mock/bg1.mp3", false);
    sm.addTrack("mock/bg2.mp3", false);
    sm.addTrack("mock/bg3.mp3", false);
    expect((sm as any).musicAudio.volume).toBe(0.25);
  });

  it("applies current sfx volume to lazily-loaded sounds", () => {
    const settings = createUserSettings(0, 0.3);
    const bus = new EventBus();
    howlCtor.mockClear();
    howlInstances.length = 0;
    new SoundManager(bus, settings);
    bus.emit(new PlaySoundEffectEvent("click"));
    // Slider position 0.3 is curved (squared) into perceptual gain: 0.3² = 0.09.
    expect(howlCtor).toHaveBeenLastCalledWith(
      expect.objectContaining({ volume: 0.09 }),
    );
  });

  it("responds to SetBackgroundMusicVolumeEvent", () => {
    eventBus.emit(new SetBackgroundMusicVolumeEvent(0.7));
    expect((soundManager as any).musicAudio.volume).toBeCloseTo(0.7 * 0.7);
  });

  it("responds to SetSoundEffectsVolumeEvent", () => {
    eventBus.emit(new PlaySoundEffectEvent("click"));
    const clickHowl = howlInstances[howlInstances.length - 1];
    clickHowl.volume.mockClear();
    eventBus.emit(new SetSoundEffectsVolumeEvent(0.4));
    // 0.4² = 0.16 perceptual gain.
    expect(clickHowl.volume).toHaveBeenCalledWith(0.4 * 0.4);
  });

  it("clamps volume values between 0 and 1", () => {
    eventBus.emit(new SetBackgroundMusicVolumeEvent(2));
    expect((soundManager as any).musicAudio.volume).toBe(1);
    eventBus.emit(new SetBackgroundMusicVolumeEvent(-0.5));
    expect((soundManager as any).musicAudio.volume).toBe(0);
  });

  it("curves the slider position into perceptual gain so the top of the range is audibly distinct", () => {
    // Linear gain would make 0.9 and 1.0 nearly indistinguishable; squaring
    // spreads the top end (0.9 → 0.81) so reductions are noticeable sooner.
    eventBus.emit(new SetBackgroundMusicVolumeEvent(0.9));
    expect((soundManager as any).musicAudio.volume).toBeCloseTo(0.81);
  });

  it("dispose() unsubscribes from EventBus so events no longer play sounds", () => {
    eventBus.emit(new PlaySoundEffectEvent("click"));
    const clickHowl = howlInstances[howlInstances.length - 1];
    expect(clickHowl.play).toHaveBeenCalledTimes(1);

    soundManager.dispose();

    eventBus.emit(new PlaySoundEffectEvent("click"));
    expect(clickHowl.play).toHaveBeenCalledTimes(1);
  });

  it("dispose() stops and unloads all loaded sound effects", () => {
    eventBus.emit(new PlaySoundEffectEvent("click"));
    const clickHowl = howlInstances[howlInstances.length - 1];

    soundManager.dispose();

    expect(clickHowl.stop).toHaveBeenCalled();
    expect(clickHowl.unload).toHaveBeenCalled();
  });

  it("dispose() stops background music and releases its source", () => {
    const audio = (soundManager as any).musicAudio as HTMLAudioElement;
    const pause = vi.spyOn(audio, "pause");
    audio.src = "mock/bg1.mp3";
    soundManager.dispose();
    expect(pause).toHaveBeenCalled();
    expect(audio.hasAttribute("src")).toBe(false);
  });

  it("applies ReplayGain track gain before the user volume", () => {
    eventBus.emit(new SetBackgroundMusicVolumeEvent(1));
    (soundManager as any).backgroundMusic[0].replayGainTrackGainDb = -6;
    (soundManager as any).applyCurrentTrackGain();
    expect((soundManager as any).musicAudio.volume).toBeCloseTo(
      10 ** (-6 / 20),
    );
  });

  it("ducks music by only 3 dB while an effect is active", () => {
    eventBus.emit(new SetBackgroundMusicVolumeEvent(1));
    eventBus.emit(new PlaySoundEffectEvent("click"));
    const clickHowl = howlInstances[howlInstances.length - 1];
    expect((soundManager as any).musicAudio.volume).toBeCloseTo(
      10 ** (MUSIC_DUCK_DB / 20),
    );

    clickHowl._fireEvent("end", 1);
    expect((soundManager as any).musicAudio.volume).toBe(1);
  });

  it("does not throw when playSoundEffect is called directly", () => {
    expect(() => soundManager.playSoundEffect("click")).not.toThrow();
  });

  it("does not throw when playBackgroundMusic and stopBackgroundMusic are called", () => {
    expect(() => soundManager.playBackgroundMusic()).not.toThrow();
    expect(() => soundManager.stopBackgroundMusic()).not.toThrow();
  });

  it("deletes the current upload with Ctrl+Delete during solo play and continues to the next track", async () => {
    const solo = new SoundManager(eventBus, userSettings, true);
    solo.addTrack("/music/static/Bundled.mp3", false, "Bundled.mp3");
    solo.addTrack("/music/uploads/First.mp3", false, "First.mp3", true);
    solo.addTrack("/music/uploads/Second.mp3", true, "Second.mp3", true);
    const message = vi.fn();
    window.addEventListener("show-message", message);

    const shortcut = new KeyboardEvent("keydown", {
      code: "Delete",
      ctrlKey: true,
      cancelable: true,
    });
    window.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/music/uploads/Second.mp3", {
        method: "DELETE",
      });
      expect((solo as any).backgroundMusic).toHaveLength(2);
    });
    expect((solo as any).musicAudio.getAttribute("src")).toBe(
      "/music/uploads/First.mp3",
    );
    expect(message).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          message: "music_page.delete_done",
          color: "green",
        }),
      }),
    );

    const deleteCalls = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([, options]) =>
          options && "method" in options && options.method === "DELETE",
      ).length;
    solo.dispose();
    window.removeEventListener("show-message", message);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Delete", ctrlKey: true }),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([, options]) =>
            options && "method" in options && options.method === "DELETE",
        ),
    ).toHaveLength(deleteCalls);
  });

  it("protects bundled tracks and ignores Ctrl+Delete in text fields", () => {
    const solo = new SoundManager(eventBus, userSettings, true);
    solo.addTrack("/music/static/Bundled.mp3", true, "Bundled.mp3");
    const deleteCalls = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([, options]) =>
          options && "method" in options && options.method === "DELETE",
      ).length;
    const message = vi.fn();
    window.addEventListener("show-message", message);
    const input = document.createElement("input");
    document.body.appendChild(input);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Delete",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    expect(message).not.toHaveBeenCalled();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Delete", ctrlKey: true }),
    );
    expect(message).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          message: "music_page.delete_bundled_error",
          color: "red",
        }),
      }),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([, options]) =>
            options && "method" in options && options.method === "DELETE",
        ),
    ).toHaveLength(deleteCalls);

    input.remove();
    solo.dispose();
    window.removeEventListener("show-message", message);
  });

  it("restores the current track when deletion fails", async () => {
    const fetchMock = vi.mocked(fetch);
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) =>
      init?.method === "DELETE"
        ? Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ error: "delete failed" }),
          } as Response)
        : originalFetch(input, init),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const solo = new SoundManager(eventBus, userSettings, true);
    solo.addTrack("/music/uploads/Current.mp3", true, "Current.mp3", true);
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
              color: "red",
            }),
          }),
        ),
      );
      expect((solo as any).backgroundMusic).toHaveLength(1);
      expect((solo as any).musicAudio.getAttribute("src")).toBe(
        "/music/uploads/Current.mp3",
      );
    } finally {
      solo.dispose();
      window.removeEventListener("show-message", message);
      fetchMock.mockImplementation(originalFetch);
      errorLog.mockRestore();
    }
  });

  it("swallows errors from Howler and does not propagate", () => {
    howlInstances.forEach((h) => {
      h.play.mockImplementation(() => {
        throw new Error("audio backend failure");
      });
      h.stop.mockImplementation(() => {
        throw new Error("audio backend failure");
      });
      h.volume.mockImplementation(() => {
        throw new Error("audio backend failure");
      });
    });
    eventBus.emit(new PlaySoundEffectEvent("click"));
    const clickHowl = howlInstances[howlInstances.length - 1];
    clickHowl.play.mockImplementation(() => {
      throw new Error("audio backend failure");
    });
    clickHowl.stop.mockImplementation(() => {
      throw new Error("audio backend failure");
    });
    clickHowl.volume.mockImplementation(() => {
      throw new Error("audio backend failure");
    });

    expect(() => soundManager.playBackgroundMusic()).not.toThrow();
    expect(() => soundManager.stopBackgroundMusic()).not.toThrow();
    expect(() => soundManager.setBackgroundMusicVolume(0.5)).not.toThrow();
    expect(() => soundManager.setSoundEffectsVolume(0.5)).not.toThrow();
    expect(() => soundManager.playSoundEffect("click")).not.toThrow();
    expect(() => soundManager.stopSoundEffect("click")).not.toThrow();
  });
});

describe("Sound channel management", () => {
  let eventBus: EventBus;

  beforeEach(() => {
    howlCtor.mockClear();
    howlInstances.length = 0;
    nextPlayId = 1;
    eventBus = new EventBus();
    new SoundManager(eventBus, createUserSettings());
  });

  it("new sound always plays even when at channel cap", () => {
    for (let i = 0; i < MAX_CONCURRENT_SOUNDS; i++) {
      eventBus.emit(new PlaySoundEffectEvent("click"));
    }

    eventBus.emit(new PlaySoundEffectEvent("atom-hit"));
    const atomHowl = howlInstances[howlInstances.length - 1];
    expect(atomHowl.play).toHaveBeenCalled();
  });

  it("stops the oldest sound when at channel cap", () => {
    for (let i = 0; i < MAX_CONCURRENT_SOUNDS; i++) {
      eventBus.emit(new PlaySoundEffectEvent("click"));
    }
    const clickHowl = howlInstances[howlInstances.length - 1];

    // The first play had id=1. Playing one more should stop id=1.
    eventBus.emit(new PlaySoundEffectEvent("atom-hit"));
    expect(clickHowl.stop).toHaveBeenCalledWith(1);
  });

  it("frees a channel when a sound ends naturally", () => {
    for (let i = 0; i < MAX_CONCURRENT_SOUNDS; i++) {
      eventBus.emit(new PlaySoundEffectEvent("click"));
    }
    const clickHowl = howlInstances[howlInstances.length - 1];

    // Simulate first sound ending naturally
    clickHowl._fireEvent("end", 1);

    // Next sound should play without stopping anything
    clickHowl.stop.mockClear();
    eventBus.emit(new PlaySoundEffectEvent("click"));
    expect(clickHowl.stop).not.toHaveBeenCalled();
  });

  it("allows up to MAX_CONCURRENT_SOUNDS without stopping any", () => {
    for (let i = 0; i < MAX_CONCURRENT_SOUNDS; i++) {
      eventBus.emit(new PlaySoundEffectEvent("click"));
    }
    const clickHowl = howlInstances[howlInstances.length - 1];
    expect(clickHowl.play).toHaveBeenCalledTimes(8);
    // No stop calls with specific IDs (only general stop might be called)
    expect(clickHowl.stop).not.toHaveBeenCalled();
  });
});
