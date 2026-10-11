# Data Dictionary

Generated from the migrated database: 36 tables in 7 modules. Money is stored as integer centavos (`*_centavos`); dates as `date`, moments as `timestamptz`. Checks and triggers listed here are enforced by PostgreSQL itself, whatever the application does.

## Access and audit

Who can sign in, what each role may do, live sessions, and the append-only audit trail.

### users

Staff accounts. Password stored as an argon2id hash; failed attempts and lockout tracked here. Deactivated, never deleted.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| username | text | no |  |  |
| full_name | text | no |  |  |
| password_hash | text | no |  |  |
| is_active | boolean | no | `true` |  |
| failed_login_attempts | integer | no | `0` |  |
| locked_until | timestamptz | yes |  |  |
| last_login_at | timestamptz | yes |  |  |
| created_at | timestamptz | no | `now()` |  |
| updated_at | timestamptz | no | `now()` |  |
| must_change_password | boolean | no | `false` |  |

- Check `users_username_lowercase`: `CHECK ((username = lower(username)))`
- Unique `users_username_unique`: `UNIQUE (username)`

### roles

The seven roles (owner, administrator, cashier, collection supervisor, auditor, technician, viewer).

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| code | text | no |  |  |
| name | text | no |  |  |
| description | text | no |  |  |

- Unique `roles_code_unique`: `UNIQUE (code)`

### permissions

Permission codes checked by the API on every request.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| code | text | no |  |  |
| description | text | no |  |  |

- Unique `permissions_code_unique`: `UNIQUE (code)`

### role_permissions

Which permissions each role grants.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| role_id | uuid | no |  | PK, FK → roles.id |
| permission_id | uuid | no |  | PK, FK → permissions.id |

- Unique index `role_permissions_role_id_permission_id_pk`: `(role_id, permission_id)`

### user_roles

Which roles each user holds.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| user_id | uuid | no |  | PK, FK → users.id |
| role_id | uuid | no |  | PK, FK → roles.id |

- Unique index `user_roles_user_id_role_id_pk`: `(user_id, role_id)`

### sessions

Signed-in sessions. Only a SHA-256 hash of the session token is stored.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| user_id | uuid | no |  | FK → users.id |
| token_hash | text | no |  |  |
| created_at | timestamptz | no | `now()` |  |
| last_activity_at | timestamptz | no | `now()` |  |
| expires_at | timestamptz | no |  |  |
| revoked_at | timestamptz | yes |  |  |

- Unique `sessions_token_hash_unique`: `UNIQUE (token_hash)`
- Index `sessions_user_idx`: `(user_id)`

### audit_logs

Every change: actor, action, record, reason, old and new values. Append-only (database trigger).

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| occurred_at | timestamptz | no | `now()` |  |
| actor_user_id | uuid | yes |  | FK → users.id |
| action | text | no |  |  |
| entity_type | text | no |  |  |
| entity_id | text | yes |  |  |
| reason | text | yes |  |  |
| old_values | jsonb | yes |  |  |
| new_values | jsonb | yes |  |  |

- Index `audit_logs_action_idx`: `(action)`
- Index `audit_logs_actor_idx`: `(actor_user_id)`
- Index `audit_logs_entity_idx`: `(entity_type, entity_id)`
- Index `audit_logs_occurred_idx`: `(occurred_at)`
- Trigger `audit_logs_no_update_delete` (BEFORE): `audit_logs_block_modification()`

## Subscribers and services

Customers, their addresses and contacts, the plans offered, and each service account with its history.

### subscribers

Customer accounts (BCIS- numbers). Status active, inactive, terminated or archived; never deleted.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| account_number | text | no | `('BCIS-'::text \|\| lpad((nextval('subscriber_account_seq'::` |  |
| full_name | text | no |  |  |
| status | text | no | `'active'::text` |  |
| billing_day | integer | no |  |  |
| collection_area_id | uuid | yes |  | FK → collection_areas.id |
| assigned_collector_id | uuid | yes |  | FK → collectors.id |
| notes | text | yes |  |  |
| created_at | timestamptz | no | `now()` |  |
| updated_at | timestamptz | no | `now()` |  |

- Unique `subscribers_account_number_unique`: `UNIQUE (account_number)`
- Check `subscribers_billing_day_valid`: `CHECK (((billing_day >= 1) AND (billing_day <= 28)))`
- Check `subscribers_status_valid`: `CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'terminated'::text, 'archived'::text])))`
- Index `subscribers_account_number_trgm_idx`: `(account_number gin_trgm_ops)`
- Index `subscribers_area_idx`: `(collection_area_id)`
- Index `subscribers_collector_idx`: `(assigned_collector_id)`
- Index `subscribers_full_name_idx`: `(full_name)`
- Index `subscribers_full_name_trgm_idx`: `(full_name gin_trgm_ops)`
- Index `subscribers_status_idx`: `(status)`

### subscriber_addresses

Addresses of a subscriber; at most one is primary. Deactivated, never deleted.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| subscriber_id | uuid | no |  | FK → subscribers.id |
| label | text | yes |  |  |
| line1 | text | no |  |  |
| barangay | text | no |  |  |
| city | text | no |  |  |
| province | text | yes |  |  |
| landmark | text | yes |  |  |
| is_primary | boolean | no | `false` |  |
| is_active | boolean | no | `true` |  |
| created_at | timestamptz | no | `now()` |  |
| updated_at | timestamptz | no | `now()` |  |

- Unique index `subscriber_addresses_id_subscriber_idx`: `(id, subscriber_id)`
- Unique index `subscriber_addresses_one_primary_idx`: `(subscriber_id) WHERE is_primary`
- Index `subscriber_addresses_search_trgm_idx`: `((((((((((line1 || ' '::text) || barangay) || ' '::text) || city) || ' '::text) || COALESCE(province, ''::text)) || ' '::text) || COALESCE(landmark, ''::text))) gin_trgm_ops)`
- Index `subscriber_addresses_subscriber_idx`: `(subscriber_id)`

### subscriber_contacts

Phone numbers and emails; at most one is primary. Searchable by digits (trigram index).

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| subscriber_id | uuid | no |  | FK → subscribers.id |
| type | text | no |  |  |
| value | text | no |  |  |
| contact_name | text | yes |  |  |
| is_primary | boolean | no | `false` |  |
| is_active | boolean | no | `true` |  |
| created_at | timestamptz | no | `now()` |  |
| updated_at | timestamptz | no | `now()` |  |

- Check `subscriber_contacts_type_valid`: `CHECK ((type = ANY (ARRAY['mobile'::text, 'landline'::text, 'email'::text, 'other'::text])))`
- Index `subscriber_contacts_digits_trgm_idx`: `(regexp_replace(value, '\D'::text, ''::text, 'g'::text) gin_trgm_ops)`
- Unique index `subscriber_contacts_one_primary_idx`: `(subscriber_id) WHERE is_primary`
- Index `subscriber_contacts_subscriber_idx`: `(subscriber_id)`
- Index `subscriber_contacts_value_idx`: `(value)`
- Index `subscriber_contacts_value_trgm_idx`: `(value gin_trgm_ops)`

### service_types

Internet, cable, combo.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| code | text | no |  |  |
| name | text | no |  |  |

- Unique `service_types_code_unique`: `UNIQUE (code)`

### service_plans

Plans with price, speed or channel count and installation fee. Deactivated, never deleted.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| code | text | no |  |  |
| name | text | no |  |  |
| service_type_id | uuid | no |  | FK → service_types.id |
| price_centavos | integer | no |  |  |
| installation_fee_centavos | integer | no | `0` |  |
| reconnection_fee_centavos | integer | no | `0` |  |
| description | text | yes |  |  |
| speed_mbps | integer | yes |  |  |
| channel_count | integer | yes |  |  |
| is_active | boolean | no | `true` |  |
| created_at | timestamptz | no | `now()` |  |
| updated_at | timestamptz | no | `now()` |  |

- Check `service_plans_attributes_positive`: `CHECK ((((speed_mbps IS NULL) OR (speed_mbps > 0)) AND ((channel_count IS NULL) OR (channel_count > 0))))`
- Unique `service_plans_code_unique`: `UNIQUE (code)`
- Check `service_plans_fees_nonneg`: `CHECK (((installation_fee_centavos >= 0) AND (reconnection_fee_centavos >= 0)))`
- Check `service_plans_price_nonneg`: `CHECK ((price_centavos >= 0))`
- Index `service_plans_active_idx`: `(is_active)`
- Index `service_plans_type_idx`: `(service_type_id)`

### service_accounts

One connection (SVC- number): plan, installation address, current rate, status and billing start.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| service_number | text | no | `('SVC-'::text \|\| lpad((nextval('service_account_seq'::regc` |  |
| subscriber_id | uuid | no |  | FK → subscriber_addresses.subscriber_id |
| plan_id | uuid | no |  | FK → service_plans.id |
| installation_address_id | uuid | no |  | FK → subscriber_addresses.id |
| status | text | no | `'pending'::text` |  |
| activation_date | date | yes |  |  |
| billing_start_date | date | yes |  |  |
| billing_day | integer | no |  |  |
| current_rate_centavos | integer | no |  |  |
| assigned_collector_id | uuid | yes |  | FK → collectors.id |
| notes | text | yes |  |  |
| created_at | timestamptz | no | `now()` |  |
| updated_at | timestamptz | no | `now()` |  |

- Check `service_accounts_activated_valid`: `CHECK (((status = ANY (ARRAY['pending'::text, 'terminated'::text])) OR (activation_date IS NOT NULL)))`
- Check `service_accounts_billing_day_valid`: `CHECK (((billing_day >= 1) AND (billing_day <= 28)))`
- Check `service_accounts_dates_valid`: `CHECK ((((activation_date IS NULL) = (billing_start_date IS NULL)) AND ((billing_start_date IS NULL) OR (billing_start_date >= activation_date))))`
- Check `service_accounts_rate_nonneg`: `CHECK ((current_rate_centavos >= 0))`
- Unique `service_accounts_service_number_unique`: `UNIQUE (service_number)`
- Check `service_accounts_status_valid`: `CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text, 'terminated'::text])))`
- Index `service_accounts_collector_idx`: `(assigned_collector_id)`
- Unique index `service_accounts_id_subscriber_idx`: `(id, subscriber_id)`
- Index `service_accounts_plan_idx`: `(plan_id)`
- Index `service_accounts_service_number_trgm_idx`: `(service_number gin_trgm_ops)`
- Index `service_accounts_status_idx`: `(status)`
- Index `service_accounts_subscriber_idx`: `(subscriber_id)`

### service_events

History of each service: activation, plan and rate changes, suspensions, reconnections. Append-only.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| service_account_id | uuid | no |  | FK → service_accounts.id |
| event_type | text | no |  |  |
| from_status | text | yes |  |  |
| to_status | text | yes |  |  |
| old_values | jsonb | yes |  |  |
| new_values | jsonb | yes |  |  |
| effective_date | date | no | `CURRENT_DATE` |  |
| reason | text | yes |  |  |
| actor_user_id | uuid | no |  | FK → users.id |
| occurred_at | timestamptz | no | `now()` |  |

- Check `service_events_type_valid`: `CHECK ((event_type = ANY (ARRAY['created'::text, 'status_change'::text, 'rate_change'::text, 'plan_change'::text, 'collector_change'::text, 'update'::text, 'reconnection_request'::text, 'reconnection_assign'::text, 'reconnection_cancel'::text])))`
- Index `service_events_account_idx`: `(service_account_id, occurred_at)`
- Trigger `service_events_no_update_delete` (BEFORE): `service_events_block_modification()`

## Billing and ledger

Monthly billing runs, invoices and their lines, adjustments, and the subscriber ledger that every balance comes from.

### billing_cycles

One row per billed month; locked while a run generates or finalizes.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| period_start | date | no |  |  |
| period_end | date | no |  |  |
| created_by_user_id | uuid | no |  | FK → users.id |
| created_at | timestamptz | no | `now()` |  |

- Check `billing_cycles_first_of_month`: `CHECK ((EXTRACT(day FROM period_start) = (1)::numeric))`
- Unique `billing_cycles_period_start_unique`: `UNIQUE (period_start)`
- Check `billing_cycles_whole_month`: `CHECK ((period_end = (((period_start + '1 mon'::interval) - '1 day'::interval))::date))`

### invoices

One per service account per month (INV- numbers). Draft until finalized; paid and adjusted amounts kept on the row; voided, never deleted.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| invoice_number | text | yes |  |  |
| billing_cycle_id | uuid | no |  | FK → billing_cycles.id |
| subscriber_id | uuid | no |  | FK → service_accounts.subscriber_id |
| service_account_id | uuid | no |  | FK → service_accounts.id |
| period_start | date | no |  |  |
| period_end | date | no |  |  |
| invoice_date | date | no |  |  |
| due_date | date | no |  |  |
| status | text | no | `'draft'::text` |  |
| total_centavos | integer | no |  |  |
| paid_centavos | integer | no | `0` |  |
| created_by_user_id | uuid | no |  | FK → users.id |
| created_at | timestamptz | no | `now()` |  |
| finalized_by_user_id | uuid | yes |  | FK → users.id |
| finalized_at | timestamptz | yes |  |  |
| voided_by_user_id | uuid | yes |  | FK → users.id |
| voided_at | timestamptz | yes |  |  |
| void_reason | text | yes |  |  |
| adjusted_centavos | integer | no | `0` |  |

- Check `invoices_draft_shape`: `CHECK ((((status = 'draft'::text) = (invoice_number IS NULL)) AND ((status = 'draft'::text) = (finalized_at IS NULL))))`
- Check `invoices_draft_unpaid`: `CHECK (((status <> 'draft'::text) OR ((paid_centavos = 0) AND (adjusted_centavos = 0))))`
- Check `invoices_due_after_issue`: `CHECK ((due_date >= invoice_date))`
- Check `invoices_effective_total_nonneg`: `CHECK (((total_centavos + adjusted_centavos) >= 0))`
- Unique `invoices_invoice_number_unique`: `UNIQUE (invoice_number)`
- Check `invoices_paid_range`: `CHECK (((paid_centavos >= 0) AND (paid_centavos <= (total_centavos + adjusted_centavos))))`
- Check `invoices_paid_status_consistent`: `CHECK (((status <> ALL (ARRAY['unpaid'::text, 'partially_paid'::text, 'paid'::text, 'credited'::text])) OR (status =
CASE
    WHEN (((total_centavos + adjusted_centavos) = 0) AND (adjusted_centavos < 0)) THEN 'credited'::text
    WHEN (paid_centavos = (total_centavos + adjusted_centavos)) THEN 'paid'::text
    WHEN (paid_centavos = 0) THEN 'unpaid'::text
    ELSE 'partially_paid'::text
END)))`
- Check `invoices_period_valid`: `CHECK ((period_end >= period_start))`
- Check `invoices_status_valid`: `CHECK ((status = ANY (ARRAY['draft'::text, 'unpaid'::text, 'partially_paid'::text, 'paid'::text, 'void'::text, 'credited'::text])))`
- Check `invoices_total_nonneg`: `CHECK ((total_centavos >= 0))`
- Check `invoices_void_shape`: `CHECK ((((status = 'void'::text) = (voided_at IS NOT NULL)) AND ((status <> 'void'::text) OR (void_reason IS NOT NULL))))`
- Index `invoices_cycle_idx`: `(billing_cycle_id)`
- Index `invoices_due_date_idx`: `(due_date)`
- Unique index `invoices_id_subscriber_idx`: `(id, subscriber_id)`
- Index `invoices_invoice_number_trgm_idx`: `(invoice_number gin_trgm_ops)`
- Unique index `invoices_one_per_period_idx`: `(service_account_id, period_start) WHERE (status <> 'void'::text)`
- Index `invoices_status_idx`: `(status)`
- Index `invoices_subscriber_idx`: `(subscriber_id, period_start)`
- Trigger `invoices_protect_finalized` (BEFORE): `invoices_protect_finalized()`

### invoice_items

Invoice lines: subscription, installation fee, reconnection fee.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| invoice_id | uuid | no |  | FK → invoices.id |
| line_no | integer | no |  |  |
| item_type | text | no |  |  |
| description | text | no |  |  |
| amount_centavos | integer | no |  |  |
| plan_id | uuid | yes |  | FK → service_plans.id |
| rate_centavos | integer | yes |  |  |
| reconnection_id | uuid | yes |  | FK → reconnection_records.id |

- Check `invoice_items_line_positive`: `CHECK ((line_no >= 1))`
- Check `invoice_items_reconnection_fee_only`: `CHECK (((reconnection_id IS NULL) OR (item_type = 'reconnection_fee'::text)))`
- Check `invoice_items_type_valid`: `CHECK ((item_type = ANY (ARRAY['subscription'::text, 'installation_fee'::text, 'reconnection_fee'::text, 'discount'::text, 'penalty'::text, 'adjustment'::text])))`
- Unique index `invoice_items_line_idx`: `(invoice_id, line_no)`
- Index `invoice_items_reconnection_idx`: `(reconnection_id)`
- Trigger `invoice_items_protect_finalized` (BEFORE): `invoice_items_protect_finalized()`

### adjustments

Credits and debits on an invoice (ADJ- numbers) with category and reason. Posted, never edited.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| adjustment_number | text | no |  |  |
| invoice_id | uuid | no |  | FK → invoices.id |
| subscriber_id | uuid | no |  | FK → invoices.subscriber_id |
| kind | text | no |  |  |
| category | text | no |  |  |
| amount_centavos | integer | no |  |  |
| reason | text | no |  |  |
| created_by_user_id | uuid | no |  | FK → users.id |
| created_at | timestamptz | no | `now()` |  |

- Unique `adjustments_adjustment_number_unique`: `UNIQUE (adjustment_number)`
- Check `adjustments_amount_positive`: `CHECK ((amount_centavos > 0))`
- Check `adjustments_category_valid`: `CHECK ((((kind = 'credit'::text) AND (category = ANY (ARRAY['discount'::text, 'service_outage'::text, 'billing_error'::text, 'goodwill'::text, 'other'::text]))) OR ((kind = 'debit'::text) AND (category = ANY (ARRAY['penalty'::text, 'reconnection_fee'::text, 'billing_error'::text, 'other'::text])))))`
- Check `adjustments_reason_present`: `CHECK ((length(TRIM(BOTH FROM reason)) >= 3))`
- Index `adjustments_invoice_idx`: `(invoice_id)`
- Index `adjustments_subscriber_idx`: `(subscriber_id, created_at)`
- Trigger `adjustments_no_update_delete` (BEFORE): `block_modification()`

### ledger_entries

Every debit and credit of a subscriber: invoices, payments, reversals, adjustments, voids. Append-only; the balance is their sum.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| seq | bigint | no |  |  |
| subscriber_id | uuid | no |  | FK → service_accounts.subscriber_id |
| service_account_id | uuid | yes |  | FK → service_accounts.id |
| entry_date | date | no |  |  |
| entry_type | text | no |  |  |
| reference | text | no |  |  |
| description | text | no |  |  |
| debit_centavos | integer | no | `0` |  |
| credit_centavos | integer | no | `0` |  |
| invoice_id | uuid | yes |  | FK → invoices.id |
| created_by_user_id | uuid | no |  | FK → users.id |
| created_at | timestamptz | no | `now()` |  |
| payment_id | uuid | yes |  | FK → payments.id |
| adjustment_id | uuid | yes |  | FK → adjustments.id |

- Check `ledger_entries_one_side`: `CHECK (((debit_centavos >= 0) AND (credit_centavos >= 0) AND ((debit_centavos = 0) <> (credit_centavos = 0))))`
- Check `ledger_entries_type_valid`: `CHECK ((entry_type = ANY (ARRAY['invoice'::text, 'invoice_void'::text, 'payment'::text, 'payment_reversal'::text, 'adjustment'::text])))`
- Index `ledger_entries_adjustment_idx`: `(adjustment_id)`
- Index `ledger_entries_invoice_idx`: `(invoice_id)`
- Index `ledger_entries_payment_idx`: `(payment_id)`
- Unique index `ledger_entries_seq_idx`: `(seq)`
- Index `ledger_entries_subscriber_idx`: `(subscriber_id, entry_date, seq)`
- Trigger `ledger_entries_no_update_delete` (BEFORE): `ledger_entries_block_modification()`

### document_sequences

Counters for invoice, receipt, adjustment, batch and backup numbers, taken under a row lock so numbers never repeat or skip.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| name | text | no |  | PK |
| prefix | text | no |  |  |
| next_value | bigint | no | `1` |  |

- Check `document_sequences_next_positive`: `CHECK ((next_value >= 1))`

## Payments and GCash

Money received, how it was applied to invoices, reversals, and GCash submissions with their proof images.

### payments

Every payment (RCPT- numbers): method, amount, allocated amount, status posted or reversed.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| receipt_number | text | no |  |  |
| subscriber_id | uuid | no |  | FK → batch_accounts.subscriber_id |
| method | text | no |  |  |
| amount_centavos | integer | no |  |  |
| allocated_centavos | integer | no | `0` |  |
| payment_date | date | no |  |  |
| reference_number | text | yes |  |  |
| notes | text | yes |  |  |
| status | text | no | `'posted'::text` |  |
| gcash_submission_id | uuid | yes |  | FK → gcash_submissions.id |
| received_by_user_id | uuid | no |  | FK → users.id |
| posted_at | timestamptz | no | `now()` |  |
| collection_batch_id | uuid | yes |  | FK → batch_accounts.batch_id |
| collector_id | uuid | yes |  | FK → collection_batches.collector_id |

- Check `payments_allocated_range`: `CHECK (((allocated_centavos >= 0) AND (allocated_centavos <= amount_centavos)))`
- Check `payments_amount_positive`: `CHECK ((amount_centavos > 0))`
- Check `payments_field_collection_shape`: `CHECK ((((collection_batch_id IS NULL) = (collector_id IS NULL)) AND ((collection_batch_id IS NULL) OR (method = ANY (ARRAY['cash'::text, 'cheque'::text])))))`
- Check `payments_gcash_shape`: `CHECK ((((method = 'gcash'::text) = (gcash_submission_id IS NOT NULL)) AND ((method <> 'gcash'::text) OR (reference_number IS NOT NULL))))`
- Unique `payments_gcash_submission_id_unique`: `UNIQUE (gcash_submission_id)`
- Check `payments_method_valid`: `CHECK ((method = ANY (ARRAY['cash'::text, 'gcash'::text, 'bank_transfer'::text, 'cheque'::text, 'other'::text])))`
- Unique `payments_receipt_number_unique`: `UNIQUE (receipt_number)`
- Check `payments_status_valid`: `CHECK ((status = ANY (ARRAY['posted'::text, 'reversed'::text])))`
- Index `payments_batch_idx`: `(collection_batch_id)`
- Index `payments_date_idx`: `(payment_date)`
- Unique index `payments_id_subscriber_idx`: `(id, subscriber_id)`
- Index `payments_receipt_number_trgm_idx`: `(receipt_number gin_trgm_ops)`
- Index `payments_reference_idx`: `(reference_number)`
- Index `payments_subscriber_idx`: `(subscriber_id, payment_date)`
- Trigger `payments_field_collection_in_progress` (BEFORE): `payments_field_collection_in_progress()`
- Trigger `payments_protect_posted` (BEFORE): `payments_protect_posted()`

### payment_allocations

How much of a payment went to which invoice, oldest first unless chosen by hand. Append-only.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| payment_id | uuid | no |  | FK → payments.id |
| invoice_id | uuid | no |  | FK → invoices.id |
| subscriber_id | uuid | no |  | FK → invoices.subscriber_id |
| amount_centavos | integer | no |  |  |
| source | text | no |  |  |
| allocated_by_user_id | uuid | no |  | FK → users.id |
| allocated_at | timestamptz | no | `now()` |  |

- Check `payment_allocations_amount_positive`: `CHECK ((amount_centavos > 0))`
- Check `payment_allocations_source_valid`: `CHECK ((source = ANY (ARRAY['auto'::text, 'manual'::text, 'credit'::text])))`
- Index `payment_allocations_invoice_idx`: `(invoice_id)`
- Index `payment_allocations_payment_idx`: `(payment_id)`
- Trigger `payment_allocations_no_update_delete` (BEFORE): `block_modification()`

### payment_reversals

The reversal of a payment, with who and why. The original stays. Append-only.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| payment_id | uuid | no |  | FK → payments.id |
| reason | text | no |  |  |
| reversed_by_user_id | uuid | no |  | FK → users.id |
| reversed_at | timestamptz | no | `now()` |  |

- Unique `payment_reversals_payment_id_unique`: `UNIQUE (payment_id)`
- Trigger `payment_reversals_no_update_delete` (BEFORE): `block_modification()`

### gcash_submissions

GCash payments reported by customers: reference (unique), sender, amount, status pending, verified or rejected.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| subscriber_id | uuid | no |  | FK → subscribers.id |
| reference_number | text | no |  |  |
| sender_name | text | no |  |  |
| sender_number | text | no |  |  |
| amount_centavos | integer | no |  |  |
| transaction_date | date | no |  |  |
| notes | text | yes |  |  |
| status | text | no | `'pending'::text` |  |
| recorded_by_user_id | uuid | no |  | FK → users.id |
| recorded_at | timestamptz | no | `now()` |  |
| reviewed_by_user_id | uuid | yes |  | FK → users.id |
| reviewed_at | timestamptz | yes |  |  |
| rejection_reason | text | yes |  |  |

- Check `gcash_submissions_amount_positive`: `CHECK ((amount_centavos > 0))`
- Check `gcash_submissions_review_shape`: `CHECK ((((status = 'pending'::text) = (reviewed_at IS NULL)) AND ((reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)) AND ((status = 'rejected'::text) = (rejection_reason IS NOT NULL))))`
- Check `gcash_submissions_status_valid`: `CHECK ((status = ANY (ARRAY['pending'::text, 'verified'::text, 'rejected'::text, 'reversed'::text])))`
- Unique index `gcash_submissions_live_reference_idx`: `(reference_number) WHERE (status = ANY (ARRAY['pending'::text, 'verified'::text]))`
- Index `gcash_submissions_reference_trgm_idx`: `(reference_number gin_trgm_ops)`
- Index `gcash_submissions_status_idx`: `(status, recorded_at)`
- Index `gcash_submissions_subscriber_idx`: `(subscriber_id)`
- Trigger `gcash_submissions_protect_reviewed` (BEFORE): `gcash_submissions_protect_reviewed()`

### payment_proofs

Proof images of a GCash submission or a payment: stored name, type, size (5 MB max) and SHA-256. Append-only.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| gcash_submission_id | uuid | yes |  | FK → gcash_submissions.id |
| payment_id | uuid | yes |  | FK → payments.id |
| storage_key | text | no |  |  |
| original_filename | text | yes |  |  |
| mime_type | text | no |  |  |
| size_bytes | integer | no |  |  |
| sha256 | text | no |  |  |
| uploaded_by_user_id | uuid | no |  | FK → users.id |
| uploaded_at | timestamptz | no | `now()` |  |

- Check `payment_proofs_mime_valid`: `CHECK ((mime_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text])))`
- Check `payment_proofs_one_owner`: `CHECK ((num_nonnulls(gcash_submission_id, payment_id) = 1))`
- Check `payment_proofs_sha256_shape`: `CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))`
- Check `payment_proofs_size_valid`: `CHECK (((size_bytes > 0) AND (size_bytes <= 5242880)))`
- Unique `payment_proofs_storage_key_unique`: `UNIQUE (storage_key)`
- Index `payment_proofs_payment_idx`: `(payment_id)`
- Index `payment_proofs_submission_idx`: `(gcash_submission_id)`
- Trigger `payment_proofs_no_update_delete` (BEFORE): `block_modification()`

## Collections

Collection areas, collectors, their batches (route sheets), field collections and cash remittances.

### collection_areas

Areas and routes subscribers belong to.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| code | text | no |  |  |
| name | text | no |  |  |
| description | text | yes |  |  |
| is_active | boolean | no | `true` |  |
| created_at | timestamptz | no | `now()` |  |
| updated_at | timestamptz | no | `now()` |  |

- Unique `collection_areas_code_unique`: `UNIQUE (code)`
- Index `collection_areas_active_idx`: `(is_active)`

### collectors

Field collectors; may be linked to a user account.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| code | text | no |  |  |
| full_name | text | no |  |  |
| contact_number | text | yes |  |  |
| user_id | uuid | yes |  | FK → users.id |
| is_active | boolean | no | `true` |  |
| created_at | timestamptz | no | `now()` |  |
| updated_at | timestamptz | no | `now()` |  |

- Unique `collectors_code_unique`: `UNIQUE (code)`
- Unique `collectors_user_id_unique`: `UNIQUE (user_id)`
- Index `collectors_active_idx`: `(is_active)`

### collector_assignments

Which collector serves a subscriber, with effective dates; at most one open assignment per subscriber.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| subscriber_id | uuid | no |  | FK → subscribers.id |
| collection_area_id | uuid | yes |  | FK → collection_areas.id |
| collector_id | uuid | yes |  | FK → collectors.id |
| effective_from | timestamptz | no | `now()` |  |
| effective_to | timestamptz | yes |  |  |
| assigned_by_user_id | uuid | no |  | FK → users.id |
| reason | text | yes |  |  |

- Check `collector_assignments_period_valid`: `CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)))`
- Index `collector_assignments_area_idx`: `(collection_area_id)`
- Index `collector_assignments_collector_idx`: `(collector_id)`
- Unique index `collector_assignments_one_open_idx`: `(subscriber_id) WHERE (effective_to IS NULL)`
- Index `collector_assignments_subscriber_idx`: `(subscriber_id, effective_from)`

### collection_batches

A collector's outing (CB- numbers): route sheet snapshot, lifecycle from open to closed, reconciliation figures and variance reason.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| batch_number | text | no |  |  |
| collector_id | uuid | no |  | FK → collectors.id |
| collection_area_id | uuid | yes |  | FK → collection_areas.id |
| collection_date | date | no |  |  |
| status | text | no | `'open'::text` |  |
| notes | text | yes |  |  |
| created_by_user_id | uuid | no |  | FK → users.id |
| created_at | timestamptz | no | `now()` |  |
| dispatched_by_user_id | uuid | yes |  | FK → users.id |
| dispatched_at | timestamptz | yes |  |  |
| submitted_by_user_id | uuid | yes |  | FK → users.id |
| submitted_at | timestamptz | yes |  |  |
| expected_cash_centavos | integer | yes |  |  |
| remitted_cash_centavos | integer | yes |  |  |
| difference_centavos | integer | yes |  |  |
| variance_kind | text | yes |  |  |
| variance_reason | text | yes |  |  |
| reconciled_by_user_id | uuid | yes |  | FK → users.id |
| reconciled_at | timestamptz | yes |  |  |
| closed_by_user_id | uuid | yes |  | FK → users.id |
| closed_at | timestamptz | yes |  |  |
| cancelled_by_user_id | uuid | yes |  | FK → users.id |
| cancelled_at | timestamptz | yes |  |  |
| cancel_reason | text | yes |  |  |

- Unique `collection_batches_batch_number_unique`: `UNIQUE (batch_number)`
- Check `collection_batches_cancel_shape`: `CHECK ((((status = 'cancelled'::text) = (cancelled_at IS NOT NULL)) AND (num_nonnulls(cancelled_at, cancelled_by_user_id, cancel_reason) = ANY (ARRAY[0, 3]))))`
- Check `collection_batches_close_shape`: `CHECK ((((status = 'closed'::text) = (closed_at IS NOT NULL)) AND ((closed_at IS NULL) = (closed_by_user_id IS NULL))))`
- Check `collection_batches_dispatch_shape`: `CHECK ((((dispatched_at IS NULL) = (dispatched_by_user_id IS NULL)) AND ((status = ANY (ARRAY['open'::text, 'cancelled'::text])) OR (dispatched_at IS NOT NULL))))`
- Check `collection_batches_reconcile_shape`: `CHECK ((((status = ANY (ARRAY['reconciled'::text, 'closed'::text])) = (reconciled_at IS NOT NULL)) AND (num_nonnulls(reconciled_at, reconciled_by_user_id, expected_cash_centavos, remitted_cash_centavos, difference_centavos, variance_kind) = ANY (ARRAY[0, 6]))))`
- Check `collection_batches_status_valid`: `CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'submitted'::text, 'remitted'::text, 'reconciled'::text, 'closed'::text, 'cancelled'::text])))`
- Check `collection_batches_submit_shape`: `CHECK ((((submitted_at IS NULL) = (submitted_by_user_id IS NULL)) AND ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'cancelled'::text])) = (submitted_at IS NULL))))`
- Check `collection_batches_variance_consistent`: `CHECK (((reconciled_at IS NULL) OR ((expected_cash_centavos >= 0) AND (remitted_cash_centavos >= 0) AND (difference_centavos = (remitted_cash_centavos - expected_cash_centavos)) AND (variance_kind =
CASE
    WHEN (difference_centavos = 0) THEN 'balanced'::text
    WHEN (difference_centavos < 0) THEN 'shortage'::text
    ELSE 'overage'::text
END) AND ((difference_centavos = 0) OR (length(TRIM(BOTH FROM COALESCE(variance_reason, ''::text))) >= 3)))))`
- Index `collection_batches_collector_idx`: `(collector_id, collection_date)`
- Unique index `collection_batches_id_collector_idx`: `(id, collector_id)`
- Index `collection_batches_status_idx`: `(status, collection_date)`
- Trigger `collection_batches_protect` (BEFORE): `collection_batches_protect()`

### batch_accounts

The subscribers on a batch with the balance they owed when it was built.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| batch_id | uuid | no |  | FK → collection_batches.id |
| subscriber_id | uuid | no |  | FK → subscribers.id |
| current_centavos | integer | no |  |  |
| arrears_centavos | integer | no |  |  |
| credit_centavos | integer | no |  |  |
| total_due_centavos | integer | no |  |  |
| added_by_user_id | uuid | no |  | FK → users.id |
| added_at | timestamptz | no | `now()` |  |

- Check `batch_accounts_amounts_valid`: `CHECK (((current_centavos >= 0) AND (arrears_centavos >= 0) AND (credit_centavos >= 0) AND (total_due_centavos = GREATEST(0, ((current_centavos + arrears_centavos) - credit_centavos)))))`
- Unique index `batch_accounts_batch_subscriber_idx`: `(batch_id, subscriber_id)`
- Index `batch_accounts_subscriber_idx`: `(subscriber_id)`
- Trigger `batch_accounts_protect` (BEFORE): `batch_accounts_protect()`

### collector_remittances

Cash handed over by the collector; voided with a reason, never deleted.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| batch_id | uuid | no |  | FK → collection_batches.id |
| collector_id | uuid | no |  | FK → collection_batches.collector_id |
| amount_centavos | integer | no |  |  |
| notes | text | yes |  |  |
| received_by_user_id | uuid | no |  | FK → users.id |
| received_at | timestamptz | no | `now()` |  |
| voided_by_user_id | uuid | yes |  | FK → users.id |
| voided_at | timestamptz | yes |  |  |
| void_reason | text | yes |  |  |

- Check `collector_remittances_amount_positive`: `CHECK ((amount_centavos > 0))`
- Check `collector_remittances_void_shape`: `CHECK (((num_nonnulls(voided_at, voided_by_user_id, void_reason) = ANY (ARRAY[0, 3])) AND ((void_reason IS NULL) OR (length(TRIM(BOTH FROM void_reason)) >= 3))))`
- Index `collector_remittances_batch_idx`: `(batch_id)`
- Index `collector_remittances_collector_idx`: `(collector_id, received_at)`
- Trigger `collector_remittances_protect` (BEFORE): `collector_remittances_protect()`

## Service control

Suspensions for non-payment and the reconnection workflow, including the reconnection fee.

### suspension_records

Each suspension: date, reason, who approved it.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| service_account_id | uuid | no |  | FK → service_accounts.id |
| effective_date | date | no |  |  |
| reason | text | no |  |  |
| approved_by | text | no |  |  |
| notes | text | yes |  |  |
| past_due_invoice_count | integer | no |  |  |
| past_due_centavos | integer | no |  |  |
| suspended_by_user_id | uuid | no |  | FK → users.id |
| created_at | timestamptz | no | `now()` |  |

- Check `suspension_records_approved_by_present`: `CHECK ((length(TRIM(BOTH FROM approved_by)) > 0))`
- Check `suspension_records_reason_present`: `CHECK ((length(TRIM(BOTH FROM reason)) > 0))`
- Check `suspension_records_snapshot_nonneg`: `CHECK (((past_due_invoice_count >= 0) AND (past_due_centavos >= 0)))`
- Index `suspension_records_account_idx`: `(service_account_id, created_at)`
- Unique index `suspension_records_id_account_idx`: `(id, service_account_id)`
- Trigger `suspension_records_no_update_delete` (BEFORE): `block_modification()`

### reconnection_records

Reconnection requests: technician, completion, fee or fee waiver.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| service_account_id | uuid | no |  | FK → service_accounts.id |
| suspension_record_id | uuid | no |  | FK → suspension_records.id |
| status | text | no | `'requested'::text` |  |
| request_date | date | no |  |  |
| requested_by_user_id | uuid | no |  | FK → users.id |
| requested_at | timestamptz | no | `now()` |  |
| fee_centavos | integer | no |  |  |
| fee_waived | boolean | no | `false` |  |
| fee_waiver_reason | text | yes |  |  |
| notes | text | yes |  |  |
| technician_user_id | uuid | yes |  | FK → users.id |
| assigned_by_user_id | uuid | yes |  | FK → users.id |
| assigned_at | timestamptz | yes |  |  |
| completion_date | date | yes |  |  |
| completed_by_user_id | uuid | yes |  | FK → users.id |
| completed_at | timestamptz | yes |  |  |
| cancel_reason | text | yes |  |  |
| cancelled_by_user_id | uuid | yes |  | FK → users.id |
| cancelled_at | timestamptz | yes |  |  |

- Check `reconnection_records_assignment_shape`: `CHECK (((num_nonnulls(technician_user_id, assigned_by_user_id, assigned_at) = ANY (ARRAY[0, 3])) AND ((status <> 'assigned'::text) OR (technician_user_id IS NOT NULL))))`
- Check `reconnection_records_cancel_shape`: `CHECK ((((status = 'cancelled'::text) = (num_nonnulls(cancel_reason, cancelled_by_user_id, cancelled_at) = 3)) AND (num_nonnulls(cancel_reason, cancelled_by_user_id, cancelled_at) = ANY (ARRAY[0, 3]))))`
- Check `reconnection_records_completion_shape`: `CHECK ((((status = 'completed'::text) = (num_nonnulls(completion_date, completed_by_user_id, completed_at) = 3)) AND (num_nonnulls(completion_date, completed_by_user_id, completed_at) = ANY (ARRAY[0, 3])) AND ((completion_date IS NULL) OR (completion_date >= request_date))))`
- Check `reconnection_records_fee_nonneg`: `CHECK ((fee_centavos >= 0))`
- Check `reconnection_records_status_valid`: `CHECK ((status = ANY (ARRAY['requested'::text, 'assigned'::text, 'completed'::text, 'cancelled'::text])))`
- Check `reconnection_records_waiver_shape`: `CHECK ((fee_waived = (fee_waiver_reason IS NOT NULL)))`
- Index `reconnection_records_account_idx`: `(service_account_id, requested_at)`
- Unique index `reconnection_records_one_live_idx`: `(service_account_id) WHERE (status = ANY (ARRAY['requested'::text, 'assigned'::text]))`
- Unique index `reconnection_records_one_per_suspension_idx`: `(suspension_record_id) WHERE (status <> 'cancelled'::text)`
- Index `reconnection_records_status_idx`: `(status)`
- Index `reconnection_records_technician_idx`: `(technician_user_id)`
- Trigger `reconnection_records_protect` (BEFORE): `reconnection_records_protect()`

## Settings, backups and integrity

Business settings, the backup history and the results of integrity checks.

### application_settings

Business settings as key/value pairs (grace period, suspension threshold).

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| key | text | no |  | PK |
| value | text | no |  |  |
| updated_at | timestamptz | no | `now()` |  |

### backup_history

Every backup (BK- numbers): kind, files, checksums, verification. Protected by a trigger: only verification fields change after completion.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| backup_number | text | no |  |  |
| kind | text | no |  |  |
| status | text | no |  |  |
| folder_name | text | no |  |  |
| note | text | yes |  |  |
| created_by_user_id | uuid | yes |  | FK → users.id |
| started_at | timestamptz | no | `now()` |  |
| completed_at | timestamptz | yes |  |  |
| database_bytes | bigint | yes |  |  |
| proof_file_count | integer | yes |  |  |
| proof_bytes | bigint | yes |  |  |
| manifest_sha256 | text | yes |  |  |
| verification_status | text | yes |  |  |
| verified_at | timestamptz | yes |  |  |
| verification_message | text | yes |  |  |
| error_message | text | yes |  |  |

- Unique `backup_history_backup_number_unique`: `UNIQUE (backup_number)`
- Check `backup_history_completed_shape`: `CHECK (((status <> 'completed'::text) OR ((completed_at IS NOT NULL) AND (manifest_sha256 IS NOT NULL) AND (database_bytes IS NOT NULL) AND (proof_file_count IS NOT NULL) AND (proof_bytes IS NOT NULL))))`
- Check `backup_history_failed_shape`: `CHECK (((status <> 'failed'::text) OR (error_message IS NOT NULL)))`
- Unique `backup_history_folder_name_unique`: `UNIQUE (folder_name)`
- Check `backup_history_in_progress_shape`: `CHECK (((status <> 'in_progress'::text) OR (completed_at IS NULL)))`
- Check `backup_history_kind_valid`: `CHECK ((kind = ANY (ARRAY['manual'::text, 'scheduled'::text, 'safety'::text])))`
- Check `backup_history_status_valid`: `CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'failed'::text])))`
- Check `backup_history_verification_valid`: `CHECK (((verification_status IS NULL) OR (verification_status = ANY (ARRAY['passed'::text, 'failed'::text]))))`
- Unique index `backup_history_one_in_progress`: `(status) WHERE (status = 'in_progress'::text)`
- Index `backup_history_started_idx`: `(started_at)`
- Trigger `backup_history_protect` (BEFORE): `backup_history_protect()`

### integrity_checks

Results of integrity checks (live, test restore, after restore). Append-only.

| Column | Type | Null | Default | Key |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| scope | text | no |  |  |
| backup_id | uuid | yes |  | FK → backup_history.id |
| passed | boolean | no |  |  |
| results | jsonb | no |  |  |
| run_by_user_id | uuid | yes |  | FK → users.id |
| ran_at | timestamptz | no | `now()` |  |

- Check `integrity_checks_backup_for_restores`: `CHECK (((scope = 'live'::text) OR (backup_id IS NOT NULL)))`
- Check `integrity_checks_scope_valid`: `CHECK ((scope = ANY (ARRAY['live'::text, 'test_restore'::text, 'after_restore'::text])))`
- Index `integrity_checks_ran_idx`: `(ran_at)`
- Trigger `integrity_checks_no_update_delete` (BEFORE): `block_modification()`
