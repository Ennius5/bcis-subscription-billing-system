import type { FastifyReply } from "fastify";
import { REPORT_EXPORT_CONTENT_TYPES, type ReportExportFormat, reportFileName } from "@bcis/shared";
import { writeAudit } from "../audit/audit";
import type { AuthContext } from "../auth/authenticate";
import type { Db } from "../db/client";
import { type ReportDocument, rowCount } from "./document";
import { renderPdf } from "./render-pdf";
import { renderXlsx } from "./render-xlsx";

/**
 * Renders the report, records the export in the audit log, then sends the file as a download.
 * The audit row is written after rendering (a failed render is not an export) and before the
 * file leaves the server (no unaudited export). `filters` is the validated query as sent.
 */
export async function sendReportExport(
  reply: FastifyReply,
  db: Db,
  auth: AuthContext,
  doc: ReportDocument,
  format: ReportExportFormat,
  filters: Record<string, unknown>,
): Promise<FastifyReply> {
  const meta = { generatedAt: new Date(), generatedBy: auth.fullName || auth.username };
  const file = format === "pdf" ? await renderPdf(doc, meta) : await renderXlsx(doc, meta);
  const fileName = reportFileName(doc.slug, doc.fileDate, format);

  await writeAudit(db, {
    actorUserId: auth.userId,
    action: "report.export",
    entityType: "report",
    entityId: doc.slug,
    newValues: { format, fileName, filters, rows: rowCount(doc), bytes: file.length },
  });

  return reply
    .header("content-type", REPORT_EXPORT_CONTENT_TYPES[format])
    .header("content-disposition", `attachment; filename="${fileName}"`)
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .send(file);
}
