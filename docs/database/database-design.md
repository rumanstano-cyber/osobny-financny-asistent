# Databázový návrh — Osobný finančný asistent

**Stav:** návrh pre produkčný SaaS systém · **Databáza:** PostgreSQL 16+ · **Dátum:** 2026-08-03

Tento dokument je databázový kontrakt, nie SQL migrácia. Nezavádza žiadnu implementáciu. Návrh podporuje Telegram MVP, pričom komunikačné kanály, identita a klientské aplikácie sú od finančného jadra oddelené.

## 1. Zásady návrhu

- Primárne kľúče: `uuid` generované aplikačne alebo databázou ako UUIDv7. Každá tabuľka s používateľskými údajmi používa `created_at timestamptz NOT NULL` a podľa potreby `updated_at timestamptz NOT NULL`.
- Časy sa ukladajú v UTC do `timestamptz`. Používateľské časové pásmo je IANA identifikátor, napr. `Europe/Bratislava`.
- Peniaze sú `amount_minor bigint` v najmenších jednotkách meny, nikdy `float` ani PostgreSQL `money`. Mena je `char(3)` ISO 4217.
- Prevádzkový multi-tenancy základ je `workspace`. Osobný účet má vlastný workspace; rodinný účet pridá členov bez zmeny modelu.
- Finančné dáta patria do workspace. Pri každom dopyte sa musí overiť členstvo; v produkcii sa odporúča PostgreSQL Row-Level Security (RLS).
- Meniteľné záznamy nesú verziu a audit. Zmazanie je vo väčšine prípadov logické (`deleted_at`); účtovné udalosti sa neopravujú potichu.
- `jsonb` je určené iba na provider payloady, validované extrakcie a rozšíriteľné metadáta. Hodnoty potrebné na filtrovanie alebo reportovanie majú vlastné stĺpce.

## 2. Referenčné hodnoty a obmedzenia

Odporúčané PostgreSQL enumy (alebo check constraints s rovnakým slovníkom):

| Typ | Hodnoty |
|---|---|
| `workspace_member_role` | `owner`, `admin`, `member`, `viewer` |
| `membership_status` | `active`, `invited`, `suspended`, `removed` |
| `auth_provider` | `telegram`, `whatsapp`, `email`, `apple`, `google`, `web_authn` |
| `channel_type` | `telegram`, `whatsapp`, `web`, `mobile` |
| `message_direction` | `inbound`, `outbound` |
| `message_processing_status` | `received`, `processing`, `completed`, `failed`, `ignored` |
| `transaction_type` | `income`, `expense`, `transfer` |
| `transaction_status` | `confirmed`, `pending_confirmation`, `voided` |
| `transaction_source` | `message`, `receipt`, `manual`, `bank_sync`, `import`, `system` |
| `classification_source` | `rule`, `ai`, `ocr`, `user`, `system` |
| `receipt_status` | `uploaded`, `queued`, `processing`, `completed`, `needs_review`, `failed`, `deleted` |
| `budget_period` | `weekly`, `monthly`, `quarterly`, `yearly`, `custom` |
| `notification_channel` | `telegram`, `whatsapp`, `push`, `email`, `in_app` |
| `notification_status` | `queued`, `sent`, `failed`, `cancelled` |
| `report_type` | `monthly_summary`, `custom_summary`, `category_summary`, `financial_health` |
| `report_delivery_status` | `queued`, `generated`, `sent`, `failed`, `cancelled` |
| `gdpr_request_type` | `export`, `erasure` |
| `gdpr_request_status` | `requested`, `processing`, `completed`, `rejected`, `cancelled` |

`currency_code` vo všetkých tabuľkách je cudzí kľúč do `currencies(code)`. Všetky `amount_minor` majú check `>= 0`; smer určuje typ transakcie, nie záporné číslo.

## 3. Tabuľky

### 3.1 Referenčné a identitné tabuľky

#### `currencies`
Oficiálny zoznam podporovaných mien.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `code` | `char(3)` | PK, ISO 4217 |
| `numeric_code` | `char(3)` | unique, nullable pre neštandardné meny |
| `name` | `text` | not null |
| `minor_unit` | `smallint` | not null, check 0–6 |
| `is_active` | `boolean` | not null, default true |

Indexy: PK `code`; unique `numeric_code`.

#### `users`
Globálna osoba; neobsahuje údaje viazané na jeden komunikačný kanál.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `display_name` | `text` | nullable |
| `email` | `citext` | unique, nullable |
| `locale` | `varchar(16)` | not null, default `sk-SK` |
| `time_zone` | `varchar(64)` | not null, default `Europe/Bratislava` |
| `status` | `varchar(24)` | not null; `active`/`suspended`/`deleted` |
| `last_seen_at` | `timestamptz` | nullable |
| `created_at`, `updated_at`, `deleted_at` | `timestamptz` | timestamps; `deleted_at` nullable |

Indexy: PK; unique čiastočný index na `email WHERE deleted_at IS NULL`; index `(status, last_seen_at DESC)`.

#### `auth_identities`
Externé identity používateľa — Telegram MVP aj budúce web/mobile prihlásenie.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK → `users.id`, `ON DELETE RESTRICT` |
| `provider` | `auth_provider` | not null |
| `provider_subject` | `text` | not null; externé stabilné ID |
| `provider_metadata` | `jsonb` | not null, default `{}`; bez tokenov |
| `verified_at`, `created_at`, `updated_at` | `timestamptz` | `verified_at` nullable |

Indexy/obmedzenia: unique `(provider, provider_subject)`; index `user_id`.

#### `user_devices`
Evidencia viacerých zariadení a push endpointov. Neuchováva tajomstvá v otvorenom texte.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK → `users.id` |
| `platform` | `varchar(24)` | `ios`/`android`/`web`/`desktop` |
| `installation_id` | `uuid` | not null, client-generated |
| `push_token_encrypted` | `bytea` | nullable |
| `push_token_hash` | `bytea` | nullable, unique lookup key |
| `app_version`, `device_label` | `text` | nullable |
| `last_seen_at`, `revoked_at`, `created_at`, `updated_at` | `timestamptz` | `revoked_at` nullable |

Indexy: unique `(user_id, installation_id)`; unique čiastočný `push_token_hash WHERE revoked_at IS NULL`; `(user_id, last_seen_at DESC)`.

#### `workspaces`
Vlastník finančných dát; osobný alebo rodinný priestor.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `name` | `text` | not null |
| `workspace_type` | `varchar(16)` | `personal`/`family` |
| `base_currency_code` | `char(3)` | FK → `currencies.code` |
| `time_zone` | `varchar(64)` | not null |
| `created_by_user_id` | `uuid` | FK → `users.id` |
| `created_at`, `updated_at`, `deleted_at` | `timestamptz` | timestamps |

Indexy: PK; `(created_by_user_id, deleted_at)`.

#### `workspace_members`
M:N väzba používateľov a workspace; základ rodinných účtov a autorizácie.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `workspace_id` | `uuid` | PK/FK → `workspaces.id` |
| `user_id` | `uuid` | PK/FK → `users.id` |
| `role` | `workspace_member_role` | not null |
| `status` | `membership_status` | not null |
| `invited_by_user_id` | `uuid` | FK → `users.id`, nullable |
| `joined_at`, `removed_at`, `created_at`, `updated_at` | `timestamptz` | timestamps |

Indexy: PK `(workspace_id, user_id)`; `(user_id, status)`; unique partial index enforcing one active owner per personal workspace.

#### `user_consents`
Verzovaný a dokazateľný záznam súhlasov (podmienky, súkromie, AI/OCR, marketing).

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK → `users.id` |
| `consent_type` | `varchar(48)` | not null |
| `policy_version` | `varchar(32)` | not null |
| `granted` | `boolean` | not null |
| `recorded_at`, `withdrawn_at` | `timestamptz` | withdrawal nullable |
| `evidence` | `jsonb` | not null, default `{}` |

Indexy: `(user_id, consent_type, recorded_at DESC)`; unique `(user_id, consent_type, policy_version, recorded_at)`.

### 3.2 Kanály a konverzácie

#### `channel_accounts`
Prepojenie identity používateľa so zdrojovým kanálom, napr. Telegram user ID. Jeden používateľ môže mať viac účtov aj zariadení.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK → `users.id` |
| `channel` | `channel_type` | not null |
| `external_account_id` | `text` | not null |
| `external_username` | `text` | nullable |
| `metadata` | `jsonb` | not null, default `{}` |
| `linked_at`, `unlinked_at`, `created_at`, `updated_at` | `timestamptz` | timestamps |

Indexy/obmedzenia: unique `(channel, external_account_id)`; `(user_id, channel) WHERE unlinked_at IS NULL`.

#### `conversations`
Normalizuje Telegram chat a budúce WhatsApp/web/mobile konverzácie.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id` |
| `channel` | `channel_type` | not null |
| `external_conversation_id` | `text` | not null |
| `conversation_type` | `varchar(24)` | `direct`/`group`/`support` |
| `last_message_at`, `created_at`, `updated_at`, `archived_at` | `timestamptz` | timestamps |

Indexy: unique `(channel, external_conversation_id)`; `(workspace_id, last_message_at DESC)`.

#### `channel_messages`
Auditovateľný záznam prichádzajúcich/odchádzajúcich udalostí; idempotencia webhookov.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `conversation_id` | `uuid` | FK → `conversations.id` |
| `sender_channel_account_id` | `uuid` | FK → `channel_accounts.id`, nullable |
| `direction` | `message_direction` | not null |
| `external_message_id` | `text` | not null |
| `idempotency_key` | `varchar(255)` | not null |
| `content_type` | `varchar(32)` | `text`/`image`/`voice`/`document`/`command` |
| `content_encrypted` | `bytea` | nullable |
| `content_hash` | `bytea` | nullable |
| `provider_payload` | `jsonb` | nullable, redacted/minimal |
| `processing_status` | `message_processing_status` | not null |
| `received_at`, `processed_at`, `created_at` | `timestamptz` | timestamps |

Indexy/obmedzenia: unique `(conversation_id, external_message_id)`; unique `idempotency_key`; `(conversation_id, received_at DESC)`; partial `(processing_status, received_at) WHERE processing_status IN ('received','failed')`. Táto tabuľka má retenčnú politiku a je kandidátom na mesačné partitioning.

### 3.3 Kategórie a finančné transakcie

#### `categories`
Systémové aj workspace-vlastné kategórie v hierarchii. Systémová kategória má `workspace_id NULL`, vlastná ho má vyplnený.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id`, nullable |
| `parent_category_id` | `uuid` | FK → `categories.id`, nullable |
| `kind` | `varchar(16)` | `system`/`custom`; check konzistentný s `workspace_id` |
| `name` | `text` | not null |
| `slug` | `varchar(96)` | not null |
| `transaction_type` | `transaction_type` | `income`/`expense`, nullable pre priečinok |
| `icon`, `color` | `varchar(32)` | nullable |
| `is_active`, `is_archived` | `boolean` | not null |
| `created_at`, `updated_at`, `archived_at` | `timestamptz` | timestamps |

Indexy: unique `(workspace_id, slug)` where `workspace_id IS NOT NULL`; unique `(slug)` where `workspace_id IS NULL`; `(workspace_id, parent_category_id, is_active)`.

#### `financial_transactions`
Hlavný záznam príjmov, výdavkov a budúcich prevodov. Všetky reporty vychádzajú z potvrdených, nevymazaných záznamov.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id` |
| `created_by_user_id` | `uuid` | FK → `users.id` |
| `transaction_type` | `transaction_type` | not null |
| `status` | `transaction_status` | not null |
| `amount_minor` | `bigint` | not null, check `>= 0` |
| `currency_code` | `char(3)` | FK → `currencies.code` |
| `occurred_at` | `timestamptz` | not null |
| `time_zone` | `varchar(64)` | not null; zóna pri zápise |
| `merchant_name` | `text` | nullable |
| `note` | `text` | nullable |
| `source` | `transaction_source` | not null |
| `source_message_id` | `uuid` | FK → `channel_messages.id`, nullable |
| `external_reference` | `text` | nullable; bankový/import ID |
| `version` | `integer` | not null, default 1 |
| `metadata` | `jsonb` | not null, default `{}` |
| `confirmed_at`, `voided_at`, `deleted_at`, `created_at`, `updated_at` | `timestamptz` | timestamps |

Indexy/obmedzenia: `(workspace_id, occurred_at DESC) WHERE deleted_at IS NULL`; `(workspace_id, transaction_type, occurred_at DESC) WHERE status='confirmed' AND deleted_at IS NULL`; `(workspace_id, currency_code, occurred_at DESC)`; `(workspace_id, merchant_name)`; unique partial `(workspace_id, source, external_reference) WHERE external_reference IS NOT NULL`; GIN full-text index nad `merchant_name` a `note`. Check: `voided_at IS NOT NULL` len pri `status='voided'`.

#### `transaction_category_assignments`
Nemenná história každej klasifikácie. Aktuálna kategória je posledný záznam s `valid_to IS NULL`; nesmie existovať viac než jeden.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `transaction_id` | `uuid` | FK → `financial_transactions.id` |
| `category_id` | `uuid` | FK → `categories.id` |
| `source` | `classification_source` | not null |
| `confidence` | `numeric(5,4)` | nullable, check 0–1 |
| `reason` | `text` | nullable |
| `ai_run_id` | `uuid` | FK → `ai_runs.id`, nullable |
| `assigned_by_user_id` | `uuid` | FK → `users.id`, nullable |
| `valid_from`, `valid_to`, `created_at` | `timestamptz` | `valid_to` nullable |

Indexy: unique partial `(transaction_id) WHERE valid_to IS NULL`; `(category_id, valid_from DESC)`; `(transaction_id, valid_from DESC)`.

#### `transaction_events`
Append-only história vzniku, potvrdenia, opravy a zrušenia. Umožní forenzný audit aj obnovu zmeny bez prepisovania významu transakcie.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `transaction_id` | `uuid` | FK → `financial_transactions.id` |
| `event_type` | `varchar(48)` | not null, napr. `created`, `confirmed`, `corrected`, `voided` |
| `actor_user_id` | `uuid` | FK → `users.id`, nullable pre systém |
| `before_state`, `after_state` | `jsonb` | nullable, redigované snapshoty |
| `reason` | `text` | nullable |
| `occurred_at` | `timestamptz` | not null |

Index: `(transaction_id, occurred_at DESC)`.

#### `exchange_rates`
Historické kurzy pre budúce multi-currency súhrny; primárna transakcia sa nikdy neprepočíta destruktívne.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `base_currency_code`, `quote_currency_code` | `char(3)` | FK → `currencies.code` |
| `rate` | `numeric(20,10)` | not null, `> 0` |
| `rate_date` | `date` | not null |
| `source` | `varchar(48)` | not null |
| `retrieved_at` | `timestamptz` | not null |

Indexy/obmedzenia: unique `(base_currency_code, quote_currency_code, rate_date, source)`; `(rate_date DESC)`.

### 3.4 Bločky, súbory a AI/OCR

#### `stored_files`
Metadáta objektov v súkromnom S3-kompatibilnom úložisku. Binárne dáta nie sú v PostgreSQL.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id` |
| `storage_provider`, `storage_key` | `text` | not null |
| `content_type` | `varchar(255)` | not null |
| `byte_size` | `bigint` | not null, `> 0` |
| `sha256` | `bytea` | not null |
| `encryption_key_version` | `varchar(32)` | nullable |
| `uploaded_by_user_id` | `uuid` | FK → `users.id`, nullable |
| `created_at`, `deleted_at` | `timestamptz` | timestamps |

Indexy/obmedzenia: unique `(storage_provider, storage_key)`; `(workspace_id, created_at DESC)`; `(workspace_id, sha256)` na detekciu duplicit.

#### `receipts`
Životný cyklus bločku a kanonické OCR polia.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id` |
| `file_id` | `uuid` | FK → `stored_files.id` |
| `uploaded_by_user_id` | `uuid` | FK → `users.id` |
| `source_message_id` | `uuid` | FK → `channel_messages.id`, nullable |
| `status` | `receipt_status` | not null |
| `merchant_name` | `text` | nullable |
| `receipt_date` | `date` | nullable |
| `total_amount_minor` | `bigint` | nullable, check `>= 0` |
| `currency_code` | `char(3)` | FK → `currencies.code`, nullable |
| `ocr_text` | `text` | nullable, retention-controlled |
| `ocr_language` | `varchar(16)` | nullable |
| `processing_error_code` | `varchar(64)` | nullable |
| `created_at`, `processed_at`, `deleted_at`, `updated_at` | `timestamptz` | timestamps |

Indexy: `(workspace_id, receipt_date DESC)`; `(workspace_id, merchant_name)`; `(workspace_id, total_amount_minor)`; GIN full-text index on `ocr_text`; partial `(status, created_at) WHERE status IN ('uploaded','queued','failed')`. Pri veľkom objeme partitionovať podľa `created_at`.

#### `receipt_ocr_runs`
História opakovaného OCR, providerov a istôt bez straty starších výstupov.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `receipt_id` | `uuid` | FK → `receipts.id` |
| `provider` | `varchar(48)` | not null |
| `provider_model` | `varchar(96)` | nullable |
| `status` | `varchar(24)` | `queued`/`running`/`completed`/`failed` |
| `extracted_data` | `jsonb` | nullable, schema-validated |
| `confidence` | `numeric(5,4)` | nullable |
| `error_code` | `varchar(64)` | nullable |
| `started_at`, `completed_at`, `created_at` | `timestamptz` | timestamps |

Indexy: `(receipt_id, created_at DESC)`; partial `(status, created_at) WHERE status IN ('queued','running')`.

#### `receipt_transaction_links`
M:N väzba bločkov a transakcií, vrátane istoty automatického párovania.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `receipt_id` | `uuid` | PK/FK → `receipts.id` |
| `transaction_id` | `uuid` | PK/FK → `financial_transactions.id` |
| `link_source` | `classification_source` | not null |
| `confidence` | `numeric(5,4)` | nullable |
| `linked_by_user_id` | `uuid` | FK → `users.id`, nullable |
| `created_at`, `unlinked_at` | `timestamptz` | timestamps |

Indexy: `(transaction_id) WHERE unlinked_at IS NULL`; `(receipt_id) WHERE unlinked_at IS NULL`.

#### `ai_runs`
Sledovateľnosť AI klasifikácie, interpretácie správy a budúcich odporúčaní. Neuchováva plný prompt, ak nie je povolený retenčnou politikou.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id` |
| `purpose` | `varchar(48)` | `message_parse`/`categorization`/`receipt_extract`/`report_insight` |
| `provider`, `model` | `varchar(96)` | not null |
| `input_hash` | `bytea` | nullable |
| `output` | `jsonb` | nullable, validovaný štruktúrovaný výstup |
| `status` | `varchar(24)` | not null |
| `prompt_version` | `varchar(64)` | nullable |
| `input_tokens`, `output_tokens` | `integer` | nullable |
| `latency_ms` | `integer` | nullable |
| `error_code` | `varchar(64)` | nullable |
| `created_at`, `completed_at` | `timestamptz` | timestamps |

Indexy: `(workspace_id, purpose, created_at DESC)`; partial `(status, created_at) WHERE status='failed'`.

### 3.5 Rozpočty, reporty a notifikácie

#### `budgets`
Rozpočtové pravidlo pre workspace, kategóriu alebo celkové výdavky.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id` |
| `category_id` | `uuid` | FK → `categories.id`, nullable = celkový rozpočet |
| `name` | `text` | not null |
| `period` | `budget_period` | not null |
| `period_anchor_day` | `smallint` | nullable, check 1–31 |
| `starts_on`, `ends_on` | `date` | `ends_on` nullable |
| `amount_minor` | `bigint` | not null, `> 0` |
| `currency_code` | `char(3)` | FK → `currencies.code` |
| `alert_threshold_percent` | `smallint` | nullable, check 1–100 |
| `is_active` | `boolean` | not null |
| `created_by_user_id` | `uuid` | FK → `users.id` |
| `created_at`, `updated_at`, `deleted_at` | `timestamptz` | timestamps |

Indexy: `(workspace_id, is_active)`; `(category_id, is_active)`; unique partial `(workspace_id, category_id, period, starts_on) WHERE deleted_at IS NULL`.

#### `report_schedules`
Nastavenie automatického reportu; dáta reportu nie sú uložené ako voľný text v tomto zázname.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id` |
| `created_by_user_id` | `uuid` | FK → `users.id` |
| `report_type` | `report_type` | not null |
| `schedule_expression` | `text` | not null; validovaný cron/RRULE |
| `time_zone` | `varchar(64)` | not null |
| `delivery_channel` | `notification_channel` | not null |
| `recipient_user_id` | `uuid` | FK → `users.id` |
| `configuration` | `jsonb` | not null, default `{}` |
| `next_run_at`, `last_run_at` | `timestamptz` | nullable |
| `is_active` | `boolean` | not null |
| `created_at`, `updated_at`, `deleted_at` | `timestamptz` | timestamps |

Indexy: partial `(next_run_at) WHERE is_active AND deleted_at IS NULL`; `(workspace_id, is_active)`.

#### `report_deliveries`
Nemenná história vygenerovaných reportov a doručenia.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id` |
| `schedule_id` | `uuid` | FK → `report_schedules.id`, nullable |
| `report_type` | `report_type` | not null |
| `period_start`, `period_end` | `timestamptz` | not null |
| `base_currency_code` | `char(3)` | FK → `currencies.code` |
| `data_snapshot` | `jsonb` | not null; prepočítaný, validovaný súhrn |
| `insight_ai_run_id` | `uuid` | FK → `ai_runs.id`, nullable |
| `file_id` | `uuid` | FK → `stored_files.id`, nullable (budúci PDF/XLSX) |
| `status` | `report_delivery_status` | not null |
| `generated_at`, `sent_at`, `created_at` | `timestamptz` | timestamps |

Indexy: `(workspace_id, period_start DESC)`; `(schedule_id, created_at DESC)`; `(status, created_at)`.

#### `notification_preferences`
Predvoľby používateľa pre typ notifikácie a kanál.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK → `users.id` |
| `workspace_id` | `uuid` | FK → `workspaces.id`, nullable |
| `notification_type` | `varchar(48)` | napr. `budget_threshold`, `monthly_report` |
| `channel` | `notification_channel` | not null |
| `is_enabled` | `boolean` | not null |
| `quiet_hours` | `jsonb` | nullable |
| `created_at`, `updated_at` | `timestamptz` | timestamps |

Indexy/obmedzenia: unique `(user_id, workspace_id, notification_type, channel)`; `(workspace_id, notification_type)`.

#### `notification_deliveries`
Outbox a história doručenia jednotlivých notifikácií.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id` |
| `recipient_user_id` | `uuid` | FK → `users.id` |
| `channel` | `notification_channel` | not null |
| `notification_type` | `varchar(48)` | not null |
| `payload` | `jsonb` | not null, bez citlivých údajov navyše |
| `deduplication_key` | `varchar(255)` | not null |
| `status` | `notification_status` | not null |
| `scheduled_for`, `sent_at`, `failed_at`, `created_at` | `timestamptz` | timestamps |
| `attempt_count` | `smallint` | not null, default 0 |
| `provider_message_id`, `error_code` | `text` | nullable |

Indexy/obmedzenia: unique `(workspace_id, deduplication_key)`; partial `(status, scheduled_for) WHERE status='queued'`; `(recipient_user_id, created_at DESC)`.

### 3.6 Audit, GDPR a prevádzka

#### `audit_events`
Nemenný bezpečnostný audit zmien a prístupov. Ukladá sa redigovaný diff, nie tajomstvá ani plné OCR texty.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id`, nullable pre globálnu udalosť |
| `actor_user_id` | `uuid` | FK → `users.id`, nullable pre systém |
| `actor_type` | `varchar(24)` | `user`/`system`/`service` |
| `action` | `varchar(96)` | not null |
| `entity_type` | `varchar(64)` | not null |
| `entity_id` | `uuid` | nullable |
| `request_id`, `ip_hash` | `varchar(128)` | nullable |
| `before_data`, `after_data`, `metadata` | `jsonb` | nullable/redigované |
| `occurred_at` | `timestamptz` | not null |

Indexy: `(workspace_id, occurred_at DESC)`; `(entity_type, entity_id, occurred_at DESC)`; `(actor_user_id, occurred_at DESC)`. Partitionovať mesačne/štvrťročne podľa retencie.

#### `gdpr_requests`
Riadi export alebo výmaz osobných údajov a zachováva zákonný dôkaz spracovania.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK → `users.id` |
| `request_type` | `gdpr_request_type` | not null |
| `status` | `gdpr_request_status` | not null |
| `requested_at`, `due_at`, `completed_at` | `timestamptz` | timestamps |
| `requested_workspace_id` | `uuid` | FK → `workspaces.id`, nullable |
| `export_file_id` | `uuid` | FK → `stored_files.id`, nullable |
| `rejection_reason` | `text` | nullable |
| `created_at`, `updated_at` | `timestamptz` | timestamps |

Indexy: partial `(status, due_at) WHERE status IN ('requested','processing')`; `(user_id, requested_at DESC)`.

#### `async_jobs`
Voliteľná databázová outbox/fronta, ak sa na začiatku nepoužije samostatný queue provider. Zabezpečuje retry a deduplikáciu OCR/reportov.

| Stĺpec | Typ | Pravidlo |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | FK → `workspaces.id`, nullable |
| `job_type` | `varchar(64)` | not null |
| `payload` | `jsonb` | not null, minimálny payload |
| `deduplication_key` | `varchar(255)` | nullable |
| `status` | `varchar(24)` | `queued`/`running`/`completed`/`failed`/`cancelled` |
| `run_after`, `locked_at`, `completed_at`, `created_at` | `timestamptz` | timestamps |
| `attempt_count`, `max_attempts` | `smallint` | not null |
| `last_error_code` | `varchar(64)` | nullable |

Indexy: partial `(run_after, created_at) WHERE status='queued'`; unique partial `(job_type, deduplication_key) WHERE deduplication_key IS NOT NULL AND status IN ('queued','running')`.

## 4. ER diagram (textová forma)

```text
users ──< auth_identities
users ──< user_devices
users ──< user_consents
users >──< workspace_members >── workspaces
users ──< channel_accounts

workspaces ──< conversations ──< channel_messages
channel_accounts ──< channel_messages

workspaces ──< categories (self-reference: parent_category_id)
workspaces ──< financial_transactions ──< transaction_events
financial_transactions ──< transaction_category_assignments >── categories
channel_messages ──< financial_transactions

workspaces ──< stored_files ──< receipts ──< receipt_ocr_runs
receipts >──< receipt_transaction_links >── financial_transactions
workspaces ──< ai_runs ──< transaction_category_assignments

workspaces ──< budgets
workspaces ──< report_schedules ──< report_deliveries
users ──< notification_preferences
workspaces ──< notification_deliveries >── users

workspaces ──< audit_events
users ──< gdpr_requests
workspaces ──< async_jobs
currencies ──< workspaces / financial_transactions / receipts / budgets / report_deliveries
```

## 5. Integritné a bezpečnostné pravidlá

1. Aplikácia aj databázové politiky overia, že `created_by_user_id`, členovia, notifikační príjemcovia a zdrojové kanály majú oprávnenie voči danému `workspace_id`.
2. Cudzí kľúč sám neochráni pred cross-workspace väzbou (napr. receipt z iného workspace). Túto konzistenciu vynútia composite FK alebo deferred constraint trigger; vo finálnej migrácii sa majú použiť aj zložené unique kľúče `(id, workspace_id)` na citlivých entitách.
3. Pôvodný obsah správ, OCR text a AI výstupy majú konfigurovateľnú retenciu, prístup len pre oprávnené služby a šifrovanie na aplikačnej vrstve tam, kde to vyžaduje klasifikácia dát.
4. Tokeny poskytovateľov, webhook tajomstvá a šifrovacie kľúče nepatria do týchto tabuliek. Spravuje ich secrets manager; v DB môže byť len odkaz a verzia kľúča.
5. `audit_events`, `transaction_events`, `transaction_category_assignments`, `receipt_ocr_runs` a `report_deliveries` sú append-only. UPDATE/DELETE povoliť len riadenej servisnej roli, ideálne databázovou politikou.
6. Každý mutačný request dostane `request_id`; externé webhooky a notifikácie používajú jedinečné idempotency/deduplication kľúče.

## 6. Škálovanie a prevádzkové odporúčania

- **Indexovať podľa skutočných dopytov:** najdôležitejšie sú `(workspace_id, occurred_at)` pre reporty a vyhľadávanie. Indexy pravidelne overovať cez `EXPLAIN ANALYZE`; nepridávať duplicitné indexy.
- **Partitioning až pri objeme:** mesačne partitionovať `channel_messages`, `audit_events`, `receipts` a prípadne `financial_transactions` podľa `created_at`/`occurred_at` až pri miliónoch riadkov alebo jasnej retenčnej potrebe. `financial_transactions` sú dlhodobo hodnotné, preto ich nevymazávať len kvôli rotácii logov.
- **Reporty:** pre MVP agregovať nad indexovanými transakciami. Pri rastúcom objeme použiť denné materializované agregácie per workspace, mena a kategória; zdrojom pravdy zostávajú transakcie.
- **Vyhľadávanie bločkov:** začať PostgreSQL full-text search s `pg_trgm` indexmi na obchodníka. Až pri merateľne nedostatočnej kvalite/latencii pridať externý search index.
- **Connection pooling:** PgBouncer alebo managed pooling; oddeliť roly aplikácie, workera a migrácií; najmenšie potrebné privilégiá.
- **Zálohy a obnova:** point-in-time recovery, šifrované zálohy, pravidelne testovaná obnova a životný cyklus objektového úložiska nezávislý od DB backupu.
- **RLS:** používať `workspace_id` ako tenant context a nastaviť ho na každom requeste v transakcii. Service/worker rola má mať úzko vymedzený bypass iba ak je nevyhnutný.
- **Observabilita:** merať pomalé dopyty, zlyhané joby, retry, veľkosť partitionov a neodoslané notifikácie. Do logov nezapisovať obsah bločkov, správ ani finančné poznámky.

## 7. Rozhodnutia pred SQL migráciami

Pred implementáciou treba schváliť:

1. poskytovateľa PostgreSQL, objektového úložiska a fronty úloh,
2. pravidlá retencie správ, OCR textov, obrázkov bločkov a auditných dát,
3. či má byť osobný workspace vytvorený automaticky pri prvom Telegram kontakte,
4. model oprávnení rodinného účtu (najmä viditeľnosť a možnosť úpravy cudzích transakcií),
5. zdroj výmenných kurzov a pravidlo pre viacmenové reporty,
6. GDPR procesy, DPA a umiestnenie dát pred produkčným spracovaním reálnych finančných údajov.
