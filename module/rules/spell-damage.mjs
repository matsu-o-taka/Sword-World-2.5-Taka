import { damageApplicationButton } from "../combat/damage-application.mjs";
import { abilityBonus } from "./weapon-damage.mjs";
import { resolvePowerTableResult } from "./power-table.mjs";
import { resolveCriticalDamageChain } from "./critical-damage.mjs";
import { characterResourceValue, updateCharacterResourceValue } from "./resources.mjs";
import { sw25EffectModifier } from "../effects/effective-values.mjs";
import { automaticFailureButton, criticalFailureHTML, isCriticalFailure, isPowerTableCritical, naturalDiceTotal } from "./critical-failure.mjs";
import { signedValue } from "./roll-modifiers.mjs";

const WOLFS_BITE_BANDS = [
  { min:2, max:6, bonus:0, damageType:"physical", text:"Magic Power points as physical damage." },
  { min:7, max:9, bonus:3, damageType:"physical", text:"3 + Magic Power points of physical damage." },
  { min:10, max:12, bonus:6, damageType:"physical", text:"6 + Magic Power points of physical damage." }
];

const THORN_BASH_BANDS = [
  { min:2, max:6, bonus:4, damageType:"physical", text:"4 + Magic Power points of physical damage." },
  { min:7, max:9, bonus:7, damageType:"physical", text:"7 + Magic Power points of physical damage." },
  { min:10, max:12, bonus:13, damageType:"physical", text:"13 + Magic Power points of physical damage." }
];

const KONG_SMASH_BANDS = [
  { min:2, max:6, bonus:12, damageType:"physical", text:"12 + Magic Power points of physical damage." },
  { min:7, max:9, bonus:15, damageType:"physical", text:"15 + Magic Power points of physical damage." },
  { min:10, max:12, bonus:18, damageType:"physical", text:"18 + Magic Power points of physical damage." }
];

const BOAR_RUSH_BANDS = [
  { min:2, max:6, bonus:13, damageType:"physical", text:"13 + Magic Power points of physical damage." },
  { min:7, max:9, bonus:16, damageType:"physical", text:"16 + Magic Power points of physical damage." },
  { min:10, max:12, bonus:19, damageType:"physical", text:"19 + Magic Power points of physical damage." }
];

const MARSAVRA_SMASH_BANDS = [
  { min:2, max:6, bonus:18, damageType:"physical", text:"18 + Magic Power points of physical damage." },
  { min:7, max:9, bonus:21, damageType:"physical", text:"21 + Magic Power points of physical damage." },
  { min:10, max:12, bonus:24, damageType:"physical", text:"24 + Magic Power points of physical damage." }
];

const LUNAR_ATTACK_BANDS = [
  { min:2, max:6, bonus:18, damageType:"physical", text:"18 + Magic Power points of physical damage." },
  { min:7, max:9, bonus:21, damageType:"physical", text:"21 + Magic Power points of physical damage." },
  { min:10, max:12, bonus:36, damageType:"physical", text:"36 + Magic Power points of physical damage." }
];

const DOUBLE_STOMP_BANDS = [
  { min:2, max:6, bonus:24, damageType:"physical", text:"24 + Magic Power points of physical damage." },
  { min:7, max:9, bonus:27, damageType:"physical", text:"27 + Magic Power points of physical damage." },
  { min:10, max:12, bonus:30, damageType:"physical", text:"30 + Magic Power points of physical damage." }
];

export function specialDamageBands(spell) {
  const stored = Array.isArray(spell?.system?.specialDamageBands) ? spell.system.specialDamageBands : [];
  if (stored.length) return stored;
  const source = String(spell?.system?.sourceUrl || "").toLowerCase();
  const name = String(spell?.name || "").trim().toLowerCase();
  if (source.includes("spell:wolfs-bite") || name === "wolf's bite" || name === "wolfs bite") return WOLFS_BITE_BANDS;
  if (source.includes("spell:thorn-bash") || name === "thorn bash") return THORN_BASH_BANDS;
  if (source.includes("spell:kong-smash") || name === "kong smash") return KONG_SMASH_BANDS;
  if (source.includes("spell:bohr-rush") || name === "boar rush" || name === "bohr rush") return BOAR_RUSH_BANDS;
  if (source.includes("spell:marsavra-smash") || name === "marsavra smash") return MARSAVRA_SMASH_BANDS;
  if (source.includes("spell:lunar-attack") || name === "lunar attack") return LUNAR_ATTACK_BANDS;
  if (source.includes("spell:double-stomp") || name === "double stomp") return DOUBLE_STOMP_BANDS;
  return [];
}

export function isDoubleStomp(spell) {
  const source = String(spell?.system?.sourceUrl || "").toLowerCase();
  const name = String(spell?.name || "").trim().toLowerCase();
  return source.includes("spell:double-stomp") || name === "double stomp";
}

export function isNaturalPower(spell) {
  const source = String(spell?.system?.sourceUrl || "").toLowerCase();
  const name = String(spell?.name || "").trim().toLowerCase().replace(/[’]/g, "'");
  return /spell:natural-power(?:-ii)?(?:$|[?#])/.test(source) || name === "natural power" || name === "natural power ii";
}

export function isNatureMagic(spell) {
  const details = [spell?.system?.requirement, spell?.system?.metadata, spell?.system?.className].join(" ");
  return /\bnature\b|\bdruid\b/i.test(details);
}

export function naturalPowerRemainder(state) {
  return Math.max(0, (Number(state?.added) || 0) - (Number(state?.spent) || 0));
}

export async function trackNaturalPowerSpending(actor, amount, spell = null) {
  const spent = Math.max(0, Number(amount) || 0);
  const state = actor.getFlag("sw25-taka", "naturalPower");
  if (!state || !spent || !isNatureMagic(spell)) return;
  await actor.setFlag("sw25-taka", "naturalPower", { ...state, spent:(Number(state.spent) || 0) + spent });
}

export async function addNaturalPowerMP(actor, amount) {
  const gained = Math.max(0, Number(amount) || 0);
  if (!gained) return;
  const state = actor.getFlag("sw25-taka", "naturalPower") ?? { added: 0, spent: 0 };
  const currentMP = characterResourceValue(actor, "mp");
  await updateCharacterResourceValue(actor, "mp", currentMP + gained);
  await actor.setFlag("sw25-taka", "naturalPower", {
    added:(Number(state.added) || 0) + gained,
    spent:Number(state.spent) || 0,
    combatId:game.combat?.id || "",
    round:Number(game.combat?.round || 0)
  });
}

export async function expireNaturalPower(actor) {
  const state = actor?.getFlag("sw25-taka", "naturalPower");
  if (!state) return 0;
  const remainder = naturalPowerRemainder(state);
  if (remainder) {
    const currentMP = characterResourceValue(actor, "mp");
    await updateCharacterResourceValue(actor, "mp", Math.max(0, currentMP - remainder));
  }
  await actor.unsetFlag("sw25-taka", "naturalPower");
  return remainder;
}

export async function rollNaturalPower({ actor, spell }) {
  const roll = await new Roll("2d6").evaluate();
  const diceTotal = Number(roll.total) || 0;
  const { result:tableValue } = resolvePowerTableResult(spell, diceTotal);
  const gained = Math.max(0, tableValue);
  const escape = value => foundry.utils.escapeHTML(String(value || ""));
  await roll.toMessage({
    speaker:ChatMessage.getSpeaker({ actor }),
    flavor:`<div class="sw25-chat-card sw25-natural-power-result"><h3>${escape(spell.name)}</h3><p><strong>Power-table roll:</strong> ${diceTotal} → ${gained} MP</p><p><strong>Unused MP gained from this spell is lost when this character ends their turn.</strong></p><button type="button" data-sw25-chat-action="add-natural-power" data-actor-id="${actor.id}" data-mp="${gained}"><i class="fas fa-plus"></i> Add ${gained} MP</button></div>`
  });
  return gained;
}

export function resolveSpecialSpellDamage(bands, diceTotal, magicPowerResult) {
  const roll = Number(diceTotal) || 0;
  const band = bands.find(entry => roll >= Number(entry.min) && roll <= Number(entry.max));
  if (!band) return null;
  const bonus = Number(band.bonus) || 0;
  return { band, bonus, total:(Number(magicPowerResult) || 0) + bonus };
}

export async function rememberMagicPowerRoll(actor, roll, classId = "") {
  await actor.setFlag("sw25-taka", "lastMagicPowerRoll", {
    total:Number(roll.total) || 0,
    classId:String(classId || ""),
    criticalFailure:isCriticalFailure(roll),
    timestamp:Date.now()
  });
}

// Effective Magic Power for spell EXTRA DAMAGE (DEC-28): casting class level
// + Intelligence bonus + the prepared effect ledger's combat.magicPower
// entry. Shared source so sheets, chat cards and rolls never compute
// different values.
export function spellDamageMagicPower(actor, castingClass) {
  return Number(castingClass?.system?.level ?? 0)
    + abilityBonus(actor?.system, "intelligence")
    + sw25EffectModifier(actor, "combat.magicPower");
}

// Generic Power Table damage roll for spells. It reuses the SAME mechanism
// as weapon damage (rules/weapon-roll.mjs): natural 2d6 -> fumble check ->
// table lookup -> accumulated power-table damage -> the item's own critical
// threshold -> an additional full table roll through the shared
// `roll-critical-damage` chat action. No parallel spell implementation.
//
// DEC-6: the Success Value is the result of the CASTING roll, never the
// damage total. The authentic cast SV arrives ONLY from the caller (the cast
// flow stamps it on the chat card); it is preserved across critical rolls
// and never re-derived here. When the caller has no casting SV (a damage
// roll posted outside a cast), NO SV travels: null is never fabricated.

// Per-card unique suffix for the collapsible detail anchors: chat messages
// accumulate in the log and survive reloads, so a module-local counter would
// eventually reuse an id already present in an older message.
const spellDamageCardId = () => `spell-damage-card-${foundry.utils.randomID()}`;

export async function rollSpellPowerTableDamage({ actor, spell, castingClass, successValue = null, targetActorUuid = null }) {
  const chain = await resolveCriticalDamageChain({
    rollDamage: () => new Roll("2d6").evaluate(),
    resolveRoll: roll => {
      const diceTotal = naturalDiceTotal(roll);
      if (isCriticalFailure(roll)) return { automaticFailure:true, diceTotal };
      const { result:tableValue } = resolvePowerTableResult(spell, diceTotal);
      return { diceTotal, tableValue, critical:isPowerTableCritical(roll, spell.system.critical) };
    }
  });
  if (chain.automaticFailure) {
    const roll = chain.rolls.at(-1).roll;
    await roll.toMessage({ speaker:ChatMessage.getSpeaker({ actor }), flavor:`<div class="sw25-chat-card sw25-damage-card sw25-spell-damage"><h3>${foundry.utils.escapeHTML(spell.name)} Damage</h3><div class="sw25-damage-outcome"><span class="sw25-spell-outcome-badge sw25-spell-outcome-failure">CRITICAL FAILURE</span></div><p class="sw25-damage-failure-note">Damage is 0. The critical chain ends here.</p>${automaticFailureButton(actor)}</div>` });
    return { criticalFailure:true, total:0 };
  }
  const magicPower = spellDamageMagicPower(actor, castingClass);
  const powerTotal = chain.accumulated;
  const total = powerTotal + magicPower;
  // DEC-6: ONLY an authentic casting SV supplied by the caller is
  // transported. A damage roll posted outside a cast carries no SV — no
  // value is derived from the damage roll or fabricated.
  const providedSuccessValue = Number(successValue);
  const spellSuccessValue = successValue !== null && successValue !== undefined && Number.isFinite(providedSuccessValue)
    ? providedSuccessValue
    : null;
  // Power Table critical (damage-roll rule): the spell's own critical value
  // against the natural roll; never the attack or Spellcasting rule.
  const critical = chain.rolls.some(entry => entry.critical);
  const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
  const chainRows = chain.rolls.map((entry, index) =>
    `<li><span class="sw25-damage-breakdown-roll">${index === 0 ? "Initial roll" : `Critical continuation ${index}`}: ${entry.diceTotal} → ${entry.tableValue}</span><span class="sw25-damage-breakdown-running">Accumulated table damage: ${chain.rolls.slice(0, index + 1).reduce((sum, rollEntry) => sum + Number(rollEntry.tableValue ?? 0), 0)}</span>${entry.critical ? '<span class="sw25-damage-breakdown-critical">Critical — continuation rolled</span>' : ""}</li>`
  ).join("");
  const rollSteps = chain.rolls.map((entry, index) =>
    `<div class="sw25-damage-roll-step"><span class="sw25-damage-roll-kind">${index === 0 ? "Power Table" : `Critical roll ${index}`}</span><span class="sw25-damage-roll">${entry.diceTotal}</span><span class="sw25-damage-arrow">→</span><span class="sw25-damage-table-value">${entry.tableValue}</span>${entry.critical ? '<span class="sw25-damage-roll-critical">critical → continued</span>' : ""}</div>`
  ).join("");
  const detailId = spellDamageCardId();
  const totalId = `${detailId}-total`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="sw25-chat-card sw25-damage-card sw25-spell-damage"><h3>${escape(spell.name)} Damage</h3>${critical ? '<div class="sw25-damage-outcome"><span class="sw25-attack-outcome-badge sw25-attack-critical">CRITICAL DAMAGE</span></div>' : ""}<div class="sw25-damage-roll-sequence">${rollSteps}</div><div class="sw25-damage-stat sw25-damage-result" data-target="${totalId}"><div class="sw25-damage-stat-summary sw25-damage-result-summary" role="button" tabindex="0"><span class="sw25-damage-result-label">Damage</span><span class="sw25-damage-result-value">${total}</span><span class="sw25-damage-result-hint">breakdown</span></div><div class="sw25-damage-stat-detail" id="${totalId}" style="display:none;"><ul class="sw25-roll-breakdown">${chainRows}<li><strong>Accumulated table damage:</strong> ${powerTotal}</li><li><strong>Magic Power:</strong> ${signedValue(magicPower)}</li><li class="sw25-damage-breakdown-final"><strong>Final damage:</strong> ${total}</li></ul></div></div>${damageApplicationButton(total, "magical", true, null, targetActorUuid)}</div>`
  });
  return {
    criticalFailure:false, total, spellSuccessValue, critical, chain:chain.rolls, magicPower,
    diceTotal:chain.rolls[0].diceTotal, tableValue:chain.rolls[0].tableValue
  };
}

export async function rollSpecialSpellDamage({ actor, spell, castingClass }) {
  const bands = specialDamageBands(spell);
  if (!bands.length) return false;
  const previous = actor.getFlag("sw25-taka", "lastMagicPowerRoll");
  if (!previous || !Number.isFinite(Number(previous.total))) {
    ui.notifications.warn(`Roll ${castingClass.name} Magic Power before casting ${spell.name}.`);
    return false;
  }
  if (previous.classId && String(previous.classId) !== String(castingClass.id)) {
    ui.notifications.warn(`The previous Magic Power roll was for another class. Roll ${castingClass.name} Magic Power first.`);
    return false;
  }
  if (previous.criticalFailure) return ui.notifications.warn("The previous Magic Power roll was a critical failure.");

  const roll = await new Roll("2d6").evaluate();
  const criticalFailure = isCriticalFailure(roll);
  if (criticalFailure) {
    await roll.toMessage({ speaker:ChatMessage.getSpeaker({ actor }), flavor:`<div class="sw25-chat-card"><h3>${foundry.utils.escapeHTML(spell.name)} Damage</h3>${criticalFailureHTML()}${automaticFailureButton(actor)}<p>No damage is dealt.</p></div>` });
    return false;
  }
  const resolved = resolveSpecialSpellDamage(bands, roll.total, previous.total);
  if (!resolved) return false;
  const type = String(resolved.band.damageType || "physical").toLowerCase() === "magical" ? "magical" : "physical";
  const escape = value => foundry.utils.escapeHTML(String(value || ""));
  const detailId = spellDamageCardId();
  await roll.toMessage({
    speaker:ChatMessage.getSpeaker({ actor }),
    flavor:`<div class="sw25-chat-card sw25-damage-card sw25-spell-damage"><h3>${escape(spell.name)} Damage</h3><div class="sw25-damage-stat" data-target="${detailId}-band"><div class="sw25-damage-stat-summary" role="button" tabindex="0"><span class="sw25-damage-roll">${Number(roll.total)}</span><span class="sw25-damage-arrow">→</span><span class="sw25-damage-total">${resolved.total}</span></div><div class="sw25-damage-stat-detail" id="${detailId}-band" style="display:none;"><ul class="sw25-roll-breakdown"><li><strong>Damage-table roll:</strong> ${Number(roll.total)} (${Number(resolved.band.min)}–${Number(resolved.band.max)})</li><li>${escape(resolved.band.text)}</li><li><strong>Previous Magic Power roll:</strong> ${Number(previous.total)}</li>${resolved.bonus ? `<li><strong>Table bonus:</strong> +${resolved.bonus}</li>` : ""}</ul></div></div><p class="sw25-weapon-total"><strong>Total:</strong> ${resolved.total}</p>${damageApplicationButton(resolved.total, type)}</div>`
  });
  return true;
}

export async function rollDoubleStompDamage({ actor, spell, castingClass, targets }) {
  const bands = specialDamageBands(spell);
  const previous = actor.getFlag("sw25-taka", "lastMagicPowerRoll");
  if (!previous || !Number.isFinite(Number(previous.total)) || (previous.classId && String(previous.classId) !== String(castingClass.id))) {
    ui.notifications.warn(`Roll ${castingClass.name} Magic Power before casting ${spell.name}.`);
    return false;
  }
  if (previous.criticalFailure) return ui.notifications.warn("The previous Magic Power roll was a critical failure.");
  for (const token of targets) {
    const target = token.actor;
    const roll = await new Roll("2d6").evaluate();
    const criticalFailure = isCriticalFailure(roll);
    if (criticalFailure) {
      await roll.toMessage({ speaker:ChatMessage.getSpeaker({ actor }), flavor:`<div class="sw25-chat-card"><h3>${foundry.utils.escapeHTML(spell.name)} — ${foundry.utils.escapeHTML(target?.name || "Target")}</h3>${criticalFailureHTML()}${automaticFailureButton(actor)}<p>No damage is dealt to this target.</p></div>` });
      continue;
    }
    const resolved = resolveSpecialSpellDamage(bands, roll.total, previous.total);
    if (!target || !resolved) continue;
    const detailId = spellDamageCardId();
    await roll.toMessage({
      speaker:ChatMessage.getSpeaker({ actor }),
      flavor:`<div class="sw25-chat-card sw25-damage-card sw25-spell-damage"><h3>${foundry.utils.escapeHTML(spell.name)} — ${foundry.utils.escapeHTML(target.name)}</h3><div class="sw25-damage-stat" data-target="${detailId}-band"><div class="sw25-damage-stat-summary" role="button" tabindex="0"><span class="sw25-damage-roll">${Number(roll.total)}</span><span class="sw25-damage-arrow">→</span><span class="sw25-damage-total">${resolved.total}</span></div><div class="sw25-damage-stat-detail" id="${detailId}-band" style="display:none;"><ul class="sw25-roll-breakdown"><li><strong>Damage-table roll:</strong> ${Number(roll.total)} (${Number(resolved.band.min)}–${Number(resolved.band.max)})</li><li><strong>Previous Magic Power roll:</strong> ${Number(previous.total)}</li><li><strong>Table bonus:</strong> +${resolved.bonus}</li></ul></div></div><p class="sw25-weapon-total"><strong>Total: ${resolved.total} physical damage</strong></p><p><em>Select ${foundry.utils.escapeHTML(target.name)} before applying this result.</em></p>${damageApplicationButton(resolved.total, "physical", false)}</div>`
    });
  }
  return true;
}
