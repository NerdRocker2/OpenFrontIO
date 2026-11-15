import { z } from "zod";
import { GameMapType } from "./Maps.gen";

/** Keep the fork's original map identity readable in stored data. */
export function canonicalGameMapName(name: string): string {
  return name === "Ain't Nobody Here But Us Chickens"
    ? GameMapType.AintNobodyHereButUsChickens
    : name;
}

// For storage/read boundaries only. Live game configs retain their plain enum
// schema so zbin's positional wire format does not acquire a transform.
export const SavedGameMapSchema = z.preprocess(
  (value) => (typeof value === "string" ? canonicalGameMapName(value) : value),
  z.enum(GameMapType),
);
