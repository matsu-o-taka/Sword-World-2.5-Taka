// Sword World 2.5 - Duration engine (T5.3).
//
// The system's OWN expiration engine for `sw25Effect` documents (T5.0-R
// consolidation D1–D12; reports/sw25-t5.0-r-duration-design-consolidation.md
// §3.2/§3.3/§3.4). It decides WHEN a persisted duration advances, from the
// individual turn transitions of the side initiative (T5.1) and from the
// system's round transition inside `handleAction` (D9).
//
// Integration contract (D9): the engine is invoked DIRECTLY from
// `handleAction` (module/combat/side-initiative.mjs) AFTER the turn
// transition has been registered and persisted through `saveState`. It is
// never called from native Foundry hooks: the native expiration machinery
// does not process `sw25Effect` at all (D1/D6/D11 — the native document
// `duration` never carries a finite `value` or an `expiry` on a system
// effect, so `isTemporary` keeps the effect out of the native registry).
//
// Failure policy (D7): no automatic retries, no tick ledger, no automatic
// recovery. Each effect is processed in ISOLATION: one effect's failure
// never stops the others. Every failure is reported visibly to the GM,
// identifying the effect and the event that produced it; the correction is
// manual, through the EffectService operations.
//
// Write path (DEC-45): every persistent modification goes through
// EffectService — decrements and expirations through `refresh`/`remove`,
// anchor degradations through the `refresh` durationAnchor patch. The engine
// never writes effect documents directly.

import {
  SW25_EFFECT_SUBTYPE,
  SW25_COMBAT_DURATION_SCALES
} from "./effect-model.mjs";
import { refreshSw25Effect, removeSw25Effect } from "./effect-service.mjs";

/** Event kinds the engine processes (side-initiative dispatch contract). */
const EVENT_KINDS = ["turn-begin", "turn-end", "round-end"];

/** Regimes whose anchor is an ACTING combatant (roundEnd has no active anchor). */
const TURN_REGIMES = ["casterTurn", "targetTurn"];

/**
 * Availability of one anchor combatant (D5, the four mandatory cases).
 *
 * The engine MUST distinguish: (A) a combatant that has not acted yet and
 * (B) one that already ended its actuation — BOTH keep a valid anchor (the
 * T5.1 `turnStates` are NOT consulted here and never mean incapacity), from
 * (C) a dead or incapacitated combatant and (D) a combatant/token that
 * disappeared from the encounter — both DEGRADE the anchor to `roundEnd`.
 *
 * Detection uses only real, GM-controlled information (no invented
 * heuristics):
 *   - presence in the encounter: `combat.combatants.get(combatantId)`;
 *   - death/incapacitation: the native defeated signal —
 *     `Combatant#isDefeated` (the manual defeated flag OR the DEFEATED
 *     special status effect on the actor, v14 verified) with a fallback to
 *     the plain `defeated` field for headless mocks;
 *   - token disappearance: a combatant with a `tokenId` whose token document
 *     no longer resolves (`Combatant#token`, v14: scene tokens lookup).
 *
 * Unconscious-but-alive characters without the DEFEATED status effect are NOT
 * auto-detected (the death check leaves them at HP 1): the GM applies the
 * DEFEATED status from the token status bar and the engine respects it. This
 * is a documented limitation, not a heuristic (consolidation §6 item 3).
 *
 * @param {Combat} combat - The combat encounter being processed.
 * @param {object} anchor - The effect's `system.durationAnchor`.
 * @returns {{available: boolean, reason: "combatant-absent"|"combatant-defeated"|"token-gone"|null}}
 */
export function sw25AnchorAvailability(combat, anchor) {
  const combatantId = typeof anchor?.combatantId === "string" && anchor.combatantId.trim() !== ""
    ? anchor.combatantId : null;
  // An anchor without a combatant identity (a direct `roundEnd` application,
  // whose identity is provenance only) never needs availability: `roundEnd`
  // decrements at the round transition regardless.
  if (!combatantId) return { available: true, reason: null };
  const combatant = combat?.combatants?.get ? combat.combatants.get(combatantId) : null;
  if (!combatant) return { available: false, reason: "combatant-absent" }; // case D
  const defeated = combatant.isDefeated === true || combatant.defeated === true; // case C
  if (defeated) return { available: false, reason: "combatant-defeated" };
  if (combatant.tokenId && !combatant.token) return { available: false, reason: "token-gone" }; // case D
  return { available: true, reason: null };
}

/**
 * The combat encounter's participant actors, deduplicated by actor id (two
 * combatants of the same Actor share one effect collection, and each effect
 * matches by its OWN combatantId — the anchor stays per-combatant).
 * @param {Combat} combat - The combat encounter.
 * @returns {Array<object>} The deduplicated actors.
 */
function participantActors(combat) {
  const actors = new Map();
  for (const combatant of [...(combat?.combatants ?? [])]) {
    const actor = combatant?.actor;
    if (actor?.effects && !actors.has(actor.id ?? actor.uuid)) actors.set(actor.id ?? actor.uuid, actor);
  }
  return [...actors.values()];
}

/** The actor's system effects (`sw25Effect` subtype only). */
function systemEffects(actor) {
  return [...(actor?.effects ?? [])].filter(effect => effect?.type === SW25_EFFECT_SUBTYPE);
}

/** Whether the effect carries an approved COMBAT duration scale. */
function isCombatScale(effect) {
  const scale = effect?.system?.durationScale;
  return typeof scale === "string" && SW25_COMBAT_DURATION_SCALES.includes(scale);
}

/**
 * Whether the effect's anchor matches a turn-edge event: a turn regime
 * (`casterTurn`/`targetTurn`) anchored to THIS combatant, on the event's
 * edge. The persisted `edge` is normalized to the approved default "begin"
 * when absent (T5.2 repair backfills it for approved regimes).
 */
function anchorMatchesTurnEvent(anchor, event) {
  if (!TURN_REGIMES.includes(anchor.regime)) return false;
  if (anchor.combatantId !== event.combatantId) return false;
  const eventEdge = event.kind === "turn-begin" ? "begin" : "end";
  return (anchor.edge ?? "begin") === eventEdge;
}

/** Whether the anchor is a deferred one (future preparation flow): the
 * engine NEVER resolves or processes it outside an explicit flow (T5.2 §4,
 * T5.3 §6). */
function isDeferredAnchor(anchor) {
  return anchor?.state === "deferred";
}

/** Human-readable label of one engine event (GM notifications, D10). */
function eventLabel(event) {
  if (event?.kind === "round-end") return `the round transition to round ${event.round ?? "?"}`;
  const side = event?.kind === "turn-begin" ? "begin" : "end";
  return `the turn ${side} of combatant ${event?.combatantId ?? "?"}`;
}

/**
 * Record one per-effect processing failure (D7/D10): visible GM notification
 * identifying the effect and the event, plus the technical console record.
 * @param {object} summary - The processing summary being built.
 * @param {object} actor - The effect's owner.
 * @param {object} effect - The failed effect.
 * @param {object} event - The event being processed.
 * @param {Error} error - The failure.
 * @returns {void}
 */
function recordFailure(summary, actor, effect, event, error) {
  const entry = {
    effectId: effect?.id ?? null,
    name: effect?.name ?? effect?.system?.family ?? null,
    actorId: actor?.id ?? null,
    eventLabel: eventLabel(event),
    error: String(error?.message ?? error)
  };
  summary.failures.push(entry);
  ui?.notifications?.error?.(`Duration engine: processing failed for effect "${entry.name ?? entry.effectId}" on ${actor?.name ?? entry.actorId ?? "?"} during ${entry.eventLabel}: ${entry.error}`);
  console.warn("Sword World 2.5 | Duration engine processing failure.", entry);
}

/**
 * D5 degradation: the anchor combatant can no longer act (dead, incapacitated
 * or disappeared). The effect STAYS on its target; its anchor REGIME changes
 * to `roundEnd` through EffectService; the combatant/token identity is kept
 * as provenance; the duration is NOT restarted; the effect is NOT removed.
 * The write goes through the `refresh` durationAnchor patch (DEC-45).
 * @param {object} actor - The effect's owner.
 * @param {object} effect - The effect to degrade.
 * @param {string} reason - Availability failure reason (D5 case).
 * @param {object} event - The event that triggered the degradation.
 * @param {object} summary - The processing summary being built.
 * @returns {Promise<boolean>} true when the degradation was written.
 */
async function degradeEffect(actor, effect, reason, event, summary) {
  const current = effect.system.durationAnchor ?? {};
  const degraded = {
    regime: "roundEnd",
    edge: current.edge ?? null, // kept as provenance; roundEnd does not use it
    combatantId: current.combatantId ?? null,
    tokenId: current.tokenId ?? null,
    state: "resolved"
  };
  const refreshed = await refreshSw25Effect(actor, effect.id, { durationAnchor: degraded });
  if (!refreshed.ok) throw new Error(refreshed.error ?? refreshed.code);
  summary.degraded.push({ effectId: effect.id, name: effect.name, reason, eventLabel: eventLabel(event) });
  // D10 discrete level: the GM must know the duration now decays every round.
  ui?.notifications?.warn?.(`Duration engine: "${effect.name ?? effect.id}" on ${actor.name ?? actor.id} now counts down at the end of each round (its anchor combatant can no longer act: ${reason}).`);
  console.warn("Sword World 2.5 | Duration engine degraded an anchor to roundEnd.", { effectId: effect.id, name: effect.name, actorId: actor.id, reason });
  return true;
}

/**
 * Advance one effect's duration according to its scale at a confirmed event:
 *   - `rounds`: DEC-23 counter bookkeeping — the ABSOLUTE new
 *     `remainingDuration` (current − 1) is written through `refresh`; at
 *     zero the effect is removed through `remove`. `initialDuration` is
 *     never touched. A `rounds` effect WITHOUT a usable counter is a
 *     processing failure reported to the GM — never an implicit duration
 *     (T5.3, open question 5.1).
 *   - `turns`: a numeric `remainingDuration` (as used by Instant/N turns)
 *     counts down at each matching anchor event, like `rounds`; a condition-
 *     based turn duration without a numeric counter expires at its matching
 *     edge. This preserves existing edge-condition effects while honoring
 *     explicit counted-turn durations.
 * @param {object} actor - The effect's owner.
 * @param {object} effect - The effect to process.
 * @param {object} event - The confirmed event.
 * @param {object} summary - The processing summary being built.
 * @returns {Promise<void>}
 */
async function processByScale(actor, effect, event, summary) {
  const scale = effect.system.durationScale;
  const label = { effectId: effect.id, name: effect.name };

  const remaining = effect.system.remainingDuration;
  const hasTurnCounter = scale === "turns"
    && typeof remaining === "number"
    && Number.isInteger(remaining)
    && remaining >= 0;
  if (scale === "turns" && !hasTurnCounter) {
    const removed = await removeSw25Effect(actor, effect.id);
    if (!removed.ok && removed.code !== "no-effect") throw new Error(removed.error ?? removed.code);
    summary.expired.push(label);
    return;
  }

  // Both counted combat scales write the absolute next counter via the
  // EffectService. `rounds` requires a counter at application; `turns` without
  // one retains its existing condition-at-edge behavior above.
  if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0) {
    throw new Error(`the effect has no usable ${scale} counter (remainingDuration = ${JSON.stringify(remaining)}); correct it manually through EffectService`);
  }
  if (remaining === 0) {
    // A zero counter should already have expired; expiring it now keeps the
    // bookkeeping coherent without inventing data.
    const removed = await removeSw25Effect(actor, effect.id);
    if (!removed.ok && removed.code !== "no-effect") throw new Error(removed.error ?? removed.code);
    summary.expired.push(label);
    return;
  }
  const newRemaining = remaining - 1;
  if (newRemaining === 0) {
    const removed = await removeSw25Effect(actor, effect.id);
    if (!removed.ok && removed.code !== "no-effect") throw new Error(removed.error ?? removed.code);
    summary.expired.push(label);
    return;
  }
  const refreshed = await refreshSw25Effect(actor, effect.id, { remainingDuration: newRemaining });
  if (!refreshed.ok) throw new Error(refreshed.error ?? refreshed.code);
  summary.discounted.push({ ...label, remaining: newRemaining });
}

/**
 * Process one turn-edge event (`turn-begin`/`turn-end` of ONE combatant):
 * every combat-scale effect anchored (casterTurn/targetTurn) to that
 * combatant on that edge advances. The anchor's availability is re-checked
 * first (D5): an unavailable anchor degrades instead of discounting.
 * @param {Combat} combat - The combat encounter.
 * @param {object} event - The turn event.
 * @param {object} summary - The processing summary being built.
 * @returns {Promise<void>}
 */
async function processTurnEdge(combat, event, summary) {
  for (const actor of participantActors(combat)) {
    for (const effect of systemEffects(actor)) {
      if (!isCombatScale(effect)) continue; // manual scales and legacy: untouched
      const anchor = effect.system.durationAnchor;
      if (!anchor || anchor.regime === "roundEnd") continue; // round transitions only
      if (isDeferredAnchor(anchor)) {
        summary.skipped.push({ effectId: effect.id, name: effect.name, reason: "deferred-anchor" });
        continue;
      }
      if (!anchorMatchesTurnEvent(anchor, event)) continue;
      try {
        const availability = sw25AnchorAvailability(combat, anchor);
        if (!availability.available) {
          await degradeEffect(actor, effect, availability.reason, event, summary);
          continue;
        }
        await processByScale(actor, effect, event, summary);
      } catch (error) {
        recordFailure(summary, actor, effect, event, error);
      }
    }
  }
}

/**
 * Process one confirmed round transition (`combat.update({round, turn:null})`
 * inside `handleAction`; never the native `roundEnd` event — consolidation
 * §3.2 note). Exactly once per transition:
 *
 *   1. D5 availability sweep: every casterTurn/targetTurn anchor whose
 *      combatant can no longer act (dead/incapacitated/disappeared)
 *      DEGRADES to `roundEnd`. A just-degraded effect is NOT discounted in
 *      the same transition (no double processing); it counts down from the
 *      NEXT round end.
 *   2. `roundEnd` regime processing: counted scales decrement by one;
 *      condition-based `turns` effects expire. Effects degraded in phase 1
 *      are excluded.
 *
 * @param {Combat} combat - The combat encounter.
 * @param {object} event - The round event ({ kind: "round-end", round }).
 * @param {object} summary - The processing summary being built.
 * @returns {Promise<void>}
 */
async function processRoundEnd(combat, event, summary) {
  const degradedIds = new Set();
  for (const actor of participantActors(combat)) {
    for (const effect of systemEffects(actor)) {
      if (!isCombatScale(effect)) continue;
      const anchor = effect.system.durationAnchor;
      if (!anchor || isDeferredAnchor(anchor)) {
        if (anchor && isDeferredAnchor(anchor)) summary.skipped.push({ effectId: effect.id, name: effect.name, reason: "deferred-anchor" });
        continue;
      }
      if (!TURN_REGIMES.includes(anchor.regime)) continue;
      try {
        const availability = sw25AnchorAvailability(combat, anchor);
        if (availability.available) continue; // cases A/B: valid anchor
        if (await degradeEffect(actor, effect, availability.reason, event, summary)) degradedIds.add(effect.id);
      } catch (error) {
        recordFailure(summary, actor, effect, event, error);
      }
    }
  }
  for (const actor of participantActors(combat)) {
    for (const effect of systemEffects(actor)) {
      if (!isCombatScale(effect)) continue;
      if (degradedIds.has(effect.id)) continue;
      const anchor = effect.system.durationAnchor;
      if (!anchor || anchor.regime !== "roundEnd") continue;
      try {
        await processByScale(actor, effect, event, summary);
      } catch (error) {
        recordFailure(summary, actor, effect, event, error);
      }
    }
  }
}

/**
 * Process ONE confirmed duration event on the GM client (D9: called directly
 * from `handleAction` AFTER the transition was saved; D7: failures are
 * isolated per effect and reported to the GM, never retried).
 *
 * The processing scope is the combat encounter's participant actors: every
 * `sw25Effect` with an approved combat `durationScale` (`rounds`/`turns`)
 * whose `durationAnchor` matches the event. Legacy scale-less effects,
 * manual scales (`minutes`/`hours`/`days`/`permanent`/`other`), deferred
 * anchors and `disabled` flags are never processed by the engine (disabled
 * affects change application, not the duration clock — no approved rule
 * pauses it).
 *
 * @param {Combat} combat - The combat encounter the transition belongs to.
 * @param {object} event - One of:
 *   { kind: "turn-begin"|"turn-end", combatantId } — the individual turn
 *   edge of one combatant (T5.1), or
 *   { kind: "round-end", round } — the system's confirmed round transition.
 * @returns {Promise<object>} Processing summary:
 *   { ok, event, discounted[], expired[], degraded[], skipped[], failures[] }.
 */
export async function processSw25DurationEvent(combat, event) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master client processes effect durations." };
  }
  if (!combat?.combatants) {
    return { ok: false, code: "no-combat", error: "No combat encounter was given to the duration engine." };
  }
  if (!event || !EVENT_KINDS.includes(event.kind)) {
    return { ok: false, code: "invalid-event", error: `Unknown duration event kind "${String(event?.kind)}" (approved: ${EVENT_KINDS.join(", ")}).` };
  }
  const summary = {
    ok: true,
    event,
    discounted: [],
    expired: [],
    degraded: [],
    skipped: [],
    failures: []
  };
  if (event.kind === "round-end") await processRoundEnd(combat, event, summary);
  else await processTurnEdge(combat, event, summary);
  // D10 technical level: a compact trace of what the engine did.
  if (summary.discounted.length || summary.expired.length || summary.degraded.length || summary.failures.length) {
    console.log("Sword World 2.5 | Duration engine summary.", summary);
  }
  return summary;
}
