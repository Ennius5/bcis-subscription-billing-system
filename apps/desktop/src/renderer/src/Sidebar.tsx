import { useState } from "react";
import type { NavItem } from "@bcis/shared";

export function findItem(items: readonly NavItem[], id: string): NavItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findItem(item.children, id);
      if (found) return found;
    }
  }
  return null;
}

function groupContaining(items: readonly NavItem[], id: string): string | null {
  for (const item of items) {
    if (item.children?.some((c) => c.id === id)) return item.id;
  }
  return null;
}

interface SidebarProps {
  items: readonly NavItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function Sidebar({ items, activeId, onSelect }: SidebarProps) {
  const [open, setOpen] = useState<Set<string>>(() => {
    const group = activeId ? groupContaining(items, activeId) : null;
    return new Set(group ? [group] : []);
  });

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <nav aria-label="Main navigation" className="aero-nav w-60 shrink-0 overflow-y-auto p-3">
      <ul className="space-y-1">
        {items.map((item) => {
          if (!item.children) {
            return (
              <li key={item.id}>
                <button
                  className="nav-item"
                  aria-current={item.id === activeId ? "page" : undefined}
                  onClick={() => onSelect(item.id)}
                >
                  {item.label}
                </button>
              </li>
            );
          }
          const expanded = open.has(item.id);
          return (
            <li key={item.id}>
              <button
                className="nav-group"
                aria-expanded={expanded}
                onClick={() => toggle(item.id)}
              >
                {item.label}
                <span aria-hidden="true" className="text-xs text-muted">
                  {expanded ? "▾" : "▸"}
                </span>
              </button>
              {expanded && (
                <ul className="mt-1 ml-3 space-y-1 border-l border-slate-400/40 pl-2">
                  {item.children.map((child) => (
                    <li key={child.id}>
                      <button
                        className="nav-item"
                        aria-current={child.id === activeId ? "page" : undefined}
                        onClick={() => onSelect(child.id)}
                      >
                        {child.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}