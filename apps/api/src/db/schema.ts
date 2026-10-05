import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const applicationSettings = pgTable("application_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});