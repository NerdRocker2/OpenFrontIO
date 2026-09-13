import NodeID3 from "node-id3";
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import {
  REPLAY_GAIN_REFERENCE_LUFS,
  tagMp3WithReplayGain,
} from "../../src/server/MusicLoudness";
import { processMusicUpload } from "../../src/server/MusicRoute";

describe("music loudness tagging", () => {
  test("measures audio with EBU R128 and updates ReplayGain 2.0 tags", async () => {
    const fixture = fs.readFileSync("resources/sounds/effects/message.mp3");
    const source = NodeID3.update(
      {
        title: "Metadata survives",
        userDefinedText: [
          { description: "replaygain_track_gain", value: "+12.00 dB" },
          { description: "replaygain_track_peak", value: "0.100000" },
          { description: "MUSICBRAINZ_TRACKID", value: "preserve-me" },
        ],
      },
      fixture,
    );
    if (source instanceof Error) throw source;

    const tagged = await tagMp3WithReplayGain(source);
    const tags = NodeID3.read(tagged.audio);
    const replayGain = new Map(
      tags.userDefinedText?.map((entry) => [
        entry.description.toUpperCase(),
        entry.value,
      ]),
    );

    expect(tags.title).toBe("Metadata survives");
    expect(tagged.loudness.integratedLufs).toBeCloseTo(-21.96, 1);
    expect(tagged.loudness.replayGainDb).toBeCloseTo(
      REPLAY_GAIN_REFERENCE_LUFS - tagged.loudness.integratedLufs,
    );
    expect(replayGain.get("REPLAYGAIN_TRACK_GAIN")).toBe(
      `+${tagged.loudness.replayGainDb.toFixed(2)} dB`,
    );
    expect(Number(replayGain.get("REPLAYGAIN_TRACK_PEAK"))).toBeCloseTo(
      tagged.loudness.replayGainPeak,
      5,
    );
    expect(replayGain.get("MUSICBRAINZ_TRACKID")).toBe("preserve-me");
  });

  test("rejects data without measurable MPEG audio", async () => {
    await expect(
      tagMp3WithReplayGain(Buffer.from("not an mp3")),
    ).rejects.toThrow(/decodable MPEG audio/);
  });

  test("preserves legacy ID3v2.3 frame bytes while replacing ReplayGain", async () => {
    const fixture = fs.readFileSync("resources/sounds/effects/message.mp3");
    const existingTag = NodeID3.create({
      title: "Existing title",
      userDefinedText: [
        { description: "REPLAYGAIN_TRACK_GAIN", value: "+12.00 dB" },
      ],
    });
    const malformedCommentBody = Buffer.from([
      0x01, 0xff, 0xfe, 0x00, 0x00, 0x6e, 0x74,
    ]);
    const commentHeader = Buffer.alloc(10);
    commentHeader.write("COMM", 0, "ascii");
    commentHeader.writeUInt32BE(malformedCommentBody.length, 4);
    const commentFrame = Buffer.concat([commentHeader, malformedCommentBody]);
    const frames = Buffer.concat([commentFrame, existingTag.subarray(10)]);
    const header = Buffer.from(existingTag.subarray(0, 10));
    header[6] = (frames.length >>> 21) & 0x7f;
    header[7] = (frames.length >>> 14) & 0x7f;
    header[8] = (frames.length >>> 7) & 0x7f;
    header[9] = frames.length & 0x7f;
    const original = Buffer.concat([header, frames, fixture]);

    const tagged = await tagMp3WithReplayGain(original);
    const userText = NodeID3.read(tagged.audio).userDefinedText ?? [];
    expect(tagged.audio.includes(commentFrame)).toBe(true);
    expect(tagged.audio.subarray(tagged.audio.length - fixture.length)).toEqual(
      fixture,
    );
    expect(NodeID3.read(tagged.audio).title).toBe("Existing title");
    expect(
      userText.filter((entry) => entry.description === "REPLAYGAIN_TRACK_GAIN"),
    ).toHaveLength(1);
    expect(
      userText.some((entry) => entry.description === "REPLAYGAIN_TRACK_PEAK"),
    ).toBe(true);
  });

  test("runs decoding and tagging outside the server event loop", async () => {
    const fixture = fs.readFileSync("resources/sounds/effects/message.mp3");
    const tagged = await processMusicUpload(fixture);
    const replayGain = NodeID3.read(tagged.audio).userDefinedText?.find(
      (entry) => entry.description.toUpperCase() === "REPLAYGAIN_TRACK_GAIN",
    );

    expect(replayGain?.value).toMatch(/^\+\d+\.\d{2} dB$/);
  });
});
