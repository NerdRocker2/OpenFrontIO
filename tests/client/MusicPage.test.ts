import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  deleteMusicTrack,
  fetchId3Metadata,
  fetchMusicTracks,
  MusicUploadError,
  uploadMusicTrack,
} = vi.hoisted(() => ({
  deleteMusicTrack: vi.fn(async () => {}),
  fetchId3Metadata: vi.fn(async (url: string) =>
    url.includes("Bundled")
      ? { duration: 65, year: "1893" }
      : { duration: 3600, year: `${new Date().getFullYear() + 1}` },
  ),
  fetchMusicTracks: vi.fn(async () => [
    {
      filename: "Bundled Song.mp3",
      url: "/music/static/Bundled%20Song.mp3",
      source: "bundled" as const,
      deletable: false,
    },
    {
      filename: "Artist B - Upload Song.mp3",
      url: "/music/uploads/Artist%20B%20-%20Upload%20Song.mp3",
      source: "upload" as const,
      deletable: true,
    },
  ]),
  MusicUploadError: class MusicUploadError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  uploadMusicTrack: vi.fn(async () => ({
    filename: "Artist A - New Song.mp3",
    url: "/music/uploads/Artist%20A%20-%20New%20Song.mp3",
    source: "upload" as const,
    deletable: true,
  })),
}));

vi.mock("../../src/client/MusicApi", () => ({
  deleteMusicTrack,
  fetchMusicTracks,
  MAX_MUSIC_UPLOAD_BYTES: 50 * 1024 * 1024,
  MusicUploadError,
  normalizeMusicUploadFilename: (name: string) => name,
  uploadMusicTrack,
}));

vi.mock("../../src/client/sound/Id3Reader", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/client/sound/Id3Reader")>();
  return { ...actual, fetchId3Metadata };
});

import "../../src/client/components/MusicPage";
import type { MusicPage } from "../../src/client/components/MusicPage";

async function mount(): Promise<MusicPage> {
  const page = document.createElement("music-page") as MusicPage;
  document.body.appendChild(page);
  await page.updateComplete;
  await vi.waitFor(() => {
    expect(page.querySelectorAll("tbody tr")).toHaveLength(2);
  });
  await page.updateComplete;
  return page;
}

describe("MusicPage", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/music?allowdelete=true");
    window.currentPageId = "page-music";
    window.showPage = undefined;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia,
    );
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      this.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      this.dispatchEvent(new Event("pause"));
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:uploaded-track");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = "";
    history.replaceState(null, "", "/");
    window.showPage = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("shows bundled and uploaded tracks and protects bundled music", async () => {
    const page = await mount();

    expect(page.textContent).toContain("Bundled Song");
    expect(page.textContent).toContain("Upload Song");
    const deleteButton = page.querySelector<HTMLButtonElement>(
      "button[aria-label='music_page.delete']",
    );
    expect(deleteButton?.disabled).toBe(true);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Delete", ctrlKey: true }),
    );
    await page.updateComplete;
    expect(deleteMusicTrack).not.toHaveBeenCalled();
    expect(page.textContent).toContain("music_page.delete_bundled_error");
  });

  it("keeps live playlist totals below the scrolling rows", async () => {
    const page = await mount();

    await vi.waitFor(() => {
      const status = page.querySelector<HTMLElement>(
        "[data-music-playlist-status]",
      )!;
      const statusText = status.textContent?.replace(/\s/g, "");
      expect(statusText).toContain("music_page.song_count:2");
      expect(statusText).toContain("music_page.total_time:1:01:05");
      expect(statusText).toContain("music_page.song_age_range:1893-1893");
    });
    const scroller = page.querySelector("#music-playlist-scroll")!;
    expect(
      scroller.nextElementSibling?.hasAttribute("data-music-playlist-status"),
    ).toBe(true);
    expect(
      scroller.nextElementSibling?.classList.contains("flex-row-reverse"),
    ).toBe(true);
  });

  it("uses standard media symbols for the player controls", async () => {
    const page = await mount();

    expect(
      page.querySelector("button[aria-label='music_page.previous']")
        ?.textContent,
    ).toContain("⏮");
    expect(
      page.querySelector("button[aria-label='music_page.play']")?.textContent,
    ).toContain("▶");
    expect(
      page.querySelector("button[aria-label='music_page.next']")?.textContent,
    ).toContain("⏭");
    expect(
      page.querySelector("button[aria-label='music_page.delete']")?.textContent,
    ).toContain("🗑");
    page
      .querySelector<HTMLButtonElement>("button[aria-label='music_page.play']")!
      .click();
    await page.updateComplete;
    const pauseIcon = page.querySelector<HTMLElement>(
      "button[aria-label='music_page.pause'] [data-music-pause-icon]",
    )!;
    expect(pauseIcon.children).toHaveLength(2);
    expect(pauseIcon.textContent?.trim()).toBe("");
  });

  it("uploads, plays, selects, and places a new track first by default", async () => {
    const page = await mount();
    const input = page.querySelector<HTMLInputElement>("#music-page-upload")!;
    const toast = new Promise<CustomEvent>((resolve) => {
      window.addEventListener(
        "show-message",
        (event) => resolve(event as CustomEvent),
        { once: true },
      );
    });
    const file = new File(["mp3"], "Artist A - New Song.mp3", {
      type: "audio/mpeg",
    });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(uploadMusicTrack).toHaveBeenCalledWith(file));
    await vi.waitFor(() => {
      const firstRow = page.querySelector<HTMLElement>("tbody tr");
      expect(firstRow?.textContent).toContain("New Song");
      expect(firstRow?.getAttribute("aria-current")).toBe("true");
    });
    expect(
      vi.mocked(HTMLMediaElement.prototype.play).mock.invocationCallOrder[0],
    ).toBeLessThan(uploadMusicTrack.mock.invocationCallOrder[0]);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect((await toast).detail).toEqual({
      message: "music_page.upload_done",
      color: "green",
      duration: 3000,
    });
  });

  it("uses compact mobile rows and centers upload below the artwork", async () => {
    const page = await mount();
    const input = page.querySelector<HTMLInputElement>("#music-page-upload")!;
    const inputClick = vi.spyOn(input, "click").mockImplementation(() => {});
    const uploadButton = page.querySelector<HTMLButtonElement>(
      "button[aria-label='music_page.upload_button']",
    )!;

    expect(uploadButton.type).toBe("button");
    expect(uploadButton.querySelector("svg")).not.toBeNull();
    expect(uploadButton.textContent?.trim()).toBe("");
    expect(uploadButton.dataset.musicUploadPosition).toBe("mobile");
    expect(uploadButton.classList.contains("rounded-lg")).toBe(true);
    expect(uploadButton.classList.contains("bg-sky-600")).toBe(true);
    const mobileUploadSlot = uploadButton.closest<HTMLElement>(
      "[data-music-upload-slot='mobile']",
    )!;
    expect(mobileUploadSlot.classList.contains("justify-center")).toBe(true);
    expect(
      mobileUploadSlot.nextElementSibling?.querySelector(
        "button[aria-label='music_page.previous']",
      ),
    ).not.toBeNull();
    const firstTrackCells = page.querySelectorAll("tbody tr:first-child td");
    expect(firstTrackCells[0].classList.contains("py-1")).toBe(true);
    expect(firstTrackCells[0].classList.contains("sm:py-2")).toBe(true);
    expect(
      firstTrackCells[3].querySelector("a")?.classList.contains("size-7"),
    ).toBe(true);
    expect(page.querySelector("details")).toBeNull();
    expect(page.querySelector("header")?.classList.contains("hidden")).toBe(
      true,
    );
    const uploadClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    expect(uploadButton.dispatchEvent(uploadClick)).toBe(false);
    expect(inputClick).toHaveBeenCalledOnce();

    const showPage = vi.fn();
    window.showPage = showPage;
    const backButton = page.querySelector<HTMLButtonElement>(
      "button[aria-label='common.back']",
    )!;
    expect(backButton.type).toBe("button");
    expect(backButton.closest(".lg\\:hidden")?.textContent).toContain(
      "main.music",
    );
    backButton.click();
    expect(showPage).toHaveBeenCalledWith("page-play");
  });

  it("shows upload failures as an error toast", async () => {
    uploadMusicTrack.mockRejectedValueOnce(new Error("upload failed"));
    const page = await mount();
    const input = page.querySelector<HTMLInputElement>("#music-page-upload")!;
    const toast = new Promise<CustomEvent>((resolve) => {
      window.addEventListener(
        "show-message",
        (event) => resolve(event as CustomEvent),
        { once: true },
      );
    });
    const file = new File(["mp3"], "Failed Song.mp3", {
      type: "audio/mpeg",
    });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect((await toast).detail).toEqual({
      message: "music_page.upload_error",
      color: "red",
      duration: 4000,
    });
    await page.updateComplete;
    const inlineError = page.querySelector<HTMLElement>(
      "[data-music-upload-status]",
    )!;
    expect(inlineError.textContent).toContain("music_page.upload_error");
    expect(
      inlineError
        .closest("[data-music-desktop-upload-row]")
        ?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("keeps the page open and explains duplicate uploads", async () => {
    uploadMusicTrack.mockRejectedValueOnce(
      new MusicUploadError("duplicate_file", "already exists"),
    );
    const page = await mount();
    const input = page.querySelector<HTMLInputElement>("#music-page-upload")!;
    const startingUrl = window.location.href;
    const toast = new Promise<CustomEvent>((resolve) => {
      window.addEventListener(
        "show-message",
        (event) => resolve(event as CustomEvent),
        { once: true },
      );
    });
    const file = new File(["mp3"], "Duplicate Song.mp3", {
      type: "audio/mpeg",
    });
    Object.defineProperty(input, "files", { value: [file] });
    const change = new Event("change", { bubbles: true, cancelable: true });

    expect(input.dispatchEvent(change)).toBe(false);
    expect((await toast).detail.message).toBe("music_page.upload_duplicate");
    expect(window.location.href).toBe(startingUrl);
    await page.updateComplete;
    expect(
      page.querySelector("[data-music-upload-status]")?.textContent,
    ).toContain("music_page.upload_duplicate");
  });

  it("catches an existing filename before playback or upload begins", async () => {
    const page = await mount();
    const input = page.querySelector<HTMLInputElement>("#music-page-upload")!;
    const startingUrl = window.location.href;
    const toast = new Promise<CustomEvent>((resolve) => {
      window.addEventListener(
        "show-message",
        (event) => resolve(event as CustomEvent),
        { once: true },
      );
    });
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    const file = new File(["mp3"], "Artist B - Upload Song.mp3", {
      type: "audio/mpeg",
    });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(
      new Event("change", { bubbles: true, cancelable: true }),
    );

    expect((await toast).detail.message).toBe("music_page.upload_duplicate");
    expect(uploadMusicTrack).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(window.location.href).toBe(startingUrl);
    expect(page.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("rejects oversized files before calling the upload endpoint", async () => {
    const page = await mount();
    const input = page.querySelector<HTMLInputElement>("#music-page-upload")!;
    const startingUrl = window.location.href;
    const toast = new Promise<CustomEvent>((resolve) => {
      window.addEventListener(
        "show-message",
        (event) => resolve(event as CustomEvent),
        { once: true },
      );
    });
    const file = new File(["mp3"], "Huge Song.mp3", {
      type: "audio/mpeg",
    });
    Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 + 1 });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(
      new Event("change", { bubbles: true, cancelable: true }),
    );

    expect((await toast).detail.message).toBe("music_page.upload_too_large");
    expect(uploadMusicTrack).not.toHaveBeenCalled();
    expect(window.location.href).toBe(startingUrl);
  });

  it("uses a labeled desktop upload row with inline results", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: false,
    } as MediaQueryList);
    const showMessage = vi.fn();
    window.addEventListener("show-message", showMessage);
    const page = await mount();
    const desktopRow = page.querySelector<HTMLElement>(
      "[data-music-desktop-upload-row]",
    )!;
    const desktopButton = desktopRow.querySelector<HTMLButtonElement>(
      "button[data-music-upload-position='desktop']",
    )!;
    expect(desktopButton.textContent).toContain("music_page.upload_button");

    const input = page.querySelector<HTMLInputElement>("#music-page-upload")!;
    const file = new File(["mp3"], "Desktop Song.mp3", {
      type: "audio/mpeg",
    });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() =>
      expect(
        desktopRow.querySelector("[data-music-upload-status]")?.textContent,
      ).toContain("music_page.upload_done"),
    );
    expect(showMessage).not.toHaveBeenCalled();
    window.removeEventListener("show-message", showMessage);
  });

  it("uses the visible sort order for playback navigation", async () => {
    const page = await mount();
    const artistSort = Array.from(page.querySelectorAll("th button")).find(
      (button) => button.textContent?.includes("music_page.artist"),
    ) as HTMLButtonElement;
    artistSort.click();
    await page.updateComplete;

    expect(page.querySelector("tbody tr")?.textContent).toContain("Artist B");

    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "BracketRight" }),
    );
    await page.updateComplete;
    const selected = page.querySelector("tbody tr[aria-current='true']");
    expect(selected?.textContent).toContain("Artist B");
  });

  it("deletes an uploaded selection and stops when leaving the page", async () => {
    const page = await mount();
    const uploadRow = Array.from(
      page.querySelectorAll<HTMLElement>("tbody tr"),
    ).find((row) => row.textContent?.includes("Upload Song"))!;
    uploadRow.click();
    await page.updateComplete;
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    vi.mocked(HTMLMediaElement.prototype.load).mockClear();
    deleteMusicTrack.mockClear();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Delete", ctrlKey: true }),
    );
    await vi.waitFor(() =>
      expect(deleteMusicTrack).toHaveBeenCalledWith(
        "Artist B - Upload Song.mp3",
      ),
    );
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    expect(
      vi.mocked(HTMLMediaElement.prototype.load).mock.invocationCallOrder[0],
    ).toBeLessThan(deleteMusicTrack.mock.invocationCallOrder[0]);
    await vi.waitFor(() =>
      expect(page.textContent).not.toContain("Upload Song"),
    );

    window.dispatchEvent(new CustomEvent("showPage", { detail: "page-play" }));
    await page.updateComplete;
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(page.textContent).toContain("music_page.state_stopped");
  });
});
