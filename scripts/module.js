import { NavalShipSheet } from "./ship-sheet.js";
import { MODULE_ID, getShipData, getEffectiveIntegrity } from "./helpers.js";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Tides of Mana: Naval Combat`);

  game.settings.register(MODULE_ID, "cannonPresets", {
    name: "Cannon Presets",
    scope: "world",
    config: false,
    type: Object,
    default: []
  });

  const actorTypes = game.system?.documentTypes?.Actor ?? [];
  const fallbackTypes = Object.keys(CONFIG.Actor?.typeLabels ?? {});
  const isDnd5e = game.system?.id === "dnd5e";
  const dnd5eTypes = ["character", "npc", "vehicle", "group"];
  const types = isDnd5e
    ? dnd5eTypes
    : actorTypes.length
      ? actorTypes
      : fallbackTypes.length
        ? fallbackTypes
        : ["character"];

  Actors.registerSheet(MODULE_ID, NavalShipSheet, {
    types,
    makeDefault: false,
    label: "Naval Ship"
  });
});

Hooks.on("hoverToken", (token, hovered) => {
  if (!canvas?.ready) return;
  const tooltipId = `${MODULE_ID}-token-tooltip`;
  let tooltip = document.getElementById(tooltipId);
  if (!hovered) {
    if (tooltip) tooltip.remove();
    return;
  }

  const actor = token?.actor;
  if (!actor) return;
  if (!game.user.isGM && !actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)) {
    return;
  }

  const ship = getShipData(actor);
  const integrity = getEffectiveIntegrity(ship);

  tooltip = document.createElement("div");
  tooltip.id = tooltipId;
  tooltip.className = "tides-mana-tooltip";
  tooltip.innerHTML = `
    <div class="tooltip-name">${actor.name}</div>
    <div>HP: ${ship.hp.value} / ${ship.hp.max}</div>
    <div>Integrity: ${integrity}</div>
  `;

  document.body.appendChild(tooltip);

  const rect = canvas.app.view.getBoundingClientRect();
  const worldPoint = new PIXI.Point(token.center.x, token.center.y);
  const screenPoint = canvas.stage.worldTransform.apply(worldPoint);
  const left = rect.left + screenPoint.x + 24;
  const top = rect.top + screenPoint.y - 20;
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
});
