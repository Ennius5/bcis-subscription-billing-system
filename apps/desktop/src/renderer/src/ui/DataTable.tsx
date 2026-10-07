import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  /** Right-align money and other numeric columns. */
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  getRowKey: (row: T) => string;
  emptyMessage: string;
}

export function DataTable<T>({ columns, rows, getRowKey, emptyMessage }: DataTableProps<T>) {
  return (
    <div className="max-h-full overflow-auto rounded-lg border border-slate-200 bg-surface">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`sticky top-0 border-b border-slate-200 bg-slate-50 px-3 py-2 font-medium text-muted ${
                  col.align === "right" ? "text-right" : "text-left"
                }`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-muted">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={getRowKey(row)} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-3 py-2 ${col.align === "right" ? "money" : "text-left"}`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}