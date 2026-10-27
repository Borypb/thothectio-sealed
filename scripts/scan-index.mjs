// Index du scan à l'image : empreinte visuelle et fiche de chaque carte, par licence et par langue.
// Thothectio s'en sert pour reconnaître une carte à l'image sans rien télécharger d'avance ni rien enregistrer :
// l'index est lu en mémoire, la carte reconnue s'affiche aussitôt grâce à sa fiche.
//
// On ne publie pas les images. Pour chaque carte : l'adresse de son image, une clé pour la retrouver à sa source,
// son empreinte (512 bits, dont on ne peut pas reconstituer l'image) et sa fiche : les champs bruts de la source
// utiles à l'app (nom, numéro, rareté, variantes…), sans les cotes. L'app les convertit avec les mêmes fonctions
// que pour un pack téléchargé (src/catalog/records.ts) : les identifiants des cartes sont identiques.
//
// Incrémental : empreintes et fiches déjà publiées (index précédent, dossier SCAN_OUT) sont reprises ;
// seules les cartes nouvelles sont traitées, dans la limite de SCAN_BUDGET_MIN minutes, les plus récentes d'abord.
//
// Sortie (branche « scan », publiée sans historique ; l'app lit les données sur jsDelivr, au commit indiqué) :
//   index.json                               { fp, fmt, updatedAt, commit, files: { "<licence>-<langue>": { parts, count, total… } } }
//   <licence>-<langue>.<n>.<empreinte>.json  { fp, fmt, game, lang, sets: [...], keys: [...], imgs: [...], cards: [...] }
//   <licence>-<langue>.<n>.<empreinte>.bin   n × 64 octets : carte entière (8 × uint32 LE) puis illustration (8 × uint32 LE)
//   state/                                   listes complètes et échecs, pour la passe suivante
// Un fichier contient au plus 20 000 cartes (limite de taille de jsDelivr) ; son nom change avec son contenu.
//
// Clé (keys[i]) et fiche (cards[i], `s` = indice dans sets) selon la licence :
//   pokemon    identifiant TCGdex (« sv03-001 ») ; fiche : détail TCGdex sans cotes ; sets : { id, name, official, date }
//   magic      « <extension>/<numéro> » ; fiche : ligne Scryfall sans cotes (anglais)
//   yugioh     identifiant YGOPRODeck ; fiche : carte avec ses extensions, l'illustration de l'entrée en tête
//   lorcana    code d'extension ; fiche : carte Lorcast ; sets : { code, name, released_at }
//   onepiece   produit punk-records ; fiche : carte punk-records ; sets : { id, name } (identifiants de l'app)
//   riftbound, dragonball, palworld, digimon, cyberpunk : fichier cards/… de ce dépôt ; fiche : carte du catalogue ; sets : { id, name, releasedAt }
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UA, getJson, readJson } from "./lib.mjs";
import { FP_VERSION, fingerprintPixels } from "./scan/fingerprint.mjs";
import { selfTest } from "./scan/selftest.mjs";
import { curatedScanEntries } from "./curated-cards.mjs";

const OUT = process.env.SCAN_OUT ?? "scan-out";
const BUDGET_MS = Number(process.env.SCAN_BUDGET_MIN ?? 300) * 60_000;
const ONLY = process.env.SCAN_GAMES ? new Set(process.env.SCAN_GAMES.split(/[\s,]+/).filter(Boolean)) : null;
const CONCURRENCY = Number(process.env.SCAN_CONCURRENCY ?? 8);
const RETRY_FAILED_MS = 7 * 24 * 3600 * 1000;
const started = Date.now();
const timeLeft = () => BUDGET_MS - (Date.now() - started);

/* ---------- listes de cartes, par source ---------- */

const TCGDEX = "https://api.tcgdex.net/v2";
/** langue de l'app → langue TCGdex, dans l'ordre de priorité */
const POKEMON_LANGS = [
  ["fr", "fr"], ["en", "en"], ["ja", "ja"], ["de", "de"], ["es", "es"], ["it", "it"], ["pt", "pt"],
  ["ko", "ko"], ["zh", "zh-tw"], ["zh-cn", "zh-cn"], ["nl", "nl"], ["pl", "pl"], ["ru", "ru"], ["th", "th"], ["id", "id"]
];

/** format de l'état d'une extension (v2 : cartes sans image gardées, pour leur donner une autre image) */
const POKEMON_STATE = 2;
/** éditions internationales : une carte porte le même identifiant TCGdex dans toutes ces langues */
const SHARED = new Set(["en", "fr", "de", "es", "it", "pt", "nl", "pl", "ru"]);
/** vieilles extensions et promos diverses souvent seulement en anglais chez TCGdex, mais vendues partout en anglais */
const englishEverywhere = (id, s) => id === "miscp" || (s.date ?? "9999") < "2004";

/** image TCGplayer d'une carte (impression anglaise), d'après cards/pokemon-tcgplayer.json (pokemon-variants.mjs) */
async function tcgplayerImages() {
  const sets = (await readJson("cards/pokemon-tcgplayer.json", { sets: {} })).sets ?? {};
  return (key) => {
    const i = key.lastIndexOf("-");
    const num = key.slice(i + 1);
    const pid = sets[key.slice(0, i)]?.[/^\d+$/.test(num) ? String(Number(num)) : num.toUpperCase()];
    return pid ? `https://tcgplayer-cdn.tcgplayer.com/product/${pid}_200w.jpg` : undefined;
  };
}

/**
 * cartes Pokémon d'une langue ; le détail d'une extension n'est relu que si son nombre de cartes a changé.
 * Une carte sans image dans cette langue prend celle de la carte anglaise (même identifiant), sinon l'image
 * TCGplayer : elle reste reconnaissable à l'image (vieilles cartes françaises, promos…). Les vieilles extensions
 * seulement anglaises chez TCGdex (Mew ancien…) sont ajoutées aux autres langues, avec leur fiche anglaise (« l »).
 */
async function pokemon(appLang, tcgLang) {
  const statePath = join(OUT, "state", `pokemon-${appLang}.sets.json`);
  const prev = await readJson(statePath, {});
  const sets = await getJson(`${TCGDEX}/${tcgLang}/sets`, { delay: 100 });
  const next = {};
  for (const s of sets) {
    const total = s.cardCount?.total ?? 0;
    if (prev[s.id] && prev[s.id].total === total && prev[s.id].name && prev[s.id].v === POKEMON_STATE) {
      next[s.id] = prev[s.id];
      continue;
    }
    try {
      const full = await getJson(`${TCGDEX}/${tcgLang}/sets/${encodeURIComponent(s.id)}`, { delay: 100 });
      next[s.id] = {
        v: POKEMON_STATE,
        total,
        name: full.name,
        official: full.cardCount?.official,
        date: full.releaseDate ?? "",
        cards: (full.cards ?? []).filter((c) => c.image).map((c) => [c.id, `${c.image}/low.webp`]),
        missing: (full.cards ?? []).filter((c) => !c.image).map((c) => c.id)
      };
    } catch (e) {
      console.warn(`TCGdex ${tcgLang}/${s.id} : ${e.message}`);
      if (prev[s.id]) next[s.id] = prev[s.id];
    }
  }
  await writeJsonCompact(statePath, next);
  const shared = SHARED.has(appLang);
  const enState = appLang === "en" ? next : shared ? await readJson(join(OUT, "state", "pokemon-en.sets.json"), {}) : {};
  const enImg = new Map(Object.values(enState).flatMap((s) => s.cards ?? []));
  const tcgImg = shared ? await tcgplayerImages() : () => undefined;
  const otherImage = (key) => (appLang !== "en" ? enImg.get(key) : undefined) ?? tcgImg(key);
  const detail = (key, lang, l) => async () => {
    const d = await getJson(`${TCGDEX}/${lang}/cards/${encodeURIComponent(key)}`, { delay: 60, retries: 2 });
    const vd = d.variants_detailed?.map(({ pricing, ...v }) => v);
    return clean({ localId: d.localId, name: d.name, rarity: d.rarity, types: d.types, variants: d.variants, vd: vd?.length ? vd : undefined, l });
  };
  const listOf = (id, s, lang, l) => {
    const set = { id, name: s.name, official: s.official, date: s.date || undefined };
    const own = s.cards ?? [];
    const borrowed = (s.missing ?? []).map((key) => [key, otherImage(key)]).filter(([, img]) => img);
    // fiche : détail de la carte, sans les cotes (une requête par carte nouvelle)
    return [...own, ...borrowed].map(([key, img]) => ({ key, img, set, detail: detail(key, lang, l) }));
  };
  // vieilles extensions anglaises absentes de cette langue
  const englishOnly = appLang !== "en" && shared ? Object.entries(enState).filter(([id, s]) => !next[id] && englishEverywhere(id, s)) : [];
  // les extensions les plus récentes d'abord : ce sont celles qu'on scanne le plus
  return [...Object.entries(next).map(([id, s]) => [id, s, tcgLang, undefined]), ...englishOnly.map(([id, s]) => [id, s, "en", "en"])]
    .sort(([, a], [, b]) => (b.date ?? "").localeCompare(a.date ?? ""))
    .flatMap(([id, s, lang, l]) => listOf(id, s, lang, l));
}

/**
 * Cartes japonaises du site officiel (cards/pokemon-ja, jp-cards.mjs) : extensions absentes de TCGdex.
 * Variantes déduites : cartes au-delà du total imprimé et Pokémon ex/V/GX en holo, les autres normales.
 */
async function pokemonJaOfficial(skip) {
  const index = await readJson("cards/pokemon-ja/index.json", { sets: [] });
  const out = [];
  for (const s of index.sets ?? []) {
    const data = await readJson(s.file, { cards: [] });
    const set = clean({ id: s.code, name: s.name, official: s.official, date: s.releasedAt });
    for (const c of data.cards ?? []) {
      const key = `${s.code}-${c.number}`;
      if (!c.image || skip.has(key)) continue;
      const holo = (s.official && Number(c.number) > s.official) || /(ex|ＥＸ|GX|V|VMAX|VSTAR)$/i.test(c.name);
      out.push({ key, img: c.image, set, rec: clean({ localId: c.number, name: c.name, variants: holo ? { holo: true } : { normal: true } }) });
    }
  }
  return out;
}

/** retire les champs vides (fichiers plus légers) */
function clean(o) {
  if (Array.isArray(o)) return o.map(clean);
  if (!o || typeof o !== "object") return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v != null && v !== "" && !(Array.isArray(v) && !v.length)) out[k] = clean(v);
  return out;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] != null).map((k) => [k, o[k]]));

const SCRYFALL_SKIPPED = new Set(["token", "memorabilia", "alchemy", "minigame", "treasure_chest", "vanguard"]);

/** Magic : fichier « default cards » de Scryfall (une ligne par impression), lu en flux */
async function magic() {
  const meta = await getJson("https://api.scryfall.com/bulk-data/default-cards", { delay: 100 });
  const file = join(tmpdir(), "scryfall-default-cards.json");
  const res = await fetch(meta.download_uri, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${meta.download_uri}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const out = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const raw of lines) {
    const line = raw.trim().replace(/,$/, "");
    if (!line.startsWith("{")) continue;
    const c = JSON.parse(line);
    if (c.digital || c.lang !== "en" || SCRYFALL_SKIPPED.has(c.set_type)) continue;
    const img = c.image_uris?.small ?? c.card_faces?.[0]?.image_uris?.small;
    if (!img) continue;
    const images = (u) => (u ? pick(u, ["small", "normal", "large"]) : undefined);
    const rec = clean({
      ...pick(c, ["set", "set_name", "collector_number", "name", "printed_name", "lang", "rarity", "released_at", "finishes", "full_art", "promo", "border_color", "frame_effects", "promo_types"]),
      image_uris: images(c.image_uris),
      card_faces: c.card_faces ? [clean({ name: c.card_faces[0].name, printed_name: c.card_faces[0].printed_name, image_uris: images(c.card_faces[0].image_uris) })] : undefined
    });
    // valeurs par défaut de Scryfall inutiles à garder
    if (rec.full_art === false) delete rec.full_art;
    if (rec.promo === false) delete rec.promo;
    out.push({ key: `${c.set}/${c.collector_number}`, img, date: c.released_at ?? "", rec });
  }
  await rm(file, { force: true });
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Yu-Gi-Oh! : toutes les cartes en une requête, une entrée par illustration */
async function yugioh() {
  const json = await getJson("https://db.ygoprodeck.com/api/v7/cardinfo.php", { delay: 200 });
  const out = [];
  for (const c of json.data ?? []) {
    const sets = (c.card_sets ?? []).map((x) => pick(x, ["set_name", "set_code", "set_rarity"]));
    for (const im of c.card_images ?? []) {
      if (!im.image_url_small) continue;
      // l'illustration de cette entrée en tête : c'est celle que l'app affiche
      const rec = { id: c.id, name: c.name, card_sets: sets, card_images: [pick(im, ["image_url", "image_url_small"])] };
      out.push({ key: String(c.id), img: im.image_url_small, rec });
    }
  }
  // identifiants les plus élevés ≈ cartes les plus récentes
  return out.sort((a, b) => Number(b.key) - Number(a.key));
}

async function lorcana() {
  const json = await getJson("https://api.lorcast.com/v0/sets", { delay: 150 });
  const sets = (Array.isArray(json) ? json : json.results ?? []).sort((a, b) => (b.released_at ?? "").localeCompare(a.released_at ?? ""));
  const out = [];
  for (const s of sets) {
    const set = clean({ code: s.code, name: s.name, released_at: s.released_at });
    const rows = await getJson(`https://api.lorcast.com/v0/sets/${encodeURIComponent(s.code)}/cards`, { delay: 150 });
    for (const r of Array.isArray(rows) ? rows : rows.results ?? []) {
      const img = r.image_uris?.digital?.small;
      if (!img) continue;
      const rec = clean({
        ...pick(r, ["collector_number", "name", "version", "rarity", "released_at"]),
        image_uris: { digital: pick(r.image_uris.digital, ["small", "normal", "large"]) }
      });
      out.push({ key: s.code, img, set, rec });
    }
  }
  return out;
}

const PUNK = "https://raw.githubusercontent.com/buhbbl/punk-records/main";
/** même correspondance que l'app (src/catalog/sources/punkrecords.ts) */
const PUNK_LISTS = {
  en: { folder: "english", dataFolder: "english" },
  fr: { folder: "french", dataFolder: "french" },
  ja: { folder: "english-asia", dataFolder: "japanese", prefix: "550" }
};

const PUNK_SPECIAL = { "701": "family", "801": "limited", "901": "promo" };
const decode = (x) => {
  let out = x;
  for (let i = 0; i < 2; i++) out = out.replace(/&amp;/g, "&").replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return out;
};

/** extensions One Piece telles que l'app les nomme : clé `op-<…>` commune aux trois langues, titre dans la langue */
let punkSets = null;
async function onePieceSets() {
  if (punkSets) return punkSets;
  const bySuffix = new Map();
  for (const [lang, p] of Object.entries(PUNK_LISTS)) {
    const rows = await getJson(`${PUNK}/${p.folder}/packs.json`, { delay: 50 });
    for (const row of Object.values(rows)) {
      const suffix = row.id.slice(-3);
      const e = bySuffix.get(suffix) ?? { titles: {}, ids: {} };
      const parts = row.title_parts ?? {};
      e.label ??= parts.label ?? undefined;
      e.titles[lang] = decode(parts.title || row.raw_title).trim();
      e.ids[lang] = p.prefix ? `${p.prefix}${suffix}` : row.id;
      bySuffix.set(suffix, e);
    }
  }
  punkSets = [...bySuffix.entries()].map(([suffix, e]) => {
    const key = e.label ? e.label.replace(/-/g, "").toLowerCase() : PUNK_SPECIAL[suffix] ?? suffix;
    return { suffix, id: `op-${key}`, titles: e.titles, ids: e.ids };
  });
  return punkSets;
}

async function onepiece(lang) {
  const p = PUNK_LISTS[lang];
  const sets = (await onePieceSets()).filter((s) => s.ids[lang]).sort((a, b) => Number(b.suffix) - Number(a.suffix));
  const out = [];
  for (const s of sets) {
    const packId = s.ids[lang];
    let cards;
    try {
      cards = await getJson(`${PUNK}/${p.dataFolder}/data/${packId}.json`, { delay: 50, retries: 1 });
    } catch {
      continue; // produit sans cartes dans cette langue
    }
    const set = { id: s.id, name: s.titles[lang] ?? s.titles.fr ?? s.titles.en ?? s.titles.ja ?? s.id };
    for (const c of cards) {
      if (c.img_full_url) out.push({ key: packId, img: c.img_full_url, set, rec: clean(pick(c, ["id", "name", "rarity", "colors", "img_full_url"])) });
    }
  }
  return out;
}

/** préfixe des identifiants d'extension dans l'app (src/catalog/sources/tcgcatalog.ts) */
const CATALOG_PREFIX = { dragonball: "db", palworld: "pal", digimon: "dgm", riftbound: "rb", cyberpunk: "cyb" };

/** licences du catalogue TCGplayer publiées par ce dépôt (cards/) */
async function tcgcatalog(game) {
  const index = await readJson("cards/index.json", { games: {} });
  const sets = [...(index.games[game]?.sets ?? [])].sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
  const out = [];
  for (const s of sets) {
    const set = clean({ id: `${CATALOG_PREFIX[game]}-g${s.groupId}`, name: s.name, releasedAt: s.releasedAt });
    const data = await readJson(s.file, { cards: [] });
    for (const c of data.cards ?? []) {
      if (!c.image) continue;
      // finitions vendues (une impression chacune), sans les cotes
      const rec = clean({ ...pick(c, ["id", "name", "label", "number", "rarity", "type", "image", "sourceImage", "url"]), prices: c.prices?.map((p) => ({ sub: p.sub, usd: null })) });
      out.push({ key: s.file, img: c.image, set, rec });
    }
  }
  return out;
}

/** fichiers publiés, dans l'ordre de priorité (le budget de temps s'épuise sur les derniers) */
const FILES = [
  ...POKEMON_LANGS.slice(0, 3).map(([l, t]) => ({
    game: "pokemon",
    lang: l,
    list: async () => {
      const tcgdex = await pokemon(l, t);
      if (l !== "ja") return tcgdex;
      // japonais : les extensions récentes du site officiel d'abord (absentes de TCGdex)
      const official = await pokemonJaOfficial(new Set(tcgdex.map((e) => e.key)));
      return [...official, ...tcgdex];
    }
  })),
  { game: "onepiece", lang: "en", list: () => onepiece("en") },
  { game: "onepiece", lang: "ja", list: () => onepiece("ja") },
  { game: "onepiece", lang: "fr", list: () => onepiece("fr") },
  { game: "lorcana", lang: "en", list: lorcana },
  // Riftbound : catalogue TCGplayer, comme l'app (Riftcodex n'est plus joignable depuis l'app)
  { game: "riftbound", lang: "en", list: () => tcgcatalog("riftbound") },
  { game: "dragonball", lang: "en", list: () => tcgcatalog("dragonball") },
  { game: "digimon", lang: "en", list: () => tcgcatalog("digimon") },
  { game: "palworld", lang: "en", list: () => tcgcatalog("palworld") },
  { game: "cyberpunk", lang: "en", list: () => tcgcatalog("cyberpunk") },
  { game: "yugioh", lang: "en", list: yugioh },
  ...POKEMON_LANGS.slice(3).map(([l, t]) => ({ game: "pokemon", lang: l, list: () => pokemon(l, t) })),
  { game: "magic", lang: "en", list: magic }
].filter((f) => !ONLY || ONLY.has(f.game) || ONLY.has(`${f.game}-${f.lang}`));

// essai hors-ligne : SCAN_LIST_FILE remplace les sources par une liste [{ game, lang, entries: [{ key, img, set?, rec? }] }]
if (process.env.SCAN_LIST_FILE) {
  const lists = JSON.parse(await readFile(process.env.SCAN_LIST_FILE, "utf8"));
  FILES.splice(0, FILES.length, ...lists.map((l) => ({ game: l.game, lang: l.lang, list: async () => l.entries })));
}

/* ---------- empreintes et fiches ---------- */

const ENTRY = 64;
const PART_SIZE = Number(process.env.SCAN_PART_SIZE ?? 20_000);
const FMT = 2;
/** adresse sans paramètre de version (« …png?260929 ») : même image, pas de nouveau calcul */
const bare = (u) => u.split("?")[0];

async function writeJsonCompact(path, data) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(data));
}

/** extension Pokémon de moins de 180 jours dont la fiche n'a que les variantes supposées par TCGdex */
const RECENT_MS = 180 * 24 * 3600 * 1000;
function staleRecord(rec, set) {
  const recent = set?.date && Date.now() - Date.parse(set.date) < RECENT_MS;
  return !!recent && !!rec.vd?.some((v) => v.variantId === "generated");
}

/** ce qui est déjà publié pour un fichier : adresse de l'image → { hash, rec } */
async function previous(oldIndex, name) {
  const map = new Map();
  const file = oldIndex.fp === FP_VERSION && oldIndex.fmt === FMT ? oldIndex.files?.[name] : null;
  for (const part of file?.parts ?? []) {
    try {
      const meta = JSON.parse(await readFile(join(OUT, `${part.file}.json`), "utf8"));
      const bin = await readFile(join(OUT, `${part.file}.bin`));
      meta.imgs.forEach((img, i) => map.set(bare(img), { hash: bin.subarray(i * ENTRY, (i + 1) * ENTRY), rec: meta.cards?.[i] ?? null }));
    } catch {
      /* morceau manquant : ses cartes seront retraitées */
    }
  }
  return map;
}

let sharp;
async function fingerprintImage(url, game, photo = false) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw Object.assign(new Error(`${res.status}`), { lasting: [403, 404, 410].includes(res.status) });
  const buf = Buffer.from(await res.arrayBuffer());
  // pixels tels que décodés, à la taille d'origine : comme l'app
  let decoded;
  try {
    // photo prise au téléphone : redressée selon son orientation EXIF, comme l'affiche l'app
    const img = sharp(buf, { failOn: "none" });
    decoded = await (photo ? img.rotate() : img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw Object.assign(e, { lasting: true }); // fichier qui n'est pas une image lisible
  }
  const { data, info } = decoded;
  // photo d'une carte ajoutée à la main : l'empreinte suppose une image recadrée au ras de la carte
  if (photo && Math.abs(info.width / info.height - 63 / 88) > 0.04) {
    console.log(`::warning title=Cartes ajoutées à la main::${url} : ${info.width} × ${info.height}, pas au format d'une carte (63 × 88). À recadrer au ras de la carte, sinon le scan la reconnaîtra mal.`);
  }
  const fp = fingerprintPixels(data, info.width, info.height, game);
  const out = Buffer.alloc(ENTRY);
  for (let i = 0; i < 8; i++) out.writeUInt32LE(fp.full[i], i * 4);
  for (let i = 0; i < 8; i++) out.writeUInt32LE(fp.art[i], 32 + i * 4);
  return out;
}

/** écrit un fichier en morceaux de PART_SIZE cartes, nommés d'après leur contenu */
async function writeParts(name, f, kept) {
  const parts = [];
  for (let k = 0; k * PART_SIZE < kept.length; k++) {
    const slice = kept.slice(k * PART_SIZE, (k + 1) * PART_SIZE);
    // extensions de ce morceau seulement, réindexées
    const sets = [];
    const setIndex = new Map();
    const cards = slice.map((e) => {
      if (!e.rec) return null;
      if (!e.set) return e.rec;
      const id = JSON.stringify(e.set);
      if (!setIndex.has(id)) setIndex.set(id, sets.push(e.set) - 1);
      return { s: setIndex.get(id), ...e.rec };
    });
    const meta = { fp: FP_VERSION, fmt: FMT, game: f.game, lang: f.lang, sets, keys: slice.map((e) => e.key), imgs: slice.map((e) => e.img), cards };
    const json = JSON.stringify(meta);
    const bin = Buffer.concat(slice.map((e) => e.hash));
    const hash = createHash("sha1").update(bin).update(json).digest("hex").slice(0, 10);
    const file = `${name}.${k}.${hash}`;
    await writeFile(join(OUT, `${file}.json`), json);
    await writeFile(join(OUT, `${file}.bin`), bin);
    parts.push({ file, n: slice.length, bytes: bin.length + Buffer.byteLength(json) });
  }
  return parts;
}

async function main() {
  console.log(`Empreintes conformes à l'app (${selfTest()} cas de test).`);
  sharp = (await import("sharp")).default;
  sharp.concurrency(1);
  await mkdir(join(OUT, "state"), { recursive: true });
  const failedPath = join(OUT, "state", "failed.json");
  const failed = await readJson(failedPath, {});
  const oldIndex = await readJson(join(OUT, "index.json"), { files: {} });
  const sameFormat = oldIndex.fp === FP_VERSION && oldIndex.fmt === FMT;
  const files = {};
  let computed = 0;

  for (const f of FILES) {
    const name = `${f.game}-${f.lang}`;
    const keepOld = (why) => {
      console.log(`${name} : ${why}, index précédent conservé.`);
      if (sameFormat && oldIndex.files?.[name]) files[name] = oldIndex.files[name];
    };
    if (timeLeft() < 5 * 60_000) {
      keepOld("plus de temps");
      continue;
    }
    let entries;
    try {
      entries = await f.list();
    } catch (e) {
      keepOld(`liste indisponible (${e.message})`);
      continue;
    }
    // cartes ajoutées à la main (curated/cards.json), reconnues à partir de leur photo
    entries = [...(await curatedScanEntries(f.game, f.lang).catch(() => [])), ...entries];
    // une adresse d'image = une entrée
    const seen = new Set();
    entries = entries.filter((e) => (seen.has(e.img) ? false : (seen.add(e.img), true)));
    const known = await previous(oldIndex, name);
    for (const e of entries) {
      const k = known.get(bare(e.img));
      if (!k) continue;
      e.hash = k.hash;
      // fiche : celle de la liste si elle vient d'être lue (données fraîches), sinon celle déjà publiée —
      // sauf la fiche Pokémon d'une extension récente dont TCGdex n'avait pas encore les variantes (« generated ») :
      // elle est redemandée, TCGdex complète ses extensions dans les semaines qui suivent leur sortie
      if (!e.rec && k.rec && !(e.detail && staleRecord(k.rec, e.set))) {
        const { s: _s, ...rec } = k.rec;
        e.rec = rec;
      }
    }
    const lastingFailure = (e) => failed[e.img] && Date.now() - Date.parse(failed[e.img]) < RETRY_FAILED_MS;
    const todo = entries.filter((e) => (!e.hash && !lastingFailure(e)) || (e.hash && !e.rec && e.detail));
    console.log(`${name} : ${entries.length} cartes, ${entries.length - todo.length} complètes, ${todo.length} à traiter.`);

    let next = 0;
    let done = 0;
    let transient = 0;
    const worker = async () => {
      while (next < todo.length && timeLeft() > 3 * 60_000) {
        const e = todo[next++];
        if (!e.hash) {
          try {
            e.hash = await fingerprintImage(e.img, f.game, String(e.key).startsWith("cur:"));
            delete failed[e.img];
          } catch (err) {
            // image absente ou illisible : mise de côté une semaine ; panne passagère (réseau, 5xx, 429) : réessayée à la passe suivante
            if (err.lasting) failed[e.img] = new Date().toISOString();
            else transient++;
          }
        }
        if (e.hash && !e.rec && e.detail) {
          try {
            e.rec = await e.detail();
          } catch {
            /* fiche réessayée à la passe suivante ; l'app demandera la carte à sa source en attendant */
          }
        }
        if (++done % 500 === 0) console.log(`  ${name} : ${done}/${todo.length}`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    computed += done;
    if (transient) console.warn(`  ${name} : ${transient} images injoignables pour l'instant, réessayées à la prochaine passe.`);

    const kept = entries.filter((e) => e.hash);
    const parts = await writeParts(name, f, kept);
    const records = kept.filter((e) => e.rec).length;
    files[name] = {
      game: f.game,
      lang: f.lang,
      count: kept.length,
      total: entries.length,
      records,
      bytes: parts.reduce((n, p) => n + p.bytes, 0),
      parts
    };
    console.log(`${name} : ${kept.length}/${entries.length} cartes dans l'index (${records} avec fiche), ${parts.length} morceau(x).`);
  }

  // fichiers d'une passe précédente qui n'ont pas été traités cette fois (filtre SCAN_GAMES)
  if (sameFormat) for (const [k, v] of Object.entries(oldIndex.files ?? {})) files[k] ??= v;
  // morceaux qui ne sont plus référencés
  const used = new Set(Object.values(files).flatMap((f) => f.parts.flatMap((p) => [`${p.file}.json`, `${p.file}.bin`])));
  for (const file of await readdir(OUT)) {
    if (/\.(json|bin)$/.test(file) && file !== "index.json" && !used.has(file)) await rm(join(OUT, file), { force: true });
  }
  await writeJsonCompact(failedPath, failed);
  await writeFile(join(OUT, "index.json"), JSON.stringify({ fp: FP_VERSION, fmt: FMT, updatedAt: new Date().toISOString(), files }, null, 1) + "\n");
  console.log(`Terminé en ${Math.round((Date.now() - started) / 60_000)} min, ${computed} cartes traitées.`);
}

await main();
