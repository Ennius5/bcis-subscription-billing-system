import { useCallback, useEffect, useState } from "react";
import { BACKUP_KIND_LABELS, BACKUP_STALE_AFTER_HOURS } from "@bcis/shared";
import type {
  ApiResult,
  BackupListDto,
  BackupListItemDto,
  IntegrityCheckRunDto,
  IntegrityReportDto,
  RestoreResultDto,
} from "../../../preload/index";
import { formatDateTime, RowError } from "../subscribers/ProfileParts";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { BackupStatusBadge, canRestoreFrom, formatBytes, IntegrityReportView, RestoreForm } from "./BackupParts";

interface BackupScreenProps {
  canRestore: boolean;
  onSessionExpired: () => void;
}

/** What the last action produced, shown above the lists until the next action. */
interface Outcome {
  tone: "success" | "danger";
  text: string;
  report?: IntegrityReportDto;
}

const SCOPE_TEXT: Record<string, (backupNumber: string | null) => string> = {
  live: () => "Live data",
  test_restore: (n) => `Test restore of ${n ?? "?"}`,
  after_restore: (n) => `After restoring ${n ?? "?"}`,
};

const actionClass = "btn btn-secondary btn-xs";

export function BackupScreen({ canRestore, onSessionExpired }: BackupScreenProps) {
  const [list, setList] = useState<BackupListDto | null>(null);
  const [checks, setChecks] = useState<IntegrityCheckRunDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Backups, verifications and test restores take seconds to minutes: one at a time, clearly labelled.
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [note, setNote] = useState("");
  const [details, setDetails] = useState<string | null>(null);
  const [shownCheck, setShownCheck] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupListItemDto | null>(null);
  const [restored, setRestored] = useState<RestoreResultDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.bcis.backups.list(), window.bcis.integrity.list()]).then(([backups, runs]) => {
      if (cancelled) return;
      if (!backups.ok && backups.code === "UNAUTHENTICATED") return onSessionExpired();
      if (backups.ok) setList(backups.data);
      if (runs.ok) setChecks(runs.data);
      setLoadError(!backups.ok ? backups.message : !runs.ok ? runs.message : null);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, onSessionExpired]);

  /** Runs one long action; maps the answer to an outcome line and reloads both lists. */
  const run = useCallback(
    async <T,>(label: string, call: () => Promise<ApiResult<T>>, describe: (data: T) => Outcome) => {
      setBusy(label);
      setOutcome(null);
      const result = await call();
      setBusy(null);
      if (!result.ok && result.code === "UNAUTHENTICATED") return onSessionExpired();
      setOutcome(result.ok ? describe(result.data) : { tone: "danger", text: result.message });
      setReloadKey((k) => k + 1);
    },
    [onSessionExpired],
  );

  function backUpNow() {
    const trimmed = note.trim();
    void run("Making a backup", () => window.bcis.backups.create(trimmed ? { note: trimmed } : {}), (b) => {
      setNote("");
      return b.verificationStatus === "passed"
        ? { tone: "success", text: `${b.backupNumber} saved and verified (${formatBytes(b.databaseBytes)}, ${b.proofFileCount ?? 0} proof images).` }
        : { tone: "danger", text: `${b.backupNumber} was saved but did not pass verification: ${b.verificationMessage ?? ""}` };
    });
  }

  if (restored) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold text-navy">Restore complete</h1>
        <p className="mt-2 text-sm text-ink">
          The data now matches <strong>{restored.backupNumber}</strong>. The data from just before the restore was saved
          as <strong>{restored.safetyBackupNumber}</strong>. Everyone has been signed out, including you.
        </p>
        <h2 className="mt-4 mb-2 text-sm font-semibold text-navy">
          Integrity check after the restore:{" "}
          <Badge tone={restored.report.passed ? "success" : "danger"}>{restored.report.passed ? "Passed" : "Failed"}</Badge>
        </h2>
        <IntegrityReportView report={restored.report} />
        <button
          onClick={onSessionExpired}
          className="btn btn-primary mt-4"
        >
          Sign in again
        </button>
      </div>
    );
  }

  const disabled = busy !== null || restoreTarget !== null;

  const columns: Column<BackupListItemDto>[] = [
    {
      key: "number",
      header: "Backup",
      render: (b) => (
        <span>
          <span className="font-medium">{b.backupNumber}</span>
          <span className="block text-xs text-muted">{BACKUP_KIND_LABELS[b.kind] ?? b.kind}</span>
        </span>
      ),
    },
    {
      key: "made",
      header: "Made",
      render: (b) => (
        <span>
          {formatDateTime(b.startedAt)}
          <span className="block text-xs text-muted">{b.createdByName ?? "Scheduled task"}</span>
        </span>
      ),
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      render: (b) =>
        b.status === "completed" ? (
          <span>
            {formatBytes(b.databaseBytes)}
            <span className="block text-xs text-muted">{b.proofFileCount} proof images</span>
          </span>
        ) : (
          "—"
        ),
    },
    { key: "status", header: "Status", render: (b) => <BackupStatusBadge backup={b} /> },
    {
      key: "test",
      header: "Test restore",
      render: (b) =>
        b.lastTestRestore ? (
          <span>
            <Badge tone={b.lastTestRestore.passed ? "success" : "danger"}>{b.lastTestRestore.passed ? "Passed" : "Failed"}</Badge>
            <span className="block text-xs text-muted">{formatDateTime(b.lastTestRestore.ranAt)}</span>
          </span>
        ) : (
          <span className="text-xs text-muted">Not tested</span>
        ),
    },
    {
      key: "actions",
      header: "",
      render: (b) => (
        <span className="flex flex-wrap justify-end gap-1">
          <button className={actionClass} onClick={() => setDetails(details === b.id ? null : b.id)}>
            {details === b.id ? "Hide details" : "Details"}
          </button>
          {b.status === "completed" && (
            <>
              <button
                className={actionClass}
                disabled={disabled}
                onClick={() =>
                  void run(`Verifying ${b.backupNumber}`, () => window.bcis.backups.verify(b.id), (v) =>
                    v.verificationStatus === "passed"
                      ? { tone: "success", text: `${v.backupNumber}: checksums match and the dump is readable.` }
                      : { tone: "danger", text: `${v.backupNumber} is damaged: ${v.verificationMessage ?? ""}` },
                  )
                }
              >
                Verify again
              </button>
              <button
                className={actionClass}
                disabled={disabled || !canRestoreFrom(b)}
                onClick={() =>
                  void run(`Test-restoring ${b.backupNumber}`, () => window.bcis.backups.testRestore(b.id), (report) => ({
                    tone: report.passed ? "success" : "danger",
                    text: report.passed
                      ? `${b.backupNumber} restores cleanly: every check passed in the test copy. Live data was not touched.`
                      : `${b.backupNumber} did not pass the test restore. Live data was not touched.`,
                    report,
                  }))
                }
              >
                Test restore
              </button>
              {canRestore && (
                <button
                  className="btn btn-danger btn-xs"
                  disabled={disabled || !canRestoreFrom(b)}
                  onClick={() => {
                    setOutcome(null);
                    setRestoreTarget(b);
                  }}
                >
                  Restore…
                </button>
              )}
            </>
          )}
        </span>
      ),
    },
  ];

  const detailRow = list?.items.find((b) => b.id === details);
  const shownRun = checks.find((c) => c.id === shownCheck);

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold text-navy">Backup &amp; Restore</h1>
          <p className="text-sm text-muted">
            Each backup holds the database, the payment proof images and a checksum manifest. Backups are kept on the
            server; copy the folders to an external drive regularly.
          </p>
        </div>
        <button
          className="btn btn-secondary shrink-0"
          disabled={disabled}
          onClick={() =>
            void run("Checking the live data", () => window.bcis.integrity.run(), (report) => ({
              tone: report.passed ? "success" : "danger",
              text: report.passed ? "Integrity check passed on the live data." : "Integrity check found problems in the live data.",
              report,
            }))
          }
        >
          Run integrity check
        </button>
      </div>

      {list?.stale && (
        <p role="alert" className="mb-4 rounded border border-warning/40 tint-warning px-3 py-2 text-sm text-ink">
          <strong className="text-warning">No good backup in the last {BACKUP_STALE_AFTER_HOURS} hours.</strong>{" "}
          {list.lastGoodBackupAt ? `The last verified backup is from ${formatDateTime(list.lastGoodBackupAt)}.` : "There is no verified backup yet."}{" "}
          Make one now, and check that the scheduled task is running.
        </p>
      )}

      <form
        className="panel mb-4 flex items-end gap-3 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          backUpNow();
        }}
      >
        <label className="block flex-1 text-sm font-medium text-ink">
          Note (optional)
          <input
            className="field"
            value={note}
            maxLength={200}
            disabled={disabled}
            placeholder="e.g. Before month-end billing"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={disabled}
          className="btn btn-accent"
        >
          Back up now
        </button>
      </form>

      {busy && (
        <p role="status" className="mb-4 rounded border border-accent/30 tint-accent px-3 py-2 text-sm text-ink">
          {busy}… This can take a minute. Other staff can keep working.
        </p>
      )}

      {outcome && (
        <div
          role="status"
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            outcome.tone === "success" ? "border-success/30 tint-success" : "border-danger/30 tint-danger"
          }`}
        >
          <p className={outcome.tone === "success" ? "text-ink" : "text-danger"}>{outcome.text}</p>
          {outcome.report && (
            <div className="mt-2">
              <IntegrityReportView report={outcome.report} />
            </div>
          )}
        </div>
      )}

      {restoreTarget && (
        <RestoreForm
          backup={restoreTarget}
          onRestored={setRestored}
          onCancel={() => setRestoreTarget(null)}
          onExpired={onSessionExpired}
        />
      )}

      {loadError && <RowError message={`Could not load backups. ${loadError}`} />}

      {list === null ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <DataTable columns={columns} rows={list.items} getRowKey={(b) => b.id} emptyMessage="No backups yet. Make the first one now." />
      )}

      {detailRow && (
        <dl className="panel mt-3 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 p-4 text-sm">
          <dt className="text-muted">Folder</dt>
          <dd className="font-mono text-xs">{detailRow.folderName}</dd>
          <dt className="text-muted">Note</dt>
          <dd>{detailRow.note ?? "—"}</dd>
          <dt className="text-muted">Finished</dt>
          <dd>{detailRow.completedAt ? formatDateTime(detailRow.completedAt) : "—"}</dd>
          <dt className="text-muted">Proof images</dt>
          <dd>{detailRow.proofFileCount === null ? "—" : `${detailRow.proofFileCount} (${formatBytes(detailRow.proofBytes)})`}</dd>
          <dt className="text-muted">Last verified</dt>
          <dd>
            {detailRow.verifiedAt ? formatDateTime(detailRow.verifiedAt) : "—"}
            {detailRow.verificationMessage && <span className="block text-xs text-muted">{detailRow.verificationMessage}</span>}
          </dd>
          {detailRow.errorMessage && (
            <>
              <dt className="text-muted">Error</dt>
              <dd className="text-danger">{detailRow.errorMessage}</dd>
            </>
          )}
        </dl>
      )}

      <h2 className="mt-8 mb-2 text-base font-semibold text-navy">Recent integrity checks</h2>
      <DataTable
        columns={[
          { key: "when", header: "When", render: (c: IntegrityCheckRunDto) => formatDateTime(c.ranAt) },
          { key: "what", header: "Checked", render: (c) => (SCOPE_TEXT[c.scope] ?? (() => c.scope))(c.backupNumber) },
          { key: "who", header: "By", render: (c) => c.runByName ?? "—" },
          {
            key: "result",
            header: "Result",
            render: (c) => <Badge tone={c.passed ? "success" : "danger"}>{c.passed ? "Passed" : "Failed"}</Badge>,
          },
          {
            key: "show",
            header: "",
            render: (c) => (
              <button className={actionClass} onClick={() => setShownCheck(shownCheck === c.id ? null : c.id)}>
                {shownCheck === c.id ? "Hide" : "Show checks"}
              </button>
            ),
          },
        ]}
        rows={checks}
        getRowKey={(c) => c.id}
        emptyMessage="No integrity check has been run yet."
      />
      {shownRun && (
        <div className="mt-3">
          <IntegrityReportView report={shownRun} />
        </div>
      )}
    </div>
  );
}
