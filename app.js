/* ============================================================
   POUTNÍK KOKPIT — půjčovna expedičních vozů
   Flotila + kalendář + finance + marketing + kontakty + úkoly.

   Data leží v privátním repu poutnik-data na GitHubu, každá
   změna je commit — je vidět kdo a kdy, nic se neztratí.
   ============================================================ */

const $  = (s, k = document) => k.querySelector(s);
const $$ = (s, k = document) => [...k.querySelectorAll(s)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pauza = (ms) => new Promise((r) => setTimeout(r, ms));
const nyni = () => new Date().toISOString();
const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 9);

/* Dnešek v Praze jako 2026-08-18 — ať kalendář sedí i z ciziny. */
const dnesISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());

const dtDen = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
const dtKratce = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric' });
const MESICE = ['leden','únor','březen','duben','květen','červen','červenec','srpen','září','říjen','listopad','prosinec'];

function denCesky(datum) {
  if (!datum) return '';
  const d = new Date(datum + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? datum : dtDen.format(d);
}
function denKratce(datum) {
  if (!datum) return '';
  const d = new Date(datum + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? datum : dtKratce.format(d);
}
function kdyKratce(iso) {
  const d = new Date(iso);
  const min = (Date.now() - d.getTime()) / 60000;
  if (min < 1) return 'právě teď';
  if (min < 60) return `před ${Math.floor(min)} min`;
  if (min < 1440) return `před ${Math.floor(min / 60)} h`;
  if (min < 2880) return 'včera';
  if (min < 10080) return `před ${Math.floor(min / 1440)} dny`;
  return dtKratce.format(d);
}

const fmtKc = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
const kc = (n) => (n == null || n === '' || Number.isNaN(+n)) ? '—' : fmtKc.format(Math.round(+n)) + ' Kč';
const cislo = (n) => (n == null || n === '' || Number.isNaN(+n)) ? null : +n;

/* Počet dní rezervace: od–do včetně obou = do-od dní půjčovného (vrácení ráno),
   ale blokované jsou v kalendáři oba dny. Účtujeme počet nocí, minimálně 1. */
function dniRez(od, doD) {
  const a = new Date(od + 'T12:00:00'), b = new Date(doD + 'T12:00:00');
  return Math.max(1, Math.round((b - a) / 86400000));
}
function pridejDni(datum, n) {
  const d = new Date(datum + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const iniciely = (jmeno) => String(jmeno || '?').split(/\s+/).slice(0, 2).map((s) => s[0] || '').join('').toUpperCase();

/* ---------------------------------------------------------- odemčení */

const b64naBajty = (b64) => Uint8Array.from(atob(String(b64).replace(/\s+/g, '')), (c) => c.charCodeAt(0));
function bajtyNaB64(bajty) {
  let bin = '';
  for (let i = 0; i < bajty.length; i += 0x8000) bin += String.fromCharCode.apply(null, bajty.subarray(i, i + 0x8000));
  return btoa(bin);
}
const textNaB64 = (s) => bajtyNaB64(new TextEncoder().encode(s));
const b64NaText = (b) => new TextDecoder().decode(b64naBajty(b));

async function desifruj(blobB64, heslo) {
  const raw = b64naBajty(blobB64);
  const zaklad = await crypto.subtle.importKey('raw', new TextEncoder().encode(heslo), 'PBKDF2', false, ['deriveKey']);
  const klic = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: raw.slice(0, 16), iterations: CFG.iterace || 600000, hash: 'SHA-256' },
    zaklad, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(16, 28) }, klic, raw.slice(28)));
}

/* Otisk klíče z config.js — po výměně klíče přestane uložené
   přihlášení platit a kokpit si řekne o heslo znovu. */
const otiskKlicu = () => Object.values(CFG.blobs || {}).map((b) => String(b || '').slice(-32)).join('|');

async function odemkni(heslo) {
  for (const blob of Object.values(CFG.blobs || {})) {
    if (!blob) continue;
    try {
      const token = await desifruj(blob, heslo);
      if (/^(github_pat_|ghp_|gho_)/.test(token)) return token.trim();
    } catch { /* špatné heslo */ }
  }
  return null;
}

/* ---------------------------------------------------------- GitHub */

const SOUBORY = {
  vozy: 'data/vozy.json',
  rezervace: 'data/rezervace.json',
  kontakty: 'data/kontakty.json',
  ukoly: 'data/ukoly.json',
  finance: 'data/finance.json',
  nastaveni: 'data/nastaveni.json',
};

const GH = {
  token: null,
  etag: {},
  mezipamet: {},

  volej: (cesta, nastaveni = {}) => fetch('https://api.github.com' + cesta, {
    cache: 'no-store',
    ...nastaveni,
    headers: {
      Authorization: 'Bearer ' + GH.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(nastaveni.headers || {}),
    },
  }),

  cesta: (soubor) => `/repos/${CFG.owner}/${CFG.repo}/contents/${soubor}`,

  async chyba(r) {
    if (r.status === 401) return 'Přístupový klíč vypršel nebo byl zrušen. Vyrob nový přes nastav_pristup.py.';
    if (r.status === 403 || r.status === 404) {
      const potize = await GH.procNejde();
      if (potize) return potize;
    }
    let detail = '';
    try { detail = (await r.json()).message || ''; } catch {}
    return `GitHub vrátil chybu ${r.status}. ${detail}`;
  },
  async selhalo(r) {
    const e = new Error(await GH.chyba(r));
    e.stav = r.status;
    return e;
  },
  async procNejde() {
    try {
      const r = await GH.volej(`/repos/${CFG.owner}/${CFG.repo}`);
      if (r.status === 404) return `Přístupový klíč nevidí repozitář ${CFG.owner}/${CFG.repo}. V nastavení klíče na GitHubu musí být pod Repository access vybraný právě tenhle repozitář.`;
      if (!r.ok) return null;
      const repo = await r.json();
      if (repo.permissions && !repo.permissions.push) return 'Přístupový klíč umí data jen číst, ne zapisovat. Na GitHubu přepni Repository permissions → Contents na „Read and write".';
      return null;
    } catch { return null; }
  },

  async nacti(soubor, { podminene = false } = {}) {
    const hlavicky = {};
    if (podminene && GH.etag[soubor]) hlavicky['If-None-Match'] = GH.etag[soubor];
    const r = await GH.volej(`${GH.cesta(soubor)}?ref=${CFG.branch}`, { headers: hlavicky });
    if (r.status === 304) return { zmeneno: false };
    if (!r.ok) throw await GH.selhalo(r);
    const et = r.headers.get('etag');
    if (et) GH.etag[soubor] = et;
    const j = await r.json();
    const data = JSON.parse(b64NaText(j.content));
    GH.mezipamet[soubor] = { data, sha: j.sha };
    return { zmeneno: true, data, sha: j.sha };
  },

  /* Zápis odolný proti souběhu: když mezitím uložil parťák, stáhneme
     jeho verzi a naši změnu pustíme znovu na ni. Mutátory proto musí
     hledat podle ID, nikdy podle indexu. */
  async zmen(soubor, uprav, zprava) {
    for (let pokus = 0; pokus < 6; pokus++) {
      let ulozene = GH.mezipamet[soubor];
      if (pokus > 0 || !ulozene) {
        const v = await GH.nacti(soubor);
        ulozene = { data: v.data, sha: v.sha };
      }
      const kopie = structuredClone(ulozene.data);
      uprav(kopie);
      kopie.zmeneno = nyni();
      kopie.zmenil = JA.jmeno;

      const telo = { message: zprava, content: textNaB64(JSON.stringify(kopie, null, 2)), branch: CFG.branch, sha: ulozene.sha };
      const r = await GH.volej(GH.cesta(soubor), { method: 'PUT', body: JSON.stringify(telo) });

      if (r.ok) {
        const j = await r.json();
        delete GH.etag[soubor];
        GH.mezipamet[soubor] = { data: kopie, sha: j.content.sha };
        return kopie;
      }
      if (r.status !== 409 && r.status !== 422) throw await GH.selhalo(r);
      await pauza(250 * (pokus + 1));
    }
    throw new Error('Nepovedlo se uložit — parťák právě ukládá to samé. Zkus to za chvíli.');
  },

  /* Dokumenty a fotky: binárka do privátního repa. */
  async nahrajSoubor(cesta, base64, zprava) {
    const r = await GH.volej(GH.cesta(cesta), {
      method: 'PUT',
      body: JSON.stringify({ message: zprava, content: base64, branch: CFG.branch }),
    });
    if (!r.ok) throw await GH.selhalo(r);
    return (await r.json()).content.sha;
  },
  async stahniSoubor(cesta) {
    const r = await GH.volej(`${GH.cesta(cesta)}?ref=${CFG.branch}`, { headers: { Accept: 'application/vnd.github.raw' } });
    if (!r.ok) throw await GH.selhalo(r);
    return r.blob();
  },
  async smazSoubor(cesta, zprava) {
    const r0 = await GH.volej(`${GH.cesta(cesta)}?ref=${CFG.branch}`);
    if (r0.status === 404) return;
    if (!r0.ok) throw await GH.selhalo(r0);
    const { sha } = await r0.json();
    const r = await GH.volej(GH.cesta(cesta), {
      method: 'DELETE',
      body: JSON.stringify({ message: zprava, sha, branch: CFG.branch }),
    });
    if (!r.ok) throw await GH.selhalo(r);
  },
};

/* ---------------------------------------------------------- demo režim */

const DEMO = new URLSearchParams(location.search).has('demo');

function zapniDemo() {
  const D = structuredClone(window.DEMO_DATA);
  GH.nacti = async (soubor) => ({ zmeneno: true, data: D[soubor], sha: 'demo' });
  GH.zmen = async (soubor, uprav) => {
    const kopie = structuredClone(D[soubor]);
    uprav(kopie);
    kopie.zmeneno = nyni();
    kopie.zmenil = JA.jmeno;
    D[soubor] = kopie;
    GH.mezipamet[soubor] = { data: kopie, sha: 'demo' };
    return kopie;
  };
  GH.nahrajSoubor = async () => 'demo';
  GH.stahniSoubor = async () => new Blob(['demo'], { type: 'text/plain' });
  GH.smazSoubor = async () => {};
  $('#demo-prouzek').classList.remove('skryto');
}

/* ---------------------------------------------------------- stav */

const JA = { jmeno: null };
const S = {
  vozy: [], rezervace: [], kontakty: [], ukoly: [],
  finance: { marketing: [], investice: [], odkazy: [] },
  nastaveni: { partneri: ['Franta', 'Parťák'], kmDenOdhad: 140, sazbaHodina: 300, traccar: {}, supabase: {} },
};
const UI = {
  zalozka: localStorage.getItem('poutnik.zalozka') || 'prehled',
  ukladam: 0,
  kalMesic: dnesISO().slice(0, 7),          // "2026-08"
  finObdobi: localStorage.getItem('poutnik.finobdobi') || '90',
  ukolFiltr: 'otevreny',
  hledatKontakt: '',
  otevreno: null,                            // {typ:'vuz'|'rezervace'|..., id, pod?}
};

const vuz = (id) => S.vozy.find((v) => v.id === id);
const kontakt = (id) => S.kontakty.find((k) => k.id === id);
const rezervaceVozu = (vid) => S.rezervace.filter((r) => (r.vozy || []).includes(vid) && r.stav !== 'zruseno');

function prevezmi(soubor, data) {
  if (soubor === SOUBORY.vozy) S.vozy = data.vozy || [];
  else if (soubor === SOUBORY.rezervace) S.rezervace = data.polozky || [];
  else if (soubor === SOUBORY.kontakty) S.kontakty = data.polozky || [];
  else if (soubor === SOUBORY.ukoly) S.ukoly = data.polozky || [];
  else if (soubor === SOUBORY.finance) S.finance = { marketing: [], investice: [], odkazy: [], ...data };
  else if (soubor === SOUBORY.nastaveni) S.nastaveni = { ...S.nastaveni, ...data };
}

async function nactiVse() {
  await Promise.all(Object.values(SOUBORY).map(async (soubor) => {
    const v = await GH.nacti(soubor);
    if (v.zmeneno) prevezmi(soubor, v.data);
  }));
}

let synchronizace = null;
function spustSynchronizaci() {
  if (DEMO || synchronizace) return;
  synchronizace = setInterval(async () => {
    if (document.hidden || UI.ukladam) return;
    try {
      let neco = false;
      for (const soubor of Object.values(SOUBORY)) {
        const v = await GH.nacti(soubor, { podminene: true });
        if (v.zmeneno) { prevezmi(soubor, v.data); neco = true; }
      }
      if (neco) vykresli();
    } catch { /* offline apod. — příště */ }
  }, 25000);
}

/* ---------------------------------------------------------- hlášky */

function hlaska(text, druh = '') {
  const e = document.createElement('div');
  e.className = 'hlaska ' + druh;
  e.innerHTML = `<svg class="icon"><use href="#${druh === 'chyba' ? 'i-krizek' : 'i-fajfka'}"/></svg><span>${esc(text)}</span>`;
  $('#hlasky').append(e);
  setTimeout(() => e.remove(), druh === 'chyba' ? 6500 : 2400);
}

async function uloz(zprava, soubor, uprav) {
  UI.ukladam++;
  $('#btn-obnovit').classList.add('tocise');
  try {
    await GH.zmen(soubor, uprav, zprava);
    prevezmi(soubor, GH.mezipamet[soubor].data);
    vykresli();
    return true;
  } catch (e) {
    /* Po neúspěchu zahodit ETag, jinak by synchronizace dostala 304
       a appka by zůstala viset na starých datech. */
    delete GH.etag[soubor];
    hlaska(e.message || 'Uložení se nepovedlo.', 'chyba');
    return false;
  } finally {
    UI.ukladam--;
    if (!UI.ukladam) $('#btn-obnovit').classList.remove('tocise');
  }
}

/* Změna jednoho vozu / jedné položky podle ID — bezpečné i po sloučení s cizí verzí. */
const ulozVuz = (zprava, id, fn) =>
  uloz(zprava, SOUBORY.vozy, (d) => { const v = (d.vozy || []).find((x) => x.id === id); if (v) fn(v); });
const ulozPolozku = (zprava, soubor, id, fn) =>
  uloz(zprava, soubor, (d) => { const p = (d.polozky || []).find((x) => x.id === id); if (p) fn(p); });

/* ============================================================
   VÝPOČTY — odhad km, kontrolky, finance, doporučení
   ============================================================ */

/* Kolik km denně vůz reálně najede — kalibrováno z rezervací,
   které mají zapsané km před i po. Jinak odhad z nastavení. */
function kmNaDen(v) {
  const vzorky = rezervaceVozu(v.id)
    .filter((r) => cislo(r.kmPred) != null && cislo(r.kmPo) != null && r.kmPo > r.kmPred)
    .map((r) => (r.kmPo - r.kmPred) / dniRez(r.od, r.do));
  if (!vzorky.length) return S.nastaveni.kmDenOdhad || 140;
  return vzorky.reduce((a, b) => a + b, 0) / vzorky.length;
}

/* Poslední zapsaný stav tachometru. */
function posledniTacho(v) {
  const t = [...(v.tachometr || [])].sort((a, b) => (b.datum || '').localeCompare(a.datum || ''));
  return t[0] || null;
}

/* Odhad dnešního stavu km: poslední zápis + km z rezervací po něm.
   U běžící výpůjčky se počítají dny do dneška. */
function odhadKm(v) {
  const posl = posledniTacho(v);
  if (!posl || cislo(posl.km) == null) return { km: null, presne: false, od: null };
  const dnes = dnesISO();
  const denniKm = kmNaDen(v);
  let km = +posl.km;
  let presne = true;
  for (const r of rezervaceVozu(v.id)) {
    if (r.stav !== 'vydano' && r.stav !== 'vraceno') continue;
    const zacatek = r.od > posl.datum ? r.od : null;
    if (!zacatek) continue;                       // jízda už je v posledním zápisu
    if (cislo(r.kmPred) != null && cislo(r.kmPo) != null) {
      km = Math.max(km, +r.kmPo);                 // skutečnost má přednost
    } else {
      const konec = r.stav === 'vydano' ? (dnes < r.do ? dnes : r.do) : r.do;
      km += denniKm * dniRez(r.od, konec);
      presne = false;
    }
  }
  return { km: Math.round(km), presne, od: posl.datum };
}

/* Vůz dnes: volný / na cestě / rezervace dnes začíná. */
function stavDnes(v) {
  const dnes = dnesISO();
  const bezici = rezervaceVozu(v.id).find((r) => r.stav === 'vydano' && r.od <= dnes && dnes <= r.do);
  if (bezici) return { druh: 'vydano', text: 'na cestě do ' + denKratce(bezici.do), rez: bezici };
  const dnesni = rezervaceVozu(v.id).find((r) => (r.stav === 'potvrzeno' || r.stav === 'poptavka') && r.od <= dnes && dnes <= r.do);
  if (dnesni) return { druh: dnesni.stav, text: (dnesni.stav === 'potvrzeno' ? 'vydat — rezervace běží' : 'poptávka na dnešek'), rez: dnesni };
  const pristi = rezervaceVozu(v.id).filter((r) => r.stav !== 'vraceno' && r.od > dnes).sort((a, b) => a.od.localeCompare(b.od))[0];
  if (pristi) return { druh: 'volny', text: 'volný, další ' + denKratce(pristi.od), rez: null };
  return { druh: 'volny', text: 'volný', rez: null };
}

const LAMPY = { volny: 'var(--zelena)', vydano: 'var(--amber)', potvrzeno: 'var(--amber)', poptavka: 'var(--amber)' };

/* ---------------------------------------------------------- kontrolky */

function dniDo(datum) {
  if (!datum) return null;
  return Math.round((new Date(datum + 'T12:00:00') - new Date(dnesISO() + 'T12:00:00')) / 86400000);
}

/* Všechna upozornění nad daty. Druhy: hori (červená) / varuje (jantar) / info. */
function kontrolky() {
  const vysledek = [];
  const dnes = dnesISO();

  for (const v of S.vozy.filter((x) => x.aktivni !== false)) {
    const est = odhadKm(v);

    for (const m of v.milniky || []) {
      if (m.typ === 'datum' && m.hodnota) {
        const za = dniDo(m.hodnota);
        if (za < 0) vysledek.push({ druh: 'hori', vuz: v, text: `${m.nazev} propadl${za < -1 ? 'o' : ''} ${denCesky(m.hodnota)}` });
        else if (za <= 30) vysledek.push({ druh: 'varuje', vuz: v, text: `${m.nazev} za ${za} dní (${denCesky(m.hodnota)})` });
      }
      if (m.typ === 'km' && cislo(m.hodnota) != null && est.km != null) {
        const zbyva = m.hodnota - est.km;
        if (zbyva <= 0) vysledek.push({ druh: 'hori', vuz: v, text: `${m.nazev}: mělo být v ${fmtKc.format(m.hodnota)} km, odhad je ${fmtKc.format(est.km)} km` });
        else if (zbyva <= 1000) vysledek.push({ druh: 'varuje', vuz: v, text: `${m.nazev} za ~${fmtKc.format(zbyva)} km` });
      }
    }
    for (const p of v.pojisteni || []) {
      const za = dniDo(p.platiDo);
      if (za != null && za < 0) vysledek.push({ druh: 'hori', vuz: v, text: `${p.druh} propadlo ${denCesky(p.platiDo)}` });
      else if (za != null && za <= 30) vysledek.push({ druh: 'varuje', vuz: v, text: `${p.druh} končí za ${za} dní` });
    }
    const l = v.leasing || {};
    if (cislo(l.denSplatky) != null && cislo(l.mesicniSplatka) != null) {
      const den = +dnes.slice(8, 10);
      const za = (l.denSplatky - den + 31) % 31;
      if (za <= 3) vysledek.push({ druh: 'info', vuz: v, text: `Splátka leasingu ${kc(l.mesicniSplatka)} ${za === 0 ? 'dnes' : 'za ' + za + ' dny'} (${l.spolecnost || '—'})` });
    }
    if (!posledniTacho(v) && v.typ !== 'stan') vysledek.push({ druh: 'info', vuz: v, text: 'Chybí první zápis tachometru' });
  }

  for (const r of S.rezervace) {
    if (r.stav === 'poptavka') {
      const stari = (Date.now() - new Date(r.vytvoreno || dnes).getTime()) / 3600000;
      if (stari > 48) vysledek.push({ druh: 'varuje', rez: r, text: `Poptávka ${jmenoRez(r)} čeká ${Math.floor(stari / 24)} dní na odpověď` });
    }
    if (r.stav === 'potvrzeno' && r.od < dnes) vysledek.push({ druh: 'varuje', rez: r, text: `Rezervace ${jmenoRez(r)} měla začít ${denCesky(r.od)} — vydat vůz?` });
    if (r.stav === 'vydano' && r.do < dnes) vysledek.push({ druh: 'varuje', rez: r, text: `${jmenoRez(r)} měl vrátit ${denCesky(r.do)} — vrátit a zapsat km` });
  }

  for (const k of konflikty()) {
    vysledek.push({ druh: 'hori', text: `KONFLIKT: ${vuz(k.vid)?.nazev || '?'} má překryv ${denKratce(k.a.od)}–${denKratce(k.a.do)} × ${denKratce(k.b.od)}–${denKratce(k.b.do)}` });
  }

  const poradi = { hori: 0, varuje: 1, info: 2 };
  return vysledek.sort((a, b) => poradi[a.druh] - poradi[b.druh]);
}

function jmenoRez(r) {
  const k = kontakt(r.kontakt);
  return k?.jmeno || r.jmeno || 'bez jména';
}

/* Překryvy potvrzených/vydaných rezervací na stejném voze. */
function konflikty() {
  const zle = [];
  for (const v of S.vozy) {
    const rez = rezervaceVozu(v.id).filter((r) => r.stav === 'potvrzeno' || r.stav === 'vydano');
    for (let i = 0; i < rez.length; i++) for (let j = i + 1; j < rez.length; j++) {
      const a = rez[i], b = rez[j];
      if (a.od < b.do && b.od < a.do) zle.push({ vid: v.id, a, b });
    }
  }
  return zle;
}

/* ---------------------------------------------------------- finance */

function obdobiRozsah() {
  const dnes = dnesISO();
  const dny = { 30: 30, 90: 90, 365: 365 }[UI.finObdobi];
  if (UI.finObdobi === 'vse') return { od: '2000-01-01', do: dnes, dnu: null };
  if (UI.finObdobi === 'rok') return { od: dnes.slice(0, 4) + '-01-01', do: dnes, dnu: dniRez(dnes.slice(0, 4) + '-01-01', dnes) };
  return { od: pridejDni(dnes, -dny), do: dnes, dnu: dny };
}

/* P&L jednoho vozu za období. Výnos = rezervace, jejichž začátek padne
   do období (vydané+vrácené = jisté, potvrzené zvlášť jako nasmlouvané). */
function plVozu(v, rozsah) {
  const rez = rezervaceVozu(v.id).filter((r) => r.od >= rozsah.od && r.od <= rozsah.do);
  const jiste = rez.filter((r) => r.stav === 'vydano' || r.stav === 'vraceno');
  const nasmlouvane = rez.filter((r) => r.stav === 'potvrzeno');
  /* Cena rezervace se stanem/vozem napůl nedělí — počítá se vozu, stan má svoje. */
  const vynos = jiste.reduce((a, r) => a + (cislo(r.castka) || 0) / (r.vozy?.length || 1), 0);
  const vynosNasml = nasmlouvane.reduce((a, r) => a + (cislo(r.castka) || 0) / (r.vozy?.length || 1), 0);

  const mesicu = (rozsah.dnu || dniRez(rozsah.od, rozsah.do)) / 30.44;
  const l = v.leasing || {};
  const leasing = (cislo(l.mesicniSplatka) || 0) * mesicu;
  const pojistky = (v.pojisteni || []).reduce((a, p) => a + (cislo(p.rocne) || 0), 0) / 12 * mesicu;
  const servis = (v.servis || []).filter((s) => s.datum >= rozsah.od && s.datum <= rozsah.do)
    .reduce((a, s) => a + (cislo(s.cena) || 0), 0);

  const dnuCelkem = rozsah.dnu || dniRez(rozsah.od, rozsah.do);
  let obsazeno = 0;
  for (const r of rez.filter((x) => x.stav !== 'poptavka')) {
    const od = r.od > rozsah.od ? r.od : rozsah.od;
    const doD = r.do < rozsah.do ? r.do : rozsah.do;
    if (od <= doD) obsazeno += dniRez(od, doD);
  }
  const fixniMesic = (cislo(l.mesicniSplatka) || 0) + (v.pojisteni || []).reduce((a, p) => a + (cislo(p.rocne) || 0), 0) / 12;

  return {
    vynos, vynosNasml, leasing, pojistky, servis,
    naklady: leasing + pojistky + servis,
    marze: vynos - (leasing + pojistky + servis),
    obsazeno, dnuCelkem,
    utilizace: dnuCelkem ? obsazeno / dnuCelkem : 0,
    breakEvenDnu: v.cenaDen ? fixniMesic / v.cenaDen : null,
    fixniMesic,
  };
}

function marketingV(rozsah) {
  return (S.finance.marketing || []).filter((m) => m.datum >= rozsah.od && m.datum <= rozsah.do)
    .reduce((a, m) => a + (cislo(m.castka) || 0), 0);
}

function hodnotaInvestice(i) {
  if (i.typ === 'cas') return (cislo(i.hodiny) || 0) * (S.nastaveni.sazbaHodina || 0);
  return cislo(i.castka) || 0;
}

/* ---------------------------------------------------------- doporučení */

function doporuceni() {
  const rady = [];
  const rozsah = { od: pridejDni(dnesISO(), -90), do: dnesISO(), dnu: 90 };

  for (const v of S.vozy.filter((x) => x.aktivni !== false)) {
    const pl = plVozu(v, rozsah);
    if (pl.utilizace >= 0.7) rady.push({ vuz: v, text: `obsazenost ${Math.round(pl.utilizace * 100)} % za 90 dní — trh by unesl cenu o ~10 % výš (teď ${kc(v.cenaDen)}/den)` });
    else if (pl.utilizace > 0 && pl.utilizace < 0.2) rady.push({ vuz: v, text: `obsazenost jen ${Math.round(pl.utilizace * 100)} % — zvaž akční cenu mimo sezónu, balíček se stanem nebo víc fotek v inzerátu` });
    if (pl.fixniMesic > 0 && pl.breakEvenDnu != null) {
      const skutecnychDnu = pl.obsazeno / 3;   // za měsíc průměrně
      if (skutecnychDnu < pl.breakEvenDnu) rady.push({ vuz: v, text: `pod break-even: fixní náklady ${kc(pl.fixniMesic)}/měs = ${Math.ceil(pl.breakEvenDnu)} dní pronájmu, reálně jede ${Math.round(skutecnychDnu)} dní/měs` });
    }
    const rezBez = rezervaceVozu(v.id).filter((r) => r.stav === 'vraceno' && (cislo(r.kmPred) == null || cislo(r.kmPo) == null));
    if (rezBez.length) rady.push({ vuz: v, text: `${rezBez.length}× vráceno bez zapsaných km — odhad kilometrů se nemá z čeho učit` });
  }

  const stan = S.vozy.find((v) => v.typ === 'stan');
  if (stan) {
    const sAuty = S.rezervace.filter((r) => r.stav !== 'zruseno' && (r.vozy || []).some((id) => (stan.naVozy || []).includes(id)));
    const seStanem = sAuty.filter((r) => (r.vozy || []).includes(stan.id));
    if (sAuty.length >= 3 && seStanem.length / sAuty.length < 0.3)
      rady.push({ vuz: stan, text: `stan jel jen s ${seStanem.length} z ${sAuty.length} kompatibilních rezervací — nabízej ho aktivně při potvrzení (${kc(stan.cenaDen)}/den navíc)` });
  }

  const utrata30 = marketingV({ od: pridejDni(dnesISO(), -30), do: dnesISO() });
  const zWebu30 = S.rezervace.filter((r) => r.zdroj === 'web' && (r.vytvoreno || '').slice(0, 10) >= pridejDni(dnesISO(), -30)).length;
  if (utrata30 > 0 && zWebu30 === 0) rady.push({ text: `za 30 dní utraceno ${kc(utrata30)} za reklamu, ale žádná poptávka z webu — zkontroluj měření a kam vedou kampaně` });
  if (utrata30 > 0 && zWebu30 > 0) rady.push({ text: `poptávka z webu vychází na ${kc(utrata30 / zWebu30)} (${zWebu30} poptávek / ${kc(utrata30)} za 30 dní)` });

  return rady;
}

/* ============================================================
   VYKRESLENÍ
   ============================================================ */

const ZALOZKY = [
  { id: 'prehled',   nazev: 'Přehled',   ikona: 'i-poloha' },
  { id: 'vozy',      nazev: 'Vozy',      ikona: 'i-auto' },
  { id: 'kalendar',  nazev: 'Kalendář',  ikona: 'i-kalendar' },
  { id: 'finance',   nazev: 'Finance',   ikona: 'i-penize' },
  { id: 'marketing', nazev: 'Marketing', ikona: 'i-megafon' },
  { id: 'kontakty',  nazev: 'Kontakty',  ikona: 'i-lide' },
  { id: 'ukoly',     nazev: 'Úkoly',     ikona: 'i-ukol' },
];

function vykresli() {
  if ($('#app').classList.contains('skryto')) return;

  const pocty = {
    kalendar: S.rezervace.filter((r) => r.stav === 'poptavka').length,
    ukoly: S.ukoly.filter((u) => u.stav !== 'hotovy').length,
  };
  $('#zalozky').innerHTML = ZALOZKY.map((z) => `
    <button class="zalozka" role="tab" data-z="${z.id}" aria-selected="${String(z.id === UI.zalozka)}">
      <svg class="icon"><use href="#${z.ikona}"/></svg>${z.nazev}
      ${pocty[z.id] ? `<span class="pocet">${pocty[z.id]}</span>` : ''}
    </button>`).join('');

  const varovani = kontrolky().filter((k) => k.druh !== 'info');
  const zp = $('#zvon-pocet');
  zp.textContent = varovani.length;
  zp.classList.toggle('skryto', !varovani.length);

  $('#ja-inic').textContent = iniciely(JA.jmeno);
  $('#ja-jmeno').textContent = JA.jmeno || '';

  const kresli = {
    prehled: kresliPrehled, vozy: kresliVozy, kalendar: kresliKalendar,
    finance: kresliFinance, marketing: kresliMarketing, kontakty: kresliKontakty, ukoly: kresliUkoly,
  }[UI.zalozka] || kresliPrehled;
  $('#plocha').innerHTML = kresli();

  if (UI.otevreno) kresliSuplik();
}

const lampaHtml = (barva) => `<span class="lampa" style="color:${barva};background:${barva}"></span>`;

function odoHtml(km, presne) {
  if (km == null) return '<span class="odo"><span class="odo-km">— zapiš tachometr</span></span>';
  const s = String(km).padStart(6, '0');
  return `<span class="odo" title="${presne ? 'poslední zapsaný stav' : 'odhad z rezervací'}">${
    [...s].map((c, i) => `<i class="${i < 3 ? 'tis' : ''}">${c}</i>`).join('')
  }<span class="odo-km">km${presne ? '' : ' ~'}</span></span>`;
}

/* ---------------------------------------------------------- PŘEHLED */

function kresliPrehled() {
  const dnes = dnesISO();
  const vsechny = kontrolky();
  const rady = doporuceni();
  const rozsah = { od: pridejDni(dnes, -30), do: dnes, dnu: 30 };
  const vynos30 = S.vozy.reduce((a, v) => a + plVozu(v, rozsah).vynos, 0);
  const poptavky = S.rezervace.filter((r) => r.stav === 'poptavka');

  return `
  <section class="sekce">
    <div class="sekce-hl">
      <h2>Flotila dnes — ${denCesky(dnes)}</h2>
      <div class="mezera"></div>
      <span class="stitek">výnos 30 dní: <b style="color:var(--zelena)">&nbsp;${kc(vynos30)}</b></span>
      ${poptavky.length ? `<span class="stitek" style="color:var(--amber);border-color:var(--amber-tm)">${poptavky.length} nových poptávek</span>` : ''}
    </div>

    <div class="flotila">
      ${S.vozy.filter((v) => v.aktivni !== false).map((v) => {
        const st = stavDnes(v);
        const est = odhadKm(v);
        const varov = vsechny.filter((k) => k.vuz?.id === v.id && k.druh !== 'info');
        return `
        <button class="vuz-instr" style="--vb:${v.barva}" data-otevri-vuz="${v.id}">
          <div class="vi-hl">
            ${lampaHtml(LAMPY[st.druh] || 'var(--khaki)')}
            <b>${esc(v.nazev)}</b>
            <span class="vi-stav">${esc(st.text)}</span>
          </div>
          <div class="vi-telo">
            ${v.typ === 'stan' ? `<span class="stitek">půjčuje se i samostatně</span>` : odoHtml(est.km, est.presne)}
            <span class="stitek">${kc(v.cenaDen)}/den</span>
          </div>
          ${varov.length ? `<div class="vi-pozn ${varov[0].druh === 'hori' ? 'hori' : 'varuje'}"><svg class="icon" style="width:13px;height:13px"><use href="#i-zvon"/></svg>${esc(varov[0].text)}${varov.length > 1 ? ` (+${varov.length - 1})` : ''}</div>` : ''}
        </button>`;
      }).join('')}
    </div>

    <div class="prehled-mrizka">
      <div class="karta">
        <h3>Kontrolky</h3>
        ${vsechny.length ? vsechny.slice(0, 12).map((k) => `
          <div class="seznam-radek">
            ${lampaHtml(k.druh === 'hori' ? 'var(--cervena)' : k.druh === 'varuje' ? 'var(--amber)' : 'var(--khaki)')}
            <span>${k.vuz ? `<b>${esc(k.vuz.nazev)}:</b> ` : ''}${esc(k.text)}</span>
          </div>`).join('')
        : '<div class="prazdno">Vše v pořádku — žádné kontrolky nesvítí.</div>'}
      </div>
      <div class="karta">
        <h3>Doporučení kokpitu</h3>
        ${rady.length ? rady.slice(0, 8).map((r) => `
          <div class="seznam-radek">
            <svg class="icon" style="color:var(--amber)"><use href="#i-poloha"/></svg>
            <span>${r.vuz ? `<b>${esc(r.vuz.nazev)}:</b> ` : ''}${esc(r.text)}</span>
          </div>`).join('')
        : '<div class="prazdno">Zatím málo dat. Až poběží rezervace, kokpit začne radit s cenou a obsazeností.</div>'}
      </div>
    </div>
  </section>`;
}

/* ---------------------------------------------------------- VOZY */

function kresliVozy() {
  return `
  <section class="sekce">
    <div class="sekce-hl">
      <h2>Vozy a vybavení</h2>
      <div class="mezera"></div>
      <button class="btn" data-akce="porovnat-web"><svg class="icon"><use href="#i-web"/></svg>Porovnat s webem</button>
      <button class="btn hlavni" data-akce="novy-vuz"><svg class="icon"><use href="#i-plus"/></svg>Přidat vůz</button>
    </div>
    <div class="vozy-mrizka">
      ${S.vozy.map((v) => {
        const est = odhadKm(v);
        const l = v.leasing || {};
        return `
        <button class="vuz-karta" style="--vb:${v.barva}" data-otevri-vuz="${v.id}">
          <h3>${esc(v.nazev)} ${v.aktivni === false ? '<span class="stitek">vyřazen</span>' : ''}</h3>
          <div class="vk-fakta">
            ${v.spz ? `<span>SPZ <b>${esc(v.spz)}</b></span>` : (v.typ === 'stan' ? '' : '<span style="color:var(--amber)">doplň SPZ</span>')}
            ${v.rok ? `<span>rok <b>${v.rok}</b></span>` : ''}
            <span>cena <b>${kc(v.cenaDen)}/den</b></span>
            <span>kauce <b>${kc(v.kauce)}</b></span>
            ${v.typ !== 'stan' ? `<span>tacho <b>${est.km == null ? '—' : fmtKc.format(est.km) + (est.presne ? '' : ' ~') + ' km'}</b></span>` : ''}
            ${cislo(l.zbyva) != null ? `<span>zbývá splatit <b>${kc(l.zbyva)}</b></span>` : (v.typ === 'stan' ? '' : '<span style="color:var(--amber)">doplň leasing</span>')}
            <span>vybavení <b>${(v.vybava || []).length} ks</b></span>
            <span>serviska <b>${(v.servis || []).length} zápisů</b></span>
          </div>
        </button>`;
      }).join('')}
    </div>
  </section>`;
}

/* ---------------------------------------------------------- šuplík: obecné */

function otevriSuplik(otevreno) {
  UI.otevreno = otevreno;
  $('#zaclona').classList.remove('skryto');
  $('#suplik').classList.remove('skryto');
  kresliSuplik();
}
function zavriSuplik() {
  UI.otevreno = null;
  $('#zaclona').classList.add('skryto');
  $('#suplik').classList.add('skryto');
}

function pole(def, hodnota) {
  const v = hodnota ?? '';
  if (def.t === 'textarea') return `<label class="pole"><b>${def.p}</b><textarea data-k="${def.k}" placeholder="${def.ph || ''}">${esc(v)}</textarea></label>`;
  if (def.t === 'select') return `<label class="pole"><b>${def.p}</b><select data-k="${def.k}">${def.moznosti.map((m) => `<option value="${m.v}" ${String(m.v) === String(v) ? 'selected' : ''}>${m.p}</option>`).join('')}</select></label>`;
  const typ = def.t === 'cislo' ? 'number' : def.t === 'datum' ? 'date' : 'text';
  return `<label class="pole"><b>${def.p}</b><input type="${typ}" data-k="${def.k}" value="${esc(v)}" placeholder="${def.ph || ''}" ${def.t === 'cislo' ? 'inputmode="numeric" step="any"' : ''}></label>`;
}
function sesbirej(kontejner) {
  const o = {};
  $$('[data-k]', kontejner).forEach((el) => {
    let v = el.value.trim();
    if (el.type === 'number') v = v === '' ? null : +v;
    o[el.dataset.k] = v;
  });
  return o;
}

/* ---------------------------------------------------------- šuplík: vůz */

function kresliSuplik() {
  const o = UI.otevreno;
  if (!o) return;
  if (o.typ === 'vuz') return kresliSuplikVozu(o);
  if (o.typ === 'rezervace') return kresliSuplikRezervace(o);
  if (o.typ === 'kontakt') return kresliSuplikKontaktu(o);
  if (o.typ === 'nastaveni') return kresliSuplikNastaveni(o);
  if (o.typ === 'kontrolky') return kresliSuplikKontrolky(o);
  if (o.typ === 'web') return kresliSuplikWebu(o);
}

const POD_VUZ = [
  { id: 'info', p: 'Vůz & peníze' }, { id: 'vybava', p: 'Basic pack' },
  { id: 'servis', p: 'Serviska' }, { id: 'tacho', p: 'Tachometr' }, { id: 'milniky', p: 'Milníky' },
];

function kresliSuplikVozu(o) {
  const v = vuz(o.id);
  if (!v) return zavriSuplik();
  o.pod = o.pod || 'info';
  const s = $('#suplik');

  s.innerHTML = `
  <div class="s-hl" style="border-left:5px solid ${v.barva}">
    <h2>${esc(v.nazev)}</h2>
    <div style="flex:1"></div>
    <button class="btn nic mala" data-akce="smaz-vuz" title="Smazat vůz"><svg class="icon"><use href="#i-kos"/></svg></button>
    <button class="hl-btn" data-akce="zavri"><svg class="icon"><use href="#i-krizek"/></svg></button>
  </div>
  <div class="s-telo">
    <div class="pod-zalozky">${POD_VUZ.map((p) => `<button class="pod-zalozka" data-pod="${p.id}" aria-selected="${String(p.id === o.pod)}">${p.p}</button>`).join('')}</div>
    <div id="pod-obsah">${
      o.pod === 'info' ? podInfoVozu(v)
      : o.pod === 'vybava' ? podVybava(v)
      : o.pod === 'servis' ? podServis(v)
      : o.pod === 'tacho' ? podTacho(v)
      : podMilniky(v)}</div>
  </div>`;
}

function podInfoVozu(v) {
  const l = v.leasing || {};
  const splaceno = (cislo(l.celkem) != null && cislo(l.zbyva) != null) ? l.celkem - l.zbyva : null;
  return `
  <div class="blok" data-blok="zaklad">
    <div class="blok-hl"><h4>Základ</h4><div class="mezera"></div><button class="btn mala hlavni" data-akce="uloz-zaklad">Uložit</button></div>
    <div class="rada r2">
      ${pole({ k: 'nazev', p: 'Název', t: 'text' }, v.nazev)}
      ${pole({ k: 'spz', p: 'SPZ', t: 'text' }, v.spz)}
      ${pole({ k: 'rok', p: 'Rok výroby', t: 'cislo' }, v.rok)}
      ${pole({ k: 'cenaDen', p: 'Cena za den (Kč)', t: 'cislo' }, v.cenaDen)}
      ${pole({ k: 'kauce', p: 'Kauce (Kč)', t: 'cislo' }, v.kauce)}
      ${pole({ k: 'aktivni', p: 'Stav', t: 'select', moznosti: [{ v: 'true', p: 'v provozu' }, { v: 'false', p: 'vyřazen / prodán' }] }, String(v.aktivni !== false))}
    </div>
    <div class="rada">${pole({ k: 'poznamka', p: 'Poznámka', t: 'textarea' }, v.poznamka)}</div>
  </div>

  <div class="blok" data-blok="leasing">
    <div class="blok-hl"><h4>Financování / leasing</h4><div class="mezera"></div>
      ${splaceno != null ? `<span class="stitek">splaceno ${kc(splaceno)} z ${kc(l.celkem)}</span>` : ''}
      <button class="btn mala hlavni" data-akce="uloz-leasing">Uložit</button></div>
    <div class="rada r2">
      ${pole({ k: 'spolecnost', p: 'Komu se splácí (společnost)', t: 'text', ph: 'např. ČSOB Leasing' }, l.spolecnost)}
      ${pole({ k: 'cisloSmlouvy', p: 'Číslo smlouvy', t: 'text' }, l.cisloSmlouvy)}
      ${pole({ k: 'celkem', p: 'Celková výše (Kč)', t: 'cislo' }, l.celkem)}
      ${pole({ k: 'zbyva', p: 'Zbývá splatit (Kč)', t: 'cislo' }, l.zbyva)}
      ${pole({ k: 'mesicniSplatka', p: 'Měsíční splátka (Kč)', t: 'cislo' }, l.mesicniSplatka)}
      ${pole({ k: 'denSplatky', p: 'Den splátky v měsíci', t: 'cislo', ph: '15' }, l.denSplatky)}
      ${pole({ k: 'konec', p: 'Konec leasingu', t: 'datum' }, l.konec)}
      ${pole({ k: 'ucet', p: 'Číslo účtu / VS', t: 'text' }, l.ucet)}
    </div>
    <div class="rada">${pole({ k: 'pozn', p: 'Poznámka', t: 'text' }, l.pozn)}</div>
  </div>

  <div class="blok" data-blok="pojisteni">
    <div class="blok-hl"><h4>Pojištění</h4><div class="mezera"></div><button class="btn mala" data-akce="pridej-pojisteni"><svg class="icon"><use href="#i-plus"/></svg>Přidat</button></div>
    ${(v.pojisteni || []).map((p) => `
      <div class="rada r2" data-id="${p.id}" style="border-bottom:1px solid var(--linka);padding-bottom:10px">
        ${pole({ k: 'druh', p: 'Druh', t: 'text', ph: 'Povinné / Havarijní' }, p.druh)}
        ${pole({ k: 'spolecnost', p: 'Pojišťovna', t: 'text' }, p.spolecnost)}
        ${pole({ k: 'cisloSmlouvy', p: 'Číslo smlouvy', t: 'text' }, p.cisloSmlouvy)}
        ${pole({ k: 'rocne', p: 'Ročně (Kč)', t: 'cislo' }, p.rocne)}
        ${pole({ k: 'platiDo', p: 'Platí do', t: 'datum' }, p.platiDo)}
        <div style="display:flex;align-items:flex-end;gap:6px">
          <button class="btn mala hlavni" data-akce="uloz-pojisteni" data-id="${p.id}">Uložit</button>
          <button class="btn mala nic pozor" data-akce="smaz-pojisteni" data-id="${p.id}"><svg class="icon"><use href="#i-kos"/></svg></button>
        </div>
      </div>`).join('') || '<div class="prazdno">Žádné pojistky. Přidej povinné ručení a havarijko.</div>'}
  </div>`;
}

function podVybava(v) {
  return `
  <div class="blok" data-blok="vybava">
    <div class="blok-hl"><h4>Basic pack — jede s vozem vždy</h4><div class="mezera"></div><button class="btn mala" data-akce="pridej-vybavu"><svg class="icon"><use href="#i-plus"/></svg>Přidat věc</button></div>
    ${(v.vybava || []).length ? `<div class="pretece"><table class="tab"><thead><tr><th>Věc</th><th class="cislo">ks</th><th>Poznámka</th><th></th></tr></thead><tbody>
      ${v.vybava.map((b) => `
      <tr data-id="${b.id}">
        <td><input data-k="nazev" value="${esc(b.nazev)}"></td>
        <td class="cislo" style="width:70px"><input data-k="ks" type="number" value="${esc(b.ks ?? 1)}"></td>
        <td><input data-k="pozn" value="${esc(b.pozn)}" placeholder="stav, kde je…"></td>
        <td class="cislo"><div class="radek-akce">
          <button class="btn mala hlavni" data-akce="uloz-vybavu" data-id="${b.id}">Uložit</button>
          <button class="btn mala nic pozor" data-akce="smaz-vybavu" data-id="${b.id}"><svg class="icon"><use href="#i-kos"/></svg></button>
        </div></td>
      </tr>`).join('')}
    </tbody></table></div>` : '<div class="prazdno">Prázdný pack. Sepiš, co s autem vždycky jede — při vydání se to odškrtává.</div>'}
  </div>`;
}

function podServis(v) {
  return `
  <div class="blok">
    <div class="blok-hl"><h4>Servisní kniha</h4><div class="mezera"></div><button class="btn mala" data-akce="pridej-servis"><svg class="icon"><use href="#i-plus"/></svg>Nový zápis</button></div>
    ${(v.servis || []).slice().sort((a, b) => (b.datum || '').localeCompare(a.datum || '')).map((z) => `
      <div class="blok" data-id="${z.id}" style="margin-bottom:10px">
        <div class="rada r3">
          ${pole({ k: 'datum', p: 'Datum', t: 'datum' }, z.datum)}
          ${pole({ k: 'km', p: 'Stav km', t: 'cislo' }, z.km)}
          ${pole({ k: 'cena', p: 'Cena (Kč)', t: 'cislo' }, z.cena)}
        </div>
        <div class="rada">${pole({ k: 'popis', p: 'Co se dělalo', t: 'textarea', ph: 'výměna oleje, brzdy…' }, z.popis)}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${(z.dokumenty || []).map((d, i) => `
            <button class="doc-chip" data-akce="otevri-dok" data-id="${z.id}" data-i="${i}" title="${esc(d.nazev)}">
              <svg class="icon" style="width:13px;height:13px"><use href="#${/\.(jpe?g|png|webp)$/i.test(d.nazev) ? 'i-foto' : 'i-dokument'}"/></svg><span>${esc(d.nazev)}</span>
            </button>
            <button class="btn mala nic pozor" data-akce="smaz-dok" data-id="${z.id}" data-i="${i}" title="Smazat přílohu"><svg class="icon" style="width:12px;height:12px"><use href="#i-krizek"/></svg></button>`).join('')}
          <label class="btn mala"><svg class="icon"><use href="#i-foto"/></svg>Přidat fotku / doklad
            <input type="file" accept="image/*,application/pdf" multiple class="skryto" data-akce-file="nahraj-dok" data-id="${z.id}"></label>
          <div style="flex:1"></div>
          <button class="btn mala hlavni" data-akce="uloz-servis" data-id="${z.id}">Uložit</button>
          <button class="btn mala nic pozor" data-akce="smaz-servis" data-id="${z.id}"><svg class="icon"><use href="#i-kos"/></svg></button>
        </div>
      </div>`).join('') || '<div class="prazdno">Prázdná serviska. Každá oprava sem — s fotkou účtenky.</div>'}
  </div>`;
}

function podTacho(v) {
  const est = odhadKm(v);
  return `
  <div class="blok">
    <div class="blok-hl"><h4>Tachometr</h4><div class="mezera"></div>
      ${est.km != null ? odoHtml(est.km, est.presne) : ''}
      <button class="btn mala hlavni" data-akce="pridej-tacho"><svg class="icon"><use href="#i-plus"/></svg>Zapsat stav</button></div>
    ${est.km != null && !est.presne ? `<p style="font-size:12.5px;color:var(--khaki);margin:0 0 10px">Odhad: poslední zápis ${denCesky(est.od)} + rezervace po něm (${Math.round(kmNaDen(v))} km/den naučeno z výpůjček). Každý skutečný zápis odhad zpřesní.</p>` : ''}
    ${(v.tachometr || []).slice().sort((a, b) => (b.datum || '').localeCompare(a.datum || '')).map((t) => `
      <div class="seznam-radek" data-id="${t.id}">
        <span style="font:600 13px var(--mono)">${fmtKc.format(t.km)} km</span>
        <span>${denCesky(t.datum)}</span>
        <span style="color:var(--khaki)">${esc(t.pozn || '')}</span>
        <span class="kdy">${esc(t.kdo || '')}</span>
        <button class="btn mala nic pozor" data-akce="smaz-tacho" data-id="${t.id}"><svg class="icon"><use href="#i-kos"/></svg></button>
      </div>`).join('') || '<div class="prazdno">Žádný zápis. První stav km je základ pro celý odhad.</div>'}
  </div>`;
}

function podMilniky(v) {
  return `
  <div class="blok">
    <div class="blok-hl"><h4>Milníky a termíny — kokpit je hlídá</h4><div class="mezera"></div><button class="btn mala" data-akce="pridej-milnik"><svg class="icon"><use href="#i-plus"/></svg>Přidat</button></div>
    ${(v.milniky || []).map((m) => `
      <div class="rada r3" data-id="${m.id}" style="border-bottom:1px solid var(--linka);padding-bottom:10px;align-items:end">
        ${pole({ k: 'nazev', p: 'Co', t: 'text', ph: 'STK, olej, dálniční známka…' }, m.nazev)}
        ${pole({ k: 'typ', p: 'Hlídat podle', t: 'select', moznosti: [{ v: 'datum', p: 'data' }, { v: 'km', p: 'kilometrů' }] }, m.typ)}
        ${m.typ === 'km' ? pole({ k: 'hodnota', p: 'Při km', t: 'cislo' }, m.hodnota) : pole({ k: 'hodnota', p: 'Termín', t: 'datum' }, m.hodnota)}
        ${pole({ k: 'pozn', p: 'Poznámka', t: 'text' }, m.pozn)}
        <div style="display:flex;gap:6px">
          <button class="btn mala hlavni" data-akce="uloz-milnik" data-id="${m.id}">Uložit</button>
          <button class="btn mala nic pozor" data-akce="smaz-milnik" data-id="${m.id}"><svg class="icon"><use href="#i-kos"/></svg></button>
        </div>
      </div>`).join('') || '<div class="prazdno">Žádné milníky. Přidej STK, servisní interval, známky…</div>'}
  </div>`;
}

/* ---------------------------------------------------------- KALENDÁŘ */

function kresliKalendar() {
  const [rok, mes] = UI.kalMesic.split('-').map(Number);
  const dnu = new Date(rok, mes, 0).getDate();
  const dnes = dnesISO();
  const prvni = UI.kalMesic + '-01';
  const posledni = UI.kalMesic + '-' + String(dnu).padStart(2, '0');
  const kfl = konflikty();

  const denTyden = (d) => new Date(rok, mes - 1, d).getDay();

  const lajny = S.vozy.filter((v) => v.aktivni !== false).map((v) => {
    const rezky = rezervaceVozu(v.id).filter((r) => r.stav !== 'vraceno' || r.do >= prvni)
      .filter((r) => r.od <= posledni && r.do >= prvni);
    /* pásy do pater, když se překrývají */
    const patra = [];
    const pasy = rezky.sort((a, b) => a.od.localeCompare(b.od)).map((r) => {
      const od = r.od < prvni ? 1 : +r.od.slice(8, 10);
      const doD = r.do > posledni ? dnu : +r.do.slice(8, 10);
      let patro = 0;
      while ((patra[patro] || '') >= r.od && patra[patro] > '') patro++;
      while (patro < patra.length && patra[patro] >= r.od) patro++;
      patra[patro] = r.do;
      const maKonflikt = kfl.some((k) => k.vid === v.id && (k.a.id === r.id || k.b.id === r.id));
      return `<button class="kal-pas ${r.stav} ${maKonflikt ? 'konflikt' : ''}" data-otevri-rez="${r.id}"
        style="--vb:${v.barva};left:${((od - 1) / dnu) * 100}%;width:${((doD - od + 1) / dnu) * 100}%;${patro ? `top:calc(50% + ${patro * 15}px);height:13px;line-height:13px;font-size:9.5px;` : ''}"
        title="${esc(jmenoRez(r))} · ${denCesky(r.od)} – ${denCesky(r.do)} · ${r.stav}">${esc(jmenoRez(r))}</button>`;
    }).join('');

    const bunky = Array.from({ length: dnu }, (_, i) => {
      const d = i + 1;
      const dt = denTyden(d);
      return `<div class="kal-bunka ${dt === 0 || dt === 6 ? 'vikend' : ''}" data-novy-den="${UI.kalMesic}-${String(d).padStart(2, '0')}" data-vuz="${v.id}" title="+ nová rezervace"></div>`;
    }).join('');

    const dneskaCara = dnes.slice(0, 7) === UI.kalMesic
      ? `<div class="kal-dneska" style="left:${((+dnes.slice(8, 10) - 0.5) / dnu) * 100}%"></div>` : '';

    return `<div class="kal-lajna">
      <div class="kal-jmeno"><span class="lampa" style="background:${v.barva};color:${v.barva}"></span>${esc(v.nazev)}</div>
      <div class="kal-plocha" style="${patra.length ? `min-height:${44 + patra.length * 15}px` : ''}">${bunky}${dneskaCara}${pasy}</div>
    </div>`;
  }).join('');

  const hlava = `<div class="kal-hlava"><div class="kal-jmeno" style="color:var(--khaki-tm);font-size:11px">VŮZ / DEN</div>
    <div class="kal-dny">${Array.from({ length: dnu }, (_, i) => {
      const d = i + 1, dt = denTyden(d);
      const jeDnes = dnes === UI.kalMesic + '-' + String(d).padStart(2, '0');
      return `<div class="kal-den ${dt === 0 || dt === 6 ? 'vikend' : ''} ${jeDnes ? 'dnes' : ''}">${d}</div>`;
    }).join('')}</div></div>`;

  const nadchazejici = S.rezervace
    .filter((r) => r.stav !== 'zruseno' && (r.stav !== 'vraceno' || r.do >= pridejDni(dnes, -14)))
    .sort((a, b) => a.od.localeCompare(b.od));

  return `
  <section class="sekce">
    <div class="sekce-hl">
      <h2>Obsazenost</h2>
      <div class="kal-nastroje">
        <button class="btn mala" data-akce="kal-posun" data-smer="-1"><svg class="icon"><use href="#i-sipka-l"/></svg></button>
        <span class="kal-mesic">${MESICE[mes - 1]} ${rok}</span>
        <button class="btn mala" data-akce="kal-posun" data-smer="1"><svg class="icon"><use href="#i-sipka-p"/></svg></button>
        <button class="btn mala nic" data-akce="kal-dnes">dnes</button>
      </div>
      <div class="mezera"></div>
      <button class="btn" data-akce="nacti-web"><svg class="icon"><use href="#i-web"/></svg>Poptávky z webu</button>
      <button class="btn hlavni" data-akce="nova-rez"><svg class="icon"><use href="#i-plus"/></svg>Nová rezervace</button>
    </div>

    <div class="kal"><div class="kal-mriz">${hlava}${lajny}</div></div>
    <p style="font-size:12px;color:var(--khaki-tm);margin:8px 2px">čárkovaně = poptávka · poloplné = potvrzeno · plné = vydáno · šedé = vráceno · kliknutím do prázdného dne založíš rezervaci</p>

    <div class="karta rez-seznam">
      <h3>Rezervace</h3>
      ${nadchazejici.length ? nadchazejici.map((r) => `
        <div class="rez-radek">
          <span class="datumy">${denKratce(r.od)} – ${denKratce(r.do)}</span>
          ${(r.vozy || []).map((id) => { const v = vuz(id); return v ? `<span class="stitek plny" style="background:${v.barva}">${esc(v.nazev.split(' ')[0])}</span>` : ''; }).join('')}
          <button class="jmeno" style="text-align:left" data-otevri-rez="${r.id}">${esc(jmenoRez(r))}</button>
          <span class="stav-pill ${r.stav}">${r.stav}</span>
          ${r.zdroj === 'web' ? '<span class="stitek">z webu</span>' : ''}
          <span class="kc">${kc(r.castka)}</span>
          ${r.stav === 'poptavka' ? `<button class="btn mala" data-akce="rez-potvrd" data-id="${r.id}">Potvrdit</button>` : ''}
          ${r.stav === 'potvrzeno' ? `<button class="btn mala" data-akce="rez-vydej" data-id="${r.id}">Vydat vůz</button>` : ''}
          ${r.stav === 'vydano' ? `<button class="btn mala hlavni" data-akce="rez-vrat" data-id="${r.id}">Vrátit vůz</button>` : ''}
        </div>`).join('') : '<div class="prazdno">Žádné rezervace. Založ první — nebo natáhni poptávky z webu.</div>'}
    </div>
  </section>`;
}

/* ---------------------------------------------------------- šuplík: rezervace */

function kresliSuplikRezervace(o) {
  const r = o.id ? S.rezervace.find((x) => x.id === o.id) : null;
  const n = r || o.predvyplneno || {};
  const s = $('#suplik');
  s.innerHTML = `
  <div class="s-hl">
    <h2>${r ? 'Rezervace — ' + esc(jmenoRez(r)) : 'Nová rezervace'}</h2>
    <div style="flex:1"></div>
    ${r ? `<button class="btn nic mala pozor" data-akce="rez-zrus" data-id="${r.id}">Zrušit rezervaci</button>` : ''}
    <button class="hl-btn" data-akce="zavri"><svg class="icon"><use href="#i-krizek"/></svg></button>
  </div>
  <div class="s-telo">
    <div class="blok">
      <div class="blok-hl"><h4>Vozy</h4></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${S.vozy.filter((v) => v.aktivni !== false).map((v) => `
          <label class="stitek" style="cursor:pointer;padding:6px 10px;${(n.vozy || []).includes(v.id) ? `background:${v.barva};color:var(--noc);border-color:${v.barva}` : ''}">
            <input type="checkbox" class="skryto" data-rez-vuz="${v.id}" ${(n.vozy || []).includes(v.id) ? 'checked' : ''}>${esc(v.nazev)}
          </label>`).join('')}
      </div>
    </div>
    <div class="blok">
      <div class="blok-hl"><h4>Termín a peníze</h4></div>
      <div class="rada r2">
        ${pole({ k: 'od', p: 'Od', t: 'datum' }, n.od)}
        ${pole({ k: 'do', p: 'Do', t: 'datum' }, n.do)}
        ${pole({ k: 'castka', p: 'Cena celkem (Kč)', t: 'cislo' }, n.castka)}
        ${pole({ k: 'zaloha', p: 'Záloha (Kč)', t: 'cislo' }, n.zaloha)}
        ${pole({ k: 'stav', p: 'Stav', t: 'select', moznosti: ['poptavka', 'potvrzeno', 'vydano', 'vraceno', 'zruseno'].map((x) => ({ v: x, p: x })) }, n.stav || 'poptavka')}
        ${pole({ k: 'zdroj', p: 'Odkud přišla', t: 'select', moznosti: [{ v: '', p: '—' }, { v: 'web', p: 'web / rezervační systém' }, { v: 'telefon', p: 'telefon' }, { v: 'znamy', p: 'známý' }, { v: 'bazos', p: 'inzerát' }] }, n.zdroj)}
        ${pole({ k: 'kmPred', p: 'Km při vydání', t: 'cislo' }, n.kmPred)}
        ${pole({ k: 'kmPo', p: 'Km při vrácení', t: 'cislo' }, n.kmPo)}
      </div>
      ${navrhCeny(n)}
    </div>
    <div class="blok">
      <div class="blok-hl"><h4>Zákazník</h4></div>
      <div class="rada r2">
        <label class="pole"><b>Kontakt z databáze</b>
          <select data-k="kontakt">
            <option value="">— nový / bez vazby —</option>
            ${S.kontakty.map((k) => `<option value="${k.id}" ${n.kontakt === k.id ? 'selected' : ''}>${esc(k.jmeno)}${k.tel ? ' · ' + esc(k.tel) : ''}</option>`).join('')}
          </select></label>
        ${pole({ k: 'jmeno', p: 'Jméno (když není v databázi)', t: 'text' }, n.jmeno)}
      </div>
      <div class="rada">${pole({ k: 'pozn', p: 'Poznámka', t: 'textarea', ph: 'kam jedou, co si berou, domluvy…' }, n.pozn)}</div>
    </div>
  </div>
  <div class="s-pata">
    <button class="btn hlavni" data-akce="uloz-rez" ${r ? `data-id="${r.id}"` : ''}>${r ? 'Uložit změny' : 'Založit rezervaci'}</button>
    <span style="font-size:12px;color:var(--khaki)">${r ? 'založil ' + esc(r.vytvoril || '?') + ' ' + kdyKratce(r.vytvoreno || nyni()) : ''}</span>
  </div>`;
}

/* Návrh ceny podle vybraných vozů a termínu — jen nápověda. */
function navrhCeny(n) {
  if (!n.od || !n.do || !(n.vozy || []).length) return '';
  const dni = dniRez(n.od, n.do);
  const zaklad = n.vozy.reduce((a, id) => a + (cislo(vuz(id)?.cenaDen) || 0), 0);
  let cena = zaklad * dni;
  let pozn = `${dni} dní × ${kc(zaklad)}`;
  if (dni >= 21) { cena *= 0.85; pozn += ' − 15 % (21+ dní)'; }
  else if (dni >= 14) { cena *= 0.9; pozn += ' − 10 % (14+ dní)'; }
  return `<p style="font-size:12.5px;color:var(--amber);margin:8px 0 0">Návrh ceny: <b>${kc(cena)}</b> (${pozn})</p>`;
}

/* Vydání a vrácení vozu — rychlý dialog se zápisem km. */
function dialogKm(r, rezim) {
  const d = $('#rychly');
  const auta = (r.vozy || []).map(vuz).filter((v) => v && v.typ !== 'stan');
  d.innerHTML = `
    <h2 style="font-size:19px;margin-bottom:4px">${rezim === 'vydej' ? 'Vydání vozu' : 'Vrácení vozu'}</h2>
    <p style="color:var(--khaki);font-size:13px;margin:0 0 14px">${esc(jmenoRez(r))} · ${denCesky(r.od)} – ${denCesky(r.do)}</p>
    ${auta.map((v) => `<div class="rada" style="margin-bottom:8px">
      ${pole({ k: 'km-' + v.id, p: `${esc(v.nazev)} — stav tachometru`, t: 'cislo', ph: 'km' }, rezim === 'vydej' ? (odhadKm(v).km ?? '') : '')}
    </div>`).join('')}
    ${rezim === 'vrat' ? `<div class="rada">${pole({ k: 'pozn', p: 'Stav vozu / poznámka', t: 'text', ph: 'čistý, plná nádrž…' }, '')}</div>` : ''}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn nic" data-akce="dialog-zavri">Zpět</button>
      <button class="btn hlavni" data-akce="dialog-potvrd" data-rezim="${rezim}" data-id="${r.id}">${rezim === 'vydej' ? 'Vydat' : 'Vrátit a zapsat km'}</button>
    </div>`;
  d.showModal();
}

async function potvrdDialogKm(rezim, rid) {
  const d = $('#rychly');
  const hodnoty = sesbirej(d);
  const r = S.rezervace.find((x) => x.id === rid);
  if (!r) return d.close();
  const auta = (r.vozy || []).map(vuz).filter((v) => v && v.typ !== 'stan');
  const prvniKm = auta.length ? hodnoty['km-' + auta[0].id] : null;

  const ok = await ulozPolozku(
    rezim === 'vydej' ? `Vydání vozu — ${jmenoRez(r)}` : `Vrácení vozu — ${jmenoRez(r)}`,
    SOUBORY.rezervace, rid,
    (p) => {
      if (rezim === 'vydej') { p.stav = 'vydano'; if (cislo(prvniKm) != null) p.kmPred = prvniKm; }
      else { p.stav = 'vraceno'; if (cislo(prvniKm) != null) p.kmPo = prvniKm; }
    });

  if (ok) {
    /* Každý skutečný stav km rovnou do tachometru vozu — kalibruje odhad. */
    for (const v of auta) {
      const km = cislo(hodnoty['km-' + v.id]);
      if (km == null) continue;
      await ulozVuz(`Tachometr ${v.nazev}: ${km} km`, v.id, (x) => {
        x.tachometr = x.tachometr || [];
        x.tachometr.push({ id: uid('ta'), datum: dnesISO(), km, kdo: JA.jmeno, pozn: (rezim === 'vydej' ? 'vydání — ' : 'vrácení — ') + jmenoRez(r) + (hodnoty.pozn ? ' · ' + hodnoty.pozn : '') });
      });
    }
    hlaska(rezim === 'vydej' ? 'Vůz vydán, šťastnou cestu.' : 'Vráceno a zapsáno.');
  }
  d.close();
}

/* ---------------------------------------------------------- FINANCE */

function kresliFinance() {
  const rozsah = obdobiRozsah();
  const vozyAkt = S.vozy;
  const ply = vozyAkt.map((v) => ({ v, pl: plVozu(v, rozsah) }));
  const celkemVynos = ply.reduce((a, x) => a + x.pl.vynos, 0);
  const celkemNasml = ply.reduce((a, x) => a + x.pl.vynosNasml, 0);
  const celkemNaklady = ply.reduce((a, x) => a + x.pl.naklady, 0);
  const mkt = marketingV(rozsah);
  const marze = celkemVynos - celkemNaklady - mkt;

  const inv = S.finance.investice || [];
  const podleOsob = {};
  for (const p of S.nastaveni.partneri || []) podleOsob[p] = 0;
  for (const i of inv) podleOsob[i.kdo] = (podleOsob[i.kdo] || 0) + hodnotaInvestice(i);
  const invCelkem = Object.values(podleOsob).reduce((a, b) => a + b, 0);

  return `
  <section class="sekce">
    <div class="sekce-hl">
      <h2>Finance</h2>
      <select style="width:auto" data-akce-zmena="fin-obdobi">
        ${[['30', 'posledních 30 dní'], ['90', 'posledních 90 dní'], ['365', 'posledních 12 měsíců'], ['rok', 'letošní rok'], ['vse', 'od začátku']]
          .map(([v, p]) => `<option value="${v}" ${UI.finObdobi === v ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
      <div class="mezera"></div>
      <span class="stitek">marže po marketingu: <b class="${marze >= 0 ? 'kc-plus' : 'kc-minus'}">&nbsp;${kc(marze)}</b></span>
    </div>

    <div class="karta pretece">
      <h3>Hospodaření vozů (${denKratce(rozsah.od)} – ${denKratce(rozsah.do)})</h3>
      <table class="tab">
        <thead><tr><th>Vůz</th><th class="cislo">Výnos</th><th class="cislo">Nasmlouváno</th><th class="cislo">Leasing</th><th class="cislo">Pojistky</th><th class="cislo">Servis</th><th class="cislo">Marže</th><th style="min-width:130px">Obsazenost</th><th class="cislo" title="Kolik dní v měsíci musí vůz jet, aby pokryl fixní náklady">Break-even</th></tr></thead>
        <tbody>
        ${ply.map(({ v, pl }) => `
          <tr>
            <td><span class="stitek plny" style="background:${v.barva}">${esc(v.nazev)}</span></td>
            <td class="cislo">${kc(pl.vynos)}</td>
            <td class="cislo" style="color:var(--khaki)">${pl.vynosNasml ? kc(pl.vynosNasml) : '—'}</td>
            <td class="cislo">${pl.leasing ? kc(-pl.leasing) : '—'}</td>
            <td class="cislo">${pl.pojistky ? kc(-pl.pojistky) : '—'}</td>
            <td class="cislo">${pl.servis ? kc(-pl.servis) : '—'}</td>
            <td class="cislo ${pl.marze >= 0 ? 'kc-plus' : 'kc-minus'}">${kc(pl.marze)}</td>
            <td><div class="util" style="--vb:${v.barva}"><div class="drah"><i style="width:${Math.min(100, Math.round(pl.utilizace * 100))}%"></i></div><span>${Math.round(pl.utilizace * 100)} %</span></div></td>
            <td class="cislo">${pl.breakEvenDnu != null && pl.fixniMesic ? Math.ceil(pl.breakEvenDnu) + ' dní/měs' : '—'}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr><td>Celkem</td><td class="cislo">${kc(celkemVynos)}</td><td class="cislo">${kc(celkemNasml)}</td>
          <td class="cislo" colspan="3">náklady ${kc(-celkemNaklady)} · marketing ${kc(-mkt)}</td>
          <td class="cislo ${marze >= 0 ? 'kc-plus' : 'kc-minus'}">${kc(marze)}</td><td colspan="2"></td></tr></tfoot>
      </table>
    </div>

    <div class="prehled-mrizka">
      <div class="karta">
        <h3>Co jsme do toho dali — vklady parťáků</h3>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px">
          ${Object.entries(podleOsob).map(([kdo, suma]) => `
            <div class="blok" style="flex:1;min-width:140px;margin:0;text-align:center">
              <div style="font:700 20px var(--mono)">${kc(suma)}</div>
              <div style="color:var(--khaki);font-size:12.5px">${esc(kdo)} · ${invCelkem ? Math.round(suma / invCelkem * 100) : 0} %</div>
            </div>`).join('')}
        </div>
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn mala" data-akce="pridej-investici"><svg class="icon"><use href="#i-plus"/></svg>Zapsat vklad</button></div>
        ${inv.slice().sort((a, b) => (b.datum || '').localeCompare(a.datum || '')).map((i) => `
          <div class="seznam-radek" data-id="${i.id}">
            <span class="stitek">${esc(i.kdo)}</span>
            <span>${esc(i.popis)} ${i.typ === 'cas' ? `<span style="color:var(--khaki)">(${i.hodiny} h × ${kc(S.nastaveni.sazbaHodina)})</span>` : ''}</span>
            <span class="kdy">${denKratce(i.datum)} · <b style="color:var(--plachta)">${kc(hodnotaInvestice(i))}</b></span>
            <button class="btn mala nic pozor" data-akce="smaz-investici" data-id="${i.id}"><svg class="icon"><use href="#i-kos"/></svg></button>
          </div>`).join('') || '<div class="prazdno">Zapiš peníze, věci i čas, co jste do firmy dali — ať je podíl fér.</div>'}
      </div>
      <div class="karta">
        <h3>Doporučení</h3>
        ${doporuceni().map((r) => `
          <div class="seznam-radek">
            <svg class="icon" style="color:var(--amber)"><use href="#i-poloha"/></svg>
            <span>${r.vuz ? `<b>${esc(r.vuz.nazev)}:</b> ` : ''}${esc(r.text)}</span>
          </div>`).join('') || '<div class="prazdno">Zatím málo dat na chytré rady.</div>'}
      </div>
    </div>
  </section>`;
}

/* ---------------------------------------------------------- MARKETING */

function kresliMarketing() {
  const mkt = (S.finance.marketing || []).slice().sort((a, b) => (b.datum || '').localeCompare(a.datum || ''));
  const rozsah = { od: pridejDni(dnesISO(), -30), do: dnesISO(), dnu: 30 };
  const utrata30 = marketingV(rozsah);
  const vynos30 = S.vozy.reduce((a, v) => a + plVozu(v, rozsah).vynos, 0);
  const zWebu30 = S.rezervace.filter((r) => r.zdroj === 'web' && (r.vytvoreno || '').slice(0, 10) >= rozsah.od).length;

  return `
  <section class="sekce">
    <div class="sekce-hl">
      <h2>Marketing</h2>
      <div class="mezera"></div>
      ${(S.finance.odkazy || []).map((o) => `<a class="btn mala" href="${esc(o.url)}" target="_blank" rel="noopener"><svg class="icon"><use href="#i-odkaz"/></svg>${esc(o.nazev)}</a>`).join('')}
      <button class="btn hlavni" data-akce="pridej-marketing"><svg class="icon"><use href="#i-plus"/></svg>Zapsat útratu</button>
    </div>

    <div class="flotila" style="margin-bottom:14px">
      <div class="karta"><h3>Útrata 30 dní</h3><div style="font:700 24px var(--mono)">${kc(utrata30)}</div></div>
      <div class="karta"><h3>Výnos 30 dní</h3><div style="font:700 24px var(--mono)" class="kc-plus">${kc(vynos30)}</div></div>
      <div class="karta"><h3>Poptávky z webu / 30 dní</h3><div style="font:700 24px var(--mono)">${zWebu30}${zWebu30 && utrata30 ? `<span style="font-size:13px;color:var(--khaki)"> · ${kc(utrata30 / zWebu30)}/poptávka</span>` : ''}</div></div>
    </div>

    <div class="karta pretece">
      <h3>Útraty a výsledky kampaní</h3>
      ${mkt.length ? `<table class="tab">
        <thead><tr><th>Datum</th><th>Platforma</th><th>Kampaň</th><th class="cislo">Částka</th><th class="cislo">Imprese</th><th class="cislo">Kliky</th><th class="cislo">Poptávky</th><th></th></tr></thead>
        <tbody>${mkt.map((m) => `
          <tr data-id="${m.id}">
            <td>${denKratce(m.datum)}</td>
            <td>${esc(m.platforma)}</td>
            <td>${esc(m.kampan)}${m.odkaz ? ` <a href="${esc(m.odkaz)}" target="_blank" rel="noopener" title="statistiky kampaně"><svg class="icon" style="width:12px;height:12px"><use href="#i-odkaz"/></svg></a>` : ''}</td>
            <td class="cislo">${kc(m.castka)}</td>
            <td class="cislo">${m.imprese ? fmtKc.format(m.imprese) : '—'}</td>
            <td class="cislo">${m.kliky ? fmtKc.format(m.kliky) : '—'}</td>
            <td class="cislo">${m.poptavky ?? '—'}</td>
            <td class="cislo"><div class="radek-akce">
              <button class="btn mala nic" data-akce="uprav-marketing" data-id="${m.id}"><svg class="icon"><use href="#i-tuzka"/></svg></button>
              <button class="btn mala nic pozor" data-akce="smaz-marketing" data-id="${m.id}"><svg class="icon"><use href="#i-kos"/></svg></button>
            </div></td>
          </tr>`).join('')}</tbody>
      </table>` : '<div class="prazdno">Žádné útraty. Každou kampaň sem — s odkazem na statistiky v Google/Meta Ads.</div>'}
    </div>
  </section>`;
}

/* ---------------------------------------------------------- KONTAKTY */

function kresliKontakty() {
  const h = UI.hledatKontakt.trim().toLowerCase();
  const seznam = S.kontakty
    .filter((k) => !h || [k.jmeno, k.tel, k.email, k.mesto, k.pozn].join(' ').toLowerCase().includes(h))
    .sort((a, b) => (a.jmeno || '').localeCompare(b.jmeno || '', 'cs'));

  return `
  <section class="sekce">
    <div class="sekce-hl">
      <h2>Kontakty — kdo si půjčoval</h2>
      <input style="width:220px" placeholder="hledat…" value="${esc(UI.hledatKontakt)}" data-akce-vstup="hledej-kontakt">
      <div class="mezera"></div>
      <button class="btn hlavni" data-akce="novy-kontakt"><svg class="icon"><use href="#i-plus"/></svg>Přidat kontakt</button>
    </div>
    <div class="karta pretece">
      ${seznam.length ? `<table class="tab">
        <thead><tr><th>Jméno</th><th>Telefon</th><th>E-mail</th><th class="cislo">Výpůjček</th><th>Štítky</th><th>Poznámka</th><th></th></tr></thead>
        <tbody>${seznam.map((k) => {
          const rezky = S.rezervace.filter((r) => r.kontakt === k.id && r.stav !== 'zruseno');
          return `
          <tr data-id="${k.id}">
            <td><button style="font-weight:600" data-akce="uprav-kontakt" data-id="${k.id}">${esc(k.jmeno)}</button></td>
            <td>${k.tel ? `<a href="tel:${esc(k.tel)}">${esc(k.tel)}</a>` : '—'}</td>
            <td>${k.email ? `<a href="mailto:${esc(k.email)}">${esc(k.email)}</a>` : '—'}</td>
            <td class="cislo">${rezky.length}</td>
            <td>${(k.stitky || []).map((st) => `<span class="stitek" ${st === 'pozor' ? 'style="color:var(--cervena);border-color:var(--cervena)"' : ''}>${esc(st)}</span>`).join(' ')}</td>
            <td style="color:var(--khaki);max-width:260px">${esc(k.pozn)}</td>
            <td class="cislo"><div class="radek-akce">
              <button class="btn mala nic pozor" data-akce="smaz-kontakt" data-id="${k.id}"><svg class="icon"><use href="#i-kos"/></svg></button>
            </div></td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : '<div class="prazdno">Žádné kontakty. Přibudou i automaticky z poptávek z webu.</div>'}
    </div>
  </section>`;
}

function kresliSuplikKontaktu(o) {
  const k = o.id ? kontakt(o.id) : null;
  const n = k || {};
  const rezky = k ? S.rezervace.filter((r) => r.kontakt === k.id).sort((a, b) => b.od.localeCompare(a.od)) : [];
  $('#suplik').innerHTML = `
  <div class="s-hl">
    <h2>${k ? esc(k.jmeno) : 'Nový kontakt'}</h2>
    <div style="flex:1"></div>
    <button class="hl-btn" data-akce="zavri"><svg class="icon"><use href="#i-krizek"/></svg></button>
  </div>
  <div class="s-telo">
    <div class="blok">
      <div class="rada r2">
        ${pole({ k: 'jmeno', p: 'Jméno a příjmení', t: 'text' }, n.jmeno)}
        ${pole({ k: 'tel', p: 'Telefon', t: 'text' }, n.tel)}
        ${pole({ k: 'email', p: 'E-mail', t: 'text' }, n.email)}
        ${pole({ k: 'mesto', p: 'Město', t: 'text' }, n.mesto)}
        ${pole({ k: 'stitky', p: 'Štítky (čárkou: vip, pozor…)', t: 'text' }, (n.stitky || []).join(', '))}
        ${pole({ k: 'dokladOk', p: 'Doklady ověřeny', t: 'select', moznosti: [{ v: 'ne', p: 'ne' }, { v: 'ano', p: 'ano — ŘP + OP viděny' }] }, n.dokladOk ? 'ano' : 'ne')}
      </div>
      <div class="rada">${pole({ k: 'pozn', p: 'Poznámka', t: 'textarea', ph: 'jak jel, jak vrátil, na co pozor…' }, n.pozn)}</div>
      <button class="btn hlavni" data-akce="uloz-kontakt" ${k ? `data-id="${k.id}"` : ''}>${k ? 'Uložit' : 'Přidat kontakt'}</button>
    </div>
    ${k ? `<div class="blok"><div class="blok-hl"><h4>Historie výpůjček</h4></div>
      ${rezky.length ? rezky.map((r) => `
        <div class="seznam-radek">
          <span class="datumy" style="font:600 12.5px var(--mono)">${denKratce(r.od)} – ${denKratce(r.do)}</span>
          ${(r.vozy || []).map((id) => esc(vuz(id)?.nazev || '')).join(' + ')}
          <span class="stav-pill ${r.stav}">${r.stav}</span>
          <span class="kdy">${kc(r.castka)}</span>
        </div>`).join('') : '<div class="prazdno">Zatím nic.</div>'}</div>` : ''}
  </div>`;
}

/* ---------------------------------------------------------- ÚKOLY */

function kresliUkoly() {
  const KATEGORIE = { auto: 'Opravy aut', web: 'Web', marketing: 'Reklama', jine: 'Ostatní' };
  const filtr = UI.ukolFiltr;
  const seznam = S.ukoly
    .filter((u) => filtr === 'vse' ? true : filtr === 'hotovy' ? u.stav === 'hotovy' : u.stav !== 'hotovy')
    .sort((a, b) => ({ vysoka: 0, stredni: 1, nizka: 2 }[a.priorita] ?? 1) - ({ vysoka: 0, stredni: 1, nizka: 2 }[b.priorita] ?? 1));

  return `
  <section class="sekce">
    <div class="sekce-hl">
      <h2>Úkoly — auta · web · reklama</h2>
      <select style="width:auto" data-akce-zmena="ukol-filtr">
        <option value="otevreny" ${filtr === 'otevreny' ? 'selected' : ''}>otevřené</option>
        <option value="hotovy" ${filtr === 'hotovy' ? 'selected' : ''}>hotové</option>
        <option value="vse" ${filtr === 'vse' ? 'selected' : ''}>všechny</option>
      </select>
      <div class="mezera"></div>
      <button class="btn hlavni" data-akce="novy-ukol"><svg class="icon"><use href="#i-plus"/></svg>Nový úkol</button>
    </div>
    <div class="karta">
      ${seznam.length ? seznam.map((u) => `
        <div class="seznam-radek" data-id="${u.id}" style="${u.stav === 'hotovy' ? 'opacity:.55' : ''}">
          <button data-akce="ukol-prepni" data-id="${u.id}" title="${u.stav === 'hotovy' ? 'Vrátit mezi otevřené' : 'Hotovo'}" style="display:grid;place-items:center;width:22px;height:22px;border:1.5px solid var(--linka2);border-radius:6px;${u.stav === 'hotovy' ? 'background:var(--zelena);border-color:var(--zelena);color:var(--noc)' : ''}">
            ${u.stav === 'hotovy' ? '<svg class="icon" style="width:13px;height:13px"><use href="#i-fajfka"/></svg>' : ''}
          </button>
          <span style="${u.stav === 'hotovy' ? 'text-decoration:line-through' : ''}">${esc(u.text)}</span>
          <span class="stitek">${KATEGORIE[u.kategorie] || u.kategorie}</span>
          ${u.vuz && vuz(u.vuz) ? `<span class="stitek plny" style="background:${vuz(u.vuz).barva}">${esc(vuz(u.vuz).nazev.split(' ')[0])}</span>` : ''}
          ${u.priorita === 'vysoka' ? '<span class="stitek" style="color:var(--cervena);border-color:var(--cervena)">důležité</span>' : ''}
          ${u.kdo ? `<span class="stitek">${esc(u.kdo)}</span>` : ''}
          ${u.termin ? `<span class="stitek">do ${denKratce(u.termin)}</span>` : ''}
          <span class="kdy">${esc(u.vytvoril || '')} ${kdyKratce(u.vytvoreno || nyni())}</span>
          <button class="btn mala nic pozor" data-akce="smaz-ukol" data-id="${u.id}"><svg class="icon"><use href="#i-kos"/></svg></button>
        </div>`).join('') : '<div class="prazdno">Čisto. Co je potřeba opravit, přidat nebo vymyslet, piš sem.</div>'}
    </div>
  </section>`;
}

/* ---------------------------------------------------------- NASTAVENÍ + MONITORING */

function kresliSuplikNastaveni() {
  const n = S.nastaveni;
  const t = n.traccar || {};
  $('#suplik').innerHTML = `
  <div class="s-hl">
    <h2>Nastavení</h2>
    <div style="flex:1"></div>
    <button class="hl-btn" data-akce="zavri"><svg class="icon"><use href="#i-krizek"/></svg></button>
  </div>
  <div class="s-telo">
    <div class="blok">
      <div class="blok-hl"><h4>Parťáci a odhady</h4><div class="mezera"></div><button class="btn mala hlavni" data-akce="uloz-nastaveni">Uložit</button></div>
      <div class="rada r2">
        ${pole({ k: 'partner0', p: 'Parťák 1', t: 'text' }, (n.partneri || [])[0])}
        ${pole({ k: 'partner1', p: 'Parťák 2', t: 'text' }, (n.partneri || [])[1])}
        ${pole({ k: 'kmDenOdhad', p: 'Výchozí odhad km/den výpůjčky', t: 'cislo' }, n.kmDenOdhad)}
        ${pole({ k: 'sazbaHodina', p: 'Sazba za hodinu práce (vklady, Kč)', t: 'cislo' }, n.sazbaHodina)}
      </div>
    </div>
    <div class="blok">
      <div class="blok-hl"><h4>Živý monitoring aut (GPS)</h4><div class="mezera"></div><button class="btn mala hlavni" data-akce="uloz-traccar">Uložit</button></div>
      <p style="font-size:12.5px;color:var(--khaki);margin:0 0 10px">
        Nákup: 4× <b>SinoTrack ST-901L / ST-906L (4G)</b> ~700–900 Kč/ks + datová SIM (~30–50 Kč/měs).
        Krabičky nasměruj na server <b>Traccar</b> (zdarma, open-source) a sem vlož adresu + token —
        kokpit pak ukáže skutečnou polohu a km místo odhadu. Do té doby běží odhad z rezervací.</p>
      <div class="rada r2">
        ${pole({ k: 'url', p: 'Traccar server (URL)', t: 'text', ph: 'https://demo.traccar.org' }, t.url)}
        ${pole({ k: 'token', p: 'API token', t: 'text' }, t.token)}
      </div>
      <div class="rada">
        ${S.vozy.filter((v) => v.typ !== 'stan').map((v) => pole({ k: 'dev-' + v.id, p: 'ID zařízení — ' + v.nazev, t: 'text', ph: 'deviceId z Traccaru' }, (t.zarizeni || {})[v.id])).join('')}
      </div>
      ${t.url && t.token ? `<button class="btn mala" data-akce="test-traccar"><svg class="icon"><use href="#i-poloha"/></svg>Vyzkoušet spojení</button>` : ''}
    </div>
    <div class="blok">
      <div class="blok-hl"><h4>Web poutnik.lovable.app (Supabase)</h4><div class="mezera"></div><button class="btn mala hlavni" data-akce="uloz-supabase">Uložit</button></div>
      <div class="rada">
        ${pole({ k: 'url', p: 'Supabase URL', t: 'text' }, (n.supabase || {}).url)}
        ${pole({ k: 'anonKey', p: 'Anon klíč', t: 'text' }, (n.supabase || {}).anonKey)}
      </div>
    </div>
    <div class="blok">
      <div class="blok-hl"><h4>Přihlášení</h4></div>
      <button class="btn" data-akce="prepni-uzivatele">Přepnout uživatele</button>
      <button class="btn nic pozor" data-akce="odhlasit">Odhlásit z tohohle prohlížeče</button>
    </div>
  </div>`;
}

async function testTraccar() {
  const t = S.nastaveni.traccar || {};
  try {
    const r = await fetch(String(t.url).replace(/\/$/, '') + '/api/devices', { headers: { Authorization: 'Bearer ' + t.token } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const zarizeni = await r.json();
    hlaska(`Traccar odpovídá — vidím ${zarizeni.length} zařízení.`);
  } catch (e) {
    hlaska('Traccar nedostupný: ' + e.message + ' (zkontroluj URL, token a CORS na serveru)', 'chyba');
  }
}

/* ---------------------------------------------------------- kontrolky šuplík */

function kresliSuplikKontrolky() {
  const vsechny = kontrolky();
  $('#suplik').innerHTML = `
  <div class="s-hl">
    <h2>Kontrolky</h2>
    <div style="flex:1"></div>
    <button class="hl-btn" data-akce="zavri"><svg class="icon"><use href="#i-krizek"/></svg></button>
  </div>
  <div class="s-telo">
    ${vsechny.length ? vsechny.map((k) => `
      <div class="seznam-radek">
        ${lampaHtml(k.druh === 'hori' ? 'var(--cervena)' : k.druh === 'varuje' ? 'var(--amber)' : 'var(--khaki)')}
        <span>${k.vuz ? `<b>${esc(k.vuz.nazev)}:</b> ` : ''}${esc(k.text)}</span>
        ${k.vuz ? `<button class="btn mala nic" data-otevri-vuz="${k.vuz.id}">otevřít</button>` : ''}
        ${k.rez ? `<button class="btn mala nic" data-otevri-rez="${k.rez.id}">otevřít</button>` : ''}
      </div>`).join('') : '<div class="prazdno">Nic nesvítí. Paráda.</div>'}
  </div>`;
}

/* ---------------------------------------------------------- WEB (Supabase most) */

async function supabaseFetch(cesta) {
  const sb = S.nastaveni.supabase || {};
  if (!sb.url || !sb.anonKey) throw new Error('V Nastavení chybí Supabase URL nebo anon klíč.');
  const r = await fetch(String(sb.url).replace(/\/$/, '') + '/rest/v1/' + cesta, {
    headers: { apikey: sb.anonKey, Authorization: 'Bearer ' + sb.anonKey },
  });
  if (!r.ok) throw new Error('Supabase vrátil ' + r.status);
  return r.json();
}

async function nactiPoptavkyZWebu() {
  hlaska('Načítám poptávky z webu…');
  try {
    const [bookings, vehicles] = await Promise.all([
      supabaseFetch('bookings?select=*&order=created_at.desc&limit=50'),
      supabaseFetch('vehicles?select=*'),
    ]);
    otevriSuplik({ typ: 'web', bookings, vehicles, rezim: 'poptavky' });
  } catch (e) { hlaska(e.message, 'chyba'); }
}

async function porovnejSWebem() {
  hlaska('Načítám vozy z webu…');
  try {
    const vehicles = await supabaseFetch('vehicles?select=*');
    otevriSuplik({ typ: 'web', vehicles, rezim: 'porovnani' });
  } catch (e) { hlaska(e.message, 'chyba'); }
}

/* Nabídka polí v cizí tabulce neznáme jistě — čteme obvyklá jména a zbytek ukážeme. */
function bookingPole(b, ...jmena) {
  for (const j of jmena) if (b[j] != null && b[j] !== '') return b[j];
  return null;
}

function kresliSuplikWebu(o) {
  const s = $('#suplik');
  if (o.rezim === 'poptavky') {
    const uzMame = new Set(S.rezervace.map((r) => r.webId).filter(Boolean));
    s.innerHTML = `
    <div class="s-hl">
      <h2>Poptávky z webu</h2>
      <div style="flex:1"></div>
      <button class="hl-btn" data-akce="zavri"><svg class="icon"><use href="#i-krizek"/></svg></button>
    </div>
    <div class="s-telo">
      ${o.bookings.length ? o.bookings.map((b, i) => {
        const jmeno = bookingPole(b, 'name', 'customer_name', 'full_name', 'jmeno') || 'bez jména';
        const od = String(bookingPole(b, 'start_date', 'from', 'date_from', 'od') || '').slice(0, 10);
        const doD = String(bookingPole(b, 'end_date', 'to', 'date_to', 'do') || '').slice(0, 10);
        const vid = bookingPole(b, 'vehicle_id', 'vehicle');
        const webVuz = (o.vehicles || []).find((v) => v.id === vid);
        const dovezene = uzMame.has(String(b.id));
        return `
        <div class="blok">
          <div class="blok-hl">
            <h4>${esc(jmeno)} · ${od ? denCesky(od) : '?'} – ${doD ? denCesky(doD) : '?'}</h4>
            <div class="mezera"></div>
            ${dovezene ? '<span class="stitek">už v kokpitu</span>' : `<button class="btn mala hlavni" data-akce="import-booking" data-i="${i}">Převzít jako poptávku</button>`}
          </div>
          <div style="font-size:12.5px;color:var(--khaki)">
            ${webVuz ? `vůz na webu: <b>${esc(webVuz.name)}</b> · ` : ''}
            ${esc(bookingPole(b, 'email') || '')} ${esc(bookingPole(b, 'phone', 'tel') || '')}
            ${bookingPole(b, 'message', 'note', 'zprava') ? `<br>„${esc(bookingPole(b, 'message', 'note', 'zprava'))}"` : ''}
          </div>
        </div>`;
      }).join('') : '<div class="prazdno">Na webu zatím žádné poptávky nejsou. Jakmile rezervační systém poběží, objeví se tady.</div>'}
    </div>`;
    return;
  }

  /* porovnání flotily s webem + prompt pro Lovable */
  const webova = o.vehicles || [];
  const prompt = lovablePrompt();
  s.innerHTML = `
  <div class="s-hl">
    <h2>Kokpit × web</h2>
    <div style="flex:1"></div>
    <button class="hl-btn" data-akce="zavri"><svg class="icon"><use href="#i-krizek"/></svg></button>
  </div>
  <div class="s-telo">
    <div class="blok">
      <div class="blok-hl"><h4>Vozy na webu (${webova.length})</h4></div>
      ${webova.map((v) => `<div class="seznam-radek"><span><b>${esc(v.name)}</b> · ${esc(v.category || '')} · ${kc(v.price_per_day)}/den</span>${v.is_active === false ? '<span class="stitek">skrytý</span>' : ''}</div>`).join('') || '<div class="prazdno">Web nevrátil žádné vozy.</div>'}
    </div>
    <div class="blok">
      <div class="blok-hl"><h4>Skutečná flotila v kokpitu (${S.vozy.filter((v) => v.aktivni !== false).length})</h4></div>
      ${S.vozy.filter((v) => v.aktivni !== false).map((v) => `<div class="seznam-radek"><span><b>${esc(v.nazev)}</b> · ${kc(v.cenaDen)}/den</span></div>`).join('')}
    </div>
    <div class="blok">
      <div class="blok-hl"><h4>Prompt pro Lovable — aktualizace webu</h4><div class="mezera"></div><button class="btn mala hlavni" data-akce="kopiruj-prompt">Zkopírovat</button></div>
      <textarea id="lovable-prompt" style="min-height:220px;font:12px var(--mono)">${esc(prompt)}</textarea>
    </div>
  </div>`;
}

function lovablePrompt() {
  const flotila = S.vozy.filter((v) => v.aktivni !== false).map((v) => ({
    name: v.nazev,
    category: { pickup: 'Prémiový pick-up', obytnak: 'Obytný vůz', teren: 'Terénní vůz', dodavka: 'Kempingový vůz', stan: 'Střešní stan' }[v.typ] || v.typ,
    price_per_day: v.cenaDen,
    description: v.poznamka || '',
    is_active: true,
  }));
  return `Aktualizuj nabídku vozů v Supabase tabulce "vehicles" podle skutečné flotily.
Smaž nebo deaktivuj vozy, které v seznamu nejsou. Zachovej strukturu tabulky a fotky nahraď
placeholderem, dokud nedodáme skutečné. U střešního stanu přidej poznámku, že se dá
kombinovat s Land Cruiserem, Mercedesem X i Multivanem, nebo půjčit samostatně.

Skutečná flotila (JSON):
${JSON.stringify(flotila, null, 2)}

Dále: rezervační formulář ukládej do tabulky "bookings" se sloupci name, email, phone,
vehicle_id, start_date, end_date, message — kokpit si je odtud stahuje.`;
}

async function importujBooking(o, i) {
  const b = o.bookings[i];
  if (!b) return;
  const jmeno = bookingPole(b, 'name', 'customer_name', 'full_name', 'jmeno') || 'bez jména';
  const email = bookingPole(b, 'email');
  const tel = bookingPole(b, 'phone', 'tel');
  const od = String(bookingPole(b, 'start_date', 'from', 'date_from', 'od') || dnesISO()).slice(0, 10);
  const doD = String(bookingPole(b, 'end_date', 'to', 'date_to', 'do') || od).slice(0, 10);
  const vid = bookingPole(b, 'vehicle_id', 'vehicle');
  const webVuz = (o.vehicles || []).find((v) => v.id === vid);
  /* Zkusíme web-vůz přiřadit ke skutečnému podle jména. */
  const nasVuz = webVuz ? S.vozy.find((v) => v.nazev.toLowerCase().split(' ').some((slovo) => slovo.length > 3 && String(webVuz.name).toLowerCase().includes(slovo))) : null;

  let kid = S.kontakty.find((k) => (email && k.email === email) || (tel && k.tel === tel))?.id;
  if (!kid) {
    kid = uid('ko');
    await uloz(`Kontakt z webu: ${jmeno}`, SOUBORY.kontakty, (d) => {
      d.polozky = d.polozky || [];
      d.polozky.push({ id: kid, jmeno, tel: tel || '', email: email || '', mesto: '', stitky: ['web'], pozn: '', vytvoreno: nyni() });
    });
  }
  const ok = await uloz(`Poptávka z webu: ${jmeno}`, SOUBORY.rezervace, (d) => {
    d.polozky = d.polozky || [];
    if (d.polozky.some((r) => r.webId === String(b.id))) return;
    d.polozky.push({
      id: uid('rz'), webId: String(b.id), vozy: nasVuz ? [nasVuz.id] : [], od, do: doD,
      stav: 'poptavka', kontakt: kid, jmeno, castka: null, zaloha: null, zdroj: 'web',
      kmPred: null, kmPo: null,
      pozn: [bookingPole(b, 'message', 'note', 'zprava'), webVuz ? `web: ${webVuz.name}` : null].filter(Boolean).join(' · '),
      vytvoril: JA.jmeno, vytvoreno: b.created_at || nyni(),
    });
  });
  if (ok) { hlaska('Poptávka převzata do kalendáře.'); zavriSuplik(); }
}

/* ---------------------------------------------------------- uploady */

function zmensiObrazek(soubor) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(soubor);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1600;
      const pomer = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * pomer);
      c.height = Math.round(img.height * pomer);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((blob) => blob ? resolve(blob) : reject(new Error('nezmenšeno')), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('obrázek nejde přečíst')); };
    img.src = url;
  });
}

async function nahrajDokumenty(vuzId, zaznamId, soubory) {
  const v = vuz(vuzId);
  if (!v) return;
  for (const soubor of soubory) {
    let blob = soubor;
    if (/^image\//.test(soubor.type)) {
      try { blob = await zmensiObrazek(soubor); } catch {}
    }
    if (blob.size > 6 * 1024 * 1024) { hlaska(`${soubor.name} je moc velký (max 6 MB).`, 'chyba'); continue; }
    const bajty = new Uint8Array(await blob.arrayBuffer());
    const bezpecne = soubor.name.replace(/[^\w.\-]+/g, '_').slice(-60).replace(/^\.+/, '') || 'soubor';
    const jmeno = (/^image\//.test(soubor.type) && !/\.jpe?g$/i.test(bezpecne)) ? bezpecne.replace(/\.\w+$/, '') + '.jpg' : bezpecne;
    const cesta = `docs/${vuzId}/${Date.now()}-${jmeno}`;
    try {
      hlaska(`Nahrávám ${jmeno}…`);
      await GH.nahrajSoubor(cesta, bajtyNaB64(bajty), `Doklad k ${v.nazev}: ${jmeno}`);
      await ulozVuz(`Příloha serviska ${v.nazev}`, vuzId, (x) => {
        const z = (x.servis || []).find((s) => s.id === zaznamId);
        if (z) { z.dokumenty = z.dokumenty || []; z.dokumenty.push({ nazev: jmeno, cesta }); }
      });
    } catch (e) { hlaska(e.message, 'chyba'); }
  }
}

async function otevriDokument(vuzId, zaznamId, i) {
  const z = (vuz(vuzId)?.servis || []).find((s) => s.id === zaznamId);
  const dok = z?.dokumenty?.[i];
  if (!dok) return;
  try {
    hlaska('Stahuji…');
    const blob = await GH.stahniSoubor(dok.cesta);
    const typ = /\.pdf$/i.test(dok.nazev) ? 'application/pdf' : 'image/jpeg';
    const url = URL.createObjectURL(new Blob([blob], { type: typ }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { hlaska(e.message, 'chyba'); }
}

/* ============================================================
   UDÁLOSTI
   ============================================================ */

document.addEventListener('click', async (u) => {
  const el = u.target.closest('[data-akce], [data-otevri-vuz], [data-otevri-rez], [data-z], [data-pod], [data-novy-den]');
  if (!el) return;

  if (el.dataset.z) {
    UI.zalozka = el.dataset.z;
    localStorage.setItem('poutnik.zalozka', UI.zalozka);
    return vykresli();
  }
  if (el.dataset.otevriVuz) return otevriSuplik({ typ: 'vuz', id: el.dataset.otevriVuz });
  if (el.dataset.otevriRez) return otevriSuplik({ typ: 'rezervace', id: el.dataset.otevriRez });
  if (el.dataset.pod && UI.otevreno) { UI.otevreno.pod = el.dataset.pod; return kresliSuplik(); }
  if (el.dataset.novyDen) {
    return otevriSuplik({ typ: 'rezervace', id: null, predvyplneno: { vozy: [el.dataset.vuz], od: el.dataset.novyDen, do: pridejDni(el.dataset.novyDen, 3), stav: 'poptavka' } });
  }

  const akce = el.dataset.akce;
  const id = el.dataset.id;
  const o = UI.otevreno;

  const akceMapa = {
    zavri: () => zavriSuplik(),
    'dialog-zavri': () => $('#rychly').close(),
    'dialog-potvrd': () => potvrdDialogKm(el.dataset.rezim, id),

    'kal-posun': () => {
      const [r, m] = UI.kalMesic.split('-').map(Number);
      const d = new Date(r, m - 1 + Number(el.dataset.smer), 1);
      UI.kalMesic = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      vykresli();
    },
    'kal-dnes': () => { UI.kalMesic = dnesISO().slice(0, 7); vykresli(); },

    'nova-rez': () => otevriSuplik({ typ: 'rezervace', id: null, predvyplneno: { vozy: [], od: dnesISO(), do: pridejDni(dnesISO(), 3), stav: 'poptavka' } }),
    'rez-potvrd': () => ulozPolozku('Rezervace potvrzena', SOUBORY.rezervace, id, (p) => { p.stav = 'potvrzeno'; }),
    'rez-vydej': () => dialogKm(S.rezervace.find((r) => r.id === id), 'vydej'),
    'rez-vrat': () => dialogKm(S.rezervace.find((r) => r.id === id), 'vrat'),
    'rez-zrus': async () => {
      if (!confirm('Zrušit tuhle rezervaci?')) return;
      await ulozPolozku('Rezervace zrušena', SOUBORY.rezervace, id, (p) => { p.stav = 'zruseno'; });
      zavriSuplik();
    },
    'uloz-rez': async () => {
      const telo = $('#suplik .s-telo');
      const hodnoty = sesbirej(telo);
      const vozyVybrane = $$('[data-rez-vuz]', telo).filter((ch) => ch.checked).map((ch) => ch.dataset.rezVuz);
      if (!hodnoty.od || !hodnoty.do || hodnoty.do < hodnoty.od) return hlaska('Zkontroluj termín od–do.', 'chyba');
      if (!vozyVybrane.length) return hlaska('Vyber aspoň jeden vůz.', 'chyba');
      if (id) {
        await ulozPolozku('Úprava rezervace', SOUBORY.rezervace, id, (p) => Object.assign(p, hodnoty, { vozy: vozyVybrane }));
      } else {
        await uloz('Nová rezervace — ' + (hodnoty.jmeno || kontakt(hodnoty.kontakt)?.jmeno || 'bez jména'), SOUBORY.rezervace, (d) => {
          d.polozky = d.polozky || [];
          d.polozky.push({ id: uid('rz'), ...hodnoty, vozy: vozyVybrane, vytvoril: JA.jmeno, vytvoreno: nyni() });
        });
      }
      zavriSuplik();
    },

    'novy-vuz': async () => {
      const idN = uid('vuz');
      const barvy = ['#D97B4F', '#7FA65A', '#E3B341', '#6FA8AD', '#A78BC0', '#C46A85', '#7B8FC4'];
      await uloz('Nový vůz', SOUBORY.vozy, (d) => {
        d.vozy.push({ id: idN, nazev: 'Nový vůz', typ: 'teren', barva: barvy[d.vozy.length % barvy.length], rok: null, spz: '', aktivni: true, cenaDen: null, kauce: null, poznamka: '', tachometr: [], vybava: [], leasing: {}, pojisteni: [], servis: [], milniky: [] });
      });
      otevriSuplik({ typ: 'vuz', id: idN });
    },
    'smaz-vuz': async () => {
      if (!o?.id || !confirm('Opravdu smazat celý vůz včetně servisky a vybavení? (Rezervace zůstanou.)')) return;
      await uloz('Smazán vůz', SOUBORY.vozy, (d) => { d.vozy = d.vozy.filter((v) => v.id !== o.id); });
      zavriSuplik();
    },
    'uloz-zaklad': () => {
      const hodnoty = sesbirej(el.closest('.blok'));
      hodnoty.aktivni = hodnoty.aktivni === 'true';
      return ulozVuz('Úprava vozu', o.id, (v) => Object.assign(v, hodnoty));
    },
    'uloz-leasing': () => ulozVuz('Leasing upraven', o.id, (v) => { v.leasing = { ...v.leasing, ...sesbirej(el.closest('.blok')) }; }),

    'pridej-pojisteni': () => ulozVuz('Nová pojistka', o.id, (v) => { v.pojisteni = v.pojisteni || []; v.pojisteni.push({ id: uid('po'), druh: '', spolecnost: '', cisloSmlouvy: '', rocne: null, platiDo: '', pozn: '' }); }),
    'uloz-pojisteni': () => ulozVuz('Pojistka upravena', o.id, (v) => { const p = v.pojisteni.find((x) => x.id === id); if (p) Object.assign(p, sesbirej(el.closest('[data-id]'))); }),
    'smaz-pojisteni': () => ulozVuz('Pojistka smazána', o.id, (v) => { v.pojisteni = v.pojisteni.filter((x) => x.id !== id); }),

    'pridej-vybavu': () => ulozVuz('Věc do packu', o.id, (v) => { v.vybava = v.vybava || []; v.vybava.push({ id: uid('vb'), nazev: '', ks: 1, pozn: '' }); }),
    'uloz-vybavu': () => ulozVuz('Pack upraven', o.id, (v) => { const b = v.vybava.find((x) => x.id === id); if (b) Object.assign(b, sesbirej(el.closest('[data-id]'))); }),
    'smaz-vybavu': () => ulozVuz('Věc z packu smazána', o.id, (v) => { v.vybava = v.vybava.filter((x) => x.id !== id); }),

    'pridej-servis': () => ulozVuz('Nový zápis servisky', o.id, (v) => { v.servis = v.servis || []; v.servis.push({ id: uid('se'), datum: dnesISO(), km: null, cena: null, popis: '', dokumenty: [] }); }),
    'uloz-servis': () => ulozVuz('Serviska upravena', o.id, (v) => { const z = v.servis.find((x) => x.id === id); if (z) Object.assign(z, sesbirej(el.closest('[data-id]'))); }),
    'smaz-servis': async () => {
      if (!confirm('Smazat zápis ze servisky? Přílohy zůstanou v archivu.')) return;
      return ulozVuz('Zápis servisky smazán', o.id, (v) => { v.servis = v.servis.filter((x) => x.id !== id); });
    },
    'otevri-dok': () => otevriDokument(o.id, id, +el.dataset.i),
    'smaz-dok': async () => {
      const z = (vuz(o.id)?.servis || []).find((s) => s.id === id);
      const dok = z?.dokumenty?.[+el.dataset.i];
      if (!dok || !confirm(`Smazat přílohu ${dok.nazev}?`)) return;
      try { await GH.smazSoubor(dok.cesta, 'Smazána příloha ' + dok.nazev); } catch {}
      return ulozVuz('Příloha smazána', o.id, (v) => { const zz = v.servis.find((s) => s.id === id); if (zz) zz.dokumenty.splice(+el.dataset.i, 1); });
    },

    'pridej-tacho': async () => {
      const km = prompt('Stav tachometru (km):');
      if (km == null || km.trim() === '' || Number.isNaN(+km)) return;
      return ulozVuz('Zápis tachometru', o.id, (v) => { v.tachometr = v.tachometr || []; v.tachometr.push({ id: uid('ta'), datum: dnesISO(), km: +km, kdo: JA.jmeno, pozn: 'ruční zápis' }); });
    },
    'smaz-tacho': () => ulozVuz('Zápis tachometru smazán', o.id, (v) => { v.tachometr = v.tachometr.filter((x) => x.id !== id); }),

    'pridej-milnik': () => ulozVuz('Nový milník', o.id, (v) => { v.milniky = v.milniky || []; v.milniky.push({ id: uid('mi'), nazev: '', typ: 'datum', hodnota: '', pozn: '' }); }),
    'uloz-milnik': () => ulozVuz('Milník upraven', o.id, (v) => { const m = v.milniky.find((x) => x.id === id); if (m) { const h = sesbirej(el.closest('[data-id]')); if (h.typ === 'km') h.hodnota = h.hodnota === '' || h.hodnota == null ? null : +h.hodnota; Object.assign(m, h); } }),
    'smaz-milnik': () => ulozVuz('Milník smazán', o.id, (v) => { v.milniky = v.milniky.filter((x) => x.id !== id); }),

    'novy-kontakt': () => otevriSuplik({ typ: 'kontakt', id: null }),
    'uprav-kontakt': () => otevriSuplik({ typ: 'kontakt', id }),
    'smaz-kontakt': async () => {
      if (!confirm('Smazat kontakt? Rezervace zůstanou, jen ztratí vazbu.')) return;
      return uloz('Kontakt smazán', SOUBORY.kontakty, (d) => { d.polozky = d.polozky.filter((k) => k.id !== id); });
    },
    'uloz-kontakt': async () => {
      const hodnoty = sesbirej($('#suplik .s-telo'));
      if (!hodnoty.jmeno) return hlaska('Jméno je potřeba.', 'chyba');
      hodnoty.stitky = String(hodnoty.stitky || '').split(',').map((x) => x.trim()).filter(Boolean);
      hodnoty.dokladOk = hodnoty.dokladOk === 'ano';
      if (id) await ulozPolozku('Kontakt upraven', SOUBORY.kontakty, id, (p) => Object.assign(p, hodnoty));
      else await uloz('Nový kontakt — ' + hodnoty.jmeno, SOUBORY.kontakty, (d) => { d.polozky = d.polozky || []; d.polozky.push({ id: uid('ko'), ...hodnoty, vytvoreno: nyni() }); });
      zavriSuplik();
    },

    'novy-ukol': async () => {
      const text = prompt('Co je potřeba udělat?');
      if (!text) return;
      return uloz('Nový úkol', SOUBORY.ukoly, (d) => {
        d.polozky = d.polozky || [];
        d.polozky.push({ id: uid('uk'), text, kategorie: 'jine', vuz: null, kdo: JA.jmeno, priorita: 'stredni', stav: 'otevreny', termin: '', vytvoril: JA.jmeno, vytvoreno: nyni() });
      });
    },
    'ukol-prepni': () => ulozPolozku('Úkol přepnut', SOUBORY.ukoly, id, (p) => { p.stav = p.stav === 'hotovy' ? 'otevreny' : 'hotovy'; p.hotovoKdy = p.stav === 'hotovy' ? nyni() : null; }),
    'smaz-ukol': () => ulozPolozku('Úkol smazán', SOUBORY.ukoly, id, () => {}) && uloz('Úkol smazán', SOUBORY.ukoly, (d) => { d.polozky = d.polozky.filter((x) => x.id !== id); }),

    'pridej-marketing': async () => {
      await uloz('Nová útrata marketingu', SOUBORY.finance, (d) => {
        d.marketing = d.marketing || [];
        d.marketing.push({ id: uid('mk'), datum: dnesISO(), platforma: 'Meta Ads', kampan: '', castka: null, odkaz: '', imprese: null, kliky: null, poptavky: null, pozn: '' });
      });
      const posledni = S.finance.marketing[S.finance.marketing.length - 1];
      dialogMarketing(posledni);
    },
    'uprav-marketing': () => dialogMarketing((S.finance.marketing || []).find((m) => m.id === id)),
    'smaz-marketing': () => uloz('Útrata smazána', SOUBORY.finance, (d) => { d.marketing = d.marketing.filter((m) => m.id !== id); }),
    'uloz-marketing-dialog': async () => {
      const hodnoty = sesbirej($('#rychly'));
      await uloz('Útrata marketingu upravena', SOUBORY.finance, (d) => { const m = d.marketing.find((x) => x.id === id); if (m) Object.assign(m, hodnoty); });
      $('#rychly').close();
    },

    'pridej-investici': () => dialogInvestice(),
    'uloz-investici-dialog': async () => {
      const hodnoty = sesbirej($('#rychly'));
      if (!hodnoty.popis) return hlaska('Napiš, co to bylo.', 'chyba');
      await uloz('Vklad zapsán', SOUBORY.finance, (d) => {
        d.investice = d.investice || [];
        d.investice.push({ id: uid('in'), ...hodnoty });
      });
      $('#rychly').close();
    },
    'smaz-investici': async () => {
      if (!confirm('Smazat tenhle vklad?')) return;
      return uloz('Vklad smazán', SOUBORY.finance, (d) => { d.investice = d.investice.filter((i) => i.id !== id); });
    },

    'nacti-web': () => nactiPoptavkyZWebu(),
    'porovnat-web': () => porovnejSWebem(),
    'import-booking': () => importujBooking(o, +el.dataset.i),
    'kopiruj-prompt': async () => {
      await navigator.clipboard.writeText($('#lovable-prompt').value);
      hlaska('Prompt zkopírován — vlož ho do Lovable chatu.');
    },

    'uloz-nastaveni': () => {
      const hodnoty = sesbirej(el.closest('.blok'));
      return uloz('Nastavení upraveno', SOUBORY.nastaveni, (d) => {
        d.partneri = [hodnoty.partner0 || 'Parťák 1', hodnoty.partner1 || 'Parťák 2'];
        d.kmDenOdhad = hodnoty.kmDenOdhad || 140;
        d.sazbaHodina = hodnoty.sazbaHodina || 0;
      });
    },
    'uloz-traccar': () => {
      const blok = el.closest('.blok');
      const hodnoty = sesbirej(blok);
      return uloz('Nastavení Traccaru', SOUBORY.nastaveni, (d) => {
        d.traccar = { url: hodnoty.url || '', token: hodnoty.token || '', zarizeni: {} };
        for (const [k, v] of Object.entries(hodnoty)) if (k.startsWith('dev-') && v) d.traccar.zarizeni[k.slice(4)] = v;
      });
    },
    'test-traccar': () => testTraccar(),
    'uloz-supabase': () => {
      const hodnoty = sesbirej(el.closest('.blok'));
      return uloz('Nastavení Supabase', SOUBORY.nastaveni, (d) => { d.supabase = { url: hodnoty.url || '', anonKey: hodnoty.anonKey || '' }; });
    },

    'prepni-uzivatele': () => { localStorage.removeItem('poutnik.ja'); location.reload(); },
    odhlasit: () => { localStorage.removeItem('poutnik.token'); localStorage.removeItem('poutnik.ja'); location.reload(); },
  };

  if (akceMapa[akce]) { u.preventDefault(); await akceMapa[akce](); }
});

/* Hlavička */
$('#btn-obnovit').addEventListener('click', async () => {
  $('#btn-obnovit').classList.add('tocise');
  try { await nactiVse(); vykresli(); hlaska('Data obnovena.'); }
  catch (e) { hlaska(e.message, 'chyba'); }
  finally { if (!UI.ukladam) $('#btn-obnovit').classList.remove('tocise'); }
});
$('#btn-nastaveni').addEventListener('click', () => otevriSuplik({ typ: 'nastaveni' }));
$('#btn-zvon').addEventListener('click', () => otevriSuplik({ typ: 'kontrolky' }));
$('#btn-ja').addEventListener('click', () => otevriSuplik({ typ: 'nastaveni' }));
$('#zaclona').addEventListener('click', zavriSuplik);
document.addEventListener('keydown', (u) => { if (u.key === 'Escape' && UI.otevreno) zavriSuplik(); });

/* vstupy (hledání, filtry) */
document.addEventListener('input', (u) => {
  const el = u.target.closest('[data-akce-vstup]');
  if (!el) return;
  if (el.dataset.akceVstup === 'hledej-kontakt') {
    UI.hledatKontakt = el.value;
    const poz = el.selectionStart;
    vykresli();
    const nove = $('[data-akce-vstup="hledej-kontakt"]');
    if (nove) { nove.focus(); nove.setSelectionRange(poz, poz); }
  }
});
document.addEventListener('change', async (u) => {
  const el = u.target.closest('[data-akce-zmena], [data-akce-file], [data-rez-vuz]');
  if (!el) return;
  if (el.dataset.akceZmena === 'fin-obdobi') { UI.finObdobi = el.value; localStorage.setItem('poutnik.finobdobi', el.value); return vykresli(); }
  if (el.dataset.akceZmena === 'ukol-filtr') { UI.ukolFiltr = el.value; return vykresli(); }
  if (el.dataset.akceFile === 'nahraj-dok') {
    const soubory = [...el.files];
    el.value = '';
    if (soubory.length && UI.otevreno?.typ === 'vuz') await nahrajDokumenty(UI.otevreno.id, el.dataset.id, soubory);
    return;
  }
  if (el.dataset.rezVuz != null && UI.otevreno?.typ === 'rezervace') {
    /* překreslit výběr vozů (barevné chipy) se zachováním rozepsaného formuláře */
    const telo = $('#suplik .s-telo');
    const hodnoty = sesbirej(telo);
    const vybrane = $$('[data-rez-vuz]', telo).filter((ch) => ch.checked).map((ch) => ch.dataset.rezVuz);
    if (UI.otevreno.id) {
      /* u existující rezervace jen vizuální stav chipu */
      const stitek = el.closest('.stitek');
      const v = vuz(el.dataset.rezVuz);
      if (el.checked) { stitek.style.background = v.barva; stitek.style.color = 'var(--noc)'; stitek.style.borderColor = v.barva; }
      else { stitek.style.background = ''; stitek.style.color = ''; stitek.style.borderColor = ''; }
    } else {
      UI.otevreno.predvyplneno = { ...UI.otevreno.predvyplneno, ...hodnoty, vozy: vybrane };
      kresliSuplik();
    }
  }
});

/* Dialogy marketingu a investic */
function dialogMarketing(m) {
  if (!m) return;
  const d = $('#rychly');
  d.innerHTML = `
    <h2 style="font-size:19px;margin-bottom:12px">Útrata za marketing</h2>
    <div class="rada r2">
      ${pole({ k: 'datum', p: 'Datum', t: 'datum' }, m.datum)}
      ${pole({ k: 'platforma', p: 'Platforma', t: 'select', moznosti: ['Meta Ads', 'Google Ads', 'Sklik', 'tisk/letáky', 'jiné'].map((x) => ({ v: x, p: x })) }, m.platforma)}
      ${pole({ k: 'castka', p: 'Částka (Kč)', t: 'cislo' }, m.castka)}
      ${pole({ k: 'kampan', p: 'Kampaň', t: 'text', ph: 'léto — obytňák' }, m.kampan)}
      ${pole({ k: 'imprese', p: 'Imprese', t: 'cislo' }, m.imprese)}
      ${pole({ k: 'kliky', p: 'Kliky', t: 'cislo' }, m.kliky)}
      ${pole({ k: 'poptavky', p: 'Poptávky z kampaně', t: 'cislo' }, m.poptavky)}
      ${pole({ k: 'odkaz', p: 'Odkaz na statistiky', t: 'text', ph: 'https://…' }, m.odkaz)}
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn nic" data-akce="dialog-zavri">Zavřít</button>
      <button class="btn hlavni" data-akce="uloz-marketing-dialog" data-id="${m.id}">Uložit</button>
    </div>`;
  d.showModal();
}

function dialogInvestice() {
  const d = $('#rychly');
  d.innerHTML = `
    <h2 style="font-size:19px;margin-bottom:12px">Zapsat vklad do firmy</h2>
    <div class="rada r2">
      ${pole({ k: 'kdo', p: 'Kdo', t: 'select', moznosti: (S.nastaveni.partneri || []).map((p) => ({ v: p, p })) }, JA.jmeno)}
      ${pole({ k: 'datum', p: 'Datum', t: 'datum' }, dnesISO())}
      ${pole({ k: 'typ', p: 'Druh', t: 'select', moznosti: [{ v: 'penize', p: 'peníze' }, { v: 'vec', p: 'věc (hodnota v Kč)' }, { v: 'cas', p: 'čas (hodiny)' }] }, 'penize')}
      ${pole({ k: 'castka', p: 'Částka / hodnota (Kč)', t: 'cislo' }, '')}
      ${pole({ k: 'hodiny', p: 'Hodiny (u času)', t: 'cislo' }, '')}
    </div>
    <div class="rada">${pole({ k: 'popis', p: 'Co to bylo', t: 'text', ph: 'kauce na leasing, střešní stan, víkend oprav…' }, '')}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn nic" data-akce="dialog-zavri">Zavřít</button>
      <button class="btn hlavni" data-akce="uloz-investici-dialog">Zapsat</button>
    </div>`;
  d.showModal();
}

/* ============================================================
   PŘIHLÁŠENÍ A START
   ============================================================ */

function ukazKdoJsem() {
  $('#brana-form').classList.add('skryto');
  $('#brana-chyba').textContent = '';
  const kdo = $('#brana-kdo');
  kdo.classList.remove('skryto');
  kdo.innerHTML = `<p style="color:var(--khaki);font-size:13.5px;margin:0 0 4px">Kdo jsi? Každá změna se podepisuje.</p>` +
    (S.nastaveni.partneri || ['Franta', 'Parťák']).map((p) => `<button class="btn" data-kdo="${esc(p)}">${esc(p)}</button>`).join('');
  $$('#brana-kdo [data-kdo]').forEach((b) => b.addEventListener('click', () => {
    JA.jmeno = b.dataset.kdo;
    localStorage.setItem('poutnik.ja', JSON.stringify({ jmeno: JA.jmeno, otisk: otiskKlicu() }));
    spustApp();
  }));
}

function spustApp() {
  $('#brana').classList.add('skryto');
  $('#app').classList.remove('skryto');
  vykresli();
  spustSynchronizaci();
}

async function prihlasSe(token) {
  GH.token = token;
  $('#brana-chyba').textContent = '';
  $('#brana-info').textContent = 'Načítám data…';
  try {
    await nactiVse();
  } catch (e) {
    $('#brana-info').textContent = '';
    $('#brana-chyba').textContent = e.message;
    localStorage.removeItem('poutnik.token');
    $('#brana-form').classList.remove('skryto');
    return;
  }
  $('#brana-info').textContent = '';
  const ulozeny = JSON.parse(localStorage.getItem('poutnik.ja') || 'null');
  if (ulozeny && ulozeny.otisk === otiskKlicu() && (S.nastaveni.partneri || []).includes(ulozeny.jmeno)) {
    JA.jmeno = ulozeny.jmeno;
    spustApp();
  } else {
    ukazKdoJsem();
  }
}

$('#brana-form').addEventListener('submit', async (u) => {
  u.preventDefault();
  const heslo = $('#brana-heslo').value;
  if (!heslo) return;
  $('#brana-chyba').textContent = '';
  $('#brana-info').textContent = 'Odemykám…';
  const token = await odemkni(heslo);
  $('#brana-info').textContent = '';
  if (!token) { $('#brana-chyba').textContent = 'Špatné heslo.'; return; }
  /* Token zůstává jen v tomhle prohlížeči, svázaný s otiskem klíče. */
  localStorage.setItem('poutnik.token', JSON.stringify({ token, otisk: otiskKlicu() }));
  prihlasSe(token);
});

(function start() {
  if (DEMO) {
    zapniDemo();
    JA.jmeno = 'Franta';
    nactiVse().then(() => { spustApp(); });
    return;
  }
  const maBlob = Object.values(CFG.blobs || {}).some(Boolean);
  if (!maBlob) {
    $('#brana-form').classList.add('skryto');
    $('#brana-info').innerHTML = 'Kokpit ještě nemá nastavený přístup k datům.<br>' +
      'Na Macu v repu spusť <b style="font-family:var(--mono)">python3 nastav_pristup.py</b> a nasaď.<br><br>' +
      '<a href="?demo=1">Mezitím se podívej na demo s ukázkovými daty →</a>';
    return;
  }
  const ulozeny = JSON.parse(localStorage.getItem('poutnik.token') || 'null');
  if (ulozeny && ulozeny.otisk === otiskKlicu()) {
    $('#brana-form').classList.add('skryto');
    prihlasSe(ulozeny.token);
  }
})();
