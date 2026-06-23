import { Howl } from "howler";
import { EventBus } from "../../core/EventBus";
import { UserSettings } from "../../core/game/UserSettings";
import { fetchId3Metadata, metadataFromFilename } from "./Id3Reader";
import {
  AddMusicTrackEvent,
  MusicNextTrackEvent,
  MusicPrevTrackEvent,
  MusicTogglePauseEvent,
  PlaySoundEffectEvent,
  SetBackgroundMusicVolumeEvent,
  SetSoundEffectsVolumeEvent,
  SoundEffect,
  soundEffectUrls,
} from "./Sounds";

export const MAX_CONCURRENT_SOUNDS = 8;

interface TrackMetadata {
  title: string;
  artist: string;
}

export class SoundManager {
  private backgroundMusic: Howl[] = [];
  private trackMetadata: TrackMetadata[] = [];
  private currentTrack: number = 0;
  private soundEffects: Map<SoundEffect, Howl> = new Map();
  private soundEffectsVolume: number = 1;
  private backgroundMusicVolume: number = 0;
  private activeSounds: { howl: Howl; id: number }[] = [];
  private pendingPlay: boolean = false;
  private eventBus: EventBus;
  private onPlaySoundEffect: (e: PlaySoundEffectEvent) => void;
  private onSetBackgroundMusicVolume: (
    e: SetBackgroundMusicVolumeEvent,
  ) => void;
  private onSetSoundEffectsVolume: (e: SetSoundEffectsVolumeEvent) => void;
  private onMusicTogglePause: () => void;
  private onMusicNextTrack: () => void;
  private onMusicPrevTrack: () => void;
  private mediaSessionAnchor: HTMLAudioElement | null = null;
  private mediaSessionAnchorUrl: string | null = null;

  constructor(eventBus: EventBus, userSettings: UserSettings) {
    this.eventBus = eventBus;
    this.setBackgroundMusicVolume(userSettings.backgroundMusicVolume());
    this.setSoundEffectsVolume(userSettings.soundEffectsVolume());
    this.onPlaySoundEffect = (e) => this.playSoundEffect(e.effect);
    this.onSetBackgroundMusicVolume = (e) =>
      this.setBackgroundMusicVolume(e.volume);
    this.onSetSoundEffectsVolume = (e) => this.setSoundEffectsVolume(e.volume);
    this.onMusicTogglePause = () => this.toggleMusicPause();
    this.onMusicNextTrack = () => this.skipToNextTrack();
    this.onMusicPrevTrack = () => this.skipToPrevTrack();
    eventBus.on(PlaySoundEffectEvent, this.onPlaySoundEffect);
    eventBus.on(SetBackgroundMusicVolumeEvent, this.onSetBackgroundMusicVolume);
    eventBus.on(SetSoundEffectsVolumeEvent, this.onSetSoundEffectsVolume);
    eventBus.on(MusicTogglePauseEvent, this.onMusicTogglePause);
    eventBus.on(MusicNextTrackEvent, this.onMusicNextTrack);
    eventBus.on(MusicPrevTrackEvent, this.onMusicPrevTrack);
    eventBus.on(AddMusicTrackEvent, (e) =>
      this.addTrack(e.url, e.playImmediately),
    );
    this.initMediaSession();
    this.loadTracksFromServer();
  }

  public dispose(): void {
    this.eventBus.off(PlaySoundEffectEvent, this.onPlaySoundEffect);
    this.eventBus.off(
      SetBackgroundMusicVolumeEvent,
      this.onSetBackgroundMusicVolume,
    );
    this.eventBus.off(SetSoundEffectsVolumeEvent, this.onSetSoundEffectsVolume);
    this.eventBus.off(MusicTogglePauseEvent, this.onMusicTogglePause);
    this.eventBus.off(MusicNextTrackEvent, this.onMusicNextTrack);
    this.eventBus.off(MusicPrevTrackEvent, this.onMusicPrevTrack);
    if (this.mediaSessionAnchor) {
      this.mediaSessionAnchor.pause();
      this.mediaSessionAnchor.remove();
      this.mediaSessionAnchor = null;
    }
    if (this.mediaSessionAnchorUrl) {
      URL.revokeObjectURL(this.mediaSessionAnchorUrl);
      this.mediaSessionAnchorUrl = null;
    }
    this.backgroundMusic.forEach((track) => {
      this.safely("stop background track", () => track.stop());
      this.safely("unload background track", () => track.unload());
    });
    this.soundEffects.forEach((sound) => {
      this.safely("stop sound effect", () => sound.stop());
      this.safely("unload sound effect", () => sound.unload());
    });
    this.soundEffects.clear();
    this.activeSounds = [];
  }

  private safely(action: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`SoundManager: failed to ${action}`, err);
    }
  }

  private initMediaSession(): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      console.warn("SoundManager: Media Session API not available");
      return;
    }
    console.log("SoundManager: registering Media Session API handlers");
    const actions: [MediaSessionAction, () => void][] = [
      ["play", () => this.toggleMusicPause()],
      ["pause", () => this.toggleMusicPause()],
      ["nexttrack", () => this.skipToNextTrack()],
      ["previoustrack", () => this.skipToPrevTrack()],
    ];
    for (const [action, handler] of actions) {
      try {
        navigator.mediaSession.setActionHandler(action, () => {
          console.log(`SoundManager: Media Session action "${action}" fired`);
          handler();
        });
        console.log(`SoundManager: registered handler for "${action}"`);
      } catch (e) {
        console.warn(`SoundManager: failed to register handler for "${action}":`, e);
      }
    }
    console.log("SoundManager: Media Session setup complete");
  }

  /**
   * Creates a silent looping HTMLAudioElement and keeps it playing.
   * Chromium-based browsers only route hardware media keys to a page via the
   * Media Session API when an HTMLMediaElement is actively playing. The Web
   * Audio API (used by Howler) is not sufficient on its own.
   */
  private ensureMediaSessionAnchor(): void {
    if (this.mediaSessionAnchor) return;
    if (typeof document === "undefined" || typeof URL === "undefined") return;
    try {
      // Minimal 1-sample, 8-bit, mono, 8 kHz WAV — just enough audio to keep
      // an HTMLMediaElement in the "playing" state at zero volume.
      const bytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x25, 0x00, 0x00, 0x00, // RIFF + size (37)
        0x57, 0x41, 0x56, 0x45,                         // "WAVE"
        0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, // "fmt " + 16
        0x01, 0x00,                                      // PCM
        0x01, 0x00,                                      // 1 channel
        0x40, 0x1f, 0x00, 0x00,                         // 8000 Hz
        0x40, 0x1f, 0x00, 0x00,                         // 8000 bytes/sec
        0x01, 0x00,                                      // block align
        0x08, 0x00,                                      // 8 bits/sample
        0x64, 0x61, 0x74, 0x61, 0x01, 0x00, 0x00, 0x00, // "data" + 1 byte
        0x80,                                            // silence
      ]);
      this.mediaSessionAnchorUrl = URL.createObjectURL(
        new Blob([bytes], { type: "audio/wav" }),
      );
      this.mediaSessionAnchor = document.createElement("audio");
      this.mediaSessionAnchor.src = this.mediaSessionAnchorUrl;
      this.mediaSessionAnchor.loop = true;
      this.mediaSessionAnchor.volume = 0;
      document.body.appendChild(this.mediaSessionAnchor);
      this.mediaSessionAnchor.play().then(() => {
        console.log("SoundManager: media session anchor playing");
      }).catch((err) => {
        console.warn("SoundManager: media session anchor failed to play:", err);
      });
    } catch (err) {
      console.warn("SoundManager: failed to create media session anchor:", err);
    }
  }

  private updateMediaSessionState(playing: boolean): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;
    const meta = this.trackMetadata[this.currentTrack];
    if (meta) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title,
        artist: meta.artist,
        album: "OpenFront.io",
      });
    }
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    console.log(
      `SoundManager: mediaSession state → ${playing ? "playing" : "paused"}, ` +
      `track ${this.currentTrack} "${meta?.title ?? "?"}"`,
    );
  }

  private loadTracksFromServer(): void {
    fetch("/api/music/tracks")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ tracks: { filename: string; url: string }[] }>;
      })
      .then(({ tracks }) => {
        for (const track of tracks) {
          this.addTrack(track.url, false);
        }
        if (this.pendingPlay && this.backgroundMusic.length > 0) {
          this.pendingPlay = false;
          this.playBackgroundMusic();
        }
      })
      .catch((err) =>
        console.error("SoundManager: failed to load music tracks", err),
      );
  }

  public addTrack(url: string, playImmediately: boolean): void {
    this.safely("add track", () => {
      const fallback = metadataFromFilename(url);
      const newIndex = this.backgroundMusic.length;

      const howl = new Howl({
        src: [url],
        loop: false,
        onend: this.playNext.bind(this),
        volume: 0,
      });
      howl.volume(this.backgroundMusicVolume);

      this.backgroundMusic.push(howl);
      this.trackMetadata.push(fallback);

      // Async ID3 read — updates metadata and refreshes MediaSession if playing.
      fetchId3Metadata(url).then((id3) => {
        if (id3.title || id3.artist) {
          this.trackMetadata[newIndex] = {
            title: id3.title ?? fallback.title,
            artist: id3.artist ?? fallback.artist,
          };
          if (newIndex === this.currentTrack) {
            this.updateMediaSessionState(
              this.backgroundMusic[newIndex]?.playing() ?? false,
            );
          }
        }
      });

      if (playImmediately) {
        this.backgroundMusic[this.currentTrack]?.stop();
        this.currentTrack = newIndex;
        this.backgroundMusic[this.currentTrack].play();
        this.ensureMediaSessionAnchor();
        this.updateMediaSessionState(true);
      }
    });
  }

  public playBackgroundMusic(): void {
    this.safely("play background music", () => {
      if (this.backgroundMusic.length === 0) {
        // Tracks haven't loaded from the server yet — defer until they arrive.
        this.pendingPlay = true;
        return;
      }
      if (!this.backgroundMusic[this.currentTrack].playing()) {
        this.backgroundMusic[this.currentTrack].play();
        this.ensureMediaSessionAnchor();
        this.updateMediaSessionState(true);
      }
    });
  }

  public stopBackgroundMusic(): void {
    this.safely("stop background music", () => {
      if (this.backgroundMusic.length > 0) {
        this.backgroundMusic[this.currentTrack].stop();
        this.updateMediaSessionState(false);
      }
    });
  }

  public setBackgroundMusicVolume(volume: number): void {
    this.backgroundMusicVolume = Math.max(0, Math.min(1, volume));
    this.safely("set background music volume", () => {
      this.backgroundMusic.forEach((track) => {
        track.volume(this.backgroundMusicVolume);
      });
    });
  }

  private playNext(): void {
    this.currentTrack = (this.currentTrack + 1) % this.backgroundMusic.length;
    this.playBackgroundMusic();
  }

  public toggleMusicPause(): void {
    this.safely("toggle music pause", () => {
      const track = this.backgroundMusic[this.currentTrack];
      if (track.playing()) {
        track.pause();
        this.updateMediaSessionState(false);
      } else {
        this.playBackgroundMusic();
      }
    });
  }

  public skipToNextTrack(): void {
    this.safely("skip to next track", () => {
      this.backgroundMusic[this.currentTrack].stop();
      this.currentTrack =
        (this.currentTrack + 1) % this.backgroundMusic.length;
      this.playBackgroundMusic();
    });
  }

  public skipToPrevTrack(): void {
    this.safely("skip to previous track", () => {
      this.backgroundMusic[this.currentTrack].stop();
      this.currentTrack =
        (this.currentTrack - 1 + this.backgroundMusic.length) %
        this.backgroundMusic.length;
      this.playBackgroundMusic();
    });
  }

  private getOrLoadSoundEffect(name: SoundEffect): Howl | null {
    let sound = this.soundEffects.get(name);
    if (sound) return sound;
    const src = soundEffectUrls.get(name);
    if (!src) return null;
    try {
      sound = new Howl({ src: [src], volume: this.soundEffectsVolume });
      this.soundEffects.set(name, sound);
      return sound;
    } catch (err) {
      console.error(`SoundManager: failed to load sound ${name}`, err);
      return null;
    }
  }

  private removeActiveSoundById(id: number): void {
    this.activeSounds = this.activeSounds.filter((s) => s.id !== id);
  }

  public playSoundEffect(name: SoundEffect): void {
    this.safely(`play sound ${name}`, () => {
      const howl = this.getOrLoadSoundEffect(name);
      if (!howl) return;

      if (this.activeSounds.length >= MAX_CONCURRENT_SOUNDS) {
        const oldest = this.activeSounds[0];
        oldest.howl.stop(oldest.id);
        this.removeActiveSoundById(oldest.id);
      }

      const id = howl.play();
      this.activeSounds.push({ howl, id });
      howl.once("end", () => this.removeActiveSoundById(id), id);
      howl.once("stop", () => this.removeActiveSoundById(id), id);
    });
  }

  public setSoundEffectsVolume(volume: number): void {
    this.soundEffectsVolume = Math.max(0, Math.min(1, volume));
    this.safely("set sound effects volume", () => {
      this.soundEffects.forEach((sound) => {
        sound.volume(this.soundEffectsVolume);
      });
    });
  }

  public stopSoundEffect(name: SoundEffect): void {
    this.safely(`stop sound ${name}`, () => {
      const howl = this.soundEffects.get(name);
      if (howl) {
        howl.stop();
        this.activeSounds = this.activeSounds.filter((s) => s.howl !== howl);
      }
    });
  }
}
