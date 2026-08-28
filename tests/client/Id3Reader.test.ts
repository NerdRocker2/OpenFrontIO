import { describe, expect, test } from "vitest";
import {
  metadataFromFilename,
  parseId3v2,
} from "../../src/client/sound/Id3Reader";

function frame(id: string, payload: number[]): number[] {
  const size = payload.length;
  return [
    ...Array.from(id).map((char) => char.charCodeAt(0)),
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    0,
    0,
    ...payload,
  ];
}

function textFrame(id: string, value: string): number[] {
  return frame(id, [3, ...new TextEncoder().encode(value)]);
}

describe("metadataFromFilename", () => {
  test("strips generated asset hashes from music URLs", () => {
    expect(
      metadataFromFilename(
        "/_assets/sounds/music/White%20Stripes%2C%20The%20-%202003%20-%20Elephant%20-%2001%20-%20Seven%20Nation%20Army.2b25ad8fdc6d.mp3",
      ),
    ).toEqual({
      artist: "White Stripes, The",
      title: "Seven Nation Army",
      year: "2003",
    });
  });

  test("reads title, artist, year, and attached artwork", () => {
    const image = [0xff, 0xd8, 0xff, 0xd9];
    const frames = [
      ...textFrame("TIT2", "Test Title"),
      ...textFrame("TPE1", "Test Artist"),
      ...textFrame("TYER", "2004"),
      ...frame("APIC", [
        0,
        ...new TextEncoder().encode("image/jpeg"),
        0,
        3,
        0,
        ...image,
      ]),
    ];
    const size = frames.length;
    const tag = new Uint8Array([
      0x49,
      0x44,
      0x33,
      3,
      0,
      0,
      (size >>> 21) & 0x7f,
      (size >>> 14) & 0x7f,
      (size >>> 7) & 0x7f,
      size & 0x7f,
      ...frames,
    ]);

    expect(parseId3v2(tag)).toEqual({
      title: "Test Title",
      artist: "Test Artist",
      year: "2004",
      artwork: {
        mimeType: "image/jpeg",
        data: new Uint8Array(image),
      },
    });
  });
});
