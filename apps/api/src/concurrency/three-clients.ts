import "dotenv/config";

/*
 * AT-09 evidence against a RUNNING server: `pnpm --filter ./apps/api concurrency`.
 *
 * Three clients sign in as the demo cashier, administrator and collection supervisor and
 * work at the same moment over HTTP, exactly like three office PCs:
 *   cashier + administrator  post small ₱1.00 payments to subscribers who owe money
 *   supervisor               keeps reading batches and its own session
 * then it checks: no failed request, no repeated receipt number, every receipt names the
 * user who posted it, the cashier still cannot use an admin route, and signing out one
 * client leaves the others signed in. The test payments are reversed at the end (also in
 * parallel), so balances return to what they were; the receipts stay, as posted records do.
 *
 * Run it from another PC with BCIS_API_URL=http://<server>:3000 to test over the LAN.
 * Options: --payments=N per posting client (default 10).
 */

const API_URL = process.env.BCIS_API_URL ?? `http://localhost:${process.env.API_PORT ?? "3000"}`;
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "";
const PER_CLIENT = Number(/--payments=(\d+)/.exec(process.argv.join(" "))?.[1] ?? 10);
const REASON = "AT-09 concurrency test (automatic reversal)";

interface Client {
  label: string;
  username: string;
  fullName: string;
  token: string;
}

interface Timed<T> {
  ok: boolean;
  status: number;
  body: T;
  ms: number;
}

async function call<T>(client: Client | null, method: string, url: string, body?: unknown): Promise<Timed<T>> {
  const started = performance.now();
  const res = await fetch(`${API_URL}${url}`, {
    method,
    headers: {
      ...(client ? { authorization: `Bearer ${client.token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: (text ? JSON.parse(text) : null) as T, ms: performance.now() - started };
}

async function signIn(label: string, username: string): Promise<Client> {
  const res = await call<{ token: string; user: { fullName: string }; message?: string }>(null, "POST", "/auth/login", {
    username,
    password: PASSWORD,
  });
  if (!res.ok) throw new Error(`${label} (${username}) could not sign in: ${res.body.message ?? res.status}`);
  return { label, username, fullName: res.body.user.fullName, token: res.body.token };
}

const results: { passed: boolean; text: string }[] = [];
function check(passed: boolean, text: string) {
  results.push({ passed, text });
  console.log(`${passed ? "PASS" : "FAIL"}  ${text}`);
}

function timing(label: string, list: Timed<unknown>[]) {
  const times = list.map((r) => r.ms);
  const avg = times.reduce((a, b) => a + b, 0) / Math.max(times.length, 1);
  console.log(`      ${label}: ${list.length} requests, average ${avg.toFixed(0)} ms, slowest ${Math.max(...times).toFixed(0)} ms`);
}

async function main() {
  if (!PASSWORD) throw new Error("SEED_DEMO_PASSWORD is not set (apps/api/.env). Run db:seed-demo first.");
  console.log(`AT-09 three-client test against ${API_URL}\n`);

  const [cashier, admin, supervisor] = await Promise.all([
    signIn("Cashier PC", "demo_cashier"),
    signIn("Admin PC", "demo_admin"),
    signIn("Supervisor PC", "demo_supervisor"),
  ]);

  const owing = await call<{ items: { subscriberId: string }[] }>(admin, "GET", "/receivables?view=outstanding&pageSize=50");
  const subscribers = [...new Set(owing.body.items.map((r) => r.subscriberId))];
  if (subscribers.length === 0) throw new Error("No subscriber owes money; run db:seed-data or generate billing first.");

  const payment = (client: Client, k: number) =>
    call<{ id: string; receiptNumber: string; receivedByName: string; message?: string }>(client, "POST", "/payments", {
      subscriberId: subscribers[k % subscribers.length],
      method: "cash",
      amountCentavos: 100,
      notes: "AT-09 concurrency test",
    });

  // Everything below starts at the same moment.
  const started = performance.now();
  const [cashierPosts, adminPosts, supervisorReads, cashierForbidden] = await Promise.all([
    Promise.all(Array.from({ length: PER_CLIENT }, (_, k) => payment(cashier, k))),
    Promise.all(Array.from({ length: PER_CLIENT }, (_, k) => payment(admin, k + 1))),
    Promise.all(
      Array.from({ length: PER_CLIENT }, (_, k) =>
        call<unknown>(supervisor, "GET", k % 2 ? "/auth/me" : "/collection-batches"),
      ),
    ),
    call<unknown>(cashier, "GET", "/admin/users"),
  ]);
  const elapsed = performance.now() - started;

  const posts = [...cashierPosts, ...adminPosts];
  const failed = posts.filter((p) => !p.ok);
  check(failed.length === 0, `${posts.length} payments posted at once by two PCs${failed.length ? ` (${failed.length} failed: ${failed[0]?.body.message})` : ""}`);

  const receipts = posts.filter((p) => p.ok).map((p) => p.body.receiptNumber);
  check(new Set(receipts).size === receipts.length, `no receipt number repeated (${receipts.toSorted()[0]} … ${receipts.toSorted().at(-1)})`);

  const wrongPoster = [
    ...cashierPosts.filter((p) => p.ok && p.body.receivedByName !== cashier.fullName),
    ...adminPosts.filter((p) => p.ok && p.body.receivedByName !== admin.fullName),
  ];
  check(wrongPoster.length === 0, "every receipt names the user who posted it (no cross-session mix-up)");
  check(supervisorReads.every((r) => r.ok), `${supervisorReads.length} reads by the third PC succeeded meanwhile`);
  check(cashierForbidden.status === 403, "the cashier is still refused an admin-only route (403)");

  console.log(`      all of the above ran in ${elapsed.toFixed(0)} ms`);
  timing("payments", posts);
  timing("reads", supervisorReads);

  // Put the balances back: reverse the test payments, again in parallel.
  const reversals = await Promise.all(
    posts.filter((p) => p.ok).map((p) => call<unknown>(admin, "POST", `/payments/${p.body.id}/reverse`, { reason: REASON })),
  );
  check(reversals.every((r) => r.ok), `${reversals.length} test payments reversed in parallel; balances are back`);

  await call<unknown>(admin, "POST", "/auth/logout");
  const [adminAfter, cashierAfter, supervisorAfter] = await Promise.all([
    call<unknown>(admin, "GET", "/auth/me"),
    call<unknown>(cashier, "GET", "/auth/me"),
    call<unknown>(supervisor, "GET", "/auth/me"),
  ]);
  check(
    adminAfter.status === 401 && cashierAfter.ok && supervisorAfter.ok,
    "signing out one PC leaves the other two signed in",
  );
  await Promise.all([call<unknown>(cashier, "POST", "/auth/logout"), call<unknown>(supervisor, "POST", "/auth/logout")]);

  const failures = results.filter((r) => !r.passed).length;
  console.log(
    failures === 0
      ? "\nAT-09 PASSED. Now run Administration > Backup & Restore > Run integrity check as the owner."
      : `\nAT-09 FAILED: ${failures} check(s) did not pass.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof TypeError && /fetch failed/.test(err.message) ? `Cannot reach the API at ${API_URL}. Is it running?` : err);
  process.exitCode = 1;
});
