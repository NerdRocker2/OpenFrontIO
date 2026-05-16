import { EliminateNationExecution } from "../src/core/execution/EliminateNationExecution";
import { Game, Player, PlayerType } from "../src/core/game/Game";
import { playerInfo, setup } from "./util/Setup";

let game: Game;
let human: Player;
let nation: Player;

describe("EliminateNationExecution", () => {
  beforeEach(async () => {
    game = await setup("plains", {}, [
      playerInfo("human", PlayerType.Human),
      playerInfo("nation_id", PlayerType.Nation),
    ]);

    human = game.player("human");
    nation = game.player("nation_id");

    // Give nation territory so it starts alive
    nation.conquer(game.ref(0, 0));

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
  });

  test("eliminates nation and removes its territory", () => {
    expect(nation.isAlive()).toBe(true);

    game.addExecution(new EliminateNationExecution(human, "nation_id"));
    game.executeNextTick();

    expect(nation.isAlive()).toBe(false);
  });

  test("does nothing if target is not a Nation", () => {
    human.conquer(game.ref(0, 0));
    expect(human.isAlive()).toBe(true);

    game.addExecution(new EliminateNationExecution(human, "human"));
    game.executeNextTick();

    expect(human.isAlive()).toBe(true);
  });

  test("is idempotent - second elimination on same player does nothing", () => {
    game.addExecution(new EliminateNationExecution(human, "nation_id"));
    game.executeNextTick();
    expect(nation.isAlive()).toBe(false);

    // Second call - should not throw
    game.addExecution(new EliminateNationExecution(human, "nation_id"));
    game.executeNextTick();
    expect(nation.isAlive()).toBe(false);
  });

  test("does nothing if target player does not exist", () => {
    // Should not throw
    game.addExecution(new EliminateNationExecution(human, "nonexistent_id"));
    expect(() => game.executeNextTick()).not.toThrow();
  });
});
