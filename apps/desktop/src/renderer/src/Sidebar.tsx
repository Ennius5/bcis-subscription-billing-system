import { useState } from "react";
import type { NavItem } from "@bcis/shared";

export function firstLeaf(items: readonly NavItem[]): NavItem | null {
  for (const item of items) {
    if (item.children) {
      const leaf = firstLeaf(item.children);
      if (leaf) return leaf;
    } else {
      return item;
    }
  }
  return null;
}

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

  const rowBase = "block w-full rounded px-3 py-2 text-left text-sm";
  const leafClass = (id: string) =>
    `${rowBase} ${
      id === activeId ? "bg-white/15 font-medium text-white" : "text-white/80 hover:bg-white/10"
    }`;

  return (
    <nav aria-label="Main navigation" className="w-60 shrink-0 overflow-y-auto bg-navy p-3 text-white">
      <ul className="space-y-1">
        {items.map((item) => {
          if (!item.children) {
            return (
              <li key={item.id}>
                <button
                  className={leafClass(item.id)}
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
                className={`${rowBase} flex items-center justify-between font-medium text-white hover:bg-white/10`}
                aria-expanded={expanded}
                onClick={() => toggle(item.id)}
              >
                {item.label}
                <span aria-hidden="true" className="text-xs text-white/60">
                  {expanded ? "▾" : "▸"}
                </span>
              </button>
              {expanded && (
                <ul className="mt-1 space-y-1 border-l border-white/20 pl-2 ml-3">
                  {item.children.map((child) => (
                    <li key={child.id}>
                      <button
                        className={leafClass(child.id)}
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