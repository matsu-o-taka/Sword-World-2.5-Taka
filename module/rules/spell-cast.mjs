// ---------------------------------------------------------------------------
// Centralized spell casting and resolution (Core Rulebook I pp. 159-175).
//
// ONE implementation of casting shared by every sheet and flow. The cast is a
// complete, ordered operation; no step is derived from a later one:
//   1. Validate that the caster can cast the spell and meets its
//      requirements (CR1 pp. 159-160), including the per-spell target
//      conditions (Double Stomp pairs, Regeneration combat targets, the
//      Magic Power roll required by special-damage spells).
//   2. Resolve the targets needed to start the cast.
//   3. Deduct the Mana Points IMMEDIATELY BEFORE the roll. A failed cast
//      never refunds the MP (CR1 p. 159: the cost is paid to attempt the
//      casting).
//   4. Spellcasting check: a plain 2d6 (CR1 p. 159). The roll carries NO
//      modifier; the modifiers enter the Success Value. Optional temporary
//      per-roll modifiers are prompted through the SHARED dialog of
//      rules/roll-modifiers.mjs (never a parallel one) and join the
//      effective Magic Power of the SV.
//   5. Natural result and Spellcasting Value (SV): ordinary SV = natural
//      2d6 + effective Magic Power; natural double 6 = automatic success and
//      +5 SV; natural double 1 = AUTOMATIC FAILURE (the spell fizzles, MP
//      spent). Natural detection uses the shared utilities of
//      rules/critical-failure.mjs and is NEVER derived from a modified total.
//   6. Resistances are resolved INDIVIDUALLY for each target (CR1 p. 168):
//      one shared Spellcasting check, one Willpower or Fortitude check per
//      target according to the spell's structured usesFortitude field. The
//      caster's SV must STRICTLY exceed the target's to take full effect; a
//      tie means the target wins. Resistance TYPES (Can't/None/Optional/
//      Neg/Half/Temporary), their difficulties and their rolls live ONLY
//      here — the effect engine never sees them.
//   7. Spell effects and consequences. Explicitly modeled immediate Instant/X
//      components resolve as part of casting; their transient data never enters
//      an ActiveEffect. The persistent component is created AS A CONSEQUENCE
//      OF THE CAST (never when Apply Damage is pressed) with the AUTHENTIC cast
//      SV (0 for no-check modalities). A resisted target receives neither.
//   8. Damage, when the spell deals it, is resolved through the SHARED Power
//      Table procedure (rules/spell-damage.mjs) and is fully independent of
//      the Spellcasting check: a Power Table fumble is a damage fumble, not
//      a cast failure, and valid cast effects survive it.
//
// Casting modalities are SEPARATE flows, never one merged semantics
// (CR1 pp. 174-175):
//   - Major Action: the full flow above with a Spellcasting check.
//   - Minor Action (⏩): no Spellcasting check, SV 0, castable any number of
//     times per turn, MP per cast. Cast conditions still apply.
//   - Combat Preparation (△): no Spellcasting check, SV 0; spells with the
//     same name can only be cast ONCE per Combat Preparation.
// A ⏩/△ spell may still be cast as a Major Action, which runs the full
// checked flow.
//
// Magic Power is centralized: spellDamageMagicPower (rules/spell-damage.mjs)
// is the single source — casting class level + Intelligence bonus + the
// prepared effect ledger's combat.magicPower. Magic Power (the SV/damage
// modifier) is never confused with Mana Points (the resource).
// ---------------------------------------------------------------------------

import { abilityBonus } from "./weapon-damage.mjs";
import { characterResourceValue, updateCharacterResourceValue } from "./resources.mjs";
import { sw25EffectModifier } from "../effects/effective-values.mjs";
import {
  isDoubleStomp,
  isNaturalPower,
  rollDoubleStompDamage,
  rollNaturalPower,
  rollSpecialSpellDamage,
  specialDamageBands,
  spellDamageMagicPower,
  trackNaturalPowerSpending
} from "./spell-damage.mjs";
import {
  getInstantXSpellData,
  getInstantXSpellIdentity,
  getSpellDuration,
  isExhaustiveSucking,
  isInstantXSpell,
  parseSw25SpellDamageAttribute,
  regenerationSpellData,
  requestRegenerationSpell,
  resolveExhaustiveSucking,
  resolveSw25CasterAnchor
} from "./spell-effects.mjs";
import { requestSw25EffectOperation } from "../effects/effect-relay.mjs";
import {
  collectCancellationCandidates,
  collectCancellationRemovalGroup,
  effectRecordedSuccessValue,
  isDispelMagicSpell,
  isSharedSpaceEffect,
  resolveCancellationAttempt
} from "../effects/effect-cancellation.mjs";
import { SW25_EFFECT_SCOPES } from "../effects/effect-model.mjs";
import { canonicalSpellName, getSpellResistance, spellDamageNature as spellDataNature } from "./spell-data.mjs";
import {
  automaticFailureButton,
  criticalFailureHTML,
  isCriticalFailure,
  isNaturalDouble,
  naturalDiceTotal
} from "./critical-failure.mjs";
import { enabledModifiersTotal, normalizeModifier, signedValue } from "./roll-modifiers.mjs";
import { resolveMonsterRollMode } from "../combat/attack-resolution.mjs";

const FLAG_SCOPE = "sw25-taka";

const escape = value => foundry.utils.escapeHTML(String(value ?? "")).replace(/\n/g, "<br>");

const warn = message => { if (typeof ui?.notifications?.warn === "function") ui.notifications.warn(message); };

// ── Resistance field (CR1 pp. 167-169, magic data field ⑦) ─────────────────

// Approved Resistance ids. `temporary` has NO implemented mechanical rule:
// its RAW treatment is pending specification, so it never invents one (no
// roll, no automatic effect creation — the card asks the GM to decide).
export const RESISTANCE_LABELS = {
  cant: "Can't",
  optional: "Optional",
  none: "None",
  neg: "Neg",
  half: "Half",
  temporary: "Temporary"
};

// The resistance ID lives in the structured `system.resistance` field
// (vocabulary + parsing in rules/spell-data.mjs). Re-exported so the
// existing consumers keep importing it from here.
export { getSpellResistance } from "./spell-data.mjs";

/**
 * Human label for a spell's Resistance, for chat cards. When the spell has
 * no recognized structured resistance, the raw metadata text is shown
 * verbatim (metadata is retained as reference/presentation data; rule
 * logic never reads it) — never silently renamed.
 * @param {object} spell - Spell Item document.
 * @returns {string}
 */
export function spellResistanceLabel(spell) {
  const id = getSpellResistance(spell);
  if (id) return RESISTANCE_LABELS[id];
  const match = String(spell?.system?.metadata || "").match(/^resistance:\s*(.+)$/im);
  return match ? match[1].trim() : "—";
}

// ── Casting modality (CR1 pp. 174-175) ──────────────────────────────────────
//
// Modality capability lives in the structured boolean fields
// `system.minorAction` (⏩) and `system.combatPreparation` (△), populated by
// the importer from the authored name markers. The markers stay in the
// spell names (DEC-1); the RULES read the booleans, never the names.

/** Whether the spell can be cast with a Minor Action (⏩). */
export function isMinorActionSpell(spell) {
  return spell?.system?.minorAction === true;
}

/** Whether the spell can be cast during Combat Preparation (△). */
export function isCombatPreparationSpell(spell) {
  return spell?.system?.combatPreparation === true;
}

/** Whether the current world is in Combat Preparation phase (combat created but not started). */
export function isInCombatPreparationPhase() {
  const combat = game?.combat;
  return !!(combat && !combat.started);
}

/** Whether the strict Combat Preparation rules are enforced by the GM setting. */
export function isStrictCombatPreparationEnabled() {
  return game?.settings?.get("sw25-taka", "enforceStrictCombatPreparationRules") ?? false;
}

// ── Spellcasting check and Success Value (CR1 pp. 159/167-168) ─────────────

/**
 * Pure Success Value computation. The natural result, the effective Magic
 * Power and the final SV are preserved SEPARATELY; the automatic-success
// bonus is a declared input (detected from the natural dice by the caller),
 * never re-derived here from a modified total.
 * @param {{natural: number, magicPower: number, automaticSuccess?: boolean}} parts
 * @returns {{natural: number, magicPower: number, automaticSuccess: boolean, successValue: number}}
 */
export function computeSpellcastingValue({ natural, magicPower, automaticSuccess = false } = {}) {
  const naturalValue = Math.max(0, Number(natural) || 0);
  const power = Math.max(0, Number(magicPower) || 0);
  const success = naturalValue + power + (automaticSuccess === true ? 5 : 0);
  return { natural: naturalValue, magicPower: power, automaticSuccess: automaticSuccess === true, successValue: success };
}

/**
 * Roll the Spellcasting check and compute the cast's Success Value ONCE.
 * The roll is a plain 2d6: modifiers enter the SV, never the dice. The
 * returned context is the single authoritative SV source for the whole
 * resolution — resistances, persistent effects and the damage transport all
 * read it; nothing recomputes or re-derives it later.
 *
 * Natural double 1 = automatic failure (isCriticalFailure, shared natural
 * detection). Natural double 6 = automatic success and +5 SV. Both are
 * detected from the natural dice only.
 *
 * @param {Actor} actor - Casting actor.
 * @param {Item} castingClass - The casting class Item.
 * @param {number|null} [magicPower=null] - Effective Magic Power override.
 *   Null (the default) uses the PERMANENT composition
 *   (spellDamageMagicPower). When the SHARED temporary-modifier dialog ran,
 *   its enabled total IS the effective Magic Power: the dialog already
 *   contains the permanent parts, so they are never added twice.
 * @returns {Promise<{roll: Roll, natural: number, automaticFailure: boolean,
 *   automaticSuccess: boolean, magicPower: number, successValue: number}>}
 */
export async function rollSpellcastingCheck({ actor, castingClass, magicPower = null } = {}) {
  const roll = await new Roll("2d6").evaluate();
  const automaticFailure = isCriticalFailure(roll);
  const automaticSuccess = !automaticFailure && isNaturalDouble(roll, 6);
  // Without a dialog override the PERMANENT composition is the authority;
  // with one, the dialog's enabled total IS the effective Magic Power (the
  // permanent parts were already seeded into it — never added twice).
  const effectiveMagicPower = magicPower === null || magicPower === undefined
    ? spellDamageMagicPower(actor, castingClass)
    : Number(magicPower) || 0;
  const natural = naturalDiceTotal(roll);
  // On automatic failure the SV is meaningless (the spell fizzles); it is
  // reported as 0 and never used for resolution.
  const value = automaticFailure
    ? 0
    : computeSpellcastingValue({ natural, magicPower: effectiveMagicPower, automaticSuccess }).successValue;
  return { roll, natural, automaticFailure, automaticSuccess, magicPower: effectiveMagicPower, successValue: value };
}

/**
 * Permanent Magic Power parts of a caster, seeded into the SHARED temporary
 * modifier dialog (rules/roll-modifiers.mjs). The Spellcasting check is a
 * plain 2d6 (CR1 p. 159): every modifier — permanent or temporary — enters
 * the Success Value through the effective Magic Power, never the dice.
 * The composition mirrors spellDamageMagicPower (rules/spell-damage.mjs):
 * casting class level + Intelligence bonus + the prepared effect ledger's
 * combat.magicPower entry.
 * @param {Actor} actor - Casting actor.
 * @param {Item} castingClass - The casting class Item.
 * @returns {Array<{label: string, value: number, enabled: boolean, temporary: boolean}>}
 */
export function spellcastingMagicPowerParts(actor, castingClass) {
  const effects = sw25EffectModifier(actor, "combat.magicPower");
  return [
    { label: `${castingClass?.name ?? "Class"} level`, value: Number(castingClass?.system?.level ?? 0), enabled: true, temporary: false },
    { label: "Intelligence bonus", value: abilityBonus(actor?.system, "intelligence"), enabled: true, temporary: false },
    { label: "Effects", value: Number(effects) || 0, enabled: Number(effects) !== 0, temporary: false }
  ];
}

// Ordinary opposed comparison (CR1 p. 168): the caster's SV must STRICTLY
// exceed the target's; a tie means the target resists.
export function casterValueExceeds(casterSuccessValue, targetSuccessValue) {
  return Number(casterSuccessValue) > Number(targetSuccessValue);
}

// ── Target resistance values ───────────────────────────────────────────────

/**
 * Effective Willpower of a character target: highest class level (the sheet's
 * Adventurer Level basis) + Spirit bonus + the prepared effect ledger's
 * resistance.willpower entry. Mirrors the sheet's calculation
 * (willpowerBase + ledger) so sheets and resistance flow never differ.
 * @param {Actor} actor - Character actor.
 * @returns {number}
 */
export function characterWillpower(actor) {
  const level = [...(actor?.items || [])]
    .filter(item => item.type === "class")
    .reduce((highest, item) => Math.max(highest, Number(item.system?.level ?? 0)), 0);
  return level + abilityBonus(actor?.system, "spirit") + sw25EffectModifier(actor, "resistance.willpower");
}

/**
 * Effective Fortitude of a character target: highest class level + Vitality
 * bonus + the prepared effect ledger's resistance.fortitude entry. This
 * mirrors the sheet calculation exactly, as characterWillpower does for
 * Spirit and Willpower.
 * @param {Actor} actor - Character actor.
 * @returns {number}
 */
export function characterFortitude(actor) {
  const level = [...(actor?.items || [])]
    .filter(item => item.type === "class")
    .reduce((highest, item) => Math.max(highest, Number(item.system?.level ?? 0)), 0);
  return level + abilityBonus(actor?.system, "vitality") + sw25EffectModifier(actor, "resistance.fortitude");
}

/**
 * Parse a monster resistance stat in the X(Y) notation ("3 (10)"):
 * X = the active check modifier (2d6 + X), Y = the passive difficulty.
 * A bare number without parentheses carries only the active modifier.
 * @param {*} value - Raw stat string.
 * @returns {{active: number, passive: number|null}|null}
 */
export function parseMonsterResistance(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const paired = raw.match(/^(-?\d+)\s*\(\s*(-?\d+)\s*\)$/);
  if (paired) return { active: Number(paired[1]), passive: Number(paired[2]) };
  const bare = raw.match(/^(-?\d+)$/);
  return bare ? { active: Number(bare[1]), passive: null } : null;
}

// ── Resistance resolution (pure core) ──────────────────────────────────────

/**
 * Resolve ONE target's resistance. This is the ONLY place where resistance
 * types, difficulties and rolls are interpreted; the effect engine only ever
 * receives the resulting `resisted` boolean.
 *
 * Inputs per type (CR1 pp. 167-169):
 *   - cant / none / unknown: no resistance roll exists; never resisted.
 *   - temporary: pending RAW specification — no roll is invented; the outcome
 *     is `pending` and blocks automatic effect creation (the GM decides).
 *   - optional: `decision` is the target's will to resist; a resisting
 *     target AUTOMATICALLY succeeds (the spell does not affect them).
 *   - neg / half: the caster's SV is compared with the target's resistance:
 *     * character: `roll` is the target's Willpower or Fortitude check
 *       (2d6 + the characteristic selected by the spell);
 *       natural double 1 is the resistance's automatic failure (the spell
 *       takes effect), natural double 6 its automatic success (resisted).
 *     * monster passive: `passiveDifficulty` is Y; the caster's SV must
 *       strictly exceed it.
 *     * monster active: `roll` is the monster's 2d6 + X with the same
 *       automatic results as a character's check.
 *   - half: a resisted target takes half damage (rounded up) and its extra
 *     effects are nullified (CR1 p. 170); the flags travel on the outcome.
 *
 * @param {object} input
 * @param {string|null} input.type - Approved resistance id (or null).
 * @param {number} [input.successValue] - The caster's SV (shared for all
 *   targets of one cast).
 * @param {Roll|{dice:Array,total:number}|null} [input.roll] - Target's
 *   resistance roll (neg/half, active mode).
 * @param {number|null} [input.passiveDifficulty] - Monster passive Y.
 * @param {boolean|null} [input.decision] - Optional resistance decision
 *   (true = the target wants to resist).
 * @returns {{type: string|null, resisted: boolean, pending: boolean,
 *   automaticFailure: boolean, automaticSuccess: boolean, targetTotal: number|null,
 *   passiveDifficulty: number|null, halfDamage: boolean, effectsNullified: boolean,
 *   resistedReason: string}}
 */
export function resolveTargetResistance({ type, successValue = 0, roll = null, passiveDifficulty = null, decision = null } = {}) {
  const outcome = {
    type: type ?? null,
    resisted: false,
    pending: false,
    automaticFailure: false,
    automaticSuccess: false,
    targetTotal: null,
    passiveDifficulty: null,
    halfDamage: false,
    effectsNullified: false,
    resistedReason: ""
  };
  if (type === "optional") {
    // The target's will alone decides: resisting targets automatically
    // succeed (CR1 p. 168).
    outcome.resisted = decision === true;
    outcome.resistedReason = outcome.resisted ? "The target rejected the spell (automatic resistance success)." : "The target accepted the spell.";
    return outcome;
  }
  if (type === "temporary") {
    outcome.pending = true;
    outcome.resistedReason = "Resistance: Temporary — its RAW treatment is pending specification; no roll was made.";
    return outcome;
  }
  if (type !== "neg" && type !== "half") {
    // cant / none / unrecognized: no resistance roll exists.
    outcome.resistedReason = type === "none"
      ? "The spell is applied to an object or a point in space; it cannot be resisted."
      : "The spell cannot be resisted.";
    return outcome;
  }
  // neg / half: Success Value comparison against the target's resistance.
  if (passiveDifficulty !== null && passiveDifficulty !== undefined) {
    const difficulty = Number(passiveDifficulty);
    outcome.passiveDifficulty = difficulty;
    outcome.resisted = !casterValueExceeds(successValue, difficulty);
    outcome.resistedReason = outcome.resisted
      ? `Passive difficulty ${difficulty} is not exceeded by SV ${successValue}.`
      : `SV ${successValue} exceeds the passive difficulty ${difficulty}.`;
    return finalizeHalf(outcome, type);
  }
  if (!roll) {
    outcome.resistedReason = "No resistance roll was provided; the target resists.";
    outcome.resisted = true;
    return finalizeHalf(outcome, type);
  }
  const automaticFailure = isCriticalFailure(roll);
  const automaticSuccess = !automaticFailure && isNaturalDouble(roll, 6);
  // The resistance total is the roll's FULL total (natural dice + the
  // character's Willpower/Fortitude or the monster's X modifier); the natural dice
  // alone are read only for the automatic results.
  const targetTotal = Number.isFinite(Number(roll?.total)) ? Number(roll.total) : naturalDiceTotal(roll);
  outcome.automaticFailure = automaticFailure;
  outcome.automaticSuccess = automaticSuccess;
  outcome.targetTotal = targetTotal;
  if (automaticFailure) {
    outcome.resisted = false;
    outcome.resistedReason = "The resistance roll is an automatic failure (natural double 1); the spell takes effect.";
    return finalizeHalf(outcome, type);
  }
  if (automaticSuccess) {
    outcome.resisted = true;
    outcome.resistedReason = "The resistance roll is an automatic success (natural double 6); the spell does not take effect.";
    return finalizeHalf(outcome, type);
  }
  outcome.resisted = !casterValueExceeds(successValue, targetTotal);
  outcome.resistedReason = outcome.resisted
    ? `Resistance total ${targetTotal} is not exceeded by SV ${successValue} (ties resist).`
    : `SV ${successValue} exceeds the resistance total ${targetTotal}.`;
  return finalizeHalf(outcome, type);
}

// Half-specific consequences of a resisted outcome (CR1 p. 170): the damage
// is halved (rounded up at application) and every additional effect is
// nullified. Non-Half spells never carry the flags.
function finalizeHalf(outcome, type) {
  if (type === "half" && outcome.resisted) {
    outcome.halfDamage = true;
    outcome.effectsNullified = true;
  }
  return outcome;
}

// ── Target collection and dialogs ──────────────────────────────────────────

function castTargetsFromTokens() {
  return [...(game?.user?.targets ?? [])].map(token => token.actor).filter(Boolean);
}

// Default Optional dialog (foundry.applications.api.DialogV2): each target
// decides independently, AFTER the Spellcasting check and BEFORE the spell's
// consequences. Closing the dialog is a non-blocking answer: the cast is
// never stalled, and an absent decision means the target accepts (CR1
// p. 168 leaves the will to the target; a silent target is treated as
// accepting rather than as an invented refusal).
async function defaultAskOptional(target, spell) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.wait !== "function") return false;
  const answer = await DialogV2.wait({
    window: { title: `${target.name} — Resistance: Optional` },
    modal: true,
    content: `<p>Does <strong>${escape(target.name)}</strong> accept the effect of <strong>${escape(spell.name)}</strong>?</p><p class="notes">Accepting applies the spell. Rejecting means the target resists and automatically succeeds.</p>`,
    buttons: [
      { action: "accept", label: "Accept (affected)", default: true },
      { action: "reject", label: "Reject (resist)" }
    ]
  });
  return answer === "reject";
}

const DEFAULT_DIALOGS = {
  askOptional: defaultAskOptional
};

/**
 * Resolve the resistance of EVERY target of one cast. The caster's
 * Spellcasting check is shared; each target is resolved individually and the
 * results are independent (CR1 p. 168).
 * @param {object} input
 * @param {Actor} input.caster - Casting actor.
 * @param {object} input.spell - Spell Item document.
 * @param {string|null} input.resistanceType - Approved resistance id.
 * @param {number} input.successValue - The cast's SV.
 * @param {Actor[]} input.targets - Resolved target actors.
 * @param {object} [input.dialogs] - Optional-resistance dialog overrides (tests).
 *   Monster defense needs no dialog: each monster's activeCombatRolls
 *   configuration is resolved through the shared combat mode resolver.
 * @returns {Promise<Array<{target: Actor, type: string|null, resisted: boolean,
 *   pending: boolean, automaticFailure: boolean, automaticSuccess: boolean,
 *   targetTotal: number|null, halfDamage: boolean, effectsNullified: boolean,
 *   summary: string}>>}
 */
export async function resolveCastTargets({ caster, spell, resistanceType, successValue, targets, dialogs = {} } = {}) {
  const askOptional = dialogs.askOptional || DEFAULT_DIALOGS.askOptional;
  // The structured spell field is the sole source of truth: false or absent
  // preserves the established Willpower default; true selects Fortitude.
  const defenseKey = spell?.system?.usesFortitude === true ? "fortitude" : "willpower";
  const defenseCharacteristic = defenseKey === "fortitude" ? "Fortitude" : "Willpower";
  const results = [];
  for (const target of targets) {
    if (!target) continue;
    if (resistanceType === "optional") {
      const wantsResist = await askOptional(target, spell);
      const outcome = resolveTargetResistance({ type: resistanceType, decision: wantsResist });
      results.push({ target, ...outcome, summary: optionalSummary(target, outcome) });
      continue;
    }
    if (resistanceType !== "neg" && resistanceType !== "half") {
      const outcome = resolveTargetResistance({ type: resistanceType, successValue });
      results.push({ target, ...outcome, summary: plainSummary(target, outcome, resistanceType) });
      continue;
    }
    // neg / half: the target's own resistance. Each monster uses its own
    // activeCombatRolls configuration through the SAME resolver as combat.
    // A missing configuration follows combat's established passive default.
    if (target.type === "monster") {
      const mode = resolveMonsterRollMode(undefined, target);
      const parsed = parseMonsterResistance(target.system?.[defenseKey]);
      if (mode === "passive" && parsed?.passive !== null && parsed?.passive !== undefined) {
        const outcome = resolveTargetResistance({ type: resistanceType, successValue, passiveDifficulty: parsed.passive });
        results.push({ target, mode, ...outcome, summary: passiveMonsterSummary(target, outcome, resistanceType, defenseCharacteristic) });
        continue;
      }
      // Existing resistance-data fallback: when no passive Y is available,
      // the active X roll remains the only usable resistance resolution.
      const modifier = parsed?.active ?? 0;
      const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
      const outcome = resolveTargetResistance({ type: resistanceType, successValue, roll });
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: target }),
        flavor: `${escape(target.name)} — ${defenseCharacteristic} (active resistance, 2d6 + ${modifier})`
      });
      results.push({ target, mode: "active", ...outcome, summary: activeSummary(target, outcome, resistanceType, defenseCharacteristic) });
      continue;
    }
    const modifier = defenseKey === "fortitude" ? characterFortitude(target) : characterWillpower(target);
    const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
    const outcome = resolveTargetResistance({ type: resistanceType, successValue, roll });
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: target }),
      flavor: `${escape(target.name)} — ${defenseCharacteristic} (resistance, 2d6 + ${modifier})`
    });
    results.push({ target, mode: "active", ...outcome, summary: activeSummary(target, outcome, resistanceType, defenseCharacteristic) });
  }
  return results;
}

// Concise, target-specific presentation of the ALREADY RESOLVED outcome.
// Active defense displays its actual roll total; passive defense displays
// the fixed difficulty used. The characteristic is supplied by the branch
// that performed the resolution, never inferred from the spell's metadata.
function targetResolutionSummary(target, outcome, resistanceType, defenseCharacteristic = null) {
  if (outcome.pending) {
    return `<strong>${escape(target.name)}:</strong> resistance pending (GM decides).`;
  }
  const defenseValue = outcome.passiveDifficulty ?? outcome.targetTotal;
  const defense = defenseCharacteristic && defenseValue !== null && defenseValue !== undefined
    ? ` (${escape(defenseCharacteristic)} ${escape(defenseValue)})`
    : "";
  const result = outcome.resisted ? "resisted" : "affected";
  const consequences = [];
  if (outcome.halfDamage) {
    consequences.push("The target takes half damage.");
  } else if (!outcome.resisted && resistanceType === "half") {
    consequences.push("The target takes full damage.");
  } else if (outcome.resisted) {
    consequences.push("The spell has no effect.");
  }
  if (outcome.effectsNullified) consequences.push("Additional effects are nullified.");
  if (outcome.automaticSuccess) consequences.push("The resistance was an automatic success (natural double 6).");
  if (outcome.automaticFailure) consequences.push("The resistance was an automatic failure (natural double 1).");
  return `<strong>${escape(target.name)}${defense} ${result}!</strong>${consequences.length ? ` ${consequences.join(" ")}` : ""}`;
}

function optionalSummary(target, outcome) {
  return targetResolutionSummary(target, outcome, "optional");
}

function plainSummary(target, outcome, resistanceType) {
  return targetResolutionSummary(target, outcome, resistanceType);
}

function passiveMonsterSummary(target, outcome, resistanceType, defenseCharacteristic) {
  return targetResolutionSummary(target, outcome, resistanceType, defenseCharacteristic);
}

function activeSummary(target, outcome, resistanceType, defenseCharacteristic) {
  return targetResolutionSummary(target, outcome, resistanceType, defenseCharacteristic);
}

// ── Dispel Magic forced removal (T6.1/T6.2, DEC-7) ─────────────────────────
//
// Dispel Magic's printed target is "1 spell", not a creature: the normal
// target-resistance phase does NOT run (the user-approved reading of the
// printed `Resistance: Neg` — the only opposed check is the Success Value
// comparison of CR I pp. 166-167). The selected tokens identify the effect
// OWNERS; the cast can remove exactly ONE effect in total (CR I p. 167:
// "only one magic or effect can be removed").
//
// T6.1 corrections:
//   - The targeted effect is DECLARED BEFORE the Spellcasting check (CR I
//     p. 167: "The removing side must declare in advance which effect they
//     want to remove"), so the chooser never runs with the attempt's SV
//     already known.
//   - Passive Success Values are NEVER shown before the attempt, and
//     `system.gmOnly` effects are invisible to non-GM users throughout the
//     whole flow (selection AND result card).
//   - The declaration transports only `{actorUuid, effectId}`; the effect is
//     re-validated against the CURRENT documents when the result is
//     processed, so a stale or forged selection removes nothing.

function cancellationEffectName(effect) {
  return effect?.name ?? effect?.system?.family ?? "Effect";
}

/** The declaration of one effect: an opaque reference, never the document. */
function cancellationSelection(candidate) {
  return { actorUuid: candidate?.target?.uuid ?? null, effectId: candidate?.effect?.id ?? null };
}

/**
 * The eligible and ineligible system effects of the selected owners.
 * `gmOnly` effects are filtered out for non-GM users BEFORE any reporting, so
 * neither the declaration list nor the result card can reveal them.
 */
function collectDispelCandidates(owners) {
  const includeGmOnly = game?.user?.isGM === true;
  const eligible = [];
  const ineligible = [];
  const emptyOwners = [];
  for (const target of owners) {
    const candidates = collectCancellationCandidates(target, "dispel", undefined, { includeGmOnly });
    if (!candidates.length) {
      emptyOwners.push(target);
      continue;
    }
    for (const candidate of candidates) {
      const entry = { target, effect: candidate.effect, eligibility: candidate.eligibility };
      if (candidate.eligibility.eligible) eligible.push(entry);
      else ineligible.push(entry);
    }
  }
  return { eligible, ineligible, emptyOwners };
}

/**
 * Default declaration dialog. It runs BEFORE the roll and lists only effect
 * names and owners — never a Success Value. Cancelling the dialog aborts the
 * cast before the MP cost; "Do not remove any" casts without a declaration.
 */
async function defaultDeclareCancellationEffect({ candidates }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.wait !== "function") return { selection: null };
  const buttons = candidates.map((candidate, index) => ({
    action: `effect-${index}`,
    label: `${escape(candidate.target?.name ?? "Target")}: ${escape(cancellationEffectName(candidate.effect))}`
  }));
  buttons.push({ action: "none", label: "Do not remove any" });
  const answer = await DialogV2.wait({
    window: { title: "Dispel Magic" },
    modal: true,
    content: "<p>Declare the one effect targeted by <strong>Dispel Magic</strong> BEFORE the Spellcasting check (CR I p. 167). The effects' Success Values are not shown.</p>",
    buttons
  });
  if (answer === "none") return { selection: null };
  const index = typeof answer === "string" && answer.startsWith("effect-")
    ? Number.parseInt(answer.slice("effect-".length), 10)
    : -1;
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length) return { cancelled: true };
  return { selection: cancellationSelection(candidates[index]) };
}

/**
 * Declare the single effect a Dispel Magic cast targets, BEFORE the check.
 * @param {object} input
 * @param {Actor[]} input.targets - Effect owners.
 * @param {object} [input.dialogs] - `declareEffect({ candidates })` override
 *   returning `{selection: {actorUuid, effectId}|null}` or `{cancelled:true}`.
 * @returns {Promise<{cancelled: boolean, selection: object|null}>}
 */
export async function declareDispelCancellation({ targets, dialogs = {} } = {}) {
  const owners = (targets ?? []).filter(Boolean);
  const { eligible } = collectDispelCandidates(owners);
  if (!eligible.length) return { cancelled: false, selection: null };
  const declareEffect = dialogs.declareEffect || defaultDeclareCancellationEffect;
  const answer = await declareEffect({ candidates: eligible });
  if (answer?.cancelled === true) return { cancelled: true, selection: null };
  const selection = answer?.selection ?? null;
  if (!selection || typeof selection.actorUuid !== "string" || typeof selection.effectId !== "string") {
    return { cancelled: false, selection: null };
  }
  return { cancelled: false, selection };
}

/**
 * Fallback of CR I p. 167 when the effect's original Success Value was not
 * recorded: the value is determined AGAIN at cancellation time. The GM enters
 * the re-determined value; an empty/invalid answer removes nothing (the value
 * is never silently replaced by 0).
 */
async function defaultRecoverCancellationSuccessValue({ target, effect }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.wait !== "function") return null;
  return DialogV2.wait({
    window: { title: "Dispel Magic — Success Value not recorded" },
    modal: true,
    content: `<p>The original Success Value of <strong>${escape(cancellationEffectName(effect))}</strong> (${escape(target?.name ?? "Target")}) was not recorded. Determine it again now (CR I p. 167) and enter the result. Without a value, nothing is removed.</p><p><label>Re-determined Success Value <input type="number" name="successValue" min="0" step="1" value="0"></label></p>`,
    buttons: [
      {
        action: "submit",
        label: "Use this Success Value",
        callback: (_event, button) => {
          const value = Number(button?.form?.elements?.successValue?.value);
          return Number.isInteger(value) && value >= 0 ? value : null;
        }
      },
      { action: "none", label: "Do not remove", callback: () => null }
    ]
  });
}

function cancellationStatusLine(target, effectName, text, { cancelled = false, pending = false, ineligible = true } = {}) {
  const statusClass = pending
    ? "sw25-resistance-pending"
    : cancelled
      ? "sw25-resistance-affected"
      : "sw25-resistance-resisted";
  return {
    target,
    cancellation: true,
    cancellationEligible: !ineligible,
    countsForOutcome: false,
    selected: false,
    cancelled,
    resisted: false,
    pending: false,
    automaticFailure: false,
    automaticSuccess: false,
    halfDamage: false,
    effectsNullified: false,
    summary: `<strong>${escape(target?.name ?? "Target")}:</strong> ${escape(effectName)} — ${text}`,
    statusClass
  };
}

/**
 * Remove the representations of the declared effect through the
 * GM-authoritative EffectService path. A `/Space` casting removes every
 * representation of the same `castId`; anything else removes exactly one.
 */
async function removeCancellationMembers(members) {
  const removed = [];
  const failures = [];
  for (const member of members) {
    const removal = await requestSw25EffectOperation("remove", { actorUuid: member.target.uuid, effectId: member.effect.id });
    if (removal?.ok === true) removed.push(member);
    else failures.push({ member, removal });
  }
  return { removed, failures };
}

/** Owners scanned for a `/Space` casting: every Actor, not only the targets. */
function cancellationRemovalOwners(owners, shared) {
  if (!shared) return owners;
  const worldActors = [...(game?.actors ?? [])];
  return worldActors.length ? worldActors : owners;
}

/**
 * Resolve a Dispel Magic cast against the DECLARED effect of the selected
 * effect owners. Ineligible effects are reported and NEVER compared; the
 * declaration is re-validated against the current documents, the stored SV is
 * compared strictly (re-determined first when it was never recorded), and
 * only a beaten effect is removed through the GM-authoritative EffectService
 * `remove` operation.
 *
 * @param {object} input
 * @param {Actor[]} input.targets - Effect owners (selected tokens).
 * @param {number} input.successValue - The cast's Success Value.
 * @param {boolean} [input.automaticSuccess=false] - Natural double 6.
 * @param {{actorUuid: string, effectId: string}|null} [input.declared] - The
 *   effect declared BEFORE the roll; null removes nothing.
 * @param {object} [input.dialogs] - `recoverSuccessValue({target, effect})`
 *   override for the unrecorded-SV fallback (CR I p. 167).
 * @returns {Promise<Array<object>>} Presentation results for the cast card.
 */
export async function resolveDispelCancellation({ targets, successValue, automaticSuccess = false, declared = null, dialogs = {} } = {}) {
  const results = [];
  const owners = (targets ?? []).filter(Boolean);
  if (!owners.length) {
    results.push({
      target: null,
      cancellation: true,
      cancellationEligible: false,
      countsForOutcome: false,
      selected: false,
      cancelled: false,
      resisted: false,
      pending: false,
      automaticFailure: false,
      automaticSuccess: false,
      halfDamage: false,
      effectsNullified: false,
      statusClass: "sw25-resistance-pending",
      summary: "<strong>Dispel Magic:</strong> no effect owner was targeted; no effect was removed. Select the token carrying the effect."
    });
    return results;
  }

  // Eligibility first: ineligible effects are reported and never compared.
  const { eligible, ineligible, emptyOwners } = collectDispelCandidates(owners);
  for (const target of emptyOwners) {
    results.push(cancellationStatusLine(target, "No effects", "there is no system effect to target.", { pending: true }));
  }
  for (const candidate of ineligible) {
    results.push(cancellationStatusLine(
      candidate.target,
      cancellationEffectName(candidate.effect),
      `cannot be removed (${escape(candidate.eligibility.reasons.join(" "))}).`,
      { pending: true }
    ));
  }
  const reportUntargeted = except => {
    for (const candidate of eligible.filter(entry => entry !== except)) {
      results.push(cancellationStatusLine(candidate.target, cancellationEffectName(candidate.effect), "was not targeted and remains in place.", { pending: true, ineligible: false }));
    }
  };
  if (!eligible.length) return results;

  // CR I p. 167: "only one magic or effect can be removed", and the effect is
  // declared in advance. Without a declaration nothing is compared.
  if (!declared) {
    reportUntargeted(null);
    return results;
  }

  // Re-validate the declaration against the CURRENT documents: an unknown,
  // stale, hidden or ineligible reference is rejected, never trusted.
  const chosen = eligible.find(candidate =>
    candidate.target?.uuid === declared.actorUuid && candidate.effect?.id === declared.effectId);
  if (!chosen) {
    const owner = owners.find(target => target?.uuid === declared.actorUuid) ?? null;
    results.push(cancellationStatusLine(
      owner,
      "Declared effect",
      "the declared effect is no longer a valid target of this cast (it was removed, is not eligible, or is not visible to you). Nothing was removed.",
      { pending: true }
    ));
    reportUntargeted(null);
    return results;
  }

  // CR I p. 167 fallback: an unrecorded original SV is determined again at
  // cancellation time. It is never silently replaced by 0.
  let reDetermined = null;
  if (automaticSuccess !== true && effectRecordedSuccessValue(chosen.effect.system) === null) {
    const recover = dialogs.recoverSuccessValue || defaultRecoverCancellationSuccessValue;
    reDetermined = await recover({ target: chosen.target, effect: chosen.effect, mechanism: "dispel" });
    if (!Number.isInteger(reDetermined) || reDetermined < 0) {
      results.push(cancellationStatusLine(
        chosen.target,
        cancellationEffectName(chosen.effect),
        "its original Success Value is not recorded and no re-determined value was provided (CR I p. 167). It was NOT treated as 0; nothing was removed.",
        { pending: true, ineligible: false }
      ));
      reportUntargeted(chosen);
      return results;
    }
  }

  const attempt = resolveCancellationAttempt({
    mechanism: "dispel",
    attemptSuccessValue: successValue,
    system: chosen.effect.system,
    automaticSuccess,
    effectSuccessValue: reDetermined ?? undefined
  });
  let cancelled = false;
  let removalNote = "";
  if (attempt.cancelled) {
    const shared = isSharedSpaceEffect(chosen.effect.system);
    const group = collectCancellationRemovalGroup(chosen, cancellationRemovalOwners(owners, shared));
    const { removed, failures } = await removeCancellationMembers(group.members);
    cancelled = failures.length === 0 && removed.length > 0;
    if (failures.length) {
      removalNote = group.members.length === 1
        ? ` The removal failed (${escape(failures[0].removal?.code ?? failures[0].removal?.error ?? "unknown error")}).`
        : ` The removal failed (${failures.map(failure => `${escape(failure.member.target?.name ?? "Target")}: ${escape(failure.removal?.code ?? failure.removal?.error ?? "unknown error")}`).join("; ")}).`;
    }
    if (group.incomplete) {
      removalNote += " Only the declared representation could be identified: the casting has no recorded castId, so the other /Space representations were NOT removed.";
    } else if (shared && removed.length > 1) {
      removalNote += ` The /Space spell is one effect for the whole area: its ${removed.length} representations were removed (CR I p. 167).`;
    }
  }
  results.push({
    ...cancellationStatusLine(
      chosen.target,
      cancellationEffectName(chosen.effect),
      `${escape(attempt.reason)}${removalNote}`,
      { cancelled }
    ),
    cancellationEligible: true,
    countsForOutcome: true,
    selected: true,
    cancelled,
    resisted: !cancelled,
    attemptSuccessValue: Number(successValue),
    effectSuccessValue: attempt.effectSuccessValue,
    automaticSuccess: attempt.automaticSuccess,
    automaticFailure: false
  });
  reportUntargeted(chosen);
  return results;
}

// ── Instant/X persistent components at CAST time ───────────────────────────

/**
 * Nature of a spell's damage channel for the DEC-9 damageType. The decision
 * logic lives in rules/spell-data.mjs (`spellDamageNature`); this wrapper
 * supplies the spell's own special-damage bands (including the legacy
 * name/source fallbacks of spell-damage.mjs).
 * @param {object} spell - Spell Item document.
 * @returns {string|null} "physical"|"magical"|null.
 */
export function spellDamageNature(spell) {
  return spellDataNature(specialDamageBands(spell), spell?.system?.hasPowerTable);
}

/**
 * Identity of ONE casting (T6.1/DEC-8): every effect created by this cast
 * shares it, so separate castings of the same spell stay distinguishable even
 * when their family/rank coincide, and a `/Space` cast can be removed as the
 * single area effect it is (CR I p. 167).
 * @returns {string}
 */
function newCastId() {
  const randomId = globalThis.foundry?.utils?.randomID;
  const suffix = typeof randomId === "function"
    ? randomId()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `cast-${suffix}`;
}

/**
 * Target selection mode of the spell for the forced-removal area rule
 * (CR I pp. 161-162/167): the structured `target.selection` authored by the
 * importer ("space" | "all" | "limited"). Non-area targets and unrecorded
 * selections carry no scope, and their effects stay individual.
 * @param {object} spell - Spell Item document.
 * @returns {string|null}
 */
function spellCastEffectScope(spell) {
  const target = spell?.system?.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  return SW25_EFFECT_SCOPES.includes(target.selection) ? target.selection : null;
}

/**
 * Create the persistent component of an Instant/X spell as a consequence of
 * the CAST (never when Apply Damage is pressed). Relocated from the
 * apply-damage path (T5.7-C) so applying later damage can never duplicate
 * the component or re-process the cast.
 *
 * Contracts honored here:
 *   - `cast.successValue` is the AUTHENTIC Success Value of the casting,
 *     transmitted by the cast flow (DEC-6). It is NEVER derived from damage.
 *     SV 0 is the legitimate no-check-modality value; a missing SV is
 *     missing mandatory data and skips the creation.
 *   - `family`/`rank` follow DEC-1/DEC-16 (authored name and version
 *     numeral). `durationScale`/`durationAnchor` follow T5.2/D4 (combat
 *     scales carry a resolved casterTurn anchor; manual scales carry none).
 *   - `origin` is the spell document UUID, `casterUUID` the caster's Actor
 *     UUID, `damageType` the DEC-9 nature when known.
 *   - `resisted` travels as the ONLY resistance information crossing the
 *     EffectService boundary (always false here: a resisted target never
 *     reaches this point). The service stores it as inert metadata; it never
 *     interprets resistance types, difficulties or rolls.
 *
 * If no spell UUID is given, or the spell is not Instant/X, nothing happens.
 * Failures (missing SV, unresolvable anchor, service rejection) are reported
 * clearly and nothing is written.
 *
 * @param {Actor} actor - Target actor receiving the effect.
 * @param {object} [context] - Casting context.
 * @param {string|null} [context.spellUuid] - UUID of the spell Item.
 * @param {string|null} [context.casterUuid] - UUID of the caster Actor.
 * @param {number|undefined} [context.successValue] - Authentic casting SV
 *   (DEC-6); absent means missing mandatory data, 0 is the no-check value.
 * @param {string|null} [context.damageType] - Spell damage channel
 *   ("magical"|"physical"); mapped to the DEC-9 nature.
 * @param {string|null} [context.successValueSource] - SV provenance
 *   (SW25_SUCCESS_VALUE_SOURCES), supplied by the cast flow.
 * @param {string|null} [context.castId] - Identity of THIS casting, shared by
 *   every representation the cast creates (T6.1/DEC-8).
 * @returns {Promise<void>}
 */
export async function applyInstantXPersistentEffect(actor, context = {}) {
  const spellUuid = context?.spellUuid ?? null;
  if (!spellUuid) return;
  let spell = null;
  if (typeof game?.items?.get === "function") {
    spell = game.items.get(spellUuid) ?? null;
  }
  if (!spell && typeof fromUuid === "function") {
    try { spell = await fromUuid(spellUuid); } catch { spell = null; }
  }
  if (!spell || !isInstantXSpell(spell)) return;
  const spellData = getInstantXSpellData(spell);
  if (!spellData) {
    console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created: its Duration ("${getSpellDuration(spell)}") has no parseable persistent part.`);
    return;
  }
  // DEC-6: the Success Value is the casting result transmitted by the cast
  // flow, never inferred from anything else. A missing SV is missing
  // mandatory data: the persistent component is not created and no value is
  // fabricated.
  const successValue = context.successValue;
  if (typeof successValue !== "number" || !Number.isInteger(successValue) || successValue < 0) {
    console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created: no casting Success Value arrived from the cast flow (missing mandatory data, DEC-6).`);
    return;
  }
  const casterUuid = typeof context.casterUuid === "string" && context.casterUuid.trim() !== "" ? context.casterUuid.trim() : null;
  const identity = getInstantXSpellIdentity(spell);
  if (!identity.family) {
    console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created: the spell has no usable identity name (DEC-1).`);
    return;
  }
  // T5.2/D4: combat scales (rounds/turns) REQUIRE a resolved anchor. The
  // approved default regime is casterTurn/begin (T5.0-R D5); when the caster
  // is not a combatant of the active encounter, no anchor is fabricated.
  // Phase 2: a minute/second-DERIVED duration then falls back to its manual
  // out-of-combat mapping (pre-combat casts keep working, under GM
  // management); an AUTHORED rounds/turns duration has no fallback and is
  // not created (D4 skip preserved).
  let durationAnchor = null;
  let scaleData = spellData;
  if (spellData.durationScale === "rounds" || spellData.durationScale === "turns") {
    durationAnchor = resolveSw25CasterAnchor(casterUuid);
    if (!durationAnchor) {
      if (spellData.outOfCombat) {
        console.warn(`sw25-taka: "${spell.name}" was cast without a combat anchor (D4): its persistent component is created on the manual "${spellData.outOfCombat.durationScale}" scale (GM-managed, out-of-combat fallback).`);
        scaleData = spellData.outOfCombat;
      } else {
        console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created: its ${spellData.durationScale}-scale duration requires a combat anchor (D4) and the caster is not a combatant of the active encounter.`);
        return;
      }
    }
  }
  const attribute = parseSw25SpellDamageAttribute(spell);
  const nature = context.damageType === "magical" ? "Magical" : context.damageType === "physical" ? "Physical" : null;
  const application = {
    family: identity.family,
    rank: identity.rank,
    cast: { successValue },
    // T6.1/DEC-7: the SV provenance is transmitted by the cast flow (an
    // ordinary check, an automatic success whose +5 is already inside the SV,
    // or a no-check modality). It is never inferred from the numeric value.
    successValueSource: typeof context.successValueSource === "string" && context.successValueSource.trim() !== ""
      ? context.successValueSource.trim()
      : null,
    // T6.1/DEC-8: one `castId` per CASTING, shared by every representation of
    // this cast on every target, plus the target selection mode of the spell
    // (`/Space`, `/All`, `/Z`) for the forced-removal area rule.
    castId: typeof context.castId === "string" && context.castId.trim() !== "" ? context.castId.trim() : null,
    effectScope: spellCastEffectScope(spell),
    changes: [],
    durationScale: scaleData.durationScale,
    initialDuration: scaleData.initialDuration,
    remainingDuration: scaleData.remainingDuration,
    // Phase 3 corrections: the authored seconds identity of an out-of-combat
    // fallback application travels with the effect (null otherwise). The
    // combat-entry flow reads it; no countdown semantics of its own.
    sourceDuration: scaleData.sourceDuration ?? null,
    durationAnchor,
    effectType: typeof spell.system?.effectType === "string" && spell.system.effectType.trim() !== "" ? spell.system.effectType.trim() : null,
    // Cancellation eligibility (DEC-7/§55): this persistent component comes
    // from a spell, so it is magical. The resistance notation is preserved as
    // source provenance only — it is NOT a cancellation-eligibility condition
    // (T6.1) and NOT the resistance resolution outcome (that remains the
    // `resisted` transport boolean below).
    isMagical: true,
    resistance: getSpellResistance(spell),
    origin: spell.uuid ?? spellUuid,
    casterUUID: casterUuid,
    damageType: nature || attribute ? { nature, ...(attribute ? { attribute } : {}) } : null,
    // EffectService boundary (DEC-R): the ONLY resistance information the
    // effect engine ever receives. The cast flow has already resolved every
    // resistance; a resisted target never gets here. The service accepts the
    // field for transport and ignores it — it never interprets resistance.
    resisted: false
  };
  const result = await requestSw25EffectOperation("apply", { actorUuid: actor.uuid, ...application });
  if (result && result.ok === false) {
    console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created (${result.code}): ${result.error}`);
  }
}

// Immediate components are deliberately keyed by explicit spell identity:
// spell descriptions are source text, not executable rules data. These two
// handlers are the initial coverage set (spell compendium sourceUrl):
//   Chilling Breath — https://sw25.wikidot.com/spell:chilling-breath
//   Healing Water   — https://sw25.wikidot.com/fspell:healing-water
//
// Damage remains a manual Roll Damage action. Healing Water creates the water
// at cast time; drinking it and rolling its healing remain a later action.
const INSTANT_X_IMMEDIATE_HANDLERS = new Map([
  ["chilling breath", ({ target }) => ({
    kind: "manual-damage",
    targetUuid: target.uuid,
    targetName: target.name
  })],
  ["healing water", ({ target }) => ({
    kind: "created-water",
    targetUuid: target.uuid,
    targetName: target.name
  })]
]);

/**
 * Canonical registry/ledger key of a spell name (Phase 2): the leading ⏩/△
 * action-marker run is authoring metadata and is stripped via the shared
 * `canonicalSpellName` before the case folding, so a handler (or a Combat
 * Preparation ledger entry) registered under a markered name resolves for the
 * clean spelling and vice versa.
 * @param {string} spellName - Authored spell name.
 * @returns {string} The canonical comparison key.
 */
function canonicalSpellKey(spellName) {
  return canonicalSpellName(spellName ?? "").name.trim().toLocaleLowerCase();
}

/**
 * Register a spell-specific immediate-component resolver. The spell name is
 * stored under its CANONICAL key: registering "⏩Healing Water" and
 * "Healing Water" target the same entry.
 * @param {string} spellName
 * @param {(context: object) => object|Promise<object>} handler
 * @returns {() => void} unregister callback
 */
export function registerSw25InstantXImmediateHandler(spellName, handler) {
  const key = canonicalSpellKey(spellName);
  if (!key || typeof handler !== "function") throw new TypeError("An Instant/X spell name and immediate handler are required.");
  const previous = INSTANT_X_IMMEDIATE_HANDLERS.get(key);
  INSTANT_X_IMMEDIATE_HANDLERS.set(key, handler);
  return () => {
    if (INSTANT_X_IMMEDIATE_HANDLERS.get(key) !== handler) return;
    if (previous) INSTANT_X_IMMEDIATE_HANDLERS.set(key, previous);
    else INSTANT_X_IMMEDIATE_HANDLERS.delete(key);
  };
}

/**
 * Resolve the explicitly modeled immediate component once for each eligible
 * target in this cast. Results are transient UI instructions, never effect
 * application data. A failed handler is not retried: it may have completed
 * part of its work before rejecting, and replay could duplicate that work.
 */
export async function resolveCastImmediateComponents({ spell, targetResults }) {
  if (!isInstantXSpell(spell)) return [];
  const handler = INSTANT_X_IMMEDIATE_HANDLERS.get(canonicalSpellKey(spell?.name));
  if (!handler) {
    console.warn(`sw25-taka: no explicit Instant/X immediate handler is registered for "${spell?.name ?? "unknown spell"}"; its persistent component is still processed.`);
    return [];
  }
  const resolved = [];
  const attemptedTargets = new Set();
  for (const result of targetResults ?? []) {
    const target = result?.target;
    if (!target || result.resisted) continue;
    const targetKey = target.uuid ?? target.id ?? target;
    if (attemptedTargets.has(targetKey)) continue;
    attemptedTargets.add(targetKey);
    try {
      const component = await handler({ spell, target, result });
      if (component) resolved.push({ ...component, target });
    } catch (error) {
      console.error(`sw25-taka: the immediate component of "${spell.name}" failed for "${target.name}"; it will not be retried for this cast.`, error);
    }
  }
  return resolved;
}

/**
 * Resolve the explicit immediate component and create the persistent
 * Instant/X component for every target that did NOT resist. Immediate data is
 * returned only for the cast card and is never included in the EffectService
 * payload.
 * @param {object} input
 * @param {object} input.spell - Spell Item document.
 * @param {Actor} input.caster - Casting actor.
 * @param {Array} input.targetResults - Outcomes of resolveCastTargets.
 * @param {number} input.successValue - The cast's SV.
 * @param {string|null} [input.successValueSource] - The SV provenance
 *   (SW25_SUCCESS_VALUE_SOURCES): "check"/"automatic" for a checked cast,
 *   "none" for the no-check modalities.
 * @returns {Promise<Array<object>|undefined>} Transient immediate-component
 *   descriptors for the cast card; undefined for non-Instant/X or invalid SV.
 */
export async function createCastEffects({ spell, caster, targetResults, successValue, successValueSource = null }) {
  if (!isInstantXSpell(spell)) return;
  if (typeof successValue !== "number" || !Number.isInteger(successValue) || successValue < 0) return;
  const immediateComponents = await resolveCastImmediateComponents({ spell, targetResults });
  const damageType = spellDamageNature(spell);
  // ONE identity for the whole casting: all the representations created below
  // share it, whatever their receiving Actor (T6.1/DEC-8).
  const castId = newCastId();
  for (const result of targetResults) {
    if (!result.target || result.resisted) continue;
    await applyInstantXPersistentEffect(result.target, {
      spellUuid: spell.uuid,
      casterUuid: caster.uuid,
      successValue,
      successValueSource,
      castId,
      damageType
    });
  }
  return immediateComponents;
}

// ── Shared cast preparation (validation BEFORE any MP cost) ────────────────

/**
 * Resolve the casting class of a spell: the assigned class Item (by
 * `classId`), a class matching the spell's `className`, or the actor's
 * default magic class.
 * @param {Actor} actor - Casting actor.
 * @param {object} spell - Spell Item document.
 * @returns {Item|null}
 */
export function resolveCastingClass(actor, spell) {
  return actor?.items?.get(spell?.system?.classId)
    || [...(actor?.items || [])].find(item =>
      item.type === "class"
      && item.name.toLowerCase() === String(spell?.system?.className || "").toLowerCase()
    )
    || actor?.items?.get(actor.system?.combat?.magicClassId)
    || null;
}

/**
 * Validate a cast BEFORE any cost is paid (CR1 p. 159: an invalid cast never
 * reaches the Mana Point expenditure). Checks the casting class, the
 * per-spell target conditions and the prerequisite Magic Power roll of
 * special-damage spells.
 * @param {object} input
 * @param {Actor} input.actor - Casting actor.
 * @param {object} input.spell - Spell Item document.
 * @returns {{blocked: false, castingClass: Item, cost: number, doubleStompTargets: Actor[],
 *   regenerationTarget: Actor|null, needsPreviousMagicPower: boolean}}
 *   |{{blocked: true, reason: string}}
 */
export function prepareSpellCast({ actor, spell } = {}) {
  if (!actor || !spell) return { blocked: true, reason: "No actor or spell was given." };
  const castingClass = resolveCastingClass(actor, spell);
  if (!castingClass) return { blocked: true, reason: `${spell.name} is not assigned to a casting class.` };

  // Per-spell target conditions (validated BEFORE the MP expenditure).
  let doubleStompTargets = [];
  if (isDoubleStomp(spell)) {
    doubleStompTargets = castTargetsFromTokens();
    if (doubleStompTargets.length !== 2) {
      return { blocked: true, reason: "Target exactly two characters before casting Double Stomp." };
    }
  }
  let regenerationTarget = null;
  const regenerationSpell = regenerationSpellData(spell);
  if (regenerationSpell) {
    const selectedTargets = castTargetsFromTokens();
    if (selectedTargets.length !== 1) return { blocked: true, reason: `Target exactly one character before casting ${spell.name}.` };
    regenerationTarget = selectedTargets[0];
    if (regenerationTarget?.type !== "character") return { blocked: true, reason: `${spell.name} requires a character target.` };
    const targetInCombat = [...(game?.combat?.combatants || [])].some(combatant =>
      combatant.actor?.uuid === regenerationTarget.uuid || combatant.actor?.id === regenerationTarget.id);
    if (!targetInCombat) return { blocked: true, reason: `The ${spell.name} target must be in the active combat encounter.` };
    if (!regenerationTarget.isOwner && !game.users.activeGM) return { blocked: true, reason: "An active GM is required to affect that target." };
  }

  const hasSpecialDamage = specialDamageBands(spell).length > 0;
  const exhaustiveSucking = isExhaustiveSucking(spell);
  const needsPreviousMagicPower = hasSpecialDamage || exhaustiveSucking;
  if (needsPreviousMagicPower) {
    const previousMagicPower = actor.getFlag(FLAG_SCOPE, "lastMagicPowerRoll") ?? null;
    if (!previousMagicPower || previousMagicPower.criticalFailure
      || (previousMagicPower.classId && String(previousMagicPower.classId) !== String(castingClass.id))) {
      return { blocked: true, reason: `Roll ${castingClass.name} Magic Power before casting ${spell.name}.` };
    }
  }

  const cost = Math.max(0, Number(spell.system.mpCost ?? 0));
  const currentMP = characterResourceValue(actor, "mp");
  if (currentMP < cost) return { blocked: true, reason: `${actor.name} does not have enough MP to cast ${spell.name}.` };

  return {
    blocked: false,
    castingClass,
    cost,
    doubleStompTargets,
    regenerationTarget,
    needsPreviousMagicPower
  };
}

/**
 * Deduct the Mana Points immediately before the roll (CR1 p. 159). A
 * subsequent automatic failure never refunds them. Nature-magic spending is
 * tracked for the Natural Power ledger as before.
 * @param {Actor} actor - Casting actor.
 * @param {number} cost - MP cost.
 * @param {object} spell - Spell Item document.
 * @returns {Promise<void>}
 */
export async function deductCastMP(actor, cost, spell) {
  const currentMP = characterResourceValue(actor, "mp");
  await updateCharacterResourceValue(actor, "mp", currentMP - Math.max(0, Number(cost) || 0));
  await trackNaturalPowerSpending(actor, cost, spell);
}

// ── Combat Preparation: once per name (CR1 p. 175) ─────────────────────────

/**
 * The ledger records CANONICAL spell names (Phase 2). Entries recorded before
 * the migration hold raw lowercased names that may carry leading ⏩/△
 * markers; those are canonicalized at READ time, so old-format ledgers keep
 * matching without any data migration.
 * @param {Actor} actor - Casting actor.
 * @returns {string[]} Canonical names already recorded for the active combat.
 */
function combatPreparationNames(actor) {
  const combatId = game?.combat?.id ?? "";
  const state = actor.getFlag(FLAG_SCOPE, "combatPreparationCasts") ?? null;
  if (!state || state.combatId !== combatId) return [];
  return [...(state.names || [])].map(name => canonicalSpellKey(name));
}

/**
 * Whether the spell name has already been cast during the current Combat
 * Preparation (CR1 p. 175: spells with the same name can only be cast once).
 * Comparison runs on canonical names: a markered spelling and the clean
 * spelling are the same spell. The ledger is scoped to the active combat;
 * without a combat there is no shared preparation window and nothing is
 * recorded.
 * @param {Actor} actor - Casting actor.
 * @param {object} spell - Spell Item document.
 * @returns {boolean}
 */
export function spellAlreadyCastInCombatPreparation(actor, spell) {
  const combatId = game?.combat?.id ?? "";
  if (!combatId) return false;
  return combatPreparationNames(actor).includes(canonicalSpellKey(spell?.name));
}

async function recordCombatPreparationCast(actor, spell) {
  const combatId = game?.combat?.id ?? "";
  if (!combatId) return;
  const names = combatPreparationNames(actor);
  names.push(canonicalSpellKey(spell?.name));
  await actor.setFlag(FLAG_SCOPE, "combatPreparationCasts", { combatId, names });
}

// ── Chat cards ─────────────────────────────────────────────────────────────

// Per-card unique suffix for the collapsible detail anchors: chat messages
// accumulate in the log, so a fixed id would always resolve to the FIRST
// message carrying it (sw25.mjs toggles details through getElementById).
let spellCardCounter = 0;

function spellCardId() {
  spellCardCounter += 1;
  return `spell-card-${spellCardCounter}`;
}

function spellModalityBadge(modality) {
  if (modality === "minor") return '<span class="sw25-spell-modality"><img src="systems/sw25-taka/assets/quickspell.svg" class="sw25-icon-quickspell" alt="Minor Action"> Minor Action</span>';
  if (modality === "preparation") return '<span class="sw25-spell-modality"><i class="fas fa-flag"></i> Combat Preparation △</span>';
  return '<span class="sw25-spell-modality"><i class="fas fa-bolt"></i> Major Action</span>';
}

// The Spellcasting check block: the principal result (natural + Magic Power
// = SV) stays always visible; the Magic Power composition (permanent parts
// and any temporary modifiers of this cast) collapses into a secondary
// detail, mirroring the attack card's breakdown.
function spellCheckBlock(check, magicPowerParts = [], detailId) {
  const parts = [`natural ${check.natural}`, `Magic Power ${check.magicPower}`];
  if (check.automaticSuccess) parts.push("<strong>+5 (automatic success)</strong>");
  // Permanent parts print as plain numbers (the sheet shows the same
  // composition); the user-added temporary modifiers keep an explicit sign.
  const partValue = part => part.temporary ? escape(signedValue(part.value)) : escape(String(Number(part.value) || 0));
  const detail = magicPowerParts.length ? `
      <div class="sw25-spell-stat-detail" id="${detailId}" style="display:none;">
        <ul class="sw25-roll-breakdown">
          ${magicPowerParts.map(part => `<li>${escape(part.label)}: ${partValue(part)}</li>`).join("")}
        </ul>
      </div>` : "";
  return `
    <div class="sw25-spell-stat" data-target="${detailId}">
      <p class="sw25-spell-stat-summary" role="button" tabindex="0"><strong>Spellcasting check:</strong> ${parts.join(" + ")} — <strong>SV ${check.successValue}</strong></p>
      ${detail}
    </div>`;
}

function rollDamageButton(actor, spell, castingClass, successValue, targetUuid = "") {
  // The AUTHENTIC cast SV travels to the damage procedure (DEC-6): the Power
  // Table never derives it. "0" is legitimate; the attribute is only absent
  // when there is genuinely no SV (impossible in a resolved cast).
  return `<button type="button" data-sw25-chat-action="roll-spell-damage" data-actor-id="${escape(actor.id)}" data-item-id="${escape(spell.id)}" data-class-id="${escape(castingClass.id)}" data-target-id="${escape(targetUuid)}" data-success-value="${Number(successValue)}"><i class="fas fa-dice-d6"></i> Roll Damage</button>`;
}

function spellCastMetadata({ actor, spell, castingClass, cost }) {
  // Dispel Magic's printed Resistance is Neg, but no creature resistance roll
  // exists: the only opposed check is the Success Value comparison against the
  // targeted effect (CR I pp. 166-167). The card states that explicitly.
  const resistance = isDispelMagicSpell(spell)
    ? "Neg (target effect SV comparison)"
    : spellResistanceLabel(spell);
  return `<div class="sw25-spell-cast-meta"><span><strong>${escape(castingClass.name)} Magic Power:</strong> ${spellDamageMagicPower(actor, castingClass)}</span><span><strong>MP:</strong> ${cost}</span><span><strong>Resistance:</strong> ${escape(resistance)}</span></div>`;
}

// The badge describes the spell's outcome, never its numeric SV. For multiple
// targets, a fully affected target makes the overall result SUCCESS; if every
// target resists, any Half result makes it RESISTED (partial effect), otherwise
// it is FAILED (no effect). Individual lines retain every target's outcome.
// Cancellation results use the same badge over the lines that were actually
// evaluated (`countsForOutcome`): ineligible/untargeted effects never turn a
// cast into FAILED, and a cast with no eligible effect is NO VALID TARGET.
function spellOutcomeBadge(automaticSuccess, targetResults) {
  let label = "SUCCESS";
  let className = "sw25-spell-outcome-success";
  const evaluated = targetResults.filter(result => result.countsForOutcome !== false);
  if (!evaluated.length && targetResults.length) {
    label = "NO VALID TARGET";
    className = "sw25-spell-outcome-failure";
  } else if (automaticSuccess) {
    label = "AUTOMATIC SUCCESS";
    className = "sw25-spell-outcome-automatic";
  } else if (evaluated.length && evaluated.every(result => result.resisted)) {
    if (evaluated.some(result => result.halfDamage)) {
      label = "RESISTED";
      className = "sw25-spell-outcome-resisted";
    } else {
      label = "FAILED";
      className = "sw25-spell-outcome-failure";
    }
  }
  return `<div class="sw25-spell-outcome"><span class="sw25-spell-outcome-badge ${className}">${label}</span></div>`;
}

async function postAutomaticFailureCard({ actor, spell, castingClass, cost, check, magicPowerParts = [] }) {
  const detailId = spellCardId();
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="sw25-chat-card sw25-spell-card sw25-spell-failure"><h3>${escape(spell.name)}</h3>${spellModalityBadge("major")}<div class="sw25-spell-outcome"><span class="sw25-spell-outcome-badge sw25-spell-outcome-failure">FAILED</span></div>${spellCheckBlock(check, magicPowerParts, detailId)}${criticalFailureHTML()}<p class="sw25-spell-failure-note">The spell fizzles; its effects are not produced.</p>${spellCastMetadata({ actor, spell, castingClass, cost })}<p class="sw25-spell-mp-note"><em>${escape(actor.name)} still spends ${cost} MP.</em></p>${automaticFailureButton(actor)}</div>`
  });
}

// The cast card: name and modality, the PRINCIPAL result (outcome badge +
// the Spellcasting check block), per-target resistance outcomes, secondary
// cast data (Magic Power, MP cost, Resistance), and the damage action. The
// spell's metadata/description stay on the item sheet — the card keeps only
// the mechanical result of this cast.
async function postCastCard({ actor, spell, castingClass, cost, modality, check = null, targetResults = [], magicPowerParts = [], immediateComponents = [] }) {
  const detailId = spellCardId();
  const automaticSuccess = modality === "major" && check?.automaticSuccess === true;
  const successValue = modality === "major" ? Number(check?.successValue ?? 0) : 0;
  const outcomeBadge = spellOutcomeBadge(automaticSuccess, targetResults);

  const lines = [];
  if (modality === "major") {
    lines.push(spellCheckBlock(check, magicPowerParts, detailId));
  } else if (modality === "minor") {
    lines.push('<p class="sw25-spell-no-check">Minor Action <img src="systems/sw25-taka/assets/quickspell.svg" class="sw25-icon-quickspell" alt="Minor Action">: no Spellcasting check is made — <strong>SV 0</strong>.</p>');
  } else {
    lines.push('<p class="sw25-spell-no-check">Combat Preparation (△): no Spellcasting check is made — <strong>SV 0</strong>.</p>');
  }
  if (targetResults.length) {
    lines.push(`<ul class="sw25-resistance-results">${targetResults.map(result => {
      const statusClass = result.statusClass ?? (result.pending
        ? "sw25-resistance-pending"
        : result.resisted
          ? result.halfDamage ? "sw25-resistance-partial" : "sw25-resistance-resisted"
          : "sw25-resistance-affected");
      return `<li class="sw25-resistance-line ${statusClass}">${result.summary}</li>`;
    }).join("")}</ul>`);
  }
  lines.push(spellCastMetadata({ actor, spell, castingClass, cost }));
  lines.push(`<p class="sw25-spell-mp-note"><em>${escape(actor.name)} spends ${cost} MP.</em></p>`);
  if (immediateComponents.some(component => component.kind === "created-water")) {
    lines.push('<p class="sw25-spell-immediate-result">The Healing Water is created now. A character must drink it using a Major Action to receive the listed healing; drinking and healing are not automatic.</p>');
  }
  const damageComponents = immediateComponents.filter(component => component.kind === "manual-damage");
  const powerRoll = spell.system.hasPowerTable && !isNaturalPower(spell)
    ? `<p class="sw25-spell-damage-action">${damageComponents.length
      ? damageComponents.map(component => `${escape(component.targetName)}: ${rollDamageButton(actor, spell, castingClass, successValue, component.targetUuid)}`).join("<br>")
      : rollDamageButton(actor, spell, castingClass, successValue, targetResults.length === 1 ? targetResults[0].target?.uuid ?? "" : "")}</p>`
    : "";
  lines.push(powerRoll);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="sw25-chat-card sw25-spell-card"><h3>${escape(spell.name)}</h3>${spellModalityBadge(modality)}${outcomeBadge}${lines.join("")}</div>`
  });
}

// ── Post-cast consequences ─────────────────────────────────────────────────

// Damage and spell-specific consequences. The Power Table procedures are
// independent of the Spellcasting check: a table fumble cancels only the
// damage of that roll, never the cast (its effects were already created in
// step 7). Regeneration and Exhaustive Sucking respect a resisted target:
// their dedicated flows receive nothing when the target resisted.
async function dispatchSpellConsequences({ actor, spell, castingClass, targetResults = [] }) {
  const doubleStomp = isDoubleStomp(spell);
  const regenerationSpell = regenerationSpellData(spell);
  if (specialDamageBands(spell).length > 0 && !doubleStomp) {
    await rollSpecialSpellDamage({ actor, spell, castingClass });
  }
  if (doubleStomp) {
    await rollDoubleStompDamage({ actor, spell, castingClass, targets: targetResults.map(result => result.target) });
  }
  if (isNaturalPower(spell)) await rollNaturalPower({ actor, spell });
  if (regenerationSpell) {
    // The regeneration spell validates exactly ONE target in
    // prepareSpellCast; that target is the first resistance outcome.
    const regenerationResult = targetResults[0] || null;
    if (regenerationResult?.resisted) {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="sw25-chat-card spell-card"><h3>${escape(spell.name)}</h3><p><strong>${escape(regenerationResult.target.name)}</strong> resisted the spell; the regeneration was not started.</p></div>`
      });
    } else if (regenerationResult?.target) {
      await requestRegenerationSpell({ target: regenerationResult.target, caster: actor, spell });
    }
  }
  if (isExhaustiveSucking(spell)) {
    await resolveExhaustiveSucking({ actor, spell, castingClass });
  }
}

// ── The three casting flows ────────────────────────────────────────────────

/**
 * MAJOR ACTION cast (CR1 p. 174): the complete flow — validation, targets,
 * MP deduction before the roll, Spellcasting check, SV, per-target
 * resistances, effects and (independently) Power Table damage.
 *
 * @param {object} input
 * @param {Actor} input.actor - Casting actor.
 * @param {Item} input.spell - Spell Item document.
 * @param {boolean} [input.applyCost=true] - Deduct the MP (sheets pass their
 *   editability; observers never write the actor).
 * @param {object} [input.dialogs] - Dialog overrides (tests).
 * @param {Function|null} [input.promptModifiers=null] - Optional prompt for
 *   temporary modifiers: the SHARED dialog of rules/roll-modifiers.mjs
 *   (openRollModifiersDialog), injected by the sheets on Shift+click. The
 *   enabled modifiers join the effective Magic Power of this cast's SV —
 *   the roll itself stays a plain 2d6 (CR1 p. 159). Cancellation aborts the
 *   cast BEFORE the MP cost (no side effects). Null skips the prompt.
 * @returns {Promise<{cast: boolean, automaticFailure?: boolean, check?: object,
 *   targetResults?: Array, mpSpent: number}>}
 */
export async function castSpellAsMajor({ actor, spell, applyCost = true, dialogs = {}, promptModifiers = null } = {}) {
  const prepared = prepareSpellCast({ actor, spell });
  if (prepared.blocked) { warn(prepared.reason); return { cast: false, mpSpent: 0 }; }

  // Combat Preparation restrictions
  if (isInCombatPreparationPhase() && isStrictCombatPreparationEnabled()) {
    warn(`Major Action casting is not allowed during Combat Preparation when strict rules are enforced. Use the Combat Preparation (△) modality for spells marked △.`);
    return { cast: false, mpSpent: 0 };
  }

  // Optional temporary-modifier prompt: the SHARED dialog of
  // rules/roll-modifiers.mjs, seeded with the caster's permanent Magic Power
  // parts (never a parallel modifier system). It opens BEFORE the MP cost so
  // a cancellation aborts the cast without side effects. The dialog's
  // enabled total IS the effective Magic Power of this cast's SV (the
  // permanent parts are seeded into it, so they are never added twice); the
  // roll itself stays a plain 2d6.
  const permanentMagicPowerParts = spellcastingMagicPowerParts(actor, prepared.castingClass);
  let effectiveMagicPower = null;
  let magicPowerParts = permanentMagicPowerParts;
  if (typeof promptModifiers === "function") {
    const modifiers = await promptModifiers({
      title: `${spell.name} — Spellcasting Modifiers`,
      diceFormula: "2d6",
      hint: "Temporary modifiers apply only to this cast: they join the effective Magic Power of the Success Value (the roll itself stays 2d6). Actor data and the sheet are not changed.",
      submitLabel: "Cast Spell",
      parts: permanentMagicPowerParts
    });
    if (!modifiers) return { cast: false, cancelled: true, mpSpent: 0 };
    const chosen = modifiers.map(normalizeModifier);
    effectiveMagicPower = enabledModifiersTotal(chosen);
    // The card's breakdown shows the permanent composition plus only the
    // temporary rows the user added (the permanent ones are already listed).
    magicPowerParts = [...permanentMagicPowerParts, ...chosen.filter(part => part.temporary)];
  }

  // (2b) Dispel Magic declares its target effect BEFORE the MP cost and the
  // roll (CR I p. 167): the choice can never be informed by the attempt's SV,
  // and abandoning the declaration aborts the cast with no side effects.
  let targets = null;
  let dispelDeclaration = null;
  if (isDispelMagicSpell(spell)) {
    targets = castSpellTargetList({ actor, spell, prepared });
    const declaration = await declareDispelCancellation({ targets, dialogs });
    if (declaration.cancelled) return { cast: false, cancelled: true, mpSpent: 0 };
    dispelDeclaration = declaration.selection;
  }

  // (3) MP deduction happens immediately BEFORE the roll; a fizzle below
  // never refunds it.
  if (applyCost) await deductCastMP(actor, prepared.cost, spell);

  // (4)+(5) The Spellcasting check and the ONE authoritative SV.
  const check = await rollSpellcastingCheck({ actor, castingClass: prepared.castingClass, magicPower: effectiveMagicPower });

  // Natural double 1: the spell fails outright. No resistances are needed
  // (CR1 p. 168), no effects are created, no damage is rolled. The MP stay
  // spent and the player may voluntarily register the Automatic Failure.
  if (check.automaticFailure) {
    await postAutomaticFailureCard({ actor, spell, castingClass: prepared.castingClass, cost: prepared.cost, check, magicPowerParts });
    return { cast: false, automaticFailure: true, mpSpent: prepared.cost, check };
  }

  // (2)+(6) Targets and their individual resistances (one shared check).
  // Dispel Magic is the exception: its target is an effect, not a creature,
  // so the normal resistance phase does not run (the printed Neg is the
  // effect-SV comparison, CR I pp. 166-167). Eligible effects only are
  // compared and removed through EffectService (DEC-7/DEC-8).
  targets = targets ?? castSpellTargetList({ actor, spell, prepared });
  let targetResults;
  if (isDispelMagicSpell(spell)) {
    targetResults = await resolveDispelCancellation({
      targets,
      successValue: check.successValue,
      automaticSuccess: check.automaticSuccess,
      declared: dispelDeclaration,
      dialogs
    });
  } else {
    const resistanceType = getSpellResistance(spell);
    targetResults = await resolveCastTargets({
      caster: actor,
      spell,
      resistanceType,
      successValue: check.successValue,
      targets,
      dialogs
    });
  }

  // (7) Spell effects: the Instant/X persistent components are created NOW,
  // with the authentic cast SV, only for targets that did not resist.
  const immediateComponents = await createCastEffects({
    spell,
    caster: actor,
    targetResults,
    successValue: check.successValue,
    successValueSource: check.automaticSuccess ? "automatic" : "check"
  });

  // (8) The cast card (with the check, the resistance results and the damage
  // button carrying the authentic SV) and the spell's own consequences.
  await postCastCard({ actor, spell, castingClass: prepared.castingClass, cost: prepared.cost, modality: "major", check, targetResults, magicPowerParts, immediateComponents });
  await dispatchSpellConsequences({ actor, spell, castingClass: prepared.castingClass, targetResults });

  return { cast: true, check, targetResults, mpSpent: prepared.cost };
}

/**
 * MINOR ACTION cast (⏩, CR1 p. 174): a SEPARATE flow, never merged with the
 * Major Action. No Spellcasting check is made, the SV is 0, and the spell
 * may be cast as many times as the caster wishes (MP per cast). Cast
 * conditions still apply; resistances are still resolved (with SV 0) and the
 * persistent Instant/X components are created at cast time with SV 0.
 *
 * @param {object} input - Same as castSpellAsMajor.
 * @returns {Promise<{cast: boolean, successValue: number, targetResults?: Array, mpSpent: number}>}
 */
export async function castSpellAsMinor({ actor, spell, applyCost = true, dialogs = {} } = {}) {
  if (!isMinorActionSpell(spell)) {
    warn(`${spell.name} cannot be cast with a Minor Action (no ⏩ marker).`);
    return { cast: false, mpSpent: 0 };
  }
  return castSpellWithoutCheck({ actor, spell, applyCost, dialogs, modality: "minor" });
}

/**
 * COMBAT PREPARATION cast (△, CR1 p. 175): a SEPARATE flow with its OWN
 * restriction — spells with the same name can only be cast once during
 * Combat Preparation. No Spellcasting check, SV 0.
 *
 * @param {object} input - Same as castSpellAsMajor.
 * @returns {Promise<{cast: boolean, successValue: number, targetResults?: Array, mpSpent: number}>}
 */
export async function castSpellInCombatPreparation({ actor, spell, applyCost = true, dialogs = {} } = {}) {
  if (!isInCombatPreparationPhase()) {
    warn(`Combat Preparation casting is only allowed during Combat Preparation phase.`);
    return { cast: false, mpSpent: 0 };
  }
  if (!isCombatPreparationSpell(spell)) {
    warn(`${spell.name} cannot be cast during Combat Preparation (no △ marker).`);
    return { cast: false, mpSpent: 0 };
  }
  if (spellAlreadyCastInCombatPreparation(actor, spell)) {
    warn(`${spell.name} has already been cast during this Combat Preparation.`);
    return { cast: false, mpSpent: 0 };
  }
  const result = await castSpellWithoutCheck({ actor, spell, applyCost, dialogs, modality: "preparation" });
  if (result.cast) await recordCombatPreparationCast(actor, spell);
  return result;
}

// Shared body of the two no-check modalities. They stay separate entry
// points with distinct rules and distinct cards; only the mechanical core
// (validate → pay → SV 0 → resistances → effects → consequences) is shared.
async function castSpellWithoutCheck({ actor, spell, applyCost, dialogs, modality }) {
  const prepared = prepareSpellCast({ actor, spell });
  if (prepared.blocked) { warn(prepared.reason); return { cast: false, mpSpent: 0 }; }
  if (applyCost) await deductCastMP(actor, prepared.cost, spell);
  // No dice are rolled, so no automatic failure can occur (CR1 p. 174).
  const successValue = 0;
  const targets = castSpellTargetList({ actor, spell, prepared });
  // Dispel Magic also declares its single target effect before the attempt
  // is resolved (no check is rolled in these modalities).
  let dispelDeclaration = null;
  if (isDispelMagicSpell(spell)) {
    const declaration = await declareDispelCancellation({ targets, dialogs });
    if (declaration.cancelled) return { cast: false, cancelled: true, mpSpent: prepared.cost };
    dispelDeclaration = declaration.selection;
  }
  const targetResults = isDispelMagicSpell(spell)
    ? await resolveDispelCancellation({ targets, successValue, declared: dispelDeclaration, dialogs })
    : await resolveCastTargets({
      caster: actor,
      spell,
      resistanceType: getSpellResistance(spell),
      successValue,
      targets,
      dialogs
    });
  const immediateComponents = await createCastEffects({ spell, caster: actor, targetResults, successValue, successValueSource: "none" });
  await postCastCard({ actor, spell, castingClass: prepared.castingClass, cost: prepared.cost, modality, check: null, targetResults, immediateComponents });
  await dispatchSpellConsequences({ actor, spell, castingClass: prepared.castingClass, targetResults });
  return { cast: true, successValue, targetResults, mpSpent: prepared.cost };
}

/**
 * Targets of a cast: the validated special targets when the spell demands
 * them (Double Stomp pairs; the Regeneration character), otherwise the
 * targeted tokens. When no target was selected, the persistent components
 * of a self-cast resolve onto the CASTER for unresistable spells (the
 * classic buff case); resolvable resistances with no target create nothing
 * rather than guessing a receiver.
 * @param {object} input
 * @returns {Actor[]}
 */
function castSpellTargetList({ actor, spell, prepared }) {
  if (isDoubleStomp(spell)) return prepared.doubleStompTargets;
  if (regenerationSpellData(spell)) return [prepared.regenerationTarget];
  const targets = castTargetsFromTokens();
  if (targets.length) return targets;
  const resistanceType = getSpellResistance(spell);
  return resistanceType === "cant" || resistanceType === null ? [actor] : [];
}
