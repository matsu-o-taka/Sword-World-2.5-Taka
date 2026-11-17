// Sword World 2.5 - Instant/X effect application (T5.7).
//
// Applies an Instant/X effect by separating the immediate component
// (resolved exactly once during casting, never persisted as an ActiveEffect)
// from the persistent component (an ActiveEffect representing only the
// pending resolution queue, created through EffectService).
//
// DEC-40: Instant/X effects may have an immediate part and a persistent part.
//   The immediate part is resolved according to the action's rules during
//   casting. The persistent part continues its own lifecycle and is NOT
//   purged automatically at combat end when its duration exceeds the combat
//   scale (rounds-scale effects follow the normal expiration rules;
//   minutes/hours/days are GM-managed).
//
// DEC-49: the ActiveEffect represents only the persistent queue; no persistent
//   `instantX` field is stored on the effect.
//
// EffectService remains the sole writer of ActiveEffects (DEC-36). The
// persistent effect integrates with T5.2 durationScale/durationAnchor and the
// T5.3 duration engine; no parallel temporal system or native expiry mechanics
// are used for Instant/X.

import { applySw25Effect } from "./effect-service.mjs";

/**
 * Apply an Instant/X effect on an actor.
 *
 * The persistent component is created as a `sw25Effect` ActiveEffect through
 * EffectService (sole writer, DEC-36). The immediate component is NOT stored
 * as an ActiveEffect: it is resolved during casting by the caller, exactly
 * once, and the caller is responsible for applying it (e.g. dealing damage,
 * applying healing). Because the immediate part is never persisted,
 * re-running this function cannot re-run it.
 *
 * The persistent effect carries no `instantX` marker (DEC-49) and is
 * distinguished only by its `durationScale`/`durationAnchor` (T5.2), which
 * the T5.3 duration engine processes. Manual scales (minutes/hours/days/
 * permanent/other) survive combat end without automatic expiry; rounds-scale
 * effects are processed by the T5.3 duration engine.
 *
 * @param {Actor} actor - The actor receiving the effect.
 * @param {object} application - Application payload (same shape as
 *   `applySw25Effect`: family, rank, cast, changes, initialDuration,
 *   remainingDuration, durationScale, durationAnchor, effectType, origin,
 *   casterUUID, familyPolicy, damageType, img, flags, acceptReplace). Only
 *   the persistent component's fields should be present: the immediate part
 *   is resolved by the caller during casting and is never stored here.
 * @param {object} [options]
 * @param {boolean} [options.notify] - Notify this client of the outcome.
 * @param {Function} [options.decide] - Async decision provider for stacking
 *   `choice-required` outcomes (T4.3).
 * @returns {Promise<{ok: boolean, code: string, effectId?: string,
 *   effectUuid?: string, successValue?: number, replacedIds?: string[],
 *   choice?: object, error?: string}>}
 */
export async function applySw25InstantXEffect(actor, application, { notify = false, decide = undefined } = {}) {
  // The persistent component is created through EffectService, the sole
  // writer of sw25Effect documents (DEC-36). No `instantX` field is stored
  // on the effect (DEC-49). The immediate component is resolved by the caller
  // during casting and is never passed here for storage, so it cannot be
  // re-run on re-processing.
  return applySw25Effect(actor, application, { notify, decide });
}
