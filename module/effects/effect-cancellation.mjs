// Sword World 2.5 - forced cancellation: eligibility and Success Value
// comparison (T6.1, DEC-7/DEC-8).
//
// This module is PURE rules logic. It answers two questions per effect:
//   1. Is the effect a valid target of the mechanism (Dispel Magic or
//      Wordbreak)?
//   2. Does the attempt beat the effect's stored Success Value?
// It never writes documents: the caller removes an eligible, beaten effect
// through EffectService's GM-authoritative `remove` operation (DEC-36).
//
// Sources verified for this task:
//   - CR I pp. 166-167 ("Forced Removal" / "Compare Success Values"):
//     the canceller is the Active side; the effect is cancelled when the
//     canceller's Success Value EXCEEDS the effect's stored Success Value
//     (the value it had when cast, including the +5 automatic-success rule),
//     or when the canceller achieves an automatic success.
//   - CR I p. 220 ([Dispel Magic]): removes ONE magical effect other than the
//     Curse type; no duration or Resistance restriction is printed.
//   - CR I p. 174 (Curse Type): "Even [Dispel Magic] will not remove them.
//     Only the [Remove Curse] spell can remove Curse effects." The exclusion
//     therefore binds BOTH Dispel Magic and Wordbreak (T6.1 correction).
//   - CR I p. 264 ([Wordbreak]): one sustained spell or effect. Only effects
//     with a duration longer than 10 seconds (1 round) or an
//     "Instant/X seconds/minutes (rounds)" duration can be cancelled.
//     Permanent durations, bare Instant durations, fall-prone results and
//     continuous physical conditions (e.g. being grabbed and rendered
//     immobile) cannot. The text prints NO `Resistance: Can't` exclusion, so
//     none is encoded (T6.1 correction of DEC-7 §7.3): resistance is source
//     provenance, never a cancellation-eligibility condition.
//   - Official Group SNE Q&A A II-05: Wordbreak CAN remove a spell affecting
//     a space/area. DEC-7's old Area: Target/Shot bullet is therefore NOT
//     encoded: the official source and the Q&A take precedence.
//
// Stored eligibility inputs (DEC-7/§55): `isMagical`, `effectType` and
// `durationScale`. Nothing is inferred from effect names or descriptions, and
// `resistance` is never consulted. Dispel Magic requires the strict boolean
// value true; false (including normalized legacy values) cannot qualify.
// Wordbreak is unaffected by the flag: it accepts magical and non-magical
// effects, and direct legacy null/missing inputs remain ineligible for Dispel.

import { SW25_EFFECT_SUBTYPE } from "./effect-model.mjs";

/** Approved cancellation mechanisms (DEC-7/§55 `cancel(ctx).mechanism`). */
export const SW25_CANCELLATION_MECHANISMS = ["dispel", "wordbreak"];

/**
 * Effect Type value that marks a Curse (DEC-7/§9; CR I p. 174): NEITHER
 * Dispel Magic NOR Wordbreak can remove it — only [Remove Curse] can. The
 * comparison is case-insensitive and tolerant of surrounding whitespace; no
 * other value is ever treated as a Curse.
 * @type {string}
 */
export const SW25_CURSE_EFFECT_TYPE = "curse";

/**
 * Explicit Effect Type values that classify a continuous physical condition
 * (fall prone, grabbed, rendered immobile) — the Wordbreak exclusions of
 * CR I p. 264. Only effects that CARRY one of these classifications are
 * excluded; an unclassified effect is never guessed to be a physical state.
 * @type {Set<string>}
 */
export const SW25_WORDBREAK_PHYSICAL_STATE_TYPES = new Set([
  "prone", "grapple", "grabbed", "immobile"
]);

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Whether an Item document is the [Dispel Magic] spell.
 * Identity is read from the structured source URL first and from the exact
 * authored name second (the same explicit-identity pattern used by the
 * existing special spell flows); descriptions are never parsed.
 * @param {object} item - Item document.
 * @returns {boolean}
 */
export function isDispelMagicSpell(item) {
  const source = normalizeText(item?.system?.sourceUrl);
  if (/(^|\/)spell:dispel-magic$/.test(source)) return true;
  return normalizeText(item?.name) === "dispel magic";
}

/**
 * Whether an Item document is the [Wordbreak] Combat Feat.
 * @param {object} item - Item document.
 * @returns {boolean}
 */
export function isWordbreakFeat(item) {
  const source = normalizeText(item?.system?.sourceUrl);
  if (/(^|[/:])(feat:)?wordbreak$/.test(source)) return true;
  return normalizeText(item?.name) === "wordbreak";
}

/**
 * Whether an effect is a Curse (excluded from BOTH mechanisms, CR I p. 174).
 * @param {object} system - Effect `system.*` payload.
 * @returns {boolean}
 */
export function isCurseEffect(system) {
  return normalizeText(system?.effectType) === SW25_CURSE_EFFECT_TYPE;
}

/**
 * Whether an effect explicitly classifies a continuous physical condition
 * (Wordbreak exclusion, CR I p. 264). Unclassified effects return false.
 * @param {object} system - Effect `system.*` payload.
 * @returns {boolean}
 */
export function isPhysicalStateEffect(system) {
  return SW25_WORDBREAK_PHYSICAL_STATE_TYPES.has(normalizeText(system?.effectType));
}

/**
 * Duration eligibility of Wordbreak (CR I p. 264).
 *
 * Stored `durationScale` (DEC-7/§55) is the only input. The approved
 * interpretation is:
 *   - `permanent`                     → excluded (printed restriction).
 *   - `minutes` / `hours` / `days`    → longer than 10 seconds.
 *   - `rounds` with initialDuration>1 → longer than one round (10 seconds).
 *   - `rounds` with 1 round or none   → not longer than 10 seconds.
 *   - `turns`                         → a turn edge is at most one round, so
 *                                        it is not longer than 10 seconds.
 *   - `other` / absent                → unverifiable: excluded rather than
 *                                        guessed.
 * The `instantX` input covers the printed "Instant/X seconds/minutes
 * (rounds)" exception: such an effect is eligible even when its stored scale
 * alone would not prove the >10-second condition (e.g. Instant/1 round).
 * Callers derive it from the effect's origin when that origin is available;
 * it is never inferred from the effect's name.
 *
 * @param {object} system - Effect `system.*` payload.
 * @param {{instantX?: boolean}} [options]
 * @returns {{eligible: boolean, reason: string}}
 */
export function wordbreakDurationEligibility(system, { instantX = false } = {}) {
  const scale = system?.durationScale ?? null;
  if (scale === "permanent") {
    return { eligible: false, reason: "Permanent duration cannot be cancelled (CR I p. 264)." };
  }
  if (instantX === true) {
    return { eligible: true, reason: "Instant/X duration is cancellable (CR I p. 264)." };
  }
  if (scale === "minutes" || scale === "hours" || scale === "days") {
    return { eligible: true, reason: `A ${scale} duration is longer than 10 seconds.` };
  }
  if (scale === "rounds") {
    const rounds = Number(system?.initialDuration);
    if (Number.isInteger(rounds) && rounds > 1) {
      return { eligible: true, reason: `An initial duration of ${rounds} rounds exceeds 10 seconds (1 round).` };
    }
    return { eligible: false, reason: "A duration of one round or less is not longer than 10 seconds (CR I p. 264)." };
  }
  if (scale === "turns") {
    return { eligible: false, reason: "A turn-edge duration is at most one round (10 seconds), and the effect is not Instant/X." };
  }
  return { eligible: false, reason: "The stored duration does not prove the required longer-than-10-seconds duration." };
}

/**
 * Eligibility of one effect for one mechanism. The two mechanisms are
 * deliberately separate (DEC-8.B): Dispel Magic only checks magic + Curse;
 * Wordbreak checks duration + physical state. Curse is excluded from BOTH
 * (CR I p. 174). `Resistance: Can't` is NOT an eligibility condition for
 * either mechanism (T6.1 correction): the printed Wordbreak text has no such
 * restriction, and resistance is never a substitute for magical status,
 * duration or effect type.
 *
 * @param {object} system - Effect `system.*` payload.
 * @param {"dispel"|"wordbreak"} mechanism - Cancellation mechanism.
 * @param {{instantX?: boolean}} [options] - Wordbreak's Instant/X exception.
 * @returns {{mechanism: string, eligible: boolean, reasons: string[]}}
 */
export function effectCancellationEligibility(system, mechanism, { instantX = false } = {}) {
  if (!SW25_CANCELLATION_MECHANISMS.includes(mechanism)) {
    return { mechanism: String(mechanism), eligible: false, reasons: [`Unknown cancellation mechanism "${String(mechanism)}".`] };
  }
  const reasons = [];
  if (isCurseEffect(system)) {
    reasons.push(`${mechanism === "dispel" ? "Dispel Magic" : "Wordbreak"} cannot remove Curse effects: only [Remove Curse] can (CR I p. 174).`);
  }
  if (mechanism === "dispel") {
    if (system?.isMagical !== true) {
      reasons.push("Dispel Magic only removes effects explicitly classified as magical (DEC-7).");
    }
  } else {
    if (isPhysicalStateEffect(system)) {
      reasons.push("Wordbreak cannot remove continuous physical conditions such as prone or grabbed/immobile states (CR I p. 264).");
    }
    const duration = wordbreakDurationEligibility(system, { instantX });
    if (!duration.eligible) reasons.push(duration.reason);
  }
  return { mechanism, eligible: reasons.length === 0, reasons };
}

/**
 * Shared Contested Check rule (DEC-7.1 / DEC-8.C): the attempt must STRICTLY
 * exceed the effect's stored Success Value. Equality does NOT remove it.
 * @param {number} attemptSuccessValue - Canceller's Success Value.
 * @param {number} effectSuccessValue - Effect's stored Success Value.
 * @returns {boolean}
 */
export function compareCancellationSuccessValues(attemptSuccessValue, effectSuccessValue) {
  return Number(attemptSuccessValue) > Number(effectSuccessValue);
}

/**
 * The effect's authoritative passive Success Value, or null when it is NOT
 * recorded (T6.1/DEC-7).
 *
 * The numeric `successValue` alone is not enough: the stored value is only
 * authoritative when its PROVENANCE was recorded (`successValueSource`). The
 * provenance also carries the automatic-success rule of CR I p. 166 — an
 * effect created by an automatic success keeps its original SV ALREADY
 * increased by +5 (DEC-6), and it is still cancelled by exceeding that value
 * or by an active-side automatic success; it is never immune.
 *
 * A legitimate SV 0 (a `none` source: Minor Action / Combat Preparation
 * casting) is returned as 0, never confused with "not recorded".
 *
 * @param {object} system - Effect `system.*` payload.
 * @returns {number|null} The stored SV, or null when it must be re-determined.
 */
export function effectRecordedSuccessValue(system) {
  const source = system?.successValueSource;
  if (typeof source !== "string" || source.trim() === "") return null;
  const value = Number(system?.successValue);
  if (!Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Resolve one cancellation attempt.
 *
 * Eligibility is decided FIRST: an ineligible effect is never compared and
 * never removed, regardless of the attempt's Success Value. For an eligible
 * effect, the stored SV is compared strictly; a natural double 6 on the
 * canceller's check is an automatic success and cancels without the
 * comparison (CR I p. 166: "exceeds ... or if automatic success is
 * achieved"). Automatic failure never reaches here (the cast flow aborts).
 *
 * Unrecorded SV (CR I p. 167): when the effect's original Success Value is
 * not recorded, the attempt CANNOT be resolved by substituting zero. The
 * result is `needsSuccessValue: true` and the caller must re-determine the
 * value (its fallback procedure) and retry with `effectSuccessValue`. An
 * active-side automatic success needs no passive value and cancels directly.
 *
 * @param {object} input
 * @param {"dispel"|"wordbreak"} input.mechanism - Cancellation mechanism.
 * @param {number} input.attemptSuccessValue - Canceller's Success Value.
 * @param {object} input.system - Effect `system.*` payload.
 * @param {boolean} [input.automaticSuccess=false] - Natural double 6.
 * @param {boolean} [input.instantX=false] - Wordbreak Instant/X exception.
 * @param {number|null} [input.effectSuccessValue] - Re-determined passive SV
 *   (the CR I p. 167 fallback), used instead of the unrecorded stored one.
 * @returns {{eligible: boolean, cancelled: boolean, reasons: string[],
 *   attemptSuccessValue: number, effectSuccessValue: number|null,
 *   automaticSuccess: boolean, needsSuccessValue: boolean, reason: string}}
 */
export function resolveCancellationAttempt({
  mechanism,
  attemptSuccessValue,
  system,
  automaticSuccess = false,
  instantX = false,
  effectSuccessValue = undefined
} = {}) {
  const eligibility = effectCancellationEligibility(system, mechanism, { instantX });
  const reDetermined = Number.isInteger(effectSuccessValue) && effectSuccessValue >= 0 ? effectSuccessValue : null;
  const passive = reDetermined ?? effectRecordedSuccessValue(system);
  const base = {
    reasons: eligibility.reasons,
    attemptSuccessValue: Number(attemptSuccessValue),
    effectSuccessValue: passive,
    automaticSuccess: automaticSuccess === true
  };
  if (!eligibility.eligible) {
    return {
      ...base,
      eligible: false,
      cancelled: false,
      needsSuccessValue: false,
      reason: eligibility.reasons.join(" ")
    };
  }
  if (automaticSuccess === true) {
    return {
      ...base,
      reasons: [],
      eligible: true,
      cancelled: true,
      needsSuccessValue: false,
      reason: "Automatic success (natural double 6): the effect is cancelled (CR I p. 166)."
    };
  }
  if (passive === null) {
    return {
      ...base,
      reasons: [],
      eligible: true,
      cancelled: false,
      needsSuccessValue: true,
      reason: "The effect's original Success Value is not recorded: it must be determined again at cancellation time (CR I p. 167). It is NOT treated as 0, and nothing was removed."
    };
  }
  const cancelled = compareCancellationSuccessValues(attemptSuccessValue, passive);
  return {
    ...base,
    reasons: [],
    eligible: true,
    cancelled,
    needsSuccessValue: false,
    reason: cancelled
      ? `SV ${Number(attemptSuccessValue)} exceeds the effect's SV ${passive}: the effect is cancelled.`
      : `SV ${Number(attemptSuccessValue)} does not exceed the effect's SV ${passive} (ties do not cancel).`
  };
}

/**
 * Collect an actor's system effects that are eligible for a mechanism.
 * Presentation/UI consumers may use this to list candidates; the actual
 * removal still goes through EffectService.
 *
 * Presentation visibility (gmOnly): `system.gmOnly` effects are excluded by
 * default, so a selection offered to a player never reveals their existence
 * or their Success Values. The GM view passes `includeGmOnly: true`.
 *
 * @param {Actor} actor - Effect owner.
 * @param {"dispel"|"wordbreak"} mechanism - Cancellation mechanism.
 * @param {(effect: object) => boolean} [instantXFor] - Optional Instant/X
 *   resolver for Wordbreak (derived from the effect's origin).
 * @param {{includeGmOnly?: boolean}} [options]
 * @returns {Array<{effect: object, eligibility: object}>}
 */
export function collectCancellationCandidates(actor, mechanism, instantXFor = undefined, { includeGmOnly = false } = {}) {
  const effects = [...(actor?.effects ?? [])]
    .filter(effect => effect?.type === SW25_EFFECT_SUBTYPE)
    .filter(effect => includeGmOnly === true || effect.system?.gmOnly !== true);
  return effects.map(effect => ({
    effect,
    eligibility: effectCancellationEligibility(
      effect.system,
      mechanism,
      { instantX: typeof instantXFor === "function" ? instantXFor(effect) === true : false }
    )
  }));
}

// ── Casting identity and the area rule (T6.1, CR I p. 167) ─────────────────

/**
 * Whether two effects belong to the SAME casting. Only a non-blank `castId`
 * proves it: `family`, `rank` and `origin` are shared by every casting of the
 * same source and are NEVER used to group effects (two castings of one spell
 * must stay independently identifiable).
 * @param {object} left - Effect `system.*` payload.
 * @param {object} right - Effect `system.*` payload.
 * @returns {boolean}
 */
export function sameCasting(left, right) {
  const castId = left?.castId;
  return typeof castId === "string" && castId.trim() !== "" && castId === right?.castId;
}

/**
 * Whether cancelling this effect must remove the WHOLE area effect.
 * Only `/Space` (CR I p. 167: "counted as one effect for the entire area")
 * groups its representations; `/All` and `/Z` are individual effects on each
 * character and are removed one at a time. An unrecorded scope is individual.
 * @param {object} system - Effect `system.*` payload.
 * @returns {boolean}
 */
export function isSharedSpaceEffect(system) {
  return system?.effectScope === "space";
}

/**
 * Every Actor-side representation that cancelling the declared effect must
 * remove. For a `/Space` casting that is ALL effects carrying its `castId`,
 * on every supplied Actor (the area spell is ONE global effect). For any
 * other effect it is exactly the declared effect — cancelling an `/All` or
 * `/Z` effect never touches the other characters.
 *
 * A `/Space` effect WITHOUT a recorded `castId` cannot be grouped: only the
 * declared representation is returned, and `incomplete` reports the
 * limitation instead of guessing a grouping from names or origins.
 *
 * @param {object} declared - `{ target, effect }` of the declared effect.
 * @param {Actor[]} actors - Candidate effect owners (e.g. `game.actors`).
 * @returns {{members: Array<{target: Actor, effect: object}>, shared: boolean,
 *   incomplete: boolean}}
 */
export function collectCancellationRemovalGroup(declared, actors = []) {
  const system = declared?.effect?.system;
  if (!declared?.target || !declared?.effect) return { members: [], shared: false, incomplete: false };
  if (!isSharedSpaceEffect(system)) {
    return { members: [{ target: declared.target, effect: declared.effect }], shared: false, incomplete: false };
  }
  if (typeof system?.castId !== "string" || system.castId.trim() === "") {
    return {
      members: [{ target: declared.target, effect: declared.effect }],
      shared: true,
      incomplete: true
    };
  }
  const members = [];
  for (const actor of actors ?? []) {
    for (const effect of [...(actor?.effects ?? [])]) {
      if (effect?.type !== SW25_EFFECT_SUBTYPE) continue;
      if (!sameCasting(system, effect.system)) continue;
      members.push({ target: actor, effect });
    }
  }
  if (!members.some(member => member.effect === declared.effect || member.effect?.id === declared.effect.id)) {
    members.push({ target: declared.target, effect: declared.effect });
  }
  return { members, shared: true, incomplete: false };
}
