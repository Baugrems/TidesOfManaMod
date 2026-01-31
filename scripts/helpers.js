export const MODULE_ID = "tides-mana";

const DIRECTION_LABELS = {
  front: "Front",
  right: "Right",
  rear: "Rear",
  left: "Left"
};

const FACING_OPTIONS = Object.keys(DIRECTION_LABELS);

const ADJACENT_DIRECTIONS = {
  front: ["left", "right"],
  right: ["front", "rear"],
  rear: ["right", "left"],
  left: ["front", "rear"]
};

export function clampNumber(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function createDefaultShip() {
  const power = 6;
  const hpMax = 15 + power * 2;
  return {
    power,
    integrity: 6,
    maneuver: 6,
    hp: {
      value: hpMax,
      max: hpMax
    },
    mana: {
      value: power,
      max: power
    },
    bonusMana: 0,
    passiveRecharge: Math.min(Math.floor(power / 3), 4),
    integrityMod: 0,
    disabledSystems: {
      cannons: false,
      ramming: false,
      movement: false,
      engineer: false
    },
    movementLocked: false,
    grappled: false,
    grappledBy: "",
    cannons: [
      {
        id: foundry.utils.randomID(),
        name: "Port Battery",
        facing: "left",
        targetDirection: "left",
        count: 2,
        damage: ""
      }
    ]
  };
}

export function getShipData(actor) {
  const stored = foundry.utils.getProperty(actor, `flags.${MODULE_ID}`) ?? {};
  const ship = foundry.utils.mergeObject(createDefaultShip(), stored, {
    inplace: false,
    overwrite: true
  });
  if (Array.isArray(stored.cannons)) ship.cannons = stored.cannons;
  normalizeShipData(ship);
  return ship;
}

export function normalizeShipData(ship) {
  ship.power = clampNumber(Number(ship.power ?? 6), 1, 12);
  ship.integrity = clampNumber(Number(ship.integrity ?? 6), 1, 12);
  ship.maneuver = clampNumber(Number(ship.maneuver ?? 6), 1, 12);

  ship.hp = ship.hp ?? {};
  ship.mana = ship.mana ?? {};

  ship.bonusMana = Number(ship.bonusMana ?? 0) || 0;
  ship.integrityMod = Number(ship.integrityMod ?? 0) || 0;

  ship.disabledSystems = ship.disabledSystems ?? {};
  ship.disabledSystems.cannons = Boolean(ship.disabledSystems.cannons);
  ship.disabledSystems.ramming = Boolean(ship.disabledSystems.ramming);
  ship.disabledSystems.movement = Boolean(ship.disabledSystems.movement);
  ship.disabledSystems.engineer = Boolean(ship.disabledSystems.engineer);

  ship.movementLocked = Boolean(ship.movementLocked);
  ship.grappled = Boolean(ship.grappled);
  ship.grappledBy = ship.grappledBy ?? "";

  ship.cannons = Array.isArray(ship.cannons) ? ship.cannons : [];
  ship.cannons = ship.cannons.map((cannon) => {
    const facing = FACING_OPTIONS.includes(cannon.facing) ? cannon.facing : "front";
    const normalized = {
      id: cannon.id || foundry.utils.randomID(),
      name: cannon.name || "Cannon",
      facing,
      targetDirection: cannon.targetDirection || facing,
      count: clampNumber(Number(cannon.count ?? 1), 1, 12),
      damage: cannon.damage ?? ""
    };
    return normalized;
  });

  applyDerivedStats(ship);
  return ship;
}

export function applyDerivedStats(ship) {
  const hpMax = 15 + ship.power * 2;
  ship.hp.max = hpMax;
  ship.hp.value = clampNumber(Number(ship.hp.value ?? hpMax), 0, hpMax);

  ship.mana.max = ship.power;
  ship.mana.value = clampNumber(Number(ship.mana.value ?? ship.power), 0, ship.power);

  ship.passiveRecharge = Math.min(Math.floor(ship.power / 3), 4);
  ship.bonusMana = clampNumber(Number(ship.bonusMana ?? 0), 0, 12);
}

export function getAllowedTargets(facing) {
  const adjacent = ADJACENT_DIRECTIONS[facing] ?? [];
  return [facing, ...adjacent];
}

export function getTargetPenalty(facing, targetDirection) {
  if (!facing || !targetDirection) return 0;
  if (facing === targetDirection) return 0;
  const allowed = getAllowedTargets(facing);
  if (!allowed.includes(targetDirection)) return null;
  return -1;
}

export function withAllowedTargets(cannon) {
  const allowed = getAllowedTargets(cannon.facing);
  const targetDirection = allowed.includes(cannon.targetDirection)
    ? cannon.targetDirection
    : cannon.facing;

  const allowedTargets = allowed.map((direction) => ({
    value: direction,
    label: `${DIRECTION_LABELS[direction] ?? direction}${
      direction === cannon.facing ? "" : " (-1)"
    }`
  }));

  return {
    ...cannon,
    targetDirection,
    allowedTargets
  };
}

export function directionLabel(direction) {
  return DIRECTION_LABELS[direction] ?? direction;
}

export async function updateShip(actor, ship) {
  normalizeShipData(ship);
  return actor.update({
    [`flags.${MODULE_ID}`]: ship
  });
}

export async function patchShip(actor, partial) {
  const ship = getShipData(actor);
  const merged = foundry.utils.mergeObject(ship, partial, {
    inplace: false,
    overwrite: true
  });
  normalizeShipData(merged);
  return actor.update({
    [`flags.${MODULE_ID}`]: merged
  });
}

export function getEffectiveIntegrity(ship) {
  const value = Number(ship.integrity ?? 1) + Number(ship.integrityMod ?? 0);
  return Math.max(1, value);
}

export async function spendMana(actor, amount) {
  const ship = getShipData(actor);
  ship.mana.value = clampNumber(ship.mana.value - amount, 0, ship.mana.max);
  await updateShip(actor, ship);
  return ship;
}

export async function applyDamage(actor, amount) {
  const ship = getShipData(actor);
  ship.hp.value = clampNumber(ship.hp.value - amount, 0, ship.hp.max);
  await updateShip(actor, ship);
  return ship;
}

export function shipStatusLines(ship) {
  const lines = [];
  if (ship.hp.value <= 0) lines.push("Ship disabled and sinking.");
  if (ship.grappled) lines.push("Ship grappled; boarding possible.");
  return lines;
}

export async function postChat(content, speakerActor) {
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: speakerActor }),
    content
  });
}

export async function rollD12Plus(modifier = 0) {
  const roll = new Roll(`1d12 + ${modifier}`);
  await roll.evaluate({ async: true });
  const die = roll.dice?.[0];
  const natural = die?.results?.[0]?.result ?? die?.total ?? roll.total;
  return { roll, natural };
}

export async function rollFormula(formula, maximize = false) {
  if (!formula) return null;
  const roll = new Roll(formula);
  if (maximize) roll.options.maximize = true;
  await roll.evaluate({ async: true });
  return roll;
}
