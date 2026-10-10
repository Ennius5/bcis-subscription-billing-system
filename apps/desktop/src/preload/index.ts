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

/* ------------------------------- Billing ------------------------------- */

export interface BillingTotalsDto {
  count: number;
  totalCentavos: number;
}

export interface BillingSummaryDto {
  period: string; // "YYYY-MM"
  generated: boolean;
  drafts: BillingTotalsDto;
  /** Finalized and not void. */
  finalized: BillingTotalsDto;
  voided: BillingTotalsDto;
  /** Active, billable accounts with no invoice for the month yet. */
  notYetBilled: number;
}

export interface FinalizeResultDto extends BillingSummaryDto {
  finalizedNow: number;
  firstNumber: string | null;
  lastNumber: string | null;
  /** Drafts left as drafts because their account is no longer active. */
  skipped: { invoiceId: string; serviceNumber: string; accountStatus: string }[];
  /** Advance credit from earlier payments applied to the newly finalized invoices. */
  creditAppliedCentavos: number;
}

export interface InvoiceListQuery {
  page?: number;
  pageSize?: number;
  period?: string;
  status?: string;
  subscriberId?: string;
  serviceAccountId?: string;
  search?: string;
}

export interface InvoiceDto {
  id: string;
  invoiceNumber: string | null; // null while a draft
  status: string;
  /** The stored status, or "overdue" for an open invoice past its due date. */
  displayStatus: string;
  periodStart: string; // "YYYY-MM-DD"
  periodEnd: string;
  invoiceDate: string;
  dueDate: string;
  totalCentavos: number;
  paidCentavos: number;
  /** Net of adjustments: debits minus credits. Effective total = totalCentavos + adjustedCentavos. */
  adjustedCentavos: number;
  balanceCentavos: number;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  serviceAccountId: string;
  serviceNumber: string;
}

export interface InvoicePageDto {
  items: InvoiceDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface InvoiceDetailDto extends InvoiceDto {
  planName: string;
  items: { lineNo: number; itemType: string; description: string; amountCentavos: number; rateCentavos: number | null }[];
  finalizedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  adjustments: InvoiceAdjustmentDto[];
}

export interface InvoiceAdjustmentDto {
  id: string;
  adjustmentNumber: string;
  kind: string; // credit | debit
  category: string;
  amountCentavos: number;
  reason: string;
  createdByName: string;
  createdAt: string;
}

export interface LedgerRange {
  from?: string; // "YYYY-MM-DD", inclusive
  to?: string;
}

export interface LedgerEntryDto {
  id: string;
  seq: number;
  entryDate: string;
  entryType: string;
  reference: string;
  description: string;
  serviceAccountId: string | null;
  invoiceId: string | null;
  debitCentavos: number;
  creditCentavos: number;
  /** Running balance after this entry; positive means the subscriber owes. */
  balanceCentavos: number;
}

export interface SubscriberLedgerDto {
  subscriberId: string;
  from: string | null;
  to: string | null;
  openingBalanceCentavos: number;
  entries: LedgerEntryDto[];
  closingBalanceCentavos: number;
  totalDebitCentavos: number;
  totalCreditCentavos: number;
}

export interface GlobalSearchHitDto {
  id: string;
  accountNumber: string;
  fullName: string;
  status: string;
  primaryAddress: string | null;
  primaryContact: string | null;
  /** What the query matched: accountNumber, serviceNumber, name, contact, address, receiptNumber, invoiceNumber or gcashReference. */
  matches: { field: string; value: string }[];
}

export interface GlobalSearchResultDto {
  query: string;
  items: GlobalSearchHitDto[];
  hasMore: boolean;
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

/* ------------------------------- Payments ------------------------------- */

export interface OpenInvoiceDto {
  id: string;
  invoiceNumber: string;
  serviceNumber: string;
  periodStart: string; // "YYYY-MM-DD"
  dueDate: string;
  totalCentavos: number;
  paidCentavos: number;
  adjustedCentavos: number;
  balanceCentavos: number;
  displayStatus: string;
}

export interface PaymentContextDto {
  subscriber: { id: string; accountNumber: string; fullName: string; status: string };
  /** Ledger balance: positive is owed, negative is credit in the subscriber's favour. */
  balanceCentavos: number;
  creditCentavos: number;
  /** Oldest first: the order oldest-first allocation pays them in. */
  openInvoices: OpenInvoiceDto[];
}

export interface PaymentAllocationDto {
  invoiceId: string;
  invoiceNumber: string;
  serviceNumber: string;
  periodStart: string;
  amountCentavos: number;
  source: string; // auto | manual | credit
  allocatedAt: string;
}

export interface PaymentDetailDto {
  id: string;
  receiptNumber: string;
  status: string; // posted | reversed
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  method: string;
  amountCentavos: number;
  allocatedCentavos: number;
  /** Unallocated money still available as credit (0 once reversed). */
  creditCentavos: number;
  paymentDate: string;
  referenceNumber: string | null;
  notes: string | null;
  gcashSubmissionId: string | null;
  receivedByName: string;
  postedAt: string;
  allocations: PaymentAllocationDto[];
  reversal: { reason: string; reversedAt: string; reversedByName: string } | null;
}

export interface PaymentListQuery {
  page?: number;
  pageSize?: number;
  subscriberId?: string;
  method?: string;
  status?: string;
  from?: string; // "YYYY-MM-DD", inclusive payment dates
  to?: string;
  search?: string;
}

export interface PaymentListItemDto {
  id: string;
  receiptNumber: string;
  status: string;
  paymentDate: string;
  postedAt: string;
  method: string;
  amountCentavos: number;
  allocatedCentavos: number;
  referenceNumber: string | null;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  receivedByName: string;
}

export interface PaymentPageDto {
  items: PaymentListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

/* -------------------------------- GCash -------------------------------- */

export interface GcashSubmissionListQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  subscriberId?: string;
}

export interface GcashSubmissionListItemDto {
  id: string;
  status: string; // pending | verified | rejected | reversed
  referenceNumber: string;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  senderName: string;
  amountCentavos: number;
  transactionDate: string;
  recordedAt: string;
  recordedByName: string;
  proofCount: number;
}

export interface GcashSubmissionPageDto {
  items: GcashSubmissionListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GcashSubmissionDto extends GcashSubmissionListItemDto {
  senderNumber: string;
  notes: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  payment: { id: string; receiptNumber: string; status: string } | null;
  proofs: { id: string; mimeType: string; sizeBytes: number; originalFilename: string | null; uploadedAt: string }[];
}

/* -------------------------- Collection batches -------------------------- */

export interface BatchListQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  collectorId?: string;
  from?: string; // "YYYY-MM-DD", inclusive collection dates
  to?: string;
}

export interface BatchListItemDto {
  id: string;
  batchNumber: string;
  status: string; // open | in_progress | submitted | remitted | reconciled | closed | cancelled
  collectionDate: string;
  collectorCode: string;
  collectorName: string;
  areaCode: string | null;
  accountCount: number;
  totalDueCentavos: number;
}

export interface BatchPageDto {
  items: BatchListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Who did a lifecycle step, and when. */
export interface BatchStepDto {
  at: string;
  byName: string;
}

/** One route sheet line. The amounts are the snapshot taken when the account was added. */
export interface BatchAccountDto {
  subscriberId: string;
  accountNumber: string;
  fullName: string;
  subscriberStatus: string;
  areaCode: string | null;
  addressLine: string | null;
  barangay: string | null;
  city: string | null;
  landmark: string | null;
  currentCentavos: number;
  arrearsCentavos: number;
  creditCentavos: number;
  totalDueCentavos: number;
  addedAt: string;
  addedLate: boolean;
  collectedCentavos: number;
  paidElsewhereCentavos: number;
}

export interface BatchCollectionDto {
  paymentId: string;
  receiptNumber: string;
  status: string; // posted | reversed
  subscriberId: string;
  accountNumber: string;
  fullName: string;
  method: string; // cash | cheque
  amountCentavos: number;
  paymentDate: string;
  referenceNumber: string | null;
  postedAt: string;
  receivedByName: string;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface BatchRemittanceDto {
  id: string;
  amountCentavos: number;
  notes: string | null;
  received: BatchStepDto;
  voided: (BatchStepDto & { reason: string }) | null;
}

export interface BatchMoneyDto {
  expectedTotalDueCentavos: number;
  cashCollectedCentavos: number;
  chequeCollectedCentavos: number;
  paidElsewhereCentavos: number;
  nonCashCentavos: number;
  uncollectedCentavos: number;
  remittedCentavos: number;
  collectionCount: number;
}

export interface BatchDetailDto {
  id: string;
  batchNumber: string;
  status: string;
  collectionDate: string;
  notes: string | null;
  collector: { id: string; code: string; fullName: string };
  area: { id: string; code: string; name: string } | null;
  created: BatchStepDto;
  dispatched: BatchStepDto | null;
  submitted: BatchStepDto | null;
  reconciled: BatchStepDto | null;
  closed: BatchStepDto | null;
  cancelled: (BatchStepDto & { reason: string }) | null;
  accounts: BatchAccountDto[];
  totals: { accountCount: number; currentCentavos: number; arrearsCentavos: number; totalDueCentavos: number };
  collections: BatchCollectionDto[];
  remittances: BatchRemittanceDto[];
  money: BatchMoneyDto;
  reconciliation: {
    expectedCashCentavos: number;
    remittedCashCentavos: number;
    differenceCentavos: number;
    varianceKind: string; // balanced | shortage | overage
    varianceReason: string | null;
  } | null;
  reversedAfterReconciliation: BatchCollectionDto[];
}

export interface CreateBatchResultDto {
  batch: BatchDetailDto;
  /** Owing subscribers left out because they are already on another open or in-progress batch. */
  skipped: { subscriberId: string; accountNumber: string; fullName: string; batchNumber: string }[];
}

export interface CollectorReportBatchDto {
  id: string;
  batchNumber: string;
  collectionDate: string;
  status: string;
  accountCount: number;
  expectedTotalDueCentavos: number;
  cashCollectedCentavos: number;
  chequeCollectedCentavos: number;
  remittedCentavos: number;
  /** Frozen at reconciliation; null before. */
  differenceCentavos: number | null;
  varianceKind: string | null;
}

export interface CollectorReportTotalsDto {
  batchCount: number;
  unreconciledCount: number;
  accountCount: number;
  expectedTotalDueCentavos: number;
  cashCollectedCentavos: number;
  chequeCollectedCentavos: number;
  remittedCentavos: number;
  shortageCentavos: number;
  overageCentavos: number;
  /** Basis points (8530 = 85.30%); null when nothing was due. */
  collectionRateBasisPoints: number | null;
}

export interface CollectorReportRowDto extends CollectorReportTotalsDto {
  collectorId: string;
  code: string;
  fullName: string;
  isActive: boolean;
  batches: CollectorReportBatchDto[];
}

export interface CollectorReportDto {
  from: string;
  to: string;
  collectors: CollectorReportRowDto[];
  totals: CollectorReportTotalsDto;
}

/* ------------------------------ Receivables ------------------------------ */

export interface ReceivableListQuery {
  view?: "outstanding" | "overdue";
  collectorId?: string;
  areaId?: string;
  planId?: string;
  serviceType?: string;
  bucket?: string;
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

/** One service account with an open balance, as of the server's today. */
export interface ReceivableRowDto {
  serviceAccountId: string;
  serviceNumber: string;
  serviceStatus: string;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  planId: string;
  planCode: string;
  planName: string;
  serviceType: string;
  areaId: string | null;
  areaName: string | null;
  collectorId: string | null;
  collectorCode: string | null;
  collectorName: string | null;
  openInvoiceCount: number;
  monthsUnpaid: number;
  oldestInvoiceId: string;
  oldestInvoiceNumber: string;
  oldestDueDate: string;
  daysPastDue: number;
  bucket: string;
  lastPaymentDate: string | null;
  currentCentavos: number;
  arrearsCentavos: number;
  totalOpenCentavos: number;
}

export interface ReceivablePageDto {
  asOf: string;
  items: ReceivableRowDto[];
  total: number;
  totalOpenCentavos: number;
  totalArrearsCentavos: number;
  page: number;
  pageSize: number;
}

export type ExportFormat = "pdf" | "xlsx";

/** A report saved through the native Save dialog; the full path stays in the main process. */
export interface SavedExportDto {
  fileName: string;
  format: ExportFormat;
}

export interface AgingQuery {
  collectorId?: string;
  areaId?: string;
  planId?: string;
  serviceType?: string;
}

export interface AgingBucketDto {
  bucket: string;
  amountCentavos: number;
  invoiceCount: number;
  accountCount: number;
}

export interface AgingReportDto {
  asOf: string;
  buckets: AgingBucketDto[];
  totalOpenCentavos: number;
  overdueCentavos: number;
  overdueAccountCount: number;
  overdueSubscriberCount: number;
  unappliedCreditCentavos: number;
  netReceivableCentavos: number;
}

export interface ReceivableFilterOptionsDto {
  collectors: Array<{ id: string; code: string; fullName: string; isActive: boolean }>;
  areas: Array<{ id: string; code: string; name: string; isActive: boolean }>;
  plans: Array<{ id: string; code: string; name: string; serviceType: string; isActive: boolean }>;
}

/* --------------------------- Service control --------------------------- */

export interface SuspensionCandidateQuery {
  collectorId?: string;
  areaId?: string;
  planId?: string;
  serviceType?: string;
  search?: string;
}

export interface SuspensionCandidateDto extends ReceivableRowDto {
  pastGraceCount: number;
  pastGraceCentavos: number;
}

export interface SuspensionCandidateListDto {
  asOf: string;
  settings: { gracePeriodDays: number; suspensionThresholdInvoices: number };
  items: SuspensionCandidateDto[];
}

export interface SuspensionRecordDto {
  id: string;
  effectiveDate: string;
  reason: string;
  approvedBy: string;
  notes: string | null;
  pastDueInvoiceCount: number;
  pastDueCentavos: number;
  suspendedByName: string;
  createdAt: string;
}

export interface ReconnectionDto {
  id: string;
  serviceAccountId: string;
  serviceNumber: string;
  subscriberId: string;
  accountNumber: string;
  subscriberName: string;
  suspensionRecordId: string;
  status: string; // requested | assigned | completed | cancelled
  requestDate: string;
  requestedByName: string;
  requestedAt: string;
  feeCentavos: number;
  feeWaived: boolean;
  feeWaiverReason: string | null;
  notes: string | null;
  technicianUserId: string | null;
  technicianName: string | null;
  assignedAt: string | null;
  completionDate: string | null;
  completedByName: string | null;
  completedAt: string | null;
  cancelReason: string | null;
  cancelledByName: string | null;
  cancelledAt: string | null;
}

export interface ServiceControlHistoryDto {
  suspensions: SuspensionRecordDto[];
  reconnections: ReconnectionDto[];
}

export interface ReconnectionListQuery {
  status?: string; // requested | assigned | completed | cancelled | open
  page?: number;
  pageSize?: number;
}

export interface ReconnectionPageDto {
  items: ReconnectionDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TechnicianDto {
  id: string;
  fullName: string;
  username: string;
}

/* ------------------------------- Settings ------------------------------- */

export interface ReceivableSettingsDto {
  gracePeriodDays: number;
  suspensionThresholdInvoices: number;
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
  search: {
    global: (q: string): Promise<ApiResult<GlobalSearchResultDto>> => ipcRenderer.invoke("search:global", q),
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
  billing: {
    summary: (period: string): Promise<ApiResult<BillingSummaryDto>> => ipcRenderer.invoke("billing:summary", period),
    generate: (period: string): Promise<ApiResult<BillingSummaryDto>> => ipcRenderer.invoke("billing:generate", period),
    discardDrafts: (period: string): Promise<ApiResult<BillingSummaryDto>> =>
      ipcRenderer.invoke("billing:discardDrafts", period),
    finalize: (period: string): Promise<ApiResult<FinalizeResultDto>> => ipcRenderer.invoke("billing:finalize", period),
    listInvoices: (query: InvoiceListQuery): Promise<ApiResult<InvoicePageDto>> =>
      ipcRenderer.invoke("billing:listInvoices", query),
    getInvoice: (id: string): Promise<ApiResult<InvoiceDetailDto>> => ipcRenderer.invoke("billing:getInvoice", id),
    voidInvoice: (id: string, reason: string): Promise<ApiResult<InvoiceDetailDto>> =>
      ipcRenderer.invoke("billing:voidInvoice", id, reason),
    adjustInvoice: (id: string, input: Record<string, unknown>): Promise<ApiResult<InvoiceDetailDto>> =>
      ipcRenderer.invoke("billing:adjustInvoice", id, input),
    ledger: (subscriberId: string, range: LedgerRange): Promise<ApiResult<SubscriberLedgerDto>> =>
      ipcRenderer.invoke("billing:ledger", subscriberId, range),
  },
  payments: {
    context: (subscriberId: string): Promise<ApiResult<PaymentContextDto>> =>
      ipcRenderer.invoke("payments:context", subscriberId),
    post: (input: Record<string, unknown>): Promise<ApiResult<PaymentDetailDto>> =>
      ipcRenderer.invoke("payments:post", input),
    get: (id: string): Promise<ApiResult<PaymentDetailDto>> => ipcRenderer.invoke("payments:get", id),
    list: (query: PaymentListQuery): Promise<ApiResult<PaymentPageDto>> => ipcRenderer.invoke("payments:list", query),
    reverse: (id: string, reason: string): Promise<ApiResult<PaymentDetailDto>> =>
      ipcRenderer.invoke("payments:reverse", id, reason),
  },
  gcash: {
    list: (query: GcashSubmissionListQuery): Promise<ApiResult<GcashSubmissionPageDto>> =>
      ipcRenderer.invoke("gcash:list", query),
    get: (id: string): Promise<ApiResult<GcashSubmissionDto>> => ipcRenderer.invoke("gcash:get", id),
    create: (input: Record<string, unknown>): Promise<ApiResult<GcashSubmissionDto>> =>
      ipcRenderer.invoke("gcash:create", input),
    /** Opens a file dialog in the main process and uploads the chosen image. */
    attachProof: (id: string): Promise<ApiResult<GcashSubmissionDto>> => ipcRenderer.invoke("gcash:attachProof", id),
    /** The proof image as a data: URL for an <img>. */
    proofImage: (proofId: string): Promise<ApiResult<string>> => ipcRenderer.invoke("gcash:proofImage", proofId),
    verify: (id: string): Promise<ApiResult<GcashSubmissionDto>> => ipcRenderer.invoke("gcash:verify", id),
    reject: (id: string, reason: string): Promise<ApiResult<GcashSubmissionDto>> =>
      ipcRenderer.invoke("gcash:reject", id, reason),
  },
  batches: {
    list: (query: BatchListQuery): Promise<ApiResult<BatchPageDto>> => ipcRenderer.invoke("batches:list", query),
    get: (id: string): Promise<ApiResult<BatchDetailDto>> => ipcRenderer.invoke("batches:get", id),
    create: (input: Record<string, unknown>): Promise<ApiResult<CreateBatchResultDto>> =>
      ipcRenderer.invoke("batches:create", input),
    addAccount: (id: string, subscriberId: string): Promise<ApiResult<BatchDetailDto>> =>
      ipcRenderer.invoke("batches:addAccount", id, subscriberId),
    removeAccount: (id: string, subscriberId: string): Promise<ApiResult<BatchDetailDto>> =>
      ipcRenderer.invoke("batches:removeAccount", id, subscriberId),
    dispatch: (id: string): Promise<ApiResult<BatchDetailDto>> => ipcRenderer.invoke("batches:dispatch", id),
    submit: (id: string): Promise<ApiResult<BatchDetailDto>> => ipcRenderer.invoke("batches:submit", id),
    cancel: (id: string, reason: string): Promise<ApiResult<BatchDetailDto>> =>
      ipcRenderer.invoke("batches:cancel", id, reason),
    /** A field collection from the collector's tally; posts a real payment and returns its receipt. */
    recordCollection: (id: string, input: Record<string, unknown>): Promise<ApiResult<PaymentDetailDto>> =>
      ipcRenderer.invoke("batches:recordCollection", id, input),
    recordRemittance: (id: string, input: Record<string, unknown>): Promise<ApiResult<BatchDetailDto>> =>
      ipcRenderer.invoke("batches:recordRemittance", id, input),
    voidRemittance: (id: string, remittanceId: string, reason: string): Promise<ApiResult<BatchDetailDto>> =>
      ipcRenderer.invoke("batches:voidRemittance", id, remittanceId, reason),
    /** `differenceCentavos` is the difference the user was shown; the server refuses if it changed. */
    reconcile: (id: string, input: Record<string, unknown>): Promise<ApiResult<BatchDetailDto>> =>
      ipcRenderer.invoke("batches:reconcile", id, input),
    /** Confirms the recorded difference again (AT-08: never closed silently as balanced). */
    close: (id: string, differenceCentavos: number): Promise<ApiResult<BatchDetailDto>> =>
      ipcRenderer.invoke("batches:close", id, differenceCentavos),
    /** Per collector, batches with a collection date from `from` to `to` (inclusive). */
    collectorReport: (from: string, to: string): Promise<ApiResult<CollectorReportDto>> =>
      ipcRenderer.invoke("batches:collectorReport", from, to),
  },
  receivables: {
    list: (query: ReceivableListQuery): Promise<ApiResult<ReceivablePageDto>> =>
      ipcRenderer.invoke("receivables:list", query),
    aging: (query: AgingQuery): Promise<ApiResult<AgingReportDto>> => ipcRenderer.invoke("receivables:aging", query),
    /** Opens the Save dialog, then downloads the export; CANCELLED if the dialog is closed. */
    exportAging: (query: AgingQuery, format: ExportFormat): Promise<ApiResult<SavedExportDto>> =>
      ipcRenderer.invoke("receivables:exportAging", query, format),
    filterOptions: (): Promise<ApiResult<ReceivableFilterOptionsDto>> => ipcRenderer.invoke("receivables:filterOptions"),
  },
  serviceControl: {
    candidates: (query: SuspensionCandidateQuery): Promise<ApiResult<SuspensionCandidateListDto>> =>
      ipcRenderer.invoke("serviceControl:candidates", query),
    suspend: (serviceAccountId: string, input: Record<string, unknown>): Promise<ApiResult<ServiceAccountDetailDto>> =>
      ipcRenderer.invoke("serviceControl:suspend", serviceAccountId, input),
    history: (serviceAccountId: string): Promise<ApiResult<ServiceControlHistoryDto>> =>
      ipcRenderer.invoke("serviceControl:history", serviceAccountId),
    requestReconnection: (serviceAccountId: string, input: Record<string, unknown>): Promise<ApiResult<ReconnectionDto>> =>
      ipcRenderer.invoke("serviceControl:requestReconnection", serviceAccountId, input),
    listReconnections: (query: ReconnectionListQuery): Promise<ApiResult<ReconnectionPageDto>> =>
      ipcRenderer.invoke("serviceControl:listReconnections", query),
    assign: (reconnectionId: string, technicianUserId: string): Promise<ApiResult<ReconnectionDto>> =>
      ipcRenderer.invoke("serviceControl:assign", reconnectionId, technicianUserId),
    complete: (reconnectionId: string, input: Record<string, unknown>): Promise<ApiResult<ReconnectionDto>> =>
      ipcRenderer.invoke("serviceControl:complete", reconnectionId, input),
    cancel: (reconnectionId: string, reason: string): Promise<ApiResult<ReconnectionDto>> =>
      ipcRenderer.invoke("serviceControl:cancel", reconnectionId, reason),
    technicians: (): Promise<ApiResult<TechnicianDto[]>> => ipcRenderer.invoke("serviceControl:technicians"),
  },
  exports: {
    /** Opens the last saved export in its default program (e.g. to print a PDF). */
    openLast: (): Promise<ApiResult<null>> => ipcRenderer.invoke("exports:openLast"),
  },
  settings: {
    receivables: (): Promise<ApiResult<ReceivableSettingsDto>> => ipcRenderer.invoke("settings:receivables"),
    /** Send only changed fields (plus an optional reason); a no-op is not audited. */
    updateReceivables: (input: Record<string, unknown>): Promise<ApiResult<ReceivableSettingsDto>> =>
      ipcRenderer.invoke("settings:updateReceivables", input),
  },
};

contextBridge.exposeInMainWorld("bcis", bcis);

export type BcisApi = typeof bcis;


