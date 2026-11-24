import { isGunWeapon, isWarriorClass, weaponDamageParts } from "./weapon-damage.mjs";
import { damageApplicationButton, incomingDamageContext } from "../combat/damage-application.mjs";
import { automaticFailureButton, isPowerTableCritical, isCriticalFailure, naturalDiceTotal } from "./critical-failure.mjs";
import { resolveClassAssignment } from "./skill-resolution.mjs";
import { signedValue } from "./roll-modifiers.mjs";
import { sw25EffectModifier } from "../effects/effective-values.mjs";
import { resolveCriticalDamageChain } from "./critical-damage.mjs";

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

export async function rollWeaponDamage({ actor, weapon, attackingClass, combatStyleId = null, targetActorUuid = null }) {
  const chain = await resolveCriticalDamageChain({
    rollDamage: () => new Roll("2d6").evaluate(),
    resolveRoll: roll => {
      const diceTotal = naturalDiceTotal(roll);
      if (isCriticalFailure(roll)) return { automaticFailure:true, diceTotal };
      const damage = weaponDamageParts({ weapon, actorSystem:actor.system, attackingClass, diceTotal });
      return { diceTotal, damage, tableValue:damage.tableValue, critical:isPowerTableCritical(roll, weapon.system.critical) };
    }
  });
  if (chain.automaticFailure) {
    const failureRoll = chain.rolls.at(-1).roll;
    await failureRoll.toMessage({
      speaker:ChatMessage.getSpeaker({ actor }),
      flavor:`<div class="sw25-chat-card sw25-damage-card"><h3>${foundry.utils.escapeHTML(weapon.name)} Damage</h3><div class="sw25-damage-outcome"><span class="sw25-spell-outcome-badge sw25-spell-outcome-failure">CRITICAL FAILURE</span></div><p class="sw25-damage-failure-note">Damage is 0. The critical chain ends here.</p>${automaticFailureButton(actor)}</div>`
    });
    return { criticalFailure:true, total:0 };
  }
  const damage = chain.rolls[0].damage;
  const powerTotal = chain.accumulated;
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
  const critical = chain.rolls.some(entry => entry.critical);
  const chainRows = chain.rolls.map((entry, index) =>
    `<li><span class="sw25-damage-breakdown-roll">${index === 0 ? "Initial roll" : `Critical continuation ${index}`}: ${entry.diceTotal} → ${entry.tableValue}</span><span class="sw25-damage-breakdown-running">Accumulated table damage: ${chain.rolls.slice(0, index + 1).reduce((sum, rollEntry) => sum + Number(rollEntry.tableValue ?? 0), 0)}</span>${entry.critical ? '<span class="sw25-damage-breakdown-critical">Critical — continuation rolled</span>' : ""}</li>`
  ).join("");
  const uniqueId = foundry.utils.randomID?.() ?? globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const detailId = `weapon-damage-${uniqueId}`;
  const totalId = `${detailId}-total`;
  const rollSteps = chain.rolls.map((entry, index) =>
    `<div class="sw25-damage-roll-step"><span class="sw25-damage-roll-kind">${index === 0 ? "Power Table" : `Critical roll ${index}`}</span><span class="sw25-damage-roll">${entry.diceTotal}</span><span class="sw25-damage-arrow">→</span><span class="sw25-damage-table-value">${entry.tableValue}</span>${entry.critical ? '<span class="sw25-damage-roll-critical">critical → continued</span>' : ""}</div>`
  ).join("");
  await chain.rolls[0].roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `
      <div class="sw25-chat-card sw25-damage-card">
        <h3>${foundry.utils.escapeHTML(weapon.name)} Damage</h3>
        ${critical ? '<div class="sw25-damage-outcome"><span class="sw25-attack-outcome-badge sw25-attack-critical">CRITICAL DAMAGE</span></div>' : ""}
        <div class="sw25-damage-roll-sequence">${rollSteps}</div>
        <div class="sw25-damage-stat sw25-damage-result" data-target="${totalId}">
          <div class="sw25-damage-stat-summary sw25-damage-result-summary" role="button" tabindex="0"><span class="sw25-damage-result-label">Damage</span><span class="sw25-damage-result-value">${total}</span><span class="sw25-damage-result-hint">breakdown</span></div>
          <div class="sw25-damage-stat-detail" id="${totalId}" style="display:none;"><ul class="sw25-roll-breakdown">${chainRows}<li><strong>Accumulated table damage:</strong> ${powerTotal}</li><li><strong>${foundry.utils.escapeHTML(attackingClass?.name ?? "Class")} level:</strong> ${damage.classLevel}</li><li><strong>${damage.gun ? "Intelligence" : "Strength"} bonus:</strong> ${signedValue(damage.bonus)}</li><li><strong>Weapon additional damage:</strong> ${signedValue(damage.additionalDamage)}</li><li><strong>Additional damage:</strong> ${signedValue(situationalDamage)}</li><li><strong>Extra Damage:</strong> ${signedValue(damage.classLevel + damage.bonus + damage.additionalDamage + situationalDamage)}</li><li class="sw25-damage-breakdown-final"><strong>Final damage:</strong> ${total}</li></ul></div>
        </div>
        ${damageApplicationButton(total, "physical", false, combatStyleId, targetActorUuid, incomingDamageContext(weapon))}
      </div>`
  });
  return { criticalFailure:false, total, critical, chain:chain.rolls };
}
