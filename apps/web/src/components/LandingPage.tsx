import type { ReactNode } from 'react';

const telegramBotUrl = 'https://t.me/MojeFinancie2026_bot';

function TelegramHeader() {
  return <div className="telegram-header"><span className="telegram-avatar">ƒ</span><div><b>Osobný finančný asistent</b><small>online</small></div></div>;
}

function ChatMessage({ from = 'bot', children }: { from?: 'user' | 'bot'; children: ReactNode }) {
  return <div className={`chat-message ${from === 'user' ? 'chat-message-user' : 'chat-message-bot'}`}>{children}</div>;
}

export function LandingPage() {
  return (
    <main className="landing-shell">
      <header className="landing-nav">
        <a className="brand" href="/" aria-label="Osobný finančný asistent – úvod">ofa<span>•</span></a>
        <nav aria-label="Hlavná navigácia"><a href="#ako-to-funguje">Ako funguje</a><a href="#ukazky">Ukážky</a><a href="#reporty">Reporty</a><a href="/login">Prihlásiť sa</a></nav>
      </header>

      <section className="hero-section" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <p className="landing-eyebrow">FINANCIE CEZ TELEGRAM</p>
          <h1 id="hero-heading">Pošli správu alebo fotku bločku do Telegramu. Výdavok sa uloží, bloček nestratíš a pri reklamácii ho nájdeš za pár sekúnd.</h1>
          <p className="hero-warranty-note">Ak chcete sledovať záruku, doklad uložíme a upozornenie príde 60, 30 a 7 dní pred koncom nastaveného obdobia. Spolu s upozornením dostanete aj uložený bloček.</p>
          <p className="hero-lead">Osobný finančný asistent ti pomáha zapisovať výdavky a príjmy priamo v Telegrame. Bez tabuliek, formulárov a ďalšej aplikácie.</p>
          <div className="hero-actions"><a className="telegram-button" href={telegramBotUrl} target="_blank" rel="noreferrer">Vyskúšať v Telegrame <span aria-hidden="true">↗</span></a><a className="text-button" href="#ukazky">Pozrieť ukážky <span aria-hidden="true">↓</span></a></div>
          <p className="hero-note">Beta verzia je bezplatná. Stačí otvoriť Telegram.</p>
        </div>
        <div className="hero-chat-stage" aria-label="Ukážka Telegram konverzácie">
          <div className="hero-glow" />
          <div className="telegram-phone"><TelegramHeader /><div className="telegram-chat hero-chat"><span className="chat-day">DNES</span><ChatMessage from="user">Káva 3,50 €<small>10:42 ✓✓</small></ChatMessage><ChatMessage><b>✅ Zapísané</b><span>Káva · 3,50 €</span><em>Reštaurácie</em><small>10:42</small></ChatMessage><ChatMessage from="user">🎙️ Hlasová správa<small>12:18 ✓✓</small></ChatMessage><ChatMessage><b>✅ Zapísané</b><span>Obed · 12,00 €</span><small>12:18</small></ChatMessage></div><div className="telegram-input"><span>Napíš správu…</span><b>➤</b></div></div>
          <div className="hero-float hero-float-top"><span>📊</span><div><small>Výdavky tento mesiac</small><b>428,60 €</b></div></div>
          <div className="hero-float hero-float-bottom"><span>✓</span><div><small>Automaticky uložené</small><b>Bez ručného prepisovania</b></div></div>
        </div>
      </section>

      <section className="trust-strip" aria-label="Hlavné výhody"><p><span>✦</span> Zápis za pár sekúnd</p><p><span>✦</span> Bločky na jednom mieste</p><p><span>✦</span> Automatické reporty</p></section>

      <section className="how-section section-wrap" id="ako-to-funguje" aria-labelledby="how-heading">
        <div className="section-intro"><p className="landing-eyebrow">AKO TO FUNGUJE</p><h2 id="how-heading">Tri jednoduché kroky. Žiadne účtovanie.</h2></div>
        <div className="steps-grid"><article><span className="step-number">01</span><div className="step-icon">✎</div><h3>Napíšeš alebo povieš</h3><p>„Káva 3,50 €“, „Benzín 60 €“ alebo jednoducho pošli hlasovú správu.</p></article><article><span className="step-number">02</span><div className="step-icon">✓</div><h3>Asistent uloží záznam</h3><p>Rozpozná sumu, príjem alebo výdavok a zaradí ho do kategórie.</p></article><article><span className="step-number">03</span><div className="step-icon">◔</div><h3>Dostaneš prehľad</h3><p>V chate máš reporty, uložené bločky aj možnosť opraviť posledný zápis.</p></article></div>
      </section>

      <section className="examples-section section-wrap" id="ukazky" aria-labelledby="examples-heading">
        <div className="section-intro centered-intro"><p className="landing-eyebrow">AKO VYZERÁ CHAT</p><h2 id="examples-heading">Píšeš prirodzene. Asistent rozumie.</h2><p>Nemusíš poznať príkazy naspamäť. Stačí napísať to, čo by si povedal človeku.</p></div>
        <div className="chat-examples-grid">
          <article className="chat-card"><TelegramHeader /><div className="telegram-chat compact-chat"><ChatMessage from="user">Káva 3,50 €</ChatMessage><ChatMessage><b>✅ Zapísané: Káva – 3,50 €</b><span>Reštaurácie</span></ChatMessage></div><footer><span>Výdavok</span><b>Hotovo za pár sekúnd</b></footer></article>
          <article className="chat-card"><TelegramHeader /><div className="telegram-chat compact-chat"><ChatMessage from="user">🎙️ Prišla mi výplata 1 500 €</ChatMessage><ChatMessage><b>✅ Zapísané: Výplata – 1 500,00 €</b><span>Príjem</span></ChatMessage></div><footer><span>Hlas alebo text</span><b>Príjmy aj výdavky</b></footer></article>
          <article className="chat-card category-demo"><TelegramHeader /><div className="telegram-chat compact-chat"><ChatMessage from="user">Oprav kategóriu</ChatMessage><ChatMessage><b>Kam mám zaradiť poslednú transakciu?</b><span>Vyber kategóriu 👇</span><div className="inline-keyboard" aria-label="Ukážka výberu kategórie"><button type="button">Reštaurácie</button><button type="button">Potraviny</button><button type="button">Auto</button><button type="button">Bývanie</button></div></ChatMessage></div><footer><span>Oprava kategórie</span><b>Kliknutím alebo vetou</b></footer></article>
          <article className="chat-card void-demo"><TelegramHeader /><div className="telegram-chat compact-chat"><ChatMessage from="user">Kávu daj do reštaurácie.</ChatMessage><ChatMessage><b>✅ Opravené.</b><span>Káva 3,50 € → Reštaurácie</span></ChatMessage><ChatMessage from="user">Zruš posledný zápis</ChatMessage><ChatMessage><b>⚠️ Naozaj chceš zrušiť posledný zápis?</b><div className="inline-keyboard single-action"><button type="button">Áno, zrušiť</button></div></ChatMessage></div><footer><span>Bezpečné opravy</span><b>Len posledný zápis</b></footer></article>
        </div>
      </section>

      <section className="receipt-section section-wrap" aria-labelledby="receipt-heading">
        <div className="receipt-copy"><p className="landing-eyebrow">BLOČKY A REKLAMÁCIE</p><h2 id="receipt-heading">Odfotíš dnes. Pri reklamácii nájdeš za pár sekúnd.</h2><p>Po spracovaní bločku si vyberiete, či ho chcete uchovať a nastaviť sledované obdobie. Finančný záznam zostáva vždy.</p><div className="feature-points"><p><span>✓</span> Obchod, dátum a suma pri jednom zázname</p><p><span>✓</span> Uložený doklad len po výslovnom potvrdení</p><p><span>✓</span> Pripomienky 60, 30 a 7 dní pred koncom sledovania</p></div><a className="telegram-button receipt-cta" href={telegramBotUrl} target="_blank" rel="noreferrer">Vyskúšať v Telegrame <span aria-hidden="true">↗</span></a></div>
        <div className="claim-demo"><div className="receipt-paper"><div className="receipt-paper-top"><b>ELEKTRO DOMOV</b><span>12. 09. 2026 · 189,00 €</span></div><div className="receipt-line"><span>Televízor 55&quot;</span><b>189,00 €</b></div><div className="receipt-total"><span>CELKOM</span><b>189,00 €</b></div><div className="receipt-code">▦ ▦ ▦ ▦ ▦</div></div><div className="claim-chat"><ChatMessage from="user">Nájdi mi bloček za televízor.</ChatMessage><ChatMessage><b>🧾 Bloček pre reklamáciu</b><span>Obchod: Elektro Domov</span><span>Dátum: 12. 09. 2026</span><span>Televízor 55&quot; · 189,00 €</span><em>Doklad je pripravený</em></ChatMessage></div><p className="claim-caption">Keď budeš riešiť reklamáciu, doklad nájdeš priamo v chate.</p></div>
      </section>

      <section className="warranty-section section-wrap" aria-labelledby="warranty-heading">
        <div className="warranty-intro">
          <p className="landing-eyebrow">SLEDOVANIE ZÁRUKY</p>
          <h2 id="warranty-heading">Doklad uložíte raz. Pripomenieme ho v správny čas.</h2>
          <p>Pri bločku stačí jedno rozhodnutie. Žiadne formuláre, žiadne vyberanie položiek.</p>
          <div className="warranty-steps" aria-label="Tri kroky sledovania záruky">
            <p><b>1</b> Pošlite bloček.</p>
            <p><b>2</b> Ak chcete sledovať záruku, kliknite ✅ ÁNO.</p>
            <p><b>3</b> Pred koncom sledovaného obdobia dostanete upozornenie aj s uloženým dokladom.</p>
          </div>
          <p className="warranty-duration-note"><b>Máte inú alebo dlhšiu záruku?</b> Stačí napísať napr. „3 roky“ alebo „36 mesiacov“.</p>
          <p>Skutočná lehota sa môže líšiť podľa výrobku a podmienok predajcu alebo výrobcu.</p>
        </div>
        <div className="warranty-chat-card" aria-label="Ukážka sledovania záruky v Telegrame">
          <TelegramHeader />
          <div className="telegram-chat warranty-chat">
            <ChatMessage><b>Obsahuje tento bloček výrobok vhodný na sledovanie reklamácie / záruky?</b><div className="inline-keyboard warranty-choice" aria-label="Ukážka voľby záruky"><button type="button">✅ ÁNO</button><button type="button">❌ NIE</button></div></ChatMessage>
            <ChatMessage><b>✅ Doklad je uložený.</b><span>Sledovanie je nastavené na 2 roky od dátumu nákupu. Ak máte inú alebo dlhšiu záruku, napíšte mi jej dĺžku.</span></ChatMessage>
            <ChatMessage from="user">3 roky</ChatMessage>
            <ChatMessage><b>⏳ O 30 dní končí sledované obdobie k dokladu z LIDL z 10. 9. 2026.</b><span className="receipt-attachment">🧾 Uložený bloček priložený</span></ChatMessage>
          </div>
        </div>
      </section>

      <section className="reports-section" id="reporty" aria-labelledby="reports-heading"><div className="section-wrap reports-layout"><div className="reports-copy"><p className="landing-eyebrow">PREHĽAD BEZ NÁMAHY</p><h2 id="reports-heading">Tvoje peniaze v pár jasných číslach.</h2><p>Týždenný report príde automaticky v pondelok do Telegramu. Mesačný prehľad dostaneš automaticky tiež; ak máš nastavený e-mail, príde aj tam.</p><div className="report-tags"><span>Automaticky</span><span>Príjmy a výdavky</span><span>Top kategórie</span></div></div><article className="report-preview" aria-label="Ukážka týždenného finančného reportu"><header><span>📊</span><div><b>Týždenný prehľad</b><small>2. – 8. september</small></div></header><div className="report-numbers"><div className="income-number"><span>Príjmy</span><b>+1 500,00 €</b></div><div className="expense-number"><span>Výdavky</span><b>−248,60 €</b></div><div><span>Bilancia</span><b>+1 251,40 €</b></div></div><div className="report-categories"><b>Top kategórie</b><p><span><i className="dot dot-green" />Potraviny</span><strong>98,40 €</strong></p><p><span><i className="dot dot-blue" />Reštaurácie</span><strong>64,20 €</strong></p><p><span><i className="dot dot-orange" />Auto</span><strong>60,00 €</strong></p></div><footer>Najvyššie výdavky boli na potraviny. Bilancia za tento týždeň je pozitívna.</footer></article></div></section>

      <section className="say-section section-wrap" aria-labelledby="say-heading"><div className="section-intro centered-intro"><p className="landing-eyebrow">ČO MÔŽEŠ NAPÍSAŤ</p><h2 id="say-heading">Takto jednoducho.</h2><p className="example-note">Toto sú len príklady. Napíš to vlastnými slovami.</p></div><div className="phrase-list"><span>„Káva 3,50 €“</span><span>„Nákup 42 €“</span><span>„Prišla mi výplata 1 500 €“</span><span>„Oprav kategóriu“</span><span>„Kávu daj do reštaurácie“</span><span>„Zruš posledný zápis“</span><span>„Vymaž poslednú transakciu“</span><span>„Nájdi mi bloček z Lidla“</span><span>„Aké boli výdavky tento mesiac?“</span></div></section>

      <section className="final-cta" aria-labelledby="cta-heading"><p className="landing-eyebrow">ZAČNI DNES</p><h2 id="cta-heading">Tvoje financie. Jedna jednoduchá konverzácia.</h2><p>Otvor Telegram, napíš prvý výdavok a uvidíš, či ti tento spôsob sedí.</p><a className="telegram-button light" href={telegramBotUrl} target="_blank" rel="noreferrer">Vyskúšať v Telegrame <span aria-hidden="true">↗</span></a></section>
      <footer className="landing-footer"><a className="brand" href="/">ofa<span>•</span></a><span>Osobný finančný asistent · beta</span><a href="/privacy">Ochrana údajov</a><a href="/login">Webový prehľad</a></footer>
    </main>
  );
}
