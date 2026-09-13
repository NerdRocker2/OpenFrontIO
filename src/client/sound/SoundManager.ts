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
export const MUSIC_DUCK_DB = -3;

const MUSIC_DUCK_GAIN = 10 ** (MUSIC_DUCK_DB / 20);
const MUSIC_DUCK_ATTACK_SECONDS = 0.015;
const MUSIC_DUCK_RELEASE_SECONDS = 0.12;
const MUSIC_COMPRESSOR_MAKEUP_DB = 1.5;

interface BackgroundTrack {
  url: string;
  title: string;
  artist: string;
  replayGainTrackGainDb?: number;
  replayGainTrackPeak?: number;
}

export class SoundManager {
  private backgroundMusic: BackgroundTrack[] = [];
  private currentTrack = 0;
  private soundEffects: Map<SoundEffect, Howl> = new Map();
  private soundEffectsVolume = 1;
  private backgroundMusicVolume = 0;
  private activeSounds: { howl: Howl; id: number }[] = [];
  private pendingPlay = false;
  private musicPlaybackRequested = false;
  private eventBus: EventBus;
  private onPlaySoundEffect: (e: PlaySoundEffectEvent) => void;
  private onSetBackgroundMusicVolume: (
    e: SetBackgroundMusicVolumeEvent,
  ) => void;
  private onSetSoundEffectsVolume: (e: SetSoundEffectsVolumeEvent) => void;
  private onMusicTogglePause: () => void;
  private onMusicNextTrack: () => void;
  private onMusicPrevTrack: () => void;
  private readonly musicAudio = document.createElement("audio");
  private musicContext: AudioContext | null = null;
  private musicTrackGain: GainNode | null = null;
  private musicDuckGain: GainNode | null = null;
  private musicOutputGain: GainNode | null = null;

  constructor(eventBus: EventBus, userSettings: UserSettings) {
    this.eventBus = eventBus;
    this.initMusicPlayback();
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
      this.addTrack(e.url, e.playImmediately, e.filename),
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
    this.musicAudio.pause();
    this.musicAudio.removeEventListener("ended", this.playNext);
    this.musicAudio.removeEventListener("play", this.onMusicPlay);
    this.musicAudio.removeEventListener("pause", this.onMusicPause);
    this.musicAudio.removeEventListener("error", this.onMusicError);
    this.musicAudio.removeAttribute("src");
    this.musicAudio.load();
    void this.musicContext?.close();
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

  private initMusicPlayback(): void {
    this.musicAudio.preload = "none";
    this.musicAudio.addEventListener("ended", this.playNext);
    this.musicAudio.addEventListener("play", this.onMusicPlay);
    this.musicAudio.addEventListener("pause", this.onMusicPause);
    this.musicAudio.addEventListener("error", this.onMusicError);

    const AudioContextConstructor =
      window.AudioContext ??
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextConstructor) return;

    try {
      const context = new AudioContextConstructor();
      const source = context.createMediaElementSource(this.musicAudio);
      const trackGain = context.createGain();
      const compressor = context.createDynamicsCompressor();
      const makeupGain = context.createGain();
      const limiter = context.createDynamicsCompressor();
      const duckGain = context.createGain();
      const outputGain = context.createGain();

      // ReplayGain establishes track-to-track loudness. This deliberately mild
      // compressor reins in within-track swings, while the final limiter catches
      // amplified true peaks from unusually dynamic tracks.
      compressor.threshold.value = -20;
      compressor.knee.value = 10;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.02;
      compressor.release.value = 0.3;
      makeupGain.gain.value = 10 ** (MUSIC_COMPRESSOR_MAKEUP_DB / 20);

      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.1;

      source
        .connect(trackGain)
        .connect(compressor)
        .connect(makeupGain)
        .connect(limiter)
        .connect(duckGain)
        .connect(outputGain)
        .connect(context.destination);

      this.musicAudio.volume = 1;
      this.musicContext = context;
      this.musicTrackGain = trackGain;
      this.musicDuckGain = duckGain;
      this.musicOutputGain = outputGain;
    } catch (err) {
      console.warn("SoundManager: Web Audio music processing unavailable", err);
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
        console.warn(
          `SoundManager: failed to register handler for "${action}":`,
          e,
        );
      }
    }
    console.log("SoundManager: Media Session setup complete");
  }

  private updateMediaSessionState(playing: boolean): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const meta = this.backgroundMusic[this.currentTrack];
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
        return r.json() as Promise<{
          tracks: { filename: string; url: string }[];
        }>;
      })
      .then(({ tracks }) => {
        for (const track of tracks) {
          this.addTrack(track.url, false, track.filename);
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

  public addTrack(
    url: string,
    playImmediately: boolean,
    filename?: string,
  ): void {
    this.safely("add track", () => {
      const fallback = metadataFromFilename(filename ?? url);
      const newIndex = this.backgroundMusic.length;
      this.backgroundMusic.push({ url, ...fallback });

      fetchId3Metadata(url, { includeDuration: false }).then((id3) => {
        const track = this.backgroundMusic[newIndex];
        if (!track) return;
        track.title = id3.title ?? fallback.title;
        track.artist = id3.artist ?? fallback.artist;
        track.replayGainTrackGainDb = id3.replayGainTrackGainDb;
        track.replayGainTrackPeak = id3.replayGainTrackPeak;
        if (newIndex === this.currentTrack) {
          this.applyCurrentTrackGain();
          this.updateMediaSessionState(!this.musicAudio.paused);
        }
      });

      if (playImmediately) {
        this.musicAudio.pause();
        this.currentTrack = newIndex;
        this.prepareCurrentTrack();
        this.playBackgroundMusic();
      }
    });
  }

  private prepareCurrentTrack(): void {
    const track = this.backgroundMusic[this.currentTrack];
    if (!track) return;
    if (this.musicAudio.getAttribute("src") !== track.url) {
      this.musicAudio.src = track.url;
      this.musicAudio.load();
    }
    this.applyCurrentTrackGain();
  }

  private applyCurrentTrackGain(): void {
    const gainDb =
      this.backgroundMusic[this.currentTrack]?.replayGainTrackGainDb ?? 0;
    const gain = 10 ** (gainDb / 20);
    if (this.musicTrackGain && this.musicContext) {
      this.musicTrackGain.gain.setValueAtTime(
        gain,
        this.musicContext.currentTime,
      );
    } else {
      this.updateFallbackMusicVolume();
    }
  }

  public playBackgroundMusic(): void {
    this.musicPlaybackRequested = true;
    this.safely("play background music", () => {
      if (this.backgroundMusic.length === 0) {
        this.pendingPlay = true;
        return;
      }
      this.prepareCurrentTrack();
      if (this.musicAudio.paused) {
        void this.musicContext?.resume().catch((err) => {
          console.warn("SoundManager: music AudioContext resume failed", err);
        });
        const playResult = this.musicAudio.play();
        void playResult?.catch((err) => {
          console.error("SoundManager: failed to play background music", err);
          this.updateMediaSessionState(false);
        });
      }
    });
  }

  public stopBackgroundMusic(): void {
    this.musicPlaybackRequested = false;
    this.safely("stop background music", () => {
      if (this.backgroundMusic.length > 0) {
        this.musicAudio.pause();
        try {
          this.musicAudio.currentTime = 0;
        } catch {
          // Metadata may not have loaded yet.
        }
        this.updateMediaSessionState(false);
      }
    });
  }

  // Slider positions are linear (0–1) but perceived loudness is roughly
  // logarithmic, so use an audio-taper curve.
  private perceptualGain(position: number): number {
    const clamped = Math.max(0, Math.min(1, position));
    return clamped * clamped;
  }

  public setBackgroundMusicVolume(volume: number): void {
    this.backgroundMusicVolume = this.perceptualGain(volume);
    this.safely("set background music volume", () => {
      if (this.musicOutputGain && this.musicContext) {
        this.musicOutputGain.gain.setValueAtTime(
          this.backgroundMusicVolume,
          this.musicContext.currentTime,
        );
      } else {
        this.updateFallbackMusicVolume();
      }
      if (this.backgroundMusicVolume > 0) {
        void this.musicContext?.resume().then(() => {
          if (this.musicPlaybackRequested && this.musicAudio.paused) {
            this.playBackgroundMusic();
          }
        });
      }
    });
  }

  private playNext = (): void => {
    if (this.backgroundMusic.length === 0) return;
    this.currentTrack = (this.currentTrack + 1) % this.backgroundMusic.length;
    this.prepareCurrentTrack();
    this.playBackgroundMusic();
  };

  private onMusicPlay = (): void => this.updateMediaSessionState(true);
  private onMusicPause = (): void => this.updateMediaSessionState(false);
  private onMusicError = (): void => {
    console.error(
      `SoundManager: failed to load music track ${this.backgroundMusic[this.currentTrack]?.url ?? "unknown"}`,
    );
  };

  public toggleMusicPause(): void {
    this.safely("toggle music pause", () => {
      if (!this.musicAudio.paused) {
        this.musicPlaybackRequested = false;
        this.musicAudio.pause();
        this.updateMediaSessionState(false);
      } else {
        this.playBackgroundMusic();
      }
    });
  }

  public skipToNextTrack(): void {
    this.safely("skip to next track", () => {
      if (this.backgroundMusic.length === 0) return;
      this.musicAudio.pause();
      this.currentTrack = (this.currentTrack + 1) % this.backgroundMusic.length;
      this.prepareCurrentTrack();
      this.playBackgroundMusic();
    });
  }

  public skipToPrevTrack(): void {
    this.safely("skip to previous track", () => {
      if (this.backgroundMusic.length === 0) return;
      this.musicAudio.pause();
      this.currentTrack =
        (this.currentTrack - 1 + this.backgroundMusic.length) %
        this.backgroundMusic.length;
      this.prepareCurrentTrack();
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
    this.activeSounds = this.activeSounds.filter((sound) => sound.id !== id);
    this.updateMusicDucking();
  }

  private updateMusicDucking(): void {
    const shouldDuck =
      this.activeSounds.length > 0 && this.soundEffectsVolume > 0;
    const target = shouldDuck ? MUSIC_DUCK_GAIN : 1;
    if (this.musicDuckGain && this.musicContext) {
      const now = this.musicContext.currentTime;
      this.musicDuckGain.gain.cancelScheduledValues(now);
      this.musicDuckGain.gain.setTargetAtTime(
        target,
        now,
        shouldDuck ? MUSIC_DUCK_ATTACK_SECONDS : MUSIC_DUCK_RELEASE_SECONDS,
      );
    } else {
      this.updateFallbackMusicVolume();
    }
  }

  private updateFallbackMusicVolume(): void {
    const trackGainDb =
      this.backgroundMusic[this.currentTrack]?.replayGainTrackGainDb ?? 0;
    const trackGain = 10 ** (trackGainDb / 20);
    const duckGain =
      this.activeSounds.length > 0 && this.soundEffectsVolume > 0
        ? MUSIC_DUCK_GAIN
        : 1;
    this.musicAudio.volume = Math.min(
      1,
      this.backgroundMusicVolume * trackGain * duckGain,
    );
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
      this.updateMusicDucking();
      howl.once("end", () => this.removeActiveSoundById(id), id);
      howl.once("stop", () => this.removeActiveSoundById(id), id);
      howl.once("playerror", () => this.removeActiveSoundById(id), id);
    });
  }

  public setSoundEffectsVolume(volume: number): void {
    this.soundEffectsVolume = this.perceptualGain(volume);
    this.safely("set sound effects volume", () => {
      this.soundEffects.forEach((sound) => {
        sound.volume(this.soundEffectsVolume);
      });
      this.updateMusicDucking();
    });
  }

  public stopSoundEffect(name: SoundEffect): void {
    this.safely(`stop sound ${name}`, () => {
      const howl = this.soundEffects.get(name);
      if (howl) {
        howl.stop();
        this.activeSounds = this.activeSounds.filter(
          (sound) => sound.howl !== howl,
        );
        this.updateMusicDucking();
      }
    });
  }
}
