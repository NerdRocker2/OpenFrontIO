import {
  eliminatedLabel,
  EliminationMarkers,
  findLeftmostOwnedTile,
  SKULL_EMOJI,
  SKULL_FILTER,
} from "../../src/client/EliminationMarkers";
import { EliminationMarkerEvent } from "../../src/client/InputHandler";
import { EventBus } from "../../src/core/EventBus";

describe("findLeftmostOwnedTile", () => {
  const grid = (owned: Set<number>, width = 200) => ({
    isValidCoord: (x: number, y: number) =>
      x >= 0 && x < width && y >= 0 && y < 200,
    isOwnedBy: (x: number) => owned.has(x),
  });

  test("returns the leftmost owned tile on the row", () => {
    const owned = new Set([60, 61, 62, 63, 64]);
    expect(findLeftmostOwnedTile(grid(owned), 62, 10)).toEqual({
      x: 60,
      y: 10,
    });
  });

  test("skips gaps (e.g. water) inside the territory", () => {
    const owned = new Set([58, 61, 62]);
    expect(findLeftmostOwnedTile(grid(owned), 62, 4)).toEqual({ x: 58, y: 4 });
  });

  test("ignores out-of-bounds columns near the map edge", () => {
    const owned = new Set([0, 1, 2]);
    expect(findLeftmostOwnedTile(grid(owned), 2, 0)).toEqual({ x: 0, y: 0 });
  });

  test("returns null when nothing is owned in range", () => {
    expect(findLeftmostOwnedTile(grid(new Set()), 100, 5)).toBeNull();
  });
});

describe("eliminatedLabel", () => {
  test("appends ' (Eliminated)' to the name", () => {
    expect(eliminatedLabel("Rome")).toBe("Rome (Eliminated)");
  });
});

describe("EliminationMarkers", () => {
  let eventBus: EventBus;
  let inSpawn: boolean;
  let markers: EliminationMarkers;
  let frames: FrameRequestCallback[];

  const transform = {
    scale: 2,
    worldToScreenCoordinates: (c: { x: number; y: number }) => ({
      x: c.x * 2,
      y: c.y * 2,
    }),
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    eventBus = new EventBus();
    inSpawn = true;
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    markers = new EliminationMarkers(
      { inSpawnPhase: () => inSpawn },
      transform,
      eventBus,
    );
  });

  afterEach(() => {
    markers.dispose();
    vi.unstubAllGlobals();
  });

  const runFrame = () => {
    const cbs = frames;
    frames = [];
    cbs.forEach((cb) => cb(0));
  };

  test("marker is only an outlined skull, with no box or text label", () => {
    eventBus.emit(new EliminationMarkerEvent("n1", "nation", 10, 20));

    const badge = document.querySelector<HTMLElement>(
      ".elimination-marker-badge",
    )!;
    expect(badge.textContent).toBe(SKULL_EMOJI);
    expect(badge.style.textShadow).toContain("#000");
    expect(badge.style.background).toBe("");
    expect(badge.style.border).toBe("");
    expect(document.querySelector(".elimination-marker")!.textContent).toBe(
      SKULL_EMOJI,
    );
  });

  test("tribe marker is tagged with its kind", () => {
    eventBus.emit(new EliminationMarkerEvent("t1", "tribe", 3, 3));

    const el = document.querySelector<HTMLElement>(".elimination-marker")!;
    expect(el.dataset.kind).toBe("tribe");
    expect(el.textContent).toBe(SKULL_EMOJI);
  });

  test("the skull glyph is tinted white for nations and light grey for tribes", () => {
    eventBus.emit(new EliminationMarkerEvent("n1", "nation", 10, 20));
    eventBus.emit(new EliminationMarkerEvent("t1", "tribe", 3, 3));

    const styleOf = (kind: string) =>
      document
        .querySelector(`.elimination-marker[data-kind="${kind}"] span`)!
        .getAttribute("style")!;
    expect(styleOf("nation")).toContain(SKULL_FILTER.nation);
    expect(styleOf("tribe")).toContain(SKULL_FILTER.tribe);
    expect(SKULL_FILTER.nation).not.toBe(SKULL_FILTER.tribe);
  });

  test("anchors the marker left of the leftmost tile", () => {
    eventBus.emit(new EliminationMarkerEvent("n1", "nation", 10, 20));

    const el = document.querySelector<HTMLElement>(".elimination-marker")!;
    expect(el.style.transform).toContain("translate(20px, 41px)");
    expect(el.style.transform).toContain("translate(-100%, -50%)");
  });

  test("re-adding the same target replaces its marker", () => {
    eventBus.emit(new EliminationMarkerEvent("n1", "nation", 10, 20));
    eventBus.emit(new EliminationMarkerEvent("n1", "nation", 12, 20));
    expect(markers.count()).toBe(1);
    expect(document.querySelectorAll(".elimination-marker").length).toBe(1);
  });

  test("markers are cleared once the spawn phase ends", () => {
    eventBus.emit(new EliminationMarkerEvent("n1", "nation", 10, 20));
    eventBus.emit(new EliminationMarkerEvent("t1", "tribe", 3, 3));
    expect(markers.count()).toBe(2);

    runFrame();
    expect(markers.count()).toBe(2);

    inSpawn = false;
    runFrame();
    expect(markers.count()).toBe(0);
    expect(document.querySelectorAll(".elimination-marker").length).toBe(0);
  });
});
