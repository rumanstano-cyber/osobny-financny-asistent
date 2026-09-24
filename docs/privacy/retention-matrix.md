# Privacy / retention matrix (technical implementation)

This matrix describes the code and migrations in this branch. It is not legal advice. The public privacy notice, controller contact, lawful bases, processor terms, international transfers and the stated retention periods require operator/legal review before public launch.

| Data class | Purpose | Location | Retention | Cleanup | Processor / status |
|---|---|---|---|---|---|
| Ordinary receipt original, OCR text, items and QR helper data | Record an expense and optionally find a receipt | Supabase private Storage + PostgreSQL | 7 days after receipt creation, only after transaction processing is complete | Bounded maintenance claims Storage deletion, then purges extraction metadata | Supabase; enforced by migration/worker |
| Tracked receipt original and extraction | Purchase-protection reminders and complaint evidence | Supabase private Storage + PostgreSQL | Latest current tracked end date + 6 months | Protection update recalculates deadline; bounded maintenance removes Storage then extraction | Supabase; enforced by migration/worker |
| Financial transactions and change history | Finance ledger and reports | Supabase PostgreSQL | Account lifetime; sole workspace removed on fulfilled erasure, shared workspace records retained | Authenticated account erasure workflow, not general retention job | Supabase; enforced with ownership safeguards |
| OCR/voice async jobs and helper payload | Reliable processing and retries | Supabase PostgreSQL | 30 days after terminal status | `cleanup_privacy_metadata`, maximum 100 rows per class/run | Supabase; enforced |
| Telegram message technical records | Message processing/deduplication | Supabase PostgreSQL | 30 days | `cleanup_privacy_metadata` | Supabase/Telegram; enforced for app records; Telegram-side retention is provider-controlled |
| Pairing codes | Telegram ↔ web linking | Supabase PostgreSQL | 15-minute validity; unused/consumed records removed within 24 hours after expiry/use | `cleanup_privacy_metadata` | Supabase; enforced |
| Detailed report snapshot | Display/deliver financial summary | Supabase PostgreSQL | 30 days after terminal delivery | Snapshot set to empty JSON in bounded cleanup | Supabase; enforced |
| Minimal report delivery record | Retry/audit of delivery | Supabase PostgreSQL | 12 months after terminal delivery | Bounded cleanup | Supabase; enforced |
| General audit/security events | Security and operational accountability | Supabase PostgreSQL | 12 months; explicit incident hold may extend | Bounded cleanup with hold check; transaction event history is separate | Supabase; enforced; legal review required |
| Warranty reminder delivery record | Retry/audit of notification | Supabase PostgreSQL | 12 months after terminal delivery | Bounded cleanup | Supabase/Telegram; enforced for app record |
| Rate-limit/dedup counters | Abuse prevention | Supabase PostgreSQL | Existing 8-day rule | Existing scheduled cleanup | Supabase; already enforced |
| Orphan receipt objects | Crash recovery | Supabase private Storage | Existing 7-day safety window before deletion | Existing guarded orphan reconciler; confirmed DB links and active jobs block deletion | Supabase; already enforced |
| Profile, Auth, Telegram identity and linked devices | Account access and delivery | Supabase Auth + PostgreSQL | Account lifetime, then 30-day erasure grace and fulfillment | Explicit account-erasure worker; shared finance retains a minimal non-identifying user tombstone | Supabase/Telegram; partially enforced, DB integration test required |
| Privacy notice acknowledgement | Evidence that a versioned notice was shown | Supabase PostgreSQL | Account lifetime + 12 months after fulfilled erasure | `cleanup_privacy_metadata` | Supabase; technical flow implemented, notice text requires legal review |
| Export package | User-controlled export | Streamed from API to verified web session | Not persisted server-side; downloaded copy under user's control | Stream ends; no public ZIP, no Telegram attachment or Storage export object | Render/Supabase; enforced in application; legal review required |
| Export/deletion request minimal record | Fulfillment/reconciliation | Supabase PostgreSQL | 12 months after completion/cancellation/rejection | `cleanup_privacy_metadata` | Supabase; enforced after migration |
| Daily production backup | Disaster recovery | AWS S3 | Target: 30 days | S3 lifecycle, **operator verification pending**; no lifecycle mutation in this branch | AWS; provider-controlled pending verification |
| Application logs | Troubleshooting | Render | Target: at most 30 days | Render retention setting, **operator verification pending** | Render; provider-controlled/legal review required |

Additional processors are OpenAI for selected AI/OCR tasks, eKasa for receipt QR lookup and Resend when email is configured. Provider-side retention/training settings and contractual transfer terms are **operator/legal verification items**; the repository cannot establish their current account settings. Original voice audio is not intentionally retained in application Storage. Inactivity or subscription termination does not trigger account erasure.

## Backup/erasure safety gate

The application keeps only a minimal database tombstone after fulfillment; a backup made before that event can still contain the old user. **Never promote a restored backup to production without reconciling fulfilled erasure requests against an independent, current source of truth.** The current backup/restore workflow verifies integrity in an isolated environment only and must not be treated as permission to restore live. An independent deletion ledger and automated restore gate are still required before this item can be considered fully closed.
