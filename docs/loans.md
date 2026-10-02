# Pôžičky

Telegram prijíma napríklad `Požičal som Janovi 150 €`, `Jano mi vrátil 50 €`,
`Požičal som si od Martina 300 €`, `Martinovi som vrátil 100 €`,
`Kto mi dlhuje?` a `Komu dlhujem?`. Ak chýba meno alebo existuje viac
rovnako pravdepodobných otvorených osôb, bot si vypýta len túto informáciu.
Rozpracovaná otázka platí 15 minút. Preplatok sa nikdy nezapíše automaticky.

Každé poskytnutie alebo prijatie vytvorí samostatnú pôžičku a `transfer`
transakciu. Každá splátka vytvorí ďalší pohyb a alokácie na otvorené pôžičky
danej osoby, smeru a meny. Splátka sa vždy priraďuje najstaršej otvorenej
pôžičke ako prvej (`opened_at`, potom UUID). Zostatok je pôvodná suma mínus
splatená suma; databáza ho nedovolí znížiť pod nulu. Stav sa v prehľadoch
agreguje po osobe, smere a mene. Rôzne meny sa nesčítajú.

Posledný pohyb možno zrušiť po potvrdení v Telegrame. Pôvodnú pôžičku s už
naviazanými splátkami bot nezruší; taká oprava vyžaduje kontrolu podpory.
Oprava posledného nepreviazaného pohybu používa zrušenie a nové zapísanie.
Termín splatnosti sa ukladá a zobrazuje, bez nového systému pripomienok.

Týždenný a mesačný report zobrazujú aktuálne otvorené zostatky. Ak nie je
otvorená pôžička, sekcia sa nevytvorí. Pohyby majú typ `transfer` a nevstupujú
do bežných súčtov príjmov a výdavkov. Migrácia musí predchádzať nasadeniu API.

Údaje sú dostupné iba serverovej roli. Export obsahuje vlastné pôžičky a
pohyby v aktívnych workspaceoch. Výmaz výlučného workspace zmaže aj evidenciu
pôžičiek; pri odchode zo zdieľaného workspace zostáva spoločná finančná
história a zmaže sa rozpracovaný chatový stav odchádzajúceho člena.
