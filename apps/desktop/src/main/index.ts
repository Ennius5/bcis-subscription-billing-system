import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type {
  ApiFailure,
  ApiResult,
  AreaDto,
  AuthResult,
  AvailableUserDto,
  BatchDetailDto,
  BatchPageDto,
  CollectorReportDto,
  CreateBatchResultDto,
  BillingSummaryDto,
  FinalizeResultDto,
  InvoiceDetailDto,
  InvoicePageDto,
  SubscriberLedgerDto,
  GcashSubmissionDto,
  GcashSubmissionPageDto,
  GlobalSearchResultDto,
  PaymentContextDto,
  PaymentDetailDto,
  PaymentPageDto,
  CollectorDto,
  PlanDto,
  AgingReportDto,
  ReceivableFilterOptionsDto,
  ReceivablePageDto,
  CollectionsReportDto,
  BillingVsCollectionDto,
  RevenueReportDto,
  ExportFormat,
  SavedExportDto,
  ReceivableSettingsDto,
  ReconnectionDto,
  ReconnectionPageDto,
  ServiceControlHistoryDto,
  SuspensionCandidateListDto,
  TechnicianDto,
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

// Private helpers: the renderer can only reach them through the handlers below.

/** Adds the token, clears it on 401, maps failures; `read` turns a successful response into data. */
async function authedFetch<T>(
  urlPath: string,
  init: { method: "GET" | "POST" | "PATCH" | "DELETE"; headers?: Record<string, string>; body?: string | Uint8Array<ArrayBuffer> },
  read: (res: Response) => Promise<T>,
): Promise<ApiResult<T>> {
  if (!currentToken) {
    return { ok: false, code: "UNAUTHENTICATED", message: "Please sign in." };
  }
  try {
    const res = await fetch(`${API_URL}${urlPath}`, {
      method: init.method,
      headers: { ...init.headers, Authorization: `Bearer ${currentToken}` },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    if (res.status === 401) currentToken = null; // session expired or revoked
    if (!res.ok) return await readError(res);
    return { ok: true, data: await read(res) };
  } catch {
    return NETWORK_ERROR;
  }
}

function authedRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<ApiResult<T>> {
  return authedFetch(
    urlPath,
    body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method },
    async (res) => (await res.json()) as T,
  );
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

ipcMain.handle("billing:adjustInvoice", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<InvoiceDetailDto>("POST", `${invoicePath(id)}/adjustments`, input)
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

const PAYMENT_LIST_KEYS = ["page", "pageSize", "subscriberId", "method", "status", "from", "to", "search"] as const;

ipcMain.handle("payments:list", (_event, query: unknown) =>
  isRecord(query) ? authedRequest<PaymentPageDto>("GET", listPath("/payments", PAYMENT_LIST_KEYS, query)) : BAD_INPUT,
);

ipcMain.handle("payments:reverse", (_event, id: unknown, reason: unknown) =>
  typeof id === "string" && typeof reason === "string"
    ? authedRequest<PaymentDetailDto>("POST", `${paymentPath(id)}/reverse`, { reason })
    : BAD_INPUT,
);

/* -------------------------------- GCash -------------------------------- */

const GCASH_LIST_KEYS = ["page", "pageSize", "status", "subscriberId"] as const;
const gcashPath = (id: string) => `/gcash-submissions/${encodeURIComponent(id)}`;

// Only for a quick answer before uploading; the API checks the real type and size again.
const PROOF_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const PROOF_MAX_BYTES = 5 * 1024 * 1024;

ipcMain.handle("gcash:list", (_event, query: unknown) =>
  isRecord(query)
    ? authedRequest<GcashSubmissionPageDto>("GET", listPath("/gcash-submissions", GCASH_LIST_KEYS, query))
    : BAD_INPUT,
);

ipcMain.handle("gcash:get", (_event, id: unknown) =>
  typeof id === "string" ? authedRequest<GcashSubmissionDto>("GET", gcashPath(id)) : BAD_INPUT,
);

ipcMain.handle("gcash:create", (_event, input: unknown) =>
  isRecord(input) ? authedRequest<GcashSubmissionDto>("POST", "/gcash-submissions", input) : BAD_INPUT,
);

// The file is chosen in a native dialog and read here, so the renderer never handles paths.
ipcMain.handle("gcash:attachProof", async (event, id: unknown): Promise<ApiResult<GcashSubmissionDto>> => {
  if (typeof id !== "string") return BAD_INPUT;
  const options: Electron.OpenDialogOptions = {
    title: "Choose the GCash proof image",
    properties: ["openFile"],
    filters: [{ name: "Images (PNG, JPEG, WebP)", extensions: ["png", "jpg", "jpeg", "webp"] }],
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  const filePath = picked.filePaths[0];
  if (picked.canceled || !filePath) return { ok: false, code: "CANCELLED", message: "No file was chosen." };

  const contentType = PROOF_TYPES[path.extname(filePath).toLowerCase()];
  if (!contentType) {
    return { ok: false, code: "PROOF_INVALID_TYPE", message: "Only PNG, JPEG or WebP images can be attached." };
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    if ((await stat(filePath)).size > PROOF_MAX_BYTES) {
      return { ok: false, code: "PROOF_TOO_LARGE", message: "The image is larger than 5 MB." };
    }
    bytes = new Uint8Array(await readFile(filePath)); // a plain copy, as fetch's body type requires
  } catch {
    return { ok: false, code: "FILE_READ", message: "The file could not be read." };
  }
  return authedFetch(
    `${gcashPath(id)}/proofs`,
    {
      method: "POST",
      headers: { "Content-Type": contentType, "X-Filename": encodeURIComponent(path.basename(filePath)) },
      body: bytes,
    },
    async (res) => (await res.json()) as GcashSubmissionDto,
  );
});

// Returned as a data: URL (allowed by the page's CSP), fetched here so the token stays in main.
ipcMain.handle("gcash:proofImage", (_event, proofId: unknown) =>
  typeof proofId === "string"
    ? authedFetch(`/gcash-proofs/${encodeURIComponent(proofId)}`, { method: "GET" }, async (res) => {
        const type = res.headers.get("content-type") ?? "";
        if (!Object.values(PROOF_TYPES).includes(type)) throw new Error("Unexpected proof type");
        return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
      })
    : BAD_INPUT,
);

ipcMain.handle("gcash:verify", (_event, id: unknown) =>
  typeof id === "string" ? authedRequest<GcashSubmissionDto>("POST", `${gcashPath(id)}/verify`) : BAD_INPUT,
);

ipcMain.handle("gcash:reject", (_event, id: unknown, reason: unknown) =>
  typeof id === "string" && typeof reason === "string"
    ? authedRequest<GcashSubmissionDto>("POST", `${gcashPath(id)}/reject`, { reason })
    : BAD_INPUT,
);

/* -------------------------- Collection batches -------------------------- */

const BATCH_LIST_KEYS = ["page", "pageSize", "status", "collectorId", "from", "to"] as const;
const batchPath = (id: string) => `/collection-batches/${encodeURIComponent(id)}`;

ipcMain.handle("batches:list", (_event, query: unknown) =>
  isRecord(query) ? authedRequest<BatchPageDto>("GET", listPath("/collection-batches", BATCH_LIST_KEYS, query)) : BAD_INPUT,
);

ipcMain.handle("batches:get", (_event, id: unknown) =>
  typeof id === "string" ? authedRequest<BatchDetailDto>("GET", batchPath(id)) : BAD_INPUT,
);

ipcMain.handle("batches:create", (_event, input: unknown) =>
  isRecord(input) ? authedRequest<CreateBatchResultDto>("POST", "/collection-batches", input) : BAD_INPUT,
);

ipcMain.handle("batches:addAccount", (_event, id: unknown, subscriberId: unknown) =>
  typeof id === "string" && typeof subscriberId === "string"
    ? authedRequest<BatchDetailDto>("POST", `${batchPath(id)}/accounts`, { subscriberId })
    : BAD_INPUT,
);

ipcMain.handle("batches:removeAccount", (_event, id: unknown, subscriberId: unknown) =>
  typeof id === "string" && typeof subscriberId === "string"
    ? authedRequest<BatchDetailDto>("DELETE", `${batchPath(id)}/accounts/${encodeURIComponent(subscriberId)}`)
    : BAD_INPUT,
);

ipcMain.handle("batches:dispatch", (_event, id: unknown) =>
  typeof id === "string" ? authedRequest<BatchDetailDto>("POST", `${batchPath(id)}/dispatch`) : BAD_INPUT,
);

ipcMain.handle("batches:submit", (_event, id: unknown) =>
  typeof id === "string" ? authedRequest<BatchDetailDto>("POST", `${batchPath(id)}/submit`) : BAD_INPUT,
);

ipcMain.handle("batches:cancel", (_event, id: unknown, reason: unknown) =>
  typeof id === "string" && typeof reason === "string"
    ? authedRequest<BatchDetailDto>("POST", `${batchPath(id)}/cancel`, { reason })
    : BAD_INPUT,
);

ipcMain.handle("batches:recordCollection", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<PaymentDetailDto>("POST", `${batchPath(id)}/collections`, input)
    : BAD_INPUT,
);

ipcMain.handle("batches:recordRemittance", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<BatchDetailDto>("POST", `${batchPath(id)}/remittances`, input)
    : BAD_INPUT,
);

ipcMain.handle("batches:voidRemittance", (_event, id: unknown, remittanceId: unknown, reason: unknown) =>
  typeof id === "string" && typeof remittanceId === "string" && typeof reason === "string"
    ? authedRequest<BatchDetailDto>(
        "POST",
        `${batchPath(id)}/remittances/${encodeURIComponent(remittanceId)}/void`,
        { reason },
      )
    : BAD_INPUT,
);

ipcMain.handle("batches:reconcile", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<BatchDetailDto>("POST", `${batchPath(id)}/reconcile`, input)
    : BAD_INPUT,
);

ipcMain.handle("batches:close", (_event, id: unknown, differenceCentavos: unknown) =>
  typeof id === "string" && typeof differenceCentavos === "number"
    ? authedRequest<BatchDetailDto>("POST", `${batchPath(id)}/close`, { differenceCentavos })
    : BAD_INPUT,
);

const isIsoDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

ipcMain.handle("batches:collectorReport", (_event, from: unknown, to: unknown) =>
  isIsoDate(from) && isIsoDate(to)
    ? authedRequest<CollectorReportDto>("GET", `/collection-reports/collectors?from=${from}&to=${to}`)
    : BAD_INPUT,
);

/* ------------------------------ Receivables ------------------------------ */

const AGING_KEYS = ["collectorId", "areaId", "planId", "serviceType"] as const;
const RECEIVABLE_LIST_KEYS = [...AGING_KEYS, "view", "bucket", "search", "sort", "page", "pageSize"] as const;

ipcMain.handle("receivables:list", (_event, query: unknown) =>
  isRecord(query)
    ? authedRequest<ReceivablePageDto>("GET", listPath("/receivables", RECEIVABLE_LIST_KEYS, query))
    : BAD_INPUT,
);

ipcMain.handle("receivables:aging", (_event, query: unknown) =>
  isRecord(query)
    ? authedRequest<AgingReportDto>("GET", listPath("/receivables/aging", AGING_KEYS, query))
    : BAD_INPUT,
);

/* -------------------------------- Exports -------------------------------- */

// Mirrors REPORT_EXPORT_CONTENT_TYPES in @bcis/shared (main does not load shared at runtime).
const EXPORT_TYPES: Record<ExportFormat, { contentType: string; filter: Electron.FileFilter }> = {
  pdf: { contentType: "application/pdf", filter: { name: "PDF document", extensions: ["pdf"] } },
  xlsx: {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filter: { name: "Excel workbook", extensions: ["xlsx"] },
  },
};
const isExportFormat = (value: unknown): value is ExportFormat => value === "pdf" || value === "xlsx";

/** Where the last export was saved; kept here so the renderer never handles file paths. */
let lastSavedExport: string | null = null;

/** This PC's calendar date (the office PCs run on Philippine time). */
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Asks where to save first, then downloads and writes the file. Cancelling the dialog sends
 * nothing to the server, so only saved exports appear in the audit log.
 */
async function saveExport(
  event: Electron.IpcMainInvokeEvent,
  urlPath: string,
  fileStem: string,
  format: ExportFormat,
): Promise<ApiResult<SavedExportDto>> {
  const type = EXPORT_TYPES[format];
  const options: Electron.SaveDialogOptions = {
    title: "Save report",
    defaultPath: path.join(app.getPath("documents"), `${fileStem}.${format}`),
    filters: [type.filter],
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return { ok: false, code: "CANCELLED", message: "The report was not saved." };

  const file = await authedFetch(urlPath, { method: "GET" }, async (res) => {
    if (res.headers.get("content-type") !== type.contentType) throw new Error("Unexpected export type");
    return new Uint8Array(await res.arrayBuffer());
  });
  if (!file.ok) return file;
  try {
    await writeFile(picked.filePath, file.data);
  } catch {
    return { ok: false, code: "FILE_WRITE", message: "The file could not be saved there. Is it open in another program?" };
  }
  lastSavedExport = picked.filePath;
  return { ok: true, data: { fileName: path.basename(picked.filePath), format } };
}

ipcMain.handle("exports:openLast", async (): Promise<ApiResult<null>> => {
  if (!lastSavedExport) return { ok: false, code: "NOT_FOUND", message: "Nothing has been saved yet." };
  const problem = await shell.openPath(lastSavedExport);
  return problem ? { ok: false, code: "OPEN_FAILED", message: problem } : { ok: true, data: null };
});

ipcMain.handle("receivables:exportAging", (event, query: unknown, format: unknown) =>
  isRecord(query) && isExportFormat(format)
    ? saveExport(event, listPath("/receivables/aging/export", [...AGING_KEYS, "format"], { ...query, format }), `ar-aging-${localToday()}`, format)
    : BAD_INPUT,
);

// The account number only shapes the suggested file name, so anything unexpected falls back.
const fileSafe = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9-]{1,40}$/.test(value) ? value : "statement";

ipcMain.handle("billing:exportStatement", (event, subscriberId: unknown, range: unknown, format: unknown, accountNumber: unknown) =>
  typeof subscriberId === "string" && isRecord(range) && isExportFormat(format)
    ? saveExport(
        event,
        listPath(`${subscriberPath(subscriberId)}/statement/export`, [...LEDGER_KEYS, "format"], { ...range, format }),
        `soa-${fileSafe(accountNumber)}-${isIsoDate(range.to) ? range.to : localToday()}`,
        format,
      )
    : BAD_INPUT,
);

ipcMain.handle("receivables:filterOptions", () =>
  authedRequest<ReceivableFilterOptionsDto>("GET", "/receivables/filter-options"),
);

/* -------------------------------- Reports -------------------------------- */

const COLLECTIONS_KEYS = ["from", "to", "groupBy"] as const;

ipcMain.handle("reports:collections", (_event, query: unknown) =>
  isRecord(query) ? authedRequest<CollectionsReportDto>("GET", listPath("/reports/collections", COLLECTIONS_KEYS, query)) : BAD_INPUT,
);

ipcMain.handle("reports:exportCollections", (event, query: unknown, format: unknown) =>
  isRecord(query) && isIsoDate(query.from) && isIsoDate(query.to) && isExportFormat(format)
    ? saveExport(
        event,
        listPath("/reports/collections/export", [...COLLECTIONS_KEYS, "format"], { ...query, format }),
        `collections-${query.from}_to_${query.to}`,
        format,
      )
    : BAD_INPUT,
);

const isMonth = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
const MONTH_RANGE_KEYS = ["from", "to"] as const;
const REVENUE_KEYS = [...MONTH_RANGE_KEYS, "dimension"] as const;
const isRevenueDimension = (value: unknown): value is string =>
  value === "plan" || value === "service_type" || value === "area";

ipcMain.handle("reports:billingVsCollection", (_event, query: unknown) =>
  isRecord(query)
    ? authedRequest<BillingVsCollectionDto>("GET", listPath("/reports/billing-vs-collection", MONTH_RANGE_KEYS, query))
    : BAD_INPUT,
);

ipcMain.handle("reports:exportBillingVsCollection", (event, query: unknown, format: unknown) =>
  isRecord(query) && isMonth(query.from) && isMonth(query.to) && isExportFormat(format)
    ? saveExport(
        event,
        listPath("/reports/billing-vs-collection/export", [...MONTH_RANGE_KEYS, "format"], { ...query, format }),
        `billing-vs-collection-${query.from}_to_${query.to}`,
        format,
      )
    : BAD_INPUT,
);

ipcMain.handle("reports:revenue", (_event, query: unknown) =>
  isRecord(query) ? authedRequest<RevenueReportDto>("GET", listPath("/reports/revenue", REVENUE_KEYS, query)) : BAD_INPUT,
);

ipcMain.handle("reports:exportRevenue", (event, query: unknown, format: unknown) =>
  isRecord(query) && isMonth(query.from) && isMonth(query.to) && isRevenueDimension(query.dimension) && isExportFormat(format)
    ? saveExport(
        event,
        listPath("/reports/revenue/export", [...REVENUE_KEYS, "format"], { ...query, format }),
        `revenue-by-${query.dimension.replace("_", "-")}-${query.from}_to_${query.to}`,
        format,
      )
    : BAD_INPUT,
);

/* --------------------------- Service control --------------------------- */

const CANDIDATE_KEYS = [...AGING_KEYS, "search"] as const;
const RECONNECTION_LIST_KEYS = ["status", "page", "pageSize"] as const;
const servicePath = (id: string) => `/service-accounts/${encodeURIComponent(id)}`;
const reconnectionPath = (id: string) => `/reconnections/${encodeURIComponent(id)}`;

ipcMain.handle("serviceControl:candidates", (_event, query: unknown) =>
  isRecord(query)
    ? authedRequest<SuspensionCandidateListDto>(
        "GET",
        listPath("/receivables/suspension-candidates", CANDIDATE_KEYS, query),
      )
    : BAD_INPUT,
);

ipcMain.handle("serviceControl:suspend", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<ServiceAccountDetailDto>("POST", `${servicePath(id)}/suspend`, input)
    : BAD_INPUT,
);

ipcMain.handle("serviceControl:history", (_event, id: unknown) =>
  typeof id === "string"
    ? authedRequest<ServiceControlHistoryDto>("GET", `${servicePath(id)}/service-control`)
    : BAD_INPUT,
);

ipcMain.handle("serviceControl:requestReconnection", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<ReconnectionDto>("POST", `${servicePath(id)}/reconnections`, input)
    : BAD_INPUT,
);

ipcMain.handle("serviceControl:listReconnections", (_event, query: unknown) =>
  isRecord(query)
    ? authedRequest<ReconnectionPageDto>("GET", listPath("/reconnections", RECONNECTION_LIST_KEYS, query))
    : BAD_INPUT,
);

ipcMain.handle("serviceControl:assign", (_event, id: unknown, technicianUserId: unknown) =>
  typeof id === "string" && typeof technicianUserId === "string"
    ? authedRequest<ReconnectionDto>("POST", `${reconnectionPath(id)}/assign`, { technicianUserId })
    : BAD_INPUT,
);

ipcMain.handle("serviceControl:complete", (_event, id: unknown, input: unknown) =>
  typeof id === "string" && isRecord(input)
    ? authedRequest<ReconnectionDto>("POST", `${reconnectionPath(id)}/complete`, input)
    : BAD_INPUT,
);

ipcMain.handle("serviceControl:cancel", (_event, id: unknown, reason: unknown) =>
  typeof id === "string" && typeof reason === "string"
    ? authedRequest<ReconnectionDto>("POST", `${reconnectionPath(id)}/cancel`, { reason })
    : BAD_INPUT,
);

ipcMain.handle("serviceControl:technicians", () => authedRequest<TechnicianDto[]>("GET", "/technicians"));

/* ------------------------------- Settings ------------------------------- */

ipcMain.handle("settings:receivables", () => authedRequest<ReceivableSettingsDto>("GET", "/settings/receivables"));

ipcMain.handle("settings:updateReceivables", (_event, input: unknown) =>
  isRecord(input) ? authedRequest<ReceivableSettingsDto>("PATCH", "/settings/receivables", input) : BAD_INPUT,
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