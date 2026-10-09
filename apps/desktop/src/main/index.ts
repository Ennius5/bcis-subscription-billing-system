import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type {
  ApiFailure,
  ApiResult,
  AreaDto,
  AuthResult,
  AvailableUserDto,
  BillingSummaryDto,
  FinalizeResultDto,
  InvoiceDetailDto,
  InvoicePageDto,
  SubscriberLedgerDto,
  GlobalSearchResultDto,
  PaymentContextDto,
  PaymentDetailDto,
  CollectorDto,
  PlanDto,
  ServiceAccountDetailDto,
  ServiceAccountPageDto,
  SessionInfo,
  SubscriberDto,
  SubscriberHistoryDto,
  SubscriberPageDto,
} from "../preload/index";

const API_URL = process.env.BCIS_API_URL ?? "http://localhost:3000";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#F6F8FB",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // The app never opens new windows or navigates away from itself.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

ipcMain.handle("api:health", async () => {
  try {
    const res = await fetch(`${API_URL}/health/db`);
    const data: unknown = await res.json();
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: null };
  }
});

// The session token never leaves the main process. The renderer only
// receives the user and permission codes.
let currentToken: string | null = null;

const NETWORK_ERROR: ApiFailure = {
  ok: false,
  code: "NETWORK",
  message: "Cannot reach the BCIS server. Check your network connection and try again.",
};

async function readError(res: Response): Promise<ApiFailure> {
  try {
    const body = (await res.json()) as {
      error?: string;
      message?: string;
      issues?: { path: string; message: string }[];
    };
    return {
      ok: false,
      code: body.error ?? "ERROR",
      message: body.message ?? "Something went wrong.",
      ...(body.issues ? { issues: body.issues } : {}),
    };
  } catch {
    return { ok: false, code: "ERROR", message: "Something went wrong." };
  }
}

ipcMain.handle(
  "auth:login",
  async (_event, username: unknown, password: unknown): Promise<AuthResult> => {
    if (typeof username !== "string" || typeof password !== "string") {
      return { ok: false, code: "VALIDATION", message: "Username and password are required." };
    }
    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) return await readError(res);
      const body = (await res.json()) as SessionInfo & { token: string };
      currentToken = body.token;
      return { ok: true, user: body.user, permissions: body.permissions };
    } catch {
      return NETWORK_ERROR;
    }
  },
);

ipcMain.handle("auth:me", async (): Promise<AuthResult> => {
  if (!currentToken) {
    return { ok: false, code: "UNAUTHENTICATED", message: "Please sign in." };
  }
  try {
    const res = await fetch(`${API_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    if (!res.ok) {
      if (res.status === 401) currentToken = null;
      return await readError(res);
    }
    const body = (await res.json()) as SessionInfo;
    return { ok: true, user: body.user, permissions: body.permissions };
  } catch {
    return NETWORK_ERROR;
  }
});

ipcMain.handle("auth:logout", async (): Promise<void> => {
  const token = currentToken;
  currentToken = null; // signed out locally even if the network call fails
  if (!token) return;
  try {
    await fetch(`${API_URL}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // The server-side session expires on its own (30 min idle, 12 h absolute).
  }
});

// Private helper: the renderer can only reach it through the handlers below.
async function authedRequest<T>(
  method: "GET" | "POST" | "PATCH",
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<ApiResult<T>> {
  if (!currentToken) {
    return { ok: false, code: "UNAUTHENTICATED", message: "Please sign in." };
  }
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${currentToken}` };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${API_URL}${urlPath}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401) currentToken = null; // session expired or revoked
    if (!res.ok) return await readError(res);
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return NETWORK_ERROR;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BAD_INPUT: ApiFailure = {
  ok: false,
  code: "VALIDATION",
  message: "Invalid request.",
};

ipcMain.handle("plans:list", (_event, includeInactive: unknown) =>
  authedRequest<PlanDto[]>("GET", includeInactive === true ? "/plans?includeInactive=true" : "/plans"),
);

ipcMain.handle("plans:create", (_event, input: unknown) =>
  isRecord(input) ? authedRequest<PlanDto>("POST", "/plans", input) : BAD_INPUT,
);

ipcMain.handle("plans:update", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<PlanDto>("PATCH", `/plans/${encodeURIComponent(id)}`, input)
    : BAD_INPUT,
);

ipcMain.handle("collectionAreas:list", (_event, includeInactive: unknown) =>
  authedRequest<AreaDto[]>(
    "GET",
    includeInactive === true ? "/collection-areas?includeInactive=true" : "/collection-areas",
  ),
);

ipcMain.handle("collectionAreas:create", (_event, input: unknown) =>
  isRecord(input) ? authedRequest<AreaDto>("POST", "/collection-areas", input) : BAD_INPUT,
);

ipcMain.handle("collectionAreas:update", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<AreaDto>("PATCH", `/collection-areas/${encodeURIComponent(id)}`, input)
    : BAD_INPUT,
);

ipcMain.handle("collectors:list", (_event, includeInactive: unknown) =>
  authedRequest<CollectorDto[]>(
    "GET",
    includeInactive === true ? "/collectors?includeInactive=true" : "/collectors",
  ),
);

ipcMain.handle("collectors:create", (_event, input: unknown) =>
  isRecord(input) ? authedRequest<CollectorDto>("POST", "/collectors", input) : BAD_INPUT,
);

ipcMain.handle("collectors:update", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<CollectorDto>("PATCH", `/collectors/${encodeURIComponent(id)}`, input)
    : BAD_INPUT,
);

ipcMain.handle("collectors:availableUsers", () =>
  authedRequest<AvailableUserDto[]>("GET", "/collectors/available-users"),
);

/* ----------------------------- Subscribers ----------------------------- */

const SUBSCRIBER_LIST_KEYS = [
  "page",
  "pageSize",
  "status",
  "collectionAreaId",
  "assignedCollectorId",
  "search",
] as const;

/** Builds a list query string from known keys only; the API validates the values. */
function listPath(base: string, keys: readonly string[], query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = query[key];
    if (typeof value === "string" && value !== "") params.set(key, value);
    if (typeof value === "number") params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

const subscriberPath = (id: string) => `/subscribers/${encodeURIComponent(id)}`;

ipcMain.handle("subscribers:list", (_event, query: unknown) =>
  isRecord(query)
    ? authedRequest<SubscriberPageDto>("GET", listPath("/subscribers", SUBSCRIBER_LIST_KEYS, query))
    : BAD_INPUT,
);

// The query is user text, so it is always URL-encoded; the API validates its length.
ipcMain.handle("search:global", (_event, q: unknown) =>
  typeof q === "string"
    ? authedRequest<GlobalSearchResultDto>("GET", `/search?q=${encodeURIComponent(q)}`)
    : BAD_INPUT,
);

ipcMain.handle("subscribers:get", (_event, id: unknown) =>
  typeof id === "string" ? authedRequest<SubscriberDto>("GET", subscriberPath(id)) : BAD_INPUT,
);

ipcMain.handle("subscribers:history", (_event, id: unknown) =>
  typeof id === "string"
    ? authedRequest<SubscriberHistoryDto[]>("GET", `${subscriberPath(id)}/history`)
    : BAD_INPUT,
);

ipcMain.handle("subscribers:create", (_event, input: unknown) =>
  isRecord(input) ? authedRequest<SubscriberDto>("POST", "/subscribers", input) : BAD_INPUT,
);

ipcMain.handle("subscribers:update", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<SubscriberDto>("PATCH", subscriberPath(id), input)
    : BAD_INPUT,
);

ipcMain.handle("subscribers:changeStatus", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<SubscriberDto>("POST", `${subscriberPath(id)}/status`, input)
    : BAD_INPUT,
);

ipcMain.handle("subscribers:changeAssignment", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<SubscriberDto>("POST", `${subscriberPath(id)}/assignment`, input)
    : BAD_INPUT,
);

ipcMain.handle("subscribers:addAddress", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<SubscriberDto>("POST", `${subscriberPath(id)}/addresses`, input)
    : BAD_INPUT,
);

ipcMain.handle("subscribers:updateAddress", (_event, id: unknown, addressId: unknown, input: unknown) =>
  typeof id === "string" && typeof addressId === "string" && isRecord(input)
    ? authedRequest<SubscriberDto>(
        "PATCH",
        `${subscriberPath(id)}/addresses/${encodeURIComponent(addressId)}`,
        input,
      )
    : BAD_INPUT,
);

ipcMain.handle("subscribers:addContact", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<SubscriberDto>("POST", `${subscriberPath(id)}/contacts`, input)
    : BAD_INPUT,
);

ipcMain.handle("subscribers:updateContact", (_event, id: unknown, contactId: unknown, input: unknown) =>
  typeof id === "string" && typeof contactId === "string" && isRecord(input)
    ? authedRequest<SubscriberDto>(
        "PATCH",
        `${subscriberPath(id)}/contacts/${encodeURIComponent(contactId)}`,
        input,
      )
    : BAD_INPUT,
);

/* --------------------------- Service accounts --------------------------- */

const SERVICE_ACCOUNT_LIST_KEYS = [
  "page",
  "pageSize",
  "subscriberId",
  "status",
  "planId",
  "serviceType",
  "search",
] as const;

const serviceAccountPath = (id: string) => `/service-accounts/${encodeURIComponent(id)}`;

ipcMain.handle("serviceAccounts:list", (_event, query: unknown) =>
  isRecord(query)
    ? authedRequest<ServiceAccountPageDto>("GET", listPath("/service-accounts", SERVICE_ACCOUNT_LIST_KEYS, query))
    : BAD_INPUT,
);

ipcMain.handle("serviceAccounts:get", (_event, id: unknown) =>
  typeof id === "string" ? authedRequest<ServiceAccountDetailDto>("GET", serviceAccountPath(id)) : BAD_INPUT,
);

ipcMain.handle("serviceAccounts:create", (_event, subscriberId: unknown, input: unknown) =>
  typeof subscriberId === "string" && isRecord(input)
    ? authedRequest<ServiceAccountDetailDto>("POST", `${subscriberPath(subscriberId)}/service-accounts`, input)
    : BAD_INPUT,
);

ipcMain.handle("serviceAccounts:update", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<ServiceAccountDetailDto>("PATCH", serviceAccountPath(id), input)
    : BAD_INPUT,
);

// One handler per action, each pinned to its own endpoint (no generic action parameter).
ipcMain.handle("serviceAccounts:changeStatus", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<ServiceAccountDetailDto>("POST", `${serviceAccountPath(id)}/status`, input)
    : BAD_INPUT,
);

ipcMain.handle("serviceAccounts:changeRate", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<ServiceAccountDetailDto>("POST", `${serviceAccountPath(id)}/rate`, input)
    : BAD_INPUT,
);

ipcMain.handle("serviceAccounts:changePlan", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<ServiceAccountDetailDto>("POST", `${serviceAccountPath(id)}/plan`, input)
    : BAD_INPUT,
);

ipcMain.handle("serviceAccounts:changeCollector", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<ServiceAccountDetailDto>("POST", `${serviceAccountPath(id)}/collector`, input)
    : BAD_INPUT,
);

/* ------------------------------- Billing ------------------------------- */

// Shape checks only; the API validates the values (real months, real dates).
const isPeriod = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
const INVOICE_LIST_KEYS = ["page", "pageSize", "period", "status", "subscriberId", "serviceAccountId", "search"] as const;
const LEDGER_KEYS = ["from", "to"] as const;
const invoicePath = (id: string) => `/invoices/${encodeURIComponent(id)}`;

ipcMain.handle("billing:summary", (_event, period: unknown) =>
  isPeriod(period) ? authedRequest<BillingSummaryDto>("GET", `/billing/summary?period=${period}`) : BAD_INPUT,
);

ipcMain.handle("billing:generate", (_event, period: unknown) =>
  isPeriod(period) ? authedRequest<BillingSummaryDto>("POST", "/billing/generate", { period }) : BAD_INPUT,
);

ipcMain.handle("billing:discardDrafts", (_event, period: unknown) =>
  isPeriod(period) ? authedRequest<BillingSummaryDto>("POST", "/billing/discard-drafts", { period }) : BAD_INPUT,
);

ipcMain.handle("billing:finalize", (_event, period: unknown) =>
  isPeriod(period) ? authedRequest<FinalizeResultDto>("POST", "/billing/finalize", { period }) : BAD_INPUT,
);

ipcMain.handle("billing:listInvoices", (_event, query: unknown) =>
  isRecord(query)
    ? authedRequest<InvoicePageDto>("GET", listPath("/invoices", INVOICE_LIST_KEYS, query))
    : BAD_INPUT,
);

ipcMain.handle("billing:getInvoice", (_event, id: unknown) =>
  typeof id === "string" ? authedRequest<InvoiceDetailDto>("GET", invoicePath(id)) : BAD_INPUT,
);

ipcMain.handle("billing:voidInvoice", (_event, id: unknown, reason: unknown) =>
  typeof id === "string" && typeof reason === "string"
    ? authedRequest<InvoiceDetailDto>("POST", `${invoicePath(id)}/void`, { reason })
    : BAD_INPUT,
);

ipcMain.handle("billing:ledger", (_event, subscriberId: unknown, range: unknown) =>
  typeof subscriberId === "string" && isRecord(range)
    ? authedRequest<SubscriberLedgerDto>("GET", listPath(`${subscriberPath(subscriberId)}/ledger`, LEDGER_KEYS, range))
    : BAD_INPUT,
);

/* ------------------------------- Payments ------------------------------- */

const paymentPath = (id: string) => `/payments/${encodeURIComponent(id)}`;

ipcMain.handle("payments:context", (_event, subscriberId: unknown) =>
  typeof subscriberId === "string"
    ? authedRequest<PaymentContextDto>("GET", `${subscriberPath(subscriberId)}/payment-context`)
    : BAD_INPUT,
);

ipcMain.handle("payments:post", (_event, input: unknown) =>
  isRecord(input) ? authedRequest<PaymentDetailDto>("POST", "/payments", input) : BAD_INPUT,
);

ipcMain.handle("payments:get", (_event, id: unknown) =>
  typeof id === "string" ? authedRequest<PaymentDetailDto>("GET", paymentPath(id)) : BAD_INPUT,
);

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});