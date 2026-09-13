import { Worker } from "node:worker_threads";
import path from "path";
import type { MusicLoudnessMetadata, TaggedMusic } from "./MusicLoudness";

export function processMusicUpload(audio: Buffer): Promise<TaggedMusic> {
  const transferable = Uint8Array.from(audio);
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.resolve(process.cwd(), "src/server/MusicLoudnessWorker.mjs"),
      {
        workerData: { audio: transferable.buffer },
        transferList: [transferable.buffer],
      },
    );
    worker.once(
      "message",
      (message: {
        audio?: ArrayBuffer;
        loudness?: MusicLoudnessMetadata;
        error?: { message: string; stack?: string };
      }) => {
        if (message.error) {
          const error = new Error(message.error.message);
          error.stack = message.error.stack;
          reject(error);
        } else if (message.audio && message.loudness) {
          resolve({
            audio: Buffer.from(message.audio),
            loudness: message.loudness,
          });
        } else {
          reject(new Error("The loudness worker returned an invalid result."));
        }
      },
    );
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`The loudness worker exited with code ${code}.`));
      }
    });
  });
}
