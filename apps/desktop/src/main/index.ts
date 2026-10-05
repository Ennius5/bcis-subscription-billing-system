import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";

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

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});