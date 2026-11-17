import { isGunWeapon, isWarriorClass, weaponDamageParts } from "./weapon-damage.mjs";
import { damageApplicationButton } from "../combat/damage-application.mjs";
import { automaticFailureButton, criticalFailureHTML, isPowerTableCritical, isCriticalFailure, naturalDiceTotal } from "./critical-failure.mjs";
import { resolveClassAssignment } from "./skill-resolution.mjs";
import { signedValue } from "./roll-modifiers.mjs";
import { sw25EffectModifier } from "../effects/effective-values.mjs";

export function resolveAttackingClass(actor, weapon, requestedClassId = "") {
  if (isGunWeapon(weapon)) {
    return actor.items.find(item =>
      item.type === "class" && /^(artificer|マギテック)$/i.test(String(item.name).trim())
    ) ?? null;
  }
  // Attacking Class follows the SAME common class-assignment rule as every
  // other class selector (skill-resolution.resolveClassAssignment): the
  // requested/stored selection while it is still a valid warrior class,
  // otherwise the highest-level owned warrior class. Roll time therefore
  // always agrees with the Attacking Class shown on the sheet, and changes
  // to class levels are picked up without stale selections.
  const assignment = resolveClassAssignment({
    classes: actor.items.filter(item => item.type === "class"),
    eligible: isWarriorClass,
    savedValue: requestedClassId || actor.system.combat?.offenseClassId || ""
  });
  return assignment.classId ? actor.items.get(assignment.classId) : null;
}

export async function rollWeaponDamage({ actor, weapon, attackingClass, accumulatedPower = 0, combatStyleId = null, targetActorUuid = null }) {
  const roll = await new Roll("2d6").evaluate();
  // Power Table damage reads the NATURAL dice (a plain 2d6 roll has no
  // modifiers); the fumble and the critical threshold are both detected
  // from these natural results, never from a modified total.
  const diceTotal = naturalDiceTotal(roll);
  // Detection only: the double 1 never writes the counter. The card offers
  // the registration button so the player decides (characters only; monster
  // Power Table damage rolls — if ever routed here — get no button).
  const criticalFailure = isCriticalFailure(roll);
  if (criticalFailure) {
    await roll.toMessage({
      speaker:ChatMessage.getSpeaker({ actor }),
      flavor:`<div class="sw25-weapon-roll"><h3>${foundry.utils.escapeHTML(weapon.name)}</h3>${criticalFailureHTML()}${automaticFailureButton(actor)}<p>No damage is dealt.</p></div>`
    });
    return { criticalFailure:true, total:0 };
  }
  const damage = weaponDamageParts({
    weapon,
    actorSystem: actor.system,
    attackingClass,
    diceTotal
  });
  const powerTotal = Number(accumulatedPower || 0) + damage.tableValue;
  // Effective Extra Damage (DEC-28): the stored circumstantial field is the
  // base; the prepared effect ledger (module/effects/effective-values.mjs)
  // adds the active effects' Extra Damage modifiers to the final total.
  const situationalDamage = Number(actor.system.combat?.additionalDamage ?? 0)
    + sw25EffectModifier(actor, "combat.additionalDamage");
  const total = powerTotal + damage.classLevel + damage.bonus + damage.additionalDamage + situationalDamage;
  // Power Table critical threshold (damage-roll rule): the weapon's own
  // critical value compared against the natural 2d6 roll. Shared with the
  // spell Power Table roll (isPowerTableCritical); never applied to the
  // attack roll or to Spellcasting. Thresholds outside 1..12 never trigger.
  const critical = isPowerTableCritical(roll, weapon.system.critical);
  const criticalControl = critical ? `
    <div class="sw25-critical-prompt">
      <strong>CRITICAL</strong>
      <button type="button"
        data-sw25-chat-action="roll-critical-damage"
        data-actor-id="${actor.id}"
        data-item-id="${weapon.id}"
        data-class-id="${attackingClass?.id ?? ""}"
        data-accumulated-power="${powerTotal}">
        <i class="fas fa-dice-d6"></i> Roll Damage Again
      </button>
    </div>` : "";

  const bonusTotal = total - damage.tableValue;
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `
      <div class="sw25-chat-card sw25-damage-card">
        <h3>${foundry.utils.escapeHTML(weapon.name)} Damage</h3>

        <div class="sw25-damage-stat" data-target="power-detail">
          <div class="sw25-damage-stat-summary" role="button" tabindex="0">
            <span class="sw25-damage-roll">${diceTotal}</span>
            <span class="sw25-damage-arrow">→</span>
            <span class="sw25-damage-table-value">${damage.tableValue}</span>
          </div>
          <div class="sw25-damage-stat-detail" id="power-detail" style="display:none;">
            <ul class="sw25-roll-breakdown">
              <li><strong>Power Table lookup:</strong> ${diceTotal} → ${damage.tableValue}</li>
              ${accumulatedPower ? `<li><strong>Accumulated power-table damage:</strong> ${accumulatedPower}</li>` : ""}
            </ul>
          </div>
        </div>

        <div class="sw25-damage-stat" data-target="damage-detail">
          <div class="sw25-damage-stat-summary" role="button" tabindex="0">
            <span class="sw25-damage-table-value">${damage.tableValue}</span>
            <span class="sw25-damage-plus">+</span>
            <span class="sw25-damage-bonus">${signedValue(bonusTotal)}</span>
            <span class="sw25-damage-equals">=</span>
            <span class="sw25-damage-total">${total}</span>
          </div>
          <div class="sw25-damage-stat-detail" id="damage-detail" style="display:none;">
            <ul class="sw25-roll-breakdown">
              <li><strong>${foundry.utils.escapeHTML(attackingClass.name)} level:</strong> ${damage.classLevel}</li>
              <li><strong>${damage.gun ? "Intelligence" : "Strength"} bonus:</strong> ${signedValue(damage.bonus)}</li>
              <li><strong>Weapon additional damage:</strong> ${signedValue(damage.additionalDamage)}</li>
              <li><strong>Additional damage:</strong> ${signedValue(situationalDamage)}</li>
              ${accumulatedPower ? `<li><strong>Accumulated power-table damage:</strong> ${accumulatedPower}</li>` : ""}
            </ul>
          </div>
        </div>

        ${damageApplicationButton(total, "physical", false, combatStyleId, targetActorUuid)}
        ${criticalControl}
      </div>`
  });
}
