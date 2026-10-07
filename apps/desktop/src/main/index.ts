import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type {ApiFailure,ApiResult,  AuthResult, PlanDto, SessionInfo } from "../preload/index";

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
  path: string,
  body?: Record<string, unknown>,
): Promise<ApiResult<T>> {
  if (!currentToken) {
    return { ok: false, code: "UNAUTHENTICATED", message: "Please sign in." };
  }
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${currentToken}` };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(`${API_URL}${path}`, {
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

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});