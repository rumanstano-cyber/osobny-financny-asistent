# Nasadenie na Render (Free)

## 1. Vytvorenie služby

1. Prihlás sa do [Render Dashboard](https://dashboard.render.com/) a zvoľ **New + → Blueprint**.
2. Pripoj GitHub účet a vyber repozitár `rumanstano-cyber/osobny-financny-asistent`.
3. Render načíta súbor `render.yaml`. Potvrď vytvorenie služby `osobny-financny-asistent-api` vo free pláne.
4. Po prvom deployi otvor službu a skopíruj jej verejnú URL, napríklad `https://osobny-financny-asistent-api.onrender.com`.

## 2. Environment Variables

V službe otvor **Environment → Environment Variables** a zadaj tieto hodnoty. Úplný zoznam je v [`.env.example`](./.env.example).

| Premenná | Hodnota |
| --- | --- |
| `BASE_URL` | Verejná Render URL bez koncového `/`, napr. `https://osobny-financny-asistent-api.onrender.com` |
| `SUPABASE_URL` | HTTPS URL Supabase projektu |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key; nikdy ho nevkladaj do klientského kódu ani GitHubu |
| `TELEGRAM_BOT_TOKEN` | Token Telegram bota |
| `OPENAI_API_KEY` | Povinný pre OCR, hlas a AI reporty |
| `INTERNAL_CRON_SECRET` | Dlhý náhodný reťazec; Blueprint ho dokáže vygenerovať |
| `TELEGRAM_WEBHOOK_SECRET` | Voliteľný dlhý náhodný reťazec |
| `REGISTER_TELEGRAM_WEBHOOK` | `true` |

Pre e-mailové reporty voliteľne pridaj `RESEND_API_KEY` a `EMAIL_FROM`.

## 3. Dokončenie webhooku

Po uložení `BASE_URL` zvoľ **Manual Deploy → Deploy latest commit**. Pri štarte aplikácia nastaví Telegram webhook na:

`https://<app-name>.onrender.com/api/telegram/webhook`

V Render logu sa objaví `Telegram webhook registered`. Over zdravie služby otvorením:

`https://<app-name>.onrender.com/health`

Očakávaná odpoveď je `{"status":"ok"}`. Potom pošli botovi testovaciu správu `Káva 3 €`.

## Dôležité pre free plán

Free web služby sa pri neaktivite uspávajú, preto môže prvá správa po dlhšej pauze reagovať pomalšie. Render môže webhook počas štartu znova nastaviť; Telegram túto operáciu podporuje. Plánovač mesačných reportov beží iba v čase, keď je služba aktívna, preto je pre garantované presné odoslanie v produkcii vhodný platený worker alebo externý scheduler.

## 4. Webový klient ako Render Static Site

1. V Render Dashboard zvoľ **New + → Blueprint** a vyber rovnaký repozitár. Ak už API služba vznikla z Blueprintu, otvor ju a synchronizuj Blueprint z vetvy `main`; Render pridá službu `osobny-financny-asistent-web`.
2. Over nastavenia statickej služby: Build Command je `corepack enable && pnpm install --frozen-lockfile && pnpm build:web` a Publish Directory je `apps/web/dist`.
3. V službe **osobny-financny-asistent-web → Environment** vlož iba tieto dve prehliadačové premenné:

| Premenná | Hodnota |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://axzatojzlajzbtukpuly.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key z **Supabase → Settings → API Keys** |

4. Zvoľ **Save, rebuild, and deploy**. Po deployi bude URL typicky `https://osobny-financny-asistent-web.onrender.com`.
5. V Supabase otvor **Authentication → URL Configuration** a pridaj túto HTTPS URL do **Site URL** aj do **Redirect URLs**. Pre lokálny vývoj ponechaj aj `http://localhost:5173`.

Nikdy nevkladaj `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` ani Telegram token do Static Site. Premenné s prefixom `VITE_` sa vložia do JavaScriptového buildu a sú verejne čitateľné.
