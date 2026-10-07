import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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