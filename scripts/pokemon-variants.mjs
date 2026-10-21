// Script 7 — versions qui existent vraiment pour chaque carte Pokémon (normale, holo, reverse, motifs Poké Ball…),
// d'après le catalogue TCGplayer (TCGCSV) : TCGdex ne renseigne parfois que la version normale des
// extensions récentes. Correspondance des extensions TCGdex ↔ groupes TCGplayer : champ thirdParty.tcgplayer
// des fichiers d'extension de la base TCGdex (github.com/tcgdex/cards-database), puis cartes par numéro.
// Catalogue américain : versions anglaises, qui valent aussi pour les éditions internationales (fr, de…).
// Sortie : cards/pokemon-variants.json  { updatedAt, sets: { <id TCGdex>: { <numéro>: "NHRPM1" } }, league: {…} }
//   N normale · H holo · R reverse · P reverse Poké Ball · M reverse Master Ball · 1 1re édition
//   league : cartes tamponnées « Pokémon League » (groupe TCGplayer « League & Championship Cards »),
//   { <id TCGdex>: { <numéro>: "R" } } avec la ou les finitions vendues (N, H, R)
// Et cards/pokemon-tcgplayer.json  { updatedAt, sets: { <id TCGdex>: { <numéro>: <produit TCGplayer> } } } :
//   l'app s'en sert pour montrer l'image TCGplayer (impression anglaise) d'une carte dont TCGdex n'a pas d'image
//   (vieilles cartes françaises, promos…) ; le scan à l'image aussi. Produit pris d'abord dans la fiche de la carte
//   chez TCGdex (champ thirdParty.tcgplayer), sinon le produit TCGplayer de même numéro dans le groupe de l'extension.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getJson, writeJson } from "./lib.mjs";

const TCGCSV = "https://tcgcsv.com/tcgplayer";
const REPO = "https://github.com/tcgdex/cards-database.git";
const DIR = process.env.TCGDEX_DB ?? "/tmp/tcgdex-cards-database";

/** extensions TCGdex : id → groupe TCGplayer (s'il est renseigné) et nom anglais */
function tcgdexSets() {
  if (!existsSync(DIR)) execFileSync("git", ["clone", "--depth", "1", "--quiet", REPO, DIR], { stdio: "inherit" });
  const out = new Map();
  const data = join(DIR, "data");
  for (const serie of readdirSync(data, { withFileTypes: true })) {
    if (!serie.isDirectory()) continue;
    for (const f of readdirSync(join(data, serie.name))) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(data, serie.name, f), "utf8");
      const id = src.match(/\bid:\s*["']([^"']+)["']/)?.[1];
      const group = src.match(/thirdParty:\s*\{[^}]*tcgplayer:\s*(\d+)/)?.[1];
      const en = src.match(/name:\s*\{[^}]*\ben:\s*["']([^"']+)["']/)?.[1];
      const official = src.match(/cardCount:\s*\{[^}]*official:\s*(\d+)/)?.[1];
      if (id) out.set(id, { group: group ? Number(group) : undefined, en, dir: join(data, serie.name, f.slice(0, -3)), official: official ? Number(official) : undefined });
    }
  }
  return out;
}

const field = (p, name) => (p.extendedData ?? []).find((x) => x.name === name)?.value;

/** cartes d'une extension TCGdex : numéro → nom anglais et produit TCGplayer indiqué par TCGdex */
function tcgdexCards(dir) {
  const out = new Map();
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    const en = src.match(/name:\s*\{[^}]*\ben:\s*["']([^"']+)["']/)?.[1];
    const pid = src.match(/tcgplayer:\s*(\d+)/)?.[1];
    out.set(numKey(f.slice(0, -3)), { en, pid: pid ? Number(pid) : undefined });
  }
  return out;
}

/** finitions vendues d'un produit (N, H, R), d'après ses prix */
function finishes(subs) {
  const out = new Set();
  for (const s of subs) out.add(/reverse/i.test(s) ? "R" : /holo/i.test(s) ? "H" : "N");
  return [...out].join("") || "N";
}

/** produit « ordinaire » pour l'image d'une carte : pas une erreur d'impression, un tampon de staff… */
const ODD = /misprint|error|staff|prerelease|pre-release|jumbo|oversized|\[.*place\]/i;

/** code des versions d'un produit : finitions vendues + motif indiqué dans le nom */
function codes(product, subs) {
  const name = product.name ?? "";
  const pattern = /master ?ball/i.test(name) ? "M" : /pok[eé] ?ball/i.test(name) ? "P" : "";
  const out = new Set();
  for (const s of subs) {
    if (pattern) out.add(pattern);
    else if (/reverse/i.test(s)) out.add("R");
    else if (/1st edition/i.test(s)) out.add("1");
    else if (/holo/i.test(s)) out.add("H");
    else if (/normal|unlimited/i.test(s)) out.add("N");
  }
  return out;
}

/** « 002/128 » → « 2 » ; « TG01/TG30 » → « TG01 » ; « SV001 » → « SV001 » */
const numKey = (n) => {
  const head = String(n ?? "").split("/")[0].trim();
  return /^\d+$/.test(head) ? String(Number(head)) : head.toUpperCase();
};

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");

export async function pokemonVariants() {
  const sets = tcgdexSets();
  // extensions sans groupe renseigné (les plus récentes) : groupe TCGplayer du même nom anglais (« ME: 30th Celebration »)
  const groups = (await getJson(`${TCGCSV}/3/groups`)).results ?? [];
  const byName = new Map();
  for (const g of groups) {
    const bare = norm(String(g.name).replace(/^[A-Z&]{1,6}\d*\s*[:-]\s*/, ""));
    byName.set(bare, [...(byName.get(bare) ?? []), g.groupId]);
  }
  const byGroup = new Map();
  let guessed = 0;
  for (const [id, s] of sets) {
    let g = s.group;
    if (!g && s.en) {
      const hits = byName.get(norm(s.en)) ?? [];
      if (hits.length === 1) {
        g = hits[0];
        guessed++;
      }
    }
    if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), id]);
  }
  console.log(`versions Pokémon : ${byGroup.size} groupes TCGplayer (${guessed} retrouvés par le nom), ${sets.size} extensions TCGdex`);
  const out = {};
  // images : produit TCGplayer de chaque carte, d'abord celui que donne TCGdex dans la fiche de la carte
  const images = {};
  const cardsOf = new Map();
  for (const [id, s] of sets) {
    const cards = tcgdexCards(s.dir);
    cardsOf.set(id, cards);
    for (const [k, c] of cards) if (c.pid) (images[id] ??= {})[k] = c.pid;
  }
  let done = 0;
  for (const [group, ids] of byGroup) {
    try {
      const products = (await getJson(`${TCGCSV}/3/${group}/products`, { delay: 120 })).results ?? [];
      const prices = (await getJson(`${TCGCSV}/3/${group}/prices`, { delay: 120 })).results ?? [];
      const subs = new Map();
      for (const r of prices) subs.set(r.productId, [...(subs.get(r.productId) ?? []), r.subTypeName]);
      const cards = {};
      const pids = {};
      for (const p of products) {
        const n = field(p, "Number");
        if (!n) continue;
        const k = numKey(n);
        const set = new Set([...(cards[k] ?? ""), ...codes(p, subs.get(p.productId) ?? [])]);
        cards[k] = [...set].join("");
        if (!pids[k] || (ODD.test(pids[k].name) && !ODD.test(p.name))) pids[k] = { id: p.productId, name: p.name ?? "" };
      }
      for (const id of ids) {
        out[id] = cards;
        for (const [k, p] of Object.entries(pids)) if (!images[id]?.[k]) (images[id] ??= {})[k] = p.id;
      }
    } catch (e) {
      console.warn(`groupe ${group} (${ids.join(", ")}) : ${e.message}`);
    }
    if (++done % 50 === 0) console.log(`versions Pokémon : ${done}/${byGroup.size} groupes`);
  }
  const league = await leagueCards(sets, cardsOf);
  await writeJson("cards/pokemon-variants.json", { updatedAt: new Date().toISOString().slice(0, 10), sets: out, league });
  await writeJson("cards/pokemon-tcgplayer.json", { updatedAt: new Date().toISOString().slice(0, 10), sets: images });
  const leagueCount = Object.values(league).reduce((n, x) => n + Object.keys(x).length, 0);
  const imageCount = Object.values(images).reduce((n, x) => n + Object.keys(x).length, 0);
  console.log(`versions Pokémon : ${Object.keys(out).length} extensions TCGdex, ${leagueCount} cartes tamponnées Ligue, ${imageCount} images TCGplayer`);
}

/**
 * Cartes tamponnées « Pokémon League » : produits « (League Promo) » / « (Pokemon League) » du groupe TCGplayer
 * « League & Championship Cards », rattachés à leur carte TCGdex par le numéro imprimé (« 077/131 » : carte 77
 * d'une extension de 131 cartes) et le nom anglais. Les lots de classement ([1st Place]…) et Staff sont écartés.
 */
async function leagueCards(sets, cardsOf) {
  const groups = (await getJson(`${TCGCSV}/3/groups`)).results ?? [];
  const g = groups.find((x) => /league\s*&\s*championship/i.test(x.name ?? ""));
  if (!g) return {};
  const products = (await getJson(`${TCGCSV}/3/${g.groupId}/products`, { delay: 120 })).results ?? [];
  const prices = (await getJson(`${TCGCSV}/3/${g.groupId}/prices`, { delay: 120 })).results ?? [];
  const subs = new Map();
  for (const r of prices) subs.set(r.productId, [...(subs.get(r.productId) ?? []), r.subTypeName]);
  const byTotal = new Map();
  for (const [id, s] of sets) if (s.official) byTotal.set(s.official, [...(byTotal.get(s.official) ?? []), id]);
  const out = {};
  for (const p of products) {
    const name = p.name ?? "";
    if (!/\((?:\d{4}-\d{4}\s+)?league promo\)|\(pok[eé]mon league\)/i.test(name) || /\[[^\]]*(place|staff)[^\]]*\]/i.test(name)) continue;
    const m = String(field(p, "Number") ?? name.match(/(\d{1,3}\/\d{1,3})/)?.[1] ?? "").match(/^0*(\d+)\s*\/\s*0*(\d+)$/);
    if (!m) continue;
    const k = String(Number(m[1]));
    const card = norm(name.replace(/\s*-\s*\d+\/\d+.*$/, "").replace(/\s*\(.*$/, ""));
    for (const id of byTotal.get(Number(m[2])) ?? []) {
      if (norm(cardsOf.get(id)?.get(k)?.en ?? "") !== card) continue;
      const set = new Set([...(out[id]?.[k] ?? ""), ...finishes(subs.get(p.productId) ?? [])]);
      (out[id] ??= {})[k] = [...set].join("");
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) await pokemonVariants();
