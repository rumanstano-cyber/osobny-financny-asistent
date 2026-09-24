export function PrivacyInformationPage() {
  return <main className="page-center">
    <article className="content-card" style={{ maxWidth: 760, width: '100%', margin: '1rem' }}>
      <a href="/">← Osobný finančný asistent</a>
      <h1>Ochrana osobných údajov</h1>
      <p><strong>Technický návrh – vyžaduje právnu a obsahovú kontrolu pred verejným spustením.</strong></p>
      <p>Osobný finančný asistent spracúva údaje potrebné na evidenciu financií, bločkov, sledovaných období a zasielanie prehľadov. Prevádzkovateľ a kontaktné údaje: <strong>doplniť pred verejným spustením</strong>.</p>
      <h2>Aké údaje a prečo</h2>
      <p>Účet a prepojenie s Telegramom, finančné záznamy, odoslané doklady, voliteľné sledovanie dokladov, reporty a technické bezpečnostné záznamy slúžia na poskytovanie zvolených funkcií a ochranu služby.</p>
      <h2>Uchovávanie</h2>
      <p>Bežný bloček bez sledovania: najviac 7 dní. Sledovaný doklad: do nastaveného konca sledovania plus 6 mesiacov. Technické spracovateľské údaje: spravidla 30 dní. Finančné transakcie zostávajú počas existencie účtu. Po výslovnej žiadosti o výmaz nasleduje 30-dňová lehota na zrušenie žiadosti.</p>
      <h2>Externé služby a zálohy</h2>
      <p>Podľa použitej funkcie sa zapájajú Telegram, Supabase, Render, OpenAI, eKasa, Resend a AWS zálohy. Konkrétne podmienky spracovateľov a medzinárodných prenosov ešte vyžadujú overenie prevádzkovateľom.</p>
      <h2>Prístup, export a výmaz</h2>
      <p>Po overenom webovom prihlásení je možné požiadať o export vlastných údajov alebo o výmaz účtu vo webovom prehľade. Kompletný export a doklady sa neposielajú cez Telegram. Pri zdieľanom účte zostávajú údaje ostatných členov zachované.</p>
      <p>Kontakt na otázky a žiadosti: <strong>doplniť pred verejným spustením</strong>.</p>
    </article>
  </main>;
}
