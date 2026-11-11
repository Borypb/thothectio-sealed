// Script 6 — cartes Pokémon japonaises du site officiel (pokemon-card.com), pour les extensions
// que TCGdex ne couvre pas (ou mal) en japonais : TCGdex s'arrête aux sorties d'avril 2025 environ.
// Liste : API de recherche (nom, image, code d'extension dans le chemin de l'image) ;
// numéro « 092 / 063 » : page de détail de la carte, demandée une seule fois par carte (cache).
// Sortie : cards/pokemon-ja/index.json + cards/pokemon-ja/<CODE>.json
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./lib.mjs";

const SITE = "https://www.pokemon-card.com";
const TCGDEX = "https://api.tcgdex.net/v2/ja";
const UA = "Mozilla/5.0 (compatible; Thothectio-catalog/1.0; +https://github.com/Borypb/thothectio-sealed)";
const DIR = "cards/pokemon-ja";
const CACHE = `${DIR}/details.json`;
/** budget de pages de détail par passe (le reste à la nuit suivante) */
const MAX_DETAILS = Number(process.env.JP_MAX_DETAILS ?? 6000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, as = "json", tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return as === "json" ? await res.json() : await res.text();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

const hash = (x) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 12);

/** largeur et hauteur d'une image PNG ou JPEG d'après son en-tête (premiers octets seulement), sinon null */
async function imageSize(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Range: "bytes=0-65535" } });
    if (!res.ok) return null;
    const b = Buffer.from(await res.arrayBuffer());
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i + 9 < b.length; ) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch {
    /* image injoignable : on réessaiera au prochain passage */
  }
  return null;
}

/**
 * Cartes en plusieurs parties (ex. 伝説の溶岩洞, M6 n° 075 + 076, deux cartes qui forment une seule illustration) :
 * le site officiel n'en fait qu'une fiche, au premier numéro, avec l'image des deux moitiés côte à côte. Repérage :
 * numéro suivant absent de l'extension (sans dépasser le total imprimé) et image nettement plus large que haute.
 * Chaque partie devient une carte (`part` : [rang, nombre de parties]), avec l'image entière (l'app en montre la
 * moitié, et la carte reconstituée sur demande). Résultat de la mesure gardé dans le cache (`wide`).
 */
async function splitCards(rows, cache) {
  const numbers = new Set(rows.map((r) => r.number));
  const out = [];
  for (const r of rows) {
    out.push(r);
    const n = Number(r.number);
    const next = String(n + 1).padStart(r.number.length, "0");
    if (!Number.isFinite(n) || numbers.has(next) || !(n + 1 <= Number(r.total))) continue;
    const known = cache[r.id] ?? (cache[r.id] = {});
    if (known.wide === undefined) {
      const size = await imageSize(r.image);
      if (!size) continue;
      known.wide = size.w > size.h * 1.2;
    }
    if (!known.wide) continue;
    r.part = [1, 2];
    out.push({ ...r, number: next, part: [2, 2] });
  }
  return out;
}

/** toutes les cartes de la base officielle : identifiant, nom, image, code d'extension */
async function listAll() {
  const out = [];
  const url = (page) => `${SITE}/card-search/resultAPI.php?regulation_sidebar_form=all&page=${page}`;
  const first = await get(url(1));
  const max = first.maxPage ?? 1;
  const push = (json) => {
    for (const c of json.cardList ?? []) {
      const code = c.cardThumbFile?.match(/\/card_images\/large\/([^/]+)\//)?.[1];
      if (code) out.push({ id: Number(c.cardID), name: (c.cardNameViewText || c.cardNameAltText || "").trim(), image: `${SITE}${c.cardThumbFile}`, code });
    }
  };
  push(first);
  for (let p = 2; p <= max; p++) {
    push(await get(url(p)));
    await sleep(120);
  }
  console.log(`pokemon-card.com : ${out.length} cartes sur ${max} pages`);
  return out;
}

/** page de détail : « 001 / 103 », produit (« 拡張パック 30th CELEBRATION ») */
async function detail(id) {
  const html = await get(`${SITE}/card-search/details.php/card/${id}/regu/all`, "text");
  const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  // « <img … alt="M6a" /> 001 / 103 » : on retire les balises avant de chercher le numéro
  const sub = text(html.match(/<div class="subtext[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? "");
  const num = sub.match(/([0-9]{1,3}[A-Za-z]?|[A-Z]{1,4}-?[0-9]{1,3})\s*\/\s*([0-9A-Za-z-]{1,6})/);
  const product = text(html.match(/<li class="List_item">([\s\S]*?)<\/li>/)?.[1] ?? "") || undefined;
  const stage = text(html.match(/<span class="type">([\s\S]*?)<\/span>/)?.[1] ?? "") || undefined;
  return { number: num?.[1], total: num?.[2], product, stage };
}

/** extensions japonaises de TCGdex dont la plupart des cartes ont une image */
async function tcgdexCovered() {
  const covered = new Map();
  let sets = [];
  try {
    sets = await get(`${TCGDEX}/sets`);
  } catch {
    return covered;
  }
  for (const s of sets) {
    try {
      const full = await get(`${TCGDEX}/sets/${encodeURIComponent(s.id)}`);
      const withImage = (full.cards ?? []).filter((c) => c.image).length;
      covered.set(s.id.toLowerCase(), withImage);
    } catch {
      /* extension ignorée */
    }
    await sleep(60);
  }
  return covered;
}

/** noms et dates officiels des produits (harvest-jp.mjs) : code d'extension → « 30th CELEBRATION », date */
async function productInfo() {
  const raw = await readJson("raw/pokemon-ja-official.json", { products: [] });
  const map = new Map();
  for (const p of raw.products ?? []) {
    const code = (p.setCode ?? p.page?.match(/\/(?:ex|product)\/([a-z0-9]+)\/?$/i)?.[1])?.toLowerCase();
    if (!code || p.kind !== "booster") continue;
    const name = p.title?.match(/「([^」]+)」/)?.[1] ?? p.title;
    const prev = map.get(code);
    if (!prev || (p.releasedAt && p.releasedAt < (prev.releasedAt ?? "9999"))) map.set(code, { name, releasedAt: p.releasedAt });
  }
  return map;
}

export async function jpCards() {
  const cache = await readJson(CACHE, {});
  const all = await listAll();
  const covered = await tcgdexCovered();
  const info = await productInfo();

  // par extension ; on ne garde que celles que TCGdex couvre mal (moins de 80 % des cartes avec image)
  const byCode = new Map();
  for (const c of all) byCode.set(c.code, [...(byCode.get(c.code) ?? []), c]);
  const wanted = [...byCode.entries()].filter(([code, cards]) => (covered.get(code.toLowerCase()) ?? 0) < cards.length * 0.8);
  console.log(`extensions à compléter : ${wanted.length} sur ${byCode.size} (${wanted.map(([c]) => c).join(", ")})`);

  // pages de détail manquantes, les plus récentes d'abord (identifiants les plus grands)
  // (une entrée sans vrai numéro, d'une ancienne version du script, est relue)
  const valid = (d) => d && /\d/.test(d.number ?? "");
  const todo = wanted.flatMap(([, cards]) => cards).filter((c) => !valid(cache[c.id])).sort((a, b) => b.id - a.id).slice(0, MAX_DETAILS);
  let done = 0;
  let next = 0;
  // deux lectures à la fois, avec une pause : environ 5 pages par seconde
  const worker = async () => {
    while (next < todo.length) {
      const c = todo[next++];
      try {
        cache[c.id] = await detail(c.id);
      } catch (e) {
        console.warn(`détail ${c.id} : ${e.message}`);
      }
      if (++done % 500 === 0) {
        console.log(`détails : ${done}/${todo.length}`);
        await writeJson(CACHE, cache);
      }
      await sleep(200);
    }
  };
  await Promise.all([worker(), worker()]);
  await writeJson(CACHE, cache);

  const prev = await readJson(`${DIR}/index.json`, { sets: [] });
  const sets = [];
  for (const [code, cards] of wanted) {
    let rows = cards
      .map((c) => ({ ...c, ...(cache[c.id] ?? {}) }))
      .filter((c) => /\d/.test(c.number ?? ""))
      .sort((a, b) => a.id - b.id)
      .map((c) => ({ id: c.id, name: c.name, number: c.number, total: c.total, image: c.image, stage: c.stage }));
    if (!rows.length) continue;
    rows = await splitCards(rows, cache);
    // nombre officiel de cartes : le total imprimé le plus fréquent
    const totals = new Map();
    for (const r of rows) totals.set(r.total, (totals.get(r.total) ?? 0) + 1);
    const official = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const products = new Map();
    for (const c of cards) {
      const p = cache[c.id]?.product;
      if (p) products.set(p, (products.get(p) ?? 0) + 1);
    }
    const product = [...products.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const meta = info.get(code.toLowerCase());
    const name = (meta?.name ?? product?.replace(/^(強化)?拡張パック\s*|^ハイクラスパック\s*|^スターター(セット|デッキ)\s*/, "") ?? code).replace(/[「」]/g, "").trim();
    const file = `${DIR}/${code}.json`;
    await writeJson(file, { code, name, official, cards: rows });
    sets.push({ code, name, official: official ? Number(official) || undefined : undefined, releasedAt: meta?.releasedAt, count: rows.length, file, version: hash(rows), firstId: rows[0].id });
  }
  // mesures des cartes en plusieurs parties
  await writeJson(CACHE, cache);
  // les plus récentes d'abord (identifiants officiels croissants avec la sortie)
  sets.sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "") || b.firstId - a.firstId);
  await writeJson(`${DIR}/index.json`, { updatedAt: new Date().toISOString().slice(0, 10), sets: sets.map(({ firstId, ...s }) => s) });
  console.log(`pokemon-ja : ${sets.length} extensions, ${sets.reduce((n, s) => n + s.count, 0)} cartes (précédemment ${prev.sets.length})`);
}

if (import.meta.url === `file://${process.argv[1]}`) await jpCards();
