import { eq } from "drizzle-orm";
import type { Tx } from "./query_helpers";
import { documentSequences } from "./schema";

const NUMBER_DIGITS = 6;

/**
 * Takes the next `count` numbers of a document series ("invoice" -> INV-000001, ...).
 *
 * The counter row is locked until the caller's transaction ends, so two PCs finalizing at
 * the same moment wait for each other instead of sharing a number. If the transaction rolls
 * back, the counter rolls back with it, so numbers are never skipped (unlike a sequence).
 */
export async function takeDocumentNumbers(tx: Tx, series: string, count: number): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid number count: ${count}`);

  const [row] = await tx.select().from(documentSequences).where(eq(documentSequences.name, series)).for("update");
  if (!row) throw new Error(`Document series not set up: ${series}`);

  await tx
    .update(documentSequences)
    .set({ nextValue: row.nextValue + count })
    .where(eq(documentSequences.name, series));

  return Array.from({ length: count }, (_, k) => `${row.prefix}${String(row.nextValue + k).padStart(NUMBER_DIGITS, "0")}`);
}
