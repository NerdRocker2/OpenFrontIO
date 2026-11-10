import { EventBus } from "../core/EventBus";
import { Cell } from "../core/game/Game";
import { EliminationMarkerEvent } from "./InputHandler";

export const ELIMINATED_SUFFIX = " (Eliminated)";
export const SKULL_EMOJI = "\u{1F480}";

// Tints the emoji glyph itself (no box behind it): desaturate the platform's
// skull, then push its light areas to white for nations or light grey for
// tribes. Black stays black, so the eye sockets and the outline are unaffected.
export const SKULL_FILTER = {
  nation: "grayscale(1) brightness(1.5)",
  tribe: "grayscale(1) brightness(0.93)",
} as const;

const MAX_SCAN_TILES = 50;

interface OwnedTileLookup {
  isValidCoord(x: number, y: number): boolean;
  isOwnedBy(x: number, y: number): boolean;
}

/**
 * Leftmost tile on row `y` (within MAX_SCAN_TILES of `x`) that belongs to the
 * player. Scans the whole window rather than stopping at the first gap so a
 * lake or inlet inside a territory doesn't cut the search short. Returns null
 * if no tile in the window is owned.
 */
export function findLeftmostOwnedTile(
  lookup: OwnedTileLookup,
  x: number,
  y: number,
): { x: number; y: number } | null {
  for (let cx = x - MAX_SCAN_TILES; cx <= x; cx++) {
    if (lookup.isValidCoord(cx, y) && lookup.isOwnedBy(cx, y)) {
      return { x: cx, y };
    }
  }
  return null;
}

export function eliminatedLabel(name: string): string {
  return `${name}${ELIMINATED_SUFFIX}`;
}

interface MarkerTransform {
  scale: number;
  worldToScreenCoordinates(cell: Cell): { x: number; y: number };
}

interface MarkerGame {
  inSpawnPhase(): boolean;
}

interface Marker {
  x: number;
  y: number;
  el: HTMLDivElement;
}

/**
 * Screen-space DOM overlay drawn next to each eliminated nation/tribe: a skull
 * badge whose right edge sits just left of where the territory was. Markers
 * follow the camera and are removed as soon as the game leaves the spawn phase.
 */
export class EliminationMarkers {
  private readonly container: HTMLDivElement;
  private readonly markers = new Map<string, Marker>();
  private rafId: number | null = null;

  constructor(
    private readonly game: MarkerGame,
    private readonly transformHandler: MarkerTransform,
    eventBus: EventBus,
    parent: HTMLElement = document.body,
  ) {
    this.container = document.createElement("div");
    this.container.className = "elimination-markers";
    this.container.style.cssText =
      "position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:5;";
    parent.appendChild(this.container);
    eventBus.on(EliminationMarkerEvent, (e) => this.add(e));
  }

  add(e: EliminationMarkerEvent): void {
    this.markers.get(e.targetID)?.el.remove();
    const el = this.createElement(e);
    this.container.appendChild(el);
    this.markers.set(e.targetID, { x: e.x, y: e.y, el });
    this.reposition();
    this.scheduleFrame();
  }

  count(): number {
    return this.markers.size;
  }

  clear(): void {
    for (const m of this.markers.values()) m.el.remove();
    this.markers.clear();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose(): void {
    this.clear();
    this.container.remove();
  }

  private createElement(e: EliminationMarkerEvent): HTMLDivElement {
    const outline =
      "-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000";
    const el = document.createElement("div");
    el.className = "elimination-marker";
    el.dataset.kind = e.kind;
    el.style.cssText =
      "position:absolute;left:0;top:0;display:flex;align-items:center;" +
      "white-space:nowrap;font-weight:700;";

    const badge = document.createElement("span");
    badge.className = "elimination-marker-badge";
    badge.textContent = SKULL_EMOJI;
    badge.style.cssText = `line-height:1.1;text-shadow:${outline};filter:${SKULL_FILTER[e.kind]};`;

    el.append(badge);
    return el;
  }

  private scheduleFrame(): void {
    if (this.rafId !== null || this.markers.size === 0) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (!this.game.inSpawnPhase()) {
        this.clear();
        return;
      }
      this.reposition();
      this.scheduleFrame();
    });
  }

  private reposition(): void {
    const scale = this.transformHandler.scale;
    const fontPx = Math.min(28, Math.max(12, scale * 4));
    for (const m of this.markers.values()) {
      const p = this.transformHandler.worldToScreenCoordinates(
        new Cell(m.x, m.y),
      );
      m.el.style.fontSize = `${fontPx}px`;
      m.el.style.transform = `translate(${p.x}px, ${p.y + scale / 2}px) translate(-100%, -50%)`;
    }
  }
}
