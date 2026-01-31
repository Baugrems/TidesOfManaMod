import { NavalShipSheet } from "./ship-sheet.js";
import { MODULE_ID } from "./helpers.js";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Tides of Mana: Naval Combat`);

  const actorTypes = game.system?.documentTypes?.Actor ?? [];
  const fallbackTypes = Object.keys(CONFIG.Actor?.typeLabels ?? {});
  const types = actorTypes.length ? actorTypes : fallbackTypes.length ? fallbackTypes : ["character"];

  Actors.registerSheet(MODULE_ID, NavalShipSheet, {
    types,
    makeDefault: false,
    label: "Naval Ship"
  });
});
