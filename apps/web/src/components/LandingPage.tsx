const telegramBotUrl = 'https://t.me/MojeFinancie2026_bot';

export function LandingPage() {
  return (
    <main className="landing-shell">
      <header className="landing-nav">
        <a className="brand" href="/" aria-label="Osobný finančný asistent – úvod">ofa<span>•</span></a>
        <nav aria-label="Hlavná navigácia">
          <a href="#ako-to-funguje">Ako to funguje</a>
          <a href="/login">Prihlásiť sa</a>
        </nav>
      </header>

      <section className="hero-section" aria-labelledby="hero-heading">
        <div className="hero-copy">
          <p className="landing-eyebrow">FINANCIE BEZ TABULIEK A FORMULÁROV</p>
          <h1 id="hero-heading">Napíš výdavok. O zvyšok sa postará asistent.</h1>
          <p className="hero-lead">Zapisuj výdavky, pošli bloček a sleduj svoj mesačný prehľad — priamo v Telegrame, ktorý už používaš.</p>
          <div className="hero-actions">
            <a className="telegram-button" href={telegramBotUrl} target="_blank" rel="noreferrer">Začať v Telegrame <span aria-hidden="true">↗</span></a>
            <a className="text-button" href="#ako-to-funguje">Pozrieť ako to funguje <span aria-hidden="true">↓</span></a>
          </div>
          <p className="hero-note">Bez inštalácie ďalšej aplikácie. Beta verzia je bezplatná.</p>
        </div>

        <div className="phone-stage" aria-label="Ukážka Telegram konverzácie s finančným asistentom">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="phone-frame">
            <div className="phone-speaker" />
            <div className="phone-header"><span className="bot-avatar">ƒ</span><div><b>Osobný finančný asistent</b><small>online</small></div></div>
            <div className="phone-chat">
              <div className="chat-day">DNES</div>
              <div className="bubble user-bubble">Káva 3 € <small>10:42 ✓✓</small></div>
              <div className="bubble bot-bubble"><b>✅ Zapísané</b><span>Reštaurácie · 3,00 €</span><small>10:42</small></div>
              <div className="bubble user-bubble receipt-bubble">📷 <span>Fotka bločku</span><small>12:18 ✓✓</small></div>
              <div className="bubble bot-bubble"><b>✅ Zapísané z bločku</b><span>Lidl · 45,20 €</span><small>12:18</small></div>
            </div>
            <div className="phone-input"><span>Napíšte správu…</span><b>➤</b></div>
          </div>
          <div className="floating-card report-card"><span>📊</span><div><small>Výdavky tento mesiac</small><b>428,60 €</b></div></div>
          <div className="floating-card saved-card"><span>✓</span><div><small>Automaticky uložené</small><b>Bez ručného prepisovania</b></div></div>
        </div>
      </section>

      <section className="trust-strip" aria-label="Hlavné výhody">
        <p><span>✦</span> Výdavok za pár sekúnd</p>
        <p><span>✦</span> Bločky uložené na jednom mieste</p>
        <p><span>✦</span> Mesačný prehľad v chate</p>
      </section>

      <section className="how-section" id="ako-to-funguje" aria-labelledby="how-heading">
        <div className="section-intro"><p className="landing-eyebrow">JEDNODUCHÝ NÁVYK</p><h2 id="how-heading">Tri kroky k lepšiemu prehľadu.</h2></div>
        <div className="steps-grid">
          <article><span className="step-number">01</span><div className="step-icon">⌁</div><h3>Napíš správu</h3><p>Stačí „Obed 12 €“ alebo „Benzín 60 €“. Asistent rozpozná sumu aj kategóriu.</p></article>
          <article><span className="step-number">02</span><div className="step-icon">◫</div><h3>Pošli bloček</h3><p>Fotku uložíme, prečítame údaje a prepojíme ju s výdavkom. Potom stačí napísať „reklamácia topánky“ alebo „bloček Lidl“ a asistent nájde doklad pre reklamáciu.</p></article>
          <article><span className="step-number">03</span><div className="step-icon">◔</div><h3>Pozri si prehľad</h3><p>Opýtaj sa na report. Uvidíš príjmy, výdavky a kategórie bez hľadania v banke.</p></article>
        </div>
      </section>

      <section className="final-cta" aria-labelledby="cta-heading">
        <p className="landing-eyebrow">ZAČNI DNES</p>
        <h2 id="cta-heading">Tvoje financie. Jedna jednoduchá konverzácia.</h2>
        <p>Vyskúšaj beta verziu zdarma a rozhodni sa až podľa toho, či ti naozaj šetrí čas.</p>
        <a className="telegram-button light" href={telegramBotUrl} target="_blank" rel="noreferrer">Otvoriť Telegram bota <span aria-hidden="true">↗</span></a>
      </section>

      <footer className="landing-footer"><a className="brand" href="/">ofa<span>•</span></a><span>Osobný finančný asistent · beta</span><a href="/login">Webový prehľad</a></footer>
    </main>
  );
}
