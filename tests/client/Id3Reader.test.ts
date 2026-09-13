import { describe, expect, test, vi } from "vitest";
import {
  fetchId3Metadata,
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

function userTextFrame(description: string, value: string): number[] {
  return frame("TXXX", [
    3,
    ...new TextEncoder().encode(description),
    0,
    ...new TextEncoder().encode(value),
  ]);
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
      ...userTextFrame("replaygain_track_gain", "-7.25 dB"),
      ...userTextFrame("REPLAYGAIN_TRACK_PEAK", "1.031250"),
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
      replayGainTrackGainDb: -7.25,
      replayGainTrackPeak: 1.03125,
      artwork: {
        mimeType: "image/jpeg",
        data: new Uint8Array(image),
      },
    });
  });

  test("fetches the remainder of a large tag when ReplayGain is beyond the initial range", async () => {
    const frames = [
      ...frame("APIC", Array(66000).fill(0)),
      ...userTextFrame("REPLAYGAIN_TRACK_GAIN", "-4.50 dB"),
      ...userTextFrame("REPLAYGAIN_TRACK_PEAK", "0.950000"),
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
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        const data =
          fetchMock.mock.calls.length === 1 ? tag.slice(0, 65536) : tag;
        return {
          ok: true,
          status: 206,
          arrayBuffer: async () => data.buffer,
        } as Response;
      });

    try {
      const metadata = await fetchId3Metadata("/music/example.mp3", {
        includeDuration: false,
      });
      expect(metadata.replayGainTrackGainDb).toBe(-4.5);
      expect(metadata.replayGainTrackPeak).toBe(0.95);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
