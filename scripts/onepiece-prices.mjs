// Script 10 — cotes One Piece (TCGplayer, via TCGCSV), pour les cartes de punk-records qui n'en ont pas.
// Catalogue anglais de TCGplayer : chaque extension (« Romance Dawn »…) liste ses cartes par code (« OP01-001 »),
// la version normale, la parallèle (« (Parallel) » ou « (Alternate Art) ») et la manga (« (Manga) »).
// Clé publiée : « <code>|<version> », version = std (normale), p1 (parallèle), p2 (manga) — comme les identifiants
// de punk-records (« OP01-120_p1 »). Une version n'est publiée que si elle est sans ambiguïté dans l'extension
// d'origine du code ; les réimpressions (r1…), promos et cartes de tournoi sont laissées de côté.
// Prix bas, milieu et marché par finition, en $ (pas le prix « haut » : une annonce, pas une vente).
// Sortie : cards/onepiece-tcgplayer.json  { updatedAt, cards: { "OP01-120|p1": [{ sub, usd, low, mid }] } }
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { getJson } from "./lib.mjs";

const TCGCSV = "https://tcgcsv.com/tcgplayer";
/** essais hors ligne : op-groups.json.gz, op-products.json.gz, op-prices.json.gz */
const LOCAL = process.env.OP_PRICES_DIR;
const local = (f) => JSON.parse(gunzipSync(readFileSync(join(LOCAL, f))).toString());

/** extensions qui ne sont pas l'origine d'une carte : promos, tournois, decks de démonstration… */
const NOT_HOME = /promo|pre-?release|tournament|championship|demo|celebration|anniversary|winner|judge|premium booster|best/i;
/** fiches à écarter : réimpressions, tampons, signatures, numéros de série, lots */
const ODD = /reprint|pre-?release|winner|judge|serial|signature|gold-stamped|stamped|\[|tournament|celebration|anniversary|wanted poster|\(sp\)|gold\)/i;
const cents = (n) => (typeof n === "number" && n > 0 ? Math.round(n * 100) / 100 : undefined);

async function load() {
  if (LOCAL) {
    return {
      groups: local("op-groups.json.gz").map((g) => ({ groupId: g.id, name: g.name })),
      products: local("op-products.json.gz").map((p) => ({ groupId: p.g, productId: p.id, name: p.n, number: p.num })),
      prices: local("op-prices.json.gz").map(([productId, subTypeName, lowPrice, midPrice, marketPrice]) => ({ productId, subTypeName, lowPrice, midPrice, marketPrice }))
    };
  }
  const cats = (await getJson(`${TCGCSV}/categories`)).results ?? [];
  const cat = cats.find((c) => /^one piece card game$/i.test(c.name)) ?? cats.find((c) => /one piece/i.test(c.name));
  if (!cat) throw new Error("catégorie One Piece introuvable chez TCGCSV");
  const groups = (await getJson(`${TCGCSV}/${cat.categoryId}/groups`)).results ?? [];
  const products = [];
  const prices = [];
  for (const g of groups) {
    try {
      for (const p of (await getJson(`${TCGCSV}/${cat.categoryId}/${g.groupId}/products`, { delay: 120 })).results ?? []) {
        const number = (p.extendedData ?? []).find((x) => x.name === "Number")?.value;
        products.push({ groupId: g.groupId, productId: p.productId, name: p.name, number });
      }
      prices.push(...((await getJson(`${TCGCSV}/${cat.categoryId}/${g.groupId}/prices`, { delay: 120 })).results ?? []));
    } catch (e) {
      console.warn(`One Piece : groupe ${g.groupId} ignoré (${e.message})`);
    }
  }
  return { groups, products, prices };
}

export async function onePiecePrices() {
  const { groups, products, prices } = await load();
  const groupName = new Map(groups.map((g) => [g.groupId, g.name]));
  const rows = new Map();
  for (const r of prices) {
    const row = { sub: r.subTypeName, usd: cents(r.marketPrice) ?? cents(r.midPrice) ?? cents(r.lowPrice) ?? null, low: cents(r.lowPrice), mid: cents(r.midPrice) };
    if (row.usd == null && row.low == null && row.mid == null) continue;
    (rows.get(r.productId) ?? rows.set(r.productId, []).get(r.productId)).push(row);
  }
  // extension d'origine de chaque préfixe (OP01, ST10, EB02…) : celle qui contient le plus de ses codes
  const codesBy = new Map();
  for (const p of products) {
    const code = /^[A-Z]{1,4}\d{0,3}-\d{2,3}$/.test(p.number ?? "") ? p.number : null;
    if (!code || NOT_HOME.test(groupName.get(p.groupId) ?? "")) continue;
    const prefix = code.split("-")[0];
    const m = codesBy.get(prefix) ?? codesBy.set(prefix, new Map()).get(prefix);
    (m.get(p.groupId) ?? m.set(p.groupId, new Set()).get(p.groupId)).add(code);
  }
  const home = new Map();
  for (const [prefix, m] of codesBy) {
    const best = [...m].sort((a, b) => b[1].size - a[1].size)[0];
    if (best) home.set(prefix, best[0]);
  }
  const byCode = new Map();
  for (const p of products) {
    if (!p.number || home.get(p.number.split("-")[0]) !== p.groupId) continue;
    (byCode.get(p.number) ?? byCode.set(p.number, []).get(p.number)).push(p);
  }
  const cards = {};
  for (const [code, list] of byCode) {
    const plain = list.filter((p) => !ODD.test(p.name ?? ""));
    const manga = plain.filter((p) => /manga/i.test(p.name));
    const parallel = plain.filter((p) => !/manga/i.test(p.name) && /\((parallel|alternate art)\)/i.test(p.name));
    const base = plain.filter((p) => !manga.includes(p) && !parallel.includes(p));
    const put = (variant, p) => {
      const r = p && rows.get(p.productId);
      if (r?.length) cards[`${code}|${variant}`] = r;
    };
    if (base.length === 1) put("std", base[0]);
    if (parallel.length === 1) {
      put("p1", parallel[0]);
      if (manga.length === 1) put("p2", manga[0]);
    }
  }
  mkdirSync("cards", { recursive: true });
  writeFileSync("cards/onepiece-tcgplayer.json", JSON.stringify({ updatedAt: new Date().toISOString().slice(0, 10), cards }));
  console.log(`cotes One Piece : ${Object.keys(cards).length} cartes (${home.size} extensions d'origine)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await onePiecePrices();
