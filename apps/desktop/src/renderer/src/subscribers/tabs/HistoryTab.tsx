import { useEffect, useMemo, useState } from "react";
import type { ServiceAccountDto, SubscriberDto, SubscriberHistoryDto } from "../../../../preload/index";
import { describeServiceEvent, type ServiceHistoryLookups } from "../../service-accounts/serviceHistory";
import { describeHistory, type HistoryLookups } from "../history";
import { formatDateTime, RowError, Section } from "../ProfileParts";

interface HistoryTabProps {
  subscriber: SubscriberDto;
  /** null while loading, or when the user cannot see services. */
  services: ServiceAccountDto[] | null;
  history: SubscriberHistoryDto[];
  areaNames: ReadonlyMap<string, string>;
  collectorNames: ReadonlyMap<string, string>;
  onSessionExpired: () => void;
}

interface TimelineEntry {
  key: string;
  occurredAt: string;
  /** "Account" for the subscriber record, otherwise the service number. */
  source: string;
  title: string;
  details: string[];
  by: string;
  reason: string | null;
}

/**
 * One timeline, newest first: changes to the subscriber record and to every one of its
 * services (status changes, plan and rate changes, suspensions, reconnections).
 */
export function HistoryTab({ subscriber, services, history, areaNames, collectorNames, onSessionExpired }: HistoryTabProps) {
  const [serviceEntries, setServiceEntries] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [planNames, setPlanNames] = useState<ReadonlyMap<string, string>>(new Map());

  // Plan names for the sentences; without plan.view they fall back to "a plan".
  useEffect(() => {
    void window.bcis.plans.list(true).then((r) => {
      if (r.ok) setPlanNames(new Map(r.data.map((p) => [p.id, `${p.code} – ${p.name}`])));
    });
  }, []);

  useEffect(() => {
    if (!services || services.length === 0) return;
    let cancelled = false;
    const lookups: ServiceHistoryLookups = { plans: planNames, collectors: collectorNames };
    void Promise.all(services.map((s) => window.bcis.serviceAccounts.get(s.id))).then((results) => {
      if (cancelled) return;
      const failure = results.find((r) => !r.ok);
      if (failure && !failure.ok) {
        if (failure.code === "UNAUTHENTICATED") return onSessionExpired();
        setError(failure.message);
      }
      setServiceEntries(
        results.flatMap((r) =>
          r.ok
            ? r.data.events.map((event) => {
                const entry = describeServiceEvent(event, lookups);
                return {
                  key: `svc-${event.id}`,
                  occurredAt: event.occurredAt,
                  source: r.data.serviceNumber,
                  title: entry.title,
                  details: entry.details,
                  by: event.actorName ?? event.actorUsername ?? "system",
                  reason: event.reason,
                };
              })
            : [],
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [services, planNames, collectorNames, onSessionExpired]);

  const timeline = useMemo(() => {
    const lookups: HistoryLookups = {
      areas: areaNames,
      collectors: collectorNames,
      addresses: subscriber.addresses,
      contacts: subscriber.contacts,
    };
    const accountEntries: TimelineEntry[] = history.map((row) => {
      const entry = describeHistory(row, lookups);
      return {
        key: `sub-${row.id}`,
        occurredAt: row.occurredAt,
        source: "Account",
        title: entry.title,
        details: entry.details,
        by: row.actorName ?? row.actorUsername ?? "system",
        reason: row.reason,
      };
    });
    return [...accountEntries, ...serviceEntries].toSorted((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }, [history, serviceEntries, subscriber, areaNames, collectorNames]);

  return (
    <Section title="Service and account history">
      {error && <RowError message={`Some service histories could not be loaded. ${error}`} />}
      {timeline.length === 0 ? (
        <p className="text-sm text-muted">No recorded changes.</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {timeline.map((item) => (
            <li key={item.key} className="py-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="font-medium text-ink">
                  <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-muted">{item.source}</span>
                  {item.title}
                </span>
                <span className="shrink-0 text-xs text-muted">{formatDateTime(item.occurredAt)}</span>
              </div>
              {item.details.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-ink">
                  {item.details.map((detail, i) => (
                    <li key={i}>{detail}</li>
                  ))}
                </ul>
              )}
              <div className="mt-1 text-xs text-muted">
                By {item.by}
                {item.reason && <> · Reason: {item.reason}</>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
