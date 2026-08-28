import { afterEach, describe, expect, it, vi } from "vitest";
import { initNavigation } from "../../src/client/Navigation";

if (!customElements.get("main-layout")) {
  customElements.define("main-layout", class extends HTMLElement {});
}

describe("music path navigation", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    history.replaceState(null, "", "/");
    window.currentPageId = undefined;
    window.showPage = undefined;
  });

  it("opens /music directly and restores the root URL when leaving", async () => {
    history.replaceState(null, "", "/music?allowdelete=true");
    document.body.innerHTML = `
      <button class="nav-menu-item" data-page="page-play">Play</button>
      <main>
        <div id="page-play"></div>
        <div id="page-music" class="hidden page-content"></div>
      </main>
    `;

    initNavigation();
    await Promise.resolve();

    expect(window.currentPageId).toBe("page-music");
    expect(
      document.getElementById("page-music")?.classList.contains("hidden"),
    ).toBe(false);
    expect(
      document.getElementById("page-play")?.classList.contains("hidden"),
    ).toBe(true);

    document.getElementById("page-music")!.click();
    await Promise.resolve();
    expect(window.currentPageId).toBe("page-music");
    expect(window.location.pathname).toBe("/music");

    document.querySelector<HTMLElement>("[data-page='page-play']")!.click();
    await vi.waitFor(() => expect(window.currentPageId).toBe("page-play"));
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });
});
