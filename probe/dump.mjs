import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
const UA = "thothectio-sealed/1.0 (+https://github.com/Borypb/thothectio-sealed)";
const get = async (u) => { const r = await fetch(u, { headers: { "User-Agent": UA } }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const save = (f, d) => writeFile(f, gzipSync(JSON.stringify(d)));
const T = "https://tcgcsv.com/tcgplayer";
const cats = (await get(`${T}/categories`)).results;
const op = cats.find((c) => /one piece/i.test(c.name));
console.log("catégorie One Piece", op?.categoryId, op?.name);
const groups = (await get(`${T}/${op.categoryId}/groups`)).results;
const products = [], prices = [];
for (const g of groups) {
  const p = (await get(`${T}/${op.categoryId}/${g.groupId}/products`)).results ?? [];
  for (const x of p) {
    const ext = Object.fromEntries((x.extendedData ?? []).map((e) => [e.name, String(e.value).slice(0, 80)]));
    products.push({ g: g.groupId, id: x.productId, n: x.name, num: ext.Number, r: ext.Rarity });
  }
  for (const x of (await get(`${T}/${op.categoryId}/${g.groupId}/prices`)).results ?? []) prices.push([x.productId, x.subTypeName, x.lowPrice, x.midPrice, x.marketPrice]);
  await new Promise((r) => setTimeout(r, 100));
}
await save("op-groups.json.gz", groups.map((g) => ({ id: g.groupId, name: g.name, abbr: g.abbreviation, date: g.publishedOn })));
await save("op-products.json.gz", products);
await save("op-prices.json.gz", prices);
console.log(groups.length, "groupes", products.length, "produits", prices.length, "prix");
const L = "https://api.lorcast.com/v0";
const sets = await get(`${L}/sets`);
const list = sets.results ?? sets;
const cards = [];
for (const s of list) {
  const c = await get(`${L}/sets/${s.code}/cards`);
  for (const x of c.results ?? c) cards.push({ set: s.code, n: x.collector_number, name: x.name, v: x.version, r: x.rarity, prices: x.prices });
  await new Promise((r) => setTimeout(r, 120));
}
await save("lor-sets.json.gz", list);
await save("lor-cards.json.gz", cards);
console.log(list.length, "extensions Lorcana", cards.length, "cartes");
