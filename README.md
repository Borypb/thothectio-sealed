# Thothectio – Produits scellés

Catalogue public des produits scellés (coffrets Dresseur d'Élite, displays, collections Ultra Premium, Pokébox…) utilisé par **Thothectio**, l'album TCG local-first.

L'app lit ce dépôt en lecture seule. Elle ne lui envoie rien, et ta collection reste sur ton appareil.

## Structure

```
index.json             # versions, libellés des types, un fichier par licence et par langue
pokemon-fr.json        # fichiers lus par l'app (générés, ne pas modifier à la main)
pokemon-en.json
pokemon-ja.json
curated/               # catalogue vérifié à la main : prioritaire sur tout le reste
                       #   (cards.json : cartes ajoutées à la main, voir plus bas)
cards/curated.json     # ces cartes au format de l'app (généré)
raw/                   # récolte brute (script 1)
generated/             # produits déduits dans d'autres langues (script 2)
review/                # produits que le script 2 n'a pas su traduire, à compléter à la main
scripts/               # harvest.mjs → localize.mjs → build.mjs (update.mjs enchaîne les trois)
```

## Mise à jour automatique

Une GitHub Action (`.github/workflows/update.yml`) tourne chaque nuit, et à la demande depuis l'onglet Actions :

1. **Récolte** (`harvest.mjs`) : produits scellés du catalogue TCGplayer via [TCGCSV](https://tcgcsv.com) (anglais et japonais),
   rattachés aux extensions TCGdex. Seules les extensions modifiées depuis la veille sont retéléchargées.
   **Japonais** (`harvest-jp.mjs`) : catalogue officiel de [pokemon-card.com](https://www.pokemon-card.com/products/)
   (noms japonais officiels, dates, prix en yens, contenu). TCGplayer ne sert plus qu'aux BOX, absentes du site officiel.
2. **Déclinaison** (`localize.mjs`) : à partir de la récolte anglaise, propose l'équivalent français de chaque produit :
   nom de l'extension traduit par TCGdex, gabarit par type (« Coffret Dresseur d'Élite … »), Pokémon traduits via PokeAPI.
   Les exclusivités d'enseignes américaines, cartons de distribution et présentoirs sont écartés.
   Les produits que les règles ne savent pas nommer sont traduits un par un dans `curated/translations-fr.json`
   (généré par `scripts/data/translations-fr.py`, noms de Pokémon tirés de la table officielle PokeAPI).
   Ce qui reste sans traduction va dans `review/`.
3. **Assemblage** (`build.mjs`) : fusionne `curated/` (prioritaire), `generated/` et `raw/`,
   et n'incrémente la version d'un fichier que si son contenu a changé.

4. **Cotes** (`prices.mjs`) : cote du marché secondaire, distincte du prix de sortie (`msrp`).
   Cardmarket (fichiers publics du jour, en €) et TCGplayer (via TCGCSV, en $), dans `prices-pokemon.json`,
   un fichier à part qui change chaque jour sans faire changer la version du catalogue.
   Une fiche Cardmarket de produit scellé couvre toutes les langues européennes : la cote est « toutes langues ».
   Les boîtes « 1st Edition », que Cardmarket ne distingue pas, restent sans cote plutôt qu'avec une cote fausse.

5. **Taux de change** (`fx.mjs`) : taux de référence de la BCE (1 € = x devise) dans `fx.json`.
   L'app les prend d'abord chez Frankfurter (même source BCE) et se rabat sur ce fichier si besoin.

6. **Cotes des cartes Pokémon que TCGdex ne cote pas** (`pokemon-prices.mjs`) : TCGdex lit le guide de prix
   public de Cardmarket et les prix TCGplayer, mais seulement pour les cartes qu'il a reliées à un produit.
   Les autres (promos Wizards, Black & White, Diamant et Perle, Nintendo, Shiny Vault de Destinées Occultes…)
   n'ont pas de cote dans l'app. Le script les retrouve chaque nuit :
   Cardmarket par le nom anglais et les attaques dans l'extension Cardmarket (« Arcanine [Quick Attack | Flames of Rage] »),
   TCGplayer par le produit indiqué dans la fiche TCGdex, sinon par le numéro dans le groupe de l'extension.
   Champs identiques à ceux de TCGdex (`pricing.cardmarket`, `pricing.tcgplayer`, sans le prix « haut » de TCGplayer,
   qui est une annonce et pas une vente), dans `cards/pokemon-prices.json` :
   `{ updatedAt, cardmarketAt, sets: { <id TCGdex>: { <numéro>: { cm, tp } } } }`.

Les produits déduits portent un champ `derived` (nom anglais d'origine) ; ceux du catalogue manuel, `verified: true`.

**Relance après échec** (`.github/workflows/relance.yml`) : quand une tâche du robot échoue (site source
injoignable, panne passagère), ses étapes en échec sont relancées 15 min plus tard, puis 1 h après le premier
échec si besoin. Deux essais au plus, jamais de relance d'une relance : pas de boucle. Tout se passe sur GitHub,
gratuitement (dépôt public). Les tâches tournent sous Node 24.

## Index du scan à l'image (branche `scan`)

Thothectio reconnaît une carte à l'image **sans rien télécharger d'avance ni rien enregistrer** grâce à cet index,
lu en mémoire par l'app. Une seconde Action (`.github/workflows/scan-index.yml`, chaque nuit après le catalogue,
et à la demande avec un choix de licences et un temps maximal) le construit avec `scripts/scan-index.mjs` :

- pour chaque carte connue de sa source (TCGdex, Scryfall, YGOPRODeck, Lorcast, punk-records, Riftcodex, et `cards/` pour
  Dragon Ball, Digimon, Palworld, Cyberpunk), l'image est téléchargée une fois et réduite à une **empreinte** de 512 bits
  (`scripts/scan/fingerprint.mjs`, copie conforme du calcul de l'app, vérifiée au démarrage par `scripts/scan/vector.json`) ;
- la **fiche** de la carte (champs bruts de la source : nom, numéro, rareté, variantes…, **sans les cotes**) est publiée avec :
  l'app l'affiche aussitôt, sans attendre la source, en la convertissant avec les mêmes fonctions que pour un pack
  téléchargé (identifiants de cartes identiques). Les cotes restent demandées à la source, à la demande ;
- **incrémental** : empreintes et fiches déjà publiées sont reprises, seules les nouvelles cartes sont traitées, les plus
  récentes d'abord. La première construction complète prend plusieurs nuits (environ 300 000 images, dont 100 000 pour Magic) ;
- publié sur la branche **`scan`**, remplacée à chaque passe (pas d'historique qui grossit), en deux commits :
  les données, puis `index.json` qui indique ce commit. L'app lit `index.json` sur GitHub (toujours à jour) et les données
  sur **jsDelivr** à l'adresse immuable de ce commit (cache CDN permanent), avec GitHub en secours.

On ne publie pas les images : seulement leur adresse.

```
index.json                                 { fp, fmt, updatedAt, commit, files: { "pokemon-fr": { game, lang, count, total, records, bytes, parts } } }
<licence>-<langue>.<n>.<empreinte>.json    { fp, fmt, game, lang, sets: [...], keys: [...], imgs: [...], cards: [...] }
<licence>-<langue>.<n>.<empreinte>.bin     n × 64 octets : carte entière (8 × uint32 LE), puis illustration (8 × uint32 LE)
state/                                     listes complètes et images en échec, pour la passe suivante
```

Un fichier contient au plus 20 000 cartes (limite de jsDelivr) et son nom change avec son contenu.
Le sens de `keys[i]`, `cards[i]` et `sets` selon la licence est décrit en tête de `scripts/scan-index.mjs`.

Fichiers : Pokémon dans les 15 langues TCGdex (français, anglais et japonais d'abord), One Piece (anglais, japonais,
français), Magic, Yu-Gi-Oh!, Lorcana, Riftbound, Dragon Ball, Digimon, Palworld, Cyberpunk (anglais).

Essai local, sans réseau : `SCAN_LIST_FILE=liste.json SCAN_OUT=/tmp/scan node scripts/scan-index.mjs`
(après `npm i --no-save sharp`), avec une liste `[{ "game", "lang", "entries": [{ "key", "img", "set"?, "rec"? }] }]`.

## Cartes ajoutées à la main

Pour les cartes qu'aucune source ne connaît (vieilles promos japonaises, Mew ancien en français, promos sans numéro…).
On les décrit dans **`curated/cards.json`** ; à chaque modification poussée sur `main`, le robot vérifie le fichier et
publie `cards/curated.json`, que l'app lit (une fois par jour au plus). Dans l'app, ces cartes apparaissent dans la
recherche, dans leur extension (Licences) et dans la fiche, avec la mention « Carte ajoutée à la main ». Le scan à
l'image les reconnaît à partir de la nuit suivante (index du scan), grâce à leur photo.

Une erreur de saisie (champ obligatoire manquant, langue ou finition inconnue, identifiant en double) bloque ce
fichier seulement : la version déjà publiée reste en place (le scan, lui, ignore ces cartes jusqu'à correction), le
reste du catalogue se met à jour, et l'erreur est affichée dans le résumé de la tâche (onglet Actions).

```json
{
  "photos": "Borypb/thothectio-photos",
  "sets": [
    { "id": "pkm-cur-jp-promos", "game": "pokemon", "name": "Promos japonaises anciennes", "series": "Promos", "releasedAt": "1997-01-01" }
  ],
  "cards": [
    { "id": "ja-pikachu-corocoro", "game": "pokemon", "lang": "ja", "set": "pkm-cur-jp-promos",
      "name": "ピカチュウ", "nameEn": "Pikachu", "finish": "holo", "tags": ["promo"], "label": "CoroCoro",
      "photo": "pokemon/ja/pikachu-corocoro.jpg" },
    { "id": "fr-mew-ancien", "game": "pokemon", "lang": "fr", "set": "pkm-basep", "setName": "Promos Wizards",
      "name": "Mew ancien", "nameEn": "Ancient Mew", "finish": "holo", "tags": ["promo"],
      "photo": "pokemon/fr/mew-ancien.jpg" }
  ]
}
```

**`sets`** : extensions créées pour ces cartes, quand aucune extension existante ne convient.

| Champ | | |
|---|---|---|
| `id` | obligatoire | unique ; commence par le préfixe de la licence (`pkm-` pour Pokémon), par exemple `pkm-cur-…` |
| `game` | obligatoire | `pokemon`, `onepiece`, `magic`, `yugioh`, `lorcana`, `digimon`, `dragonball`, `riftbound`, `palworld`, `cyberpunk` |
| `name` | obligatoire | nom affiché |
| `releasedAt`, `series`, `printedTotal` | facultatifs | date (AAAA-MM-JJ), série, nombre de cartes imprimé |

**`cards`** : une ligne par impression (une même carte en holo et en normale = deux lignes).

| Champ | | |
|---|---|---|
| `id` | obligatoire | unique, ne change plus ensuite (il sert d'identifiant à la carte dans les collections) |
| `game`, `lang` | obligatoires | licence ; langue de la carte : `fr`, `en`, `ja`, `de`, `es`, `it`, `pt`, `ko`, `zh` (traditionnel), `zh-cn`, `nl`, `pl`, `ru`, `th`, `id` |
| `set` | obligatoire | une extension de `sets`, ou une extension déjà connue de l'app (Pokémon : `pkm-` suivi de l'identifiant TCGdex, `pkm-basep` pour les promos Wizards) |
| `setName` | conseillé si `set` existe déjà | nom de l'extension, affiché tant que l'app ne l'a pas en mémoire |
| `name` | obligatoire | nom imprimé sur la carte |
| `nameEn` | conseillé | nom anglais (la recherche le trouve aussi) |
| `number` | si imprimé | numéro tel qu'imprimé ; sans numéro, laisser vide |
| `finish` | facultatif | `normal` (par défaut), `holo`, `reverse`, `metal` |
| `tags` | facultatif | `promo`, `stamped`, `first_edition`, `full_art`, `alt_art`, `special_alt`, `parallel`, `jumbo`, `master_ball`, `poke_ball`, `leader`, `manga`, `lucky` |
| `label` | facultatif | mention courte affichée sur la carte (« CoroCoro », « Tampon Ligue »…) |
| `rarity`, `releasedAt` | facultatifs | rareté, date de sortie (sinon celle de l'extension) |
| `photo` | conseillé | chemin dans le dépôt `photos`, ou adresse complète d'une image |
| `showPhoto` | facultatif | `false` : la photo sert au scan mais n'est pas affichée dans l'app |
| `source`, `note` | facultatifs | d'où vient l'information (lien, référence) ; non publiés |

**Photos** : dans un dépôt GitHub **public** à part (`photos`, par exemple `Borypb/thothectio-photos`), qu'on peut
fermer à tout moment sans toucher à ce dépôt. Pour que le scan reconnaisse la carte, la photo doit être :

- **recadrée au ras de la carte**, sans fond autour (le robot prévient dans l'onglet Actions quand le format s'éloigne
  de 63 × 88) ; le scanner de documents de l'iPhone (Notes ou Fichiers › Scanner des documents) recadre et redresse tout seul ;
- **de face**, à plat, **hors sleeve**, sans reflet sur l'illustration, lumière du jour ;
- au moins 600 pixels de haut, en JPEG, PNG ou WebP.

Pour remplacer une photo, lui donner **un nouveau nom** : le robot garde l'empreinte d'une adresse déjà traitée.

Le scan à l'image n'a d'index que pour Pokémon (15 langues), One Piece (anglais, japonais, français) et l'anglais des
autres licences : ailleurs, la carte est dans la recherche et le catalogue, pas dans le scan.

## index.json

```json
{
  "version": 1,
  "updatedAt": "2026-10-10",
  "kinds": { "etb": "Coffret Dresseur d'Élite", "booster_box": "Display" },
  "games": {
    "pokemon": {
      "files": {
        "fr": { "file": "pokemon-fr.json", "version": 3, "count": 412 },
        "en": { "file": "pokemon-en.json", "version": 7, "count": 2180 }
      }
    }
  }
}
```

L'app télécharge `index.json` (une fois par jour au plus), puis seulement les fichiers dont la `version` a changé.
Les versions sont gérées par `build.mjs` : pour corriger un produit, modifie `curated/` puis lance `node scripts/build.mjs`
(ou laisse l'Action de la nuit s'en charger).

## Format d'un produit

```json
{
  "id": "pkm-fr-sv03-etb",
  "kind": "etb",
  "name": "Coffret Dresseur d'Élite Flammes Obsidiennes",
  "lang": "fr",
  "setIds": ["pkm-sv03"],
  "releasedAt": "2023-08-11",
  "contents": [
    { "type": "booster", "setId": "pkm-sv03", "qty": 9 },
    { "type": "promo", "cardId": "pkm-svp:056:fr:holo" }
  ],
  "extras": ["65 protège-cartes", "45 cartes Énergie"],
  "editions": ["Koraidon", "Miraidon"],
  "image": "images/pkm-fr-sv03-etb.webp",
  "msrp": { "eur": 54.99 },
  "aliases": ["etb", "flammes obsidiennes"]
}
```

| Champ | Obligatoire | Rôle |
|---|---|---|
| `id` | oui | `<licence>-<langue>-<extension>-<type>`, unique et **jamais modifié** (les albums s'y réfèrent) |
| `kind` | oui | une clé de `kinds` dans `index.json` |
| `name` | oui | nom commercial dans la langue du produit |
| `lang` | oui | `fr`, `en`, `ja`… |
| `setIds` | non | extensions liées, mêmes identifiants que l'app (`pkm-sv03`, `op-op09`, `mtg-woe`…) |
| `releasedAt` | non | date de sortie `AAAA-MM-JJ` |
| `contents` | non | boosters (`setId`, `qty`) et cartes promo (`cardId` au format de l'app, ou `name` à défaut) |
| `extras` | non | accessoires, en texte libre |
| `editions` | non | versions visuelles d'un même produit (couvertures différentes, même contenu) |
| `image` | non | chemin dans ce dépôt ou URL |
| `msrp` | non | prix public conseillé |
| `aliases` | non | mots-clés pour la recherche |

## Couverture

- Pokémon : tout le catalogue scellé TCGplayer en anglais et en japonais ; en français, les équivalents déduits
  plus le catalogue vérifié (ETB et displays Écarlate et Violet / Méga-Évolution, Collection Ultra Premium 151).
- À venir : autres licences, autres langues européennes.

Non affilié à Nintendo, The Pokémon Company, Bandai, Wizards of the Coast, Konami, Ravensburger, Riot Games, Pocketpair.

5. **Cartes** (`cards.mjs`) : cartes des licences sans API publique — Dragon Ball Super Fusion World, Palworld, Digimon, Riftbound, Cyberpunk —
   depuis le catalogue TCGplayer (TCGCSV), avec images du CDN TCGplayer et cote du jour en $.
   `cards/index.json` liste les extensions ; une extension = un fichier `cards/<licence>/<groupId>.json`.
