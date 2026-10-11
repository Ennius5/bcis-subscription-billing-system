import { useEffect, useState } from "react";
import { formatPesos, SUBSCRIBER_CONTACTS_MAX, type PermissionCode } from "@bcis/shared";
import type {
  ServiceAccountDto,
  SubscriberAddressDto,
  SubscriberContactDto,
  SubscriberDto,
  SubscriberHistoryDto,
} from "../../../preload/index";
import { Badge } from "../ui/Badge";
import { DataTable } from "../ui/DataTable";
import { AddServiceForm } from "./AddServiceForm";
import { AddressForm } from "./AddressForm";
import { AssignmentForm } from "./AssignmentForm";
import { ContactForm } from "./ContactForm";
import { DetailsForm } from "./DetailsForm";
import { ActionButton, Field, formatDateTime, RowError, Section } from "./ProfileParts";
import { balanceText, LedgerSection } from "../billing/LedgerSection";
import { ServiceAccountScreen } from "../service-accounts/ServiceAccountScreen";
import { StatusForm } from "./StatusForm";
import { contactTypeLabel, serviceTypeLabel, StatusBadge } from "./status";
import { ProfileTabBar, visibleProfileTabs, type ProfileTab } from "./ProfileTabs";
import { AuditTab } from "./tabs/AuditTab";
import { BillingTab } from "./tabs/BillingTab";
import { CollectionTab } from "./tabs/CollectionTab";
import { DocumentsTab } from "./tabs/DocumentsTab";
import { HistoryTab } from "./tabs/HistoryTab";
import { PaymentsTab } from "./tabs/PaymentsTab";

type Editing =
  | { kind: "details" | "status" | "assignment" | "service" }
  | { kind: "address"; address: SubscriberAddressDto | null } // null = add
  | { kind: "contact"; contact: SubscriberContactDto | null }
  | null;

type RowAction = "primary" | "deactivate" | "reactivate";

const ROW_ACTION_CHANGES: Record<RowAction, Record<string, boolean>> = {
  primary: { isPrimary: true },
  deactivate: { isActive: false },
  reactivate: { isActive: true },
};

/** Only offers the actions the server would accept for this row. */
function RowActions({
  item,
  canReactivate,
  onEdit,
  onAction,
}: {
  item: { isPrimary: boolean; isActive: boolean };
  canReactivate: boolean;
  onEdit: () => void;
  onAction: (action: RowAction) => void;
}) {
  return (
    <span className="flex justify-end gap-1">
      {item.isActive && <ActionButton label="Edit" onClick={onEdit} />}
      {item.isActive && !item.isPrimary && <ActionButton label="Make primary" onClick={() => onAction("primary")} />}
      {item.isActive && !item.isPrimary && <ActionButton label="Deactivate" onClick={() => onAction("deactivate")} />}
      {!item.isActive && canReactivate && <ActionButton label="Reactivate" onClick={() => onAction("reactivate")} />}
    </span>
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
  /** Decides which tabs and buttons show; the server checks every request again. */
  permissions: readonly PermissionCode[];
  onBack: () => void;
  onSessionExpired: () => void;
}

export function SubscriberProfile({ subscriberId, permissions, onBack, onSessionExpired }: SubscriberProfileProps) {
  const canManage = permissions.includes("subscriber.manage");
  const canViewServices = permissions.includes("service.view");
  const canViewBilling = permissions.includes("billing.view");
  const canManageServices = permissions.includes("service.manage");
  const canControlServices = permissions.includes("suspension.manage");
  const tabs = visibleProfileTabs(permissions);

  const [tab, setTab] = useState<ProfileTab>("overview");
  const [subscriber, setSubscriber] = useState<SubscriberDto | null>(null);
  const [services, setServices] = useState<ServiceAccountDto[] | null>(null);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [servicesKey, setServicesKey] = useState(0);
  // Third level: a service account opened from this profile.
  const [openServiceId, setOpenServiceId] = useState<string | null>(null);
  const [history, setHistory] = useState<SubscriberHistoryDto[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [rowError, setRowError] = useState<{ section: "address" | "contact"; message: string } | null>(null);
  const [rowBusy, setRowBusy] = useState(false);
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

  // The Overview shows the ledger balance (owed, or a credit); needs billing.view.
  useEffect(() => {
    if (!canViewBilling) return;
    let cancelled = false;
    void window.bcis.billing.ledger(subscriberId, {}).then((r) => {
      if (!cancelled && r.ok) setBalance(r.data.closingBalanceCentavos);
    });
    return () => {
      cancelled = true;
    };
  }, [subscriberId, canViewBilling, tab]);

  // A subscriber has a handful of services, so one page of 100 is all of them.
  useEffect(() => {
    if (!canViewServices) return;
    let cancelled = false;
    void window.bcis.serviceAccounts.list({ subscriberId, pageSize: 100 }).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setServices(r.data.items);
        setServicesError(null);
      } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
      else setServicesError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [subscriberId, canViewServices, servicesKey, onSessionExpired]);

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
    setRowError(null);
    const events = await window.bcis.subscribers.history(subscriberId);
    if (events.ok) setHistory(events.data);
    else if (events.code === "UNAUTHENTICATED") onSessionExpired();
  }

  // One-click row changes: make primary, deactivate, reactivate.
  async function runRowAction(section: "address" | "contact", id: string, action: RowAction) {
    if (rowBusy) return;
    setRowBusy(true);
    setRowError(null);
    const changes = ROW_ACTION_CHANGES[action];
    const result =
      section === "address"
        ? await window.bcis.subscribers.updateAddress(subscriberId, id, changes)
        : await window.bcis.subscribers.updateContact(subscriberId, id, changes);
    setRowBusy(false);
    if (result.ok) return void handleSaved(result.data);
    if (result.code === "UNAUTHENTICATED") return onSessionExpired();
    setRowError({ section, message: result.message });
  }

  function selectTab(next: ProfileTab) {
    setEditing(null);
    setRowError(null);
    setTab(next);
  }

  // Hiding controls is cosmetic: the server enforces subscriber.manage and the archived rule.
  const editable = canManage && subscriber !== null && subscriber.status !== "archived";
  const rowsEditable = editable && editing === null && !rowBusy;
  // Matches the server: inactive subscribers may get a service, terminated and archived may not.
  const canAddService =
    canManageServices &&
    editing === null &&
    subscriber !== null &&
    subscriber.status !== "terminated" &&
    subscriber.status !== "archived";
  const activeContacts = subscriber?.contacts.filter((c) => c.isActive).length ?? 0;
  const contactsFull = activeContacts >= SUBSCRIBER_CONTACTS_MAX;
  const formProps = subscriber && {
    subscriber,
    onSaved: (updated: SubscriberDto) => void handleSaved(updated),
    onCancel: () => setEditing(null),
    onExpired: onSessionExpired,
  };

  return (
    <>
      {openServiceId && (
        <ServiceAccountScreen
          key={openServiceId}
          serviceAccountId={openServiceId}
          canManage={canManageServices}
          canControl={canControlServices}
          backLabel={subscriber ? `Back to ${subscriber.fullName}` : "Back to subscriber"}
          onBack={() => {
            setOpenServiceId(null);
            setServicesKey((k) => k + 1); // the service screen may have changed its row here
          }}
          onSessionExpired={onSessionExpired}
        />
      )}
      {/* The profile stays mounted while a service is open, so it keeps its place. */}
      <div hidden={openServiceId !== null}>
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
                <ActionButton label="Change status" onClick={() => setEditing({ kind: "status" })} />
              )}
            </div>

            {subscriber.status === "archived" && (
              <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-muted">
                This account is archived. Its record is read-only.
              </p>
            )}

            {editing?.kind === "status" && <StatusForm {...formProps} />}

            <ProfileTabBar tabs={tabs} active={tab} onSelect={selectTab} />

            <div role="tabpanel" className="space-y-4">
              {tab === "overview" && (
                <>
                  {editing?.kind === "details" && <DetailsForm {...formProps} />}
                  {editing?.kind === "assignment" && <AssignmentForm {...formProps} />}

                  <div className="grid grid-cols-2 gap-4">
                    <Section
                      title="Details"
                      action={
                        editable &&
                        editing === null && <ActionButton label="Edit" onClick={() => setEditing({ kind: "details" })} />
                      }
                    >
                      <dl className="grid grid-cols-2 gap-3">
                        {canViewBilling && (
                          <Field label="Balance">
                            {balance === null ? (
                              "…"
                            ) : (
                              <span className={`money font-semibold ${balance > 0 ? "text-danger" : "text-ink"}`}>
                                {balanceText(balance)}
                                {balance > 0 ? " owed" : balance < 0 ? " in credit" : ""}
                              </span>
                            )}
                          </Field>
                        )}
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
                        editable &&
                        editing === null && <ActionButton label="Change" onClick={() => setEditing({ kind: "assignment" })} />
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

                  <Section
                    title="Addresses"
                    action={
                      rowsEditable && (
                        <ActionButton label="Add address" onClick={() => setEditing({ kind: "address", address: null })} />
                      )
                    }
                  >
                    {editing?.kind === "address" && (
                      <AddressForm key={editing.address?.id ?? "new"} {...formProps} address={editing.address} />
                    )}
                    {rowError?.section === "address" && <RowError message={rowError.message} />}
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
                        ...(rowsEditable
                          ? [
                              {
                                key: "actions",
                                header: "",
                                render: (a: SubscriberAddressDto) => (
                                  <RowActions
                                    item={a}
                                    canReactivate
                                    onEdit={() => setEditing({ kind: "address", address: a })}
                                    onAction={(action) => void runRowAction("address", a.id, action)}
                                  />
                                ),
                              },
                            ]
                          : []),
                      ]}
                      rows={subscriber.addresses}
                      getRowKey={(a) => a.id}
                      emptyMessage="No addresses."
                    />
                  </Section>

                  <Section
                    title="Contacts"
                    action={
                      rowsEditable &&
                      (contactsFull ? (
                        <span className="text-xs text-muted">
                          {SUBSCRIBER_CONTACTS_MAX} active contacts (the maximum). Deactivate one to add another.
                        </span>
                      ) : (
                        <ActionButton label="Add contact" onClick={() => setEditing({ kind: "contact", contact: null })} />
                      ))
                    }
                  >
                    {editing?.kind === "contact" && (
                      <ContactForm key={editing.contact?.id ?? "new"} {...formProps} contact={editing.contact} />
                    )}
                    {rowError?.section === "contact" && <RowError message={rowError.message} />}
                    <DataTable
                      columns={[
                        { key: "type", header: "Type", render: (c) => contactTypeLabel(c.type) },
                        { key: "value", header: "Value", render: (c) => c.value },
                        { key: "name", header: "Contact name", render: (c) => c.contactName ?? "—" },
                        { key: "flags", header: "", render: (c) => <FlagBadges {...c} /> },
                        ...(rowsEditable
                          ? [
                              {
                                key: "actions",
                                header: "",
                                render: (c: SubscriberContactDto) => (
                                  <RowActions
                                    item={c}
                                    canReactivate={!contactsFull}
                                    onEdit={() => setEditing({ kind: "contact", contact: c })}
                                    onAction={(action) => void runRowAction("contact", c.id, action)}
                                  />
                                ),
                              },
                            ]
                          : []),
                      ]}
                      rows={subscriber.contacts}
                      getRowKey={(c) => c.id}
                      emptyMessage="No contacts on file."
                    />
                  </Section>
                </>
              )}

              {tab === "services" && (
                <Section
                  title="Service accounts"
                  action={
                    canAddService && <ActionButton label="Add service" onClick={() => setEditing({ kind: "service" })} />
                  }
                >
                  {editing?.kind === "service" && (
                    <AddServiceForm
                      subscriber={subscriber}
                      onSaved={() => {
                        setEditing(null);
                        setServicesKey((k) => k + 1);
                      }}
                      onCancel={() => setEditing(null)}
                      onExpired={onSessionExpired}
                    />
                  )}
                  {servicesError && <RowError message={`Could not load service accounts. ${servicesError}`} />}
                  {services === null && !servicesError ? (
                    <p className="text-sm text-muted">Loading…</p>
                  ) : (
                    <DataTable
                      columns={[
                        {
                          key: "number",
                          header: "Service no.",
                          render: (s) => (
                            <button
                              className="font-medium text-accent hover:underline"
                              onClick={() => setOpenServiceId(s.id)}
                              title={`Open ${s.serviceNumber}`}
                            >
                              {s.serviceNumber}
                            </button>
                          ),
                        },
                        { key: "type", header: "Type", render: (s) => serviceTypeLabel(s.serviceType) },
                        { key: "plan", header: "Plan", render: (s) => `${s.planCode} – ${s.planName}` },
                        { key: "status", header: "Status", render: (s) => <StatusBadge status={s.status} /> },
                        { key: "address", header: "Installed at", render: (s) => s.addressLine1 },
                        { key: "activated", header: "Activated", render: (s) => s.activationDate ?? "—" },
                        {
                          key: "rate",
                          header: "Monthly rate",
                          align: "right",
                          render: (s) => formatPesos(s.currentRateCentavos),
                        },
                      ]}
                      rows={services ?? []}
                      getRowKey={(s) => s.id}
                      emptyMessage="No service accounts yet."
                    />
                  )}
                </Section>
              )}

              {tab === "billing" && (
                <BillingTab subscriberId={subscriberId} permissions={permissions} onSessionExpired={onSessionExpired} />
              )}
              {tab === "payments" && (
                <PaymentsTab subscriberId={subscriberId} permissions={permissions} onSessionExpired={onSessionExpired} />
              )}
              {tab === "ledger" && (
                <LedgerSection
                  subscriberId={subscriberId}
                  accountNumber={subscriber.accountNumber}
                  onSessionExpired={onSessionExpired}
                />
              )}
              {tab === "collection" && <CollectionTab subscriber={subscriber} onSessionExpired={onSessionExpired} />}
              {tab === "history" && (
                <HistoryTab
                  subscriber={subscriber}
                  services={canViewServices ? services : null}
                  history={history}
                  areaNames={areaNames}
                  collectorNames={collectorNames}
                  onSessionExpired={onSessionExpired}
                />
              )}
              {tab === "documents" && (
                <DocumentsTab subscriber={subscriber} permissions={permissions} onSessionExpired={onSessionExpired} />
              )}
              {tab === "audit" && <AuditTab subscriberId={subscriberId} onSessionExpired={onSessionExpired} />}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
