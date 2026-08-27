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

const UA = { "User-Agent": "Mozilla/5.0 (compatible; portfolio-fab/1.0)" };
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
    if (attempt < 3) { await sleep(800 * (attempt + 1)); return fetchQuote(sym, attempt + 1); }
    throw e;
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

(async () => {
  // Reprise de l'ancien fichier : un ticker qui échoue garde sa dernière valeur connue
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync("prices.json", "utf8")); } catch (e) {}
  const prevPrices = (prev && prev.prices) || {};

  const prices = {};
  const stale = [];
  const entries = Object.entries(YF);

  for (let i = 0; i < entries.length; i += 4) {          // petits lots : on reste courtois
    await Promise.all(entries.slice(i, i + 4).map(async ([key, sym]) => {
      try {
        const px = await fetchQuote(sym);
        const b = BOUNDS[key];
        if (b && (px < b[0] || px > b[1])) throw new Error(`hors bornes (${px})`);
        prices[key] = +px.toFixed(4);
      } catch (e) {
        console.error(`✗ ${key} (${sym}) : ${e.message}`);
        if (prevPrices[key] != null) { prices[key] = prevPrices[key]; stale.push(key); }
      }
    }));
    await sleep(400);
  }

  const eurusd = await fetchEurUsd() ?? prev.eurusd ?? 1.174;

  const out = {
    updated: new Date().toISOString(),
    eurusd: +Number(eurusd).toFixed(5),
    count: Object.keys(prices).length,
    stale,                                   // tickers repris de l'exécution précédente
    prices
  };

  // Sécurité : ne jamais écraser un bon fichier par un fichier quasi vide
  const prevCount = Object.keys(prevPrices).length;
  if (out.count === 0 || (prevCount > 5 && out.count < prevCount / 2)) {
    console.error(`Abandon : seulement ${out.count} cours obtenus (précédent : ${prevCount}).`);
    process.exit(1);
  }

  fs.writeFileSync("prices.json", JSON.stringify(out, null, 1));
  console.log(`✓ ${out.count} cours écrits · EUR/USD ${out.eurusd}` + (stale.length ? ` · repris : ${stale.join(",")}` : ""));
})();
