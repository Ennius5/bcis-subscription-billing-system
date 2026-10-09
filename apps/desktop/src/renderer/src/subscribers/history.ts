import type {
  SubscriberAddressDto,
  SubscriberContactDto,
  SubscriberHistoryDto,
} from "../../../preload/index";
import { contactTypeLabel, statusLabel } from "./status";

/** What the sentences need to turn ids into something a person recognises. */
export interface HistoryLookups {
  areas: ReadonlyMap<string, string>; // id -> code
  collectors: ReadonlyMap<string, string>; // id -> code and name
  addresses: readonly SubscriberAddressDto[];
  contacts: readonly SubscriberContactDto[];
}

export interface HistoryEntry {
  title: string;
  details: string[];
}

const FIELD_LABELS: Record<string, string> = {
  fullName: "Full name",
  billingDay: "Billing day",
  notes: "Notes",
  label: "Label",
  line1: "Street or purok",
  barangay: "Barangay",
  city: "City",
  province: "Province",
  landmark: "Landmark",
  value: "Value",
  contactName: "Contact name",
};

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(blank)";
  // Audit values are plain JSON; anything structured is shown as JSON, never "[object Object]".
  const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  return `“${scalar ? String(value) : JSON.stringify(value)}”`;
}

/** One phrase per changed field; flag changes get plain words instead of from/to. */
function fieldChanges(oldValues: Record<string, unknown>, newValues: Record<string, unknown>): string[] {
  const phrases: string[] = [];
  for (const [key, value] of Object.entries(newValues)) {
    if (key === "isPrimary") {
      if (value === true) phrases.push("Made primary");
    } else if (key === "isActive") {
      phrases.push(value ? "Reactivated" : "Deactivated");
    } else if (key in FIELD_LABELS) {
      phrases.push(`${FIELD_LABELS[key]} changed from ${show(oldValues[key])} to ${show(value)}`);
    }
    // Ids such as addressId or demotedAddressId are context, not changes.
  }
  return phrases;
}

function addressText(a: { line1?: unknown; barangay?: unknown; city?: unknown }): string {
  return [a.line1, a.barangay, a.city].filter((part) => typeof part === "string" && part).join(", ");
}

function contactText(c: { type?: unknown; value?: unknown }): string {
  const type = typeof c.type === "string" ? contactTypeLabel(c.type) : "Contact";
  return `${type} ${typeof c.value === "string" ? c.value : ""}`.trim();
}

function nameOf(map: ReadonlyMap<string, string>, id: unknown, fallback: string): string {
  if (id === null || id === undefined) return "none";
  return (typeof id === "string" && map.get(id)) || fallback;
}

export function describeHistory(row: SubscriberHistoryDto, lookups: HistoryLookups): HistoryEntry {
  const oldValues = row.oldValues ?? {};
  const newValues = row.newValues ?? {};

  switch (row.action) {
    case "subscriber.create":
      return { title: "Subscriber created", details: [] };

    case "subscriber.update":
      return { title: "Details updated", details: fieldChanges(oldValues, newValues) };

    case "subscriber.status_change":
      return {
        title: `Status changed from ${statusLabel(String(oldValues.status))} to ${statusLabel(String(newValues.status))}`,
        details: [],
      };

    case "subscriber.assignment_change": {
      const details: string[] = [];
      if (oldValues.collectionAreaId !== newValues.collectionAreaId) {
        details.push(
          `Area: ${nameOf(lookups.areas, oldValues.collectionAreaId, "an area")} → ${nameOf(lookups.areas, newValues.collectionAreaId, "an area")}`,
        );
      }
      if (oldValues.assignedCollectorId !== newValues.assignedCollectorId) {
        details.push(
          `Collector: ${nameOf(lookups.collectors, oldValues.assignedCollectorId, "a collector")} → ${nameOf(lookups.collectors, newValues.assignedCollectorId, "a collector")}`,
        );
      }
      return { title: "Collection assignment changed", details };
    }

    case "subscriber.address_add":
      return {
        title: `Address added: ${addressText(newValues)}`,
        details: newValues.isPrimary === true ? ["Made primary"] : [],
      };

    case "subscriber.address_update": {
      const address = lookups.addresses.find((a) => a.id === newValues.addressId);
      return {
        title: address ? `Address updated: ${addressText(address)}` : "Address updated",
        details: fieldChanges(oldValues, newValues),
      };
    }

    case "subscriber.contact_add":
      return {
        title: `Contact added: ${contactText(newValues)}`,
        details: newValues.isPrimary === true ? ["Made primary"] : [],
      };

    case "subscriber.contact_update": {
      const contact = lookups.contacts.find((c) => c.id === newValues.contactId);
      return {
        title: contact ? `Contact updated: ${contactText(contact)}` : "Contact updated",
        details: fieldChanges(oldValues, newValues),
      };
    }

    default:
      // Unknown actions show what was recorded rather than hiding it.
      return {
        title: row.action,
        details: [
          ...(row.oldValues ? [`Before: ${JSON.stringify(row.oldValues)}`] : []),
          ...(row.newValues ? [`After: ${JSON.stringify(row.newValues)}`] : []),
        ],
      };
  }
}
