// Sorcery: Contested Realm : complète le catalogue TCGplayer (cards.mjs) avec la liste officielle de l'éditeur,
// api.sorcerytcg.com/api/cards (toutes les cartes et toutes leurs impressions : extension, finition, produit ; ni image
// ni cote).
//  - chaque impression officielle est rapprochée d'une carte TCGplayer : même nom, même extension (ou une extension ou
//    une mention promo de TCGplayer pour les promos), même finition ; puis, pour les restes, nom au pluriel près
//    (« Foot Soldiers »), finition ou extension seule (TCGplayer range parfois une promo ailleurs) ; enfin nom
//    approchant pour les promos (« Apurrentice Wizard » chez TCGplayer, « Apprentice Wizard » chez l'éditeur) ;
//  - impression sans équivalent TCGplayer : ajoutée à son extension TCGplayer (Crusade et Jihad d'Alpha et Beta,
//    jetons de boîte de Beta, avatars des decks de Gothic…), les promos Dust à « Dust Reward Promos », celles du Welcome
//    Kit à « Welcome Kit Promos », les autres (Organized Play, dont les 21 avatars Rainbow, Draft Kit…) à une extension
//    à part « Promos » (cards/sorcery/api-promos.json) ;
//  - extension officielle que TCGplayer n'a pas encore : rien d'ajouté (TCGplayer la liste en quelques jours, et des
//    cartes ajoutées entre-temps changeraient d'identifiant à son arrivée).
// « Jihad » s'affiche « Ji had », comme sur eBay (RENAMED).
// Cartes ajoutées : sans image ni lien TCGplayer, `source: "sorcery-api"`, finition dans `prices` (cote vide) pour que
// l'app sache si elles sont foil. Elles sont retirées puis recalculées à chaque passage : une carte que TCGplayer finit
// par lister disparaît d'elle-même.
// Identifiants numériques stables (l'app les attend) : 7 000 000 000 + empreinte de l'impression officielle (« slug »),
// hors de la plage des identifiants TCGplayer ; extension « Promos » : 77 000 999.
// Liste officielle injoignable : la dernière copie (cards/sorcery-api.json, réécrite seulement si elle change).
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { getJson, readJson, writeJson } from "./lib.mjs";

const API = "https://api.sorcerytcg.com/api/cards";
const CACHE = "cards/sorcery-api.json";
const PROMO_FILE = "cards/sorcery/api-promos.json";
export const PROMO_GROUP = 77_000_999;
export const SOURCE = "sorcery-api";

/** nom comparable : minuscules, sans accents ni ponctuation */
const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
/** même nom au pluriel près (« Foot Soldiers » / « Foot Soldier ») */
const plural = (s) => fold(s).replace(/s$/, "");

const num = (s, mod) => parseInt(createHash("sha1").update(s).digest("hex").slice(0, 12), 16) % mod;
const cardId = (slug) => 7_000_000_000 + num(slug, 999_999_999);

/** produit officiel → mention de la carte, à la manière de TCGplayer (rien pour les boosters) */
const PRODUCT = {
  Booster: undefined,
  PreconstructedDeck: "Preconstructed Deck",
  BoxTopper: "Box Topper",
  Dust: "Dust Reward",
  OrganizedPlay: "Organized Play",
  WelcomeKit: "Welcome Kit",
  DraftKit: "Draft Kit",
  AlphaInvestments: "Alpha Investments",
  Kickstarter: "Kickstarter",
  TeamCovenant: "Team Covenant",
  StarCityGames: "Star City Games"
};
const productLabel = (p) => (p in PRODUCT ? PRODUCT[p] : String(p ?? "").replace(/([a-z])([A-Z])/g, "$1 $2") || undefined);

/** finition officielle → ligne de cote TCGplayer (« Normal », « Foil », « Rainbow Foil ») */
const subOf = (finish) => (finish === "Standard" ? "Normal" : /foil/i.test(finish) ? finish : `${finish} Foil`);

/** mentions TCGplayer d'une promo, hors des extensions promo */
const PROMO_LABEL = /promo|pledge|kit|covenant|contest|judge|investment|convention|star city|scg/i;
/** variantes propres à TCGplayer (erreur d'impression, carte corrigée) : jamais une autre impression officielle */
const TCG_ONLY = /misprint|corrected/i;

/** précision de l'impression d'après son slug : « 002-foot_soldier_1-bt-s » → « 1 », « 002-frog_blue-bt-s » → « Blue » */
function suffixOf(card, p) {
  const mid = String(p.slug ?? "").split("-").slice(1, -2).join("-");
  if (!card.slug || !mid.startsWith(`${card.slug}_`)) return undefined;
  return mid
    .slice(card.slug.length + 1)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** réponse de l'API → liste compacte (copie de secours, entrée de planAdditions) */
export function compact(raw) {
  if (!Array.isArray(raw) || raw.length < 100) throw new Error("liste vide ou incomplète");
  return raw.map((c) => {
    if (!c?.name || !Array.isArray(c.printings)) throw new Error("format inattendu");
    return {
      name: c.name,
      slug: c.slug,
      rarity: c.engine?.rarity ?? undefined,
      type: c.engine?.type ?? undefined,
      printings: c.printings.map((p) => ({
        slug: p.slug,
        set: p.set?.name,
        product: p.meta?.product,
        finish: p.meta?.finish ?? "Standard",
        printedAt: p.printedAt?.slice(0, 10)
      }))
    };
  });
}

/**
 * Rapproche les impressions officielles (`cards`, liste compacte) des cartes TCGplayer (`groups` : { groupId, name,
 * cards }) ; renvoie les cartes à ajouter par extension (`add`), les promos sans extension (`promos`), les impressions
 * d'extensions que TCGplayer n'a pas (`skipped`), le nombre d'impressions retrouvées et le détail de chacune (`log`).
 */
export function planAdditions(cards, groups) {
  const T = [];
  for (const g of groups) {
    const promoGroup = /promo/i.test(g.name);
    for (const c of g.cards) {
      if (c.source) continue;
      const label = c.label ?? "";
      T.push({
        g,
        c,
        label,
        gk: fold(g.name),
        promo: promoGroup || PROMO_LABEL.test(label),
        precon: /preconstructed/i.test(label),
        tcgOnly: TCG_ONLY.test(label),
        foil: /foil/i.test(label) || (c.prices ?? []).some((r) => /foil/i.test(r.sub)),
        k1: fold(c.name),
        k2: plural(c.name),
        used: false
      });
    }
  }
  const P = [];
  for (const c of cards) {
    for (const p of c.printings) {
      P.push({ c, p, promo: /^promos?$/i.test(p.set ?? ""), sk: fold(p.set), sfx: suffixOf(c, p), foil: p.finish !== "Standard", k1: fold(c.name), k2: plural(c.name), matched: null, pass: 0 });
    }
  }
  const index = (k) => {
    const m = new Map();
    for (const t of T) m.set(t[k], [...(m.get(t[k]) ?? []), t]);
    return m;
  };
  const by1 = index("k1");
  const by2 = index("k2");
  /** même extension, ou promo des deux côtés */
  const ctx = (x, t) => (x.promo ? t.promo : x.sk === t.gk);
  /** indices qui départagent des cartes du même nom : précision (« 1 », « Blue »), produit */
  const hint = (x, t) => {
    let s = 0;
    if (x.sfx && new RegExp(`\\b${x.sfx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t.label)) s += 3;
    const pr = x.p.product;
    if (pr === "Booster" && !t.label.replace(/foil/i, "").trim()) s += 2;
    if (pr === "PreconstructedDeck" && t.precon) s += 2;
    if (pr === "BoxTopper" && /box topper/i.test(t.label)) s += 2;
    return s;
  };
  // à chaque passe, les meilleures paires d'abord
  const pass = (n, cand, score) => {
    const pairs = [];
    for (const x of P) {
      if (x.matched) continue;
      for (const t of cand(x) ?? []) {
        if (t.used) continue;
        const s = score(x, t);
        if (s >= 0) pairs.push({ x, t, s });
      }
    }
    pairs.sort((a, b) => b.s - a.s);
    for (const { x, t } of pairs) {
      if (x.matched || t.used) continue;
      x.matched = t;
      x.pass = n;
      t.used = true;
    }
  };
  // 1. même nom, même extension (ou promo), même finition
  pass(1, (x) => by1.get(x.k1), (x, t) => (x.foil === t.foil && ctx(x, t) ? 20 + hint(x, t) : -1));
  // 2. nom au pluriel près ; extension ou finition seule (jamais une carte de deck pour une autre impression)
  pass(2, (x) => by2.get(x.k2), (x, t) => {
    if (t.tcgOnly || (t.precon && x.p.product !== "PreconstructedDeck")) return -1;
    const c = ctx(x, t);
    const f = x.foil === t.foil;
    return c || f ? (c ? 4 : 0) + (f ? 3 : 0) + hint(x, t) : -1;
  });
  // 3. nom approchant (3 lettres d'écart au plus), même extension (ou promo) et même finition
  pass(3, (x) => T.filter((t) => !t.used && !t.tcgOnly && ctx(x, t) && x.foil === t.foil), (x, t) => {
    if (Math.min(x.k1.length, t.k1.length) < 8) return -1;
    const d = lev(x.k1, t.k1);
    return d <= 3 && d <= 0.3 * Math.max(x.k1.length, t.k1.length) ? 10 - d : -1;
  });

  const bySet = new Map(groups.map((g) => [fold(g.name), g]));
  const dust = groups.find((g) => /dust/i.test(g.name));
  const welcome = groups.find((g) => /welcome kit/i.test(g.name));
  const add = new Map();
  const promos = [];
  const skipped = new Map();
  for (const x of P) {
    if (x.matched) continue;
    let g;
    // produit déjà dit par le nom de l'extension : pas répété sur la carte
    let implied = false;
    if (x.promo) {
      g = x.p.product === "Dust" ? dust : x.p.product === "WelcomeKit" ? welcome : undefined;
      implied = Boolean(g);
    } else {
      g = bySet.get(x.sk);
      if (!g) {
        skipped.set(x.p.set, (skipped.get(x.p.set) ?? 0) + 1);
        continue;
      }
    }
    // promo : « Promo » dans la mention, comme chez TCGplayer (badge Promo dans l'app)
    const product = implied ? undefined : productLabel(x.p.product);
    const card = {
      id: cardId(x.p.slug),
      name: x.c.name,
      label: [x.sfx, x.promo && product && !/promo/i.test(product) ? `${product} Promo` : product, x.p.finish === "Foil" ? "Foil" : undefined].filter(Boolean).join(" · ") || undefined,
      rarity: x.c.rarity ?? undefined,
      type: x.c.type ?? undefined,
      prices: [{ sub: subOf(x.p.finish), usd: null }],
      slug: x.p.slug,
      source: SOURCE
    };
    if (g) add.set(g.groupId, [...(add.get(g.groupId) ?? []), card]);
    else promos.push({ card, printedAt: x.p.printedAt });
  }
  const log = P.map((x) => `${x.p.slug} → ${x.matched ? `${x.pass} ${x.matched.g.name} · ${x.matched.c.name}${x.matched.label ? ` [${x.matched.label}]` : ""}` : "ajoutée"}`);
  return { add, promos, skipped, matched: P.filter((x) => x.matched).length, total: P.length, log };
}

/**
 * noms réécrits comme sur les places de marché (eBay : « Ji had »), pour que l'app ne montre pas le mot (règles des
 * boutiques d'applications) ; la carte reste trouvable et se rapproche toujours par son nom d'origine
 */
const RENAMED = { Jihad: "Ji had" };
const shown = (c) => (RENAMED[c.name] ? { ...c, name: RENAMED[c.name] } : c);

/** ordre alphabétique, comme TCGplayer ; une carte ajoutée vient après celles du même nom */
const byName = (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });

async function loadOfficial() {
  try {
    const cards = compact(await getJson(API, { retries: 2 }));
    await writeJson(CACHE, { source: API, cards });
    return cards;
  } catch (e) {
    const cached = await readJson(CACHE, null);
    console.warn(`sorcery : liste officielle injoignable (${e.message})${cached ? ", dernière copie utilisée" : ""}`);
    return cached?.cards ?? null;
  }
}

/**
 * Après la mise à jour des extensions TCGplayer de Sorcery (`sets`, fiches de l'index) : ajoute à leurs fichiers les
 * impressions officielles qui leur manquent et renvoie l'extension « Promos » à ajouter à l'index (ou rien).
 */
export async function completeSorcery(sets, hash) {
  const official = await loadOfficial();
  if (!official) return [];
  const groups = [];
  for (const s of sets) {
    if (s.source === SOURCE) continue;
    const data = await readJson(s.file, null);
    if (!data) continue;
    data.cards = data.cards.filter((c) => c.source !== SOURCE);
    groups.push({ s, data, groupId: s.groupId, name: s.name, cards: data.cards });
  }
  const plan = planAdditions(official, groups);
  let added = 0;
  for (const g of groups) {
    const extra = plan.add.get(g.groupId) ?? [];
    added += extra.length;
    g.data.cards = [...g.data.cards, ...extra].map(shown).sort(byName);
    await writeJson(g.s.file, g.data);
    g.s.count = g.data.cards.length;
    g.s.version = hash(g.data.cards.map(({ prices, ...c }) => c));
  }
  const skipped = [...plan.skipped].map(([s, n]) => `${s} (${n})`).join(", ");
  console.log(
    `sorcery : liste officielle, ${plan.total} impressions, ${plan.matched} retrouvées sur TCGplayer, ` +
      `${added} ajoutées à leur extension, ${plan.promos.length} à l'extension « Promos »` +
      (skipped ? ` ; extensions pas encore sur TCGplayer : ${skipped}` : "")
  );
  if (!plan.promos.length) {
    await rm(PROMO_FILE, { force: true });
    return [];
  }
  const cards = plan.promos.map((x) => shown(x.card)).sort(byName);
  await writeJson(PROMO_FILE, { groupId: PROMO_GROUP, source: SOURCE, cards });
  const dates = plan.promos.map((x) => x.printedAt).filter(Boolean).sort();
  return [
    {
      groupId: PROMO_GROUP,
      name: "Promos",
      code: "PR",
      releasedAt: dates[0],
      count: cards.length,
      file: PROMO_FILE,
      source: SOURCE,
      version: hash(cards.map(({ prices, ...c }) => c))
    }
  ];
}
