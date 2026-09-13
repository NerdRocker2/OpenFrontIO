import { parentPort, workerData } from "node:worker_threads";
import { tagMp3WithReplayGain } from "./MusicLoudness.ts";

void tagMp3WithReplayGain(Buffer.from(workerData.audio))
  .then((tagged) => {
    const audio = Uint8Array.from(tagged.audio);
    parentPort?.postMessage(
      { audio: audio.buffer, loudness: tagged.loudness },
      [audio.buffer],
    );
  })
  .catch((error) => {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    parentPort?.postMessage({
      error: { message: normalized.message, stack: normalized.stack },
    });
  });
