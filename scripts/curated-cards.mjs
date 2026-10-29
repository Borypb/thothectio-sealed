// Script 8 — cartes ajoutées à la main : celles qu'aucune source ne connaît (vieilles promos japonaises, rééditions
// de Mew ancien…). Le fichier vérifié à la main `curated/cards.json` est converti au format de l'app dans
// `cards/curated.json` ; l'index du scan à l'image y prend les photos (scan-index.mjs, `curatedScanEntries`).
//
// Format de curated/cards.json (voir le README, « Cartes ajoutées à la main ») :
//   photos  dépôt GitHub public des photos (« Borypb/thothectio-photos »), branche main
//   sets    extensions créées pour ces cartes : { id, game, name, releasedAt?, series?, printedTotal? }
//   cards   { id, game, lang, set, name, nameEn?, number?, finish?, tags?, label?, rarity?, photo?, showPhoto?, source?, note?,
//             cardmarket?, tcgplayer?, cardmarketUrl? }  (produits pour la cote : repris par pokemon-prices.mjs ;
//             cardmarketUrl : page de la carte chez Cardmarket, pour « Voir les offres »)
//           set : une extension de `sets`, ou une extension déjà connue de l'app (« pkm-miscp », « pkm-basep »…)
// Images de remplacement (curated/images.json) : cartes que la source connaît sans image, ou avec une image fausse
// (dos de carte chez TCGplayer) ; { <licence>: { <identifiant de la carte à la source>: chemin dans ce dépôt ou adresse } }.
// Sortie : cards/curated.json  { updatedAt, sets: [SetDef], cards: [CardPrinting], extraLangs: { <id extension>: [langues] },
//                               images: { <licence>: { <identifiant>: adresse } } }
import { existsSync } from "node:fs";
import { readJson, writeJson } from "./lib.mjs";

const SOURCE = "curated/cards.json";
const IMAGES = "curated/images.json";
/** fichiers de ce dépôt (photos/…) servis tels quels */
const SELF = "https://raw.githubusercontent.com/Borypb/thothectio-sealed/main/";
const OUT = "cards/curated.json";
const GAMES = ["pokemon", "digimon", "onepiece", "dragonball", "palworld", "yugioh", "magic", "lorcana", "riftbound", "cyberpunk"];
const LANGS = ["fr", "en", "ja", "de", "es", "it", "pt", "nl", "pl", "ru", "ko", "zh", "zh-cn", "th", "id"];
const FINISHES = { normal: "normal", normale: "normal", holo: "holofoil", holofoil: "holofoil", reverse: "reverse_holo", reverse_holo: "reverse_holo", metal: "metal" };
const FINISH_KEY = { normal: "normal", holofoil: "holo", reverse_holo: "reverse", metal: "metal" };
const TAGS = ["full_art", "alt_art", "special_alt", "promo", "first_edition", "parallel", "master_ball", "poke_ball", "stamped", "jumbo", "leader", "manga", "lucky"];

/** adresse d'une photo : chemin dans le dépôt des photos, ou adresse complète */
export function photoUrl(photos, photo) {
  if (!photo) return undefined;
  if (/^https?:\/\//.test(photo)) return photo;
  if (!photos) return undefined;
  return `https://raw.githubusercontent.com/${photos}/main/${photo.split("/").map(encodeURIComponent).join("/")}`;
}

/** lit et vérifie le fichier ; les erreurs bloquent la publication (une carte mal saisie ne part pas) */
export async function readCurated() {
  const src = await readJson(SOURCE, { sets: [], cards: [] });
  const errors = [];
  const sets = new Map();
  for (const s of src.sets ?? []) {
    if (!s.id || !s.game || !s.name) errors.push(`extension sans id, licence ou nom : ${JSON.stringify(s)}`);
    else if (!GAMES.includes(s.game)) errors.push(`extension ${s.id} : licence inconnue « ${s.game} »`);
    else if (sets.has(s.id)) errors.push(`extension ${s.id} en double`);
    else sets.set(s.id, s);
  }
  const seen = new Set();
  const cards = [];
  for (const c of src.cards ?? []) {
    const where = `carte ${c.id ?? JSON.stringify(c).slice(0, 60)}`;
    if (!c.id || !c.game || !c.lang || !c.set || !c.name) {
      errors.push(`${where} : id, game, lang, set et name sont obligatoires`);
      continue;
    }
    if (!GAMES.includes(c.game)) errors.push(`${where} : licence inconnue « ${c.game} »`);
    if (!LANGS.includes(c.lang)) errors.push(`${where} : langue inconnue « ${c.lang} »`);
    const finish = FINISHES[String(c.finish ?? "normal").toLowerCase()];
    if (!finish) errors.push(`${where} : finition inconnue « ${c.finish} » (normal, holo, reverse, metal)`);
    const bad = (c.tags ?? []).filter((t) => !TAGS.includes(t));
    if (bad.length) errors.push(`${where} : variantes inconnues ${bad.join(", ")}`);
    for (const f of ["cardmarket", "tcgplayer"]) {
      if (c[f] != null && !(Number.isInteger(c[f]) && c[f] > 0)) errors.push(`${where} : « ${f} » doit être le numéro du produit (nombre entier)`);
    }
    if (c.cardmarketUrl != null && !/^https:\/\/www\.cardmarket\.com\/[a-z]{2}\/[^?#]+$/.test(c.cardmarketUrl))
      errors.push(`${where} : « cardmarketUrl » doit être l'adresse d'une page de www.cardmarket.com`);
    if (seen.has(c.id)) errors.push(`${where} : id en double`);
    seen.add(c.id);
    cards.push({ ...c, finish });
  }
  return { photos: src.photos, sets, cards, errors };
}

/** carte au format de l'app (`CardPrinting`), identifiant stable `extension:numéro:langue:variante` */
export function toPrinting(c, set, photos) {
  const number = String(c.number ?? "").trim() || `x-${c.id}`;
  const key = [FINISH_KEY[c.finish], ...(c.tags ?? []).filter((t) => t === "first_edition" || t === "stamped")].join("-");
  const img = c.showPhoto === false ? undefined : photoUrl(photos, c.photo);
  return clean({
    id: `${c.set}:${number}:${c.lang}:${key}-curated`,
    game: c.game,
    setId: c.set,
    setName: set?.name ?? c.setName ?? c.set,
    number: String(c.number ?? "").trim() || "—",
    printedTotal: set?.printedTotal ? String(set.printedTotal) : undefined,
    name: c.name,
    nameEn: c.nameEn,
    lang: c.lang,
    rarity: c.rarity,
    finish: c.finish,
    variantTags: [...new Set(c.tags ?? [])],
    variantLabel: c.label,
    releasedAt: c.releasedAt ?? set?.releasedAt,
    imageSmall: img,
    imageLarge: img,
    // « Voir les offres » : la page de la version chez Cardmarket (la recherche par nom japonais ne trouve rien)
    shopLinks: c.cardmarketUrl ? { cardmarket: c.cardmarketUrl } : undefined,
    curated: true
  });
}

/**
 * images de remplacement, par licence : { pokemon: { "miscp-001": adresse } } ; un chemin (photos/…) doit exister
 * dans ce dépôt. Renvoie aussi les erreurs (elles bloquent la publication, comme pour les cartes).
 */
export async function readImageFixes() {
  const src = await readJson(IMAGES, {});
  const images = {};
  const errors = [];
  for (const [game, map] of Object.entries(src)) {
    if (game.startsWith("_")) continue;
    if (!GAMES.includes(game) || !map || typeof map !== "object") {
      errors.push(`${IMAGES} : licence inconnue « ${game} »`);
      continue;
    }
    for (const [key, v] of Object.entries(map)) {
      if (typeof v !== "string" || !v.trim()) errors.push(`${IMAGES} : ${game} ${key} sans image`);
      else if (/^https?:\/\//.test(v)) (images[game] ??= {})[key] = v;
      else if (!existsSync(v)) errors.push(`${IMAGES} : ${game} ${key} : fichier ${v} absent du dépôt`);
      else (images[game] ??= {})[key] = SELF + v.split("/").map(encodeURIComponent).join("/");
    }
  }
  return { images, errors };
}

/** retire les champs vides */
function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length)));
}

/** entrées de l'index du scan pour une licence et une langue : la photo de chaque carte, et sa fiche complète */
export async function curatedScanEntries(game, lang) {
  const { photos, sets, cards, errors } = await readCurated();
  if (errors.length) return [];
  return cards
    .filter((c) => c.game === game && c.lang === lang && photoUrl(photos, c.photo))
    .map((c) => ({ key: `cur:${c.id}`, img: photoUrl(photos, c.photo), rec: { cur: 1, p: toPrinting(c, sets.get(c.set), photos) } }));
}

export async function curatedCards() {
  const { photos, sets, cards, errors: cardErrors } = await readCurated();
  const { images, errors: imageErrors } = await readImageFixes();
  const errors = [...cardErrors, ...imageErrors];
  if (errors.length) {
    for (const e of errors) console.error(`cartes ajoutées à la main : ${e}`);
    throw new Error(`${errors.length} erreur(s) dans ${SOURCE} : rien n'est publié tant qu'elles ne sont pas corrigées`);
  }
  // langues de chaque extension : celles de ses cartes
  const langs = new Map();
  for (const c of cards) langs.set(c.set, new Set([...(langs.get(c.set) ?? []), c.lang]));
  const outSets = [...sets.values()].map((s) =>
    clean({
      id: s.id,
      game: s.game,
      name: s.name,
      series: s.series,
      code: s.code ?? s.id.replace(/^[a-z]+-/, ""),
      releasedAt: s.releasedAt,
      printedTotal: s.printedTotal,
      languages: [...(langs.get(s.id) ?? [])],
      finishes: [...new Set(cards.filter((c) => c.set === s.id).map((c) => c.finish))],
      source: "curated"
    })
  );
  // extensions déjà connues de l'app qui reçoivent des cartes dans une nouvelle langue
  const extraLangs = Object.fromEntries([...langs.entries()].filter(([id]) => !sets.has(id)).map(([id, l]) => [id, [...l]]));
  const outCards = cards.map((c) => toPrinting(c, sets.get(c.set), photos));
  await writeJson(OUT, { updatedAt: new Date().toISOString().slice(0, 10), sets: outSets, cards: outCards, extraLangs, images });
  const fixes = Object.values(images).reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`cartes ajoutées à la main : ${outCards.length} carte(s), ${outSets.length} extension(s) créée(s), ${fixes} image(s) de remplacement`);
}

if (import.meta.url === `file://${process.argv[1]}`) await curatedCards();
