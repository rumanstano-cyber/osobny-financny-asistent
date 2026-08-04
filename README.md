# Osobný finančný asistent

Monorepo základ pre viac-kanálovú AI SaaS platformu správy osobných financií.

Aktuálny stav: vytvorená je iba adresárová štruktúra. Implementácia ešte nezačala.

Architektonické rozhodnutia a produktová špecifikácia sú v [PROJECT.md](./PROJECT.md).

## Spustenie Telegram MVP

1. V Supabase Dashboard otvor **SQL Editor**, vlož a spusti obsah [`supabase/migrations/20260803000000_initial_schema.sql`](./supabase/migrations/20260803000000_initial_schema.sql). Migrácia vytvára iba nové objekty s názvami tejto architektúry; nemení starú tabuľku `transactions`.
2. Skopíruj `.env.example` do `.env` a doplň Supabase URL, **service-role key**, Telegram bot token a dlhý náhodný `TELEGRAM_WEBHOOK_SECRET`. Súbory s tajomstvami sa necommitujú.
3. Po nainštalovaní Node.js 22+ a pnpm spusti `pnpm install` a `pnpm dev:api`.
4. Nastav Telegram webhook na verejnú HTTPS adresu `https://TVOJA_DOMENA/webhooks/telegram` a odovzdaj rovnaký `secret_token` ako `TELEGRAM_WEBHOOK_SECRET`.

Pre nasadenie vytvor súkromný Supabase Storage bucket migráciou `20260804010000_create_receipts_bucket.sql`. Webhook sa nastavuje až po nasadení backendu na verejnú HTTPS URL.

Overenie: `GET /health` musí odpovedať `{"status":"ok"}`. Po správe `Káva 3 €` bot odpovie `✅ Zapísané: Káva – 3,00 €` a uloží používateľa, osobný workspace, Telegram správu, transakciu, kategóriu a auditnú udalosť.
