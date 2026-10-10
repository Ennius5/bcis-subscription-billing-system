import { useState } from "react";
import type { ApiResult, ExportFormat, SavedExportDto } from "../../../preload/index";

interface ExportButtonsProps {
  /** Calls the report's export IPC with the screen's current filters. */
  onExport: (format: ExportFormat) => Promise<ApiResult<SavedExportDto>>;
  onExpired: () => void;
  disabled?: boolean;
}

type Status = { kind: "idle" } | { kind: "busy"; format: ExportFormat } | { kind: "saved"; file: SavedExportDto } | { kind: "error"; message: string };

const BUTTON = "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50";

/**
 * "Export PDF" / "Export Excel" for report screens. Main asks where to save, the server builds
 * the file from the same data the screen shows and audits the export. Reports print from the
 * PDF: "Open" shows the saved file in its default program.
 */
export function ExportButtons({ onExport, onExpired, disabled = false }: ExportButtonsProps) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "busy";

  async function run(format: ExportFormat) {
    setStatus({ kind: "busy", format });
    const r = await onExport(format);
    if (r.ok) setStatus({ kind: "saved", file: r.data });
    else if (r.code === "CANCELLED") setStatus({ kind: "idle" });
    else if (r.code === "UNAUTHENTICATED") onExpired();
    else setStatus({ kind: "error", message: r.message });
  }

  async function open() {
    const r = await window.bcis.exports.openLast();
    if (!r.ok) setStatus({ kind: "error", message: `Could not open the file. ${r.message}` });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button className={BUTTON} disabled={disabled || busy} onClick={() => void run("pdf")}>
          {status.kind === "busy" && status.format === "pdf" ? "Exporting…" : "Export PDF"}
        </button>
        <button className={BUTTON} disabled={disabled || busy} onClick={() => void run("xlsx")}>
          {status.kind === "busy" && status.format === "xlsx" ? "Exporting…" : "Export Excel"}
        </button>
      </div>
      {status.kind === "saved" && (
        <p role="status" className="text-xs text-success">
          Saved {status.file.fileName}.{" "}
          <button className="underline hover:no-underline" onClick={() => void open()}>
            {status.file.format === "pdf" ? "Open to print" : "Open"}
          </button>
        </p>
      )}
      {status.kind === "error" && (
        <p role="alert" className="text-xs text-danger">
          {status.message}
        </p>
      )}
    </div>
  );
}
