#!/usr/bin/env node
/* port.folio Fab — récupération des cours côté serveur (GitHub Actions).
 *
 * Pourquoi : dans un navigateur, appeler Yahoo exige un proxy CORS gratuit,
 * instable et limité en débit. Ici le code tourne sur un serveur GitHub :
 * aucune restriction CORS, aucun proxy, aucune limite de débit.
 * Le résultat est écrit dans prices.json, servi par GitHub Pages sur le MÊME
 * domaine que l'application -> chargement instantané et fiable à 100 %.
 *
 * Sortie : prices.json { updated, eurusd, prices:{TICKER:px}, stale:[...] }
 */
const fs = require("fs");

const YF = {
  FTI:"FTI", HPE:"HPE", AMZN:"AMZN", MC:"MC.PA", NATO:"NATO.L", NVDA:"NVDA",
  ABUS:"ABUS", GAD:"DFND.MI", MSFT:"MSFT", SPY:"SPY",
  CEG:"CEG", PLTR:"PLTR", FCX:"FCX", ASML:"ASML", URA:"URA",
  SMH:"SMH", NLR:"NLR", ITA:"ITA", IGV:"IGV", COPX:"COPX", XLE:"XLE"
};

// Bornes anti-aberration : un cours hors de ces limites est rejeté.
const BOUNDS = {
  FTI:[10,300], HPE:[5,200], AMZN:[50,600], MC:[200,1200], NATO:[5,80],
  NVDA:[20,600], ABUS:[0.5,40], GAD:[2,50], MSFT:[100,1200], SPY:[200,1500],
  CEG:[50,1200], PLTR:[5,400], FCX:[5,200], ASML:[200,3000], URA:[5,200],
  SMH:[50,700], NLR:[20,300], ITA:[50,500], IGV:[50,300], COPX:[10,200], XLE:[30,300]
};

// Symboles Stooq (source de SECOURS, gratuite et accessible depuis les IP datacenter de
// GitHub, là où Yahoo bloque parfois). US UNIQUEMENT : même devise (USD) que Yahoo, donc
// aucun risque de conversion. Les 3 européennes (MC/NATO/GAD) restent Yahoo + reprise de la
// dernière valeur si échec — on évite tout piège de devise (pence GBX de Londres, etc.).
const STOOQ = {
  FTI:"fti.us", HPE:"hpe.us", AMZN:"amzn.us", NVDA:"nvda.us", ABUS:"abus.us",
  MSFT:"msft.us", SPY:"spy.us", CEG:"ceg.us", PLTR:"pltr.us", FCX:"fcx.us",
  ASML:"asml.us", URA:"ura.us", SMH:"smh.us", NLR:"nlr.us", ITA:"ita.us",
  IGV:"igv.us", COPX:"copx.us", XLE:"xle.us"
};

// En-têtes proches d'un vrai navigateur : réduit nettement les blocages datacenter.
const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9"
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchQuote(sym, attempt = 0) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  const host = hosts[attempt % hosts.length];
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const px = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!Number.isFinite(px) || px <= 0) throw new Error("prix invalide");
    return px;
  } catch (e) {
    clearTimeout(to);
    // Sur 401/403/429/999 (blocage ou quota Yahoo), on attend plus longtemps avant de réessayer.
    const throttled = /HTTP (401|403|429|999)/.test(e.message);
    if (attempt < 3) {
      await sleep((throttled ? 2500 : 800) * (attempt + 1));
      return fetchQuote(sym, attempt + 1);
    }
    throw e;
  }
}

// ----- Source de SECOURS : Stooq (CSV) -----
// Lecture PURE (testable sans réseau) : renvoie le cours de clôture, ou lève une erreur.
function parseStooqCsv(txt) {
  const rows = String(txt).trim().split("\n");
  if (rows.length < 2) throw new Error("csv Stooq vide");
  const header = rows[0].split(",").map(s => s.trim().toLowerCase());
  let ci = header.indexOf("close");
  if (ci < 0) ci = 6;                         // format standard sd2t2ohlcv : Close = index 6
  const close = parseFloat(rows[1].split(",")[ci]);
  if (!Number.isFinite(close) || close <= 0) throw new Error("prix Stooq invalide");
  return close;
}

async function fetchStooq(sym) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return parseStooqCsv(await r.text());
  } catch (e) { clearTimeout(to); throw e; }
}

// Orchestrateur par ticker : Yahoo d'abord, Stooq en secours (US uniquement).
async function fetchPrice(key, sym) {
  try { return { px: await fetchQuote(sym), src: "yahoo" }; }
  catch (e1) {
    const ss = STOOQ[key];
    if (!ss) throw e1;
    try { return { px: await fetchStooq(ss), src: "stooq" }; }
    catch (e2) { throw new Error(`yahoo(${e1.message}) + stooq(${e2.message})`); }
  }
}

async function fetchEurUsd() {
  // Banque centrale européenne via Frankfurter : gratuit, sans clé, très stable.
  try {
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR", { headers: UA });
    if (r.ok) {
      const j = await r.json();
      const v = j?.rates?.EUR;
      if (Number.isFinite(v) && v > 0.5 && v < 2) return 1 / v;  // renvoie EUR/USD
    }
  } catch (e) { /* on tente Yahoo ensuite */ }
  try { return await fetchQuote("EURUSD=X"); } catch (e) { return null; }
}

async function main() {
  // Reprise de l'ancien fichier : un ticker qui échoue garde sa dernière valeur connue
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync("prices.json", "utf8")); } catch (e) {}
  const prevPrices = (prev && prev.prices) || {};

  const prices = {};
  const stale = [];
  let freshCount = 0, viaStooq = 0;
  const entries = Object.entries(YF);

  for (let i = 0; i < entries.length; i += 4) {          // petits lots : on reste courtois
    await Promise.all(entries.slice(i, i + 4).map(async ([key, sym]) => {
      try {
        const { px, src } = await fetchPrice(key, sym);
        const b = BOUNDS[key];
        if (b && (px < b[0] || px > b[1])) throw new Error(`hors bornes (${px})`);
        prices[key] = +px.toFixed(4);
        freshCount++;
        if (src === "stooq") viaStooq++;
      } catch (e) {
        console.error(`✗ ${key} (${sym}) : ${e.message}`);
        if (prevPrices[key] != null) { prices[key] = prevPrices[key]; stale.push(key); }
      }
    }));
    await sleep(400);
  }

  // Sécurité n°1 : AUCUN cours frais ce cycle (Yahoo ET Stooq muets) → on n'écrit PAS.
  // On garde l'ancien fichier tel quel : pas de faux 'updated' qui ferait croire à des cours
  // récents. La run GitHub passe en échec (rouge) → tu es alerté que la source est en panne.
  if (freshCount === 0) {
    console.error(`Abandon : aucun cours frais ce cycle (${stale.length} repris de l'ancien fichier). Fichier conservé, 'updated' inchangé.`);
    process.exit(1);
  }

  const eurusd = await fetchEurUsd() ?? prev.eurusd ?? 1.174;

  const out = {
    updated: new Date().toISOString(),
    eurusd: +Number(eurusd).toFixed(5),
    count: Object.keys(prices).length,
    freshCount,                              // cours réellement rafraîchis ce cycle
    stale,                                   // tickers repris de l'exécution précédente
    prices
  };

  // Sécurité n°2 : ne jamais écraser un bon fichier par un fichier quasi vide.
  const prevCount = Object.keys(prevPrices).length;
  if (out.count === 0 || (prevCount > 5 && out.count < prevCount / 2)) {
    console.error(`Abandon : seulement ${out.count} cours obtenus (précédent : ${prevCount}).`);
    process.exit(1);
  }

  fs.writeFileSync("prices.json", JSON.stringify(out, null, 1));
  console.log(`✓ ${out.count} cours écrits (${freshCount} frais${viaStooq ? ", dont " + viaStooq + " via Stooq" : ""}) · EUR/USD ${out.eurusd}` + (stale.length ? ` · repris : ${stale.join(",")}` : ""));
}

// Lancé seulement en exécution directe (GitHub Actions : `node fetch-prices.js`).
// À l'import (tests), rien ne s'exécute → on peut tester les fonctions pures sans réseau.
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { parseStooqCsv, fetchQuote, fetchStooq, fetchPrice, fetchEurUsd };
