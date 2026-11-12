import {
  GameType,
  PlayerID,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

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

  snapshot(w: SnapshotWriter): ExecRecord {
    return EliminateNationExecutionSnapshot.write({
      player: w.player(this.player),
      targetID: this.targetID,
    });
  }

  restoreSnapshot(s: EliminateNationState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.targetID = s.targetID;
  }
}

const EliminateNationStateSchema = z.object({
  player: zPlayerRef(),
  targetID: z.string(),
});
type EliminateNationState = z.infer<typeof EliminateNationStateSchema>;

export const EliminateNationExecutionSnapshot = execSnapshotType({
  name: "EliminateNation",
  version: 1,
  schema: EliminateNationStateSchema,
  cls: () => EliminateNationExecution,
});
