import { EliminateTribeExecution } from "../src/core/execution/EliminateTribeExecution";
import { Game, GameType, Player, PlayerType } from "../src/core/game/Game";
import { GameConfigSchema, IntentSchema } from "../src/core/Schemas";
import { playerInfo, setup } from "./util/Setup";

let game: Game;
let human: Player;
let tribe: Player;
let nation: Player;

describe("EliminateTribeExecution", () => {
  beforeEach(async () => {
    game = await setup("plains", { gameType: GameType.Singleplayer }, [
      playerInfo("human", PlayerType.Human),
      playerInfo("tribe_id", PlayerType.Bot),
      playerInfo("nation_id", PlayerType.Nation),
    ]);

    human = game.player("human");
    tribe = game.player("tribe_id");
    nation = game.player("nation_id");

    tribe.conquer(game.ref(0, 0));
    nation.conquer(game.ref(5, 5));

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
  });

  test("eliminates a tribe and removes its territory", () => {
    expect(tribe.isAlive()).toBe(true);

    game.addExecution(new EliminateTribeExecution(human, "tribe_id"));
    game.executeNextTick();

    expect(tribe.isAlive()).toBe(false);
    expect(tribe.tiles().size).toBe(0);
  });

  test("does nothing if target is a Nation", () => {
    game.addExecution(new EliminateTribeExecution(human, "nation_id"));
    game.executeNextTick();

    expect(nation.isAlive()).toBe(true);
  });

  test("does nothing if target is a Human", () => {
    human.conquer(game.ref(10, 10));

    game.addExecution(new EliminateTribeExecution(human, "human"));
    game.executeNextTick();

    expect(human.isAlive()).toBe(true);
  });

  test("is idempotent", () => {
    game.addExecution(new EliminateTribeExecution(human, "tribe_id"));
    game.executeNextTick();
    expect(tribe.isAlive()).toBe(false);

    game.addExecution(new EliminateTribeExecution(human, "tribe_id"));
    expect(() => game.executeNextTick()).not.toThrow();
    expect(tribe.isAlive()).toBe(false);
  });

  test("does nothing if target player does not exist", () => {
    game.addExecution(new EliminateTribeExecution(human, "nonexistent_id"));
    expect(() => game.executeNextTick()).not.toThrow();
  });
});

describe("EliminateTribeExecution outside singleplayer", () => {
  test("does not eliminate tribes in a multiplayer game", async () => {
    const mpGame = await setup("plains", { gameType: GameType.Public }, [
      playerInfo("human", PlayerType.Human),
      playerInfo("tribe_id", PlayerType.Bot),
    ]);
    const mpTribe = mpGame.player("tribe_id");
    mpTribe.conquer(mpGame.ref(0, 0));
    while (mpGame.inSpawnPhase()) {
      mpGame.executeNextTick();
    }

    mpGame.addExecution(
      new EliminateTribeExecution(mpGame.player("human"), "tribe_id"),
    );
    mpGame.executeNextTick();

    expect(mpTribe.isAlive()).toBe(true);
  });
});

describe("eliminate_tribe schemas", () => {
  test("intent schema accepts eliminate_tribe", () => {
    const result = IntentSchema.safeParse({
      type: "eliminate_tribe",
      targetID: "abcd1234",
    });
    expect(result.success).toBe(true);
  });

  test("eliminateTribes allows 1..50 and rejects out-of-range values", () => {
    const shape = GameConfigSchema.shape.eliminateTribes;
    expect(shape.safeParse(10).success).toBe(true);
    expect(shape.safeParse(50).success).toBe(true);
    expect(shape.safeParse(51).success).toBe(false);
    expect(shape.safeParse(0).success).toBe(false);
    expect(shape.safeParse(undefined).success).toBe(true);
  });
});
