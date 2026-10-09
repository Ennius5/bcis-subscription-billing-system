import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SubscriberDto, SubscriberHistoryDto } from "../../../preload/index";
import { Badge } from "../ui/Badge";
import { DataTable } from "../ui/DataTable";
import { AssignmentForm } from "./AssignmentForm";
import { DetailsForm } from "./DetailsForm";
import { describeHistory, type HistoryLookups } from "./history";
import { StatusForm } from "./StatusForm";
import { contactTypeLabel, StatusBadge } from "./status";

const DATE_TIME = new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" });
const formatDateTime = (iso: string) => DATE_TIME.format(new Date(iso));

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100" onClick={onClick}>
      {label}
    </button>
  );
}

type Editing = "details" | "status" | "assignment" | null;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

function FlagBadges({ isPrimary, isActive }: { isPrimary: boolean; isActive: boolean }) {
  return (
    <span className="flex gap-1">
      {isPrimary && <Badge tone="success">Primary</Badge>}
      {!isActive && <Badge tone="neutral">Inactive</Badge>}
    </span>
  );
}

interface SubscriberProfileProps {
  subscriberId: string;
  canManage: boolean;
  onBack: () => void;
  onSessionExpired: () => void;
}

export function SubscriberProfile({ subscriberId, canManage, onBack, onSessionExpired }: SubscriberProfileProps) {
  const [subscriber, setSubscriber] = useState<SubscriberDto | null>(null);
  const [history, setHistory] = useState<SubscriberHistoryDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [areaNames, setAreaNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [collectorNames, setCollectorNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.bcis.subscribers.get(subscriberId),
      window.bcis.subscribers.history(subscriberId),
    ]).then(([detail, events]) => {
      if (cancelled) return;
      if (!detail.ok || !events.ok) {
        const failure = !detail.ok ? detail : !events.ok ? events : null;
        if (failure?.code === "UNAUTHENTICATED") onSessionExpired();
        else setLoadError(failure?.message ?? "Something went wrong.");
        return;
      }
      setSubscriber(detail.data);
      setHistory(events.data);
    });
    return () => {
      cancelled = true;
    };
  }, [subscriberId, onSessionExpired]);

  // Only used to name areas and collectors in the history. Needs collection.view;
  // without it the history falls back to "an area" / "a collector".
  useEffect(() => {
    void window.bcis.collectionAreas.list(true).then((r) => {
      if (r.ok) setAreaNames(new Map(r.data.map((a) => [a.id, a.code])));
    });
    void window.bcis.collectors.list(true).then((r) => {
      if (r.ok) setCollectorNames(new Map(r.data.map((c) => [c.id, `${c.code} – ${c.fullName}`])));
    });
  }, []);

  // Every change endpoint returns the updated subscriber; only the history needs a refetch.
  async function handleSaved(updated: SubscriberDto) {
    setSubscriber(updated);
    setEditing(null);
    const events = await window.bcis.subscribers.history(subscriberId);
    if (events.ok) setHistory(events.data);
    else if (events.code === "UNAUTHENTICATED") onSessionExpired();
  }

  // Hiding controls is cosmetic: the server enforces subscriber.manage and the archived rule.
  const editable = canManage && subscriber !== null && subscriber.status !== "archived";
  const formProps = subscriber && {
    subscriber,
    onSaved: (updated: SubscriberDto) => void handleSaved(updated),
    onCancel: () => setEditing(null),
    onExpired: onSessionExpired,
  };

  const lookups: HistoryLookups = useMemo(
    () => ({
      areas: areaNames,
      collectors: collectorNames,
      addresses: subscriber?.addresses ?? [],
      contacts: subscriber?.contacts ?? [],
    }),
    [areaNames, collectorNames, subscriber],
  );

  return (
    <div>
      <button className="mb-4 text-sm text-accent hover:underline" onClick={onBack}>
        ← Back to subscribers
      </button>

      {loadError && (
        <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load the subscriber. {loadError}
        </p>
      )}
      {!subscriber && !loadError && <p className="text-muted">Loading…</p>}

      {subscriber && formProps && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="flex flex-wrap items-center gap-3 text-xl font-semibold text-navy">
              {subscriber.fullName}
              <span className="font-normal text-muted">{subscriber.accountNumber}</span>
              <StatusBadge status={subscriber.status} />
            </h1>
            {editable && editing === null && (
              <ActionButton label="Change status" onClick={() => setEditing("status")} />
            )}
          </div>

          {subscriber.status === "archived" && (
            <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-muted">
              This account is archived. Its record is read-only.
            </p>
          )}

          {editing === "status" && <StatusForm {...formProps} />}
          {editing === "details" && <DetailsForm {...formProps} />}
          {editing === "assignment" && <AssignmentForm {...formProps} />}

          <div className="grid grid-cols-2 gap-4">
            <Section
              title="Details"
              action={editable && editing === null && <ActionButton label="Edit" onClick={() => setEditing("details")} />}
            >
              <dl className="grid grid-cols-2 gap-3">
                <Field label="Billing day">Day {subscriber.billingDay} of each month</Field>
                <Field label="Customer since">{formatDateTime(subscriber.createdAt)}</Field>
                <div className="col-span-2">
                  <Field label="Notes">
                    {subscriber.notes ? (
                      <span className="whitespace-pre-wrap">{subscriber.notes}</span>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </Field>
                </div>
              </dl>
            </Section>

            <Section
              title="Collection assignment"
              action={
                editable && editing === null && <ActionButton label="Change" onClick={() => setEditing("assignment")} />
              }
            >
              <dl className="grid grid-cols-2 gap-3">
                <Field label="Area">
                  {subscriber.areaCode ? `${subscriber.areaCode} – ${subscriber.areaName}` : "Not assigned"}
                </Field>
                <Field label="Collector">
                  {subscriber.collectorCode
                    ? `${subscriber.collectorCode} – ${subscriber.collectorName}`
                    : "Not assigned"}
                </Field>
              </dl>
            </Section>
          </div>

          <Section title="Addresses">
            <DataTable
              columns={[
                { key: "label", header: "Label", render: (a) => a.label ?? "—" },
                { key: "line1", header: "Street or purok", render: (a) => a.line1 },
                { key: "barangay", header: "Barangay", render: (a) => a.barangay },
                {
                  key: "city",
                  header: "City",
                  render: (a) => (a.province ? `${a.city}, ${a.province}` : a.city),
                },
                { key: "landmark", header: "Landmark", render: (a) => a.landmark ?? "—" },
                { key: "flags", header: "", render: (a) => <FlagBadges {...a} /> },
              ]}
              rows={subscriber.addresses}
              getRowKey={(a) => a.id}
              emptyMessage="No addresses."
            />
          </Section>

          <Section title="Contacts">
            <DataTable
              columns={[
                { key: "type", header: "Type", render: (c) => contactTypeLabel(c.type) },
                { key: "value", header: "Value", render: (c) => c.value },
                { key: "name", header: "Contact name", render: (c) => c.contactName ?? "—" },
                { key: "flags", header: "", render: (c) => <FlagBadges {...c} /> },
              ]}
              rows={subscriber.contacts}
              getRowKey={(c) => c.id}
              emptyMessage="No contacts on file."
            />
          </Section>

          <Section title="History">
            {history.length === 0 ? (
              <p className="text-sm text-muted">No recorded changes.</p>
            ) : (
              <ol className="divide-y divide-slate-100">
                {history.map((row) => {
                  const entry = describeHistory(row, lookups);
                  return (
                    <li key={row.id} className="py-2 text-sm">
                      <div className="flex justify-between gap-4">
                        <span className="font-medium text-ink">{entry.title}</span>
                        <span className="shrink-0 text-xs text-muted">{formatDateTime(row.occurredAt)}</span>
                      </div>
                      {entry.details.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-ink">
                          {entry.details.map((detail, i) => (
                            <li key={i}>{detail}</li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-1 text-xs text-muted">
                        By {row.actorName ?? row.actorUsername ?? "system"}
                        {row.reason && <> · Reason: {row.reason}</>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
