import { EventBus } from "@openfront/shared/EventBus";
import {
  deleteMusicTrack,
  fetchMusicTracks,
  MUSIC_LIBRARY_CHANGED_EVENT,
} from "../MusicApi";
import { translateText } from "../Utils";
import { AudioMixer } from "./AudioMixer";
import { fetchId3Metadata, metadataFromFilename } from "./Id3Reader";
import {
  AddMusicTrackEvent,
  MusicNextTrackEvent,
  MusicPrevTrackEvent,
  MusicTogglePauseEvent,
} from "./Sounds";

export const MUSIC_DUCK_DB = -3;

const MUSIC_DUCK_GAIN = 10 ** (MUSIC_DUCK_DB / 20);
const MUSIC_DUCK_ATTACK_SECONDS = 0.015;
const MUSIC_DUCK_RELEASE_SECONDS = 0.12;
const MUSIC_COMPRESSOR_MAKEUP_DB = 1.5;

interface BackgroundTrack {
  url: string;
  filename: string;
  deletable: boolean;
  title: string;
  artist: string;
  replayGainTrackGainDb?: number;
  replayGainTrackPeak?: number;
}

export class MusicLibraryPlayer {
  private backgroundMusic: BackgroundTrack[] = [];
  private currentTrack = 0;
  private backgroundMusicVolume = 0;
  private playInFlight = false;
  private playAttempt = 0;
  private musicPlaybackRequested = false;
  private deletingTrack = false;
  private disposed = false;
  private eventBus: EventBus;
  private stopFollowingMixer: () => void;
  private onAddTrack: (e: AddMusicTrackEvent) => void;
  private onMusicTogglePause: () => void;
  private onMusicNextTrack: () => void;
  private onMusicPrevTrack: () => void;
  private readonly musicAudio = document.createElement("audio");
  private musicContext: AudioContext | null = null;
  private musicTrackGain: GainNode | null = null;
  private musicDuckGain: GainNode | null = null;
  private musicOutputGain: GainNode | null = null;

  constructor(
    eventBus: EventBus,
    private readonly mixer: AudioMixer,
    private readonly enableDeleteShortcut = false,
  ) {
    this.eventBus = eventBus;
    this.initMusicPlayback();
    this.followMixer();
    this.stopFollowingMixer = mixer.onChange(() => this.followMixer());
    this.onMusicTogglePause = () => this.toggleMusicPause();
    this.onMusicNextTrack = () => this.skipToNextTrack();
    this.onMusicPrevTrack = () => this.skipToPrevTrack();
    eventBus.on(MusicTogglePauseEvent, this.onMusicTogglePause);
    eventBus.on(MusicNextTrackEvent, this.onMusicNextTrack);
    eventBus.on(MusicPrevTrackEvent, this.onMusicPrevTrack);
    this.onAddTrack = (e) =>
      this.addTrack(e.url, e.playImmediately, e.filename, true);
    eventBus.on(AddMusicTrackEvent, this.onAddTrack);
    if (this.enableDeleteShortcut) {
      window.addEventListener("keydown", this.onDeleteShortcut);
    }
    this.initMediaSession();
    window.addEventListener("pointerdown", this.retryRequestedPlayback);
    this.loadTracksFromServer();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.musicPlaybackRequested = false;
    this.playAttempt++;
    window.removeEventListener("pointerdown", this.retryRequestedPlayback);
    if ("mediaSession" in navigator) {
      for (const action of [
        "play",
        "pause",
        "nexttrack",
        "previoustrack",
      ] as const) {
        this.safely("clear media handler", () =>
          navigator.mediaSession.setActionHandler(action, null),
        );
      }
      navigator.mediaSession.playbackState = "none";
    }
    window.removeEventListener("keydown", this.onDeleteShortcut);
    this.stopFollowingMixer();
    this.eventBus.off(AddMusicTrackEvent, this.onAddTrack);
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
    this.backgroundMusic = [];
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
      ["play", () => this.resumeMusic()],
      ["pause", () => this.pauseMusic()],
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
    fetchMusicTracks()
      .then((tracks) => {
        if (this.disposed) return;
        for (const track of tracks) {
          this.addTrack(
            track.url,
            false,
            track.filename,
            track.source === "upload" && track.deletable,
          );
        }
        if (this.musicPlaybackRequested && this.backgroundMusic.length > 0) {
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
    deletable = false,
  ): void {
    this.safely("add track", () => {
      const fallback = metadataFromFilename(filename ?? url);
      const newIndex = this.backgroundMusic.length;
      const track: BackgroundTrack = {
        url,
        filename: filename ?? url,
        deletable,
        ...fallback,
      };
      this.backgroundMusic.push(track);

      void fetchId3Metadata(url, { includeDuration: false }).then((id3) => {
        if (!this.backgroundMusic.includes(track)) return;
        track.title = id3.title ?? fallback.title;
        track.artist = id3.artist ?? fallback.artist;
        track.replayGainTrackGainDb = id3.replayGainTrackGainDb;
        track.replayGainTrackPeak = id3.replayGainTrackPeak;
        if (this.backgroundMusic[this.currentTrack] === track) {
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
      this.playAttempt++;
      this.playInFlight = false;
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
    if (this.disposed) return;
    this.musicPlaybackRequested = true;
    if (this.backgroundMusicVolume === 0) return;
    this.safely("play background music", () => {
      if (this.backgroundMusic.length === 0) {
        return;
      }
      this.prepareCurrentTrack();
      // A playing media element can still be silent behind a suspended graph.
      if (this.musicContext?.state !== "running") {
        void this.musicContext?.resume().catch((err) => {
          console.warn("SoundManager: music AudioContext resume failed", err);
        });
      }
      if (this.musicAudio.paused && !this.playInFlight) {
        const attempt = ++this.playAttempt;
        this.playInFlight = true;
        const playResult = this.musicAudio.play();
        void Promise.resolve(playResult)
          .catch((err) => {
            if (attempt !== this.playAttempt || this.disposed) return;
            console.error("SoundManager: failed to play background music", err);
            this.updateMediaSessionState(false);
          })
          .finally(() => {
            if (attempt === this.playAttempt) this.playInFlight = false;
          });
      }
    });
  }

  public stopBackgroundMusic(): void {
    this.pauseMusic();
    this.safely("stop background music", () => {
      if (this.backgroundMusic.length > 0) {
        try {
          this.musicAudio.currentTime = 0;
        } catch {
          // Metadata may not have loaded yet.
        }
        this.updateMediaSessionState(false);
      }
    });
  }

  private followMixer(): void {
    const wasSilent = this.backgroundMusicVolume === 0;
    this.backgroundMusicVolume = this.mixer.musicOutputVolume();
    if (this.musicOutputGain && this.musicContext) {
      this.musicOutputGain.gain.setValueAtTime(
        this.backgroundMusicVolume,
        this.musicContext.currentTime,
      );
    }
    this.updateMusicDucking();
    if (
      this.musicPlaybackRequested &&
      wasSilent &&
      this.backgroundMusicVolume > 0
    ) {
      this.playBackgroundMusic();
    }
  }

  private playNext = (): void => {
    if (
      !this.musicPlaybackRequested ||
      this.disposed ||
      this.backgroundMusic.length === 0
    )
      return;
    this.currentTrack = (this.currentTrack + 1) % this.backgroundMusic.length;
    this.prepareCurrentTrack();
    this.playBackgroundMusic();
  };

  private onDeleteShortcut = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (
      !event.ctrlKey ||
      event.code !== "Delete" ||
      event.repeat ||
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.isContentEditable
    ) {
      return;
    }
    event.preventDefault();
    void this.deleteCurrentTrack();
  };

  private showDeleteMessage(key: string, color: "green" | "red"): void {
    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: { message: translateText(key), color, duration: 3000 },
      }),
    );
  }

  private async deleteCurrentTrack(): Promise<void> {
    if (this.deletingTrack) return;
    const track = this.backgroundMusic[this.currentTrack];
    if (!track) return;
    if (!track.deletable) {
      this.showDeleteMessage("music_page.delete_bundled_error", "red");
      return;
    }

    this.deletingTrack = true;
    const keepPlaying = this.musicPlaybackRequested;
    this.musicAudio.pause();
    this.musicAudio.removeAttribute("src");
    this.musicAudio.load();
    // Release the streaming file handle before deletion, especially on Windows.
    await new Promise((resolve) => setTimeout(resolve, 75));
    if (this.disposed) {
      this.deletingTrack = false;
      return;
    }

    try {
      await deleteMusicTrack(track.filename);
      if (this.disposed) return;
      const index = this.backgroundMusic.indexOf(track);
      if (index === -1) return;
      this.backgroundMusic.splice(index, 1);
      window.dispatchEvent(new Event(MUSIC_LIBRARY_CHANGED_EVENT));
      if (this.backgroundMusic.length > 0) {
        this.currentTrack = Math.min(index, this.backgroundMusic.length - 1);
        this.prepareCurrentTrack();
        if (keepPlaying) this.playBackgroundMusic();
      } else {
        this.currentTrack = 0;
        this.musicPlaybackRequested = false;
        this.updateMediaSessionState(false);
      }
      this.showDeleteMessage("music_page.delete_done", "green");
    } catch (err) {
      if (this.disposed) return;
      console.error("SoundManager: failed to delete music track", err);
      this.prepareCurrentTrack();
      if (keepPlaying) this.playBackgroundMusic();
      this.showDeleteMessage("music_page.delete_error", "red");
    } finally {
      this.deletingTrack = false;
    }
  }

  private onMusicPlay = (): void => this.updateMediaSessionState(true);
  private onMusicPause = (): void => this.updateMediaSessionState(false);
  private onMusicError = (): void => {
    console.error(
      `SoundManager: failed to load music track ${this.backgroundMusic[this.currentTrack]?.url ?? "unknown"}`,
    );
  };

  public toggleMusicPause(): void {
    this.safely("toggle music pause", () => {
      if (
        (!this.musicAudio.paused || this.playInFlight) &&
        this.backgroundMusicVolume > 0 &&
        (!this.musicContext || this.musicContext.state === "running")
      ) {
        this.pauseMusic();
      } else {
        this.resumeMusic();
      }
    });
  }

  public skipToNextTrack(): void {
    this.safely("skip to next track", () => {
      if (this.deletingTrack || this.backgroundMusic.length === 0) return;
      this.musicAudio.pause();
      this.currentTrack = (this.currentTrack + 1) % this.backgroundMusic.length;
      this.prepareCurrentTrack();
      this.playBackgroundMusic();
    });
  }

  private resumeMusic(): void {
    if (this.disposed) return;
    // Volume changes notify followMixer synchronously. Start only once, after
    // both channels are enabled and still inside the user's gesture.
    this.musicPlaybackRequested = false;
    this.mixer.enableMusic();
    this.playBackgroundMusic();
  }

  private pauseMusic(): void {
    this.musicPlaybackRequested = false;
    this.playAttempt++;
    this.playInFlight = false;
    this.musicAudio.pause();
    this.updateMediaSessionState(false);
  }

  private retryRequestedPlayback = (): void => {
    if (this.musicPlaybackRequested && !this.deletingTrack) {
      this.playBackgroundMusic();
    }
  };

  public skipToPrevTrack(): void {
    this.safely("skip to previous track", () => {
      if (this.deletingTrack || this.backgroundMusic.length === 0) return;
      this.musicAudio.pause();
      this.currentTrack =
        (this.currentTrack - 1 + this.backgroundMusic.length) %
        this.backgroundMusic.length;
      this.prepareCurrentTrack();
      this.playBackgroundMusic();
    });
  }

  private updateMusicDucking(): void {
    const shouldDuck = this.mixer.hasAudibleCues();
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
    const duckGain = this.mixer.hasAudibleCues() ? MUSIC_DUCK_GAIN : 1;
    this.musicAudio.volume = Math.min(
      1,
      this.backgroundMusicVolume * trackGain * duckGain,
    );
  }
}
