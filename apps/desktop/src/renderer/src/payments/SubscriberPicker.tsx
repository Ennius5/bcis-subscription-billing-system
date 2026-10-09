import { useEffect, useRef, useState } from "react";
import { GLOBAL_SEARCH_MIN_LENGTH } from "@bcis/shared";
import type { GlobalSearchHitDto } from "../../../preload/index";
import { StatusBadge } from "../subscribers/status";

const SEARCH_DELAY_MS = 300;

interface SubscriberPickerProps {
  onPick: (subscriberId: string) => void;
  onSessionExpired: () => void;
}

/** Find the paying subscriber by account no., name, phone or address (the global search). */
export function SubscriberPicker({ onPick, onSessionExpired }: SubscriberPickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<GlobalSearchHitDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const query = text.trim();
  const tooShort = query.length < GLOBAL_SEARCH_MIN_LENGTH;

  // The cashier starts typing straight away.
  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (tooShort) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.bcis.search.global(query).then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setHits(r.data.items);
          setError(null);
        } else if (r.code === "UNAUTHENTICATED") onSessionExpired();
        else setError(r.message);
      });
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, tooShort, onSessionExpired]);

  return (
    <div className="max-w-2xl">
      <label className="block text-sm font-medium text-ink">
        Subscriber
        <input
          ref={input}
          type="search"
          className="mt-1 block w-full rounded border border-slate-300 bg-surface px-3 py-2 font-normal text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          placeholder="Account no., name, phone or address"
          value={text}
          maxLength={100}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter takes the first match, for speed at the counter.
            if (e.key === "Enter" && hits[0]) onPick(hits[0].id);
          }}
        />
      </label>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      {!tooShort && hits.length === 0 && !error && <p className="mt-2 text-sm text-muted">No matching subscribers.</p>}
      {hits.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-surface">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                onClick={() => onPick(hit.id)}
              >
                <span>
                  <span className="font-medium text-ink">{hit.fullName}</span>{" "}
                  <span className="text-muted">· {hit.accountNumber}</span>
                  {hit.primaryAddress && <span className="block text-xs text-muted">{hit.primaryAddress}</span>}
                </span>
                <StatusBadge status={hit.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
