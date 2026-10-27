// Sonde : produits et guide Cardmarket des autres licences (copies compactes pour analyse)
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
const UA = "thothectio-sealed/1.0 (+https://github.com/Borypb/thothectio-sealed)";
const get = async (u) => { const r = await fetch(u, { headers: { "User-Agent": UA } }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const CM = "https://downloads.s3.cardmarket.com/productCatalog";
for (const g of [3, 13, 17, 18, 19, 22, 23, 24, 25, 26]) {
  try {
    const p = await get(`${CM}/productList/products_singles_${g}.json`);
    const q = await get(`${CM}/priceGuide/price_guide_${g}.json`);
    await writeFile(`cm-${g}-products.json.gz`, gzipSync(JSON.stringify(p)));
    await writeFile(`cm-${g}-guide.json.gz`, gzipSync(JSON.stringify(q)));
    console.log(g, p.products.length, p.products[0]?.categoryName, q.priceGuides.length);
  } catch (e) { console.log(g, e.message); }
}
