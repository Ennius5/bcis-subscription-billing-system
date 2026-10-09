import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from "drizzle-orm/pg-core";


export const applicationSettings = pgTable("application_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull().unique(),
    fullName: text("full_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("users_username_lowercase", sql`${t.username} = lower(${t.username})`)],
);

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
});

export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  description: text("description").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    reason: text("reason"),
    oldValues: jsonb("old_values"),
    newValues: jsonb("new_values"),
  },
  (t) => [
    index("audit_logs_occurred_idx").on(t.occurredAt),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_actor_idx").on(t.actorUserId),
    index("audit_logs_action_idx").on(t.action),
  ],
);

export const serviceTypes = pgTable("service_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(), // internet | cable | combo
  name: text("name").notNull(),
});

export const servicePlans = pgTable(
  "service_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    serviceTypeId: uuid("service_type_id")
      .notNull()
      .references(() => serviceTypes.id),
    priceCentavos: integer("price_centavos").notNull(),
    installationFeeCentavos: integer("installation_fee_centavos").notNull().default(0),
    reconnectionFeeCentavos: integer("reconnection_fee_centavos").notNull().default(0),
    description: text("description"),
    speedMbps: integer("speed_mbps"),
    channelCount: integer("channel_count"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("service_plans_price_nonneg", sql`${t.priceCentavos} >= 0`),
    check(
      "service_plans_fees_nonneg",
      sql`${t.installationFeeCentavos} >= 0 AND ${t.reconnectionFeeCentavos} >= 0`,
    ),
    check(
      "service_plans_attributes_positive",
      sql`(${t.speedMbps} IS NULL OR ${t.speedMbps} > 0) AND (${t.channelCount} IS NULL OR ${t.channelCount} > 0)`,
    ),
    index("service_plans_type_idx").on(t.serviceTypeId),
    index("service_plans_active_idx").on(t.isActive),
  ],
);
export const collectionAreas = pgTable(
  "collection_areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("collection_areas_active_idx").on(t.isActive)],
);

export const collectors = pgTable(
  "collectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    fullName: text("full_name").notNull(),
    contactNumber: text("contact_number"),
    // Optional login. A collector may never use the desktop app.
    userId: uuid("user_id").unique().references(() => users.id),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("collectors_active_idx").on(t.isActive)],
);

export const subscriberAccountSeq = pgSequence("subscriber_account_seq", {
  startWith: 1,
  increment: 1,
});

export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountNumber: text("account_number")
      .notNull()
      .unique()
      .default(sql`('BCIS-' || lpad(nextval('subscriber_account_seq')::text, 6, '0'))`),
    fullName: text("full_name").notNull(),
    status: text("status").notNull().default("active"),
    billingDay: integer("billing_day").notNull(),
    collectionAreaId: uuid("collection_area_id").references(() => collectionAreas.id),
    assignedCollectorId: uuid("assigned_collector_id").references(() => collectors.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "subscribers_status_valid",
      sql`${t.status} IN ('active', 'inactive', 'terminated', 'archived')`,
    ),
    check("subscribers_billing_day_valid", sql`${t.billingDay} BETWEEN 1 AND 28`),
    index("subscribers_full_name_idx").on(t.fullName),
    index("subscribers_status_idx").on(t.status),
    index("subscribers_area_idx").on(t.collectionAreaId),
    index("subscribers_collector_idx").on(t.assignedCollectorId),
  ],
);

export const subscriberAddresses = pgTable(
  "subscriber_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    label: text("label"),
    line1: text("line1").notNull(),
    barangay: text("barangay").notNull(),
    city: text("city").notNull(),
    province: text("province"),
    landmark: text("landmark"),
    isPrimary: boolean("is_primary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("subscriber_addresses_subscriber_idx").on(t.subscriberId),
    uniqueIndex("subscriber_addresses_one_primary_idx")
      .on(t.subscriberId)
      .where(sql`${t.isPrimary}`),
    // Target of the service_accounts composite foreign key (address must belong to the subscriber).
    uniqueIndex("subscriber_addresses_id_subscriber_idx").on(t.id, t.subscriberId),
  ],
);

export const subscriberContacts = pgTable(
  "subscriber_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    type: text("type").notNull(),
    value: text("value").notNull(),
    contactName: text("contact_name"),
    isPrimary: boolean("is_primary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "subscriber_contacts_type_valid",
      sql`${t.type} IN ('mobile', 'landline', 'email', 'other')`,
    ),
    index("subscriber_contacts_subscriber_idx").on(t.subscriberId),
    index("subscriber_contacts_value_idx").on(t.value),
    uniqueIndex("subscriber_contacts_one_primary_idx")
      .on(t.subscriberId)
      .where(sql`${t.isPrimary}`),
  ],
);

export const collectorAssignments = pgTable(
  "collector_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    collectionAreaId: uuid("collection_area_id").references(() => collectionAreas.id),
    collectorId: uuid("collector_id").references(() => collectors.id),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    assignedByUserId: uuid("assigned_by_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
  },
  (t) => [
    check(
      "collector_assignments_period_valid",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    index("collector_assignments_subscriber_idx").on(t.subscriberId, t.effectiveFrom),
    index("collector_assignments_collector_idx").on(t.collectorId),
    index("collector_assignments_area_idx").on(t.collectionAreaId),
    uniqueIndex("collector_assignments_one_open_idx")
      .on(t.subscriberId)
      .where(sql`${t.effectiveTo} IS NULL`),
  ],
);

/* --------------------------- Service accounts --------------------------- */

export const serviceAccountSeq = pgSequence("service_account_seq", {
  startWith: 1,
  increment: 1,
});

export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceNumber: text("service_number")
      .notNull()
      .unique()
      .default(sql`('SVC-' || lpad(nextval('service_account_seq')::text, 6, '0'))`),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    planId: uuid("plan_id")
      .notNull()
      .references(() => servicePlans.id),
    installationAddressId: uuid("installation_address_id").notNull(),
    status: text("status").notNull().default("pending"),
    // Calendar dates without a time zone, kept as "YYYY-MM-DD" strings.
    activationDate: date("activation_date"),
    billingStartDate: date("billing_start_date"),
    billingDay: integer("billing_day").notNull(),
    // The account's own rate. A plan price change does not touch it; only an explicit rate change does.
    currentRateCentavos: integer("current_rate_centavos").notNull(),
    // Optional override; when null the subscriber's assigned collector applies.
    assignedCollectorId: uuid("assigned_collector_id").references(() => collectors.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "service_accounts_installation_address_fk",
      columns: [t.installationAddressId, t.subscriberId],
      foreignColumns: [subscriberAddresses.id, subscriberAddresses.subscriberId],
    }),
    check(
      "service_accounts_status_valid",
      sql`${t.status} IN ('pending', 'active', 'suspended', 'terminated')`,
    ),
    check("service_accounts_billing_day_valid", sql`${t.billingDay} BETWEEN 1 AND 28`),
    check("service_accounts_rate_nonneg", sql`${t.currentRateCentavos} >= 0`),
    // Activation and billing start are set together, and billing cannot start before activation.
    check(
      "service_accounts_dates_valid",
      sql`(${t.activationDate} IS NULL) = (${t.billingStartDate} IS NULL) AND (${t.billingStartDate} IS NULL OR ${t.billingStartDate} >= ${t.activationDate})`,
    ),
    // Only pending (and pending-then-cancelled) accounts may lack an activation date.
    check(
      "service_accounts_activated_valid",
      sql`${t.status} IN ('pending', 'terminated') OR ${t.activationDate} IS NOT NULL`,
    ),
    index("service_accounts_subscriber_idx").on(t.subscriberId),
    index("service_accounts_plan_idx").on(t.planId),
    index("service_accounts_status_idx").on(t.status),
    index("service_accounts_collector_idx").on(t.assignedCollectorId),
    // Lets invoices and ledger entries prove their service account belongs to their subscriber.
    uniqueIndex("service_accounts_id_subscriber_idx").on(t.id, t.subscriberId),
  ],
);

/** Append-only service history (DB trigger blocks UPDATE and DELETE). */
export const serviceEvents = pgTable(
  "service_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    oldValues: jsonb("old_values"),
    newValues: jsonb("new_values"),
    effectiveDate: date("effective_date").notNull().default(sql`CURRENT_DATE`),
    reason: text("reason"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "service_events_type_valid",
      sql`${t.eventType} IN ('created', 'status_change', 'rate_change', 'plan_change', 'collector_change', 'update')`,
    ),
    index("service_events_account_idx").on(t.serviceAccountId, t.occurredAt),
  ],
);

/* ------------------------------ Billing ------------------------------ */

/**
 * Gapless document numbers (invoices now, receipts in Phase 5). The row is locked with
 * SELECT ... FOR UPDATE while numbers are taken, so finalizing on three PCs at once can
 * neither share nor skip a number, and a rolled-back transaction gives its numbers back.
 */
export const documentSequences = pgTable(
  "document_sequences",
  {
    name: text("name").primaryKey(), // "invoice"
    prefix: text("prefix").notNull(), // "INV-"
    nextValue: bigint("next_value", { mode: "number" }).notNull().default(1),
  },
  (t) => [check("document_sequences_next_positive", sql`${t.nextValue} >= 1`)],
);

/** One row per billing month. period_start is always the 1st of the month. */
export const billingCycles = pgTable(
  "billing_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodStart: date("period_start").notNull().unique(),
    periodEnd: date("period_end").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("billing_cycles_first_of_month", sql`extract(day from ${t.periodStart}) = 1`),
    check(
      "billing_cycles_whole_month",
      sql`${t.periodEnd} = (${t.periodStart} + interval '1 month' - interval '1 day')::date`,
    ),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Assigned when the invoice is finalized; drafts have none. Never reused: voids keep theirs. */
    invoiceNumber: text("invoice_number").unique(),
    billingCycleId: uuid("billing_cycle_id")
      .notNull()
      .references(() => billingCycles.id),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    serviceAccountId: uuid("service_account_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date").notNull(),
    // OVERDUE is not stored: it is derived from due_date and the unpaid balance.
    status: text("status").notNull().default("draft"),
    totalCentavos: integer("total_centavos").notNull(),
    /** Maintained by payment allocation (Phase 5). */
    paidCentavos: integer("paid_centavos").notNull().default(0),
    /**
     * Net of the invoice's adjustments: debits minus credits (negative when credited).
     * total_centavos never changes after finalizing; the effective total is total + adjusted.
     */
    adjustedCentavos: integer("adjusted_centavos").notNull().default(0),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finalizedByUserId: uuid("finalized_by_user_id").references(() => users.id),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id").references(() => users.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (t) => [
    foreignKey({
      name: "invoices_service_account_fk",
      columns: [t.serviceAccountId, t.subscriberId],
      foreignColumns: [serviceAccounts.id, serviceAccounts.subscriberId],
    }),
    check(
      "invoices_status_valid",
      sql`${t.status} IN ('draft', 'unpaid', 'partially_paid', 'paid', 'void', 'credited')`,
    ),
    check("invoices_total_nonneg", sql`${t.totalCentavos} >= 0`),
    // Never more paid than the effective total, and credits can never take the total below zero.
    check(
      "invoices_paid_range",
      sql`${t.paidCentavos} >= 0 AND ${t.paidCentavos} <= ${t.totalCentavos} + ${t.adjustedCentavos}`,
    ),
    check("invoices_effective_total_nonneg", sql`${t.totalCentavos} + ${t.adjustedCentavos} >= 0`),
    // Payments and adjustments only go to finalized invoices.
    check("invoices_draft_unpaid", sql`${t.status} <> 'draft' OR (${t.paidCentavos} = 0 AND ${t.adjustedCentavos} = 0)`),
    // The status always agrees with the amounts, so allocation or an adjustment can never leave it out of step.
    // CREDITED: credit adjustments brought the effective total to zero (so nothing was paid).
    check(
      "invoices_paid_status_consistent",
      sql`${t.status} NOT IN ('unpaid', 'partially_paid', 'paid', 'credited') OR ${t.status} = CASE
        WHEN ${t.totalCentavos} + ${t.adjustedCentavos} = 0 AND ${t.adjustedCentavos} < 0 THEN 'credited'
        WHEN ${t.paidCentavos} = ${t.totalCentavos} + ${t.adjustedCentavos} THEN 'paid'
        WHEN ${t.paidCentavos} = 0 THEN 'unpaid'
        ELSE 'partially_paid' END`,
    ),
    check("invoices_period_valid", sql`${t.periodEnd} >= ${t.periodStart}`),
    check("invoices_due_after_issue", sql`${t.dueDate} >= ${t.invoiceDate}`),
    // Drafts have no number and were never finalized; every other status has both.
    check(
      "invoices_draft_shape",
      sql`(${t.status} = 'draft') = (${t.invoiceNumber} IS NULL) AND (${t.status} = 'draft') = (${t.finalizedAt} IS NULL)`,
    ),
    check(
      "invoices_void_shape",
      sql`(${t.status} = 'void') = (${t.voidedAt} IS NOT NULL) AND (${t.status} <> 'void' OR ${t.voidReason} IS NOT NULL)`,
    ),
    // AT-11: one live invoice per service account and month. A void frees the month for rebilling.
    uniqueIndex("invoices_one_per_period_idx")
      .on(t.serviceAccountId, t.periodStart)
      .where(sql`${t.status} <> 'void'`),
    // Target of the payment_allocations foreign key: an invoice paired with its subscriber.
    uniqueIndex("invoices_id_subscriber_idx").on(t.id, t.subscriberId),
    index("invoices_subscriber_idx").on(t.subscriberId, t.periodStart),
    index("invoices_cycle_idx").on(t.billingCycleId),
    index("invoices_due_date_idx").on(t.dueDate),
    index("invoices_status_idx").on(t.status),
  ],
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }), // a trigger allows deleting drafts only
    lineNo: integer("line_no").notNull(),
    itemType: text("item_type").notNull(),
    description: text("description").notNull(),
    /** Negative for discounts and credits. */
    amountCentavos: integer("amount_centavos").notNull(),
    /** Snapshot of what was billed, so later plan or rate changes never alter this line. */
    planId: uuid("plan_id").references(() => servicePlans.id),
    rateCentavos: integer("rate_centavos"),
  },
  (t) => [
    check(
      "invoice_items_type_valid",
      sql`${t.itemType} IN ('subscription', 'installation_fee', 'reconnection_fee', 'discount', 'penalty', 'adjustment')`,
    ),
    check("invoice_items_line_positive", sql`${t.lineNo} >= 1`),
    uniqueIndex("invoice_items_line_idx").on(t.invoiceId, t.lineNo),
  ],
);

/**
 * The subscriber ledger (spec 3.5). Append-only: a correction is a new entry (a void
 * credits back the invoice's debit), never an edit. The running balance is computed
 * from these rows in (entry_date, seq) order, so it can always be reproduced.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Posting order; breaks ties between entries on the same date. */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    serviceAccountId: uuid("service_account_id"),
    entryDate: date("entry_date").notNull(),
    entryType: text("entry_type").notNull(),
    reference: text("reference").notNull(), // INV-000123, later RCPT-000045
    description: text("description").notNull(),
    debitCentavos: integer("debit_centavos").notNull().default(0),
    creditCentavos: integer("credit_centavos").notNull().default(0),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    paymentId: uuid("payment_id").references(() => payments.id),
    adjustmentId: uuid("adjustment_id").references(() => adjustments.id),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "ledger_entries_service_account_fk",
      columns: [t.serviceAccountId, t.subscriberId],
      foreignColumns: [serviceAccounts.id, serviceAccounts.subscriberId],
    }),
    check(
      "ledger_entries_type_valid",
      sql`${t.entryType} IN ('invoice', 'invoice_void', 'payment', 'payment_reversal', 'adjustment')`,
    ),
    // Exactly one side carries the amount.
    check(
      "ledger_entries_one_side",
      sql`${t.debitCentavos} >= 0 AND ${t.creditCentavos} >= 0 AND (${t.debitCentavos} = 0) <> (${t.creditCentavos} = 0)`,
    ),
    uniqueIndex("ledger_entries_seq_idx").on(t.seq),
    index("ledger_entries_subscriber_idx").on(t.subscriberId, t.entryDate, t.seq),
    index("ledger_entries_invoice_idx").on(t.invoiceId),
    index("ledger_entries_payment_idx").on(t.paymentId),
    index("ledger_entries_adjustment_idx").on(t.adjustmentId),
  ],
);

/**
 * A debit or credit adjustment to one finalized invoice (spec 3.4: "controlled adjustment").
 * The invoice's own lines and total never change; its adjusted_centavos carries the net, and
 * the ledger gets a matching line. Append-only: a wrong adjustment is corrected by posting
 * the opposite one, so both stay visible.
 */
export const adjustments = pgTable(
  "adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adjustmentNumber: text("adjustment_number").notNull().unique(),
    invoiceId: uuid("invoice_id").notNull(),
    subscriberId: uuid("subscriber_id").notNull(),
    /** credit lowers what is owed, debit adds to it. */
    kind: text("kind").notNull(),
    category: text("category").notNull(),
    amountCentavos: integer("amount_centavos").notNull(),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "adjustments_invoice_fk",
      columns: [t.invoiceId, t.subscriberId],
      foreignColumns: [invoices.id, invoices.subscriberId],
    }),
    check("adjustments_amount_positive", sql`${t.amountCentavos} > 0`),
    check(
      "adjustments_category_valid",
      sql`(${t.kind} = 'credit' AND ${t.category} IN ('discount', 'service_outage', 'billing_error', 'goodwill', 'other'))
        OR (${t.kind} = 'debit' AND ${t.category} IN ('penalty', 'reconnection_fee', 'billing_error', 'other'))`,
    ),
    check("adjustments_reason_present", sql`length(trim(${t.reason})) >= 3`),
    index("adjustments_invoice_idx").on(t.invoiceId),
    index("adjustments_subscriber_idx").on(t.subscriberId, t.createdAt),
  ],
);

/* ------------------------------ Payments ------------------------------ */

/**
 * A posted payment (spec 3.6). Every row is a receipt: the RCPT- number is taken when the
 * payment is posted, and a reversed payment keeps its number, so numbers are never reused.
 * The ledger credit for the full amount is posted with it. allocated_centavos is how much
 * of it has been applied to invoices; the rest is the subscriber's credit (advance payment),
 * applied to later invoices when they are finalized.
 * Rows are never deleted; after posting only allocated_centavos and posted -> reversed change.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptNumber: text("receipt_number").notNull().unique(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    method: text("method").notNull(),
    amountCentavos: integer("amount_centavos").notNull(),
    allocatedCentavos: integer("allocated_centavos").notNull().default(0),
    /** When the customer paid (GCash: the transaction date). posted_at is when it was recorded. */
    paymentDate: date("payment_date").notNull(),
    /** GCash reference (normalized), bank reference or cheque number. */
    referenceNumber: text("reference_number"),
    notes: text("notes"),
    status: text("status").notNull().default("posted"),
    /** GCash payments come only from a verified submission (spec 3.7). */
    gcashSubmissionId: uuid("gcash_submission_id")
      .unique()
      .references(() => gcashSubmissions.id),
    receivedByUserId: uuid("received_by_user_id")
      .notNull()
      .references(() => users.id),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "payments_method_valid",
      sql`${t.method} IN ('cash', 'gcash', 'bank_transfer', 'cheque', 'other')`,
    ),
    check("payments_status_valid", sql`${t.status} IN ('posted', 'reversed')`),
    check("payments_amount_positive", sql`${t.amountCentavos} > 0`),
    check(
      "payments_allocated_range",
      sql`${t.allocatedCentavos} >= 0 AND ${t.allocatedCentavos} <= ${t.amountCentavos}`,
    ),
    // A GCash payment always has its reference and the submission it was verified from.
    check(
      "payments_gcash_shape",
      sql`(${t.method} = 'gcash') = (${t.gcashSubmissionId} IS NOT NULL) AND (${t.method} <> 'gcash' OR ${t.referenceNumber} IS NOT NULL)`,
    ),
    // Allocations use (id, subscriber_id) so a payment can only pay its own subscriber's invoices.
    uniqueIndex("payments_id_subscriber_idx").on(t.id, t.subscriberId),
    index("payments_subscriber_idx").on(t.subscriberId, t.paymentDate),
    index("payments_date_idx").on(t.paymentDate),
    index("payments_reference_idx").on(t.referenceNumber),
  ],
);

/**
 * Which invoices a payment paid (spec 5.1: Invoice >--< Payment). Append-only history:
 * reversing a payment does not delete its allocations; the payment's status says they no
 * longer count, and the invoices' paid_centavos are reduced in the same transaction.
 */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    subscriberId: uuid("subscriber_id").notNull(),
    amountCentavos: integer("amount_centavos").notNull(),
    /** auto = oldest-first when posted, manual = chosen by an authorized user, credit = advance credit applied later. */
    source: text("source").notNull(),
    allocatedByUserId: uuid("allocated_by_user_id")
      .notNull()
      .references(() => users.id),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "payment_allocations_payment_fk",
      columns: [t.paymentId, t.subscriberId],
      foreignColumns: [payments.id, payments.subscriberId],
    }),
    foreignKey({
      name: "payment_allocations_invoice_fk",
      columns: [t.invoiceId, t.subscriberId],
      foreignColumns: [invoices.id, invoices.subscriberId],
    }),
    check("payment_allocations_amount_positive", sql`${t.amountCentavos} > 0`),
    check("payment_allocations_source_valid", sql`${t.source} IN ('auto', 'manual', 'credit')`),
    index("payment_allocations_payment_idx").on(t.paymentId),
    index("payment_allocations_invoice_idx").on(t.invoiceId),
  ],
);

/** The record of a reversal (AT-06). At most one per payment; the payment row stays. */
export const paymentReversals = pgTable("payment_reversals", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id")
    .notNull()
    .unique()
    .references(() => payments.id),
  reason: text("reason").notNull(),
  reversedByUserId: uuid("reversed_by_user_id")
    .notNull()
    .references(() => users.id),
  reversedAt: timestamp("reversed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A GCash payment as reported by the customer (spec 3.7). It is evidence, not money:
 * nothing is posted until an authorized user verifies it, which creates the payment.
 * pending -> verified | rejected; verified -> reversed when its payment is reversed.
 * The unique index below is the duplicate-reference rule (AT-05): a reference can be
 * pending or verified only once, and rejecting or reversing frees it again.
 */
export const gcashSubmissions = pgTable(
  "gcash_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    /** Normalized: spaces removed, upper case. */
    referenceNumber: text("reference_number").notNull(),
    senderName: text("sender_name").notNull(),
    senderNumber: text("sender_number").notNull(),
    amountCentavos: integer("amount_centavos").notNull(),
    transactionDate: date("transaction_date").notNull(),
    notes: text("notes"),
    status: text("status").notNull().default("pending"),
    recordedByUserId: uuid("recorded_by_user_id")
      .notNull()
      .references(() => users.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who verified or rejected it, and when (spec 3.7 step 6). */
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
  },
  (t) => [
    check(
      "gcash_submissions_status_valid",
      sql`${t.status} IN ('pending', 'verified', 'rejected', 'reversed')`,
    ),
    check("gcash_submissions_amount_positive", sql`${t.amountCentavos} > 0`),
    check(
      "gcash_submissions_review_shape",
      sql`(${t.status} = 'pending') = (${t.reviewedAt} IS NULL) AND (${t.reviewedAt} IS NULL) = (${t.reviewedByUserId} IS NULL) AND (${t.status} = 'rejected') = (${t.rejectionReason} IS NOT NULL)`,
    ),
    uniqueIndex("gcash_submissions_live_reference_idx")
      .on(t.referenceNumber)
      .where(sql`${t.status} IN ('pending', 'verified')`),
    index("gcash_submissions_status_idx").on(t.status, t.recordedAt),
    index("gcash_submissions_subscriber_idx").on(t.subscriberId),
  ],
);

/**
 * An uploaded proof image (spec 4: validated type and size, safe storage path). The file
 * lives in the API's proof folder under storage_key, a server-generated UUID name; the
 * name the user's file had is kept only for display. Belongs to a GCash submission or,
 * for other methods, directly to a payment. Append-only.
 */
export const paymentProofs = pgTable(
  "payment_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gcashSubmissionId: uuid("gcash_submission_id").references(() => gcashSubmissions.id),
    paymentId: uuid("payment_id").references(() => payments.id),
    storageKey: text("storage_key").notNull().unique(),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("payment_proofs_one_owner", sql`num_nonnulls(${t.gcashSubmissionId}, ${t.paymentId}) = 1`),
    check("payment_proofs_mime_valid", sql`${t.mimeType} IN ('image/png', 'image/jpeg', 'image/webp')`),
    check("payment_proofs_size_valid", sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 5242880`),
    check("payment_proofs_sha256_shape", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    index("payment_proofs_submission_idx").on(t.gcashSubmissionId),
    index("payment_proofs_payment_idx").on(t.paymentId),
  ],
);