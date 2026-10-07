import { useEffect, useState } from "react";
import { ROLE_PERMISSIONS, visibleNavigation } from "@bcis/shared";

type Status = "checking" | "connected" | "unreachable";

export function App() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    void window.bcis.getHealth().then((result) => {
      setStatus(result.ok ? "connected" : "unreachable");
    });
  }, []);

  const cashierGroups = visibleNavigation(ROLE_PERMISSIONS.cashier).length;

  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold text-navy">BCIS Billing</h1>
      <p className="mt-2 text-muted">
        API and database:{" "}
        <strong className={status === "connected" ? "text-success" : "text-danger"}>
          {status}
        </strong>
      </p>
      <p className="mt-2">Cashier sees {cashierGroups} top-level menu groups.</p>
      <p className="money mt-2 w-40 rounded bg-surface p-2">₱1,234.50</p>
    </main>
  );
}