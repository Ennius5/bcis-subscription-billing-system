import { contextBridge, ipcRenderer } from "electron";

export interface HealthResult {
  ok: boolean;
  data: unknown;
}

const bcis = {
  getHealth: (): Promise<HealthResult> => ipcRenderer.invoke("api:health"),
};

contextBridge.exposeInMainWorld("bcis", bcis);

export type BcisApi = typeof bcis;