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

export interface AreaDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface CollectorDto {
  id: string;
  code: string;
  fullName: string;
  contactNumber: string | null;
  userId: string | null;
  username: string | null;
  isActive: boolean;
}

export interface AvailableUserDto {
  id: string;
  username: string;
  fullName: string;
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

    collectionAreas: {
    list: (includeInactive: boolean): Promise<ApiResult<AreaDto[]>> =>
      ipcRenderer.invoke("collectionAreas:list", includeInactive),
    create: (input: Record<string, unknown>): Promise<ApiResult<AreaDto>> =>
      ipcRenderer.invoke("collectionAreas:create", input),
    update: (id: string, input: Record<string, unknown>): Promise<ApiResult<AreaDto>> =>
      ipcRenderer.invoke("collectionAreas:update", id, input),
  },
  collectors: {
    list: (includeInactive: boolean): Promise<ApiResult<CollectorDto[]>> =>
      ipcRenderer.invoke("collectors:list", includeInactive),
    create: (input: Record<string, unknown>): Promise<ApiResult<CollectorDto>> =>
      ipcRenderer.invoke("collectors:create", input),
    update: (id: string, input: Record<string, unknown>): Promise<ApiResult<CollectorDto>> =>
      ipcRenderer.invoke("collectors:update", id, input),
    availableUsers: (): Promise<ApiResult<AvailableUserDto[]>> =>
      ipcRenderer.invoke("collectors:availableUsers"),
  },
};

contextBridge.exposeInMainWorld("bcis", bcis);

export type BcisApi = typeof bcis;


