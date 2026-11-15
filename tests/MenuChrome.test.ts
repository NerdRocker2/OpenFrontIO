// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  hideMenuChrome,
  menuChromeIsTornDown,
  restoreMenuChrome,
} from "../src/client/MenuChrome";

afterEach(() => {
  document.body.innerHTML = "";
  document.body.classList.remove("in-game");
  // Module-level teardown flag: reset so state cannot leak between tests.
  restoreMenuChrome();
});

// The gate that decides whether any of the above runs.
//
// It is keyed on "did we tear the chrome down?" rather than on any separate
// signal that happens to correlate. The first version of this gate read the
// `in-game` body class, and that was subtly wrong: the teardown runs in
// `prestart.then(...)` while setInGameSignal(true) runs later in
// `join.then(...)`. For multiplayer those are two distinct server messages
// with a real window between them while terrain loads -- the "prestart->start
// window" ClientGameRunner names. A leave inside that window found the chrome
// torn down but the class unset, so nothing restored: the exact bug this PR
// exists to fix, arriving through a narrower door.
describe("menuChromeIsTornDown", () => {
  it("is false at the menu, so a pre-start leave restores nothing", () => {
    expect(menuChromeIsTornDown()).toBe(false);
  });

  it("is true as soon as the chrome is hidden", () => {
    hideMenuChrome();

    expect(menuChromeIsTornDown()).toBe(true);
  });

  // The regression. The teardown has happened; the in-game signal has not
  // been set and will not be until the join resolves. Restore must still fire.
  it("is true during the prestart->start window, before any in-game signal", () => {
    hideMenuChrome();
    expect(document.body.classList.contains("in-game")).toBe(false);

    expect(menuChromeIsTornDown()).toBe(true);
  });

  it("is false again once the chrome has been restored", () => {
    hideMenuChrome();
    restoreMenuChrome();

    expect(menuChromeIsTornDown()).toBe(false);
  });

  // Deliberately independent of the body class, so the two cannot drift.
  it("does not consult the in-game class", () => {
    document.body.classList.add("in-game");

    expect(menuChromeIsTornDown()).toBe(false);
  });
});
