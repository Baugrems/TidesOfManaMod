import { NavalShipSheet } from "./ship-sheet.js";
import { MODULE_ID } from "./helpers.js";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Tides of Mana: Naval Combat`);

  const actorTypes = game.system?.documentTypes?.Actor ?? [];
  if (actorTypes.length) {
    Actors.registerSheet(MODULE_ID, NavalShipSheet, {
      types: actorTypes,
      makeDefault: false,
      label: "Naval Ship"
    });
  }
});
