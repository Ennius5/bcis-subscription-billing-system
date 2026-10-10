import { AUDIT_CATEGORIES, AUDIT_CATEGORY_LABELS } from "@bcis/shared";
import { type ReportDocument, manilaTimestamp } from "./document";
import type { UserActivityReport } from "./user-activity";

const when = (date: Date | null) => (date ? manilaTimestamp(date) : null);

export function buildUserActivityDocument(report: UserActivityReport): ReportDocument {
  const { totals } = report;
  return {
    slug: "user-activity",
    title: "User Activity",
    period: `${report.from} to ${report.to}`,
    fileDate: `${report.from}_to_${report.to}`,
    filters: [],
    orientation: "landscape",
    figures: [
      { label: "Users listed", value: report.users.length, kind: "count" },
      { label: "Sign-ins", value: totals.loginCount, kind: "count" },
      { label: "Audited actions", value: totals.actionCount, kind: "count" },
      { label: "Exports", value: totals.byCategory.exports, kind: "count" },
    ],
    tables: [
      {
        title: "By user",
        columns: [
          { header: "User", kind: "text", width: 1.3 },
          { header: "Name / roles", kind: "text", width: 2.2 },
          { header: "Sign-ins", kind: "count", width: 0.8 },
          { header: "Actions", kind: "count", width: 0.8 },
          ...AUDIT_CATEGORIES.map((c) => ({ header: AUDIT_CATEGORY_LABELS[c], kind: "count" as const, width: 0.9 })),
          { header: "Last action", kind: "text", width: 1.3 },
        ],
        rows: report.users.map((u) => [
          `${u.username}${u.isActive || !u.userId ? "" : " (inactive)"}`,
          u.roles ? `${u.fullName} (${u.roles})` : u.fullName,
          u.loginCount,
          u.actionCount,
          ...AUDIT_CATEGORIES.map((c) => u.byCategory[c]),
          when(u.lastActionAt),
        ]),
        totals: ["Total", null, totals.loginCount, totals.actionCount, ...AUDIT_CATEGORIES.map((c) => totals.byCategory[c]), null],
        emptyMessage: "No users.",
      },
      {
        title: "By action",
        columns: [
          { header: "Action", kind: "text", width: 2 },
          { header: "Area", kind: "text", width: 1.4 },
          { header: "Times", kind: "count" },
          { header: "Users", kind: "count" },
        ],
        rows: report.actions.map((a) => [a.action, AUDIT_CATEGORY_LABELS[a.category], a.count, a.userCount]),
        emptyMessage: "No audited actions in this period.",
      },
    ],
    notes: [
      "Sign-ins are sessions started in the period. Actions are audit log entries; viewing screens is not recorded. Times are Asia/Manila.",
    ],
  };
}
