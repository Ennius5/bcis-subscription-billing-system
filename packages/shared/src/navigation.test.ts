import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "./permissions";
import { homeScreenId, visibleNavigation, type NavItem } from "./navigation";

function ids(items: readonly NavItem[]): string[] {
  return items.flatMap((i) => (i.children ? [i.id, ...ids(i.children)] : [i.id]));
}

describe("visibleNavigation", () => {
  it("shows everything to the owner", () => {
    const shown = ids(visibleNavigation(ROLE_PERMISSIONS.owner));
    expect(shown).toContain("admin.backup");
    expect(shown).toContain("billing.generate");
    expect(shown).toContain("receivables.suspension");
  });

  it("hides admin, reports and billing generation from the cashier", () => {
    const shown = ids(visibleNavigation(ROLE_PERMISSIONS.cashier));
    expect(shown).toContain("payments.receive");
    expect(shown).toContain("payments.gcash");
    expect(shown).not.toContain("billing.generate");
    expect(shown).not.toContain("administration");
    expect(shown).not.toContain("collections");
    expect(shown).not.toContain("reports");
  });

  it("shows the technician only service and suspension screens", () => {
    const shown = ids(visibleNavigation(ROLE_PERMISSIONS.technician));
    expect(shown).toEqual([
      "subscribers",
      "subscribers.services",
      "receivables",
      "receivables.suspension",
      "services",
    ]);
  });

  it("gives the viewer read-only dashboards, reports and receivables", () => {
    const shown = ids(visibleNavigation(ROLE_PERMISSIONS.viewer));
    expect(shown).toEqual([
      "dashboard",
      "receivables",
      "receivables.outstanding",
      "receivables.overdue",
      "receivables.aging",
      "reports",
    ]);
  });

  it("returns nothing for a user with no permissions", () => {
    expect(visibleNavigation([])).toEqual([]);
  });

    it("shows Service Plans to the administrator but not to the cashier", () => {
    expect(ids(visibleNavigation(ROLE_PERMISSIONS.administrator))).toContain("subscribers.plans");
    expect(ids(visibleNavigation(ROLE_PERMISSIONS.cashier))).not.toContain("subscribers.plans");
  });
});

describe("homeScreenId", () => {
  it("opens the dashboard for roles that have it", () => {
    expect(homeScreenId(visibleNavigation(ROLE_PERMISSIONS.owner))).toBe("dashboard");
    expect(homeScreenId(visibleNavigation(ROLE_PERMISSIONS.viewer))).toBe("dashboard");
  });

  it("opens Services for the technician", () => {
    expect(homeScreenId(visibleNavigation(ROLE_PERMISSIONS.technician))).toBe("services");
  });

  it("falls back to the first visible screen, or nothing", () => {
    expect(homeScreenId(visibleNavigation(["plan.view"]))).toBe("subscribers.plans");
    expect(homeScreenId([])).toBeNull();
  });
});
