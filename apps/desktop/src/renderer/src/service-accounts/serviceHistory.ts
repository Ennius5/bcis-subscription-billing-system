import { formatPesos } from "@bcis/shared";
import type { ServiceEventDto } from "../../../preload/index";
import { statusLabel } from "../subscribers/status";

/** What the sentences need to turn ids into something a person recognises. */
export interface ServiceHistoryLookups {
  plans: ReadonlyMap<string, string>; // id -> "CODE – Name"
  collectors: ReadonlyMap<string, string>; // id -> "CODE – Name"
}

export interface ServiceHistoryEntry {
  title: string;
  details: string[];
}

const money = (value: unknown) => (typeof value === "number" ? formatPesos(value) : "(unknown)");

function nameOf(map: ReadonlyMap<string, string>, id: unknown, fallback: string): string {
  return (typeof id === "string" && map.get(id)) || fallback;
}

function collectorText(lookups: ServiceHistoryLookups, id: unknown): string {
  return id === null || id === undefined ? "subscriber's collector" : nameOf(lookups.collectors, id, "a collector");
}

export function describeServiceEvent(event: ServiceEventDto, lookups: ServiceHistoryLookups): ServiceHistoryEntry {
  const oldValues = event.oldValues ?? {};
  const newValues = event.newValues ?? {};
  const effective = `Effective ${event.effectiveDate}`;

  switch (event.eventType) {
    case "created":
      return {
        title: "Service account created as Pending",
        details: [
          `Plan: ${nameOf(lookups.plans, newValues.planId, "a plan")}`,
          `Monthly rate: ${money(newValues.currentRateCentavos)}`,
          `Billing day: ${String(newValues.billingDay)}`,
          ...(newValues.assignedCollectorId ? [`Collector: ${collectorText(lookups, newValues.assignedCollectorId)}`] : []),
        ],
      };

    case "status_change": {
      // Phase 7: suspending and reconnecting are status changes that point at their records.
      if (typeof newValues.suspensionId === "string") {
        const count = Number(newValues.pastDueInvoiceCount ?? 0);
        return {
          title: "Suspended",
          details: [
            effective,
            `Approved by ${String(newValues.approvedBy)}`,
            `${count} past-due invoice${count === 1 ? "" : "s"} at the time`,
          ],
        };
      }
      if (typeof newValues.reconnectionId === "string") {
        const fee = Number(newValues.feeCentavos ?? 0);
        return {
          title: "Reconnected (suspension lifted)",
          details: [effective, fee > 0 ? `Reconnection fee ${formatPesos(fee)} goes on the next bill` : "No reconnection fee"],
        };
      }
      const from = statusLabel(event.fromStatus ?? String(oldValues.status));
      const to = statusLabel(event.toStatus ?? String(newValues.status));
      const details = [effective];
      if (typeof newValues.activationDate === "string") details.push(`Activated on ${newValues.activationDate}`);
      if (typeof newValues.billingStartDate === "string") details.push(`Billing starts ${newValues.billingStartDate}`);
      return { title: `Status changed from ${from} to ${to}`, details };
    }

    case "rate_change":
      return {
        title: `Monthly rate changed from ${money(oldValues.rateCentavos)} to ${money(newValues.rateCentavos)}`,
        details: [effective],
      };

    case "plan_change": {
      const details = [
        `Plan: ${nameOf(lookups.plans, oldValues.planId, "a plan")} → ${nameOf(lookups.plans, newValues.planId, "another plan")}`,
      ];
      if (oldValues.rateCentavos !== newValues.rateCentavos) {
        details.push(`Monthly rate: ${money(oldValues.rateCentavos)} → ${money(newValues.rateCentavos)}`);
      }
      details.push(effective);
      return { title: "Plan changed", details };
    }

    case "collector_change":
      return {
        title: "Collector changed",
        details: [
          `${collectorText(lookups, oldValues.assignedCollectorId)} → ${collectorText(lookups, newValues.assignedCollectorId)}`,
        ],
      };

    case "update": {
      const details: string[] = [];
      if ("installationAddressId" in newValues) details.push("Installation address changed");
      if ("billingDay" in newValues) {
        details.push(`Billing day changed from ${String(oldValues.billingDay)} to ${String(newValues.billingDay)}`);
      }
      if ("notes" in newValues) details.push(newValues.notes ? "Notes updated" : "Notes cleared");
      return { title: "Service details updated", details };
    }

    case "reconnection_request":
      return {
        title: "Reconnection requested",
        details: [
          `Requested ${event.effectiveDate}`,
          newValues.feeWaived
            ? `Reconnection fee ${money(newValues.feeCentavos)} waived`
            : `Reconnection fee ${money(newValues.feeCentavos)}`,
        ],
      };

    case "reconnection_assign":
      return {
        title: oldValues.technicianUserId ? "Reconnection handed to another technician" : "Reconnection assigned to a technician",
        details: [],
      };

    case "reconnection_cancel":
      return { title: "Reconnection cancelled", details: ["The service stays suspended."] };

    default:
      // Unknown event types show what was recorded rather than hiding it.
      return {
        title: event.eventType,
        details: [
          ...(event.oldValues ? [`Before: ${JSON.stringify(event.oldValues)}`] : []),
          ...(event.newValues ? [`After: ${JSON.stringify(event.newValues)}`] : []),
        ],
      };
  }
}
