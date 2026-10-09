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

export interface SubscriberListQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  collectionAreaId?: string;
  assignedCollectorId?: string;
  search?: string;
}

export interface SubscriberListItemDto {
  id: string;
  accountNumber: string;
  fullName: string;
  status: string;
  billingDay: number;
  collectionAreaId: string | null;
  areaCode: string | null;
  areaName: string | null;
  assignedCollectorId: string | null;
  collectorCode: string | null;
  collectorName: string | null;
  primaryContact: string | null;
  primaryAddress: string | null;
}

export interface SubscriberPageDto {
  items: SubscriberListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SubscriberAddressDto {
  id: string;
  label: string | null;
  line1: string;
  barangay: string;
  city: string;
  province: string | null;
  landmark: string | null;
  isPrimary: boolean;
  isActive: boolean;
}

export interface SubscriberContactDto {
  id: string;
  type: string;
  value: string;
  contactName: string | null;
  isPrimary: boolean;
  isActive: boolean;
}

export interface SubscriberDto {
  id: string;
  accountNumber: string;
  fullName: string;
  status: string;
  billingDay: number;
  notes: string | null;
  collectionAreaId: string | null;
  areaCode: string | null;
  areaName: string | null;
  assignedCollectorId: string | null;
  collectorCode: string | null;
  collectorName: string | null;
  createdAt: string; // ISO timestamps: dates arrive as JSON strings
  updatedAt: string;
  addresses: SubscriberAddressDto[];
  contacts: SubscriberContactDto[];
}

export interface ServiceAccountListQuery {
  page?: number;
  pageSize?: number;
  subscriberId?: string;
  status?: string;
  planId?: string;
  serviceType?: string;
  search?: string;
}

export interface ServiceAccountDto {
  id: string;
  serviceNumber: string;
  status: string;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  subscriberStatus: string;
  planId: string;
  planCode: string;
  planName: string;
  planPriceCentavos: number;
  serviceType: string;
  currentRateCentavos: number;
  billingDay: number;
  activationDate: string | null; // "YYYY-MM-DD"
  billingStartDate: string | null;
  installationAddressId: string;
  addressLine1: string;
  addressBarangay: string;
  addressCity: string;
  /** The account's own override; null means the subscriber's collector applies. */
  assignedCollectorId: string | null;
  /** The effective collector: the override if set, otherwise the subscriber's. */
  collectorCode: string | null;
  collectorName: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceAccountPageDto {
  items: ServiceAccountDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ServiceEventDto {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  effectiveDate: string;
  reason: string | null;
  actorUsername: string | null;
  actorName: string | null;
  occurredAt: string;
}

export interface ServiceAccountDetailDto extends ServiceAccountDto {
  events: ServiceEventDto[];
}

export interface SubscriberHistoryDto {
  id: string;
  occurredAt: string;
  action: string;
  actorUsername: string | null;
  actorName: string | null;
  reason: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
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
  subscribers: {
    list: (query: SubscriberListQuery): Promise<ApiResult<SubscriberPageDto>> =>
      ipcRenderer.invoke("subscribers:list", query),
    get: (id: string): Promise<ApiResult<SubscriberDto>> => ipcRenderer.invoke("subscribers:get", id),
    history: (id: string): Promise<ApiResult<SubscriberHistoryDto[]>> =>
      ipcRenderer.invoke("subscribers:history", id),
    create: (input: Record<string, unknown>): Promise<ApiResult<SubscriberDto>> =>
      ipcRenderer.invoke("subscribers:create", input),
    update: (id: string, input: Record<string, unknown>): Promise<ApiResult<SubscriberDto>> =>
      ipcRenderer.invoke("subscribers:update", id, input),
    changeStatus: (id: string, input: Record<string, unknown>): Promise<ApiResult<SubscriberDto>> =>
      ipcRenderer.invoke("subscribers:changeStatus", id, input),
    changeAssignment: (id: string, input: Record<string, unknown>): Promise<ApiResult<SubscriberDto>> =>
      ipcRenderer.invoke("subscribers:changeAssignment", id, input),
    addAddress: (id: string, input: Record<string, unknown>): Promise<ApiResult<SubscriberDto>> =>
      ipcRenderer.invoke("subscribers:addAddress", id, input),
    updateAddress: (
      id: string,
      addressId: string,
      input: Record<string, unknown>,
    ): Promise<ApiResult<SubscriberDto>> =>
      ipcRenderer.invoke("subscribers:updateAddress", id, addressId, input),
    addContact: (id: string, input: Record<string, unknown>): Promise<ApiResult<SubscriberDto>> =>
      ipcRenderer.invoke("subscribers:addContact", id, input),
    updateContact: (
      id: string,
      contactId: string,
      input: Record<string, unknown>,
    ): Promise<ApiResult<SubscriberDto>> =>
      ipcRenderer.invoke("subscribers:updateContact", id, contactId, input),
  },
  serviceAccounts: {
    list: (query: ServiceAccountListQuery): Promise<ApiResult<ServiceAccountPageDto>> =>
      ipcRenderer.invoke("serviceAccounts:list", query),
    get: (id: string): Promise<ApiResult<ServiceAccountDetailDto>> => ipcRenderer.invoke("serviceAccounts:get", id),
    create: (subscriberId: string, input: Record<string, unknown>): Promise<ApiResult<ServiceAccountDetailDto>> =>
      ipcRenderer.invoke("serviceAccounts:create", subscriberId, input),
    update: (id: string, input: Record<string, unknown>): Promise<ApiResult<ServiceAccountDetailDto>> =>
      ipcRenderer.invoke("serviceAccounts:update", id, input),
    changeStatus: (id: string, input: Record<string, unknown>): Promise<ApiResult<ServiceAccountDetailDto>> =>
      ipcRenderer.invoke("serviceAccounts:changeStatus", id, input),
    changeRate: (id: string, input: Record<string, unknown>): Promise<ApiResult<ServiceAccountDetailDto>> =>
      ipcRenderer.invoke("serviceAccounts:changeRate", id, input),
    changePlan: (id: string, input: Record<string, unknown>): Promise<ApiResult<ServiceAccountDetailDto>> =>
      ipcRenderer.invoke("serviceAccounts:changePlan", id, input),
    changeCollector: (id: string, input: Record<string, unknown>): Promise<ApiResult<ServiceAccountDetailDto>> =>
      ipcRenderer.invoke("serviceAccounts:changeCollector", id, input),
  },
};

contextBridge.exposeInMainWorld("bcis", bcis);

export type BcisApi = typeof bcis;


