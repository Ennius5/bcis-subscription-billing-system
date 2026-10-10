import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runPgTool } from "./pg-tools";

/**
 * What a backup folder contains, written as manifest.json next to the files:
 *   database.dump   pg_dump custom format
 *   proofs/         copies of the payment proof images
 *   manifest.json   this description, with a SHA-256 for every file
 * The manifest's own SHA-256 is kept in backup_history, so editing it is detected too.
 */

export const MANIFEST_FILE = "manifest.json";
export const DATABASE_FILE = "database.dump";
export const PROOFS_FOLDER = "proofs";

export interface FileEntry {
  name: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: 1;
  backupNumber: string;
  kind: string;
  createdAt: string;
  createdBy: string | null;
  database: FileEntry;
  proofs: FileEntry[];
  /** Rows per key table, counted in the same snapshot pg_dump used. */
  rowCounts: Record<string, number>;
  migrations: { applied: number; lastCreatedAt: number | null };
}

export function sha256OfText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Streams the file, so a large dump never has to fit in memory. */
export async function describeFile(filePath: string): Promise<FileEntry> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return { name: path.basename(filePath), bytes: (await stat(filePath)).size, sha256: hash.digest("hex") };
}

export interface VerificationResult {
  passed: boolean;
  /** One plain sentence per problem found; empty when passed. */
  problems: string[];
}

async function checkFile(filePath: string, expected: FileEntry, label: string, problems: string[]) {
  try {
    const actual = await describeFile(filePath);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      problems.push(`${label} has changed since the backup was made.`);
    }
  } catch {
    problems.push(`${label} is missing.`);
  }
}

/**
 * Checks a backup folder without restoring it: the manifest is the one recorded,
 * every file matches its checksum, and pg_restore can read the dump's table of contents,
 * including the data of every table that was counted.
 */
export async function verifyBackupFolder(
  folder: string,
  expectedManifestSha256: string,
  pg: { binDir: string; databaseUrl: string },
): Promise<VerificationResult> {
  const problems: string[] = [];

  let manifest: BackupManifest;
  try {
    const text = await readFile(path.join(folder, MANIFEST_FILE), "utf8");
    if (sha256OfText(text) !== expectedManifestSha256) {
      problems.push("manifest.json has changed since the backup was made.");
    }
    manifest = JSON.parse(text) as BackupManifest;
  } catch {
    return { passed: false, problems: ["The backup folder or its manifest.json is missing or unreadable."] };
  }

  await checkFile(path.join(folder, DATABASE_FILE), manifest.database, "The database file", problems);
  for (const proof of manifest.proofs) {
    await checkFile(path.join(folder, PROOFS_FOLDER, proof.name), proof, `Proof image ${proof.name}`, problems);
  }

  try {
    const contents = await runPgTool(pg.binDir, "pg_restore", ["--list", path.join(folder, DATABASE_FILE)], pg.databaseUrl);
    for (const table of Object.keys(manifest.rowCounts)) {
      if (!new RegExp(`TABLE DATA public ${table} `).test(contents)) {
        problems.push(`The database file has no data section for ${table}.`);
      }
    }
  } catch (err) {
    problems.push(`pg_restore cannot read the database file (${(err as Error).message}).`);
  }

  return { passed: problems.length === 0, problems };
}
