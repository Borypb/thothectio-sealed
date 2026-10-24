// Chaîne complète : récolte → déclinaison des langues → assemblage.
import { harvest, SOURCES } from "./harvest.mjs";
import { harvestJpOfficial } from "./harvest-jp.mjs";
import { localize, TEMPLATES } from "./localize.mjs";
import { build } from "./build.mjs";
import { prices } from "./prices.mjs";
import { fx } from "./fx.mjs";
import { cards } from "./cards.mjs";
import { pokemonVariants } from "./pokemon-variants.mjs";
import { pokemonNames } from "./pokemon-names.mjs";
import { curatedCards } from "./curated-cards.mjs";

// cartes ajoutées à la main (curated/cards.json) : en premier, une erreur de saisie n'empêche pas le reste
try {
  await curatedCards();
} catch (e) {
  console.log(`::error title=Cartes ajoutées à la main::${e.message}`);
}

for (const [game, sources] of Object.entries(SOURCES)) {
  for (const src of sources) await harvest(game, src);
  if (game === "pokemon") {
    try {
      await harvestJpOfficial();
    } catch (e) {
      // on garde la récolte précédente si le site officiel ne répond pas
      console.warn("Catalogue officiel japonais indisponible :", e.message);
    }
  }
  for (const lang of Object.keys(TEMPLATES)) await localize(game, lang);
}
await build();
// cotes du jour (fichier séparé : le catalogue ne change pas de version chaque jour)
await prices("pokemon", "pkm");
// taux de change BCE (secours de l'app pour convertir les prix)
try {
  await fx();
} catch (e) {
  console.warn("Taux BCE indisponibles :", e.message);
}
// cartes des licences sans API publique (Dragon Ball Fusion World, Palworld, Digimon)
try {
  await cards();
} catch (e) {
  console.warn("Cartes TCGplayer indisponibles :", e.message);
}
// versions qui existent vraiment pour chaque carte Pokémon (TCGdex ne connaît parfois que la normale)
try {
  await pokemonVariants();
} catch (e) {
  console.warn("Versions Pokémon indisponibles :", e.message);
}
// noms des Pokémon dans toutes les langues (recherche d'une langue à l'autre)
try {
  await pokemonNames();
} catch (e) {
  console.warn("Noms des Pokémon indisponibles :", e.message);
}
