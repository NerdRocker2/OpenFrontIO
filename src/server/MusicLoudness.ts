import { analyzeLoudness } from "bravoh-loudness";
import { MPEGDecoder } from "mpg123-decoder";
import NodeID3 from "node-id3";

export const REPLAY_GAIN_REFERENCE_LUFS = -18;

export interface MusicLoudnessMetadata {
  integratedLufs: number;
  loudnessRangeLu: number;
  truePeakDbtp: number;
  replayGainDb: number;
  replayGainPeak: number;
}

export interface TaggedMusic {
  audio: Buffer;
  loudness: MusicLoudnessMetadata;
}

interface UserDefinedText {
  description: string;
  value: string;
}

function userTextDescription(frameBody: Buffer): string | undefined {
  if (frameBody.length < 2) return undefined;
  const encoding = frameBody[0];
  if (encoding === 0 || encoding === 3) {
    const end = frameBody.indexOf(0, 1);
    if (end === -1) return undefined;
    return frameBody
      .subarray(1, end)
      .toString(encoding === 3 ? "utf8" : "latin1")
      .trim()
      .toUpperCase();
  }
  if (encoding === 1 || encoding === 2) {
    for (let end = 1; end + 1 < frameBody.length; end += 2) {
      if (frameBody[end] !== 0 || frameBody[end + 1] !== 0) continue;
      const charset = encoding === 2 ? "utf-16be" : "utf-16";
      return new TextDecoder(charset)
        .decode(frameBody.subarray(1, end))
        .trim()
        .toUpperCase();
    }
  }
  return undefined;
}

/** Rebuild only the ID3v2.3 frame list; copy every unrelated frame verbatim. */
function updateV23ReplayGainFrames(
  audio: Buffer,
  gain: string,
  peak: string,
): Buffer | undefined {
  if (
    audio.toString("ascii", 0, 3) !== "ID3" ||
    audio[3] !== 3 ||
    audio[5] !== 0
  ) {
    return undefined;
  }
  const sizeBytes = audio.subarray(6, 10);
  if (sizeBytes.length !== 4 || sizeBytes.some((byte) => byte > 127)) {
    throw new Error("Invalid ID3v2.3 tag size.");
  }
  const tagSize =
    (sizeBytes[0] << 21) |
    (sizeBytes[1] << 14) |
    (sizeBytes[2] << 7) |
    sizeBytes[3];
  const tagEnd = 10 + tagSize;
  if (tagEnd > audio.length) throw new Error("ID3v2.3 tag exceeds MP3 length.");

  const retainedFrames: Buffer[] = [];
  let position = 10;
  while (position + 10 <= tagEnd && audio[position] !== 0) {
    const identifier = audio.toString("ascii", position, position + 4);
    if (!/^[A-Z0-9]{4}$/.test(identifier)) {
      throw new Error(`Invalid ID3v2.3 frame at offset ${position}.`);
    }
    const frameSize = audio.readUInt32BE(position + 4);
    const frameEnd = position + 10 + frameSize;
    if (frameEnd > tagEnd) throw new Error(`Invalid ${identifier} frame size.`);
    const description =
      identifier === "TXXX"
        ? userTextDescription(audio.subarray(position + 10, frameEnd))
        : undefined;
    if (
      description !== "REPLAYGAIN_TRACK_GAIN" &&
      description !== "REPLAYGAIN_TRACK_PEAK"
    ) {
      retainedFrames.push(audio.subarray(position, frameEnd));
    }
    position = frameEnd;
  }
  const padding = audio.subarray(position, tagEnd);
  if (padding.some((byte) => byte !== 0)) {
    throw new Error("Unexpected bytes after ID3v2.3 frames.");
  }

  const replayGainTag = NodeID3.create({
    userDefinedText: [
      { description: "REPLAYGAIN_TRACK_GAIN", value: gain },
      { description: "REPLAYGAIN_TRACK_PEAK", value: peak },
    ],
  });
  const newFrames = replayGainTag.subarray(10);
  const newSize =
    retainedFrames.reduce((sum, frame) => sum + frame.length, 0) +
    newFrames.length +
    padding.length;
  if (newSize >= 1 << 28) throw new Error("ID3v2.3 tag is too large.");
  const header = Buffer.from(audio.subarray(0, 10));
  header[6] = (newSize >>> 21) & 0x7f;
  header[7] = (newSize >>> 14) & 0x7f;
  header[8] = (newSize >>> 7) & 0x7f;
  header[9] = newSize & 0x7f;
  return Buffer.concat([
    header,
    newFrames,
    ...retainedFrames,
    padding,
    audio.subarray(tagEnd),
  ]);
}

function replayGainUpdates(
  existing: UserDefinedText[] | undefined,
  gain: string,
  peak: string,
): UserDefinedText[] {
  const updates: UserDefinedText[] = [];
  let hasGain = false;
  let hasPeak = false;

  for (const entry of existing ?? []) {
    const description = entry.description.trim().toUpperCase();
    if (description === "REPLAYGAIN_TRACK_GAIN") {
      updates.push({ description: entry.description, value: gain });
      hasGain = true;
    } else if (description === "REPLAYGAIN_TRACK_PEAK") {
      updates.push({ description: entry.description, value: peak });
      hasPeak = true;
    } else {
      updates.push(entry);
    }
  }

  if (!hasGain) {
    updates.push({ description: "REPLAYGAIN_TRACK_GAIN", value: gain });
  }
  if (!hasPeak) {
    updates.push({ description: "REPLAYGAIN_TRACK_PEAK", value: peak });
  }
  return updates;
}

/**
 * Measures an MP3 with ITU-R BS.1770/EBU R128 and writes ReplayGain 2.0
 * track metadata. The MPEG audio frames are not re-encoded.
 */
export async function tagMp3WithReplayGain(
  audio: Buffer,
): Promise<TaggedMusic> {
  const decoder = new MPEGDecoder();
  await decoder.ready;

  let decoded: ReturnType<MPEGDecoder["decode"]>;
  try {
    decoded = decoder.decode(
      new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
    );
  } finally {
    decoder.free();
  }

  if (
    decoded.samplesDecoded <= 0 ||
    decoded.sampleRate <= 0 ||
    decoded.channelData.length === 0
  ) {
    throw new Error("The upload did not contain decodable MPEG audio.");
  }

  const measurement = analyzeLoudness(decoded.channelData, {
    sampleRateHz: decoded.sampleRate,
  });
  if (
    !Number.isFinite(measurement.integratedLufs) ||
    !Number.isFinite(measurement.truePeakDbtp)
  ) {
    throw new Error("The upload did not contain measurable audio.");
  }

  const replayGainDb = REPLAY_GAIN_REFERENCE_LUFS - measurement.integratedLufs;
  const replayGainPeak = 10 ** (measurement.truePeakDbtp / 20);
  const gainText = `${replayGainDb >= 0 ? "+" : ""}${replayGainDb.toFixed(2)} dB`;
  const peakText = replayGainPeak.toFixed(6);
  const tagged =
    updateV23ReplayGainFrames(audio, gainText, peakText) ??
    NodeID3.update(
      {
        userDefinedText: replayGainUpdates(
          NodeID3.read(audio).userDefinedText,
          gainText,
          peakText,
        ),
      },
      audio,
    );
  if (tagged instanceof Error) throw tagged;

  return {
    audio: tagged,
    loudness: {
      integratedLufs: measurement.integratedLufs,
      loudnessRangeLu: measurement.loudnessRangeLu,
      truePeakDbtp: measurement.truePeakDbtp,
      replayGainDb,
      replayGainPeak,
    },
  };
}
