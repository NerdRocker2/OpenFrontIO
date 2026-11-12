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

export class EliminateTribeExecution implements Execution {
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
        `EliminateTribeExecution: target ${this.targetID} not found`,
      );
      return;
    }

    const target = game.player(this.targetID);

    if (target.type() !== PlayerType.Bot) {
      console.warn(
        `EliminateTribeExecution: target ${this.targetID} is not a Tribe`,
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
    return EliminateTribeExecutionSnapshot.write({
      player: w.player(this.player),
      targetID: this.targetID,
    });
  }

  restoreSnapshot(s: EliminateTribeState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.targetID = s.targetID;
  }
}

const EliminateTribeStateSchema = z.object({
  player: zPlayerRef(),
  targetID: z.string(),
});
type EliminateTribeState = z.infer<typeof EliminateTribeStateSchema>;

export const EliminateTribeExecutionSnapshot = execSnapshotType({
  name: "EliminateTribe",
  version: 1,
  schema: EliminateTribeStateSchema,
  cls: () => EliminateTribeExecution,
});
