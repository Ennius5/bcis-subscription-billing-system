# Entity-Relationship Diagram

Generated from the migrated database. One diagram per module; tables from other modules appear without columns where they are referenced. Only keys, money, document numbers, statuses and key dates are drawn; every column is in the data dictionary. Most tables also record who created or changed a row (a foreign key to `users`); those links are drawn only in the first diagram, to keep the others readable.

Notation: `||--o{` one to many; `|o--o{` the parent is optional (nullable foreign key).

## Access and audit

Who can sign in, what each role may do, live sessions, and the append-only audit trail.

```mermaid
erDiagram
  m0_users["users"] {
    uuid id PK
  }
  m0_roles["roles"] {
    uuid id PK
    text code
  }
  m0_permissions["permissions"] {
    uuid id PK
    text code
  }
  m0_role_permissions["role_permissions"] {
    uuid role_id PK,FK
    uuid permission_id PK,FK
  }
  m0_user_roles["user_roles"] {
    uuid user_id PK,FK
    uuid role_id PK,FK
  }
  m0_sessions["sessions"] {
    uuid id PK
    uuid user_id FK
  }
  m0_audit_logs["audit_logs"] {
    uuid id PK
    uuid actor_user_id FK
  }
  m0_users |o--o{ m0_audit_logs : "actor_user_id"
  m0_permissions ||--o{ m0_role_permissions : "permission_id"
  m0_roles ||--o{ m0_role_permissions : "role_id"
  m0_users ||--o{ m0_sessions : "user_id"
  m0_roles ||--o{ m0_user_roles : "role_id"
  m0_users ||--o{ m0_user_roles : "user_id"
```

<div class="page-break"></div>

## Subscribers and services

Customers, their addresses and contacts, the plans offered, and each service account with its history.

```mermaid
erDiagram
  m1_subscribers["subscribers"] {
    uuid id PK
    text account_number
    text status
    uuid collection_area_id FK
    uuid assigned_collector_id FK
  }
  m1_subscriber_addresses["subscriber_addresses"] {
    uuid id PK
    uuid subscriber_id FK
  }
  m1_subscriber_contacts["subscriber_contacts"] {
    uuid id PK
    uuid subscriber_id FK
  }
  m1_service_types["service_types"] {
    uuid id PK
    text code
  }
  m1_service_plans["service_plans"] {
    uuid id PK
    text code
    uuid service_type_id FK
    integer price_centavos
    integer installation_fee_centavos
    integer reconnection_fee_centavos
  }
  m1_service_accounts["service_accounts"] {
    uuid id PK
    text service_number
    uuid subscriber_id FK
    uuid plan_id FK
    uuid installation_address_id FK
    text status
    date activation_date
    date billing_start_date
    integer current_rate_centavos
    uuid assigned_collector_id FK
  }
  m1_service_events["service_events"] {
    uuid id PK
    uuid service_account_id FK
    date effective_date
    uuid actor_user_id FK
  }
  m1_collectors["collectors"] {
  }
  m1_collection_areas["collection_areas"] {
  }
  m1_collectors |o--o{ m1_service_accounts : "assigned_collector_id"
  m1_subscriber_addresses ||--o{ m1_service_accounts : "installation_address_id"
  m1_service_plans ||--o{ m1_service_accounts : "plan_id"
  m1_subscriber_addresses ||--o{ m1_service_accounts : "subscriber_id"
  m1_subscribers ||--o{ m1_service_accounts : "subscriber_id"
  m1_service_accounts ||--o{ m1_service_events : "service_account_id"
  m1_service_types ||--o{ m1_service_plans : "service_type_id"
  m1_subscribers ||--o{ m1_subscriber_addresses : "subscriber_id"
  m1_subscribers ||--o{ m1_subscriber_contacts : "subscriber_id"
  m1_collectors |o--o{ m1_subscribers : "assigned_collector_id"
  m1_collection_areas |o--o{ m1_subscribers : "collection_area_id"
```

<div class="page-break"></div>

## Billing and ledger

Monthly billing runs, invoices and their lines, adjustments, and the subscriber ledger that every balance comes from.

```mermaid
erDiagram
  m2_billing_cycles["billing_cycles"] {
    uuid id PK
    date period_start
    uuid created_by_user_id FK
  }
  m2_invoices["invoices"] {
    uuid id PK
    text invoice_number
    uuid billing_cycle_id FK
    uuid subscriber_id FK
    uuid service_account_id FK
    date period_start
    date invoice_date
    date due_date
    text status
    integer total_centavos
    integer paid_centavos
    uuid created_by_user_id FK
    uuid finalized_by_user_id FK
    uuid voided_by_user_id FK
    integer adjusted_centavos
  }
  m2_invoice_items["invoice_items"] {
    uuid id PK
    uuid invoice_id FK
    integer amount_centavos
    uuid plan_id FK
    integer rate_centavos
    uuid reconnection_id FK
  }
  m2_adjustments["adjustments"] {
    uuid id PK
    text adjustment_number
    uuid invoice_id FK
    uuid subscriber_id FK
    text kind
    integer amount_centavos
    uuid created_by_user_id FK
  }
  m2_ledger_entries["ledger_entries"] {
    uuid id PK
    uuid subscriber_id FK
    uuid service_account_id FK
    date entry_date
    integer debit_centavos
    integer credit_centavos
    uuid invoice_id FK
    uuid created_by_user_id FK
    uuid payment_id FK
    uuid adjustment_id FK
  }
  m2_document_sequences["document_sequences"] {
    text name PK
  }
  m2_service_plans["service_plans"] {
  }
  m2_reconnection_records["reconnection_records"] {
  }
  m2_service_accounts["service_accounts"] {
  }
  m2_subscribers["subscribers"] {
  }
  m2_payments["payments"] {
  }
  m2_invoices ||--o{ m2_adjustments : "invoice_id"
  m2_invoices ||--o{ m2_adjustments : "subscriber_id"
  m2_invoices ||--o{ m2_invoice_items : "invoice_id"
  m2_service_plans |o--o{ m2_invoice_items : "plan_id"
  m2_reconnection_records |o--o{ m2_invoice_items : "reconnection_id"
  m2_billing_cycles ||--o{ m2_invoices : "billing_cycle_id"
  m2_service_accounts ||--o{ m2_invoices : "service_account_id"
  m2_service_accounts ||--o{ m2_invoices : "subscriber_id"
  m2_subscribers ||--o{ m2_invoices : "subscriber_id"
  m2_adjustments |o--o{ m2_ledger_entries : "adjustment_id"
  m2_invoices |o--o{ m2_ledger_entries : "invoice_id"
  m2_payments |o--o{ m2_ledger_entries : "payment_id"
  m2_service_accounts |o--o{ m2_ledger_entries : "service_account_id"
  m2_service_accounts ||--o{ m2_ledger_entries : "subscriber_id"
  m2_subscribers ||--o{ m2_ledger_entries : "subscriber_id"
```

<div class="page-break"></div>

## Payments and GCash

Money received, how it was applied to invoices, reversals, and GCash submissions with their proof images.

```mermaid
erDiagram
  m3_payments["payments"] {
    uuid id PK
    text receipt_number
    uuid subscriber_id FK
    integer amount_centavos
    integer allocated_centavos
    date payment_date
    text reference_number
    text status
    uuid gcash_submission_id FK
    uuid received_by_user_id FK
    uuid collection_batch_id FK
    uuid collector_id FK
  }
  m3_payment_allocations["payment_allocations"] {
    uuid id PK
    uuid payment_id FK
    uuid invoice_id FK
    uuid subscriber_id FK
    integer amount_centavos
    uuid allocated_by_user_id FK
  }
  m3_payment_reversals["payment_reversals"] {
    uuid id PK
    uuid payment_id FK
    uuid reversed_by_user_id FK
  }
  m3_gcash_submissions["gcash_submissions"] {
    uuid id PK
    uuid subscriber_id FK
    text reference_number
    text sender_number
    integer amount_centavos
    date transaction_date
    text status
    uuid recorded_by_user_id FK
    uuid reviewed_by_user_id FK
  }
  m3_payment_proofs["payment_proofs"] {
    uuid id PK
    uuid gcash_submission_id FK
    uuid payment_id FK
    uuid uploaded_by_user_id FK
  }
  m3_subscribers["subscribers"] {
  }
  m3_invoices["invoices"] {
  }
  m3_batch_accounts["batch_accounts"] {
  }
  m3_collection_batches["collection_batches"] {
  }
  m3_subscribers ||--o{ m3_gcash_submissions : "subscriber_id"
  m3_invoices ||--o{ m3_payment_allocations : "invoice_id"
  m3_payments ||--o{ m3_payment_allocations : "payment_id"
  m3_invoices ||--o{ m3_payment_allocations : "subscriber_id"
  m3_payments ||--o{ m3_payment_allocations : "subscriber_id"
  m3_gcash_submissions |o--o{ m3_payment_proofs : "gcash_submission_id"
  m3_payments |o--o{ m3_payment_proofs : "payment_id"
  m3_payments ||--o{ m3_payment_reversals : "payment_id"
  m3_batch_accounts |o--o{ m3_payments : "collection_batch_id"
  m3_collection_batches |o--o{ m3_payments : "collection_batch_id"
  m3_collection_batches |o--o{ m3_payments : "collector_id"
  m3_gcash_submissions |o--o{ m3_payments : "gcash_submission_id"
  m3_batch_accounts ||--o{ m3_payments : "subscriber_id"
  m3_subscribers ||--o{ m3_payments : "subscriber_id"
```

<div class="page-break"></div>

## Collections

Collection areas, collectors, their batches (route sheets), field collections and cash remittances.

```mermaid
erDiagram
  m4_collection_areas["collection_areas"] {
    uuid id PK
    text code
  }
  m4_collectors["collectors"] {
    uuid id PK
    text code
    text contact_number
    uuid user_id FK
  }
  m4_collector_assignments["collector_assignments"] {
    uuid id PK
    uuid subscriber_id FK
    uuid collection_area_id FK
    uuid collector_id FK
    uuid assigned_by_user_id FK
  }
  m4_collection_batches["collection_batches"] {
    uuid id PK
    text batch_number
    uuid collector_id FK
    uuid collection_area_id FK
    date collection_date
    text status
    uuid created_by_user_id FK
    uuid dispatched_by_user_id FK
    uuid submitted_by_user_id FK
    integer expected_cash_centavos
    integer remitted_cash_centavos
    integer difference_centavos
    uuid reconciled_by_user_id FK
    uuid closed_by_user_id FK
    uuid cancelled_by_user_id FK
  }
  m4_batch_accounts["batch_accounts"] {
    uuid id PK
    uuid batch_id FK
    uuid subscriber_id FK
    integer current_centavos
    integer arrears_centavos
    integer credit_centavos
    integer total_due_centavos
    uuid added_by_user_id FK
  }
  m4_collector_remittances["collector_remittances"] {
    uuid id PK
    uuid batch_id FK
    uuid collector_id FK
    integer amount_centavos
    uuid received_by_user_id FK
    uuid voided_by_user_id FK
  }
  m4_subscribers["subscribers"] {
  }
  m4_collection_batches ||--o{ m4_batch_accounts : "batch_id"
  m4_subscribers ||--o{ m4_batch_accounts : "subscriber_id"
  m4_collection_areas |o--o{ m4_collection_batches : "collection_area_id"
  m4_collectors ||--o{ m4_collection_batches : "collector_id"
  m4_collection_areas |o--o{ m4_collector_assignments : "collection_area_id"
  m4_collectors |o--o{ m4_collector_assignments : "collector_id"
  m4_subscribers ||--o{ m4_collector_assignments : "subscriber_id"
  m4_collection_batches ||--o{ m4_collector_remittances : "batch_id"
  m4_collection_batches ||--o{ m4_collector_remittances : "collector_id"
```

<div class="page-break"></div>

## Service control

Suspensions for non-payment and the reconnection workflow, including the reconnection fee.

```mermaid
erDiagram
  m5_suspension_records["suspension_records"] {
    uuid id PK
    uuid service_account_id FK
    date effective_date
    integer past_due_centavos
    uuid suspended_by_user_id FK
  }
  m5_reconnection_records["reconnection_records"] {
    uuid id PK
    uuid service_account_id FK
    uuid suspension_record_id FK
    text status
    date request_date
    uuid requested_by_user_id FK
    integer fee_centavos
    uuid technician_user_id FK
    uuid assigned_by_user_id FK
    date completion_date
    uuid completed_by_user_id FK
    uuid cancelled_by_user_id FK
  }
  m5_service_accounts["service_accounts"] {
  }
  m5_service_accounts ||--o{ m5_reconnection_records : "service_account_id"
  m5_suspension_records ||--o{ m5_reconnection_records : "service_account_id"
  m5_suspension_records ||--o{ m5_reconnection_records : "suspension_record_id"
  m5_service_accounts ||--o{ m5_suspension_records : "service_account_id"
```

<div class="page-break"></div>

## Settings, backups and integrity

Business settings, the backup history and the results of integrity checks.

```mermaid
erDiagram
  m6_application_settings["application_settings"] {
    text key PK
  }
  m6_backup_history["backup_history"] {
    uuid id PK
    text backup_number
    text kind
    text status
    uuid created_by_user_id FK
  }
  m6_integrity_checks["integrity_checks"] {
    uuid id PK
    uuid backup_id FK
    uuid run_by_user_id FK
  }
  m6_backup_history |o--o{ m6_integrity_checks : "backup_id"
```
