import { useEffect, useState } from "react";
import { formatPesos, gcashRejectSchema } from "@bcis/shared";
import type { GcashSubmissionDto } from "../../../preload/index";
import { useSave } from "../service-accounts/useSave";
import { ProfileForm, schemaErrors } from "../subscribers/ProfileForm";
import { Field, formatDateTime, RowError } from "../subscribers/ProfileParts";
import { Badge, type BadgeTone } from "../ui/Badge";
import { TextField } from "../ui/TextField";

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: "Pending", tone: "warning" },
  verified: { label: "Verified", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  reversed: { label: "Reversed", tone: "neutral" },
};

export function GcashStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

interface GcashDetailProps {
  submissionId: string;
  canAttach: boolean;
  canVerify: boolean;
  /** Called after anything changes, so the queue can refresh. */
  onChanged: () => void;
  onSessionExpired: () => void;
}

type Mode = "view" | "confirmVerify" | "reject";

/** The right-hand pane: what the customer reported, the proof image, and the decision. */
export function GcashDetail({ submissionId, canAttach, canVerify, onChanged, onSessionExpired }: GcashDetailProps) {
  const [submission, setSubmission] = useState<GcashSubmissionDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shownProofId, setShownProofId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.gcash.get(submissionId).then((r) => {
      if (cancelled) return;
      if (r.ok) setSubmission(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setLoadError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [submissionId, onSessionExpired]);

  function updated(next: GcashSubmissionDto, message: string | null = null) {
    setSubmission(next);
    setMode("view");
    setNotice(message);
    onChanged();
  }

  async function attach() {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    const r = await window.bcis.gcash.attachProof(submissionId);
    setBusy(false);
    if (r.ok) {
      setShownProofId(r.data.proofs.at(-1)?.id ?? null);
      updated(r.data, "Proof image attached. Compare it with the details before verifying.");
    } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
    else if (r.code !== "CANCELLED") setActionError(r.message);
  }

  async function verify() {
    setBusy(true);
    setActionError(null);
    const r = await window.bcis.gcash.verify(submissionId);
    setBusy(false);
    if (r.ok) updated(r.data, `Verified and posted as ${r.data.payment?.receiptNumber ?? "a payment"}.`);
    else if (r.code === "UNAUTHENTICATED") onSessionExpired();
    else {
      setMode("view");
      setActionError(r.message);
    }
  }

  if (loadError) return <RowError message={`Could not load the submission. ${loadError}`} />;
  if (!submission) return <p className="text-muted">Loading…</p>;

  const pending = submission.status === "pending";
  const proofId = shownProofId ?? submission.proofs[0]?.id ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-3 text-lg font-semibold text-navy">
          {submission.referenceNumber}
          <GcashStatusBadge status={submission.status} />
        </h2>
        {pending && mode === "view" && (
          <div className="flex flex-wrap gap-2">
            {canAttach && (
              <button
                className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
                disabled={busy}
                onClick={() => void attach()}
              >
                Attach image
              </button>
            )}
            {canVerify && (
              <>
                <button
                  className="rounded bg-navy px-3 py-1.5 text-sm font-medium text-white hover:bg-navy/90 disabled:opacity-50"
                  disabled={busy || submission.proofCount === 0}
                  title={submission.proofCount === 0 ? "Attach the proof image first." : undefined}
                  onClick={() => setMode("confirmVerify")}
                >
                  Verify…
                </button>
                <button
                  className="rounded border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-danger/5 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => setMode("reject")}
                >
                  Reject…
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {actionError && <RowError message={actionError} />}
      {notice && (
        <p aria-live="polite" className="rounded border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          {notice}
        </p>
      )}

      {mode === "confirmVerify" && (
        <div className="rounded-lg border border-accent/30 bg-slate-50 p-4 text-sm">
          <p className="text-ink">
            Post <strong className="money">{formatPesos(submission.amountCentavos)}</strong> from{" "}
            <strong>{submission.subscriberName}</strong> ({submission.accountNumber}), paid on{" "}
            <strong>{submission.transactionDate}</strong>?
          </p>
          <p className="mt-1 text-muted">
            Only verify after checking the reference and amount in the GCash transaction history. A screenshot alone is
            not proof of payment.
          </p>
          <div className="mt-3 flex gap-3">
            <button
              className="rounded bg-navy px-4 py-2 font-medium text-white hover:bg-navy/90 disabled:opacity-50"
              disabled={busy}
              onClick={() => void verify()}
            >
              {busy ? "Posting…" : "Yes, verify and post"}
            </button>
            <button
              className="rounded border border-slate-300 px-4 py-2 text-ink hover:bg-white"
              disabled={busy}
              onClick={() => setMode("view")}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "reject" && (
        <RejectForm
          submission={submission}
          onSaved={(next) => updated(next, "Submission rejected. Nothing was posted.")}
          onCancel={() => setMode("view")}
          onExpired={onSessionExpired}
        />
      )}

      <dl className="grid grid-cols-3 gap-3 rounded-lg border border-slate-200 bg-surface p-4">
        <Field label="Subscriber">
          {submission.subscriberName}
          <span className="block text-xs text-muted">{submission.accountNumber}</span>
        </Field>
        <Field label="Amount">
          <span className="money block text-left font-semibold">{formatPesos(submission.amountCentavos)}</span>
        </Field>
        <Field label="Transaction date">{submission.transactionDate}</Field>
        <Field label="Sender">{submission.senderName}</Field>
        <Field label="Sender number">{submission.senderNumber}</Field>
        <Field label="Recorded">
          {formatDateTime(submission.recordedAt)}
          <span className="block text-xs text-muted">by {submission.recordedByName}</span>
        </Field>
        {submission.reviewedAt && (
          <Field label={submission.status === "rejected" ? "Rejected" : "Verified"}>
            {formatDateTime(submission.reviewedAt)}
            <span className="block text-xs text-muted">by {submission.reviewedByName}</span>
          </Field>
        )}
        {submission.payment && (
          <Field label="Receipt">
            {submission.payment.receiptNumber}
            {submission.payment.status === "reversed" && <span className="block text-xs text-danger">Reversed</span>}
          </Field>
        )}
        {submission.rejectionReason && <Field label="Rejection reason">{submission.rejectionReason}</Field>}
        {submission.notes && <Field label="Notes">{submission.notes}</Field>}
      </dl>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Proof</h3>
          {submission.proofs.length > 1 &&
            submission.proofs.map((p, i) => (
              <button
                key={p.id}
                className={`rounded px-2 py-0.5 text-xs ${p.id === proofId ? "bg-navy text-white" : "border border-slate-300 hover:bg-slate-50"}`}
                onClick={() => setShownProofId(p.id)}
              >
                Image {i + 1}
              </button>
            ))}
        </div>
        {proofId ? (
          <ProofImage key={proofId} proofId={proofId} onSessionExpired={onSessionExpired} />
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 px-3 py-8 text-center text-sm text-muted">
            No proof image yet.{pending && canAttach ? " Use Attach image to add the customer's screenshot." : ""}
          </p>
        )}
      </section>
    </div>
  );
}

function ProofImage({ proofId, onSessionExpired }: { proofId: string; onSessionExpired: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.bcis.gcash.proofImage(proofId).then((r) => {
      if (cancelled) return;
      if (r.ok) setSrc(r.data);
      else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [proofId, onSessionExpired]);

  if (error) return <RowError message={`Could not load the image. ${error}`} />;
  if (!src) return <p className="text-sm text-muted">Loading image…</p>;
  return (
    <img
      src={src}
      alt="Customer's GCash proof of payment"
      className="max-h-[32rem] rounded-lg border border-slate-200 bg-white object-contain"
    />
  );
}

interface RejectFormProps {
  submission: GcashSubmissionDto;
  onSaved: (next: GcashSubmissionDto) => void;
  onCancel: () => void;
  onExpired: () => void;
}

function RejectForm({ submission, onSaved, onCancel, onExpired }: RejectFormProps) {
  const [reason, setReason] = useState("");
  const { errors, formError, saving, reject, save } = useSave(onSaved, onExpired);

  function submit() {
    const parsed = gcashRejectSchema.safeParse({ reason });
    if (!parsed.success) return reject(schemaErrors(parsed.error));
    void save(() => window.bcis.gcash.reject(submission.id, parsed.data.reason));
  }

  return (
    <ProfileForm
      title={`Reject ${submission.referenceNumber}`}
      submitLabel="Reject"
      saving={saving}
      error={formError}
      onSubmit={submit}
      onCancel={onCancel}
    >
      <TextField
        label="Reason"
        value={reason}
        onChange={setReason}
        required
        error={errors.reason}
        hint="e.g. not found in the GCash history, or the amount does not match. The reference becomes free again."
        maxLength={200}
      />
    </ProfileForm>
  );
}
