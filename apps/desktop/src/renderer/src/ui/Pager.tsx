interface PagerProps {
  page: number;
  pageSize: number;
  total: number;
  loading?: boolean;
  onPage: (page: number) => void;
}

/** "Showing 51–100 of 2,340" with Previous / Next, for server-paged lists. */
export function Pager({ page, pageSize, total, loading = false, onPage }: PagerProps) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const button = "btn btn-secondary btn-sm";
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-muted">
      <span aria-live="polite">
        {total === 0 ? "No results" : `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <span className="flex items-center gap-2">
        <button className={button} disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {lastPage}
        </span>
        <button className={button} disabled={page >= lastPage || loading} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </span>
    </div>
  );
}
