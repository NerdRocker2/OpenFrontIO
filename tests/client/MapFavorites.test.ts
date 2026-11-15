import { GameMapType } from "@openfront/engine-api/game/GameTypes";
import { beforeEach, expect, test } from "vitest";
import {
  getFavoriteMaps,
  toggleFavoriteMap,
} from "../../src/client/components/map/MapFavorites";

const MAP = GameMapType.AintNobodyHereButUsChickens;
const LEGACY_NAME = "Ain't Nobody Here But Us Chickens";

beforeEach(() => localStorage.clear());

test("retains old chicken favorites, deduplicates aliases, and filters invalid maps", () => {
  localStorage.setItem(
    "map-favorites",
    JSON.stringify([LEGACY_NAME, MAP, GameMapType.World, "Unknown", null, 5]),
  );
  expect(getFavoriteMaps()).toEqual([MAP, GameMapType.World]);
});

test("toggles a legacy favorite off and writes canonical names on the next save", () => {
  localStorage.setItem("map-favorites", JSON.stringify([LEGACY_NAME]));
  expect(toggleFavoriteMap(MAP)).toEqual([]);
  expect(toggleFavoriteMap(MAP)).toEqual([MAP]);
  expect(JSON.parse(localStorage.getItem("map-favorites")!)).toEqual([MAP]);
});
