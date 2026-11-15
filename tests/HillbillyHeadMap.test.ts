import {
  GameMapSize,
  GameMapType,
  GameType,
  listedMaps,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { MapManifestSchema } from "@openfront/engine-api/game/MapManifest";
import { createGameRunner } from "@openfront/engine/GameRunner";
import { FetchGameMapLoader } from "@openfront/shared/FetchGameMapLoader";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import fs from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { scriptedGameStart } from "./util/ScriptedGame";

const MAP = GameMapType.HillbillyHead;
const DIR = "resources/maps/hillbillyhead";

afterEach(() => vi.unstubAllGlobals());

describe("restored Hillbilly Head", () => {
  test("is selectable with its nine nations and original creator credit", () => {
    expect(listedMaps.find((map) => map.type === MAP)).toMatchObject({
      id: "HillbillyHead",
      categories: ["north_america"],
      defaultNationCount: 9,
      author: "Jeff Lawlor",
      descriptionKey: "map_description.hillbillyhead",
    });
  });

  test("all existing terrain sizes match their dimensions and land counts", () => {
    const manifest = MapManifestSchema.parse(
      JSON.parse(fs.readFileSync(`${DIR}/manifest.json`, "utf8")),
    );
    expect(manifest.name).toBe(MAP);
    expect(manifest.nations).toHaveLength(9);
    for (const key of ["map", "map4x", "map16x"] as const) {
      const bytes = fs.readFileSync(`${DIR}/${key}.bin`);
      const metadata = manifest[key];
      expect(bytes.length).toBe(metadata.width * metadata.height);
      let landTiles = 0;
      for (const byte of bytes) landTiles += byte >>> 7;
      expect(landTiles).toBe(metadata.num_land_tiles);
    }
  });

  test.each([GameMapSize.Normal, GameMapSize.Compact])(
    "loads real %s terrain and starts a game with all nine nations",
    async (size) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (url: string) =>
            new Response(new Uint8Array(fs.readFileSync(url))),
        ),
      );
      const loader = new FetchGameMapLoader("resources/maps");
      expect(loader.getMapData(MAP).webpPath).toBe(`${DIR}/thumbnail.webp`);
      const files = await loadMapFiles(loader, MAP, size);
      const gameStart = scriptedGameStart({
        gameMap: MAP,
        gameMapSize: size,
        gameType: GameType.Singleplayer,
        nations: "default",
        bots: 0,
        doomsdayClock: undefined,
      });
      const updates = vi.fn();
      const runner = await createGameRunner(
        gameStart,
        undefined,
        files,
        updates,
      );
      const game = runner.game;
      expect(game.width()).toBe(size === GameMapSize.Normal ? 5000 : 2500);
      expect(game.height()).toBe(game.width());
      for (const nation of files.manifest.nations) {
        const [x, y] = nation.coordinates!;
        const tile = game.ref(x, y);
        expect(game.isLand(tile)).toBe(true);
        expect(game.isImpassable(tile)).toBe(false);
      }
      for (let turn = 0; turn < 3; turn++) {
        runner.addTurn({ turnNumber: turn, intents: [] });
        expect(runner.executeNextTick()).toBe(true);
      }
      const nations = game
        .players()
        .filter((p) => p.type() === PlayerType.Nation);
      expect(nations).toHaveLength(9);
      expect(nations.every((nation) => nation.hasSpawned())).toBe(true);
      expect(game.ticks()).toBe(3);
    },
  );
});
