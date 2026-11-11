// World of Warcraft TCG en français : cartes de wowtcgfr.com (créé et maintenu par Aeron, avec son accord du
// 11/11/2026 ; crédit : wowtcgfr.com, Aeron, et le Discord de sa communauté).
// Lecture lente et légère : la page des extensions, puis la page de chaque extension française (numéro, nom, type,
// image). Les pages de chaque carte ne sont pas lues. robots.txt : tout est permis, une page par seconde au plus.
// Lancé avec wow-cards.mjs, une fois par mois (wow-cards.yml).
// Sortie : cards/wow-wowtcgfr.json
//   { updatedAt, source, credit, community, editions: [{ code, name, cards: [{ n, name, type, image }] }] }
// Les cartes françaises sont reliées aux cartes anglaises par leur extension et leur numéro : wow-merge.mjs.
import { htmlText as text, readJson, UA, writeJson } from "./lib.mjs";

const SITE = "https://wowtcgfr.com";
const FILE = "cards/wow-wowtcgfr.json";
export const WOWTCGFR_COMMUNITY = "https://discord.gg/EX9fQqyyzg";
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

/** le site garde des morceaux de code commentés dans ses pages */
const uncomment = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

/** extensions françaises de la page « World of Warcraft JCC » : code et nom français */
function editions(html) {
  const out = [];
  const seen = new Set();
  const re = /href="https:\/\/wowtcgfr\.com\/edition\/([^/"]+)\/fr" style="text-decoration: none; display:block;">([\s\S]*?)<\/a>/g;
  for (const m of uncomment(html).matchAll(re)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    // le nom est le premier texte du bloc (puis « 364 Cartes », l'année)
    const name = m[2]
      .split(/<[^>]+>/)
      .map(text)
      .find((x) => x && !/^\d+\s*cartes?$/i.test(x) && !/^\d{4}$/.test(x));
    out.push({ code: m[1], name: name ?? m[1] });
  }
  return out;
}

/** cartes d'une page d'extension */
function cardsOf(html, code) {
  const rows = [];
  for (const tr of uncomment(html).split("<tr>").slice(1)) {
    const n = /<td align="right">\s*(\w+)\s*<\/td>/.exec(tr)?.[1];
    const a = /<a href="https:\/\/wowtcgfr\.com\/carte\/edition\/[^"]+"[\s\S]*?img\.src='(https:\/\/wowtcgfr\.com\/cartes\/[^']+)'[\s\S]*?>([\s\S]*?)<img/.exec(tr);
    if (!n || !a) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
    // numéro en double dans la page (Héros d'Azeroth n° 150) : la première ligne
    if (rows.some((r) => Number(r.n) === Number(n))) continue;
    rows.push({ n, name: text(a[2]), type: tds[2] || undefined, image: a[1] });
  }
  if (!rows.length) console.warn(`wowtcgfr.com ${code} : aucune carte lue`);
  return rows;
}

export async function wowFr() {
  const list = editions(await page("/world-of-warcraft-jcc"));
  if (!list.length) throw new Error("wowtcgfr.com : aucune extension trouvée");
  const prev = await readJson(FILE, { editions: [] });
  const prevBy = new Map(prev.editions.map((e) => [e.code, e]));
  const out = [];
  for (const e of list) {
    try {
      out.push({ ...e, cards: cardsOf(await page(`/edition/${e.code}/fr`), e.code) });
    } catch (err) {
      console.warn(`wowtcgfr.com ${e.code} : ${err.message}`);
      if (prevBy.has(e.code)) out.push(prevBy.get(e.code));
    }
  }
  await writeJson(FILE, {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: SITE,
    credit: "wowtcgfr.com, créé et maintenu par Aeron",
    community: WOWTCGFR_COMMUNITY,
    editions: out
  });
  console.log(`wowtcgfr.com : ${out.length} extensions, ${out.reduce((n, e) => n + e.cards.length, 0)} cartes`);
}

if (import.meta.url === `file://${process.argv[1]}`) await wowFr();
