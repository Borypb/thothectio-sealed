// Script 8 — cotes des cartes Pokémon que TCGdex ne sait pas coter.
// TCGdex lit lui-même le guide de prix public de Cardmarket et les prix TCGplayer, mais seulement pour les cartes
// qu'il a reliées à un produit : une carte sans identifiant Cardmarket n'a pas d'euros, une extension sans groupe
// TCGplayer n'a pas de dollars (ex. Wizards Black Star Promos : ni l'un ni l'autre). Ce script comble ces trous,
// chaque nuit, avec les mêmes fichiers publics :
//  - Cardmarket : liste des cartes à l'unité + guide des prix du jour (en €, toutes langues et tous états) ;
//    carte retrouvée dans son extension Cardmarket par son nom anglais et ses talents et attaques
//    (« Arcanine [Quick Attack | Flames of Rage] ») ; cartes de même nom et mêmes attaques : dans l'ordre.
//  - TCGplayer (via TCGCSV) : produit indiqué par TCGdex dans la fiche de la carte, sinon produit de même numéro
//    dans le groupe de l'extension ; prix bas, milieu et marché par version (en $). Le prix « haut » est laissé de côté :
//    c'est l'annonce la plus chère en ligne, pas une vente.
// Les champs reprennent ceux de TCGdex (`pricing.cardmarket`, `pricing.tcgplayer`) : l'app les lit de la même façon.
// Corrige aussi les liens faux de TCGdex : quand la fiche Cardmarket qu'il indique n'a pas les attaques de la carte et
// qu'une fiche de la même extension a exactement son nom et ses attaques, sa cote est publiée avec « fix: 1 ».
// Versions de la carte (v) : cote propre à chaque version quand elle en a une — produit TCGplayer de la version,
// fiche Cardmarket de la version si Cardmarket les sépare, sinon fiche partagée (« normal-1st-movie », « holo-cosmos »…).
// Liens faits à la main : curated/cardmarket-links.json (carte TCGdex → fiche Cardmarket) ; cartes ajoutées à la main
// (curated/cards.json) avec « cardmarket » ou « tcgplayer » : cote dans « ids », par identifiant de l'impression.
// Sortie : cards/pokemon-prices.json  { updatedAt, cardmarketAt, sets: { <id TCGdex>: { <numéro>: { cm, tp, fix, v } } }, ids }
// Éditions internationales seulement (dossier data/ de TCGdex, sans TCG Pocket).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getJson, readJson } from "./lib.mjs";
import { readCurated, toPrinting } from "./curated-cards.mjs";

const CM = "https://downloads.s3.cardmarket.com/productCatalog";
const TCGCSV = "https://tcgcsv.com/tcgplayer";
const REPO = "https://github.com/tcgdex/cards-database.git";
const DIR = process.env.TCGDEX_DB ?? "/tmp/tcgdex-cards-database";
/** essais hors ligne : copies des fichiers publics (cm-products, cm-guide, tcg-groups, tcg-products, tcg-prices) */
const LOCAL = process.env.PRICES_DIR;

const local = (f) => JSON.parse(gunzipSync(readFileSync(join(LOCAL, `${f}.json.gz`))).toString());

/* ---------- lecture des fichiers de TCGdex ---------- */

const STR = String.raw`(["'])((?:\\.|(?!\1).)*)\1`;
const unq = (s) => s.replace(/\\(.)/g, "$1");
/** valeur anglaise d'un bloc « name: { en: "…" } » */
const enOf = (src) => {
  const m = src?.match(new RegExp(String.raw`\ben:\s*` + STR));
  return m ? unq(m[2]) : undefined;
};
/** bloc de premier niveau (`\tkey: [ … \n\t]`) */
function block(src, key) {
  const m = src.match(new RegExp(String.raw`^\t${key}:\s*([[{])`, "m"));
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = src.indexOf(`\n\t${m[1] === "[" ? "]" : "}"}`, start);
  return end < 0 ? null : src.slice(start, end);
}
/** noms anglais des éléments d'une liste (talents, attaques) */
const names = (list) => (list ? [...list.matchAll(new RegExp(String.raw`\bname:\s*\{[^}]*?\ben:\s*` + STR, "g"))].map((m) => unq(m[2])) : []);
const ids = (src, kind) => [...(src ?? "").matchAll(new RegExp(String.raw`\b${kind}:\s*(\d+)`, "g"))].map((m) => Number(m[1]));

/** objets de premier niveau d'une liste (« { type: … }, { … } »), sans se perdre dans les accolades imbriquées */
function objects(list) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < (list ?? "").length; i++) {
    const ch = list[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) out.push(list.slice(start, i + 1));
    }
  }
  return out;
}

/** clé d'une version, comme l'identifiant de l'impression dans l'app (tcgdexVariants.ts) : « normal-1st-movie », « holo-cosmos » */
const keyPart = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "-");
function variantOf(obj) {
  const str = (k) => obj.match(new RegExp(String.raw`\b${k}:\s*["']([^"']+)["']`))?.[1];
  const stamps = [...(obj.match(/\bstamp:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => keyPart(m[1]));
  const type = keyPart(str("type") ?? "normal");
  const jumbo = keyPart(str("size") ?? "") === "jumbo";
  const key = [type, str("foil") && keyPart(str("foil")), str("subtype") && keyPart(str("subtype")), jumbo ? "jumbo" : undefined, ...stamps].filter(Boolean).join("-");
  return { key, type, plain: key === type, cm: ids(obj, "cardmarket")[0], tp: ids(obj, "tcgplayer")[0] };
}

function parseCard(src) {
  const third = src.match(/^\tthirdParty:\s*\{([^}]*)\}/m)?.[1];
  const variants = block(src, "variants");
  const types = [];
  if (variants) for (const m of variants.matchAll(/\btype:\s*["']([\w-]+)["']/g)) types.push(m[1]);
  // versions détaillées (liste « variants: [ … ] ») : clé, produit TCGplayer et fiche Cardmarket de chacune
  const list = /^\tvariants:\s*\[/m.test(src) ? objects(variants).map(variantOf) : [];
  return {
    versions: list,
    name: enOf(block(src, "name")),
    moves: [...names(block(src, "abilities")), ...names(block(src, "attacks"))],
    // identifiants de la carte, puis ceux de ses versions (le premier est la version de base)
    cm: [...ids(third, "cardmarket"), ...ids(variants, "cardmarket")],
    tp: [...ids(third, "tcgplayer"), ...ids(variants, "tcgplayer")],
    types
  };
}

/** extensions et cartes internationales de TCGdex */
function tcgdex() {
  if (!existsSync(DIR)) execFileSync("git", ["clone", "--depth", "1", "--quiet", REPO, DIR], { stdio: "inherit" });
  const data = join(DIR, "data");
  const sets = [];
  for (const serie of readdirSync(data, { withFileTypes: true })) {
    if (!serie.isDirectory() || /pocket/i.test(serie.name)) continue;
    for (const f of readdirSync(join(data, serie.name))) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(data, serie.name, f), "utf8");
      const id = src.match(/\bid:\s*["']([^"']+)["']/)?.[1];
      const dir = join(data, serie.name, f.slice(0, -3));
      if (!id || !existsSync(dir)) continue;
      const third = src.match(/thirdParty:\s*\{([^}]*)\}/)?.[1];
      const cards = [];
      for (const c of readdirSync(dir)) {
        if (!c.endsWith(".ts")) continue;
        const card = parseCard(readFileSync(join(dir, c), "utf8"));
        if (card.name) cards.push({ number: c.slice(0, -3), ...card });
      }
      sets.push({ id, en: enOf(src.match(/name:\s*\{[^}]*\}/)?.[0]), cmExp: ids(third, "cardmarket")[0], group: ids(third, "tcgplayer")[0], cards });
    }
  }
  return sets;
}

/* ---------- outils ---------- */

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
/** « 002/128 » → « 2 » ; « BW01 » → « BW01 » (même clé que pokemon-variants.mjs) */
const numKey = (n) => {
  const head = String(n ?? "").split("/")[0].trim();
  return /^\d+$/.test(head) ? String(Number(head)) : head.toUpperCase();
};
/** ordre naturel des numéros (« 2 » avant « 10 », « BW2 » avant « BW10 ») */
const byNumber = (a, b) => a.number.localeCompare(b.number, "en", { numeric: true });
const round = (n) => (typeof n === "number" && n > 0 ? Math.round(n * 100) / 100 : undefined);
const compact = (o) => {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  return Object.keys(out).length ? out : undefined;
};

/**
 * Fiche Cardmarket : « Arcanine [Quick Attack | Flames of Rage] », « Unown [J] [Join | Hidden Power] »,
 * « Snivy [Tackle | Vine Whip | SV] », « Turtwig Lv.10 [Tackle | Razor Leaf] », « Pikachu (Top Deck) ».
 * Le dernier crochet liste talents et attaques, suivis parfois d'un code d'extension (« SV », « BW ») ;
 * les crochets d'avant font partie du nom ; le niveau chiffré (« Lv.10 ») n'est pas dans le nom chez TCGdex.
 */
function cmKey(name) {
  const brackets = [...name.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
  const moves = brackets.length ? brackets.pop().split("|").map((s) => s.trim()).filter((s) => s && !/^[A-Z]{1,3}$/.test(s)) : [];
  const base = name.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ").replace(/\s+lv\.?\s*\d+\b/i, " ");
  return { name: norm(`${base} ${brackets.join(" ")}`), moves: moves.map(norm).sort().join("|") };
}
const cardKey = (c) => ({ name: norm(c.name), moves: c.moves.map(norm).sort().join("|") });

/* ---------- Cardmarket ---------- */

async function loadCardmarket() {
  if (LOCAL) return { products: local("cm-products").products, guide: local("cm-guide") };
  const products = (await getJson(`${CM}/productList/products_singles_6.json`, { delay: 0 })).products;
  const guide = await getJson(`${CM}/priceGuide/price_guide_6.json`, { delay: 0 });
  return { products, guide };
}

const CM_FIELDS = ["avg", "low", "trend", "avg1", "avg7", "avg30"];
function cmPrices(g) {
  const out = {};
  for (const f of CM_FIELDS) {
    out[f] = round(g[f]);
    out[`${f}-holo`] = round(g[`${f}-holo`]);
  }
  return compact(out);
}

/**
 * Extension Cardmarket de chaque extension TCGdex : celle que TCGdex indique, sinon celle des produits déjà reliés
 * à ses cartes, sinon celle qui contient le plus de ses cartes (nom + attaques) : au moins 60 % d'entre elles, avec
 * une nette avance sur la suivante, et pas déjà attribuée à une autre extension.
 */
function expansions(sets, products) {
  const expOf = new Map(products.map((p) => [p.idProduct, p.idExpansion]));
  const out = new Map();
  for (const s of sets) {
    if (s.cmExp) {
      out.set(s.id, s.cmExp);
      continue;
    }
    const count = new Map();
    for (const c of s.cards) for (const id of c.cm) if (expOf.has(id)) count.set(expOf.get(id), (count.get(expOf.get(id)) ?? 0) + 1);
    const best = [...count].sort((a, b) => b[1] - a[1])[0];
    if (best) out.set(s.id, best[0]);
  }
  const taken = new Set(out.values());
  const byKey = new Map();
  for (const p of products) {
    const k = cmKey(p.name);
    const key = `${k.name}#${k.moves}`;
    (byKey.get(key) ?? byKey.set(key, new Set()).get(key)).add(p.idExpansion);
  }
  let guessed = 0;
  for (const s of sets) {
    if (out.has(s.id) || s.cards.length < 3) continue;
    const count = new Map();
    for (const c of s.cards) {
      const k = cardKey(c);
      for (const e of byKey.get(`${k.name}#${k.moves}`) ?? []) if (!taken.has(e)) count.set(e, (count.get(e) ?? 0) + 1);
    }
    const [first, second] = [...count].sort((a, b) => b[1] - a[1]);
    const lead = first ? first[1] - (second?.[1] ?? 0) : 0;
    if (first && first[1] >= Math.max(3, s.cards.length * 0.6) && lead >= Math.max(3, s.cards.length * 0.1)) {
      out.set(s.id, first[0]);
      taken.add(first[0]);
      guessed++;
    }
  }
  return { map: out, guessed };
}

/** produit Cardmarket de chaque carte sans identifiant, dans l'extension retrouvée */
function matchCardmarket(set, expansion, products) {
  const pool = products.filter((p) => p.idExpansion === expansion).map((p) => ({ ...p, key: cmKey(p.name) }));
  const out = new Map();
  if (!pool.length) return out;
  // cartes de même nom et mêmes attaques (Mew 8 et 9) : appariées dans l'ordre des numéros et des fiches
  const groups = new Map();
  for (const c of [...set.cards].sort(byNumber)) {
    const k = cardKey(c);
    const key = `${k.name}#${k.moves}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(c);
  }
  for (const [key, cards] of groups) {
    const [name, moves] = key.split("#");
    let hits = pool.filter((p) => p.key.name === name && p.key.moves === moves);
    // attaques notées autrement : le nom seul, s'il n'y a qu'une carte de ce nom de chaque côté
    if (!hits.length) {
      const sameName = pool.filter((p) => p.key.name === name);
      const cardsSameName = set.cards.filter((c) => norm(c.name) === name);
      if (sameName.length === 1 && cardsSameName.length === 1) hits = sameName;
    }
    hits.sort((a, b) => a.idProduct - b.idProduct);
    cards.forEach((c, i) => {
      if (hits[i]) out.set(c.number, hits[i].idProduct);
    });
    // carte seule de ce nom : toutes ses fiches (versions que Cardmarket sépare, comme l'Évoli holo cosmos et
    // l'Évoli tamponné « Jr. Stamp Rally » de la même promo), dans l'ordre de leur création
    if (cards.length === 1 && hits.length) out.set(`${cards[0].number}#all`, hits.map((h) => h.idProduct));
  }
  return out;
}

/**
 * Fiche Cardmarket de chaque version d'une carte.
 * - Autant de fiches que de versions (Évoli holo cosmos et Évoli tamponné « Jr. Stamp Rally ») : dans l'ordre.
 * - Sinon, Cardmarket ne les distingue pas : la fiche va à la version courante de la carte — la version simple
 *   (normale, holo, reverse) quand elle existe ; sinon, celles qui ont leur produit TCGplayer (Électek tamponné
 *   « 1st Movie », que tout le monde a, et pas sa variante au tampon inversé). Une variante rare (erreur d'impression,
 *   étoile grise, Mew brillante…) ne reçoit pas la cote de la carte courante : elle garde seulement la sienne
 *   chez TCGplayer quand elle en a une.
 */
function versionProducts(card, all, base) {
  const out = new Map();
  const vs = card.versions;
  if (!vs.length || !base) return out;
  if (all && all.length > 1 && all.length === vs.length) {
    vs.forEach((v, i) => out.set(v.key, all[i]));
    return out;
  }
  const plain = vs.filter((v) => v.plain);
  const sold = vs.filter((v) => v.tp);
  for (const v of plain.length ? plain : sold.length ? sold : vs) out.set(v.key, base);
  return out;
}

/* ---------- TCGplayer ---------- */

async function loadTcgplayer(neededGroups) {
  if (LOCAL) {
    const groups = local("tcg-groups").map((g) => ({ groupId: g.id, name: g.name }));
    const prices = local("tcg-prices").map(([productId, subTypeName, lowPrice, midPrice, , marketPrice]) => ({ productId, subTypeName, lowPrice, midPrice, marketPrice }));
    const products = local("tcg-products").map((p) => ({ productId: p.id, groupId: p.g, name: p.n, number: p.num }));
    return { groups, prices, products: () => products };
  }
  const groups = (await getJson(`${TCGCSV}/3/groups`)).results ?? [];
  const prices = [];
  for (const g of groups) {
    try {
      prices.push(...((await getJson(`${TCGCSV}/3/${g.groupId}/prices`, { delay: 120 })).results ?? []));
    } catch (e) {
      console.warn(`cotes Pokémon : groupe TCGplayer ${g.groupId} ignoré (${e.message})`);
    }
  }
  return {
    groups,
    prices,
    async products(groupIds) {
      const out = [];
      for (const id of groupIds) {
        try {
          for (const p of (await getJson(`${TCGCSV}/3/${id}/products`, { delay: 120 })).results ?? []) {
            const number = (p.extendedData ?? []).find((x) => x.name === "Number")?.value;
            out.push({ productId: p.productId, groupId: id, name: p.name, number });
          }
        } catch (e) {
          console.warn(`cotes Pokémon : produits du groupe ${id} ignorés (${e.message})`);
        }
      }
      return out;
    }
  };
}

/** prix TCGplayer d'un produit, au format de TCGdex : { normal: { lowPrice, midPrice, marketPrice }, holofoil: … } */
function tpPrices(rows) {
  const out = {};
  for (const r of rows ?? []) {
    const v = compact({ lowPrice: round(r.lowPrice), midPrice: round(r.midPrice), marketPrice: round(r.marketPrice) });
    if (v) out[String(r.subTypeName).toLowerCase().replaceAll(" ", "-")] = v;
  }
  return compact(out);
}

/* ---------- liens faits à la main ---------- */

/**
 * curated/cardmarket-links.json : fiches Cardmarket reliées à la main quand le rapprochement automatique ne peut pas
 * (extension Cardmarket d'une seule carte, comme Ancient Mew). Clé « <id TCGdex de l'extension>/<numéro TCGdex> »,
 * valeur : identifiant du produit Cardmarket (liste publique products_singles_6.json).
 */
async function readLinks() {
  const json = await readJson("curated/cardmarket-links.json", {});
  const out = {};
  for (const [k, v] of Object.entries(json.pokemon ?? {})) if (Number.isInteger(v) && v > 0) out[k] = v;
  return out;
}

/* ---------- assemblage ---------- */

export async function pokemonPrices() {
  const sets = tcgdex();
  const total = sets.reduce((n, s) => n + s.cards.length, 0);
  // ce que TCGdex sait déjà coter : on ne refait pas son travail
  const tcgdexGroups = new Set(sets.map((s) => s.group).filter(Boolean));
  const needsCm = (c) => !c.cm.length;
  const needsTp = (s, c) => !(s.group && c.tp.length);
  const todo = sets.filter((s) => s.cards.some((c) => needsCm(c) || needsTp(s, c)));

  const cm = await loadCardmarket();
  const guide = new Map(cm.guide.priceGuides.map((g) => [g.idProduct, g]));
  const { map: expOf, guessed } = expansions(sets, cm.products);

  // groupes TCGplayer : celui de TCGdex, sinon celui du même nom anglais (comme pokemon-variants.mjs)
  const tcg = await loadTcgplayer();
  const byName = new Map();
  for (const g of tcg.groups) {
    const bare = norm(String(g.name).replace(/^[A-Z&]{1,6}\d*\s*[:-]\s*/, ""));
    byName.set(bare, [...(byName.get(bare) ?? []), g.groupId]);
  }
  const groupOf = new Map();
  for (const s of todo) {
    const hits = s.group ? [s.group] : (byName.get(norm(s.en)) ?? []);
    if (hits.length === 1) groupOf.set(s.id, hits[0]);
  }
  const rowsOf = new Map();
  for (const r of tcg.prices) (rowsOf.get(r.productId) ?? rowsOf.set(r.productId, []).get(r.productId)).push(r);
  // produits par numéro, seulement pour les extensions dont des cartes n'ont pas de produit TCGplayer chez TCGdex
  const wantGroups = new Set(todo.filter((s) => groupOf.has(s.id) && s.cards.some((c) => !c.tp.length)).map((s) => groupOf.get(s.id)));
  const products = await tcg.products([...wantGroups]);
  const byGroupNumber = new Map();
  for (const p of products) {
    if (!p.number || !wantGroups.has(p.groupId)) continue;
    const k = `${p.groupId}|${numKey(p.number)}`;
    (byGroupNumber.get(k) ?? byGroupNumber.set(k, []).get(k)).push(p);
  }

  const out = {};
  let withCm = 0;
  let withTp = 0;
  let fixed = 0;
  // liens faux de TCGdex : la fiche Cardmarket qu'il indique n'a pas les attaques de la carte, alors qu'une fiche
  // de la même extension a exactement son nom et ses attaques (cartes interverties, décalées d'un numéro…)
  const keyOf = new Map(cm.products.map((p) => [p.idProduct, cmKey(p.name)]));
  const sameKey = (a, b) => a && b && a.name === b.name && a.moves === b.moves;
  const wrongLink = (c) => c.cm.length && c.cm.every((id) => keyOf.has(id) && !sameKey(keyOf.get(id), cardKey(c)));
  const links = await readLinks();
  const work = sets.filter((s) => todo.includes(s) || (expOf.has(s.id) && s.cards.some(wrongLink)));
  for (const s of work) {
    const cmIds = expOf.has(s.id) ? matchCardmarket(s, expOf.get(s.id), cm.products) : new Map();
    for (const c of s.cards) {
      const entry = {};
      // fiche Cardmarket reliée à la main (curated/cardmarket-links.json) : prioritaire sur le rapprochement
      const linked = links[`${s.id}/${c.number}`];
      if (linked) cmIds.set(c.number, linked);
      if (linked) cmIds.set(`${c.number}#all`, [linked]);
      if (needsCm(c)) {
        const g = guide.get(cmIds.get(c.number));
        const prices = g && cmPrices(g);
        if (prices) {
          entry.cm = prices;
          withCm++;
        }
      } else if (wrongLink(c) && sameKey(keyOf.get(cmIds.get(c.number)), cardKey(c))) {
        const prices = cmPrices(guide.get(cmIds.get(c.number)) ?? {});
        if (prices) {
          // l'app préfère cette cote à celle de TCGdex
          entry.cm = prices;
          entry.fix = 1;
          fixed++;
        }
      }
      if (todo.includes(s) && needsTp(s, c)) {
        let pid = c.tp[0];
        if (!pid && groupOf.has(s.id)) {
          // même numéro dans le groupe ; plusieurs produits : celui dont le nom commence par celui de la carte
          const same = byGroupNumber.get(`${groupOf.get(s.id)}|${numKey(c.number)}`) ?? [];
          const named = same.filter((p) => norm(p.name).startsWith(norm(c.name)));
          pid = (named.length === 1 ? named[0] : same.length === 1 ? same[0] : undefined)?.productId;
        }
        const prices = pid && tpPrices(rowsOf.get(pid));
        if (prices) {
          entry.tp = prices;
          withTp++;
        }
      }
      // versions particulières (tampon du film, holo cosmos…) : leur produit TCGplayer et leur fiche Cardmarket
      if (todo.includes(s) && c.versions.some((v) => !v.plain || c.versions.length > 1)) {
        const perVersion = needsCm(c) ? versionProducts(c, cmIds.get(`${c.number}#all`), cmIds.get(c.number)) : new Map();
        const v = {};
        for (const ver of c.versions) {
          const e = {};
          const g = perVersion.has(ver.key) ? guide.get(perVersion.get(ver.key)) : undefined;
          const cmP = g && cmPrices(g);
          if (cmP) e.cm = cmP;
          const tpP = ver.tp && needsTp(s, c) ? tpPrices(rowsOf.get(ver.tp)) : undefined;
          if (tpP) e.tp = tpP;
          if (e.cm || e.tp) v[ver.key] = e;
        }
        if (Object.keys(v).length) entry.v = v;
      }
      if (entry.cm || entry.tp || entry.v) (out[s.id] ??= {})[c.number] = entry;
    }
  }

  // cartes ajoutées à la main (curated/cards.json) avec leur fiche Cardmarket ou leur produit TCGplayer :
  // cote par identifiant de l'impression dans l'app (versions japonaises d'Ancient Mew…)
  const ids = {};
  try {
    const { photos, sets: cSets, cards: cCards, errors } = await readCurated();
    if (!errors.length) {
      for (const c of cCards) {
        if (c.game !== "pokemon" || (!c.cardmarket && !c.tcgplayer)) continue;
        const e = {};
        const cmP = c.cardmarket && guide.get(Number(c.cardmarket)) ? cmPrices(guide.get(Number(c.cardmarket))) : undefined;
        if (cmP) e.cm = cmP;
        const tpP = c.tcgplayer ? tpPrices(rowsOf.get(Number(c.tcgplayer))) : undefined;
        if (tpP) e.tp = tpP;
        if (e.cm || e.tp) ids[toPrinting(c, cSets.get(c.set), photos).id] = e;
      }
    }
  } catch (e) {
    console.warn("cotes des cartes ajoutées à la main indisponibles :", e.message);
  }

  const updatedAt = new Date().toISOString().slice(0, 10);
  // compact : le fichier change chaque jour et les apps le téléchargent
  mkdirSync("cards", { recursive: true });
  writeFileSync("cards/pokemon-prices.json", JSON.stringify({ updatedAt, cardmarketAt: cm.guide.createdAt, sets: out, ids }));
  const missing = todo.reduce((n, s) => n + s.cards.filter((c) => needsCm(c) || needsTp(s, c)).length, 0);
  console.log(
    `cotes Pokémon : ${total} cartes chez TCGdex, ${missing} sans cote complète chez lui ; ` +
      `comblées : ${withCm} en € (${guessed} extensions Cardmarket retrouvées par les cartes), ${withTp} en $ ; ` +
      `${fixed} liens Cardmarket faux de TCGdex corrigés ` +
      `(${tcgdexGroups.size} groupes TCGplayer chez TCGdex)`
  );
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) await pokemonPrices();

/* exportés pour les essais (scripts de contrôle hors ligne) */
export { tcgdex as tcgdexForTest, expansions as expansionsForTest, matchCardmarket as matchForTest };
