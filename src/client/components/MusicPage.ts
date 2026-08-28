import { html, LitElement, nothing } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { assetUrl } from "../../core/AssetUrls";
import {
  deleteMusicTrack,
  fetchMusicTracks,
  MAX_MUSIC_UPLOAD_BYTES,
  MusicTrack,
  MusicUploadError,
  normalizeMusicUploadFilename,
  uploadMusicTrack,
} from "../MusicApi";
import { fetchId3Metadata, metadataFromFilename } from "../sound/Id3Reader";
import { translateText } from "../Utils";
import { modalHeader } from "./ui/ModalHeader";

type PlaybackState = "stopped" | "loading" | "playing" | "paused" | "error";
type SortColumn = "artist" | "year" | "title";
type SortDirection = "asc" | "desc";

interface LibraryTrack extends MusicTrack {
  title: string;
  artist: string;
  year: string;
  duration?: number;
  id3Year?: number;
  artworkUrl?: string;
  localPlaybackUrl?: string;
}

const musicFallbackArt = assetUrl("images/music.svg");

@customElement("music-page")
export class MusicPage extends LitElement {
  @state() private tracks: LibraryTrack[] = [];
  @state() private currentUrl: string | null = null;
  @state() private playbackState: PlaybackState = "stopped";
  @state() private elapsed = 0;
  @state() private duration = 0;
  @state() private loading = false;
  @state() private uploadStatus: "idle" | "uploading" | "done" | "error" =
    "idle";
  @state() private uploadErrorMessage = "";
  @state() private statusMessage = "";
  @state() private sortColumn: SortColumn | null = null;
  @state() private sortDirection: SortDirection = "asc";
  @state() private allowDelete = false;
  @state() private enrichingCount = 0;

  @query("#music-page-upload")
  private uploadInput!: HTMLInputElement;

  @query("#music-playlist-scroll")
  private playlistScroll!: HTMLElement;

  private readonly audio = document.createElement("audio");
  private loaded = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.audio.preload = "metadata";
    this.audio.addEventListener("playing", this.onPlaying);
    this.audio.addEventListener("pause", this.onPause);
    this.audio.addEventListener("waiting", this.onWaiting);
    this.audio.addEventListener("timeupdate", this.onTimeUpdate);
    this.audio.addEventListener("loadedmetadata", this.onLoadedMetadata);
    this.audio.addEventListener("ended", this.onEnded);
    this.audio.addEventListener("error", this.onAudioError);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("showPage", this.onShowPage);
    this.refreshDeleteVisibility();
    if (window.location.pathname === "/music") void this.loadTracks();
  }

  disconnectedCallback() {
    this.stopAndReset();
    this.clearMediaSessionHandlers();
    this.audio.removeEventListener("playing", this.onPlaying);
    this.audio.removeEventListener("pause", this.onPause);
    this.audio.removeEventListener("waiting", this.onWaiting);
    this.audio.removeEventListener("timeupdate", this.onTimeUpdate);
    this.audio.removeEventListener("loadedmetadata", this.onLoadedMetadata);
    this.audio.removeEventListener("ended", this.onEnded);
    this.audio.removeEventListener("error", this.onAudioError);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("showPage", this.onShowPage);
    this.revokeTrackUrls(this.tracks);
    super.disconnectedCallback();
  }

  private onShowPage = (event: Event) => {
    const isMusicPage = (event as CustomEvent<string>).detail === "page-music";
    if (isMusicPage) {
      this.refreshDeleteVisibility();
      this.initMediaSessionHandlers();
      void this.loadTracks();
    } else {
      this.stopAndReset();
      this.clearMediaSessionHandlers();
    }
  };

  private refreshDeleteVisibility() {
    this.allowDelete =
      new URLSearchParams(window.location.search).get("allowdelete") === "true";
  }

  private async loadTracks(): Promise<void> {
    if (this.loaded || this.loading) return;
    this.loading = true;
    this.statusMessage = "";
    try {
      const tracks = await fetchMusicTracks();
      this.tracks = tracks.map((track) => this.withFallbackMetadata(track));
      this.currentUrl ??= this.tracks[0]?.url ?? null;
      this.setAudioSourceForCurrentTrack();
      this.loaded = true;
      this.enrichingCount += this.tracks.length;
      void Promise.all(this.tracks.map((track) => this.enrichTrack(track)));
    } catch (err) {
      console.error("MusicPage: failed to load tracks", err);
      this.statusMessage = translateText("music_page.load_error");
    } finally {
      this.loading = false;
    }
  }

  private withFallbackMetadata(track: MusicTrack): LibraryTrack {
    const fallback = metadataFromFilename(track.filename);
    return {
      ...track,
      title: fallback.title,
      artist: fallback.artist,
      year: fallback.year,
    };
  }

  private async enrichTrack(track: LibraryTrack): Promise<void> {
    try {
      const metadata = await fetchId3Metadata(
        track.localPlaybackUrl ?? track.url,
        { includeArtwork: true },
      );
      const artworkUrl = metadata.artwork
        ? URL.createObjectURL(
            new Blob([Uint8Array.from(metadata.artwork.data).buffer], {
              type: metadata.artwork.mimeType,
            }),
          )
        : undefined;
      const index = this.tracks.findIndex(
        (candidate) => candidate.url === track.url,
      );
      if (index === -1) {
        if (artworkUrl) URL.revokeObjectURL(artworkUrl);
        return;
      }
      const previous = this.tracks[index];
      if (previous.artworkUrl) URL.revokeObjectURL(previous.artworkUrl);
      const updated: LibraryTrack = {
        ...previous,
        title: this.nonEmptyMetadata(metadata.title, previous.title),
        artist: this.nonEmptyMetadata(metadata.artist, previous.artist),
        year: this.nonEmptyMetadata(metadata.year, previous.year),
        duration: this.validDuration(metadata.duration),
        id3Year: this.validId3Year(metadata.year),
        artworkUrl,
      };
      this.tracks = this.tracks.map((candidate, candidateIndex) =>
        candidateIndex === index ? updated : candidate,
      );
      if (updated.url === this.currentUrl) this.updateMediaSessionState();
    } finally {
      this.enrichingCount = Math.max(0, this.enrichingCount - 1);
    }
  }

  private setAudioSourceForCurrentTrack() {
    const track = this.currentTrack;
    if (!track) {
      this.audio.removeAttribute("src");
      this.audio.load();
      return;
    }
    const playbackUrl = track.localPlaybackUrl ?? track.url;
    if (this.audio.getAttribute("src") !== playbackUrl) {
      this.audio.src = playbackUrl;
      this.audio.load();
    }
    this.updateMediaSessionState();
  }

  private get currentTrack(): LibraryTrack | undefined {
    return this.tracks.find((track) => track.url === this.currentUrl);
  }

  private get orderedTracks(): LibraryTrack[] {
    if (!this.sortColumn) return this.tracks;
    const column = this.sortColumn;
    const direction = this.sortDirection === "asc" ? 1 : -1;
    return this.tracks
      .map((track, index) => ({ track, index }))
      .sort((a, b) => {
        const left = a.track[column].trim();
        const right = b.track[column].trim();
        if (!left && right) return 1;
        if (left && !right) return -1;
        const compared = left.localeCompare(right, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        return compared === 0 ? a.index - b.index : compared * direction;
      })
      .map(({ track }) => track);
  }

  private setSort(column: SortColumn) {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
    } else {
      this.sortColumn = column;
      this.sortDirection = "asc";
    }
  }

  private async selectTrack(track: LibraryTrack, play: boolean) {
    const changed = this.currentUrl !== track.url;
    if (changed) {
      this.audio.pause();
      this.currentUrl = track.url;
      this.elapsed = 0;
      this.duration = 0;
      this.playbackState = "stopped";
      this.setAudioSourceForCurrentTrack();
    }
    if (play) await this.playCurrent();
  }

  private async playCurrent() {
    if (!this.currentTrack) return;
    this.playbackState = "loading";
    try {
      await this.audio.play();
    } catch (err) {
      console.error("MusicPage: playback failed", err);
      this.playbackState = "error";
      this.statusMessage = translateText("music_page.play_error");
    }
  }

  private togglePlayPause = () => {
    if (this.audio.paused) void this.playCurrent();
    else this.audio.pause();
  };

  private skip(direction: -1 | 1) {
    const ordered = this.orderedTracks;
    if (ordered.length === 0) return;
    const currentIndex = ordered.findIndex(
      (track) => track.url === this.currentUrl,
    );
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + direction + ordered.length) % ordered.length;
    void this.selectTrack(ordered[nextIndex], true);
  }

  private stopAndReset() {
    this.audio.pause();
    try {
      this.audio.currentTime = 0;
    } catch {
      // Some browsers reject currentTime changes before metadata is available.
    }
    this.elapsed = 0;
    this.playbackState = "stopped";
    this.updateMediaSessionState();
  }

  private onPlaying = () => {
    this.playbackState = "playing";
    this.statusMessage = "";
    this.updateMediaSessionState();
  };

  private onPause = () => {
    if (this.playbackState !== "stopped") this.playbackState = "paused";
    this.updateMediaSessionState();
  };

  private onWaiting = () => {
    this.playbackState = "loading";
  };

  private onTimeUpdate = () => {
    this.elapsed = Number.isFinite(this.audio.currentTime)
      ? this.audio.currentTime
      : 0;
  };

  private onLoadedMetadata = () => {
    this.duration = Number.isFinite(this.audio.duration)
      ? this.audio.duration
      : 0;
  };

  private onEnded = () => this.skip(1);

  private onAudioError = () => {
    this.playbackState = "error";
    this.statusMessage = translateText("music_page.play_error");
    this.updateMediaSessionState();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (
      window.currentPageId !== "page-music" ||
      this.isTextEntry(event.target)
    ) {
      return;
    }
    if (event.ctrlKey && event.code === "Delete") {
      event.preventDefault();
      void this.deleteCurrentTrack();
      return;
    }
    if (event.repeat) return;
    if (event.code === "Backslash") {
      event.preventDefault();
      this.togglePlayPause();
    } else if (event.code === "BracketLeft") {
      event.preventDefault();
      this.skip(-1);
    } else if (event.code === "BracketRight") {
      event.preventDefault();
      this.skip(1);
    }
  };

  private isTextEntry(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    return (
      element?.tagName === "INPUT" ||
      element?.tagName === "TEXTAREA" ||
      element?.isContentEditable === true
    );
  }

  private openUploadPicker = (event: Event) => {
    // A file picker can keep the originating click alive until the chooser is
    // dismissed on mobile browsers. Prevent any surrounding form/default
    // action from turning that click into a navigation after selection.
    event.preventDefault();
    event.stopPropagation();
    if (this.uploadStatus !== "uploading") this.uploadInput.click();
  };

  private showMobileUploadToast(message: string, color: "green" | "red") {
    if (!window.matchMedia("(max-width: 639px)").matches) return;
    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: {
          message,
          color,
          duration: color === "green" ? 3000 : 4000,
        },
      }),
    );
  }

  private renderMobileUploadButton() {
    return html`<button
      type="button"
      data-music-upload-position="mobile"
      class="size-11 inline-flex items-center justify-center rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-wait transition-colors"
      ?disabled=${this.uploadStatus === "uploading"}
      title=${this.uploadStatus === "uploading"
        ? translateText("music_page.uploading")
        : translateText("music_page.upload_button")}
      aria-label=${translateText("music_page.upload_button")}
      aria-busy=${this.uploadStatus === "uploading" ? "true" : "false"}
      @click=${this.openUploadPicker}
    >
      <svg
        class="size-6 ${this.uploadStatus === "uploading"
          ? "animate-pulse"
          : ""}"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16"></path>
      </svg>
    </button>`;
  }

  private async onUploadSelected(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    if (file.size > MAX_MUSIC_UPLOAD_BYTES) {
      this.showUploadError(translateText("music_page.upload_too_large"));
      return;
    }
    const normalizedFilename = normalizeMusicUploadFilename(file.name);
    if (
      this.tracks.some(
        (track) =>
          track.filename.localeCompare(normalizedFilename, undefined, {
            sensitivity: "accent",
          }) === 0,
      )
    ) {
      this.showUploadError(
        translateText("music_page.upload_duplicate", {
          filename: normalizedFilename,
        }),
      );
      return;
    }

    this.uploadStatus = "uploading";
    this.uploadErrorMessage = "";
    this.statusMessage = "";
    const previousUrl = this.currentUrl;
    const localPlaybackUrl = URL.createObjectURL(file);
    const provisional = this.withFallbackMetadata({
      filename: file.name,
      url: localPlaybackUrl,
      source: "upload",
      deletable: false,
    });
    provisional.localPlaybackUrl = localPlaybackUrl;
    this.tracks = [provisional, ...this.tracks];
    this.currentUrl = provisional.url;
    this.elapsed = 0;
    this.duration = 0;
    this.playbackState = "stopped";
    this.setAudioSourceForCurrentTrack();
    // Start playback while the file-picker gesture is still active. Waiting
    // for the network upload first can make browsers reject play() as autoplay.
    void this.playCurrent();

    try {
      const uploaded = await uploadMusicTrack(file);
      const replaced = this.tracks.filter(
        (track) =>
          track !== provisional &&
          track.source === "upload" &&
          track.filename === uploaded.filename,
      );
      this.revokeTrackUrls(replaced);
      const existing = this.tracks.filter(
        (track) =>
          track !== provisional &&
          !(track.source === "upload" && track.filename === uploaded.filename),
      );
      const track = this.withFallbackMetadata(uploaded);
      track.localPlaybackUrl = localPlaybackUrl;
      this.tracks = [track, ...existing];
      this.currentUrl = track.url;
      this.loaded = true;
      this.updateMediaSessionState();
      this.uploadStatus = "done";
      this.showMobileUploadToast(
        translateText("music_page.upload_done"),
        "green",
      );
      await this.updateComplete;
      this.scrollTrackToTop(track.url);
      this.enrichingCount += 1;
      await this.enrichTrack(track);
      await this.updateComplete;
      this.scrollTrackToTop(track.url);
    } catch (err) {
      console.error("MusicPage: upload failed", err);
      this.audio.pause();
      this.tracks = this.tracks.filter((track) => track !== provisional);
      URL.revokeObjectURL(localPlaybackUrl);
      this.currentUrl = previousUrl;
      this.elapsed = 0;
      this.duration = 0;
      this.playbackState = "stopped";
      this.setAudioSourceForCurrentTrack();
      const message =
        err instanceof MusicUploadError && err.code === "duplicate_file"
          ? translateText("music_page.upload_duplicate", {
              filename: file.name,
            })
          : err instanceof MusicUploadError && err.code === "file_too_large"
            ? translateText("music_page.upload_too_large")
            : translateText("music_page.upload_error");
      this.showUploadError(message);
    }
  }

  private showUploadError(message: string) {
    this.uploadStatus = "error";
    this.uploadErrorMessage = message;
    this.showMobileUploadToast(message, "red");
  }

  private scrollTrackToTop(url: string) {
    const row = Array.from(
      this.querySelectorAll<HTMLElement>("[data-music-track-url]"),
    ).find((candidate) => candidate.dataset.musicTrackUrl === url);
    if (!row || !this.playlistScroll) return;
    const rowRect = row.getBoundingClientRect();
    const containerRect = this.playlistScroll.getBoundingClientRect();
    this.playlistScroll.scrollTop += rowRect.top - containerRect.top - 42;
  }

  private async deleteCurrentTrack() {
    const track = this.currentTrack;
    if (!track) return;
    if (!track.deletable || track.source !== "upload") {
      this.statusMessage = translateText("music_page.delete_bundled_error");
      return;
    }

    const ordered = this.orderedTracks;
    const currentIndex = ordered.findIndex(
      (candidate) => candidate.url === track.url,
    );
    const remainingOrdered = ordered.filter(
      (candidate) => candidate.url !== track.url,
    );
    const nextTrack =
      remainingOrdered.length > 0
        ? remainingOrdered[Math.min(currentIndex, remainingOrdered.length - 1)]
        : undefined;
    const keepPlaying =
      this.playbackState === "playing" || this.playbackState === "loading";

    // Release the browser's streaming request before asking the server to
    // unlink the file. This matters on Windows, where an active MP3 stream can
    // keep the file handle locked and make unlink fail with EPERM/EBUSY.
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.playbackState = "stopped";
    await new Promise((resolve) => setTimeout(resolve, 75));

    try {
      await deleteMusicTrack(track.filename);
      this.revokeTrackUrls([track]);
      this.tracks = this.tracks.filter(
        (candidate) => candidate.url !== track.url,
      );
      this.currentUrl = nextTrack?.url ?? null;
      this.elapsed = 0;
      this.duration = 0;
      this.playbackState = "stopped";
      this.setAudioSourceForCurrentTrack();
      this.statusMessage = translateText("music_page.delete_done");
      if (nextTrack && keepPlaying) await this.playCurrent();
    } catch (err) {
      console.error("MusicPage: delete failed", err);
      this.statusMessage = translateText("music_page.delete_error");
      this.setAudioSourceForCurrentTrack();
      if (keepPlaying) await this.playCurrent();
    }
  }

  private initMediaSessionHandlers() {
    if (!("mediaSession" in navigator)) return;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => void this.playCurrent()],
      ["pause", () => this.audio.pause()],
      ["nexttrack", () => this.skip(1)],
      ["previoustrack", () => this.skip(-1)],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Browser exposes Media Session but not this particular action.
      }
    }
    this.updateMediaSessionState();
  }

  private clearMediaSessionHandlers() {
    if (!("mediaSession" in navigator)) return;
    for (const action of [
      "play",
      "pause",
      "nexttrack",
      "previoustrack",
    ] as MediaSessionAction[]) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        // Browser exposes Media Session but not this particular action.
      }
    }
    navigator.mediaSession.playbackState = "none";
  }

  private updateMediaSessionState() {
    if (!("mediaSession" in navigator)) return;
    const track = this.currentTrack;
    if (track && typeof MediaMetadata !== "undefined") {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: "OpenFront.io",
        artwork: [{ src: track.artworkUrl ?? musicFallbackArt }],
      });
    }
    navigator.mediaSession.playbackState =
      this.playbackState === "playing" ? "playing" : "paused";
  }

  private revokeTrackUrls(tracks: LibraryTrack[]) {
    for (const track of tracks) {
      if (track.artworkUrl) URL.revokeObjectURL(track.artworkUrl);
      if (track.localPlaybackUrl) {
        URL.revokeObjectURL(track.localPlaybackUrl);
      }
    }
  }

  private formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${remainder.toString().padStart(2, "0")}`;
  }

  private formatTotalTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainder = totalSeconds % 60;
    if (hours === 0) {
      return `${minutes}:${remainder.toString().padStart(2, "0")}`;
    }
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainder
      .toString()
      .padStart(2, "0")}`;
  }

  private validDuration(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  }

  private validId3Year(value: string | undefined): number | undefined {
    const normalized = value?.trim();
    if (!normalized || !/^\d{1,4}$/.test(normalized)) return undefined;
    const year = Number(normalized);
    const currentYear = new Date().getFullYear();
    return Number.isInteger(year) && year > 0 && year <= currentYear
      ? year
      : undefined;
  }

  private get totalDuration(): number {
    return this.tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);
  }

  private get songAgeRange(): string {
    const years = this.tracks
      .map((track) => track.id3Year)
      .filter((year): year is number => year !== undefined);
    if (years.length === 0) return "—";
    return `${Math.min(...years)} - ${Math.max(...years)}`;
  }

  private nonEmptyMetadata(
    value: string | undefined,
    fallback: string,
  ): string {
    const normalized = value?.trim();
    if (normalized === undefined || normalized.length === 0) return fallback;
    return normalized;
  }

  private displayArtist(track: LibraryTrack | undefined): string {
    if (track === undefined || track.artist.length === 0) {
      return translateText("music_page.unknown_artist");
    }
    return track.artist;
  }

  private stateLabel(): string {
    return translateText(`music_page.state_${this.playbackState}`);
  }

  private sortIndicator(column: SortColumn) {
    if (this.sortColumn !== column) return nothing;
    return html`<span aria-hidden="true"
      >${this.sortDirection === "asc" ? "↑" : "↓"}</span
    >`;
  }

  private getAriaSort(column: SortColumn): "ascending" | "descending" | "none" {
    if (this.sortColumn !== column) return "none";
    return this.sortDirection === "asc" ? "ascending" : "descending";
  }

  render() {
    const current = this.currentTrack;
    const ordered = this.orderedTracks;
    return html`
      <section
        class="h-full min-h-0 flex flex-col gap-3 px-3 py-4 sm:px-0 text-white"
      >
        <div class="lg:hidden -mx-3 -mt-4">
          ${modalHeader({
            title: translateText("main.music"),
            onBack: () => window.showPage?.("page-play"),
            ariaLabel: translateText("common.back"),
          })}
        </div>

        <header class="hidden lg:block shrink-0">
          <h1 class="text-3xl sm:text-4xl font-semibold text-malibu-blue">
            ${translateText("music_page.heading")}
          </h1>
          <p class="mt-1 text-sm sm:text-base text-white/65">
            ${translateText("music_page.caption")}
          </p>
        </header>

        <input
          id="music-page-upload"
          class="hidden"
          type="file"
          accept="audio/mpeg,.mp3"
          @change=${this.onUploadSelected}
        />

        <div
          class="hidden sm:flex shrink-0 items-center gap-3 flex-wrap"
          data-music-desktop-upload-row
        >
          <button
            type="button"
            data-music-upload-position="desktop"
            class="px-4 py-2 rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-wait font-semibold transition-colors"
            ?disabled=${this.uploadStatus === "uploading"}
            @click=${this.openUploadPicker}
          >
            ${this.uploadStatus === "uploading"
              ? translateText("music_page.uploading")
              : translateText("music_page.upload_button")}
          </button>
          ${this.uploadStatus === "done"
            ? html`<span
                data-music-upload-status
                class="text-sm text-emerald-300"
                >${translateText("music_page.upload_done")}</span
              >`
            : this.uploadStatus === "error"
              ? html`<span data-music-upload-status class="text-sm text-red-300"
                  >${this.uploadErrorMessage ||
                  translateText("music_page.upload_error")}</span
                >`
              : nothing}
        </div>

        <section
          class="flex-1 min-h-0 flex flex-col overflow-hidden rounded-xl border border-white/25 bg-zinc-950/80 shadow-xl"
          aria-label=${translateText("music_page.player")}
        >
          <div
            class="shrink-0 grid grid-cols-[72px_1fr] sm:grid-cols-[96px_1fr_auto] gap-3 sm:gap-5 items-center border-b border-white/15 bg-zinc-900/85 p-3 sm:p-4"
          >
            <div
              class="size-[72px] sm:size-24 rounded-md bg-black/35 border border-white/10 flex items-center justify-center overflow-hidden"
            >
              <img
                class="w-full h-full object-cover ${current?.artworkUrl
                  ? ""
                  : "p-4 opacity-70"}"
                src=${current?.artworkUrl ?? musicFallbackArt}
                alt=${translateText("music_page.album_art_alt")}
              />
            </div>

            <div class="min-w-0">
              <div class="text-xl sm:text-2xl font-semibold truncate">
                ${current?.title ?? translateText("music_page.no_track")}
              </div>
              <div class="text-sm text-white/60 truncate">
                ${this.displayArtist(current)}
              </div>
              <div class="mt-2 flex gap-3 text-xs sm:text-sm text-white/60">
                <span>${this.stateLabel()}</span>
                <span class="tabular-nums">
                  ${this.formatTime(this.elapsed)}${this.duration > 0
                    ? ` / ${this.formatTime(this.duration)}`
                    : ""}
                </span>
              </div>
            </div>

            <div
              class="flex items-center justify-center sm:hidden"
              data-music-upload-slot="mobile"
            >
              ${this.renderMobileUploadButton()}
            </div>
            <div
              class="flex items-center justify-center gap-2 sm:gap-3"
              data-music-transport-controls
            >
              <button
                type="button"
                class="size-11 inline-flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40 transition-colors"
                ?disabled=${ordered.length === 0}
                title=${translateText("music_page.previous_hint")}
                aria-label=${translateText("music_page.previous")}
                @click=${() => this.skip(-1)}
              >
                <span class="text-2xl leading-none" aria-hidden="true"
                  >&#x23EE;&#xFE0E;</span
                >
              </button>
              <button
                type="button"
                class="size-12 inline-flex items-center justify-center rounded-full bg-sky-600 hover:bg-sky-500 disabled:opacity-40 font-semibold transition-colors"
                ?disabled=${ordered.length === 0}
                title=${translateText("music_page.play_pause_hint")}
                aria-label=${this.playbackState === "playing"
                  ? translateText("music_page.pause")
                  : translateText("music_page.play")}
                @click=${this.togglePlayPause}
              >
                ${this.playbackState === "playing"
                  ? html`<span
                      data-music-pause-icon
                      class="inline-flex items-center gap-1"
                      aria-hidden="true"
                    >
                      <span class="h-5 w-1 rounded-sm bg-current"></span>
                      <span class="h-5 w-1 rounded-sm bg-current"></span>
                    </span>`
                  : html`<span
                      class="text-2xl leading-none translate-x-px"
                      aria-hidden="true"
                      >&#x25B6;&#xFE0E;</span
                    >`}
              </button>
              <button
                type="button"
                class="size-11 inline-flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40 transition-colors"
                ?disabled=${ordered.length === 0}
                title=${translateText("music_page.next_hint")}
                aria-label=${translateText("music_page.next")}
                @click=${() => this.skip(1)}
              >
                <span class="text-2xl leading-none" aria-hidden="true"
                  >&#x23ED;&#xFE0E;</span
                >
              </button>
              ${this.allowDelete
                ? html`<button
                    type="button"
                    class="size-11 inline-flex items-center justify-center rounded-full bg-red-700/80 hover:bg-red-600 disabled:opacity-35 transition-colors"
                    ?disabled=${!current?.deletable}
                    title=${translateText("music_page.delete_hint")}
                    aria-label=${translateText("music_page.delete")}
                    @click=${this.deleteCurrentTrack}
                  >
                    <span class="text-xl leading-none" aria-hidden="true"
                      >&#x1F5D1;&#xFE0E;</span
                    >
                  </button>`
                : nothing}
            </div>
          </div>

          ${this.statusMessage
            ? html`<div
                class="shrink-0 border-b border-white/10 px-4 py-2 text-sm text-amber-300"
                role="status"
              >
                ${this.statusMessage}
              </div>`
            : nothing}

          <div
            id="music-playlist-scroll"
            class="flex-1 min-h-48 overflow-y-auto bg-zinc-950/45"
          >
            <table
              class="w-full table-fixed text-sm"
              aria-label="Music playlist"
            >
              <colgroup>
                <col class="w-[34%] sm:w-[28%]" />
                <col class="hidden sm:table-column sm:w-[12%]" />
                <col class="w-[54%] sm:w-[50%]" />
                <col class="w-12 sm:w-[10%]" />
              </colgroup>
              <thead
                class="sticky top-0 z-10 bg-zinc-900 text-left text-white/70"
              >
                <tr>
                  <th
                    aria-sort=${this.getAriaSort("artist")}
                    class="px-2 py-1.5 sm:px-3 sm:py-2"
                  >
                    <button
                      type="button"
                      class="flex items-center gap-1 hover:text-white"
                      @click=${() => this.setSort("artist")}
                    >
                      ${translateText("music_page.artist")}${this.sortIndicator(
                        "artist",
                      )}
                    </button>
                  </th>
                  <th
                    aria-sort=${this.getAriaSort("year")}
                    class="hidden sm:table-cell px-3 py-2"
                  >
                    <button
                      type="button"
                      class="flex items-center gap-1 hover:text-white"
                      @click=${() => this.setSort("year")}
                    >
                      ${translateText("music_page.year")}${this.sortIndicator(
                        "year",
                      )}
                    </button>
                  </th>
                  <th
                    aria-sort=${this.getAriaSort("title")}
                    class="px-2 py-1.5 sm:px-3 sm:py-2"
                  >
                    <button
                      type="button"
                      class="flex items-center gap-1 hover:text-white"
                      @click=${() => this.setSort("title")}
                    >
                      ${translateText("music_page.title")}${this.sortIndicator(
                        "title",
                      )}
                    </button>
                  </th>
                  <th class="px-1 py-1.5 sm:px-2 sm:py-2 text-center">
                    <span class="sr-only"
                      >${translateText("music_page.download")}</span
                    >
                  </th>
                </tr>
              </thead>
              <tbody>
                ${ordered.map(
                  (track) => html`
                    <tr
                      data-music-track-url=${track.url}
                      class="border-t border-white/8 cursor-pointer hover:bg-white/8 ${track.url ===
                      this.currentUrl
                        ? "bg-sky-700/35 text-white"
                        : "text-white/80"}"
                      aria-current=${track.url === this.currentUrl
                        ? "true"
                        : nothing}
                      @click=${() => this.selectTrack(track, true)}
                    >
                      <td class="px-2 py-1 sm:px-3 sm:py-2 truncate">
                        ${track.artist ||
                        translateText("music_page.unknown_artist")}
                      </td>
                      <td class="hidden sm:table-cell px-3 py-2 tabular-nums">
                        ${track.year || "—"}
                      </td>
                      <td
                        class="px-2 py-1 sm:px-3 sm:py-2 font-medium truncate"
                      >
                        ${track.title}
                      </td>
                      <td class="px-1 py-1 sm:px-2 sm:py-2 text-center">
                        <a
                          class="inline-flex size-7 sm:size-8 items-center justify-center rounded hover:bg-white/15"
                          href=${track.url}
                          download=${track.filename}
                          title=${translateText("music_page.download")}
                          aria-label=${translateText(
                            "music_page.download_track",
                            {
                              title: track.title,
                            },
                          )}
                          @click=${(event: Event) => event.stopPropagation()}
                          >↓</a
                        >
                      </td>
                    </tr>
                  `,
                )}
                ${!this.loading && ordered.length === 0
                  ? html`<tr>
                      <td
                        colspan="4"
                        class="px-4 py-8 text-center text-white/50"
                      >
                        ${translateText("music_page.empty")}
                      </td>
                    </tr>`
                  : nothing}
              </tbody>
            </table>
          </div>
          <div
            data-music-playlist-status
            class="h-[29px] sm:h-[37px] shrink-0 flex flex-row-reverse justify-start overflow-hidden border-t border-sky-300/35 bg-gradient-to-r from-zinc-950 via-sky-950/90 to-zinc-900 text-[10px] sm:text-xs leading-none"
            role="status"
            aria-live="polite"
          >
            ${[
              [translateText("music_page.song_count"), `${this.tracks.length}`],
              [
                translateText("music_page.total_time"),
                this.formatTotalTime(this.totalDuration),
              ],
              [translateText("music_page.song_age_range"), this.songAgeRange],
            ].map(
              ([label, value]) => html`
                <div
                  class="h-full shrink-0 flex items-center gap-1 px-1 sm:gap-1.5 sm:px-3 border-l border-white/20 whitespace-nowrap"
                >
                  <span class="text-white/60">${label}:</span>
                  <span
                    class="tabular-nums font-black text-xs sm:text-base tracking-wide text-cyan-300 ${this
                      .enrichingCount > 0
                      ? "animate-pulse"
                      : ""}"
                    >${value}</span
                  >
                </div>
              `,
            )}
          </div>
        </section>
      </section>
    `;
  }
}
