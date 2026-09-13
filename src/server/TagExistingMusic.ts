import NodeID3 from "node-id3";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { processMusicUpload } from "./MusicLoudnessWorkerClient";

const MUSIC_DIRS = ["uploads/music", "proprietary/sounds/music"] as const;
const REPLAYGAIN_KEYS = new Set([
  "REPLAYGAIN_TRACK_GAIN",
  "REPLAYGAIN_TRACK_PEAK",
]);

interface MusicFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

function withoutEmptyFields(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(withoutEmptyFields);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined && entry !== "")
        .map(([key, entry]) => [key, withoutEmptyFields(entry)]),
    );
  }
  return value;
}

function id3TagEnd(audio: Buffer): number {
  if (audio.toString("ascii", 0, 3) !== "ID3") return 0;
  if (audio.length < 10 || audio.subarray(6, 10).some((byte) => byte > 127)) {
    throw new Error("Invalid ID3v2 header size");
  }
  const tagSize =
    (audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9];
  const footerSize = audio[3] === 4 && (audio[5] & 0x10) !== 0 ? 10 : 0;
  const end = 10 + tagSize + footerSize;
  if (end > audio.length) throw new Error("ID3v2 tag exceeds file length");
  return end;
}

function nonReplayGainTags(audio: Buffer): Record<string, unknown> {
  const tags = NodeID3.read(audio);
  const raw: Record<string, unknown> = { ...tags.raw };
  const userText =
    tags.userDefinedText?.filter(
      (entry) => !REPLAYGAIN_KEYS.has(entry.description.trim().toUpperCase()),
    ) ?? [];
  delete raw.TXXX;
  return withoutEmptyFields({ raw, userText }) as Record<string, unknown>;
}

function verifyTaggedAudio(original: Buffer, tagged: Buffer): void {
  if (
    !original
      .subarray(id3TagEnd(original))
      .equals(tagged.subarray(id3TagEnd(tagged)))
  ) {
    throw new Error("MPEG audio or trailing metadata changed");
  }
  if (
    !isDeepStrictEqual(nonReplayGainTags(original), nonReplayGainTags(tagged))
  ) {
    throw new Error("Unrelated ID3 metadata changed");
  }
  const replayGain = new Map(
    NodeID3.read(tagged).userDefinedText?.map((entry) => [
      entry.description.trim().toUpperCase(),
      entry.value,
    ]),
  );
  if (
    !/^[-+]\d+\.\d{2} dB$/.test(
      replayGain.get("REPLAYGAIN_TRACK_GAIN") ?? "",
    ) ||
    !/^\d+\.\d{6}$/.test(replayGain.get("REPLAYGAIN_TRACK_PEAK") ?? "")
  ) {
    throw new Error("ReplayGain track tags are missing or invalid");
  }
}

async function listMusicFiles(root: string): Promise<MusicFile[]> {
  const files: MusicFile[] = [];
  for (const relativeDir of MUSIC_DIRS) {
    const absoluteDir = path.resolve(root, relativeDir);
    const dirStat = await fs.lstat(absoluteDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw new Error(`Not a regular directory: ${absoluteDir}`);
    }
    for (const entry of await fs.readdir(absoluteDir, {
      withFileTypes: true,
    })) {
      if (!entry.name.toLowerCase().endsWith(".mp3")) continue;
      const absolutePath = path.join(absoluteDir, entry.name);
      const fileStat = await fs.lstat(absolutePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(`Not a regular MP3 file: ${absolutePath}`);
      }
      files.push({
        relativePath: path.join(relativeDir, entry.name),
        absolutePath,
        size: fileStat.size,
      });
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.length === 1 && args[0] === "--apply";
  const resume = args.length === 2 && args[0] === "--resume";
  if (args.length > 0 && !apply && !resume) {
    throw new Error(
      "Usage: npx tsx src/server/TagExistingMusic.ts [--apply | --resume BACKUP_DIR]",
    );
  }

  const root = process.cwd();
  const files = await listMusicFiles(root);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  console.log(`Found ${files.length} music MP3s (${totalBytes} bytes).`);
  if (!apply && !resume) {
    console.log("Dry run only. Pass --apply to back up and tag these files.");
    return;
  }

  const backupBase = path.resolve(root, "uploads/music-tag-backups");
  const backupRoot = resume
    ? path.resolve(args[1])
    : path.join(
        backupBase,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
      );
  if (path.dirname(backupRoot) !== backupBase) {
    throw new Error(
      "Backup must be a direct child of uploads/music-tag-backups",
    );
  }
  if (resume) {
    const backupStat = await fs.lstat(backupRoot);
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
      throw new Error("The backup path is not a regular directory");
    }
    console.log(`Resuming from backup ${backupRoot}`);
  } else {
    await fs.mkdir(backupRoot, { recursive: true });
    console.log(`Backing up originals to ${backupRoot}`);
    for (const file of files) {
      const backupPath = path.join(backupRoot, file.relativePath);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.copyFile(file.absolutePath, backupPath, 1); // COPYFILE_EXCL
      const copied = await fs.stat(backupPath);
      if (copied.size !== file.size)
        throw new Error(`Incomplete backup: ${file.relativePath}`);
    }
  }

  let taggedCount = 0;
  const failures: string[] = [];
  for (const [index, file] of files.entries()) {
    const backupPath = path.join(backupRoot, file.relativePath);
    const stagedPath = `${file.absolutePath}.replaygain-${process.pid}.tmp`;
    try {
      const backupStat = await fs.lstat(backupPath);
      if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
        throw new Error("Backup is not a regular file");
      }
      const current = await fs.readFile(file.absolutePath);
      const original = await fs.readFile(backupPath);
      if (!current.equals(original)) {
        verifyTaggedAudio(original, current);
        taggedCount += 1;
        console.log(
          `[${index + 1}/${files.length}] ${file.relativePath}: already tagged and verified`,
        );
        continue;
      }
      const { audio, loudness } = await processMusicUpload(original);
      verifyTaggedAudio(original, audio);
      await fs.writeFile(stagedPath, audio, { flag: "wx" });
      verifyTaggedAudio(original, await fs.readFile(stagedPath));
      await fs.rename(stagedPath, file.absolutePath);
      taggedCount += 1;
      const digest = createHash("sha256")
        .update(audio)
        .digest("hex")
        .slice(0, 12);
      console.log(
        `[${index + 1}/${files.length}] ${file.relativePath}: ` +
          `${loudness.integratedLufs.toFixed(2)} LUFS, ` +
          `${loudness.replayGainDb.toFixed(2)} dB gain, sha256 ${digest}`,
      );
    } catch (error) {
      await fs.unlink(stagedPath).catch(() => undefined);
      const message = `${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(`FAILED ${message}`);
    }
  }

  console.log(`Tagged ${taggedCount}/${files.length}; backups: ${backupRoot}`);
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
