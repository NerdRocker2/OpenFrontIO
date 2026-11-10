import { EliminationMarkerEvent } from "../../src/client/InputHandler";
import "../../src/client/hud/layers/PlayerInfoOverlay";
import type { PlayerInfoOverlay } from "../../src/client/hud/layers/PlayerInfoOverlay";
import { EventBus } from "../../src/core/EventBus";

describe("PlayerInfoOverlay eliminated names", () => {
  let eventBus: EventBus;
  let inSpawn: boolean;
  let overlay: PlayerInfoOverlay;

  const player = (id: string, name: string) =>
    ({ id: () => id, displayName: () => name }) as never;

  const nameOf = (p: never): string =>
    (
      overlay as unknown as { displayNameOf: (p: never) => string }
    ).displayNameOf(p);

  beforeEach(() => {
    eventBus = new EventBus();
    inSpawn = true;
    overlay = document.createElement(
      "player-info-overlay",
    ) as PlayerInfoOverlay;
    overlay.eventBus = eventBus;
    overlay.game = { inSpawnPhase: () => inSpawn } as never;
    overlay.init();
  });

  test("appends ' (Eliminated)' to eliminated nations and tribes", () => {
    eventBus.emit(new EliminationMarkerEvent("n1", "nation", 1, 1));
    eventBus.emit(new EliminationMarkerEvent("t1", "tribe", 2, 2));

    expect(nameOf(player("n1", "Rome"))).toBe("Rome (Eliminated)");
    expect(nameOf(player("t1", "Wolves"))).toBe("Wolves (Eliminated)");
  });

  test("leaves other players' names untouched", () => {
    eventBus.emit(new EliminationMarkerEvent("n1", "nation", 1, 1));

    expect(nameOf(player("n2", "Egypt"))).toBe("Egypt");
  });

  test("drops the suffix once the spawn phase ends", () => {
    eventBus.emit(new EliminationMarkerEvent("n1", "nation", 1, 1));
    inSpawn = false;

    expect(nameOf(player("n1", "Rome"))).toBe("Rome");
  });
});
