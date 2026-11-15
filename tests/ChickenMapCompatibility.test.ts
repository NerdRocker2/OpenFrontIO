import { GameMapType, maps } from "@openfront/engine-api/game/GameTypes";
import {
  MapInfoSchema,
  MapManifestSchema,
} from "@openfront/engine-api/game/MapManifest";
import { SavedGameMapSchema } from "@openfront/engine-api/game/MapNames";
import { GameConfigSchema } from "@openfront/engine-api/Schemas";
import {
  readSnapshotHeader,
  snapshotGame,
} from "@openfront/engine/snapshot/GameSnapshot";
import {
  decodeSnapshotValue,
  encodeSnapshotValue,
} from "@openfront/engine/snapshot/SnapshotCodec";
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { setup } from "./util/Setup";
import { restoreTestGame } from "./util/Snapshot";

const LEGACY_NAME = "Ain't Nobody Here But Us Chickens";
const MAP = GameMapType.AintNobodyHereButUsChickens;

describe("chicken map compatibility", () => {
  test("uses a valid internal name and preserves the display name and terrain metadata", () => {
    const info = MapInfoSchema.parse(
      JSON.parse(
        fs.readFileSync(
          "map-generator/assets/maps/aintnobodyherebutuschickens/info.json",
          "utf8",
        ),
      ),
    );
    const manifest = MapManifestSchema.parse(
      JSON.parse(
        fs.readFileSync(
          "resources/maps/aintnobodyherebutuschickens/manifest.json",
          "utf8",
        ),
      ),
    );
    expect(MAP).toBe("AintNobodyHereButUsChickens");
    expect(info.name).toBe(MAP);
    expect(manifest.name).toBe(MAP);
    expect(info.display_name).toBe(LEGACY_NAME);
    expect(manifest.display_name).toBe(LEGACY_NAME);
    expect(manifest.nations).toEqual(info.nations);
    expect(manifest.nations).toHaveLength(42);
    expect(maps.find((map) => map.type === MAP)).toMatchObject({
      id: "AintNobodyHereButUsChickens",
      categories: ["featured", "continental"],
      defaultNationCount: 42,
    });
    for (const key of ["map", "map4x", "map16x"] as const) {
      expect(
        fs.statSync(`resources/maps/aintnobodyherebutuschickens/${key}.bin`)
          .size,
      ).toBe(manifest[key].width * manifest[key].height);
    }
  });

  test("accepts the legacy name only at saved-data boundaries", () => {
    expect(SavedGameMapSchema.parse(LEGACY_NAME)).toBe(MAP);
    expect(SavedGameMapSchema.parse(MAP)).toBe(MAP);
    expect(SavedGameMapSchema.safeParse("Unknown Chicken Map").success).toBe(
      false,
    );
    expect(GameConfigSchema.shape.gameMap.safeParse(LEGACY_NAME).success).toBe(
      false,
    );
    expect(GameConfigSchema.shape.gameMap.parse(MAP)).toBe(MAP);
  });

  test("loads and resumes an old-name snapshot, then saves the canonical name", async () => {
    // A small test terrain isolates save compatibility from expensive map loading.
    const game = await setup("plains", { gameMap: MAP });
    const root = decodeSnapshotValue(snapshotGame(game)) as {
      gameConfig: { gameMap: string };
    };
    root.gameConfig.gameMap = LEGACY_NAME;
    const legacy = encodeSnapshotValue(root);
    expect(readSnapshotHeader(legacy).gameConfig.gameMap).toBe(MAP);
    const restored = await restoreTestGame(legacy, "plains");
    expect(restored.config().gameConfig().gameMap).toBe(MAP);
    restored.executeNextTick();
    expect(readSnapshotHeader(snapshotGame(restored)).gameConfig.gameMap).toBe(
      MAP,
    );
  });
});
