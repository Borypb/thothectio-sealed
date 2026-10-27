// Sonde : copie compacte des données publiques Cardmarket (Pokémon) et TCGplayer (TCGCSV, Pokémon) pour analyse.
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const UA = "thothectio-sealed/1.0 (+https://github.com/Borypb/thothectio-sealed)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i >= 3) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}
const save = (f, data) => writeFile(f, gzipSync(JSON.stringify(data)));

const CM = "https://downloads.s3.cardmarket.com/productCatalog";
await save("cm-products.json.gz", await get(`${CM}/productList/products_singles_6.json`));
await save("cm-guide.json.gz", await get(`${CM}/priceGuide/price_guide_6.json`));

const T = "https://tcgcsv.com/tcgplayer/3";
const groups = (await get(`${T}/groups`)).results;
const products = [];
const prices = [];
for (const g of groups) {
  try {
    const p = await get(`${T}/${g.groupId}/products`);
    for (const x of p.results ?? []) {
      const ext = Object.fromEntries((x.extendedData ?? []).map((e) => [e.name, String(e.value).replace(/<[^>]+>/g, " ").slice(0, 200)]));
      if (!ext.Number && !ext.Rarity) continue;
      products.push({ g: g.groupId, id: x.productId, n: x.name, num: ext.Number, r: ext.Rarity, a: [ext.Attack1, ext.Attack2, ext.Attack3].filter(Boolean).map((s) => s.slice(0, 60)) });
    }
    const q = await get(`${T}/${g.groupId}/prices`);
    for (const x of q.results ?? []) prices.push([x.productId, x.subTypeName, x.lowPrice, x.midPrice, x.highPrice, x.marketPrice]);
  } catch (e) {
    console.log("groupe", g.groupId, e.message);
  }
  await sleep(120);
}
await save("tcg-groups.json.gz", groups.map((g) => ({ id: g.groupId, name: g.name, abbr: g.abbreviation, date: g.publishedOn })));
await save("tcg-products.json.gz", products);
await save("tcg-prices.json.gz", prices);
console.log(groups.length, "groupes,", products.length, "cartes,", prices.length, "prix");
