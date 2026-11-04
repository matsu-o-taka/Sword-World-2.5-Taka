// Sword World 2.5 - Attack resolution between characters and monsters
//
// Resolves weapon attacks in both directions using Foundry targeting:
//   - character -> monster: active Accuracy roll vs monster Evasion
//   - monster  -> character: monster Accuracy vs active Evasion roll
//
// Rules enforced here:
//   - The compare is STRICT: the attack total must EXCEED the defender's
//     Evasion. Equaling Evasion does not hit (SW2.5 core combat rule).
//   - Monster Accuracy/Evasion are rolled (active) or taken as passive
//     values (base + 7) according to the WORLD setting
//     "monsterRollResolution", which only affects monsters.
//   - A discovered Weak Point of category "Accuracy" grants the
//     attacker a permanent accuracy modifier derived from the monster's
//     own weakPoint data. Discovery lives in the world weakness registry
//     (Monster Knowledge) and applies to the attack roll, never to
//     damage, and it coexists with temporary modifiers.
//   - Temporary modifiers come from the shared dialog (rules/roll-modifiers)
//     and never touch Actor data.
//   - Natural double 1 on a roll is a critical failure (rules/critical-
//     failure). For the attacker it means an automatic miss; for a
//     character defender it follows the same semantics used by the
//     existing Evasion challenge (the attack lands regardless).

import { readMonsterActorCombatStyles, getMainCombatStyleIndex } from "../actor/monster-sheet-data.mjs";
import { parseWeaknessData } from "./damage-application.mjs";
import { speciesWeaknessKnown } from "./monster-knowledge.mjs";
import { criticalFailureHTML, isCriticalFailure, markCriticalFailure, rollDiceResults } from "../rules/critical-failure.mjs";
import { assembleRollFormula, enabledModifiersTotal, normalizeModifier, openRollModifiersDialog, signedValue } from "../rules/roll-modifiers.mjs";
import { characterEvasionParts } from "./evasion-challenge.mjs";

export const SYSTEM_ID = "sword-world-25";
export const MONSTER_ROLL_RESOLUTION_SETTING = "monsterRollResolution";
const SETTING_CHOICES = new Set(["active", "passive"]);

// Read the global monster roll resolution setting ("active" | "passive").
// Invalid or missing values fall back to "active" so rolls always resolve.
export function getMonsterRollResolution() {
  const value = game?.settings?.get(SYSTEM_ID, MONSTER_ROLL_RESOLUTION_SETTING);
  return SETTING_CHOICES.has(String(value) || "") ? String(value) : "active";
}

// Base modifier from a monster statistic string such as "10 (17)" (stored as
// free text): the leading integer is the active modifier; the parenthesised
// value is only its derived passive presentation (+7, see the study of the
// monster data format — never duplicated as a separate data source here).
// "-" (or any non-numeric text) yields null: the statistic is unavailable.
export function parseBaseValue(raw) {
  const match = String(raw ?? "").match(/-?\d+/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

// Derived passive value: base modifier + 7 (the 2d6 average).
export function passiveValue(base) {
  return Number(base) + 7;
}

// The monster's defense statistic (Evasion) lives on its combat-style rows as
// free text. Resolve which row defends a general attack: the row marked as
// Main Section first, otherwise the first row with a numeric Evasion value.
export function monsterDefenseEntry(monster) {
  const styles = readMonsterActorCombatStyles(monster);
  if (!styles.length) return null;
  const candidates = styles
    .map((style, index) => ({ style, index, base: parseBaseValue(style?.evasion) }))
    .filter(entry => entry.base !== null);
  if (!candidates.length) return null;
  const mainIndex = getMainCombatStyleIndex(styles);
  const main = mainIndex === null ? null : candidates.find(entry => entry.index === mainIndex);
  return main ?? candidates[0];
}

// Target token resolution. Distinguishes targeted tokens (game.user.targets)
// from merely selected/controlled tokens (canvas.tokens.controlled): only
// targeting marks an attack target; selected tokens are reported as such so
// the user knows what is missing.
export function resolveAttackTarget({ targets, controlled } = {}) {
  const targetList = [...(targets ?? game?.user?.targets ?? [])];
  const controlledList = [...(controlled ?? canvas?.tokens?.controlled ?? [])];
  if (!targetList.length) {
    return { status: controlledList.length ? "not-targeted" : "no-target", actor: null, token: null };
  }
  if (targetList.length > 1) return { status: "multiple", actor: null, token: null };
  const token = targetList[0];
  const actor = token?.actor ?? token?.document?.actor ?? null;
  if (!actor) return { status: "no-actor", actor: null, token: null };
  return { status: "ok", actor, token };
}

// Human-readable failure reason for a target that cannot be resolved.
export function describeTargetFailure(status, expectedType) {
  switch (status) {
    case "no-target":
      return `No attack target is selected. Target a token (whose Actor is ${expectedType}) to resolve the attack.`;
    case "not-targeted":
      return "The controlled token is only selected, not targeted. Target the token (aim the target crosshair) so the attack has a defender.";
    case "multiple":
      return "Only one attack target is supported. Clear extra targets first.";
    case "no-actor":
      return "The targeted token has no Actor to defend the attack.";
    case "no-attack":
      return "This attack has no usable Accuracy value.";
    case "not-monster":
      return `The attack target must be a monster. Target a monster token (${expectedType}).`;
    case "not-character":
      return "This attack resolves only against a character. Target a character token.";
    case "no-defense":
      return "The monster has no usable Evasion value in its combat statistics.";
    default:
      return "No valid attack target.";
  }
}

// Weak Point accuracy modifier for the target monster. Uses strictly the
// target's species entry in the world weakness registry (set by Monster
// Knowledge revelations). Shared species knowledge applies to every
// specimen; no per-Actor `weaknessDiscovered` state is consulted. Returns
// null when the Weak Point is undiscovered, absent, or not of the
// "Accuracy" category.
export function weakPointAccuracyModifier(monster) {
  if (monster?.type !== "monster" || !speciesWeaknessKnown(monster)) return null;
  const data = parseWeaknessData(monster?.system?.weakPoint);
  if (!data) return null;
  if (String(data.category).trim().toLowerCase() !== "accuracy") return null;
  const bonus = Number(data.bonus ?? 0);
  if (!Number.isFinite(bonus) || bonus <= 0) return null;
  return { label: `Weak Point (${data.category})`, value: bonus };
}

// Monster defense value for a general attack, honouring the world setting.
// Active: a real `2d6 + base` roll; Passive: base + 7 with no dice at all.
// A double 1 on the active defense roll is a critical failure for the
// defender (the attacker hits unless the attacker also fumbled).
export async function resolveMonsterDefense(monster, mode) {
  const entry = monsterDefenseEntry(monster);
  if (!entry) return null;
  const base = entry.base;
  if (mode === "passive") {
    return { mode: "passive", base, total: passiveValue(base), roll: null, natural: null, criticalFailure: false };
  }
  const roll = await new Roll(assembleRollFormula("2d6", base)).evaluate();
  return {
    mode: "active",
    base,
    total: Number(roll.total),
    roll,
    natural: rollDiceResults(roll).reduce((sum, value) => sum + Number(value || 0), 0),
    criticalFailure: isCriticalFailure(roll)
  };
}

const esc = value => foundry.utils.escapeHTML(String(value ?? ""));

// One side (attacker Accuracy or defender Evasion) of the resolution card.
function rollSideHtml({ title, name, origin, natural, parts = [], total, criticalFailure }) {
  const rows = [];
  if (natural !== null && natural !== undefined) {
    rows.push(`<li><strong>2d6 roll:</strong> ${esc(natural)}</li>`);
  }
  for (const part of parts) {
    rows.push(`<li>${esc(part.label)}: ${esc(signedValue(part.value))}</li>`);
  }
  rows.push(`<li class="sw25-roll-total"><strong>${esc(title)} total: ${esc(signedValue(total))}</strong></li>`);
  if (criticalFailure) rows.push(criticalFailureHTML());
  return `
    <div class="sw25-attack-side">
      <h4>${esc(title)} — ${esc(name)} <span class="sw25-roll-origin">(${esc(origin)})</span></h4>
      <ul class="sw25-roll-breakdown">${rows.join("")}</ul>
    </div>`;
}

// Complete resolution card shared by both directions.
export function attackCardHtml({
  attackerTitle, attackerName, attackStatLabel, attackOrigin, attackNatural, attackParts, attackTotal, attackCriticalFailure,
  defenderName, defenseStatLabel, defenseOrigin, defenseNatural, defenseParts = [], defenseTotal, defenseCriticalFailure,
  attackerCritFailNote, extraHtml = ""
}) {
  const resultClass = attackTotal > defenseTotal ? "sw25-attack-hit" : "sw25-attack-miss";
  return `
    <div class="sw25-chat-card sw25-attack-card">
      <h3>${esc(attackerTitle)} — ${esc(attackStatLabel)} on ${esc(defenderName)}</h3>
      <div class="sw25-attack-sides">
        ${rollSideHtml({
          title: attackStatLabel, name: attackerName, natural: attackNatural,
          parts: attackParts, total: attackTotal, criticalFailure: attackCriticalFailure, origin: attackOrigin
        })}
        ${rollSideHtml({
          title: defenseStatLabel, name: defenderName, natural: defenseNatural,
          parts: defenseParts, total: defenseTotal, criticalFailure: defenseCriticalFailure, origin: defenseOrigin
        })}
      </div>
      <p class="sw25-attack-compare">The attack must exceed ${esc(defenseStatLabel)}: <strong>${esc(signedValue(attackTotal))}</strong> vs <strong>${esc(signedValue(defenseTotal))}</strong></p>
      ${attackerCritFailNote ? `<p>${esc(attackerCritFailNote)}</p>` : ""}
      <p class="${resultClass}"><strong>${attackTotal > defenseTotal ? "HIT" : "MISS"}</strong></p>
      ${extraHtml}
    </div>`;
}

// Compile a full breakdown from enabled dialog modifiers.
const breakdownParts = modifiers => modifiers
  .filter(part => part?.enabled !== false)
  .map(part => normalizeModifier(part));

// ---------------------------------------------------------------------------
// Character -> monster attack
// ---------------------------------------------------------------------------

/**
 * Resolve a character weapon attack against a monster target.
 *
 * @param {object} flow
 * @param {Actor}   flow.actor            Attacking character.
 * @param {Item}    flow.weapon           Weapon item.
 * @param {Item}    flow.attackingClass   Class item resolved by the weapon.
 * @param {Array}   flow.accuracyParts    Permanent Accuracy parts of the
 *                                        character (labels included).
 * @param {Actor}   flow.targetMonster    Defending monster Actor.
 * @param {string}  [flow.resolutionMode] "active"/"passive" monster setting.
 * @param {Function} [flow.promptModifiers] Injectable dialog (tests).
 * @returns {Promise<object>} status + resolution details.
 */
export async function characterWeaponAttackFlow({
  actor, weapon, attackingClass, accuracyParts, targetMonster,
  resolutionMode = getMonsterRollResolution(),
  promptModifiers = openRollModifiersDialog
} = {}) {
  if (targetMonster?.type !== "monster") return { status: "invalid-target" };
  const defense = await resolveMonsterDefense(targetMonster, resolutionMode);
  if (!defense) return { status: "no-defense" };

  const weakPoint = weakPointAccuracyModifier(targetMonster);
  const seedParts = [...(accuracyParts ?? []).map(part => ({ ...part, enabled: true, temporary: false }))];
  if (weakPoint) seedParts.push(weakPoint);

  const modifiers = await promptModifiers({
    title: `${weapon?.name ?? "Attack"} — Modifiers`,
    diceFormula: "2d6",
    submitLabel: "Resolve Attack",
    parts: seedParts
  });
  if (!modifiers) return { status: "cancelled", phases: { dialog: true, roll: false } };

  const parts = breakdownParts(modifiers);
  const total = enabledModifiersTotal(parts);
  const roll = await new Roll(assembleRollFormula("2d6", total)).evaluate();
  const natural = rollDiceResults(roll).reduce((sum, value) => sum + Number(value || 0), 0);
  const attackerCriticalFailure = await markCriticalFailure(actor, roll);

  // Strict comparison: the attack must EXCEED the defender's Evasion.
  const hit = !attackerCriticalFailure && (defense.criticalFailure || Number(roll.total) > defense.total);

  const damageButtonHtml = hit && !isGunLikeWeapon(weapon) ? `
    <button type="button" class="sw25-attack-damage"
      data-sw25-chat-action="roll-critical-damage"
      data-actor-id="${esc(actor?.id)}"
      data-item-id="${esc(weapon?.id)}"
      data-class-id="${esc(attackingClass?.id ?? "")}"
      data-accumulated-power="0">
      <i class="fas fa-dice-d6"></i> Roll Damage</button>` : "";

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: attackCardHtml({
      attackerTitle: weapon?.name ?? "Attack",
      attackerName: actor?.name,
      attackStatLabel: "Accuracy",
      attackOrigin: `${weapon?.name ?? "Weapon"}-Accuracy (2d6${total ? ` ${total > 0 ? "+" : "-"} ${Math.abs(total)}` : ""})`,
      attackNatural: natural,
      attackParts: parts,
      attackTotal: Number(roll.total),
      attackCriticalFailure: Boolean(attackerCriticalFailure),
      defenderName: targetMonster?.name,
      defenseStatLabel: "Evasion",
      defenseOrigin: defense.mode === "passive"
        ? `passive (base ${signedValue(defense.base)} + 7)`
        : `active roll (2d6 ${signedValue(defense.base)})`,
      defenseNatural: defense.natural,
      defenseParts: [{ label: "Base Evasion", value: defense.base }],
      defenseTotal: defense.total,
      defenseCriticalFailure: Boolean(defense.criticalFailure),
      attackerCritFailNote: attackerCriticalFailure ? "Critical failure: the attack is an automatic miss." : "",
      extraHtml: damageButtonHtml
    })
  });

  return {
    status: "resolved",
    hit,
    attackTotal: Number(roll.total),
    attackNatural: natural,
    defenseTotal: defense.total,
    defenseMode: defense.mode,
    defenseCriticalFailure: defense.criticalFailure,
    attackerCriticalFailure
  };
}

const isGunLikeWeapon = weapon => /^(gun|artificer)/i.test(String(weapon?.system?.category ?? ""));

// ---------------------------------------------------------------------------
// Monster -> character attack
// ---------------------------------------------------------------------------

/**
 * Resolve a monster attack (one combat style row) against a character target.
 *
 * @param {object} flow
 * @param {Actor}  flow.monsterActor   Attacking monster Actor.
 * @param {object} flow.style          Combat style row of the attack.
 * @param {Actor}  flow.targetActor    Defending character Actor.
 * @param {string} [flow.resolutionMode] "active"/"passive" monster setting.
 * @param {Function} [flow.promptModifiers] Injectable dialog (tests).
 * @returns {Promise<object>} status + resolution details.
 */
export async function monsterWeaponAttackFlow({
  monsterActor, style, targetActor,
  resolutionMode = getMonsterRollResolution(),
  promptModifiers = openRollModifiersDialog
} = {}) {
  const attackBase = parseBaseValue(style?.accuracy);
  if (attackBase === null) return { status: "no-attack" };
  if (targetActor?.type !== "character") return { status: "invalid-target" };

  let attackNatural = null;
  let attackTotal;
  let attackRoll = null;
  let attackCriticalFailure = false;
  if (resolutionMode === "passive") {
    // Passive mode: no dice are invented for the monster's Accuracy.
    attackTotal = passiveValue(attackBase);
  } else {
    attackRoll = await new Roll(assembleRollFormula("2d6", attackBase)).evaluate();
    attackNatural = rollDiceResults(attackRoll).reduce((sum, value) => sum + Number(value || 0), 0);
    attackTotal = Number(attackRoll.total);
    attackCriticalFailure = isCriticalFailure(attackRoll);
  }

  const defensePartsSeed = characterEvasionParts(targetActor)
    .map(part => ({ ...part, enabled: true, temporary: false }));
  const modifiers = await promptModifiers({
    title: `${targetActor?.name ?? "Evasion"} — Modifiers`,
    diceFormula: "2d6",
    submitLabel: "Roll Evasion",
    parts: defensePartsSeed
  });
  if (!modifiers) return { status: "cancelled" };

  const evasionParts = breakdownParts(modifiers);
  const evasionExtra = enabledModifiersTotal(evasionParts);
  const evasionRoll = await new Roll(assembleRollFormula("2d6", evasionExtra)).evaluate();
  const evasionNatural = rollDiceResults(evasionRoll).reduce((sum, value) => sum + Number(value || 0), 0);
  const evasionCriticalFailure = await markCriticalFailure(targetActor, evasionRoll);

  // Strict comparison with the character's active Evasion roll. A critical
  // failure on the defender's roll lets the attack through (same semantics
  // as the existing Evasion challenge); an attacking critical failure always
  // misses.
  const hit = !attackCriticalFailure && (evasionCriticalFailure || attackTotal > Number(evasionRoll.total));
  const attackOrigin = resolutionMode === "passive"
    ? `passive (base ${signedValue(attackBase)} + 7)`
    : `active roll (2d6 ${signedValue(attackBase)})`;
  const resolutionNote = resolutionMode === "passive"
    ? "Monster Accuracy resolved with its passive value (base + 7); no dice were rolled."
    : "Monster Accuracy resolved with a real 2d6 roll.";

  const cardHtml = attackCardHtml({
    attackerTitle: `${monsterActor?.name} attack`,
    attackerName: monsterActor?.name,
    attackStatLabel: "Accuracy",
    attackOrigin,
    attackNatural,
    attackParts: [{ label: "Base Accuracy", value: attackBase }],
    attackTotal,
    attackCriticalFailure,
    defenderName: targetActor?.name,
    defenseStatLabel: "Evasion",
    defenseOrigin: "active roll (character)",
    defenseNatural: evasionNatural,
    defenseParts: evasionParts,
    defenseTotal: Number(evasionRoll.total),
    defenseCriticalFailure: evasionCriticalFailure,
    attackerCritFailNote: attackCriticalFailure
      ? "Critical failure: the attack is an automatic miss."
      : "",
    extraHtml: `<p class="sw25-attack-note">${esc(resolutionNote)}</p>`
  });

  if (attackRoll) {
    // Active attack: publish through the attack roll so the dice are visible.
    await attackRoll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: monsterActor }),
      flavor: cardHtml
    });
  } else {
    // Passive mode: no attack dice exist; publish the breakdown directly.
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: monsterActor }),
      content: cardHtml
    });
  }

  return {
    status: "resolved",
    hit,
    attackTotal,
    attackNatural,
    defenseTotal: Number(evasionRoll.total),
    defenseMode: "active",
    defenseCriticalFailure: evasionCriticalFailure,
    attackCriticalFailure
  };
}

