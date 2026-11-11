// World of Warcraft TCG : complète le catalogue TCGplayer (cards.mjs) avec la liste de wowcards.info (wow-cards.mjs,
// « wowcards.info, créé par Richard Kämmerer, maintenu par Xavier »).
//  - extension TCGplayer reconnue (la plupart de ses noms de cartes figurent dans une édition du site) : numéro, type,
//    coût et artiste de chaque carte quand TCGplayer ne les donne pas ; image du site quand TCGplayer n'en a pas, sinon
//    en image de secours (altImages) ; cartes de l'édition absentes de TCGplayer ajoutées, si l'extension et l'édition
//    se correspondent l'une à l'autre, ou si l'extension n'est qu'une partie de l'édition (pas pour les groupes
//    TCGplayer qui mêlent plusieurs decks) ;
//  - édition du site absente de TCGplayer (Reign of Fire, Crown of the Heavens, decks de raid, promos…) : extension
//    à part (fichier cards/wow/wcx-<code>.json), sans cote TCGplayer.
// Identifiants numériques stables (l'app les attend) : extension 90 000 000 + empreinte du code, carte
// 9 000 000 000 + empreinte de « code/numéro » — hors de la plage des identifiants TCGplayer.
// Dates : mois de sortie d'après warcraft.wiki.gg (extensions de base, decks de raid et de donjon) ; inconnues sinon.
// Français : chaque carte d'une édition traduite (wowtcgfr.com, même numérotation) reçoit `tr.fr` { name, type, image } ;
// l'extension, `languages: ["en", "fr"]` et son nom français (`names.fr`).
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { readJson, writeJson } from "./lib.mjs";

const FILE = "cards/wow-wowcards.json";
/** cartes françaises de wowtcgfr.com (wow-fr.mjs, « wowtcgfr.com, créé et maintenu par Aeron ») */
const FR_FILE = "cards/wow-wowtcgfr.json";
/** code d'extension de wowtcgfr.com → code d'édition de wowcards.info, quand ils diffèrent */
const FR_EDITION = { darkportal: "dark-portal", mc: "molten-core" };

/** mois de sortie (warcraft.wiki.gg), par code d'édition du site ou début de code */
const RELEASED = {
  reign: "2013-07",
  betrayal: "2013-02",
  ancients: "2012-10",
  timewalkers: "2013-04",
  tomb: "2012-06",
  crown: "2012-02",
  throne: "2011-10",
  twilight: "2011-07",
  elements: "2011-04",
  worldbreaker: "2010-12",
  icecrown: "2010-09",
  wrathgate: "2010-05",
  scourgewar: "2009-11",
  honor: "2009-06",
  gladiators: "2009-03",
  drums: "2008-10",
  illidan: "2008-06",
  betrayer: "2008-04",
  legion: "2007-11",
  outland: "2007-08",
  "dark-portal": "2007-04",
  azeroth: "2006-10",
  caverns: "2013-04",
  aspects: "2012-08",
  deadmines: "2011-11",
  "scarlet-monastery": "2011-11",
  "shadowfang-keep": "2011-11",
  "dungeon-treasure": "2011-11",
  citadel: "2011-03",
  naxxramas: "2009-12",
  "black-temple": "2008-09",
  magtheridon: "2008-01",
  "molten-core": "2007-05",
  onyxia: "2006-11"
};

function releasedAt(code) {
  const key = Object.keys(RELEASED)
    .filter((k) => code === k || code.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? `${RELEASED[key]}-01` : undefined;
}

/** nom comparable : minuscules, sans accents ni ponctuation */
const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");

const num = (s, mod) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 12), 16) % mod;
export const editionGroupId = (code) => 90_000_000 + num(code, 9_999_999);
const cardId = (code, n) => 9_000_000_000 + num(`${code}/${n}`, 999_999_999);

/** carte du site → carte du catalogue (tr : traductions de la carte) */
const toCard = (e, c, tr) => ({
  id: cardId(e.code, c.n),
  name: c.name,
  number: c.n,
  rarity: c.rarity,
  type: c.type,
  cost: c.cost,
  artist: c.artist,
  image: c.image,
  tr,
  source: "wowcards"
});

/** cartes françaises par « édition/numéro » et noms français des éditions */
async function loadFr(codes) {
  const data = await readJson(FR_FILE, null);
  const cards = new Map();
  const names = new Map();
  for (const e of data?.editions ?? []) {
    const code = FR_EDITION[e.code] ?? e.code;
    if (!codes.has(code)) {
      console.warn(`wowtcgfr.com ${e.code} : édition anglaise introuvable`);
      continue;
    }
    names.set(code, e.name);
    for (const c of e.cards) cards.set(`${code}/${Number(c.n)}`, { name: c.name, type: c.type, image: c.image });
  }
  return { cards, names };
}

/** null : liste du site pas encore récoltée (wow-cards.yml) */
export async function loadWow() {
  const data = await readJson(FILE, null);
  if (!data?.editions?.length) return null;
  const editions = data.editions
    .filter((e) => e.cards?.length)
    .map((e) => {
      const byName = new Map();
      for (const c of e.cards) if (!byName.has(fold(c.name))) byName.set(fold(c.name), c);
      return { ...e, byName };
    });
  const fr = await loadFr(new Set(editions.map((e) => e.code)));
  const trOf = (code, n) => {
    const f = fr.cards.get(`${code}/${Number(n)}`);
    return f ? { fr: f } : undefined;
  };
  /** édition → meilleur groupe TCGplayer qui la couvre (au moins 60 % de ses noms) */
  const covered = new Map();
  let filled = 0;
  let added = 0;

  /**
   * complète les cartes d'une extension TCGplayer (avant son enregistrement) ; renvoie ce qui s'ajoute à sa fiche
   * dans l'index (langues, nom français)
   */
  function enrich(groupId, data) {
    const names = new Set(data.cards.map((c) => fold(c.name)));
    const scored = editions
      .map((e) => {
        let ov = 0;
        for (const n of e.byName.keys()) if (names.has(n)) ov++;
        return { e, ov, ofEdition: ov / e.byName.size, ofGroup: ov / (names.size || 1) };
      })
      .filter((x) => x.ov >= 3 && (x.ofEdition >= 0.6 || x.ofGroup >= 0.5))
      .sort((a, b) => b.ov - a.ov);
    if (!scored.length) return undefined;
    // extension TCGplayer entièrement comprise dans une seule édition (« The Black Temple » : 23 des 70 cartes du deck
    // de raid) : c'est cette édition, incomplète chez TCGplayer
    const best = scored[0];
    const subset = best.ofGroup >= 0.9 && best.ov >= 10 && (scored[1]?.ov ?? 0) < best.ov * 0.5;
    for (const x of scored) {
      if (x.ofEdition < 0.6 && !(subset && x === best)) continue;
      const prev = covered.get(x.e.code);
      if (!prev || x.ov > prev.ov) covered.set(x.e.code, { groupId, ov: x.ov });
    }
    for (const c of data.cards) {
      const k = fold(c.name);
      const hit = scored.find((x) => x.e.byName.has(k));
      if (!hit) continue;
      const w = hit.e.byName.get(k);
      const before = JSON.stringify(c);
      // traduction : seulement si l'édition correspond vraiment à l'extension (pas pour une réimpression ailleurs)
      const tr = hit.ofEdition >= 0.6 || (subset && hit === best) ? trOf(hit.e.code, w.n) : undefined;
      if (tr) c.tr = tr;
      else delete c.tr;
      c.number ??= w.n;
      c.type ??= w.type;
      c.cost ??= w.cost;
      c.artist ??= w.artist;
      if (w.image && !c.image && !c.pendingImage) c.image = w.image;
      else if (w.image && w.image !== c.image) c.altImages = [w.image];
      if (JSON.stringify(c) !== before) filled++;
    }
    // l'édition et l'extension se correspondent l'une à l'autre : cartes de l'édition absentes de TCGplayer
    if (subset || (best.ofEdition >= 0.6 && best.ofGroup >= 0.6 && (scored[1]?.ov ?? 0) < best.ov * 0.8)) {
      for (const [k, w] of best.e.byName) {
        if (names.has(k)) continue;
        data.cards.push(toCard(best.e, w, trOf(best.e.code, w.n)));
        added++;
      }
    }
    return extraFields(data.cards, scored.find((x) => fr.names.has(x.e.code) && (x.ofEdition >= 0.6 || (subset && x === best)))?.e.code);
  }

  /** langues de l'extension et nom français, d'après les traductions de ses cartes */
  function extraFields(cards, code) {
    if (!cards.some((c) => c.tr?.fr)) return undefined;
    return { languages: ["en", "fr"], names: code && fr.names.get(code) ? { fr: fr.names.get(code) } : undefined };
  }

  /** éditions du site qu'aucune extension TCGplayer ne couvre : extensions à part */
  async function extraSets(hash) {
    const out = [];
    for (const e of editions) {
      if (covered.has(e.code)) continue;
      const groupId = editionGroupId(e.code);
      const file = `cards/wow/wcx-${e.code}.json`;
      const data = { groupId, source: "wowcards", cards: e.cards.map((c) => toCard(e, c, trOf(e.code, c.n))) };
      await writeJson(file, data);
      out.push({
        groupId,
        name: e.name,
        code: e.code.toUpperCase(),
        releasedAt: releasedAt(e.code),
        count: data.cards.length,
        file,
        source: "wowcards",
        ...extraFields(data.cards, e.code),
        version: hash(data.cards)
      });
    }
    // édition désormais retrouvée sur TCGplayer : son fichier à part n'a plus lieu d'être
    const kept = new Set(out.map((s) => s.file.split("/").pop()));
    for (const f of await readdir("cards/wow").catch(() => [])) if (/^wcx-.*\.json$/.test(f) && !kept.has(f)) await rm(`cards/wow/${f}`);
    console.log(
      `wow : ${covered.size} éditions de wowcards.info retrouvées sur TCGplayer (${filled} cartes complétées, ${added} ajoutées), ` +
        `${out.length} éditions ajoutées (${out.reduce((n, s) => n + s.count, 0)} cartes) ; ` +
        `français : ${fr.names.size} éditions de wowtcgfr.com, ${fr.cards.size} cartes`
    );
    return out;
  }

  return { enrich, extraSets };
}
