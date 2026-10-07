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

export interface ApiIssue {
  path: string;
  message: string;
}

export interface ApiFailure {
  ok: false;
  code: string;
  message: string;
  issues?: ApiIssue[];
}

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export interface PlanDto {
  id: string;
  code: string;
  name: string;
  serviceType: string;
  priceCentavos: number;
  installationFeeCentavos: number;
  reconnectionFeeCentavos: number;
  description: string | null;
  speedMbps: number | null;
  channelCount: number | null;
  isActive: boolean;
}

const bcis = {
  getHealth: (): Promise<HealthResult> => ipcRenderer.invoke("api:health"),
  login: (username: string, password: string): Promise<AuthResult> =>
    ipcRenderer.invoke("auth:login", username, password),
  me: (): Promise<AuthResult> => ipcRenderer.invoke("auth:me"),
  logout: (): Promise<void> => ipcRenderer.invoke("auth:logout"),
  plans: {
    list: (includeInactive: boolean): Promise<ApiResult<PlanDto[]>> =>
      ipcRenderer.invoke("plans:list", includeInactive),
    create: (input: Record<string, unknown>): Promise<ApiResult<PlanDto>> =>
      ipcRenderer.invoke("plans:create", input),
    update: (id: string, input: Record<string, unknown>): Promise<ApiResult<PlanDto>> =>
      ipcRenderer.invoke("plans:update", id, input),
  },
};

contextBridge.exposeInMainWorld("bcis", bcis);

export type BcisApi = typeof bcis;


