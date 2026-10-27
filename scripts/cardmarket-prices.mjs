// Script 9 — cotes Cardmarket des cartes des autres licences, depuis le guide de prix public de Cardmarket.
// Le guide ne donne que l'identifiant de chaque produit ; la liste des produits donne son nom et son extension
// (pas de numéro de carte). Rapprochement, licence par licence :
//  - extension Cardmarket de chaque extension de l'app : celle qui contient le plus de ses cartes (par le nom),
//    au moins 60 % d'entre elles, avec une nette avance sur la suivante, et pas déjà attribuée ;
//  - dans l'extension, carte retrouvée par son nom ; cartes de même nom (versions alternatives, enchantées…) :
//    dans l'ordre des numéros d'un côté et des fiches Cardmarket de l'autre.
// Licences traitées : celles dont Cardmarket a une seule fiche par carte, toutes langues confondues
// (Lorcana, Riftbound, Cyberpunk). Pas One Piece, Digimon ni Dragon Ball Fusion World : Cardmarket y sépare
// éditions anglaise et japonaise en extensions distinctes sans dire laquelle est laquelle, et une cote de la
// mauvaise édition serait fausse.
// Sortie : cards/cardmarket-<licence>.json
//   { updatedAt, cardmarketAt, fields: ["avg", "low", …], cards: { <clé de la carte dans l'app>: [valeurs] } }
//   clé : produit TCGplayer pour les licences du catalogue (Riftbound, Cyberpunk), « <code extension>:<numéro> »
//   pour Lorcana (Lorcast).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { getJson } from "./lib.mjs";

const CM = "https://downloads.s3.cardmarket.com/productCatalog";
const LORCAST = "https://api.lorcast.com/v0";
/** essais hors ligne : dossier des copies (cm-<jeu>-products.json.gz, cm-<jeu>-guide.json.gz, lor-cards.json.gz) */
const LOCAL = process.env.CM_PRICES_DIR;

export const FIELDS = ["avg", "low", "trend", "avg1", "avg7", "avg30", "avg-foil", "low-foil", "trend-foil", "avg1-foil", "avg7-foil", "avg30-foil"];

const norm = (s) =>
  String(s ?? "")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
/** nom d'une fiche Cardmarket ou TCGplayer sans précisions entre crochets ou parenthèses */
const bare = (name) => norm(String(name ?? "").replace(/\[[^\]]*\]|\([^)]*\)/g, " "));
const round = (n) => (typeof n === "number" && n > 0 ? Math.round(n * 100) / 100 : null);
const local = (f) => JSON.parse(gunzipSync(readFileSync(join(LOCAL, f))).toString());

async function loadCardmarket(game) {
  if (LOCAL) return { products: local(`cm-${game}-products.json.gz`).products, guide: local(`cm-${game}-guide.json.gz`) };
  const products = (await getJson(`${CM}/productList/products_singles_${game}.json`, { delay: 0 })).products;
  const guide = await getJson(`${CM}/priceGuide/price_guide_${game}.json`, { delay: 0 });
  return { products, guide };
}

/**
 * Rapprochement générique.
 * sets : [{ id, cards: [{ key (clé dans l'app), name (nom comparable), order (tri des homonymes) }] }]
 * Renvoie Map(clé de la carte → idProduct) et le nombre d'extensions reliées.
 */
export function matchSets(sets, products) {
  const byExp = new Map();
  const expsOf = new Map();
  for (const p of products) {
    const k = bare(p.name);
    if (!k) continue;
    (byExp.get(p.idExpansion) ?? byExp.set(p.idExpansion, []).get(p.idExpansion)).push({ k, id: p.idProduct });
    (expsOf.get(k) ?? expsOf.set(k, new Set()).get(k)).add(p.idExpansion);
  }
  // extensions les mieux reliées d'abord : une extension Cardmarket ne sert qu'une fois
  const scored = sets.map((s) => {
    const names = new Set(s.cards.map((c) => c.name).filter(Boolean));
    const count = new Map();
    for (const n of names) for (const e of expsOf.get(n) ?? []) count.set(e, (count.get(e) ?? 0) + 1);
    return { s, n: names.size, top: [...count].sort((a, b) => b[1] - a[1]) };
  });
  scored.sort((a, b) => (b.top[0]?.[1] ?? 0) - (a.top[0]?.[1] ?? 0));
  const used = new Set();
  const out = new Map();
  let linked = 0;
  for (const { s, n, top } of scored) {
    const [first, second] = top.filter(([e]) => !used.has(e));
    if (!first) continue;
    const lead = first[1] - (second?.[1] ?? 0);
    if (first[1] < Math.max(3, n * 0.6) || lead < Math.max(3, n * 0.1)) continue;
    used.add(first[0]);
    linked++;
    const pool = new Map();
    for (const p of byExp.get(first[0])) (pool.get(p.k) ?? pool.set(p.k, []).get(p.k)).push(p.id);
    const groups = new Map();
    for (const c of s.cards) if (c.name) (groups.get(c.name) ?? groups.set(c.name, []).get(c.name)).push(c);
    for (const [name, cards] of groups) {
      const ids = (pool.get(name) ?? []).sort((a, b) => a - b);
      cards.sort((a, b) => String(a.order).localeCompare(String(b.order), "en", { numeric: true }));
      cards.forEach((c, i) => {
        if (ids[i]) out.set(c.key, ids[i]);
      });
    }
  }
  return { ids: out, linked };
}

/* ---------- cartes de chaque licence, telles que l'app les identifie ---------- */

/** licences du catalogue TCGplayer publié par cards.mjs : clé = produit TCGplayer */
function catalogSets(game) {
  const index = JSON.parse(readFileSync("cards/index.json", "utf8"));
  return (index.games?.[game]?.sets ?? []).map((s) => {
    const data = JSON.parse(readFileSync(s.file, "utf8"));
    return {
      id: String(s.groupId),
      cards: data.cards.map((c) => ({ key: String(c.id), name: bare(c.name), order: `${c.label ? 1 : 0}|${c.number ?? ""}|${c.id}` }))
    };
  });
}

/** Lorcana (Lorcast) : clé = « <code extension>:<numéro> », nom = « Mickey Mouse - Brave Little Tailor » */
async function lorcanaSets() {
  const rows = [];
  if (LOCAL) {
    for (const c of local("lor-cards.json.gz")) rows.push({ set: c.set, n: c.n, name: c.name, v: c.v });
  } else {
    const json = await getJson(`${LORCAST}/sets`);
    for (const s of json.results ?? json) {
      const cards = await getJson(`${LORCAST}/sets/${encodeURIComponent(s.code)}/cards`, { delay: 120 });
      for (const c of cards.results ?? cards) rows.push({ set: s.code, n: c.collector_number, name: c.name, v: c.version });
    }
  }
  const bySet = new Map();
  for (const r of rows) {
    (bySet.get(r.set) ?? bySet.set(r.set, []).get(r.set)).push({ key: `${r.set}:${r.n}`, name: bare(`${r.name} ${r.v ?? ""}`), order: `${String(r.n).length}|${r.n}` });
  }
  return [...bySet].map(([id, cards]) => ({ id, cards }));
}

const GAMES = {
  lorcana: { cm: 19, sets: lorcanaSets },
  riftbound: { cm: 22, sets: async () => catalogSets("riftbound") },
  cyberpunk: { cm: 23, sets: async () => catalogSets("cyberpunk") }
};

export async function cardmarketPrices() {
  const updatedAt = new Date().toISOString().slice(0, 10);
  mkdirSync("cards", { recursive: true });
  for (const [game, def] of Object.entries(GAMES)) {
    try {
      const sets = await def.sets();
      const cm = await loadCardmarket(def.cm);
      const guide = new Map(cm.guide.priceGuides.map((g) => [g.idProduct, g]));
      const { ids, linked } = matchSets(sets, cm.products);
      const cards = {};
      for (const [key, id] of ids) {
        const g = guide.get(id);
        if (!g) continue;
        const values = FIELDS.map((f) => round(g[f]));
        if (values.some((v) => v != null)) cards[key] = values;
      }
      // compact : téléchargé par les apps, change chaque jour
      writeFileSync(`cards/cardmarket-${game}.json`, JSON.stringify({ updatedAt, cardmarketAt: cm.guide.createdAt, fields: FIELDS, cards }));
      const total = sets.reduce((n, s) => n + s.cards.length, 0);
      console.log(`cotes Cardmarket ${game} : ${Object.keys(cards).length} cartes sur ${total} (${linked} extensions sur ${sets.length} reliées)`);
    } catch (e) {
      console.warn(`cotes Cardmarket ${game} indisponibles :`, e.message);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await cardmarketPrices();
