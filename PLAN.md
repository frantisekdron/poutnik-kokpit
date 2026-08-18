# POUTNÍK KOKPIT — plán akce

**Cíl:** jeden dashboard pro půjčovnu (4 vozy + střešní stan), který je zdrojem pravdy
o vozech, penězích a rezervacích, napojitelný na web poutnik.lovable.app (Supabase).

## Architektura
- **Appka:** statická SPA na GitHub Pages → `frantisekdron.github.io/poutnik-kokpit`
- **Databáze:** privátní repo `frantisekdron/poutnik-data` (JSON), zápis přes GitHub
  Contents API — každá změna = commit (vidíme kdo/kdy, nic se neztratí)
- **Přístup:** heslo → AES-GCM dešifruje jemný PAT (jen poutnik-data). Dva uživatelé
  (Franta + parťák), každý zápis podepsaný.
- **Web:** Lovable/Supabase — kokpit čte `bookings` (poptávky z webu) a hlídá,
  že `vehicles` na webu odpovídá skutečné flotile (generuje prompt pro Lovable).
- **Monitoring:** odhad km z rezervací kalibrovaný zápisy tachometru; připraveno
  napojení Traccar (levné 4G GPS krabičky) → pak skutečná poloha + km živě.

## Sekce (7, žádné další)
Přehled (kontrolky+odhad km+doporučení) · Vozy (vybavení, leasing, pojištění,
serviska+dokumenty, tachometr, milníky) · Kalendář (lajny obsazenosti, stavy
poptávka→potvrzeno→vydáno→vráceno) · Finance (P&L na vůz, utilizace, break-even,
investice parťáků) · Marketing (útraty, odkazy, výsledky, CAC) · Kontakty · Úkoly

## Role a úkoly (kdo co dělá při stavbě)
- **Manažer (orchestrátor):** drží zadání, skládá výsledek, rozhoduje spory auditorů.
- **Provozní projektu:** repa, seed dat, šifrování přístupu, Pages, nasazení.
- **Dělníci (stavba):** datový model → GH vrstva → sekce UI → výpočty (km odhad,
  P&L, doporučení) → Supabase most → uploady dokumentů.
- **Auditoři:** (1) logika souběhu a mutací, (2) bezpečnost (krypto, brána, PAT),
  (3) shoda se zadáním — každá věc ze zadání má místo v UI.
- **Ověřovači:** klikací test v prohlížeči (login, CRUD všude, kalendář, mobil),
  test proti testovací větvi dat, až pak ostrá data.

## Provozní RACI (Franta × parťák) — po spuštění
- Denně: nové poptávky z webu potvrdit/odmítnout · vydání+vrácení vozu = zapsat km
- Týdně: úkoly na autech, marketing útraty, odpovědi kontaktům
- Měsíčně: kontrola leasingů/pojistek (kokpit hlídá termíny), P&L pohled, ceny dle
  utilizace (kokpit doporučí), zápis investic
- Kdykoliv: servis → hned do servisky s fotkou účtenky

## GPS monitoring — nákup (doporučení)
- 4× **SinoTrack ST-901L / ST-906L (4G LTE)** ~700–900 Kč/ks (AliExpress) — napevno na 12V
- SIM: levný datový tarif (BLESKmobil/Kaktus, ~30–50 Kč/měs/auto, stačí 50 MB)
- Platforma: **Traccar** (open-source, zdarma) — kokpit má na něj připravené napojení
  (URL+token v Nastavení). Do té doby běží chytrý odhad km.
