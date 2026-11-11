// Outils communs aux scripts du catalogue (Node 20+, sans dépendance).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const UA = "thothectio-sealed/1.0 (+https://github.com/Borypb/thothectio-sealed)";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { retries = 3, delay = 250 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const json = await res.json();
      await sleep(delay);
      return json;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

export async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

/** marques des entités « &eacute; », « &ccedil; »… (lettre + accent) */
const MARKS = { acute: "\u0301", grave: "\u0300", circ: "\u0302", uml: "\u0308", cedil: "\u0327", tilde: "\u0303", ring: "\u030A" };
const NAMED = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", mdash: "—", ndash: "–", middot: "·", hellip: "…",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", times: "×", numero: "№",
  oelig: "œ", OElig: "Œ", aelig: "æ", AElig: "Æ", szlig: "ß", rarr: "→", larr: "←"
};

/** texte d'un morceau de HTML : balises retirées, entités décodées, espaces réunis */
export function htmlText(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([A-Za-z])(acute|grave|circ|uml|cedil|tilde|ring);/g, (_, l, m) => (l + MARKS[m]).normalize("NFC"))
    .replace(/&([A-Za-z]+);/g, (x, n) => NAMED[n] ?? " ")
    .replace(/[\uE000-\uF8FF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function norm(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Type de produit d'après son nom anglais (catalogue TCGplayer).
 * L'ordre compte : du plus précis au plus générique.
 */
export function classify(name) {
  const n = name.toLowerCase();
  // cartons de distribution (« … Collection Case ») — pas « On the Case » ni « Case File »
  if (/\bcase\b/.test(n) && !/on the case|case file/.test(n)) return "case";
  // présentoirs de magasin (« Mini Tin Display », « Theme Deck Display »…) — mais pas les displays de boosters
  if (/\bdisplay\b/.test(n) && !/booster display/.test(n)) return "case";
  // lots revendeurs TCGplayer (« Art Bundle [Set of 4] ») : pas un produit officiel
  if (/art bundle|\[set of \d+\]/.test(n) && !/collection/.test(n)) return null;
  if (/code card/.test(n)) return null;
  if (/elite trainer box/.test(n)) return "etb";
  if (/ultra[- ]premium collection/.test(n)) return "upc";
  if (/super[- ]premium collection/.test(n)) return "spc";
  if (/booster display|booster box/.test(n)) return "booster_box";
  if (/booster bundle/.test(n)) return "bundle";
  if (/build (&|and) battle/.test(n)) return "build_battle";
  if (/mini tin/.test(n)) return "mini_tin";
  if (/\btin\b/.test(n)) return "tin";
  if (/blister|\b(2|3)[- ]pack\b|checklane/.test(n)) return "blister";
  if (/theme deck|battle deck|starter deck|trainer kit|league battle|deck box/.test(n) && !/collection|premium/.test(n)) return "deck";
  if (/binder|portfolio|pocket/.test(n)) return "binder";
  if (/booster pack|sleeved booster|^.*\bbooster$/.test(n)) return "booster";
  if (/collection|box\b|chest|bundle|calendar/.test(n)) return "collection";
  return "other";
}

/** produits réservés aux enseignes américaines : pas d'équivalent européen probable */
export const US_ONLY =
  /\b(target|walmart|costco|sam'?s club|best buy|gamestop|meijer|kmart|toys ?r ?us|dollar general|staples|bj'?s|pokemon center|pokémon center|exclusive|checklane|\d-tab|mcdonald'?s|trick or trade|general mills)\b/i;
