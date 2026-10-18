// Script 6 — produits scellés des licences autres que Pokémon, depuis le catalogue TCGplayer (TCGCSV), en anglais.
// One Piece, Magic, Yu-Gi-Oh!, Lorcana, Digimon, Dragon Ball Fusion World, Riftbound, Palworld.
// Chaque produit est rattaché à l'extension de l'app (mêmes identifiants que dans Licences) quand c'est possible.
// Incrémental : un groupe n'est relu que si son `modifiedOn` a changé ; les cotes TCGplayer, chaque jour.
// Sorties : raw/<licence>-en.json, <licence>-en.json, prices-<licence>.json, entrées dans index.json
import { getJson, norm, readJson, writeJson } from "./lib.mjs";

const TCGCSV = "https://tcgcsv.com/tcgplayer";

/**
 * licences de l'app → catégorie TCGplayer (essayées dans l'ordre), préfixe des identifiants,
 * et façon de retrouver l'extension de l'app à partir du groupe TCGplayer
 */
export const LICENCES = {
  onepiece: { cats: [/^one piece card game$/i, /^one piece/i], prefix: "op", link: "onepiece" },
  magic: { cats: [/^magic$/i, /^magic: the gathering$/i, /^magic/i], prefix: "mtg", link: "magic" },
  yugioh: { cats: [/^yugioh$/i, /^yu-?gi-?oh/i], prefix: "ygo", link: "yugioh" },
  lorcana: { cats: [/^lorcana tcg$/i, /lorcana/i], prefix: "lor", link: "lorcana" },
  digimon: { cats: [/^digimon card game$/i, /^digimon/i], prefix: "dgm", link: "group" },
  dragonball: { cats: [/^dragon ball super fusion world$/i, /fusion world/i], prefix: "db", link: "group" },
  riftbound: { cats: [/^riftbound/i, /riftbound/i], prefix: "rb", link: "group" },
  palworld: { cats: [/^palworld/i], prefix: "pal", link: "group" }
};

/** TCGplayer met la date de récolte à la place des dates inconnues */
const realDate = (d) => (d && !/\.\d{5,}Z$/.test(d) ? d.slice(0, 10) : undefined);

const hasField = (p, re) => (p.extendedData ?? []).some((e) => re.test(e.name));

/**
 * Type de produit d'après son nom anglais, pour les jeux autres que Pokémon.
 * null : pas un produit scellé à proposer (lots revendeurs, accessoires, cartes à l'unité).
 */
export function classifyTcg(name) {
  const n = name.toLowerCase();
  if (/code card|\[set of \d+\]|\bart series\b|\bsingles?\b|\bplaymat\b|\bsleeves?\b|\bdeck protector\b|\bcard sleeves\b|\bdice\b|\btoken\b|\blife counter\b/.test(n)) return null;
  if (/\bcase\b/.test(n) && !/on the case|case file|briefcase/.test(n)) return "case";
  if (/\bdisplay\b/.test(n) && !/booster display|booster box display|play booster display|draft booster display|set booster display|collector booster display/.test(n)) return "case";
  if (/booster (box|display)|draft booster box|play booster box|set booster box|collector booster box|booster box display/.test(n)) return "booster_box";
  if (/pre-?release|prerelease/.test(n)) return "build_battle";
  if (/booster bundle|\bbundle\b|gift bundle|fat pack/.test(n)) return "bundle";
  if (/mini tin/.test(n)) return "mini_tin";
  if (/\btin\b/.test(n)) return "tin";
  if (/blister|\b(2|3)[- ]pack\b|double pack|triple pack|checklane/.test(n)) return "blister";
  if (/starter deck|start deck|structure deck|commander deck|theme deck|challenger deck|planeswalker deck|intro pack|precon|preconstructed|duel deck|speed duel|\bdeck\b/.test(n) && !/deck box|collection|binder|portfolio/.test(n)) return "deck";
  if (/binder|portfolio/.test(n)) return "binder";
  if (/booster pack|collector booster|draft booster|set booster|play booster|jumpstart|\bbooster\b|\bpack\b/.test(n)) return "booster";
  if (/collection|trove|gift box|gift set|premium|chest|box\b|bundle|calendar|kit\b|secret lair/.test(n)) return "collection";
  return "other";
}

/** produit scellé : ni numéro ni rareté (ce que portent les cartes) */
const isSealed = (p) => !hasField(p, /^(number|rarity|card number)$/i) && classifyTcg(p.name) !== null;

/** extensions des sources de l'app, pour rattacher les groupes TCGplayer */
async function appSets(link) {
  try {
    if (link === "magic") {
      const json = await getJson("https://api.scryfall.com/sets", { delay: 100 });
      return (json.data ?? []).map((s) => ({ id: `mtg-${s.code}`, code: s.code, name: s.name }));
    }
    if (link === "yugioh") {
      const json = await getJson("https://db.ygoprodeck.com/api/v7/cardsets.php", { delay: 100 });
      return (json ?? []).map((s) => ({ id: `ygo-${String(s.set_code).toLowerCase()}`, code: s.set_code, name: s.set_name }));
    }
    if (link === "lorcana") {
      const json = await getJson("https://api.lorcast.com/v0/sets", { delay: 100 });
      return (Array.isArray(json) ? json : json.results ?? []).map((s) => ({ id: `lor-${s.code}`, code: s.code, name: s.name }));
    }
  } catch (e) {
    console.warn(`Extensions ${link} indisponibles : rattachement par code seulement`, e.message);
  }
  return [];
}

/** « OP-01 », « OP01 », « op 01 » → « op01 » */
const codeKey = (c) => String(c ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** extension de l'app pour un groupe TCGplayer */
function linkSet(cfg, group, sets) {
  if (cfg.link === "group") return `${cfg.prefix}-g${group.groupId}`;
  const abbr = codeKey(group.abbreviation);
  if (cfg.link === "onepiece") {
    // « OP01 », « ST-10 », « EB01 », « PRB01 » ; sinon le code en tête du nom (« Romance Dawn [OP01] »)
    const code = abbr || codeKey(group.name.match(/\b((?:OP|ST|EB|PRB)-?\d{2})\b/i)?.[1]);
    return /^(op|st|eb|prb)\d{2}$/.test(code) ? `op-${code}` : undefined;
  }
  const byCode = abbr ? sets.find((s) => codeKey(s.code) === abbr) : undefined;
  if (byCode) return byCode.id;
  const name = norm(group.name);
  const byName = sets.filter((s) => norm(s.name) === name);
  if (byName.length === 1) return byName[0].id;
  return undefined;
}

async function resolveCategory(cfg, cats) {
  for (const re of cfg.cats) {
    const hit = cats.find((c) => re.test(c.name) || re.test(c.displayName ?? ""));
    if (hit) return hit.categoryId;
  }
  return null;
}

async function harvestLicence(game, cfg, cats) {
  const categoryId = await resolveCategory(cfg, cats);
  if (!categoryId) {
    console.warn(`${game} : catégorie TCGplayer introuvable`);
    return null;
  }
  const out = `raw/${game}-en.json`;
  const previous = await readJson(out, { groups: {} });
  const sets = await appSets(cfg.link);
  const groups = (await getJson(`${TCGCSV}/${categoryId}/groups`)).results ?? [];
  const result = { game, lang: "en", categoryId, harvestedAt: new Date().toISOString(), groups: {} };
  let fetched = 0;
  for (const g of groups) {
    const cached = previous.groups?.[g.groupId];
    const setId = linkSet(cfg, g, sets);
    if (cached && cached.modifiedOn === g.modifiedOn) {
      result.groups[g.groupId] = { ...cached, setId: setId ?? cached.setId };
      continue;
    }
    let products = [];
    try {
      products = (await getJson(`${TCGCSV}/${categoryId}/${g.groupId}/products`, { delay: 120 })).results ?? [];
    } catch (e) {
      console.warn(`${game} : groupe ${g.groupId} illisible`, e.message);
      if (cached) result.groups[g.groupId] = cached;
      continue;
    }
    fetched++;
    result.groups[g.groupId] = {
      name: g.name,
      abbreviation: g.abbreviation || undefined,
      modifiedOn: g.modifiedOn,
      publishedOn: realDate(g.publishedOn),
      setId,
      products: products.filter(isSealed).map((p) => ({
        tcgplayerId: p.productId,
        name: p.name,
        kind: classifyTcg(p.name),
        releasedOn: realDate(p.presaleInfo?.releasedOn) ?? realDate(g.publishedOn),
        image: p.imageUrl,
        url: p.url
      }))
    };
  }
  await writeJson(out, result);
  const count = Object.values(result.groups).reduce((n, g) => n + g.products.length, 0);
  const linked = Object.values(result.groups).filter((g) => g.products.length && g.setId).length;
  const withProducts = Object.values(result.groups).filter((g) => g.products.length).length;
  console.log(`${game} : ${count} produits scellés, ${fetched} groupes relus, ${linked}/${withProducts} groupes rattachés à une extension`);
  return result;
}

const clean = (o) => JSON.parse(JSON.stringify(o));

/** cotes TCGplayer du jour pour les produits scellés (prix du marché, plus bas prix) */
async function harvestPrices(game, cfg, raw) {
  const items = {};
  for (const [groupId, g] of Object.entries(raw.groups)) {
    if (!g.products.length) continue;
    const ids = new Map(g.products.map((p) => [p.tcgplayerId, `${cfg.prefix}-en-tcp${p.tcgplayerId}`]));
    try {
      const rows = (await getJson(`${TCGCSV}/${raw.categoryId}/${groupId}/prices`, { delay: 80 })).results ?? [];
      for (const r of rows) {
        const id = ids.get(r.productId);
        if (!id || items[id]) continue;
        const market = r.marketPrice ?? undefined;
        const low = r.lowPrice ?? undefined;
        if (market == null && low == null) continue;
        items[id] = { tp: clean({ market, low }) };
      }
    } catch {
      /* groupe sans cotes aujourd'hui */
    }
  }
  return items;
}

export async function sealedLicences(only) {
  const cats = (await getJson(`${TCGCSV}/categories`)).results ?? [];
  const index = await readJson("index.json", { version: 1, games: {} });
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;
  for (const [game, cfg] of Object.entries(LICENCES)) {
    if (only && !only.includes(game)) continue;
    let raw;
    try {
      raw = await harvestLicence(game, cfg, cats);
    } catch (e) {
      console.warn(`${game} : récolte impossible`, e.message);
      continue;
    }
    if (!raw) continue;
    const products = [];
    for (const g of Object.values(raw.groups)) {
      for (const p of g.products) {
        if (!p.kind || p.kind === "case") continue;
        products.push({
          id: `${cfg.prefix}-en-tcp${p.tcgplayerId}`,
          game,
          kind: p.kind,
          name: p.name,
          lang: "en",
          setIds: g.setId ? [g.setId] : undefined,
          releasedAt: p.releasedOn,
          image: p.image,
          source: { tcgplayer: p.tcgplayerId }
        });
      }
    }
    const sorted = clean(products.sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "") || a.id.localeCompare(b.id)));
    if (sorted.length) {
      const file = `${game}-en.json`;
      const previous = await readJson(file, null);
      const same = previous && JSON.stringify(previous.products) === JSON.stringify(sorted);
      const version = same ? previous.version : (previous?.version ?? 0) + 1;
      if (!same) {
        await writeJson(file, { version, game, lang: "en", products: sorted });
        console.log(`${file} : v${version}, ${sorted.length} produits`);
      }
      const entry = { files: { ...(index.games?.[game]?.files ?? {}), en: { file, version, count: sorted.length } } };
      if (JSON.stringify(index.games?.[game]) !== JSON.stringify(entry)) changed = true;
      index.games = { ...index.games, [game]: entry };
    }
    try {
      const items = await harvestPrices(game, cfg, raw);
      const pfile = `prices-${game}.json`;
      await writeJson(pfile, { date: today, items });
      const pentry = { file: pfile, date: today, count: Object.keys(items).length };
      if (JSON.stringify(index.prices?.[game]) !== JSON.stringify(pentry)) changed = true;
      index.prices = { ...index.prices, [game]: pentry };
    } catch (e) {
      console.warn(`${game} : cotes indisponibles`, e.message);
    }
  }
  if (changed) {
    index.version = (index.version ?? 0) + 1;
    index.updatedAt = today;
    await writeJson("index.json", index);
    console.log(`index.json : v${index.version}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.slice(2);
  await sealedLicences(only.length ? only : undefined);
}
