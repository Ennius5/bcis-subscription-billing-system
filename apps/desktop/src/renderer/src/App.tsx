import { useEffect, useState } from "react";

type Status = "checking" | "connected" | "unreachable";

export function App() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    void window.bcis.getHealth().then((result) => {
      setStatus(result.ok ? "connected" : "unreachable");
    });
  }, []);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: 32,
        color: "#0F172A",
      }}
    >
      <h1 style={{ color: "#0F2747" }}>BCIS Billing</h1>
      <p>
        API and database: <strong>{status}</strong>
      </p>
    </main>
  );
}