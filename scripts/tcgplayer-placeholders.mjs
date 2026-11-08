// Images d'attente de TCGplayer. Sur les cartes d'une extension qui vient de sortir, TCGplayer met souvent une image
// provisoire (dos de carte…) tant que la vraie photo n'est pas prête, puis la remplace à la même adresse. Règle de
// l'app : un dos de carte ne s'affiche que lorsqu'il n'y a aucun visuel. Ces images ne sont donc pas publiées.
//
// Repérage : la petite image (200 px) des produits des extensions récentes est téléchargée, puis comparée :
//  - même fichier, ou image quasi identique (empreinte du scan, scan/fingerprint.mjs), sur au moins CLUSTER cartes de
//    noms différents = image d'attente ; son empreinte est gardée (`known`) ;
//  - ensuite, une image proche d'une empreinte gardée est reconnue, même sur une seule carte.
// Une image validée n'est plus retéléchargée ; une image encore en attente est revérifiée à chaque passage.
//
// Sortie : cards/tcgplayer-waiting.json
//   { updatedAt, waiting: { <produit>: <depuis> }, cleared: { <produit>: <date> }, known: [{ sha, fp, since, from }], ok: [produits] }
//   waiting : image encore en attente (l'app ne l'affiche ni ne la garde) ;
//   cleared : vraie photo arrivée depuis moins de KEEP_CLEARED_DAYS jours (l'app jette la copie gardée avant cette date).
import { createHash } from "node:crypto";
import { readJson, sleep, UA, writeJson } from "./lib.mjs";
import { FP_WORDS, fingerprintPixels, toHex } from "./scan/fingerprint.mjs";

const FILE = "cards/tcgplayer-waiting.json";
const imageUrl = (pid) => `https://tcgplayer-cdn.tcgplayer.com/product/${pid}_200w.jpg`;
/** extensions vérifiées : publiées depuis moins de 6 mois */
export const RECENT_MS = 183 * 86400000;
/** même image sur au moins 5 cartes de noms différents */
const CLUSTER = 5;
/** écart d'empreinte (bits sur 256) : « quasi identique » entre deux images du même passage, puis avec une image connue */
const NEAR = 6;
const KNOWN_NEAR = 12;
const KEEP_CLEARED_DAYS = 30;
const PARALLEL = 6;

let state = null;
/** module sharp : undefined tant qu'il n'a pas été cherché, null s'il manque (comparaison exacte des fichiers seulement) */
let sharp;

async function load() {
  if (state) return state;
  const s = await readJson(FILE, {});
  state = { waiting: s.waiting ?? {}, cleared: s.cleared ?? {}, known: s.known ?? [], ok: new Set(s.ok ?? []) };
  return state;
}

/** produits dont l'image était encore en attente au dernier passage */
export async function waitingProducts() {
  return new Set(Object.keys((await load()).waiting).map(Number));
}

async function save() {
  const st = await load();
  const limit = new Date(Date.now() - KEEP_CLEARED_DAYS * 86400000).toISOString().slice(0, 10);
  for (const [pid, d] of Object.entries(st.cleared)) if (d < limit) delete st.cleared[pid];
  await writeJson(FILE, {
    updatedAt: new Date().toISOString().slice(0, 10),
    waiting: st.waiting,
    cleared: st.cleared,
    known: st.known,
    ok: [...st.ok].sort((a, b) => a - b)
  });
}

async function decoder() {
  if (sharp === undefined) {
    try {
      sharp = (await import("sharp")).default;
    } catch {
      sharp = null;
      console.warn("images TCGplayer : module sharp absent, comparaison des fichiers seulement");
    }
  }
  return sharp;
}

const fromHex = (hex) => {
  const out = new Uint32Array(FP_WORDS);
  for (let i = 0; i < FP_WORDS; i++) out[i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  return out;
};

function distance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (a[i] ^ b[i]) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}

/** { buf } ; { missing } si TCGplayer n'a aucune image ; null si le serveur ne répond pas (nouvel essai au prochain passage) */
async function fetchImage(pid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(imageUrl(pid), { headers: { "User-Agent": UA } });
      if (res.status === 404 || res.status === 403) return { missing: true };
      if (!res.ok) throw new Error(String(res.status));
      return { buf: Buffer.from(await res.arrayBuffer()) };
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

async function describe(buf) {
  const sha = createHash("sha1").update(buf).digest("hex");
  const sh = await decoder();
  if (!sh) return { sha };
  try {
    const { data, info } = await sh(buf, { failOn: "none" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { sha, fp: fingerprintPixels(data, info.width, info.height, "pokemon").full };
  } catch {
    return { sha };
  }
}

/** nom de carte comparable (sans précision entre parenthèses ni numéro) */
export const cardKey = (name) =>
  String(name ?? "")
    .replace(/\s*[([].*?[)\]]/g, "")
    .replace(/\s*-\s*[A-Z0-9]*\d+[A-Z0-9/-]*$/i, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");

/**
 * Vérifie l'image de ces produits TCGplayer ([{ pid, name }]) : ceux qui n'ont pas encore été validés, et ceux dont
 * l'image était en attente. Renvoie les produits dont l'image est (encore) une image d'attente.
 */
export async function checkTcgplayerImages(label, products) {
  const st = await load();
  const today = new Date().toISOString().slice(0, 10);
  const todo = new Map();
  for (const p of products) if (p.pid && (!st.ok.has(p.pid) || st.waiting[p.pid])) todo.set(p.pid, cardKey(p.name) || String(p.pid));
  const pids = [...todo.keys()];
  const seen = [];
  let next = 0;
  const worker = async () => {
    while (next < pids.length) {
      const pid = pids[next++];
      const got = await fetchImage(pid);
      if (!got || got.missing) continue;
      seen.push({ pid, key: todo.get(pid), ...(await describe(got.buf)) });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const known = st.known.map((k) => ({ sha: k.sha, fp: k.fp ? fromHex(k.fp) : null }));
  const isKnown = (x) => known.some((k) => k.sha === x.sha || (k.fp && x.fp && distance(k.fp, x.fp) <= KNOWN_NEAR));
  // nouvelles images d'attente : la même image sur au moins CLUSTER cartes de noms différents
  let fresh = 0;
  for (const x of seen) {
    if (isKnown(x)) continue;
    const twins = seen.filter((y) => y.sha === x.sha || (x.fp && y.fp && distance(x.fp, y.fp) <= NEAR));
    if (new Set(twins.map((y) => y.key)).size < CLUSTER) continue;
    st.known.push({ sha: x.sha, fp: x.fp ? toHex(x.fp) : undefined, since: today, from: label });
    known.push({ sha: x.sha, fp: x.fp ?? null });
    fresh++;
  }

  const waiting = new Set();
  const checked = new Set();
  let arrived = 0;
  for (const x of seen) {
    checked.add(x.pid);
    if (isKnown(x)) {
      st.waiting[x.pid] ??= today;
      st.ok.delete(x.pid);
      waiting.add(x.pid);
    } else {
      if (st.waiting[x.pid]) {
        delete st.waiting[x.pid];
        st.cleared[x.pid] = today;
        arrived++;
      }
      st.ok.add(x.pid);
    }
  }
  // image en attente qui n'a pas pu être revérifiée (serveur muet) : toujours en attente
  for (const p of products) if (st.waiting[p.pid] && !checked.has(p.pid)) waiting.add(p.pid);
  console.log(
    `images TCGplayer (${label}) : ${seen.length} vérifiées, ${waiting.size} en attente, ${arrived} vraies photos arrivées, ${fresh} nouvelles images d'attente`
  );
  await save();
  return waiting;
}
