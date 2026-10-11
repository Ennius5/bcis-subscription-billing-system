import { useState } from "react";
import { backupRestoreSchema } from "@bcis/shared";
import type { BackupListItemDto, IntegrityReportDto, RestoreResultDto } from "../../../preload/index";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { Badge } from "../ui/Badge";
import { TextField } from "../ui/TextField";

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One badge for the state that matters: can this backup be trusted? */
export function BackupStatusBadge({ backup }: { backup: BackupListItemDto }) {
  if (backup.status === "in_progress") return <Badge tone="warning">In progress</Badge>;
  if (backup.status === "failed") return <Badge tone="danger">Failed</Badge>;
  if (backup.verificationStatus === "passed") return <Badge tone="success">Verified</Badge>;
  return <Badge tone="danger">Damaged</Badge>;
}

export function canRestoreFrom(backup: BackupListItemDto): boolean {
  return backup.status === "completed" && backup.verificationStatus === "passed";
}

/** The integrity check as a checklist: text and color for every line, never color alone. */
export function IntegrityReportView({ report }: { report: IntegrityReportDto }) {
  return (
    <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-surface">
      {report.checks.map((check) => (
        <li key={check.code} className="flex items-start gap-3 px-3 py-2 text-sm">
          <span className="w-14 shrink-0">
            <Badge tone={check.passed ? "success" : "danger"}>{check.passed ? "Pass" : "Fail"}</Badge>
          </span>
          <span>
            <span className="font-medium text-ink">{check.label}</span>
            <span className="block text-xs text-muted">{check.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

interface RestoreFormProps {
  backup: BackupListItemDto;
  onRestored: (result: RestoreResultDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

/** The only screen in the system that replaces data, so it asks for the backup number by hand. */
export function RestoreForm({ backup, onRestored, onCancel, onExpired }: RestoreFormProps) {
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onRestored, onExpired);

  function submit() {
    const parsed = backupRestoreSchema.safeParse({ confirmBackupNumber: confirm, reason });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    if (parsed.data.confirmBackupNumber.toUpperCase() !== backup.backupNumber) {
      return reject({ confirmBackupNumber: `Type ${backup.backupNumber} exactly.` });
    }
    void save(() => window.bcis.backups.restore(backup.id, parsed.data));
  }

  return (
    <ProfileForm
      title={`Restore ${backup.backupNumber}`}
      submitLabel={`Replace all data with ${backup.backupNumber}`}
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <div className="rounded border border-danger/30 tint-danger px-3 py-2 text-sm text-ink">
        <p className="font-semibold text-danger">This replaces the data on every PC with the backup.</p>
        <ul className="mt-1 list-disc pl-5">
          <li>Everything recorded after {backup.backupNumber} was made disappears from the system.</li>
          <li>A safety backup of the current data is taken first, so this can be undone by restoring that copy.</li>
          <li>Everyone is locked out while it runs, then signed out on every PC, you included.</li>
          <li>Backup history and integrity check results are kept.</li>
        </ul>
      </div>
      {saving && (
        <p role="status" className="text-sm text-muted">
          Restoring. This can take a minute or two; do not close the app.
        </p>
      )}
      <div className="grid grid-cols-3 gap-3">
        <TextField
          label={`Type ${backup.backupNumber} to confirm`}
          value={confirm}
          onChange={setConfirm}
          required
          error={errors.confirmBackupNumber}
          maxLength={20}
          autoComplete="off"
        />
        <div className="col-span-2">
          <TextField label="Reason" value={reason} onChange={setReason} required error={errors.reason} hint="Required. Recorded in the audit log." maxLength={200} />
        </div>
      </div>
    </ProfileForm>
  );
}
