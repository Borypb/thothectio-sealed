// World of Warcraft TCG : liste des cartes de wowcards.info (créé par Richard Kämmerer, maintenu par Xavier), avec
// son accord (6/11/2026 : « Tu peux crawler le site sans problème » ; crédit : « wowcards.info, créé par Richard
// Kämmerer, maintenu par Xavier »).
// Lecture lente et légère : la page d'accueil (liste des éditions), la page de chaque édition (numéro, nom, type, coût,
// rareté, artiste, image) et la page des cartes sans image. Les pages de chaque carte ne sont pas lues.
// Lancé une fois par mois (wow-cards.yml) : le jeu est arrêté depuis 2013, le site n'ajoute que des corrections.
// Sortie : cards/wow-wowcards.json
//   { updatedAt, source, credit, editions: [{ code, name, section, cards: [{ n, name, type, cost, rarity, artist, image }] }] }
// Fusion avec le catalogue TCGplayer (numéros, cartes et extensions absentes de TCGplayer) : wow-merge.mjs.
import { htmlText as decode, readJson, UA, writeJson } from "./lib.mjs";

const SITE = "https://www.wowcards.info";
const FILE = "cards/wow-wowcards.json";
const PAUSE_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(path) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${SITE}${path}`, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      const html = await res.text();
      await sleep(PAUSE_MS);
      return html;
    } catch (e) {
      if (i >= 2) throw e;
      await sleep(5000 * (i + 1));
    }
  }
}

/**
 * éditions des colonnes de la page d'accueil : rubrique (« Basic Sets », « Raid and Dungeon Decks »…), groupe
 * (« Timewalkers Block », « Molten Core »…) et nom. Hors extensions de base, le nom seul est souvent ambigu
 * (« Raid Deck », « Treasure », « Badges of Justice ») : il est précédé du groupe.
 */
function editions(home) {
  const body = home.slice(home.indexOf('class="homecols"'));
  const out = [];
  const seen = new Set();
  let section = "";
  let group = "";
  // un groupe s'arrête à la fin de sa sous-liste (</ul>) : les éditions suivantes de la rubrique n'en font pas partie
  const re = /<h3>([^<]*)<\/h3>|<li>([^<]+)\n|<a href="\/edition\/([^/"]+)\/en\/?"[^>]*>([^<]+)<\/a>|(<\/ul>)/g;
  for (const m of body.matchAll(re)) {
    if (m[5]) group = "";
    else if (m[1] !== undefined) {
      section = decode(m[1]);
      group = "";
    } else if (m[2] !== undefined) group = decode(m[2]);
    else if (!seen.has(m[3])) {
      seen.add(m[3]);
      const name = decode(m[4]);
      const full = group && !/^basic sets$/i.test(section) ? `${group}: ${name}` : name;
      out.push({ code: m[3], name: full, section, group: group || undefined });
    }
  }
  return out;
}

/** cartes d'une page d'édition (tableau « list ed ») */
function cardsOf(html, code) {
  const rows = [];
  for (const tr of html.split("<tr>").slice(1)) {
    const n = /class="r c-n">([^<]*)</.exec(tr)?.[1]?.trim();
    const link = /class="c-name"><a href="\/card\/[^"]*" title="([^"]*)" data-img="([^"]*)"/.exec(tr);
    if (!n || !link) continue;
    const type = /class="c-type">([\s\S]*?)<span class="m-meta">/.exec(tr)?.[1];
    const cost = /class="c-cost">([^<]*)</.exec(tr)?.[1]?.trim();
    const rarity = /class="c-rarity">([\s\S]*?)<\/td>/.exec(tr)?.[1];
    const artist = /class="c-artist">([\s\S]*?)<\/td>/.exec(tr)?.[1];
    rows.push({
      n,
      name: decode(link[1]),
      type: type ? decode(type) : undefined,
      cost: cost || undefined,
      rarity: rarity ? decode(rarity) || undefined : undefined,
      artist: artist ? decode(artist) || undefined : undefined,
      image: link[2] ? `${SITE}${link[2]}` : undefined
    });
  }
  if (!rows.length) console.warn(`wowcards.info ${code} : aucune carte lue`);
  return rows;
}

export async function wowCards() {
  const home = await page("/");
  const list = editions(home);
  if (list.length < 50) throw new Error(`liste des éditions incomplète (${list.length})`);
  // cartes dont le site n'a pas l'image : pas d'image publiée (l'app montre son dos de carte)
  const missing = new Set();
  try {
    const html = await page("/missing-images");
    for (const m of html.matchAll(/href="\/card\/([^/]+)\/en\/([^/]+)\//g)) missing.add(`${m[1]}/${m[2]}`);
  } catch (e) {
    console.warn("wowcards.info : liste des images manquantes indisponible", e.message);
  }
  const prev = await readJson(FILE, { editions: [] });
  const prevBy = new Map(prev.editions.map((e) => [e.code, e]));
  const out = [];
  for (const e of list) {
    try {
      const cards = cardsOf(await page(`/edition/${e.code}/en`), e.code).map((c) => (missing.has(`${e.code}/${c.n}`) ? { ...c, image: undefined } : c));
      out.push({ ...e, cards });
    } catch (err) {
      // édition illisible ce mois-ci : celle du mois dernier
      console.warn(`wowcards.info ${e.code} : ${err.message}`);
      if (prevBy.has(e.code)) out.push(prevBy.get(e.code));
    }
  }
  await writeJson(FILE, {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: SITE,
    credit: "wowcards.info, créé par Richard Kämmerer, maintenu par Xavier",
    editions: out
  });
  console.log(`wowcards.info : ${out.length} éditions, ${out.reduce((n, e) => n + e.cards.length, 0)} cartes, ${missing.size} sans image`);
}

if (import.meta.url === `file://${process.argv[1]}`) await wowCards();
