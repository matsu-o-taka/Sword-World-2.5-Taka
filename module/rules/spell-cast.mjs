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
//      modifier; the modifiers enter the Success Value.
//   5. Natural result and Spellcasting Value (SV): ordinary SV = natural
//      2d6 + effective Magic Power; natural double 6 = automatic success and
//      +5 SV; natural double 1 = AUTOMATIC FAILURE (the spell fizzles, MP
//      spent). Natural detection uses the shared utilities of
//      rules/critical-failure.mjs and is NEVER derived from a modified total.
//   6. Resistances are resolved INDIVIDUALLY for each target (CR1 p. 168):
//      one shared Spellcasting check, one Willpower check per target. The
//      caster's SV must STRICTLY exceed the target's to take full effect; a
//      tie means the target wins. Resistance TYPES (Can't/None/Optional/
//      Neg/Half/Temporary), their difficulties and their rolls live ONLY
//      here — the effect engine never sees them.
//   7. Spell effects and consequences. The persistent Instant/X components
//      are created AS A CONSEQUENCE OF THE CAST (never when Apply Damage is
//      pressed) with the AUTHENTIC cast SV (0 for the no-check modalities).
//      A resisted target never receives the persistent component.
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
  automaticFailureButton,
  criticalFailureHTML,
  isCriticalFailure,
  isNaturalDouble,
  naturalDiceTotal
} from "./critical-failure.mjs";

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

/**
 * Read the Resistance type of a spell from its imported metadata
 * ("Resistance: Neg", "Resistance: Can't", "Resistance: Negates", ...).
 * Wiki spell pages author "Negates" and "Can't"; both normalize to the
 * approved ids. An absent or unrecognized field returns null: the spell is
 * then treated as unresistable (Can't behavior) and the raw text is shown
 * on the cast card — nothing is invented for it.
 * @param {object} spell - Spell Item document.
 * @returns {string|null} An approved resistance id, or null.
 */
export function getSpellResistance(spell) {
  const metadata = String(spell?.system?.metadata || "");
  const match = metadata.match(/^resistance:\s*(.+)$/im);
  if (!match) return null;
  const raw = match[1].trim().toLowerCase().replace(/[’‘]/g, "'");
  if (/^(can'?t|cannot)$/.test(raw)) return "cant";
  if (/^optional$/.test(raw)) return "optional";
  if (/^none$/.test(raw)) return "none";
  if (/^neg(ated|ates)?$/.test(raw)) return "neg";
  if (/^half$/.test(raw)) return "half";
  if (/^temporar(y|ily)$/.test(raw)) return "temporary";
  return null;
}

/**
 * Human label for a spell's Resistance, for chat cards. An unrecognized raw
 * value is shown verbatim (never silently renamed).
 * @param {object} spell - Spell Item document.
 * @returns {string}
 */
export function spellResistanceLabel(spell) {
  const metadata = String(spell?.system?.metadata || "");
  const match = metadata.match(/^resistance:\s*(.+)$/im);
  const id = getSpellResistance(spell);
  if (id) return RESISTANCE_LABELS[id];
  return match ? match[1].trim() : "—";
}

// ── Casting modality detection (CR1 pp. 174-175) ───────────────────────────
//
// The importer keeps the ⏩/△ authoring markers IN the spell name (verified
// against the compendium; DEC-1 keeps them in the family), so the name is
// the source of modality capability.

/** Whether the spell can be cast with a Minor Action (⏩ marker). */
export function isMinorActionSpell(spell) {
  return /⏩/.test(String(spell?.name || ""));
}

/** Whether the spell can be cast during Combat Preparation (△ marker). */
export function isCombatPreparationSpell(spell) {
  return /△/.test(String(spell?.name || ""));
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
 * @returns {Promise<{roll: Roll, natural: number, automaticFailure: boolean,
 *   automaticSuccess: boolean, magicPower: number, successValue: number}>}
 */
export async function rollSpellcastingCheck({ actor, castingClass }) {
  const roll = await new Roll("2d6").evaluate();
  const automaticFailure = isCriticalFailure(roll);
  const automaticSuccess = !automaticFailure && isNaturalDouble(roll, 6);
  const magicPower = spellDamageMagicPower(actor, castingClass);
  const natural = naturalDiceTotal(roll);
  // On automatic failure the SV is meaningless (the spell fizzles); it is
  // reported as 0 and never used for resolution.
  const value = automaticFailure
    ? 0
    : computeSpellcastingValue({ natural, magicPower, automaticSuccess }).successValue;
  return { roll, natural, automaticFailure, automaticSuccess, magicPower, successValue: value };
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
 *     * character: `roll` is the target's Willpower check (2d6 + Willpower);
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
  // character's Willpower or the monster's X modifier); the natural dice
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

// Default monster resistance mode dialog (GM authority): passive uses the
// X(Y) difficulty Y; active rolls 2d6 + X. When only one mode has data, it
// is used without asking. Closing keeps the passive default.
async function defaultAskMonsterMode(monster, check) {
  const parsed = parseMonsterResistance(monster?.system?.[check]);
  if (!parsed) return "active";
  if (parsed.passive === null) return "active";
  if (parsed.active === null) return "passive";
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.wait !== "function") return "passive";
  const answer = await DialogV2.wait({
    window: { title: `${monster.name} — ${check === "fortitude" ? "Fortitude" : "Willpower"} X(${parsed.passive})` },
    modal: true,
    content: `<p>How does <strong>${escape(monster.name)}</strong> resist?</p><p class="notes">Passive: the caster's SV must strictly exceed ${parsed.passive}. Active: the monster rolls 2d6 + ${parsed.active}.</p>`,
    buttons: [
      { action: "passive", label: `Passive (${parsed.passive})`, default: true },
      { action: "active", label: `Active (2d6 + ${parsed.active})` }
    ]
  });
  return answer === "passive" ? "passive" : answer === "active" ? "active" : "passive";
}

const DEFAULT_DIALOGS = {
  askOptional: defaultAskOptional,
  askMonsterMode: defaultAskMonsterMode
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
 * @param {object} [input.dialogs] - Dialog overrides (tests).
 * @returns {Promise<Array<{target: Actor, type: string|null, resisted: boolean,
 *   pending: boolean, automaticFailure: boolean, automaticSuccess: boolean,
 *   targetTotal: number|null, halfDamage: boolean, effectsNullified: boolean,
 *   summary: string}>>}
 */
export async function resolveCastTargets({ caster, spell, resistanceType, successValue, targets, dialogs = {} } = {}) {
  const askOptional = dialogs.askOptional || DEFAULT_DIALOGS.askOptional;
  const askMonsterMode = dialogs.askMonsterMode || DEFAULT_DIALOGS.askMonsterMode;
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
    // neg / half: the target's own resistance.
    if (target.type === "monster") {
      const mode = await askMonsterMode(target, "willpower");
      const parsed = parseMonsterResistance(target.system?.willpower);
      if (mode === "passive" && parsed?.passive !== null && parsed?.passive !== undefined) {
        const outcome = resolveTargetResistance({ type: resistanceType, successValue, passiveDifficulty: parsed.passive });
        results.push({ target, mode, ...outcome, summary: passiveMonsterSummary(target, outcome, resistanceType) });
        continue;
      }
      const modifier = parsed?.active ?? 0;
      const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
      const outcome = resolveTargetResistance({ type: resistanceType, successValue, roll });
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: target }),
        flavor: `${escape(target.name)} — Willpower (active resistance, 2d6 + ${modifier})`
      });
      results.push({ target, mode: "active", ...outcome, summary: activeSummary(target, outcome, resistanceType) });
      continue;
    }
    const roll = await new Roll(`2d6 + ${characterWillpower(target)}`).evaluate();
    const outcome = resolveTargetResistance({ type: resistanceType, successValue, roll });
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: target }),
      flavor: `${escape(target.name)} — Willpower (resistance, 2d6 + ${characterWillpower(target)})`
    });
    results.push({ target, mode: "active", ...outcome, summary: activeSummary(target, outcome, resistanceType) });
  }
  return results;
}

function resistanceWord(outcome, resistanceType) {
  if (outcome.pending) return "pending (GM decides)";
  if (outcome.resisted) return resistanceType === "half" ? "resisted — half damage, extra effects nullified" : "resisted";
  return "affected";
}

function optionalSummary(target, outcome) {
  return `<strong>${escape(target.name)}:</strong> ${resistanceWord(outcome, "optional")} — ${escape(outcome.resistedReason)}`;
}

function plainSummary(target, outcome, resistanceType) {
  return `<strong>${escape(target.name)}:</strong> ${resistanceWord(outcome, resistanceType)} — ${escape(outcome.resistedReason)}`;
}

function passiveMonsterSummary(target, outcome, resistanceType) {
  return `<strong>${escape(target.name)}:</strong> ${resistanceWord(outcome, resistanceType)} — ${escape(outcome.resistedReason)}`;
}

function activeSummary(target, outcome, resistanceType) {
  return `<strong>${escape(target.name)}:</strong> ${resistanceWord(outcome, resistanceType)} — Willpower ${outcome.targetTotal ?? "—"}; ${escape(outcome.resistedReason)}`;
}

// ── Instant/X persistent components at CAST time ───────────────────────────

/**
 * Nature of a spell's damage channel for the DEC-9 damageType. Derived from
 * the spell's own data only: special-damage bands (uniform type) or the
 * shared Power Table (magical). Unknown → null.
 * @param {object} spell - Spell Item document.
 * @returns {string|null}
 */
export function spellDamageNature(spell) {
  const bands = specialDamageBands(spell);
  if (bands.length) {
    const types = new Set(bands.map(band => String(band.damageType || "").toLowerCase()));
    return types.size === 1 ? (types.has("magical") ? "magical" : "physical") : null;
  }
  return spell?.system?.hasPowerTable ? "magical" : null;
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
  // is not a combatant of the active encounter, no anchor is fabricated and
  // the persistent component is not created.
  let durationAnchor = null;
  if (spellData.durationScale === "rounds" || spellData.durationScale === "turns") {
    durationAnchor = resolveSw25CasterAnchor(casterUuid);
    if (!durationAnchor) {
      console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created: its ${spellData.durationScale}-scale duration requires a combat anchor (D4) and the caster is not a combatant of the active encounter.`);
      return;
    }
  }
  const attribute = parseSw25SpellDamageAttribute(spell);
  const nature = context.damageType === "magical" ? "Magical" : context.damageType === "physical" ? "Physical" : null;
  const application = {
    family: identity.family,
    rank: identity.rank,
    cast: { successValue },
    changes: [],
    durationScale: spellData.durationScale,
    initialDuration: spellData.initialDuration,
    remainingDuration: spellData.remainingDuration,
    durationAnchor,
    effectType: typeof spell.system?.effectType === "string" && spell.system.effectType.trim() !== "" ? spell.system.effectType.trim() : null,
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

/**
 * Create the persistent Instant/X components for every target that did NOT
 * resist. A resisted target never receives one (its additional effects are
 * nullified under Half; under Neg it is unaffected altogether).
 * @param {object} input
 * @param {object} input.spell - Spell Item document.
 * @param {Actor} input.caster - Casting actor.
 * @param {Array} input.targetResults - Outcomes of resolveCastTargets.
 * @param {number} input.successValue - The cast's SV.
 * @returns {Promise<void>}
 */
export async function createCastEffects({ spell, caster, targetResults, successValue }) {
  if (!isInstantXSpell(spell)) return;
  if (typeof successValue !== "number" || !Number.isInteger(successValue) || successValue < 0) return;
  const damageType = spellDamageNature(spell);
  for (const result of targetResults) {
    if (!result.target || result.resisted) continue;
    await applyInstantXPersistentEffect(result.target, {
      spellUuid: spell.uuid,
      casterUuid: caster.uuid,
      successValue,
      damageType
    });
  }
}

// ── Shared cast preparation (validation BEFORE any MP cost) ────────────────

/**
 * Resolve the casting class of a spell: the assigned class Item, a class
 * matching the spell's class/school name, or the actor's default magic class.
 * @param {Actor} actor - Casting actor.
 * @param {object} spell - Spell Item document.
 * @returns {Item|null}
 */
export function resolveCastingClass(actor, spell) {
  return actor?.items?.get(spell?.system?.classId)
    || [...(actor?.items || [])].find(item =>
      item.type === "class"
      && item.name.toLowerCase() === String(spell?.system?.className || spell?.system?.school || "").toLowerCase()
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
  const currentMP = Number(actor.system.mp?.value ?? 0);
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
  const currentMP = Number(actor.system.mp?.value ?? 0);
  await actor.update({ "system.mp.value": currentMP - Math.max(0, Number(cost) || 0) });
  await trackNaturalPowerSpending(actor, cost, spell);
}

// ── Combat Preparation: once per name (CR1 p. 175) ─────────────────────────

function combatPreparationNames(actor) {
  const combatId = game?.combat?.id ?? "";
  const state = actor.getFlag(FLAG_SCOPE, "combatPreparationCasts") ?? null;
  return state && state.combatId === combatId ? [...(state.names || [])] : [];
}

/**
 * Whether the spell name has already been cast during the current Combat
 * Preparation (CR1 p. 175: spells with the same name can only be cast once).
 * The ledger is scoped to the active combat; without a combat there is no
 * shared preparation window and nothing is recorded.
 * @param {Actor} actor - Casting actor.
 * @param {object} spell - Spell Item document.
 * @returns {boolean}
 */
export function spellAlreadyCastInCombatPreparation(actor, spell) {
  const combatId = game?.combat?.id ?? "";
  if (!combatId) return false;
  return combatPreparationNames(actor).includes(String(spell?.name ?? "").trim().toLowerCase());
}

async function recordCombatPreparationCast(actor, spell) {
  const combatId = game?.combat?.id ?? "";
  if (!combatId) return;
  const names = combatPreparationNames(actor);
  names.push(String(spell?.name ?? "").trim().toLowerCase());
  await actor.setFlag(FLAG_SCOPE, "combatPreparationCasts", { combatId, names });
}

// ── Chat cards ─────────────────────────────────────────────────────────────

function spellCheckLine(check) {
  const parts = [`natural ${check.natural}`, `Magic Power ${check.magicPower}`];
  if (check.automaticSuccess) parts.push("<strong>+5 (automatic success)</strong>");
  return `<p><strong>Spellcasting check:</strong> ${parts.join(" + ")} — <strong>SV ${check.successValue}</strong></p>`;
}

function rollDamageButton(actor, spell, castingClass, successValue) {
  // The AUTHENTIC cast SV travels to the damage procedure (DEC-6): the Power
  // Table never derives it. "0" is legitimate; the attribute is only absent
  // when there is genuinely no SV (impossible in a resolved cast).
  return `<button type="button" data-sw25-chat-action="roll-spell-damage" data-actor-id="${escape(actor.id)}" data-item-id="${escape(spell.id)}" data-class-id="${escape(castingClass.id)}" data-success-value="${Number(successValue)}"><i class="fas fa-dice-d6"></i> Roll Damage</button>`;
}

async function postAutomaticFailureCard({ actor, spell, cost, check }) {
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="sw25-chat-card spell-card"><h3>${escape(spell.name)}</h3>${criticalFailureHTML()}<p><strong>Spellcasting check:</strong> natural ${check.natural} — <strong>automatic failure</strong>. The spell fizzles; its effects are not produced.</p><p><em>${escape(actor.name)} still spends ${cost} MP.</em></p>${automaticFailureButton(actor)}</div>`
  });
}

async function postCastCard({ actor, spell, castingClass, cost, modality, check = null, targetResults = [] }) {
  const lines = [];
  if (modality === "major") {
    lines.push(spellCheckLine(check));
  } else if (modality === "minor") {
    lines.push('<p><strong>Minor Action (⏩):</strong> no Spellcasting check is made — <strong>SV 0</strong>.</p>');
  } else {
    lines.push('<p><strong>Combat Preparation (△):</strong> no Spellcasting check is made — <strong>SV 0</strong>.</p>');
  }
  lines.push(`<p><strong>${escape(castingClass.name)} Magic Power:</strong> ${spellDamageMagicPower(actor, castingClass)} &nbsp; <strong>MP:</strong> ${cost}</p>`);
  lines.push(`<p><strong>Resistance:</strong> ${escape(spellResistanceLabel(spell))}</p>`);
  for (const result of targetResults) lines.push(`<p class="sw25-resistance-line">${result.summary}</p>`);
  if (spell.system.metadata) lines.push(`<p>${escape(spell.system.metadata)}</p>`);
  if (spell.system.description) lines.push(`<p>${escape(spell.system.description)}</p>`);
  const powerRoll = spell.system.hasPowerTable && !isNaturalPower(spell)
    ? `<p>${rollDamageButton(actor, spell, castingClass, modality === "major" ? check.successValue : 0)}</p>`
    : "";
  lines.push(powerRoll);
  lines.push(`<p><em>${escape(actor.name)} spends ${cost} MP.</em></p>`);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="sw25-chat-card spell-card"><h3>${escape(spell.name)}</h3>${lines.join("")}</div>`
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
 * @returns {Promise<{cast: boolean, automaticFailure?: boolean, check?: object,
 *   targetResults?: Array, mpSpent: number}>}
 */
export async function castSpellAsMajor({ actor, spell, applyCost = true, dialogs = {} } = {}) {
  const prepared = prepareSpellCast({ actor, spell });
  if (prepared.blocked) { warn(prepared.reason); return { cast: false, mpSpent: 0 }; }

  // (3) MP deduction happens immediately BEFORE the roll; a fizzle below
  // never refunds it.
  if (applyCost) await deductCastMP(actor, prepared.cost, spell);

  // (4)+(5) The Spellcasting check and the ONE authoritative SV.
  const check = await rollSpellcastingCheck({ actor, castingClass: prepared.castingClass });

  // Natural double 1: the spell fails outright. No resistances are needed
  // (CR1 p. 168), no effects are created, no damage is rolled. The MP stay
  // spent and the player may voluntarily register the Automatic Failure.
  if (check.automaticFailure) {
    await postAutomaticFailureCard({ actor, spell, cost: prepared.cost, check });
    return { cast: false, automaticFailure: true, mpSpent: prepared.cost, check };
  }

  // (2)+(6) Targets and their individual resistances (one shared check).
  const targets = castSpellTargetList({ actor, spell, prepared });
  const resistanceType = getSpellResistance(spell);
  const targetResults = await resolveCastTargets({
    caster: actor,
    spell,
    resistanceType,
    successValue: check.successValue,
    targets,
    dialogs
  });

  // (7) Spell effects: the Instant/X persistent components are created NOW,
  // with the authentic cast SV, only for targets that did not resist.
  await createCastEffects({ spell, caster: actor, targetResults, successValue: check.successValue });

  // (8) The cast card (with the check, the resistance results and the damage
  // button carrying the authentic SV) and the spell's own consequences.
  await postCastCard({ actor, spell, castingClass: prepared.castingClass, cost: prepared.cost, modality: "major", check, targetResults });
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
  const resistanceType = getSpellResistance(spell);
  const targetResults = await resolveCastTargets({
    caster: actor,
    spell,
    resistanceType,
    successValue,
    targets,
    dialogs
  });
  await createCastEffects({ spell, caster: actor, targetResults, successValue });
  await postCastCard({ actor, spell, castingClass: prepared.castingClass, cost: prepared.cost, modality, check: null, targetResults });
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
