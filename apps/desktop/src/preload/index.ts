import { contextBridge, ipcRenderer } from "electron";

export interface HealthResult {
  ok: boolean;
  data: unknown;
}

export interface SessionInfo {
  user: { id: string; username: string; fullName: string };
  permissions: string[];
}

export type AuthResult =
  | ({ ok: true } & SessionInfo)
  | { ok: false; code: string; message: string };

const bcis = {
  getHealth: (): Promise<HealthResult> => ipcRenderer.invoke("api:health"),
  login: (username: string, password: string): Promise<AuthResult> =>
    ipcRenderer.invoke("auth:login", username, password),
  me: (): Promise<AuthResult> => ipcRenderer.invoke("auth:me"),
  logout: (): Promise<void> => ipcRenderer.invoke("auth:logout"),
};

contextBridge.exposeInMainWorld("bcis", bcis);

export type BcisApi = typeof bcis;