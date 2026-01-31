# Tides of Mana: Naval Combat

System-agnostic Foundry VTT module for high-seas ship combat using the provided Naval Combat rules.

## What it adds
- A **Naval Ship** actor sheet you can apply to any actor type in your system.
- Ship stats and derived resources (HP, Mana, Passive Recharge).
- Buttons for initiative, engineer recharge, round recharge, integrity shield, ramming, and movement spending.
- Cannon batteries with facing, target direction, mana cost, and optional damage formulas.
- Chat output for key actions, criticals, and ramming outcomes.

## Quick start
1. Enable the module in your world.
2. Create (or pick) an Actor and open **Sheet Configuration**.
3. Choose **Naval Ship** as the sheet.
4. Fill in Power / Integrity / Maneuverability, then configure cannons.
5. Use the action buttons during combat.

## Cannon damage
The rules document does not specify cannon damage, so each cannon has a **Damage formula** field.
- Example: `2d6` or `1d10+2`.
- If left blank, the module will still roll to hit and prompt you to apply damage manually.

## Targeting
- Select a target token before firing or ramming to resolve hit vs. Integrity.
- Cannons can fire in their facing direction or adjacent directions at a -1 penalty.
- Cannons cannot fire in the opposite direction.

## Notes
- Critical hit (natural 12) applies max damage and reduces target Integrity by 1 (min 1).
- Critical failure (natural 1) marks the system as unavailable next round.
- Use **Clear Temp Effects** to reset temporary flags between rounds if needed.
