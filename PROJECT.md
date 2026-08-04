# Osobný finančný asistent — projektová špecifikácia

## 1. Účel produktu

Osobný finančný asistent je viac-kanálová AI SaaS platforma pre správu osobných financií. Používateľ komunikuje prirodzeným jazykom; systém rozpoznáva finančné udalosti, uchováva ich, pracuje s bločkami a poskytuje okamžité aj pravidelné finančné prehľady.

Prvým kanálom je Telegram. Architektúra však nesmie viazať doménovú logiku na Telegram, aby bolo možné neskôr bez prepisovania jadra doplniť WhatsApp, web a mobilnú aplikáciu.

## 2. Stav existujúceho projektu (audit: 2026-08-03)

Auditovaný pracovný priečinok je momentálne prázdny.

- Nenachádza sa v ňom zdrojový kód, konfigurácia, balíčkový manifest ani skripty.
- Nenachádza sa databázová migrácia, schéma, export databázy ani konfiguračné údaje pripojenia.
- Nenachádza sa existujúca tabuľka, ktorú bolo možné preskúmať.
- Nenachádza sa Git repozitár ani iná projektová história.

Z tohto dôvodu zatiaľ nie je možné overiť technológie, bezpečnostné nastavenia, dátový model, kvalitu kódu ani súlad už vytvorenej databázovej tabuľky s cieľovou architektúrou. Pred implementáciou je potrebné dodať prístup k databáze, SQL schému/export alebo umiestnenie existujúceho projektu, ak sa nachádza mimo tohto priečinka.

## 3. Produktové požiadavky pre prvú verziu

### Textové zápisy

Používateľ môže poslať napríklad:

- `Káva 3 €`
- `Potraviny Lidl 45 €`
- `Benzín 60 €`
- `Výplata 1500 €`
- `Príjem 250 €`

Systém musí určiť, či ide o príjem alebo výdavok, a vytvoriť finančnú transakciu s najmenej týmito údajmi:

- suma a mena,
- dátum a čas udalosti,
- kategória,
- poznámka,
- používateľ,
- zdrojový kanál a identifikátor konverzácie/správy,
- miera istoty AI a pôvod hodnoty (AI, používateľ, OCR).

Pri dostatočnej istote bot odpovie `✅ Zapísané.` Pri nízkej istote si vyžiada krátke potvrdenie alebo výber kategórie. Neistota sa nesmie potichu ukladať ako nepravdivý údaj.

### Kategórie

Základný katalóg: Potraviny, Káva, Auto, Bývanie, Reštaurácie, Zábava, Drogéria, Elektronika, Oblečenie, Zdravie, Domácnosť, Deti, Poistenie, Dovolenka a Ostatné.

Kategórie majú byť dátovo riadené, nie pevne zapísané vo vstupe bota. Neskôr musí byť možné pridať vlastné kategórie, pravidlá a preferencie používateľa.

### Bločky

Používateľ môže poslať fotografiu bločku. Systém musí:

1. bezpečne uložiť originálny súbor mimo databázy,
2. spracovať OCR asynchrónne,
3. extrahovať obchodníka, dátum, sumu a relevantný text,
4. vytvoriť alebo prepojiť výdavok,
5. umožniť vyhľadávanie v texte a štruktúrovaných poliach, napr. „Nájdi bloček z Lidla“ alebo „…za televízor“.

Automatické párovanie bločka s transakciou musí byť kontrolovateľné používateľom, najmä pri podobných sumách alebo dátumoch.

### Reporty

Používateľ môže prirodzeným jazykom požiadať o prehľad, napr. mesačné výdavky, výdavky na jedlo alebo aktuálny finančný stav. Systém vygeneruje stručnú odpoveď z overených agregovaných dát.

Mesačný report obsahuje príjmy, výdavky, úspory, rozdelenie podľa kategórií, grafy, trendy a opatrne formulované AI odporúčania. Výpočty súm musia pochádzať z databázy; AI ich iba vysvetľuje a formuluje.

## 4. Cieľová architektúra

Odporúčaný začiatok je **modulárny monolit** s jasnými doménovými hranicami, nie sada mikroservisov. Poskytne rýchlosť vývoja a jednoduchšiu prevádzku, pričom moduly sa neskôr dajú samostatne vyčleniť pri reálnej potrebe škálovania.

```text
Telegram / WhatsApp / Web / Mobile
              │
       Channel adapters
              │
       Application API
              │
 ┌────────────┼──────────────────────────┐
 │ Identity & tenancy                     │
 │ Conversation / AI orchestration        │
 │ Transactions & categorisation          │
 │ Receipts & document search             │
 │ Reports, budgets & notifications       │
 └────────────┼──────────────────────────┘
              │
 PostgreSQL + object storage + job queue
              │
  OCR / AI provider adapters / observability
```

### Navrhované komponenty

- **API/aplikácia:** typovo bezpečný backend s REST alebo GraphQL API pre budúce klienty; webhook endpointy pre chatové kanály.
- **Databáza:** PostgreSQL ako zdroj pravdy pre transakčné dáta, prístup cez verzované migrácie.
- **Súbory:** objektové úložisko kompatibilné so S3 pre bločky a generované reporty; v databáze len metadáta a referencie.
- **Asynchrónne úlohy:** fronta a worker pre OCR, spracovanie AI, generovanie reportov a plánované notifikácie. Webhook nesmie čakať na dlhé OCR/AI operácie.
- **AI vrstva:** poskytovateľsky nezávislý adaptér s validovaným štruktúrovaným výstupom. Jazykový model nesmie vykonávať SQL ani rozhodovať o prístupových právach.
- **Vyhľadávanie:** PostgreSQL full-text search postačuje na začiatok; samostatný vyhľadávací index sa pridá až pri merateľnej potrebe.
- **Observabilita:** štruktúrované logy, metriky, sledovanie chýb a auditné udalosti; citlivé finančné údaje sa nesmú zapisovať do logov v plnom znení.

## 5. Doménový dátový model (návrh, zatiaľ neimplementovaný)

Kľúčové entity:

- `users` — vlastník identity a nastavení.
- `workspaces` — finančný priestor; pripravený na rodinné účty a SaaS tenancy.
- `workspace_members` — roly a členstvo používateľov vo workspace.
- `channel_accounts` — prepojenie používateľa s Telegramom a budúcimi kanálmi, bez ukladaných nešifrovaných tokenov.
- `categories` — systémové a vlastné kategórie vo workspace.
- `transactions` — nemenný finančný záznam s typom `income`/`expense`, sumou v minor units, menou, časom, obchodníkom, poznámkou a kategóriou.
- `transaction_category_assignments` — história a pôvod kategorizácie, ak bude neskôr potrebná revízia/viac kategórií.
- `receipts` — metadáta súboru, OCR stav, extrahované hodnoty a väzba na objektové úložisko.
- `receipt_transaction_links` — väzba bločkov a transakcií vrátane istoty párovania.
- `conversations` a `messages` — minimálne potrebná história pre idempotenciu, stav doplňujúcej otázky a audit; retenčné pravidlá musia byť konfigurovateľné.
- `report_schedules` a `report_deliveries` — plánovanie a doručenie pravidelných reportov.
- `audit_events` — bezpečnostne relevantné akcie a zmeny údajov.

### Dátové pravidlá

- Peniaze ukladať ako celé minor units (`amount_minor`), nikdy nie `float`.
- Mena musí mať ISO 4217 kód; všetky primárne sumy sa uchovávajú v pôvodnej mene.
- Časy ukladať v UTC; časové pásmo je používateľské/workspace nastavenie.
- Každý doménový záznam musí byť scoped na `workspace_id`; ide o základ izolácie tenantov.
- Vstupné správy a webhooky musia mať idempotency key, aby opakované doručenie nevytvorilo duplicitný výdavok.
- Ručné opravy majú vytvoriť auditnú stopu; finančný záznam sa nemá nepozorovane prepísať.

## 6. Bezpečnosť a súkromie

- Overovať podpisy webhookov Telegramu a budúcich poskytovateľov.
- Zaviesť autorizáciu na úrovni workspace a roly pred každým čítaním či zápisom.
- Šifrovať dáta počas prenosu aj v úložisku; tajomstvá uložiť v správcovi tajomstiev, nie v repozitári ani v chate.
- Použiť krátkodobé podpísané URL pre prístup k bločkom, nie verejné odkazy.
- Zaviesť limity požiadaviek, ochranu proti zneužitiu, validáciu vstupov a ochranu pred prompt injection z obsahu správ/bločkov.
- Navrhnúť export a vymazanie používateľských dát, retenčné lehoty a audit prístupov s ohľadom na GDPR.
- AI odporúčania výslovne prezentovať ako informatívne, nie ako regulované investičné či finančné poradenstvo.

## 7. Prevádzka a škálovanie

- Samostatné prostredia development, staging a production; žiadne produkčné tajomstvá v lokálnych `.env` súboroch.
- Kontajnerizácia, automatické testy, linting, typová kontrola a databázové migrácie v CI/CD.
- Zálohy PostgreSQL, test obnovy, životný cyklus súborov a monitoring fronty úloh.
- Horizontálne škálovateľné API a workery; stateless aplikácia.
- Prehľadové agregácie a indexy optimalizovať podľa reálnych dopytov; predčasné mikroservisy a samostatný search cluster neimplementovať.

## 8. Budúce rozšírenia

Architektúra musí nechať priestor pre hlasové správy, AI finančného poradcu, rodinné účty, viac mien a kurzy, export PDF/Excel, bankovú synchronizáciu, finančné ciele, rozpočty a upozornenia na vysoké výdavky.

Tieto schopnosti majú byť pridané ako samostatné doménové moduly a integrácie. Základné transakcie preto už od začiatku nesmú predpokladať jediného používateľa, jedinú menu, jediný komunikačný kanál ani výlučne manuálne zadaný pôvod údajov.

## 9. Zistenia a odporúčania pred implementáciou

1. V pracovnom priečinku nie je žiadna existujúca tabuľka. Je potrebné poskytnúť SQL schému/export, prístup k databáze alebo jej reálne umiestnenie. Až potom možno posúdiť kompatibilitu a pripraviť neinvazívnu migračnú stratégiu.
2. Treba vybrať backendový stack, hosting, databázového poskytovateľa, objektové úložisko, job queue a AI/OCR poskytovateľov. Tieto voľby zásadne ovplyvnia náklady, ochranu dát a prevádzku.
3. Pred kódom treba potvrdiť pravidlá: základná mena, krajiny/jazyky, či je účet osobný alebo workspace, retenčná politika fotografií a cieľový model prihlásenia mimo Telegramu.
4. Pre prvé vydanie odporúčam dodávať jadro v poradí: identity a tenancy → Telegram vstup a idempotentný zápis → kategorizácia s potvrdením neistoty → reporty → OCR bločky → plánované reporty.

## 10. Návrh ďalšieho postupu (bez implementácie)

1. Dodať alebo sprístupniť aktuálny zdrojový projekt a existujúcu databázovú tabuľku na doplňujúci audit.
2. Schváliť technologický stack a rozhodnutia o prevádzke/súkromí.
3. Pripraviť detailný návrh databázovej schémy a API kontraktov na schválenie.
4. Až po schválení založiť projektový základ, migrácie, CI/CD a prvý Telegram vertikálny tok.

Žiadny zdrojový kód, databáza ani existujúca funkcionalita neboli počas tohto auditu upravené.
