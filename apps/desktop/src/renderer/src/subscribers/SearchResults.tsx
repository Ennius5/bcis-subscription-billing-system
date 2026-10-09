import { useEffect, useState } from "react";
import { GLOBAL_SEARCH_LIMIT, GLOBAL_SEARCH_MIN_LENGTH } from "@bcis/shared";
import type { GlobalSearchResultDto } from "../../../preload/index";
import { StatusBadge } from "./status";

const MATCH_LABELS: Record<string, string> = {
  accountNumber: "Account no.",
  serviceNumber: "Service no.",
  name: "Name",
  contact: "Contact",
  address: "Address",
};

interface SearchResultsProps {
  /** Already trimmed and debounced by the shell. */
  query: string;
  onOpen: (subscriberId: string) => void;
  onSessionExpired: () => void;
}

export function SearchResults({ query, onOpen, onSessionExpired }: SearchResultsProps) {
  const [result, setResult] = useState<GlobalSearchResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const tooShort = query.length < GLOBAL_SEARCH_MIN_LENGTH;

  useEffect(() => {
    if (tooShort) return;
    let cancelled = false;
    setLoading(true);
    void window.bcis.search.global(query).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setResult(r.data);
        setError(null);
      } else if (r.code === "UNAUTHENTICATED") {
        onSessionExpired();
        return;
      } else {
        setError(r.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [query, tooShort, onSessionExpired]);

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-navy">Search</h1>
      <p className="mb-4 text-sm text-muted">
        Account or service number, name, contact number or address. Press Esc to go back.
      </p>

      {tooShort ? (
        <p className="text-muted">Type at least {GLOBAL_SEARCH_MIN_LENGTH} characters to search.</p>
      ) : error ? (
        <p role="alert" className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          Search failed. {error}
        </p>
      ) : !result || (loading && result.query !== query) ? (
        <p className="text-muted">Searching…</p>
      ) : result.items.length === 0 ? (
        <p className="text-muted">No subscribers match “{result.query}”.</p>
      ) : (
        <>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-surface" aria-live="polite">
            {result.items.map((hit) => (
              <li key={hit.id}>
                <button
                  className="block w-full px-4 py-3 text-left hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                  onClick={() => onOpen(hit.id)}
                >
                  <span className="flex flex-wrap items-center gap-3">
                    <span className="font-medium text-accent">{hit.fullName}</span>
                    <span className="text-sm text-muted">{hit.accountNumber}</span>
                    <StatusBadge status={hit.status} />
                  </span>
                  <span className="mt-1 block text-sm text-ink">
                    {[hit.primaryContact, hit.primaryAddress].filter(Boolean).join(" · ") || "—"}
                  </span>
                  <span className="mt-1 block text-xs text-muted">
                    Matched{" "}
                    {hit.matches.map((m, i) => (
                      <span key={m.field}>
                        {i > 0 && ", "}
                        {MATCH_LABELS[m.field] ?? m.field}: <span className="text-ink">{m.value}</span>
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {result.hasMore && (
            <p className="mt-3 text-sm text-muted">
              Showing the first {GLOBAL_SEARCH_LIMIT} matches. Type more to narrow the search.
            </p>
          )}
        </>
      )}
    </div>
  );
}
