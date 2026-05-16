import { Execution, Game, GameType, Player, PlayerID, PlayerType } from "../game/Game";

export class EliminateNationExecution implements Execution {
  constructor(
    private player: Player,
    private targetID: PlayerID,
  ) {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  init(game: Game, ticks: number): void {
    if (game.config().gameConfig().gameType !== GameType.Singleplayer) {
      return;
    }

    if (!game.hasPlayer(this.targetID)) {
      console.warn(
        `EliminateNationExecution: target ${this.targetID} not found`,
      );
      return;
    }

    const target = game.player(this.targetID);

    if (target.type() !== PlayerType.Nation) {
      console.warn(
        `EliminateNationExecution: target ${this.targetID} is not a Nation`,
      );
      return;
    }

    if (!target.isAlive()) {
      return;
    }

    for (const tile of target.tiles()) {
      target.relinquish(tile);
    }
  }

  tick(ticks: number): void {}
}
