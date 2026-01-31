import {
  MODULE_ID,
  getShipData,
  normalizeShipData,
  updateShip,
  withAllowedTargets,
  getTargetPenalty,
  getEffectiveIntegrity,
  spendMana,
  applyDamage,
  patchShip,
  postChat,
  rollD12Plus,
  rollFormula,
  directionLabel
} from "./helpers.js";

export class NavalShipSheet extends ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["tides-mana", "sheet", "actor"],
      width: 720,
      height: 820,
      submitOnChange: true,
      submitOnClose: true
    });
  }

  get template() {
    return `modules/${MODULE_ID}/templates/ship-sheet.hbs`;
  }

  async getData(options) {
    const data = await super.getData(options);
    const ship = getShipData(this.actor);
    ship.cannons = ship.cannons.map((cannon) => withAllowedTargets(cannon));
    ship.effectiveIntegrity = getEffectiveIntegrity(ship);
    ship.boardingReady = ship.hp.value <= 0 || ship.grappled;
    data.ship = ship;
    data.systemName = game.system.title;
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.on("click", ".action", this._onAction.bind(this));
    html.on("click", ".cannon-add", this._onCannonAdd.bind(this));
    html.on("click", ".cannon-delete", this._onCannonDelete.bind(this));
    html.on("click", ".cannon-fire", this._onCannonFire.bind(this));
    html.on("click", ".clear-effects", this._onClearEffects.bind(this));
  }

  async _updateObject(event, formData) {
    const expanded = foundry.utils.expandObject(formData);
    const incoming = foundry.utils.getProperty(expanded, `flags.${MODULE_ID}`) ?? {};
    const current = getShipData(this.actor);
    const ship = foundry.utils.mergeObject(current, incoming, {
      inplace: false,
      overwrite: true
    });

    normalizeShipData(ship);
    foundry.utils.setProperty(expanded, `flags.${MODULE_ID}`, ship);

    return super._updateObject(event, expanded);
  }

  async _onAction(event) {
    event.preventDefault();
    const action = event.currentTarget?.dataset?.action;
    if (!action) return;

    switch (action) {
      case "initiative":
        return this._rollInitiative();
      case "engineer":
        return this._rollEngineer();
      case "begin-round":
        return this._beginRound();
      case "shield":
        return this._activateShield();
      case "movement":
        return this._spendMovement(event.currentTarget);
      case "ramming":
        return this._rammingAttack();
      default:
        return null;
    }
  }

  async _rollInitiative() {
    const ship = getShipData(this.actor);
    const { roll, natural } = await rollD12Plus(ship.maneuver);
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: `Initiative (Maneuverability ${ship.maneuver >= 0 ? "+" : ""}${
        ship.maneuver
      })`
    });
    if (natural === 1 || natural === 12) {
      await postChat(
        `<div class="tides-mana-chat"><strong>Natural ${natural}</strong> on initiative roll.</div>`,
        this.actor
      );
    }
  }

  async _rollEngineer() {
    const ship = getShipData(this.actor);
    if (ship.disabledSystems.engineer) {
      ui.notifications.warn("Engineer system is unavailable next round.");
      return;
    }

    const roll = new Roll("1d12");
    await roll.evaluate({ async: true });
    const natural = roll.dice?.[0]?.results?.[0]?.result ?? roll.total;

    let bonus = 0;
    if (natural >= 5 && natural <= 8) bonus = 2;
    if (natural >= 9 && natural <= 11) bonus = 4;
    if (natural === 12) bonus = 6;

    ship.bonusMana = bonus;
    await updateShip(this.actor, ship);

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: "Engineer Recharge"
    });

    const message = bonus
      ? `Engineer will add <strong>+${bonus}</strong> mana next round.`
      : "No bonus mana next round.";

    await postChat(`<div class="tides-mana-chat">${message}</div>`, this.actor);
  }

  async _beginRound() {
    const ship = getShipData(this.actor);
    const gained = ship.passiveRecharge + ship.bonusMana;
    ship.mana.value = Math.min(ship.mana.value + gained, ship.mana.max);
    ship.bonusMana = 0;
    ship.movementLocked = false;

    await updateShip(this.actor, ship);

    await postChat(
      `<div class="tides-mana-chat"><strong>Round Refresh</strong>: +${gained} mana (passive ${ship.passiveRecharge}).</div>`,
      this.actor
    );
  }

  async _activateShield() {
    const ship = getShipData(this.actor);
    if (ship.mana.value < 2) {
      ui.notifications.warn("Not enough mana to raise the Integrity Shield.");
      return;
    }
    await spendMana(this.actor, 2);
    await postChat(
      "<div class=\"tides-mana-chat\"><strong>Integrity Shield</strong> engaged: block a confirmed incoming hit.</div>",
      this.actor
    );
  }

  async _spendMovement(button) {
    const ship = getShipData(this.actor);
    if (ship.disabledSystems.movement) {
      ui.notifications.warn("Movement system is unavailable next round.");
      return;
    }
    if (ship.movementLocked) {
      ui.notifications.warn("Movement is locked for the remainder of the round.");
      return;
    }

    const wrapper = button.closest(".movement-controls");
    const input = wrapper?.querySelector("input.movement-squares");
    const squares = Number(input?.value ?? 0);
    if (!squares || squares <= 0) {
      ui.notifications.warn("Enter squares moved to spend movement mana.");
      return;
    }

    if (ship.mana.value < squares) {
      ui.notifications.warn("Not enough mana to cover movement.");
      return;
    }

    await spendMana(this.actor, squares);
    await postChat(
      `<div class=\"tides-mana-chat\"><strong>Movement</strong>: spent ${squares} mana for ${squares} squares.</div>`,
      this.actor
    );
  }

  async _rammingAttack() {
    const ship = getShipData(this.actor);
    if (ship.disabledSystems.ramming) {
      ui.notifications.warn("Ramming system is unavailable next round.");
      return;
    }
    if (ship.mana.value < 2) {
      ui.notifications.warn("Not enough mana to ram (requires 2 mana).");
      return;
    }

    const targetToken = game.user.targets?.first
      ? game.user.targets.first()
      : Array.from(game.user.targets ?? [])[0];
    if (!targetToken?.actor) {
      ui.notifications.warn("Select a target ship to ram.");
      return;
    }

    const targetActor = targetToken.actor;
    const targetShip = getShipData(targetActor);

    await spendMana(this.actor, 2);

    const { roll, natural } = await rollD12Plus(ship.maneuver);
    const defense = getEffectiveIntegrity(targetShip) + 8;
    const hit = roll.total >= defense;

    const flavor = `Ramming Check vs Integrity ${getEffectiveIntegrity(
      targetShip
    )} + 8 (Target ${targetActor.name})`;

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor
    });

    if (natural === 1) {
      await patchShip(this.actor, { disabledSystems: { ramming: true } });
      await postChat(
        "<div class=\"tides-mana-chat\"><strong>Critical Failure</strong>: Ramming system unavailable next round.</div>",
        this.actor
      );
    }

    if (!hit) {
      const selfDamageRoll = await rollFormula("1d6");
      const selfDamage = selfDamageRoll?.total ?? 0;
      await applyDamage(this.actor, selfDamage);
      await patchShip(this.actor, { integrityMod: -2, movementLocked: true });

      await postChat(
        `<div class=\"tides-mana-chat\"><strong>Ramming Failed</strong>: took ${selfDamage} damage, movement locked, Integrity -2 next round.</div>`,
        this.actor
      );
      const selfAfter = getShipData(this.actor);
      if (selfAfter.hp.value <= 0) {
        await postChat(
          `<div class=\"tides-mana-chat\"><strong>${this.actor.name}</strong> is disabled and sinking.</div>`,
          this.actor
        );
      }
      if (selfDamageRoll) {
        await selfDamageRoll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: this.actor }),
          flavor: "Ramming Backlash"
        });
      }
      return;
    }

    const critical = natural === 12;
    const targetDamageRoll = await rollFormula("2d6", critical);
    const attackerDamageRoll = await rollFormula("1d6", false);
    const targetDamage = targetDamageRoll?.total ?? 0;
    const attackerDamage = attackerDamageRoll?.total ?? 0;

    await applyDamage(targetActor, targetDamage);
    await applyDamage(this.actor, attackerDamage);

    const selfAfter = getShipData(this.actor);
    if (selfAfter.hp.value <= 0) {
      await postChat(
        `<div class=\"tides-mana-chat\"><strong>${this.actor.name}</strong> is disabled and sinking.</div>`,
        this.actor
      );
    }

    if (critical) {
      targetShip.integrity = Math.max(1, targetShip.integrity - 1);
      await patchShip(targetActor, { integrity: targetShip.integrity });
      await postChat(
        `<div class=\"tides-mana-chat\"><strong>Critical Hit</strong>: max ramming damage, target Integrity -1 (now ${targetShip.integrity}).</div>`,
        this.actor
      );
    }

    if (targetDamageRoll) {
      await targetDamageRoll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: "Ramming Damage"
      });
    }
    if (attackerDamageRoll) {
      await attackerDamageRoll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: "Ramming Recoil"
      });
    }

    const targetAfter = getShipData(targetActor);
    if (targetAfter.hp.value <= 0) {
      await postChat(
        `<div class=\\\"tides-mana-chat\\\"><strong>${targetActor.name}</strong> is disabled and sinking.</div>`,
        this.actor
      );
    }
    if (targetAfter.hp.value > 0 && targetAfter.hp.value <= targetAfter.hp.max / 2) {
      await patchShip(targetActor, { grappled: true, grappledBy: this.actor.id });
      await postChat(
        `<div class=\"tides-mana-chat\"><strong>Grappled!</strong> ${targetActor.name} is grappled (below 50% HP).</div>`,
        this.actor
      );
    }
  }

  async _onCannonAdd(event) {
    event.preventDefault();
    const ship = getShipData(this.actor);
    ship.cannons.push({
      id: foundry.utils.randomID(),
      name: `Cannon ${ship.cannons.length + 1}`,
      facing: "front",
      targetDirection: "front",
      count: 1,
      damage: ""
    });
    await updateShip(this.actor, ship);
  }

  async _onCannonDelete(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".cannon");
    const cannonId = li?.dataset?.cannonId;
    if (!cannonId) return;
    const ship = getShipData(this.actor);
    ship.cannons = ship.cannons.filter((cannon) => cannon.id !== cannonId);
    await updateShip(this.actor, ship);
  }

  async _onCannonFire(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".cannon");
    const cannonId = li?.dataset?.cannonId;
    if (!cannonId) return;

    const ship = getShipData(this.actor);
    if (ship.disabledSystems.cannons) {
      ui.notifications.warn("Cannons are unavailable next round.");
      return;
    }

    const cannon = ship.cannons.find((entry) => entry.id === cannonId);
    if (!cannon) return;

    const countInput = li.querySelector("input.cannon-count");
    const damageInput = li.querySelector("input.cannon-damage");
    const facingSelect = li.querySelector("select.cannon-facing");
    const targetSelect = li.querySelector("select.cannon-target");

    const count = Number(countInput?.value ?? cannon.count ?? 1);
    const damageFormula = damageInput?.value ?? cannon.damage ?? "";
    const facing = facingSelect?.value ?? cannon.facing ?? "front";
    const targetDirection = targetSelect?.value ?? cannon.targetDirection ?? facing;

    const penalty = getTargetPenalty(facing, targetDirection);
    if (penalty === null) {
      ui.notifications.warn("Cannons cannot fire in the opposite direction.");
      return;
    }

    const manaCost = count;
    if (ship.mana.value < manaCost) {
      ui.notifications.warn("Not enough mana to fire that many cannons.");
      return;
    }

    await spendMana(this.actor, manaCost);

    const targetToken = game.user.targets?.first
      ? game.user.targets.first()
      : Array.from(game.user.targets ?? [])[0];
    const targetActor = targetToken?.actor ?? null;
    const targetShip = targetActor ? getShipData(targetActor) : null;

    const { roll, natural } = await rollD12Plus(ship.maneuver + penalty);

    const defense = targetShip ? getEffectiveIntegrity(targetShip) + 6 : null;
    const hit = defense ? roll.total >= defense : null;

    const flavorParts = [
      `Cannon Fire (${directionLabel(facing)} → ${directionLabel(targetDirection)})`,
      penalty ? "-1 adjacent" : "",
      targetActor ? `vs ${targetActor.name} Integrity ${getEffectiveIntegrity(targetShip)} + 6` : ""
    ].filter(Boolean);

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: flavorParts.join(" ")
    });

    if (natural === 1) {
      await patchShip(this.actor, { disabledSystems: { cannons: true } });
      await postChat(
        "<div class=\"tides-mana-chat\"><strong>Critical Failure</strong>: Cannons unavailable next round.</div>",
        this.actor
      );
    }

    if (!targetActor) {
      await postChat(
        "<div class=\"tides-mana-chat\">No target selected: rolled attack only.</div>",
        this.actor
      );
      return;
    }

    if (!hit) {
      await postChat(
        `<div class=\"tides-mana-chat\"><strong>Miss</strong>: ${targetActor.name} holds (defense ${defense}).</div>`,
        this.actor
      );
      return;
    }

    const critical = natural === 12;
    const damageRoll = await rollFormula(damageFormula, critical);
    const damage = damageRoll?.total ?? 0;

    if (critical) {
      targetShip.integrity = Math.max(1, targetShip.integrity - 1);
      await patchShip(targetActor, { integrity: targetShip.integrity });
      await postChat(
        `<div class=\"tides-mana-chat\"><strong>Critical Hit</strong>: max damage, target Integrity -1 (now ${targetShip.integrity}).</div>`,
        this.actor
      );
    }

    if (damageRoll) {
      await damageRoll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: `Cannon Damage (${damageFormula || "manual"})`
      });
    } else {
      await postChat(
        "<div class=\"tides-mana-chat\">No damage formula set; apply damage manually.</div>",
        this.actor
      );
    }

    if (damage > 0) {
      await applyDamage(targetActor, damage);
      const updatedTarget = getShipData(targetActor);
      if (updatedTarget.hp.value <= 0) {
        await postChat(
          `<div class=\"tides-mana-chat\"><strong>${targetActor.name}</strong> is disabled and sinking.</div>`,
          this.actor
        );
      }
    }
  }

  async _onClearEffects(event) {
    event.preventDefault();
    const ship = getShipData(this.actor);
    ship.integrityMod = 0;
    ship.disabledSystems = {
      cannons: false,
      ramming: false,
      movement: false,
      engineer: false
    };
    ship.movementLocked = false;
    await updateShip(this.actor, ship);
    await postChat(
      "<div class=\"tides-mana-chat\"><strong>Temporary effects cleared.</strong></div>",
      this.actor
    );
  }
}
