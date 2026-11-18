// Sword World 2.5 - Attack resolution between characters and monsters
//
// Resolves weapon attacks in both directions using Foundry targeting:
//   - character -> monster: active Accuracy roll vs monster Evasion
//   - monster  -> character: monster Accuracy vs active Evasion roll
//
// Rules enforced here:
//   - The compare is STRICT: the attack total must EXCEED the defender's
//     Evasion. Equaling Evasion does not hit (SW2.5 core combat rule).
//   - Monster rolls are governed by the per-monster toggle
//     `system.activeCombatRolls` (Addresses sheet UI + template.json):
//       enabled  -> monster Accuracy/Evasion roll 2d6 + base (active)
//       disabled -> monster uses its parenthesized value, base + 7 (fixed)
//     The toggle defaults to disabled for monsters without the property.
//     An explicit `resolutionMode` argument overrides the toggle.
//   - Weak Points discovered through Monster Knowledge are recorded in the
//     Monster Knowledge Registry (module/knowledge/, F1). They do not
//     currently grant any mechanical bonus during attack resolution: the
//     bonus application is documented pending work, and the pre-F1
//     `weaknessRegistry` setting no longer receives writes after F2-T1.
//   - Temporary modifiers come from the shared dialog (rules/roll-modifiers)
//     and never touch Actor data.
//   - Natural double 1 on a roll is a critical failure (rules/critical-
//     failure). For the attacker it means an automatic miss; for a
//     character defender it follows the same semantics used by the
//     existing Evasion challenge (the attack lands regardless).
//   - Natural double 6 on an ATTACK roll is an automatic critical: it beats
//     the defender's Evasion regardless of the totals. The weapon's Power
//     Table critical threshold is a DAMAGE-roll rule (rules/weapon-roll)
//     and is never applied to the attack roll.

import { readMonsterActorCombatStyles, getMainCombatStyleIndex } from "../actor/monster-sheet-data.mjs";
import { parseWeaknessData, numericCombatValue } from "./damage-application.mjs";
import { automaticFailureButton, criticalFailureHTML, isCriticalFailure, isNaturalDouble, naturalDiceTotal } from "../rules/critical-failure.mjs";
import { assembleRollFormula, enabledModifiersTotal, normalizeModifier, openRollModifiersDialog, signedValue } from "../rules/roll-modifiers.mjs";
import { openTargetSelectionDialog } from "../rules/target-selection.mjs";
import { characterEvasionParts, staticAccuracy } from "./evasion-challenge.mjs";

// Per-monster toggle reader. Missing property means fixed mode (no rolls).
export function getMonsterActiveCombatRolls(monster) {
  return Boolean(monster?.system?.activeCombatRolls ?? false);
}

// Read the active/fixed mode for a monster: an explicit override wins;
// otherwise the per-monster toggle decides. Shared by weapon and spell
// resolution so every combat flow applies the same configuration default.
export function resolveMonsterRollMode(mode, monster) {
  if (mode === "active" || mode === "passive") return mode;
  return getMonsterActiveCombatRolls(monster) ? "active" : "passive";
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

// Weapon accuracy is always rollable. This helper treats an absent,
// ambiguous, or inapplicable target as "no comparison" rather than as a
// reason to block the attack roll. Only a single monster can supply Evasion.
export function resolveOptionalMonsterAttackTarget(targetState = {}) {
  const result = resolveAttackTarget(targetState);
  return result.status === "ok" && result.actor?.type === "monster" ? result.actor : null;
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

// Fixed monster statistic: the parenthesized value of the stored string is
// the authoritative fixed value (base + 7 as written at import time); when
// the parenthesized presentation is absent, derive base + 7.
function fixedValue(raw) {
  return staticAccuracy(raw) ?? passiveValue(parseBaseValue(raw) ?? 0);
}

// Monster defense value for a general attack, honouring the per-monster
// toggle (or an explicit `mode` argument).
// Active: a real `2d6 + base` roll; Fixed: the parenthesized value with no
// dice at all.
// A double 1 on the active defense roll is a critical failure for the
// defender (the attacker hits unless the attacker also fumbled).
export async function resolveMonsterDefense(monster, mode, combatStyleId = null) {
  const styles = readMonsterActorCombatStyles(monster);
  if (!styles.length) return null;

  let entry;
  if (combatStyleId) {
    const style = styles.find(s => s.id === combatStyleId);
    if (!style) return null;
    const base = parseBaseValue(style.evasion);
    if (base === null) return null;
    entry = { style, index: styles.indexOf(style), base };
  } else {
    const candidates = styles
      .map((style, index) => ({ style, index, base: parseBaseValue(style?.evasion) }))
      .filter(entry => entry.base !== null);
    if (!candidates.length) return null;
    const mainIndex = getMainCombatStyleIndex(styles);
    entry = mainIndex === null ? null : candidates.find(entry => entry.index === mainIndex);
    if (!entry) entry = candidates[0];
    if (!entry) return null;
  }

  const base = entry.base;

  if (resolveMonsterRollMode(mode, monster) === "passive") {
    return { mode: "passive", base, total: fixedValue(entry.style.evasion), roll: null, natural: null, criticalFailure: false, automaticSuccess: false };
  }
  const roll = await new Roll(assembleRollFormula("2d6", base)).evaluate();
  return {
    mode: "active",
    base,
    total: Number(roll.total),
    roll,
    natural: naturalDiceTotal(roll),
    criticalFailure: isCriticalFailure(roll),
    // Automatic success (natural double 6) on the DEFENSE roll: the passive
    // side wins the opposed check regardless of the attacker's result
    // (Core Rulebook I p.100).
    automaticSuccess: isNaturalDouble(roll, 6)
  };
}

const esc = value => foundry.utils.escapeHTML(String(value ?? ""));

// RAW precedence for the opposed Accuracy vs Evasion check (Core Rulebook I
// p.100): an active (attacker) Automatic Failure loses without comparison; a
// passive (defender) Automatic Failure loses without comparison; a passive
// Automatic Success wins over ANY active result (including an active
// Automatic Success — both automatic means the passive side wins); otherwise
// the attack hits only when the Accuracy total strictly exceeds Evasion.
export function resolveAttackHit({
  attackCriticalFailure = false, attackNatural = 0, attackTotal = 0,
  defenseTotal = 0, defenseCriticalFailure = false, defenseAutomaticSuccess = false
} = {}) {
  if (attackCriticalFailure) return false;
  if (defenseAutomaticSuccess) return false;
  if (defenseCriticalFailure) return true;
  if (Number(attackNatural) === 12) return true; // attacker automatic success
  return Number(attackTotal) > Number(defenseTotal);
}

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
// The attack's automatic critical is the natural double 6 (12) and beats
// Evasion regardless of the totals; the item's Power Table critical
// threshold is a damage-roll rule and is deliberately NOT consulted here.
// A defender Automatic Success (natural double 6 on an active defense roll)
// wins the opposed check: the card then shows MISS even against an attacker
// natural 12, so the CRITICAL badge only appears when the attack really hits.
export function attackCardHtml({
  attackerTitle, attackerName, attackStatLabel, attackOrigin, attackNatural, attackParts, attackTotal, attackCriticalFailure,
  defenderName, defenseStatLabel, defenseOrigin, defenseNatural, defenseParts = [], defenseTotal, defenseCriticalFailure,
  defenseAutomaticSuccess = false,
  attackerCritFailNote, attackerFailureButton = "", defenseFailureButton = "",
  extraHtml = ""
}) {
  const cardId = foundry.utils.randomID?.() ?? globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  if (!defenderName) {
    const detailId = `attack-roll-${cardId}`;
    return `
      <div class="sw25-chat-card sw25-attack-card">
        <h3>${esc(attackerTitle)} — ${esc(attackStatLabel)}</h3>
        <div class="sw25-attack-comparison">
          <div class="sw25-attack-stat sw25-attack-side-accuracy" data-target="${detailId}">
            <div class="sw25-attack-stat-summary" role="button" tabindex="0"><span class="sw25-attack-summary-heading">Accuracy</span><span class="sw25-attack-roll-group"><span class="sw25-attack-roll-label">Roll</span><span class="sw25-attack-roll">${Number(attackNatural) || 0}</span></span><span class="sw25-attack-total-group"><span class="sw25-attack-total-label">Total</span><span class="sw25-attack-total">${signedValue(attackTotal)}</span></span></div>
            <div class="sw25-attack-stat-detail" id="${detailId}" style="display:none;"><ul class="sw25-roll-breakdown">${attackParts.map(part => `<li>${esc(part.label)}: ${esc(signedValue(part.value))}</li>`).join("")}<li><strong>Origin:</strong> ${esc(attackOrigin)}</li></ul></div>
          </div>
        </div>
        ${attackerCritFailNote ? `<p>${esc(attackerCritFailNote)}</p>` : ""}
        ${Boolean(attackCriticalFailure) && attackerFailureButton ? `<div class="sw25-attack-failure-register">${attackerFailureButton}</div>` : ""}
        ${extraHtml}
      </div>`;
  }
  const isFumble = Boolean(attackCriticalFailure);
  const isAttackAutoSuccess = !isFumble && Number(attackNatural) === 12;
  const defenseAuto = Boolean(defenseAutomaticSuccess) && !isFumble;
  const hit = resolveAttackHit({
    attackCriticalFailure: isFumble,
    attackNatural: isFumble ? 0 : attackNatural,
    attackTotal,
    defenseTotal,
    defenseCriticalFailure: Boolean(defenseCriticalFailure),
    defenseAutomaticSuccess: defenseAuto
  });
  const isCritical = isAttackAutoSuccess && hit;

  let outcomeLabel, outcomeClass;
  if (isFumble) { outcomeLabel = "FUMBLE"; outcomeClass = "sw25-attack-fumble"; }
  else if (isCritical) { outcomeLabel = "CRITICAL"; outcomeClass = "sw25-attack-critical"; }
  else if (hit) { outcomeLabel = "HIT"; outcomeClass = "sw25-attack-hit"; }
  else { outcomeLabel = "MISS"; outcomeClass = "sw25-attack-miss"; }

  const accuracyRoll = Number(attackNatural) || 0;
  const evasionRoll = Number(defenseNatural) || 0;
  const accuracyDetailId = `attack-accuracy-${cardId}`;
  const evasionDetailId = `attack-evasion-${cardId}`;

  return `
    <div class="sw25-chat-card sw25-attack-card">
      <h3>${esc(attackerTitle)} — ${esc(attackStatLabel)} on ${esc(defenderName)}</h3>

      <div class="sw25-attack-outcome">
        <span class="sw25-attack-outcome-badge ${outcomeClass}">${outcomeLabel}</span>
      </div>

      <div class="sw25-attack-comparison sw25-attack-compare">
        <div class="sw25-attack-stat sw25-attack-side-accuracy" data-target="${accuracyDetailId}">
          <div class="sw25-attack-stat-summary" role="button" tabindex="0">
            <span class="sw25-attack-summary-heading">Accuracy</span>
            <span class="sw25-attack-roll-group"><span class="sw25-attack-roll-label">Roll</span><span class="sw25-attack-roll">${accuracyRoll}</span></span>
            <span class="sw25-attack-total-group"><span class="sw25-attack-total-label">Total</span><span class="sw25-attack-total">${signedValue(attackTotal)}</span></span>
          </div>
          <div class="sw25-attack-stat-detail" id="${accuracyDetailId}" style="display:none;">
            <ul class="sw25-roll-breakdown">
              ${attackParts.map(p => `<li>${esc(p.label)}: ${esc(signedValue(p.value))}</li>`).join('')}
              <li><strong>Origin:</strong> ${esc(attackOrigin)}</li>
              ${isFumble ? '<li class="sw25-critical-failure"><strong>CRITICAL FAILURE</strong></li>' : ''}
            </ul>
          </div>
        </div>

        <div class="sw25-attack-vs">vs</div>

        <div class="sw25-attack-stat sw25-attack-side-evasion" data-target="${evasionDetailId}">
          <div class="sw25-attack-stat-summary" role="button" tabindex="0">
            ${defenseNatural !== null ? `(${evasionRoll})` : esc(signedValue(defenseTotal))}
          </div>
          <div class="sw25-attack-stat-detail" id="${evasionDetailId}" style="display:none;">
            <ul class="sw25-roll-breakdown">
              ${defenseParts.map(p => `<li>${esc(p.label)}: ${esc(signedValue(p.value))}</li>`).join('')}
              <li><strong>Origin:</strong> ${esc(defenseOrigin)}</li>
              ${defenseCriticalFailure ? '<li class="sw25-critical-failure"><strong>CRITICAL FAILURE</strong></li>' : ''}
              ${defenseAuto ? '<li class="sw25-automatic-success"><strong>AUTOMATIC SUCCESS</strong></li>' : ''}
            </ul>
          </div>
        </div>
      </div>

      ${attackerCritFailNote ? `<p class="sw25-attack-critfail-note">${esc(attackerCritFailNote)}</p>` : ""}
      ${isFumble && attackerFailureButton ? `<div class="sw25-attack-failure-register">${attackerFailureButton}</div>` : ""}
      ${defenseCriticalFailure && defenseFailureButton ? `<div class="sw25-attack-failure-register">${defenseFailureButton}</div>` : ""}
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
 * @param {string}  [flow.resolutionMode] Optional "active"/"passive"
 *                                        override; default is the monster's
 *                                        activeCombatRolls toggle.
 * @param {Function} [flow.promptModifiers] Injectable dialog (tests).
 * @returns {Promise<object>} status + resolution details.
 */
export async function characterWeaponAttackFlow({
  actor, weapon, attackingClass, accuracyParts, targetMonster,
  resolutionMode, promptModifiers = openRollModifiersDialog
} = {}) {
  if (targetMonster && targetMonster.type !== "monster") return { status: "invalid-target" };

  // Multi-section monster: prompt the GM to select which section is being targeted.
  // This determines both the Evasion used for the accuracy contest and the
  // combatStyles row that will receive damage.
  let combatStyleId = null;
  const combatStyles = targetMonster ? readMonsterActorCombatStyles(targetMonster) : [];
  if (combatStyles.length > 1) {
    combatStyleId = await openTargetSelectionDialog({
      title: `Select Section Target — ${targetMonster.name}`,
      submitLabel: "Resolve Attack",
      options: combatStyles.map(cs => ({
        id: cs.id,
        label: cs.section || cs.style || "Section",
        description: `HP: ${numericCombatValue(cs.hp?.value) ?? 0}/${numericCombatValue(cs.hp?.max) ?? 0}, Evasion: ${cs.evasion ?? "—"}`
      })),
      minSelections: 1
    });
    if (!combatStyleId) return { status: "cancelled", phases: { dialog: true, roll: false } };
  }

  const defense = targetMonster ? await resolveMonsterDefense(targetMonster, resolutionMode, combatStyleId) : null;

  const seedParts = [...(accuracyParts ?? []).map(part => ({ ...part, enabled: true, temporary: false }))];

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
  const natural = naturalDiceTotal(roll);
  // Detection only: the double 1 never writes the counter; the card offers
  // the registration button so the player decides.
  const attackerCriticalFailure = isCriticalFailure(roll);
  // Automatic attack critical: natural double 6 beats Evasion regardless of
  // the totals (see attackCardHtml). Detected from the natural dice only.
  const attackAutomaticCritical = isNaturalDouble(roll, 6);

  // RAW precedence: a defender Automatic Success wins over everything; a
  // defender fumble lets the attack through; an attacker automatic success
  // always hits unless the defender also automatic-succeeds.
  const hit = defense ? resolveAttackHit({
    attackCriticalFailure: attackerCriticalFailure,
    attackNatural: natural,
    attackTotal: Number(roll.total),
    defenseTotal: defense.total,
    defenseCriticalFailure: defense.criticalFailure,
    defenseAutomaticSuccess: defense.automaticSuccess
  }) : null;

  const damageButtonHtml = (hit !== false) && !isGunLikeWeapon(weapon) ? `
    <button type="button" class="sw25-attack-damage"
      data-sw25-chat-action="roll-critical-damage"
      data-actor-id="${esc(actor?.id)}"
      data-target-id="${esc(targetMonster?.uuid ?? "")}"
      data-item-id="${esc(weapon?.id)}"
      data-class-id="${esc(attackingClass?.id ?? "")}"
      data-combat-style-id="${combatStyleId ?? ""}"
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
      defenderName: defense ? targetMonster?.name : null,
      defenseStatLabel: "Evasion",
      defenseOrigin: defense ? defense.mode === "passive"
        ? `fixed (${signedValue(defense.total)})`
        : `active roll (2d6 ${signedValue(defense.base)})` : "",
      defenseNatural: defense?.natural ?? null,
      defenseParts: defense ? [{ label: "Base Evasion", value: defense.base }] : [],
      defenseTotal: defense?.total,
      defenseCriticalFailure: Boolean(defense?.criticalFailure),
      defenseAutomaticSuccess: Boolean(defense?.automaticSuccess),
      attackerCritFailNote: attackerCriticalFailure ? "Critical failure: the attack is an automatic miss." : "",
      attackerFailureButton: automaticFailureButton(actor),
      extraHtml: damageButtonHtml
    })
  });

  return {
    status: "resolved",
    hit,
    targetMonster,
    attackTotal: Number(roll.total),
    attackNatural: natural,
    attackAutomaticCritical,
    defenseTotal: defense?.total ?? null,
    defenseMode: defense?.mode ?? null,
    defenseCriticalFailure: Boolean(defense?.criticalFailure),
    defenseAutomaticSuccess: Boolean(defense?.automaticSuccess),
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
 * @param {string} [flow.resolutionMode] Optional "active"/"passive"
 *                                       override; default is the monster's
 *                                       activeCombatRolls toggle.
 * @param {Function} [flow.promptModifiers] Injectable dialog (tests).
 * @returns {Promise<object>} status + resolution details.
 */
export async function monsterWeaponAttackFlow({
  monsterActor, style, targetActor, resolutionMode, promptModifiers = openRollModifiersDialog
} = {}) {
  const attackBase = parseBaseValue(style?.accuracy);
  if (attackBase === null) return { status: "no-attack" };
  if (targetActor?.type !== "character") return { status: "invalid-target" };

  const mode = resolveMonsterRollMode(resolutionMode, monsterActor);
  let attackNatural = null;
  let attackTotal;
  let attackRoll = null;
  let attackCriticalFailure = false;
  if (mode === "passive") {
    // Fixed mode: no dice are invented for the monster's Accuracy.
    attackTotal = fixedValue(style?.accuracy);
  } else {
    attackRoll = await new Roll(assembleRollFormula("2d6", attackBase)).evaluate();
    attackNatural = naturalDiceTotal(attackRoll);
    attackTotal = Number(attackRoll.total);
    attackCriticalFailure = isCriticalFailure(attackRoll);
  }
  // Automatic attack critical on the monster's active roll: natural double 6
  // beats the defender's Evasion regardless of the totals. Fixed-mode
  // attacks roll no dice and therefore cannot score one.
  const attackAutomaticCritical = attackRoll ? isNaturalDouble(attackRoll, 6) : false;

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
  const evasionNatural = naturalDiceTotal(evasionRoll);
  // Detection only: the double 1 never writes the counter; the card offers
  // the registration button so the player decides (character defender).
  const evasionCriticalFailure = isCriticalFailure(evasionRoll);
  const evasionAutomaticSuccess = isNaturalDouble(evasionRoll, 6);

  // RAW precedence: a defender Automatic Success (natural double 6 on the
  // Evasion roll) wins over any Accuracy result; a defender fumble lets the
  // attack through; an attacking natural double 6 always hits unless the
  // defender also automatic-succeeds.
  const hit = resolveAttackHit({
    attackCriticalFailure,
    attackNatural,
    attackTotal,
    defenseTotal: Number(evasionRoll.total),
    defenseCriticalFailure: evasionCriticalFailure,
    defenseAutomaticSuccess: evasionAutomaticSuccess
  });
  const attackOrigin = mode === "passive"
    ? `fixed (${signedValue(attackTotal)})`
    : `active roll (2d6 ${signedValue(attackBase)})`;
  const resolutionNote = mode === "passive"
    ? "Monster Accuracy resolved with its fixed value (base + 7); no dice were rolled."
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
    defenseAutomaticSuccess: evasionAutomaticSuccess,
    attackerCritFailNote: attackCriticalFailure
      ? "Critical failure: the attack is an automatic miss."
      : "",
    // The monster never registers Automatic Failures; the character defender
    // gets the registration button on its own fumble.
    defenseFailureButton: automaticFailureButton(targetActor),
    extraHtml: `<p class="sw25-attack-note">${esc(resolutionNote)}</p>`
  });

  if (attackRoll) {
    // Active attack: publish through the attack roll so the dice are visible.
    await attackRoll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: monsterActor }),
      flavor: cardHtml
    });
  } else {
    // Fixed mode: no attack dice exist; publish the breakdown directly.
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: monsterActor }),
      content: cardHtml
    });
  }

  return {
    status: "resolved",
    hit,
    targetActor,
    attackTotal,
    attackNatural,
    attackRoll,
    attackAutomaticCritical,
    defenseTotal: Number(evasionRoll.total),
    defenseMode: "active",
    defenseCriticalFailure: evasionCriticalFailure,
    defenseAutomaticSuccess: evasionAutomaticSuccess,
    attackCriticalFailure
  };
}
