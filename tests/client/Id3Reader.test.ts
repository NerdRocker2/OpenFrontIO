import { describe, expect, test } from "vitest";
import { metadataFromFilename } from "../../src/client/sound/Id3Reader";

describe("metadataFromFilename", () => {
  test("strips generated asset hashes from music URLs", () => {
    expect(
      metadataFromFilename(
        "/_assets/sounds/music/White%20Stripes%2C%20The%20-%202003%20-%20Elephant%20-%2001%20-%20Seven%20Nation%20Army.2b25ad8fdc6d.mp3",
      ),
    ).toEqual({
      artist: "White Stripes, The",
      title: "Seven Nation Army",
    });
  });
});
