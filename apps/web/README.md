# Webový klient

Mobile-first React/Vite aplikácia pre klientsky finančný prehľad. Priamo používa Supabase Auth a Data API s používateľskou reláciou; **neobsahuje ani nesmie obsahovať** service-role kľúč.

## Lokálne spustenie

1. Aplikuj migráciu `supabase/migrations/20260811184000_add_web_auth_and_dashboard_rls.sql` do Supabase.
2. V Supabase Dashboard nastav v **Authentication → URL Configuration** `http://localhost:5173` ako Site URL a Redirect URL.
3. Skopíruj `apps/web/.env.example` do `apps/web/.env.local` a vyplň URL projektu a jeho publishable key.
4. V koreni repozitára spusti `pnpm install` a `pnpm dev:web`.
5. Otvor `http://localhost:5173`.

## Nasadenie

### Render Static Site

Blueprint `render.yaml` vytvára samostatnú statickú službu `osobny-financny-asistent-web`. V jej Environment nastaveniach zadaj:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Po deployi pridaj jej HTTPS URL do Supabase **Authentication → URL Configuration** ako Site URL a Redirect URL.

Klient používa chránenú trasu `/dashboard`; Blueprint už obsahuje potrebné SPA presmerovanie na `index.html`.

### Vercel

Importuj rovnaký GitHub repozitár, nastav **Root Directory** na `apps/web`, Build Command `pnpm build` a Output Directory `dist`. Pridaj rovnaké dve `VITE_` premenné a verejnú URL vlož do Supabase Auth URL Configuration.

## Párovanie s Telegramom

Po prihlásení vytvor v dashboarde jednorazový kód. V súkromnom chate s botom následne pošli `/link KÓD`. Kód sa v databáze neukladá v otvorenom tvare, platí 15 minút a dá sa použiť len raz.
