import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectProofType, PROOF_MAX_BYTES, type ProofMimeType } from "@bcis/shared";

/*
 * Payment proof files on the API server's disk (spec 4: validate type, size and a safe
 * storage path). Nothing from the uploader decides where a file goes: the name is a new
 * UUID plus an extension chosen from the detected type, inside one fixed folder.
 */

const EXTENSIONS: Record<ProofMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The only shape a storage key can have, so a key can never point outside the folder. */
const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

export class ProofFileError extends Error {
  constructor(
    public readonly code: "PROOF_EMPTY" | "PROOF_TOO_LARGE" | "PROOF_INVALID_TYPE",
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface StoredProof {
  storageKey: string;
  mimeType: ProofMimeType;
  sizeBytes: number;
  sha256: string;
}

export class ProofStore {
  constructor(private readonly directory: string) {}

  private pathFor(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new Error("Invalid proof storage key");
    return path.join(this.directory, storageKey);
  }

  /** Checks the bytes and writes them under a new name. Throws ProofFileError for bad files. */
  async save(bytes: Uint8Array): Promise<StoredProof> {
    if (bytes.length === 0) throw new ProofFileError("PROOF_EMPTY", 400, "The file is empty.");
    if (bytes.length > PROOF_MAX_BYTES) {
      throw new ProofFileError("PROOF_TOO_LARGE", 413, "The image is larger than 5 MB.");
    }
    const mimeType = detectProofType(bytes);
    if (!mimeType) {
      throw new ProofFileError("PROOF_INVALID_TYPE", 415, "Only PNG, JPEG or WebP images can be attached.");
    }

    const storageKey = `${randomUUID()}.${EXTENSIONS[mimeType]}`;
    await mkdir(this.directory, { recursive: true });
    // "wx": fail rather than overwrite, should a name ever repeat.
    await writeFile(this.pathFor(storageKey), bytes, { flag: "wx" });
    return {
      storageKey,
      mimeType,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.pathFor(storageKey));
  }

  /**
   * Only for cleaning up a file whose database row was never committed. Stored proofs are
   * never deleted (payment_proofs is append-only).
   */
  async discard(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }
}

/** The uploader's file name, kept for display only: no folders, no control characters, short. */
export function displayFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return cleaned === "" ? null : cleaned;
}
