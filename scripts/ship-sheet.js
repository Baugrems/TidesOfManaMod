import {
  MODULE_ID,
  getShipData,
  normalizeShipData,
  updateShip,
  withAllowedTargets,
  getAllowedTargets,
  getTargetPenalty,
  getEffectiveIntegrity,
  spendMana,
  applyDamage,
  patchShip,
  addLog,
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
      submitOnChange: false,
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
    ship.log = Array.isArray(ship.log) ? ship.log : [];

    const targetToken = game.user.targets?.first
      ? game.user.targets.first()
      : Array.from(game.user.targets ?? [])[0];
    const targetActor = targetToken?.actor ?? null;
    const targetShip = targetActor ? getShipData(targetActor) : null;
    data.target = targetActor
      ? {
          name: targetActor.name,
          hp: targetShip?.hp?.value ?? 0,
          hpMax: targetShip?.hp?.max ?? 0,
          integrity: targetShip ? getEffectiveIntegrity(targetShip) : 0
        }
      : null;

    const stationEntries = Object.entries(ship.stations ?? {});
    const stationActors = await Promise.all(
      stationEntries.map(async ([key, uuid]) => {
        if (!uuid) return [key, null];
        const doc = await fromUuid(uuid);
        return [key, doc];
      })
    );
    const stationNames = {};
    const stationPermissions = {};
    const stationManned = {};
    stationActors.forEach(([key, doc]) => {
      stationNames[key] = doc?.name ?? "";
      stationManned[key] = Boolean(doc);
      stationPermissions[key] = doc
        ? game.user.isGM ||
          doc.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
        : false;
    });
    data.stationNames = stationNames;
    data.stationPermissions = stationPermissions;
    data.stationManned = stationManned;
    data.statusBanner = {
      disabled: ship.hp.value <= 0,
      grappled: ship.grappled,
      movementLocked: ship.movementLocked
    };
    data.tabs = {
      status: ship.uiTab === "status",
      cannons: ship.uiTab === "cannons",
      stations: ship.uiTab === "stations",
      combat: ship.uiTab === "combat"
    };

    const pcOptions = [{ value: "", label: "-- Unassigned --" }];
    const actors = Array.from(game.actors ?? []);
    actors
      .filter((actor) => actor.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((actor) => {
        pcOptions.push({ value: actor.uuid, label: actor.name });
      });
    data.pcOptions = pcOptions;
    data.ship = ship;
    data.systemName = game.system.title;
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.on("click", ".action", this._onAction.bind(this));
    html.on("click", ".combat-join", this._onCombatJoin.bind(this));
    html.on("click", ".toggle-mode", this._onToggleMode.bind(this));
    html.on("click", ".sheet-tab", this._onTabChange.bind(this));
    html.on("click", ".preset-save", this._onPresetSave.bind(this));
    html.on("click", ".preset-load", this._onPresetLoad.bind(this));
    html.on("click", ".cannon-add", this._onCannonAdd.bind(this));
    html.on("click", ".cannon-delete", this._onCannonDelete.bind(this));
    html.on("click", ".cannon-fire", this._onCannonFire.bind(this));
    html.on("click", ".clear-effects", this._onClearEffects.bind(this));
    html.on("change", ".cannon-facing", this._onCannonFacingChange.bind(this));
    html.on("change", ".cannon-target", this._onCannonTargetChange.bind(this));
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
      case "round-start":
        return this._startRound();
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

  async _requireStation(stationKey, actionLabel) {
    if (game.user.isGM) return true;
    const ship = getShipData(this.actor);
    const uuid = ship.stations?.[stationKey];
    if (!uuid) {
      ui.notifications.warn(`${actionLabel} requires a crewed ${stationKey} station.`);
      return false;
    }
    const doc = await fromUuid(uuid);
    const hasControl = doc?.testUserPermission(
      game.user,
      CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
    );
    if (!hasControl) {
      ui.notifications.warn(`Only the assigned ${stationKey} can use ${actionLabel}.`);
      return false;
    }
    return true;
  }

  async _ensureCanManageShip(actionLabel) {
    if (game.user.isGM || this.actor.isOwner) return true;
    ui.notifications.warn(`${actionLabel} requires ship ownership or GM permissions.`);
    return false;
  }

  async _getActiveToken() {
    const tokens = this.actor.getActiveTokens(true);
    return tokens?.[0] ?? null;
  }

  async _onToggleMode(event) {
    event.preventDefault();
    const ship = getShipData(this.actor);
    await patchShip(this.actor, { editMode: !ship.editMode });
    this.render(false);
  }

  async _onTabChange(event) {
    event.preventDefault();
    const tab = event.currentTarget?.dataset?.tab;
    if (!tab) return;
    await patchShip(this.actor, { uiTab: tab });
    this.render(false);
  }

  async _ensureCombat() {
    if (game.combat) return game.combat;
    return Combat.create({ scene: canvas.scene?.id });
  }

  async _ensureCombatant() {
    const token = await this._getActiveToken();
    if (!token) {
      ui.notifications.warn("Place this ship's token on the scene to join combat.");
      return null;
    }
    const combat = await this._ensureCombat();
    const existing = combat.combatants?.find((c) => c.tokenId === token.id);
    if (existing) return existing;
    return combat.createEmbeddedDocuments("Combatant", [{ tokenId: token.id, actorId: this.actor.id }]);
  }

  async _onCombatJoin(event) {
    event.preventDefault();
    const ship = getShipData(this.actor);
    const { roll } = await rollD12Plus(ship.maneuver);
    const token = await this._getActiveToken();
    if (!token) return;
    const combat = await this._ensureCombat();
    const combatant = combat.combatants?.find((c) => c.tokenId === token.id);
    if (!combatant) {
      await combat.createEmbeddedDocuments("Combatant", [{ tokenId: token.id, actorId: this.actor.id, initiative: roll.total }]);
    } else {
      await combatant.update({ initiative: roll.total });
    }
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: `Naval Initiative (Maneuverability ${ship.maneuver >= 0 ? "+" : ""}${ship.maneuver})`
    });
    ui.notifications.info("Ship joined combat with naval initiative.");
  }

  async _rollInitiative() {
    if (!(await this._requireStation("captain", "Initiative"))) return;
    const ship = getShipData(this.actor);
    const { roll, natural } = await rollD12Plus(ship.maneuver);
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: `Initiative (Maneuverability ${ship.maneuver >= 0 ? "+" : ""}${
        ship.maneuver
      })`
    });
    const token = await this._getActiveToken();
    if (token && game.combat) {
      const combatant = game.combat.combatants?.find((c) => c.tokenId === token.id);
      if (combatant) await combatant.update({ initiative: roll.total });
    }
    if (natural === 1 || natural === 12) {
      await postChat(
        `<div class="tides-mana-chat"><strong>Natural ${natural}</strong> on initiative roll.</div>`,
        this.actor
      );
    }
    await addLog(this.actor, `Initiative rolled (${roll.total}).`);
  }

  async _rollEngineer() {
    if (!(await this._requireStation("engineer", "Engineer Recharge"))) return;
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
    await addLog(this.actor, `Engineer recharge set to +${bonus} next round.`);
  }

  async _beginRound() {
    if (!(await this._requireStation("captain", "Round Recharge"))) return;
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
    await addLog(this.actor, `Round refresh +${gained} mana.`);
  }

  async _startRound() {
    if (!(await this._requireStation("captain", "Start Round"))) return;
    const ship = getShipData(this.actor);
    ship.integrityMod = 0;
    ship.disabledSystems = {
      cannons: false,
      ramming: false,
      movement: false,
      engineer: false
    };
    ship.movementLocked = false;
    const gained = ship.passiveRecharge + ship.bonusMana;
    ship.mana.value = Math.min(ship.mana.value + gained, ship.mana.max);
    ship.bonusMana = 0;
    await updateShip(this.actor, ship);
    await postChat(
      `<div class="tides-mana-chat"><strong>New Round</strong>: temp effects cleared, +${gained} mana.</div>`,
      this.actor
    );
    await addLog(this.actor, `New round: cleared temp effects, +${gained} mana.`);
  }

  async _activateShield() {
    if (!(await this._requireStation("captain", "Integrity Shield"))) return;
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
    await addLog(this.actor, "Integrity Shield engaged (-2 mana).");
  }

  async _spendMovement(button) {
    if (!(await this._requireStation("helm", "Movement"))) return;
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
    await addLog(this.actor, `Movement ${squares} squares (-${squares} mana).`);
  }

  async _rammingAttack() {
    if (!(await this._requireStation("captain", "Ramming"))) return;
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
      await addLog(this.actor, "Ramming critical failure.");
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
      await addLog(this.actor, `Ramming failed (${selfDamage} self-damage).`);
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
    await addLog(this.actor, `Ramming hit (${targetDamage} to target, ${attackerDamage} to self).`);
  }

  async _onCannonAdd(event) {
    event.preventDefault();
    if (!(await this._ensureCanManageShip("Add Cannon"))) return;
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
    if (!(await this._ensureCanManageShip("Delete Cannon"))) return;
    const li = event.currentTarget.closest(".cannon");
    const cannonId = li?.dataset?.cannonId;
    if (!cannonId) return;
    const ship = getShipData(this.actor);
    ship.cannons = ship.cannons.filter((cannon) => cannon.id !== cannonId);
    await updateShip(this.actor, ship);
  }

  async _onCannonFire(event) {
    event.preventDefault();
    if (!(await this._requireStation("gunnery", "Cannon Fire"))) return;
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

    const targetSelect = li.querySelector("select.cannon-target");
    const facingSelect = li.querySelector("select.cannon-facing");
    const countInput = li.querySelector("input.cannon-count");
    const damageInput = li.querySelector("input.cannon-damage");

    const facing = ship.editMode
      ? facingSelect?.value ?? cannon.facing ?? "front"
      : cannon.facing ?? "front";
    const targetDirection = targetSelect?.value ?? cannon.targetDirection ?? facing;
    const count = ship.editMode
      ? Number(countInput?.value ?? cannon.count ?? 1)
      : Number(cannon.count ?? 1);
    const damageFormula = ship.editMode ? damageInput?.value ?? cannon.damage ?? "" : cannon.damage ?? "";

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
      await addLog(this.actor, "Cannon critical failure.");
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
      await addLog(this.actor, "Cannon attack missed.");
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
    await addLog(this.actor, `Cannon hit for ${damage} damage.`);
  }

  async _onClearEffects(event) {
    event.preventDefault();
    if (!(await this._requireStation("captain", "Clear Temp Effects"))) return;
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
    await addLog(this.actor, "Temporary effects cleared.");
  }

  async _onPresetSave(event) {
    event.preventDefault();
    if (!(await this._ensureCanManageShip("Save Preset"))) return;
    const formData = this.form ? new FormData(this.form) : null;
    const expanded = formData ? foundry.utils.expandObject(Object.fromEntries(formData)) : {};
    const incoming = foundry.utils.getProperty(expanded, `flags.${MODULE_ID}`) ?? {};
    const ship = foundry.utils.mergeObject(getShipData(this.actor), incoming, {
      inplace: false,
      overwrite: true
    });
    normalizeShipData(ship);
    const name = await Dialog.prompt({
      title: "Save Cannon Preset",
      content: "<p>Preset name:</p><input type=\"text\" name=\"presetName\" />",
      label: "Save",
      callback: (html) => html.find("input[name='presetName']").val()?.trim()
    });
    if (!name) return;
    const presets = (game.settings.get(MODULE_ID, "cannonPresets") ?? []).filter(
      (preset) => preset.name !== name
    );
    presets.push({ name, cannons: ship.cannons });
    await game.settings.set(MODULE_ID, "cannonPresets", presets);
    ui.notifications.info(`Saved cannon preset: ${name}`);
  }

  async _onPresetLoad(event) {
    event.preventDefault();
    if (!(await this._ensureCanManageShip("Load Preset"))) return;
    const presets = game.settings.get(MODULE_ID, "cannonPresets") ?? [];
    if (!presets.length) {
      ui.notifications.warn("No cannon presets saved yet.");
      return;
    }
    const options = presets
      .map((preset) => `<option value="${preset.name}">${preset.name}</option>`)
      .join("");
    const selected = await Dialog.prompt({
      title: "Load Cannon Preset",
      content: `<p>Select a preset:</p><select name="preset">${options}</select>`,
      label: "Load",
      callback: (html) => html.find("select[name='preset']").val()
    });
    if (!selected) return;
    const preset = presets.find((entry) => entry.name === selected);
    if (!preset) return;
    const ship = getShipData(this.actor);
    ship.cannons = preset.cannons;
    await updateShip(this.actor, ship);
    ui.notifications.info(`Loaded cannon preset: ${preset.name}`);
  }

  async _onCannonFacingChange(event) {
    const select = event.currentTarget;
    const li = select.closest(".cannon");
    const cannonId = li?.dataset?.cannonId;
    if (!cannonId) return;
    const facing = select.value;
    const targetSelect = li.querySelector("select.cannon-target");
    if (targetSelect) {
      const allowed = getAllowedTargets(facing);
      const options = allowed
        .map((direction) => {
          const label = `${directionLabel(direction)}${direction === facing ? "" : " (-1)"}`;
          return `<option value="${direction}">${label}</option>`;
        })
        .join("");
      targetSelect.innerHTML = options;
      targetSelect.value = allowed.includes(targetSelect.value) ? targetSelect.value : facing;
    }

    const ship = getShipData(this.actor);
    const cannon = ship.cannons.find((entry) => entry.id === cannonId);
    if (cannon) {
      cannon.facing = facing;
      if (!getAllowedTargets(facing).includes(cannon.targetDirection)) cannon.targetDirection = facing;
      await updateShip(this.actor, ship);
    }
  }

  async _onCannonTargetChange(event) {
    const select = event.currentTarget;
    const li = select.closest(".cannon");
    const cannonId = li?.dataset?.cannonId;
    if (!cannonId) return;
    const ship = getShipData(this.actor);
    const cannon = ship.cannons.find((entry) => entry.id === cannonId);
    if (!cannon) return;
    cannon.targetDirection = select.value;
    await updateShip(this.actor, ship);
  }
}
