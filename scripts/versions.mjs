// Empreinte de la liste des extensions de chaque licence, telle que l'app la lit (mêmes sources). Publiée chaque nuit :
// l'app la lit une fois par jour et ne relit la liste d'une licence que si son empreinte a changé. Une nouvelle
// extension apparaît ainsi le lendemain de sa publication par la source, sans nouveau build ni téléchargement inutile.
// Sortie : cards/versions.json  { updatedAt, games: { <licence>: <empreinte> } }
// Une source muette garde l'empreinte de la veille.
import { createHash } from "node:crypto";
import { getJson, readJson, writeJson } from "./lib.mjs";

const FILE = "cards/versions.json";
const hash = (x) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 12);

/** extensions d'un catalogue publié par le robot (cards/index.json, cards/<licence>-<langue>/index.json) */
async function catalog(game, langs = []) {
  const index = await readJson("cards/index.json", { games: {} });
  const sets = (index.games[game]?.sets ?? []).map((s) => [s.groupId, s.version]);
  const official = [];
  for (const l of langs) official.push(((await readJson(`cards/${game}-${l}/index.json`, { sets: [] })).sets ?? []).map((s) => [s.id ?? s.code, s.version]));
  if (!sets.length && !official.some((o) => o.length)) throw new Error("catalogue vide");
  return hash([sets, official]);
}

const SOURCES = {
  async pokemon() {
    const lists = [];
    for (const l of ["en", "fr", "de", "es", "it", "pt", "ja"]) {
      const sets = await getJson(`https://api.tcgdex.net/v2/${l}/sets`, { delay: 100 });
      lists.push(sets.map((s) => [s.id, s.cardCount?.total ?? 0]));
    }
    const ja = (await readJson("cards/pokemon-ja/index.json", { sets: [] })).sets ?? [];
    return hash([lists, ja.map((s) => [s.code, s.version])]);
  },
  async magic() {
    const { data } = await getJson("https://api.scryfall.com/sets", { delay: 150 });
    return hash(data.map((s) => [s.code, s.card_count, s.released_at]));
  },
  async yugioh() {
    const sets = await getJson("https://db.ygoprodeck.com/api/v7/cardsets.php", { delay: 150 });
    return hash(sets.map((s) => [s.set_code, s.num_of_cards]));
  },
  async lorcana() {
    const json = await getJson("https://api.lorcast.com/v0/sets", { delay: 150 });
    return hash((json.results ?? json).map((s) => [s.id ?? s.code, s.released_at]));
  },
  async onepiece() {
    const lists = [];
    for (const f of ["english", "french", "english-asia", "chinese-traditional"]) {
      const rows = await getJson(`https://raw.githubusercontent.com/buhbbl/punk-records/main/${f}/packs.json`, { delay: 100 }).catch(() => ({}));
      lists.push(Object.keys(rows).sort());
    }
    return hash(lists);
  },
  riftbound: () => catalog("riftbound"),
  digimon: () => catalog("digimon", ["ja"]),
  dragonball: () => catalog("dragonball", ["ja"]),
  palworld: () => catalog("palworld"),
  cyberpunk: () => catalog("cyberpunk")
};

/** licences supplémentaires (catalogue TCGplayer) : empreinte de leur catalogue, dès qu'elles y sont */
async function extraCatalogs(out) {
  const index = await readJson("cards/index.json", { games: {} });
  for (const game of Object.keys(index.games)) {
    if (SOURCES[game]) continue;
    try {
      out[game] = await catalog(game);
    } catch {
      /* catalogue vide : rien */
    }
  }
}

export async function versions() {
  const prev = (await readJson(FILE, { games: {} })).games ?? {};
  const games = { ...prev };
  for (const [game, fn] of Object.entries(SOURCES)) {
    try {
      games[game] = await fn();
    } catch (e) {
      console.warn(`empreinte ${game} : source muette (${e.message}), celle de la veille est gardée`);
    }
  }
  await extraCatalogs(games);
  const changed = Object.keys(games).filter((g) => games[g] !== prev[g]);
  await writeJson(FILE, { updatedAt: new Date().toISOString().slice(0, 10), games });
  console.log(`empreintes des listes d'extensions : ${Object.keys(games).length} licences, changées : ${changed.join(", ") || "aucune"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await versions();
