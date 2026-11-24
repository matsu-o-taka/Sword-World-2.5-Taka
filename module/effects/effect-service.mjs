// Sword World 2.5 - EffectService (T2.1): the only authorized write path for
// the system's persistent ActiveEffects (DEC-36).
//
// Every create/modify/delete of the system's `sw25Effect` documents goes
// through this service: `apply`, `remove`, `toggle`, `refresh`. Interfaces and
// automations REQUEST operations; they never write ActiveEffects directly
// (DEC-36 + §8.4 of the research report). Player clients do not write at all:
// their requests travel through the GM relay (module/effects/effect-relay.mjs)
// and the designated GM executes them here with GM authority.
//
// Authority model (DEC-36):
//   - Writes are executed by the designated GM (direct authority) — the
//     service keeps its own `not-gm` gate as defense in depth, exactly like
//     the Monster Knowledge registry service.
//   - EffectService is the ONLY writer of `sw25Effect` documents, for GM and
//     non-GM alike: every persistent write goes through the module-private
//     write-authorization window below (active ONLY during the awaited write
//     call of a service-owned operation — never a global or permanent
//     exception). The write guard registered by `initializeEffectService`
//     rejects every direct write of a system effect attempted outside the
//     service, INCLUDING manual GM edits through document APIs or the sheet:
//     GM authority decides WHO may execute an operation, not WHETHER a write
//     may bypass the service. The T1.3 repair layer delegates its document
//     write to `performSw25EffectRepairWrite` for the same reason.
//   - Reads NEVER pass through the GM: `listSw25Effects` / `getSw25Effect`
//     work on any client without the relay (DEC-36; T2.5).
//
// Contracts respected from Block 1:
//   - Schema + normalization: every payload written here is first run through
//     `normalizeSw25EffectSystem` (T1.3); unrecoverable payloads are REJECTED
//     at the source instead of being persisted for later repair (DEC-41:
//     nothing silently modified, nothing invalid persisted).
//   - Identity: `family` (+ `rank` hierarchy) is the only stacking identity;
//     no `stackKey`, no duplicated `canonicalName` is ever persisted (DEC-1,
//     DEC-16, DEC-49). The canonical name stays presentation-only.
//   - Success Value: `apply` requires the casting context (DEC-6, DEC-50) —
//     see `resolveSw25CastSuccessValue` and the module contract comment below.
//   - Stacking: the central stacking resolver (Bloque 4) is a REGISTERABLE
//     EXTENSION POINT (`registerSw25StackingResolver`, wired from sw25.mjs
//     init with module/effects/stacking-resolver.mjs). `apply` consults it
//     BEFORE any write and executes its decision: "accumulate" creates the
//     new effect; "replace" is one transactional plan (create first, then
//     delete the replaced ids, rollback the create if the delete fails);
//     "refused"/"unresolved" write nothing; "choice-required" collects the
//     target's decision (a decision provider or the payload's
//     `acceptReplace`) BEFORE writing anything. With no resolver registered
//     the documented default is "accumulate": nothing is invented here.
//
// No queues, no automatic retries, no local fallback writes (DEC-36): the
// relay owns the transport contract; this service owns the document writes.

import { normalizeSw25EffectSystem } from "./effect-repair.mjs";
import { buildSw25CanonicalName } from "./effect-identity.mjs";
import {
  SW25_EFFECT_SUBTYPE,
  SW25_DURATION_SCALES,
  SW25_COMBAT_DURATION_SCALES,
  SW25_TIME_DURATION_SCALES,
  SW25_TIME_SCALE_UNIT_MINUTES,
  SW25_COMBAT_ENTRY_THRESHOLD_MINUTES,
  SW25_ROUNDS_PER_MINUTE,
  SW25_SECONDS_PER_ROUND,
  SW25_ANCHOR_REGIMES,
  SW25_ANCHOR_EDGES,
  SW25_ANCHOR_STATES,
  SW25_SUCCESS_VALUE_SOURCES,
  SW25_EFFECT_SCOPES
} from "./effect-model.mjs";
import { prepareSw25EffectRows } from "./effects-tab.mjs";
import { normalizeSw25RuleElements } from "./rule-elements.mjs";

/** Operations the service implements (relay + report vocabulary). */
export const SW25_EFFECT_OPERATIONS = ["apply", "remove", "toggle", "refresh", "set-duration"];

/** Approved rank range (DEC-16 table: 1..10, 0 = no numeral). */
const RANK_MIN = 0;
const RANK_MAX = 10;

// ── resolveStacking extension point (Bloque 4 plugs in here) ────────────────

/**
 * Currently registered stacking resolver (null until Bloque 4 registers one).
 * @type {Function|null}
 */
let stackingResolver = null;

/**
 * Register the central stacking resolver (Bloque 4). Passing null clears it.
 *
 * The production resolver is `resolveSw25Stacking`
 * (module/effects/stacking-resolver.mjs), registered from sw25.mjs init. Its
 * decision contract ({ outcome: "accumulate"|"replace"|"refused"|
 * "choice-required"|"unresolved", replaceIds?, durations?, choice? }) is
 * documented on that module; this service is the only executor of the
 * decision. With no resolver registered the documented default is
 * "accumulate".
 *
 * @param {Function|null} resolver - The resolver, or null to clear.
 * @returns {void}
 */
export function registerSw25StackingResolver(resolver) {
  stackingResolver = typeof resolver === "function" ? resolver : null;
}

/**
 * Currently registered stacking resolver (or null; diagnostics/tests).
 * @returns {Function|null}
 */
export function getSw25StackingResolver() {
  return stackingResolver;
}

/**
 * Consult the stacking extension point (Bloque 4). Passes through the full
 * decision object of the registered resolver; without a resolver the
 * documented default is `{ outcome: "accumulate" }` (DEC-2 default for a new
 * application — no per-effect flags, no invention). A resolver failure or a
 * shapeless decision is surfaced as an explicit refusal: nothing is written
 * on an undecidable state.
 * @param {object} context - { actor, application, existing }
 * @returns {object} The stacking decision: { outcome, code?, error?, policy?,
 *   replaceIds?, durations?, choice? }.
 */
function consultStacking(context) {
  if (!stackingResolver) return { outcome: "accumulate" };
  try {
    const decision = stackingResolver(context);
    if (decision && typeof decision.outcome === "string") return decision;
    return { outcome: "refused", code: "invalid-stacking-decision", error: "The stacking resolver returned no outcome." };
  } catch (error) {
    return { outcome: "refused", code: "stacking-resolver-failed", error: String(error?.message ?? error) };
  }
}

// ── Casting context and Success Value (DEC-6, DEC-50) ───────────────────────

/**
 * Derive the Success Value from the casting context (DEC-6).
 *
 * Casting-context contract (T2.4) — `apply` accepts EXACTLY ONE of:
 *   - `cast: { successValue: <integer >= 0> }` — the SV already calculated by
 *     the casting process (the future casting flow's source of truth).
 *   - `cast: { mode: "minor" }` — no Magic Power roll is made; the SV is
 *     automatically 0 (DEC-6/DEC-50). No other component may accompany it.
 *   - `cast: { mode: "major", dieTotal: <2..12>, magicPower: <integer> }` —
 *     the SV is the 2d6 result plus the Magic Power used; a natural 12 is a
 *     critical success: `SV = 12 + 5 + magicPower` (DEC-6).
 *
 * Mixing a direct `successValue` with mode components is ambiguous and is
 * rejected rather than guessed. SV 0 is a legitimate, persisted value
 * (minor-action casting, DEC-6). The casting context itself (mode, die,
 * magic power) belongs to the casting process, NOT to the persisted effect
 * schema (DEC-50): only the derived `successValue` is written.
 *
 * @param {*} cast - The casting context provided by the caller.
 * @returns {{ok: boolean, successValue?: number, code?: string, error?: string}}
 */
export function resolveSw25CastSuccessValue(cast) {
  if (!cast || typeof cast !== "object" || Array.isArray(cast)) {
    return { ok: false, code: "no-cast-context", error: "apply requires a casting context: { successValue } or { mode, dieTotal, magicPower } (DEC-6/DEC-50)." };
  }
  const hasDirect = cast.successValue !== undefined && cast.successValue !== null;
  const hasMode = cast.mode !== undefined;
  if (hasDirect && hasMode) {
    return { ok: false, code: "ambiguous-cast", error: "The casting context mixes a direct successValue with mode components; provide exactly one form." };
  }
  if (hasDirect) {
    const value = cast.successValue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return { ok: false, code: "invalid-success-value", error: "successValue must be an integer >= 0 (SV 0 is legitimate for minor-action casting)." };
    }
    return { ok: true, successValue: value };
  }
  if (!hasMode) {
    return { ok: false, code: "no-cast-context", error: "The casting context needs either a direct successValue or a casting mode (DEC-6/DEC-50)." };
  }
  if (cast.mode === "minor") {
    if (cast.dieTotal !== undefined || cast.magicPower !== undefined) {
      return { ok: false, code: "ambiguous-cast", error: "A minor-action casting makes no Magic Power roll (DEC-50); dieTotal/magicPower are not accepted." };
    }
    return { ok: true, successValue: 0 };
  }
  if (cast.mode === "major") {
    const { dieTotal, magicPower } = cast;
    if (typeof dieTotal !== "number" || !Number.isInteger(dieTotal) || dieTotal < 2 || dieTotal > 12) {
      return { ok: false, code: "invalid-cast", error: "A major-action casting needs an integer dieTotal between 2 and 12 (the natural 2d6 result)." };
    }
    if (typeof magicPower !== "number" || !Number.isInteger(magicPower)) {
      return { ok: false, code: "invalid-cast", error: "A major-action casting needs an integer magicPower (the Magic Power used for the casting)." };
    }
    // DEC-6: natural 12 is a critical success; SV = 12 + 5 + Magic Power.
    const critical = dieTotal === 12;
    return { ok: true, successValue: dieTotal + (critical ? 5 : 0) + magicPower };
  }
  return { ok: false, code: "invalid-cast", error: `Unknown casting mode "${String(cast.mode)}" (approved modes: "major", "minor").` };
}

/**
 * Provenance of the Success Value derived from the casting context (T6.1,
 * DEC-7; SW25_SUCCESS_VALUE_SOURCES). A checked major cast records `check`
 * (or `automatic` on a natural 12, whose +5 is already inside the SV); a
 * no-check minor/preparation cast records `none`. A DIRECT `successValue`
 * carries no derivable provenance: the caller must declare it explicitly
 * through the application payload's `successValueSource`, otherwise the value
 * stays "not recorded" (null) and forced removal re-determines it at
 * cancellation time (CR I p. 167) instead of guessing.
 * @param {*} cast - The casting context provided by the caller.
 * @returns {string|null}
 */
export function resolveSw25CastSuccessValueSource(cast) {
  if (!cast || typeof cast !== "object" || Array.isArray(cast)) return null;
  if (cast.mode === "minor") return "none";
  if (cast.mode === "major") return cast.dieTotal === 12 ? "automatic" : "check";
  return null;
}

// ── Write authorization: EffectService is the only writer (DEC-36) ──────────
//
// Module-private authorization window. `serviceWriteDepth` is incremented
// ONLY while a service-owned write is in flight (apply/remove/toggle/refresh
// and the delegated T1.3 repair write) and restored in `finally`, so the
// exception is strictly scoped to the corresponding write operation: it is
// never global, never permanent, and no other module can obtain it (this
// module exports no way to raise the counter). The write guard below consults
// it; every direct write found outside the window is cancelled, even when
// initiated by the GM.

let serviceWriteDepth = 0;

/**
 * Run one write executor inside the service's write-authorization window.
 * The window closes as soon as the awaited write settles (success or error).
 * @param {Function} executor - Async write call (Foundry document API).
 * @returns {Promise<*>} The executor's result.
 */
async function runAuthorizedServiceWrite(executor) {
  serviceWriteDepth += 1;
  try {
    return await executor();
  } finally {
    serviceWriteDepth = Math.max(0, serviceWriteDepth - 1);
  }
}

/**
 * Whether an EffectService-owned write is currently in flight on this client.
 * (Module-private state; exposed for the guard and tests.)
 * @returns {boolean}
 */
export function isSw25EffectServiceWriteActive() {
  return serviceWriteDepth > 0;
}

// ── Write guard: no direct writes outside the service ───────────────────────

/**
 * Write guard for the system's effect subtype (DEC-36).
 *
 * Registered on `preCreateActiveEffect` / `preUpdateActiveEffect` /
 * `preDeleteActiveEffect` by `initializeEffectService`. It ONLY guards the
 * system's `sw25Effect` subtype: native effects of other subtypes (conditions
 * and core features) are untouched for compatibility.
 *
 * Result: a direct write of a system effect is accepted ONLY while a
 * service-owned write is in flight (the service's own operations and the
 * delegated T1.3 repair write). Every other direct write — by a player AND by
 * the GM through document APIs or sheet editing — is rejected (the write is
 * cancelled): EffectService is the single persistent write path, and GM
 * authority governs who executes operations, not whether the service may be
 * bypassed. Player code must request operations through the GM relay.
 *
 * @param {object} document - The effect document the hook reports.
 * @param {object} [change] - Change payload (update/create hooks).
 * @param {object} [options] - Foundry write options.
 * @param {string|null} [userId] - Requesting user id (hook parameter).
 * @returns {boolean} false cancels the write.
 */
export function guardSw25EffectWrite(document, change, options, userId) {
  if (!document || document.type !== SW25_EFFECT_SUBTYPE) return true;
  if (serviceWriteDepth > 0) return true; // EffectService-owned write in flight
  const name = document?.name ?? "?";
  console.warn(`Sword World 2.5 | Rejected a direct write of effect "${name}" outside EffectService: system effects are written only through EffectService (DEC-36); request the operation via the GM relay or the service API.`);
  if (globalThis.ui?.notifications?.warn) {
    globalThis.ui.notifications.warn("Effects are persistent system data: request the operation instead of writing it directly.");
  }
  return false;
}

/**
 * Register the effect write guards on this client. Wired from sw25.mjs
 * (`Hooks.once("ready", initializeEffectService)`) and directly callable in
 * tests. Runs on EVERY client: all direct writes of system effects outside
 * the service's authorization window are rejected there.
 * @returns {void}
 */
export function initializeEffectService() {
  if (typeof Hooks?.on === "function") {
    Hooks.on("preCreateActiveEffect", guardSw25EffectWrite);
    Hooks.on("preUpdateActiveEffect", guardSw25EffectWrite);
    Hooks.on("preDeleteActiveEffect", guardSw25EffectWrite);
    // T5.5: end-of-combat disposition of combat-lifecycle duration effects
    // (rounds / turns) when a Combat document is deleted (endCombat,
    // programmatic delete, etc.): rounds with ≥ 6 remaining rounds are
    // converted to manual minutes (both counters = remaining / 6, exact) and
    // preserved; the rest are removed. Fires on all clients;
    // purgeSw25CombatDurationEffects gates writes on GM.
    Hooks.on("deleteCombat", async () => {
      if (game?.user?.isGM !== true) return;
      const result = await purgeSw25CombatDurationEffects();
      if (result.code === "partial") {
        console.warn("[SW25 EffectService] Combat-end purge completed with errors:", result.errors);
      }
    });
    console.log("[SW25 EffectService] write guards registered");
  }
}

// ── Validation helpers ─────────────────────────────────────────────────────

/** Result shape of every operation: { ok, code, ... } — failures never throw. */

function notGmResult() {
  return { ok: false, code: "not-gm", error: "Only the Game Master can execute effect operations." };
}

function notActorResult() {
  return { ok: false, code: "no-actor", error: "No actor was given for the effect operation." };
}

/**
 * Validate a rank against the approved table (DEC-16: 0..10).
 * @param {*} rank - Candidate rank.
 * @returns {string|null} Rejection code, or null when valid.
 */
function rankRejection(rank) {
  if (rank === undefined || rank === null) return null; // default 0 applies
  if (typeof rank !== "number" || !Number.isInteger(rank) || rank < RANK_MIN || rank > RANK_MAX) {
    return "invalid-rank";
  }
  return null;
}

/**
 * Validate optional round-managed duration bookkeeping (DEC-23).
 * @param {object} application - Validated application payload.
 * @returns {string|null} Rejection code, or null when valid.
 */
function durationRejection(application) {
  const { initialDuration, remainingDuration } = application;
  for (const value of [initialDuration, remainingDuration]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return "invalid-duration";
  }
  if (typeof initialDuration === "number" && typeof remainingDuration === "number" && remainingDuration > initialDuration) {
    return "invalid-duration";
  }
  return null;
}

/**
 * Validate the optional authored `sourceDuration` identity (Phase 3
 * corrections): shape-level only. null/absent is the normal case; when
 * present it must be `{ unit: non-blank string, amount: positive finite
 * number }`. WHICH units are meaningful is the rules layer's question
 * (spell-effects.mjs writes "seconds" today); the service transports it.
 * @param {*} sourceDuration - Candidate payload field.
 * @returns {string|null} Rejection code, or null when valid.
 */
function sourceDurationRejection(sourceDuration) {
  if (sourceDuration === undefined || sourceDuration === null) return null;
  if (typeof sourceDuration !== "object" || Array.isArray(sourceDuration)) return "invalid-source-duration";
  const { unit, amount } = sourceDuration;
  if (typeof unit !== "string" || unit.trim() === "") return "invalid-source-duration";
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return "invalid-source-duration";
  return null;
}

/**
 * Normalized `sourceDuration` for the persisted system payload: the approved
 * two-key shape or null (an absent field is never invented).
 * @param {*} sourceDuration - Validated payload field.
 * @returns {{unit: string, amount: number}|null}
 */
function normalizeSourceDurationField(sourceDuration) {
  if (sourceDuration === undefined || sourceDuration === null) return null;
  if (typeof sourceDuration !== "object" || Array.isArray(sourceDuration)) return null;
  const { unit, amount } = sourceDuration;
  if (typeof unit !== "string" || unit.trim() === ""
    || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  return { unit: unit.trim(), amount };
}

/**
 * Validate the native `changes` entries at the source. Structure-level only:
 * the semantic catalog (EFFECT_TARGETS) arrives with Bloque 3 (DEC-27/28).
 * @param {*} changes - Candidate changes array.
 * @returns {string|null} Rejection code, or null when valid.
 */
function changesRejection(changes) {
  if (changes === undefined || changes === null) return null;
  if (!Array.isArray(changes)) return "invalid-changes";
  for (const change of changes) {
    if (!change || typeof change !== "object" || Array.isArray(change)) return "invalid-changes";
    if (typeof change.key !== "string" || change.key.trim() === "") return "invalid-changes";
    if (change.value === undefined) return "invalid-changes";
  }
  return null;
}

/**
 * Validate the optional `familyPolicy` flow field (Bloque 4): structural only
 * (a non-blank string when present). Which policy ids exist is the resolver's
 * semantic question: an unknown id resolves to `unresolved` there, never to a
 * silent accumulation.
 * @param {object} application - Application payload.
 * @returns {string|null} Rejection code, or null when valid.
 */
function familyPolicyRejection(application) {
  const { familyPolicy } = application;
  if (familyPolicy === undefined || familyPolicy === null) return null;
  if (typeof familyPolicy !== "string" || familyPolicy.trim() === "") return "invalid-family-policy";
  return null;
}

/**
 * Validate the optional `damageType` flow field (DEC-9/DEC-20): an object
 * with optional non-blank string `nature`/`attribute` when present.
 * @param {object} application - Application payload.
 * @returns {string|null} Rejection code, or null when valid.
 */
function damageTypeRejection(application) {
  const { damageType } = application;
  if (damageType === undefined || damageType === null) return null;
  if (!damageType || typeof damageType !== "object" || Array.isArray(damageType)) return "invalid-damage-type";
  for (const key of ["nature", "attribute"]) {
    const value = damageType[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.trim() === "") return "invalid-damage-type";
  }
  return null;
}

function normalizeChanges(changes) {
  if (!Array.isArray(changes)) return [];
  return changes.map(change => ({
    key: change.key.trim(),
    ...(change.type !== undefined ? { type: change.type } : {}),
    value: change.value,
    ...(change.phase !== undefined ? { phase: change.phase } : {}),
    ...(change.priority !== undefined ? { priority: change.priority } : {})
  }));
}

/**
 * Build the persisted `system.damageType` value (DEC-9) from the validated
 * application field: null when absent or fully empty, otherwise the approved
 * two-key shape with trimmed values.
 * @param {*} damageType - Validated candidate { nature?, attribute? }.
 * @returns {{nature: string|null, attribute: string|null}|null}
 */
function normalizeDamageType(damageType) {
  if (!damageType || typeof damageType !== "object" || Array.isArray(damageType)) return null;
  const nature = typeof damageType.nature === "string" && damageType.nature.trim() !== "" ? damageType.nature.trim() : null;
  const attribute = typeof damageType.attribute === "string" && damageType.attribute.trim() !== "" ? damageType.attribute.trim() : null;
  if (nature === null && attribute === null) return null;
  return { nature, attribute };
}

/**
 * Validate the optional `durationScale` flow field (Bloque 5, T5.2): a
 * non-blank approved scale id when present (effect-model.mjs
 * SW25_DURATION_SCALES). The scale is never inferred from the durations: an
 * application without it stays a legacy one and keeps working.
 * @param {object} application - Application payload.
 * @returns {string|null} Rejection code, or null when valid.
 */
function durationScaleRejection(application) {
  const { durationScale } = application;
  if (durationScale === undefined || durationScale === null) return null;
  if (typeof durationScale !== "string" || durationScale.trim() === "") return "invalid-duration-scale";
  if (!SW25_DURATION_SCALES.includes(durationScale.trim())) return "invalid-duration-scale";
  return null;
}

/**
 * Validate the optional `durationAnchor` flow field (Bloque 5, T5.2; D4/D5,
 * T5.0-R §3.3/§3.5) and its consistency with `durationScale`:
 *
 *   - An application on a COMBAT scale (`rounds`/`turns`) without an anchor is
 *     rejected (`anchor-required`) — D4: an unresolvable anchor identity
 *     rejects the application instead of persisting an unusable effect.
 *   - An anchor on a MANUAL scale (or without any scale) is rejected
 *     (`anchor-not-required`): manual scales never carry combat anchors.
 *   - An explicitly `deferred` anchor is rejected in ordinary applications
 *     (`anchor-deferred`): the deferred state is RESERVED for the future
 *     preparation flow (T5.0-R §3.5) and must not become a general fallback
 *     that bypasses D4.
 *   - A `resolved` anchor requires a `combatantId` (`invalid-anchor`):
 *     casterTurn/targetTurn anchors are per-combatant identities (two tokens
 *     of the same Actor are independent combatants). A `roundEnd` anchor may
 *     omit the identity: the regime decrements at every round end, so the
 *     combatant is provenance only.
 *   - The origin ACTOR identity is not part of the anchor payload: its
 *     canonical representation is `casterUUID` (casterTurn/roundEnd) or the
 *     effect's parent Actor (targetTurn).
 *
 * @param {object} application - Application payload (scale already validated).
 * @returns {string|null} Rejection code, or null when valid.
 */
function durationAnchorRejection(application) {
  const scale = typeof application.durationScale === "string" && application.durationScale.trim() !== ""
    ? application.durationScale.trim() : null;
  const anchor = application.durationAnchor;
  if (anchor === undefined || anchor === null) {
    return scale && SW25_COMBAT_DURATION_SCALES.includes(scale) ? "anchor-required" : null;
  }
  const shape = anchorShapeRejection(anchor);
  if (shape) return shape;
  // Scale compatibility: an anchor only makes sense on a combat scale.
  if (!scale || !SW25_COMBAT_DURATION_SCALES.includes(scale)) return "anchor-not-required";
  return null;
}

/**
 * Shape validation of one `durationAnchor` value, shared by `apply` (T5.2)
 * and the `refresh` anchor patch (T5.3, D5 degradation write path): regime,
 * edge, state and identity keys. Scale compatibility is NOT checked here —
 * the caller knows the scale being written against.
 * @param {*} anchor - Candidate anchor value.
 * @returns {string|null} Rejection code ("invalid-anchor" | "anchor-deferred"), or null when valid.
 */
function anchorShapeRejection(anchor) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return "invalid-anchor";
  const { regime, edge, state, combatantId, tokenId } = anchor;
  if (typeof regime !== "string" || regime.trim() === "" || !SW25_ANCHOR_REGIMES.includes(regime.trim())) {
    return "invalid-anchor";
  }
  if (edge !== undefined && edge !== null
    && (typeof edge !== "string" || edge.trim() === "" || !SW25_ANCHOR_EDGES.includes(edge.trim()))) {
    return "invalid-anchor";
  }
  if (tokenId !== undefined && tokenId !== null
    && (typeof tokenId !== "string" || tokenId.trim() === "")) {
    return "invalid-anchor";
  }
  if (state !== undefined && state !== null) {
    if (typeof state !== "string" || state.trim() === "" || !SW25_ANCHOR_STATES.includes(state.trim())) {
      return "invalid-anchor";
    }
    if (state.trim() === "deferred") {
      // Reserved for the future preparation flow (T5.0-R §3.5); ordinary
      // applications and engine writes must resolve the anchor combatant (D4).
      return "anchor-deferred";
    }
  }
  // "resolved" (explicit or by default): the combatant identity is mandatory
  // for casterTurn/targetTurn; optional for roundEnd.
  const needsCombatant = regime.trim() !== "roundEnd";
  const hasCombatant = typeof combatantId === "string" && combatantId.trim() !== "";
  if (needsCombatant && !hasCombatant) return "invalid-anchor";
  if (hasCombatant && typeof combatantId !== "string") return "invalid-anchor";
  return null;
}

/**
 * Validate an anchor PATCH for `refresh` (T5.3): the same shape rules as
 * `apply`, but the scale comes from the EFFECT's persisted `durationScale` —
 * an anchor is only meaningful on a combat-scale effect (D4/D5).
 * @param {object} effect - The effect document being refreshed.
 * @param {*} anchor - Candidate anchor patch value.
 * @returns {string|null} Rejection code, or null when valid.
 */
function durationAnchorPatchRejection(effect, anchor) {
  const shape = anchorShapeRejection(anchor);
  if (shape) return shape;
  const scale = typeof effect.system?.durationScale === "string" && effect.system.durationScale.trim() !== ""
    ? effect.system.durationScale.trim() : null;
  if (!scale || !SW25_COMBAT_DURATION_SCALES.includes(scale)) return "anchor-not-required";
  return null;
}

/**
 * Validate the DEC-23 counter bookkeeping of a `rounds`-scale application
 * (T5.3, open question 5.1): `rounds` is a COUNTED combat scale, so an
 * application without a positive integer initial counter is unprocessable by
 * the duration engine and is rejected instead of persisting an unusable
 * effect (same philosophy as D4 for anchors). No implicit duration is ever
 * assigned; `turns` (condition scale) and the manual scales never require a
 * counter.
 * @param {object} application - Application payload.
 * @returns {string|null} Rejection code, or null when valid.
 */
function roundsCounterRejection(application) {
  const scale = typeof application.durationScale === "string" && application.durationScale.trim() !== ""
    ? application.durationScale.trim() : null;
  if (scale !== "rounds") return null;
  const initial = application.initialDuration;
  if (typeof initial !== "number" || !Number.isInteger(initial) || initial < 1) {
    return "rounds-counter-required";
  }
  return null;
}

/**
 * Reject any attempt to drive the effect through the NATIVE duration engine
 * at application time (Bloque 5, T5.2; D1/D6/D11): a system effect must never
 * populate the native document `duration` with a finite `value` or an
 * `expiry` — that is what makes the native registry treat it as temporary and
 * expire it (the verified v14 `isTemporary` barrier). `duration.units` and
 * the other native duration fields stay allowed (presentation/inert data).
 * @param {*} duration - The application's native `duration` payload, if any.
 * @returns {string|null} Rejection code, or null when safe.
 */
function nativeDurationRejection(duration) {
  if (duration === undefined || duration === null) return null;
  if (typeof duration !== "object" || Array.isArray(duration)) return null; // rejected later by the schema
  if (duration.expiry !== undefined && duration.expiry !== null) return "native-duration-forbidden";
  if (duration.value !== undefined && duration.value !== null) {
    const numeric = typeof duration.value === "number" ? duration.value : Number(duration.value);
    if (Number.isFinite(numeric)) return "native-duration-forbidden";
  }
  return null;
}

/** Rejection messages for the `durationAnchor` validation (T5.2). */
const DURATION_ANCHOR_ERRORS = {
  "anchor-required": "The application's duration scale (rounds/turns) requires a combat anchor: apply with durationAnchor = { regime, combatantId (and optional tokenId/edge) }. A deferred anchor is reserved for the future preparation flow and cannot be used as a fallback (D4, T5.2).",
  "anchor-not-required": "durationAnchor is only meaningful on a combat duration scale (rounds/turns); manual scales (minutes/hours/days/permanent/other) and scale-less legacy applications never carry an anchor.",
  "anchor-deferred": "The deferred anchor state is reserved for the future preparation flow (T5.0-R §3.5); ordinary applications must resolve the anchor combatant (D4).",
  "invalid-anchor": "durationAnchor must be { regime (casterTurn|targetTurn|roundEnd), edge? (begin|end), combatantId?, tokenId?, state? } with a non-blank combatantId for casterTurn/targetTurn anchors (two tokens of the same Actor are independent combatants)."
};

/**
 * Build the persisted `system.durationAnchor` value (Bloque 5, T5.2) from the
 * validated application field: null when absent, otherwise the approved
 * five-key shape with trimmed values and the approved defaults applied
 * (`edge` "begin", `state` "resolved") so the payload normalizes cleanly.
 * @param {*} anchor - Validated candidate anchor.
 * @returns {{regime: string, edge: string, combatantId: string|null,
 *   tokenId: string|null, state: string}|null}
 */
function normalizeDurationAnchor(anchor) {
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return null;
  const trim = value => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  return {
    regime: anchor.regime.trim(),
    edge: trim(anchor.edge) ?? "begin",
    combatantId: trim(anchor.combatantId),
    tokenId: trim(anchor.tokenId),
    state: trim(anchor.state) ?? "resolved"
  };
}

/**
 * Collect the target's decision for a `choice-required` stacking outcome
 * (DEC-3 step 3 / DEC-22). UI-independent: the decision comes from the
 * injected async provider (`decide`, used by the T4.3 dialog) or from the
 * payload's `acceptReplace` field; without either the application stays
 * PENDING with its choice data — no write, no implicit acceptance (DEC-44:
 * no silent outcomes).
 * @param {object} stacking - The resolver's `choice-required` decision.
 * @param {object} payload - The application payload.
 * @param {Function} [decide] - Async decision provider.
 * @returns {Promise<{abort: boolean, result?: object}>}
 */
async function resolveStackingChoiceDecision(stacking, payload, decide) {
  if (typeof decide === "function") {
    let answer;
    try {
      answer = await decide(stacking.choice ?? null);
    } catch (error) {
      return { abort: true, result: { ok: false, code: "decision-failed", error: `The stacking decision could not be collected: ${String(error?.message ?? error)}` } };
    }
    if (answer === true) return { abort: false };
    if (answer === false) return { abort: true, result: replaceDiscardedResult() };
    return { abort: true, result: { ok: false, code: "invalid-decision", error: "The decision provider must resolve to true (accept the new application) or false (keep the previous one)." } };
  }
  if (payload.acceptReplace === true) return { abort: false };
  if (payload.acceptReplace === false) return { abort: true, result: replaceDiscardedResult() };
  return {
    abort: true,
    result: {
      ok: false,
      code: "choice-required",
      choice: stacking.choice ?? null,
      error: `The stacking rules require a decision before this effect can be applied (${stacking.code ?? "conflict"}); nothing was written. Re-apply with a decision (acceptReplace or a decision provider) to proceed.`
    }
  };
}

function replaceDiscardedResult() {
  return { ok: false, code: "replace-discarded", error: "The decision kept the previous effect: the new application was discarded whole, without any write (DEC-3)." };
}

// ── The four operations ────────────────────────────────────────────────────

/**
 * `apply`: create one persistent `sw25Effect` on the actor (GM authority).
 *
 * The payload is normalized with the T1.3 normalizer BEFORE the write; an
 * application that would produce review-level data is rejected at the source
 * (`invalid-application`) instead of persisting invalid data (DEC-41). The
 * stacking extension point is consulted first; the documented default (no
 * Bloque 4 resolver yet) is "accumulate".
 *
 * @param {Actor} actor - The actor receiving the effect.
 * @param {object} application - Application payload:
 *   family (required, non-blank string), rank (0..10, default 0), cast
 *   (casting context — see `resolveSw25CastSuccessValue`), changes
 *   (optional native change entries), initialDuration / remainingDuration
 *   (optional round bookkeeping, DEC-23), img, effectType, origin,
 *   casterUUID (optional provenance), familyPolicy (optional stacking policy
 *   id; absent means "spell", DEC-3), damageType (optional {nature,
 *   attribute}, DEC-9), isMagical (optional boolean cancellation eligibility
 *   flag; null/absent legacy input defaults to false, DEC-7), resistance (optional emitting-effect
 *   resistance notation for cancellation eligibility, e.g. "cant", DEC-7),
 *   durationScale (optional approved scale id, T5.2 —
 *   never inferred from the durations), durationAnchor (optional combat
 *   anchor {regime, edge?, combatantId?, tokenId?, state?}, T5.2 — required
 *   for combat scales, per combatant; "deferred" reserved for preparation),
 *   duration (optional native document duration — must NOT carry a finite
 *   `value` or an `expiry` on a system effect, D1/D6/D11). T6.1 adds
 *   `successValueSource` (optional SV provenance id, DEC-7), `castId`
 *   (optional identity of one casting) and `effectScope` (optional target
 *   scope "space"/"all"/"limited", DEC-8). `acceptReplace`
 *   (optional boolean) carries the
 *   decision for a pending stacking choice (DEC-3) and is NEVER persisted.
 *   The document `name` is NOT accepted: it is always the canonical name
 *   derived from family + rank.
 * @param {object} [options]
 * @param {boolean} [options.notify] - Notify this client of the outcome.
 * @param {Function} [options.decide] - UI-independent async decision provider
 *   for `choice-required` outcomes (T4.3): called with the choice data and
 *   must resolve to true (accept the new application) or false (keep the
 *   previous). Without it, a pending choice is returned untouched.
 * @returns {Promise<{ok: boolean, code: string, effectId?: string,
 *   effectUuid?: string, successValue?: number, replacedIds?: string[],
 *   choice?: object, error?: string}>}
 */
export async function applySw25Effect(actor, application, { notify = false, decide = undefined } = {}) {
  if (game?.user?.isGM !== true) return notGmResult();
  if (!actor?.effects) return notActorResult();
  const payload = application && typeof application === "object" && !Array.isArray(application)
    ? application : null;
  if (!payload) {
    return { ok: false, code: "invalid-application", error: "No effect application payload was given." };
  }
  if (typeof payload.family !== "string" || payload.family.trim() === "") {
    return { ok: false, code: "invalid-family", error: "system.family is the only stacking identity (DEC-1) and is required: a non-blank family name." };
  }
  const rankProblem = rankRejection(payload.rank);
  if (rankProblem) {
    return { ok: false, code: rankProblem, error: `rank must be an integer between ${RANK_MIN} and ${RANK_MAX} (DEC-16 approved table).` };
  }
  const cast = resolveSw25CastSuccessValue(payload.cast);
  if (!cast.ok) {
    return { ok: false, code: cast.code, error: cast.error };
  }
  const durationProblem = durationRejection(payload);
  if (durationProblem) {
    return { ok: false, code: durationProblem, error: "initialDuration/remainingDuration must be integers >= 0, with remaining <= initial (DEC-23)." };
  }
  // Authored source duration identity (Phase 3 corrections): shape-level
  // transport validation; the units are the rules layer's business.
  const sourceDurationProblem = sourceDurationRejection(payload.sourceDuration);
  if (sourceDurationProblem) {
    return { ok: false, code: sourceDurationProblem, error: "sourceDuration, when present, must be { unit: non-blank string, amount: positive finite number }." };
  }
  const changesProblem = changesRejection(payload.changes);
  if (changesProblem) {
    return { ok: false, code: changesProblem, error: "changes must be an array of { key (non-blank string), value } entries; type/phase/priority are optional." };
  }
  const policyProblem = familyPolicyRejection(payload);
  if (policyProblem) {
    return { ok: false, code: policyProblem, error: "familyPolicy must be a non-blank string when present (the stacking policy id; absent means \"spell\", DEC-3)." };
  }
  const damageTypeProblem = damageTypeRejection(payload);
  if (damageTypeProblem) {
    return { ok: false, code: damageTypeProblem, error: "damageType must be an object with optional non-blank string nature/attribute when present (DEC-9)." };
  }
  // Configured rule elements (reusable effects architecture): validated
  // through the central registry, never by per-effect special cases. An absent
  // array means "no configured rules" and writes an empty array.
  const rules = normalizeSw25RuleElements(payload.rules);
  if (!rules.ok) {
    return { ok: false, code: rules.code, error: rules.error };
  }
  if (payload.isMagical !== undefined && payload.isMagical !== null && typeof payload.isMagical !== "boolean") {
    return { ok: false, code: "invalid-application", error: "isMagical must be a boolean when supplied; null/absent legacy values default to false (DEC-7 cancellation eligibility)." };
  }
  if (payload.resistance !== undefined && payload.resistance !== null
    && (typeof payload.resistance !== "string" || payload.resistance.trim() === "")) {
    return { ok: false, code: "invalid-application", error: "resistance, when present, must be a non-blank string (the emitting effect's resistance notation, DEC-7)." };
  }
  // T6.1/DEC-7: the Success Value provenance is validated as an approved id;
  // absent means "not recorded" and is never invented from the numeric value.
  if (payload.successValueSource !== undefined && payload.successValueSource !== null
    && !SW25_SUCCESS_VALUE_SOURCES.includes(payload.successValueSource)) {
    return { ok: false, code: "invalid-application", error: `successValueSource, when present, must be an approved provenance id (${SW25_SUCCESS_VALUE_SOURCES.join(", ")}); absent means "not recorded".` };
  }
  if (payload.castId !== undefined && payload.castId !== null
    && (typeof payload.castId !== "string" || payload.castId.trim() === "")) {
    return { ok: false, code: "invalid-application", error: "castId, when present, must be a non-blank string identifying one casting (DEC-7/DEC-8)." };
  }
  if (payload.effectScope !== undefined && payload.effectScope !== null
    && !SW25_EFFECT_SCOPES.includes(payload.effectScope)) {
    return { ok: false, code: "invalid-application", error: `effectScope, when present, must be an approved target scope id (${SW25_EFFECT_SCOPES.join(", ")}); absent means no recorded area selection mode.` };
  }
  const durationScaleProblem = durationScaleRejection(payload);
  if (durationScaleProblem) {
    return { ok: false, code: durationScaleProblem, error: `durationScale must be an approved scale id when present (${SW25_DURATION_SCALES.join(", ")}); it is never inferred from the durations (T5.2).` };
  }
  const durationAnchorProblem = durationAnchorRejection(payload);
  if (durationAnchorProblem) {
    return { ok: false, code: durationAnchorProblem, error: DURATION_ANCHOR_ERRORS[durationAnchorProblem] };
  }
  // Native isolation first (D1/D6/D11 is the more fundamental contract),
  // then the DEC-23 counter bookkeeping of the counted `rounds` scale.
  const nativeDurationProblem = nativeDurationRejection(payload.duration);
  if (nativeDurationProblem) {
    return { ok: false, code: nativeDurationProblem, error: "The native document duration must never carry a finite `value` or an `expiry` on a system effect (native isolation, D1/D6/D11): the system duration scale and anchor live in system.durationScale/durationAnchor; expiry processing belongs to the T5.3 engine." };
  }
  const roundsCounterProblem = roundsCounterRejection(payload);
  if (roundsCounterProblem) {
    return {
      ok: false,
      code: roundsCounterProblem,
      error: "The `rounds` duration scale is a COUNTED combat scale (DEC-23): the application must declare a positive integer initialDuration (remainingDuration, when present, must be an integer <= initial). A `rounds` effect without a counter is unprocessable by the duration engine and no implicit duration is assigned (T5.3, open question 5.1)."
    };
  }
  if (payload.acceptReplace !== undefined && typeof payload.acceptReplace !== "boolean") {
    return { ok: false, code: "invalid-application", error: "acceptReplace, when present, must be the boolean decision for a pending stacking choice (DEC-3)." };
  }

  // ── Central stacking resolution (Bloque 4) ─────────────────────────────
  // The resolver is consulted BEFORE any write, with an enriched application
  // view (the derived Success Value added so SV policies can compare without
  // duplicating the casting contract). Nothing is written until a COMPLETE
  // plan exists.
  const existing = [...actor.effects].filter(effect => effect.type === SW25_EFFECT_SUBTYPE);
  const stacking = consultStacking({
    actor,
    application: { ...payload, successValue: cast.successValue },
    existing
  });

  let replaceIds = [];
  let durations = null; // null → the application's own duration bookkeeping
  if (stacking.outcome === "accumulate") {
    // The application is created as its own new effect; nothing is replaced.
  } else if (stacking.outcome === "replace") {
    // Deterministic substitution (policy-approved): create the new effect,
    // then delete the replaced applications as one plan.
    replaceIds = [...(stacking.replaceIds ?? [])];
    durations = stacking.durations ?? null;
  } else if (stacking.outcome === "choice-required") {
    // DEC-3 step 3: the target decides BEFORE anything is written. The
    // decision arrives from the injected provider (UI-independent) or from
    // the payload's `acceptReplace`; without either the application stays
    // pending with its choice data — no write, no implicit acceptance.
    const decision = await resolveStackingChoiceDecision(stacking, payload, decide);
    if (decision.abort) return decision.result;
    replaceIds = [...(stacking.replaceIds ?? [])];
    durations = stacking.durations ?? null;
  } else {
    // "refused" and "unresolved": explicit no-write outcomes.
    return {
      ok: false,
      code: stacking.code ?? (stacking.outcome === "refused" ? "stacking-refused" : "stacking-unresolved"),
      error: stacking.error ?? `The stacking resolution ended with outcome "${stacking.outcome}"; nothing was written.`,
      ...(stacking.choice ? { choice: stacking.choice } : {})
    };
  }

  // Build the system payload and normalize it at the source (T1.3). A
  // replacement plan carries the resolver's merged durations (DEC-4/DEC-18);
  // without one the application's own bookkeeping applies.
  const effectiveDurations = durations ?? {
    initialDuration: payload.initialDuration ?? null,
    remainingDuration: payload.remainingDuration ?? null
  };
  // T5.3 (open question 5.1): DEC-23 completion for a fresh `rounds`
  // application — when an initial counter is declared without an explicit
  // remaining one, the remaining is stamped equal to the initial (a
  // just-applied effect still holds its whole duration). No duration is ever
  // INVENTED when none was declared: `rounds` without an initial counter is
  // rejected above, and legacy scale-less applications stay untouched.
  if (!durations
    && typeof payload.durationScale === "string" && payload.durationScale.trim() === "rounds"
    && typeof effectiveDurations.initialDuration === "number"
    && effectiveDurations.remainingDuration === null) {
    effectiveDurations.remainingDuration = effectiveDurations.initialDuration;
  }
  const rawSystem = {
    schemaVersion: undefined, // normalizer backfills the approved version
    family: payload.family,
    rank: payload.rank ?? 0,
    successValue: cast.successValue,
    // T6.1/DEC-7: the SV provenance comes from the explicit payload when the
    // caller knows it (a cast flow that already resolved its own check), and
    // otherwise from the casting context itself. It is never inferred from
    // the numeric value; a direct SV without either stays "not recorded".
    successValueSource: payload.successValueSource ?? resolveSw25CastSuccessValueSource(payload.cast),
    // T6.1/DEC-8: casting instance identity and target scope (area rule).
    castId: typeof payload.castId === "string" && payload.castId.trim() !== "" ? payload.castId.trim() : null,
    effectScope: typeof payload.effectScope === "string" && payload.effectScope.trim() !== "" ? payload.effectScope.trim() : null,
    initialDuration: effectiveDurations.initialDuration ?? null,
    remainingDuration: effectiveDurations.remainingDuration ?? null,
    casterUUID: typeof payload.casterUUID === "string" && payload.casterUUID.trim() !== "" ? payload.casterUUID.trim() : null,
    effectType: typeof payload.effectType === "string" && payload.effectType.trim() !== "" ? payload.effectType.trim() : null,
    // Cancellation eligibility (DEC-7/§55): the stored magical status is the
    // Dispel Magic gate. New effects always persist a boolean; absent/null
    // legacy input defaults to false (non-magical or unconfirmed).
    // `resistance` is source provenance only, NOT an eligibility condition.
    isMagical: typeof payload.isMagical === "boolean" ? payload.isMagical : false,
    resistance: typeof payload.resistance === "string" && payload.resistance.trim() !== "" ? payload.resistance.trim() : null,
    familyPolicy: typeof payload.familyPolicy === "string" && payload.familyPolicy.trim() !== "" ? payload.familyPolicy.trim() : null,
    damageType: normalizeDamageType(payload.damageType),
    // Bloque 5 (T5.2): the scale is never inferred from the durations; the
    // anchor is stamped only when the validation above accepted it.
    durationScale: typeof payload.durationScale === "string" && payload.durationScale.trim() !== "" ? payload.durationScale.trim() : null,
    durationAnchor: normalizeDurationAnchor(payload.durationAnchor),
    // Authored source duration identity (Phase 3 corrections): the normalized
    // two-key shape or null. No countdown semantics of its own — the
    // combat-entry flow reads it to offer the combat-equivalent conversion.
    sourceDuration: normalizeSourceDurationField(payload.sourceDuration),
    // Presentation visibility (gmOnly): an effect the system's own interfaces
    // show only to GM users. Nothing mechanical derives from it (the duration
    // engine and effective values read documents directly); see the schema
    // field documentation in effect-model.mjs.
    gmOnly: payload.gmOnly === true,
    rules: rules.rules,
    changes: normalizeChanges(payload.changes)
  };
  const { data, issues, futureVersion } = normalizeSw25EffectSystem(structuredClone(rawSystem));
  if (futureVersion || issues.some(issue => issue.severity === "review")) {
    // A freshly built payload must be clean; anything else is a caller bug.
    return { ok: false, code: "invalid-application", error: `The application payload does not normalize cleanly: ${issues.map(issue => issue.code).join(", ")}` };
  }

  const createData = { type: SW25_EFFECT_SUBTYPE, system: data };
  // The core ActiveEffect schema requires a non-undefined document name, and
  // it is ALWAYS the canonical name reconstructed from family + rank
  // (DEC-16/DEC-49): a `name` provided in the payload cannot override it, so
  // the native name can never disagree with the persisted identity. This is
  // the native `name` document label, not a duplicated canonicalName field;
  // the family/rank identity fields remain the only source of truth.
  createData.name = buildSw25CanonicalName(payload.family.trim(), payload.rank ?? 0) ?? payload.family.trim();
  if (typeof payload.img === "string" && payload.img !== "") createData.img = payload.img;
  if (typeof payload.origin === "string" && payload.origin !== "") createData.origin = payload.origin;
  if (payload.duration && typeof payload.duration === "object" && !Array.isArray(payload.duration)) {
    createData.duration = structuredClone(payload.duration);
  }
  // Flags are free-form document metadata (not part of the system schema).
  // The Concealed Main Section uses flags to persist the plaintext selection
  // record (`{ sectionId }`); the effect itself carries `system.gmOnly: true`,
  // so the system's own effect interfaces (Effects tab, inspector) hide it
  // from players. This is presentation-layer hiding: the document still
  // replicates to every client like any other ActiveEffect.
  if (payload.flags && typeof payload.flags === "object" && !Array.isArray(payload.flags)) {
    createData.flags = structuredClone(payload.flags);
  }

  try {
    const [created] = await runAuthorizedServiceWrite(() =>
      actor.createEmbeddedDocuments("ActiveEffect", [createData])
    );
    if (!created?.id) {
      // Foundry can resolve the create without a persisted document (e.g. a
      // rejected embedded document): that is a failed write, never an "applied".
      return { ok: false, code: "write-failed", error: "The effect document was not persisted (no created id)." };
    }
    // Replacement plan (DEC-3/DEC-4): the new effect is created FIRST, then
    // the replaced applications are deleted. If the delete fails, the NEW
    // effect is rolled back, so the actor ends either with the previous state
    // intact or with the replacement complete — never with BOTH coexisting
    // (the documented transient between the two awaits is only visible to the
    // executing GM client). Foundry v14 has no embedded-document transaction;
    // a delete that fails inside Foundry itself is reported, never silently
    // repaired (DEC-41).
    if (replaceIds.length) {
      try {
        await runAuthorizedServiceWrite(() => actor.deleteEmbeddedDocuments("ActiveEffect", replaceIds));
      } catch (deleteError) {
        try {
          await runAuthorizedServiceWrite(() => actor.deleteEmbeddedDocuments("ActiveEffect", [created.id]));
        } catch (rollbackError) {
          return {
            ok: false,
            code: "replace-rollback-failed",
            error: `The replacement delete failed (${String(deleteError?.message ?? deleteError)}) and the rollback failed too (${String(rollbackError?.message ?? rollbackError)}): the actor may carry both applications; manual repair is required.`
          };
        }
        return {
          ok: false,
          code: "replace-write-failed",
          error: `The replacement could not be completed (${String(deleteError?.message ?? deleteError)}): the previous application(s) were conserved and the new one was rolled back.`
        };
      }
    }
    if (notify) ui?.notifications?.info?.(`Effect applied: ${payload.family.trim()}.`);
    return {
      ok: true,
      code: "applied",
      effectId: created?.id ?? null,
      effectUuid: created?.uuid ?? null,
      successValue: cast.successValue,
      ...(replaceIds.length ? { replacedIds: [...replaceIds] } : {})
    };
  } catch (error) {
    return { ok: false, code: "write-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Find one of the actor's system effects by id (internal helper).
 * @param {Actor} actor - Owning actor.
 * @param {*} effectId - Effect id.
 * @returns {object|null} The `sw25Effect` document, or null.
 */
function findSw25Effect(actor, effectId) {
  if (typeof effectId !== "string" || effectId === "") return null;
  return [...actor.effects].find(effect => effect.type === SW25_EFFECT_SUBTYPE && effect.id === effectId) ?? null;
}

/**
 * `remove`: delete one persistent `sw25Effect` from the actor (GM authority).
 * Only the system's own subtype is managed; native effects of other subtypes
 * are outside the service's scope.
 * @param {Actor} actor - Owning actor.
 * @param {string} effectId - Id of the effect document to remove.
 * @param {object} [options]
 * @param {boolean} [options.notify] - Notify this client of the outcome.
 * @returns {Promise<{ok: boolean, code: string, error?: string}>}
 */
export async function removeSw25Effect(actor, effectId, { notify = false } = {}) {
  if (game?.user?.isGM !== true) return notGmResult();
  if (!actor?.effects) return notActorResult();
  const effect = findSw25Effect(actor, effectId);
  if (!effect) {
    return { ok: false, code: "no-effect", error: "No system effect with that id exists on the actor." };
  }
  try {
    const deleted = await runAuthorizedServiceWrite(() => effect.delete());
    // Foundry v14 resolves Document.delete() to undefined when a pre-delete
    // hook cancels the operation. That is not an exception, but it is still a
    // failed removal and must never be acknowledged as a deleted effect. If
    // the document is nevertheless absent, the deletion did persist (this
    // also preserves compatibility with document doubles returning undefined
    // after a successful deletion).
    if (!deleted && findSw25Effect(actor, effectId)) {
      return { ok: false, code: "write-failed", error: "The effect deletion was cancelled before it was persisted." };
    }
    if (notify) ui?.notifications?.info?.("Effect removed.");
    return { ok: true, code: "removed", effectId };
  } catch (error) {
    return { ok: false, code: "write-failed", error: String(error?.message ?? error) };
  }
}

/**
 * `toggle`: switch one persistent `sw25Effect` between active and disabled
 * (GM authority). Without an explicit target state the current state flips;
 * with `{ active: boolean }` the requested state is applied.
 * @param {Actor} actor - Owning actor.
 * @param {string} effectId - Id of the effect document to toggle.
 * @param {object} [options]
 * @param {boolean} [options.active] - Explicit target state (true = active).
 * @param {boolean} [options.notify] - Notify this client of the outcome.
 * @returns {Promise<{ok: boolean, code: string, disabled?: boolean, error?: string}>}
 */
export async function toggleSw25Effect(actor, effectId, { active = null, notify = false } = {}) {
  if (game?.user?.isGM !== true) return notGmResult();
  if (!actor?.effects) return notActorResult();
  const effect = findSw25Effect(actor, effectId);
  if (!effect) {
    return { ok: false, code: "no-effect", error: "No system effect with that id exists on the actor." };
  }
  const targetDisabled = active === true ? false : active === false ? true : effect.disabled !== true;
  try {
    await runAuthorizedServiceWrite(() => effect.update({ disabled: targetDisabled }));
    if (notify) ui?.notifications?.info?.(targetDisabled ? "Effect disabled." : "Effect activated.");
    return { ok: true, code: "toggled", effectId, disabled: targetDisabled };
  } catch (error) {
    return { ok: false, code: "write-failed", error: String(error?.message ?? error) };
  }
}

/**
 * `refresh`: update the live values of one persistent `sw25Effect` (GM
 * authority). Accepts a new Success Value (same casting-context contract as
 * `apply`), a new remaining duration in rounds (DEC-23), and — since T5.3 — a
 * full replacement `durationAnchor` (the D5 degradation write path used by
 * the duration engine: regime change to `roundEnd` with the combatant/token
 * identity kept as provenance). Only the provided fields are written; the
 * rest of the document is untouched.
 * @param {Actor} actor - Owning actor.
 * @param {string} effectId - Id of the effect document to refresh.
 * @param {object} patch - { cast?, successValue?, remainingDuration?,
 *   durationAnchor? }.
 * @param {object} [options]
 * @param {boolean} [options.notify] - Notify this client of the outcome.
 * @returns {Promise<{ok: boolean, code: string, updated?: object, error?: string}>}
 */
export async function refreshSw25Effect(actor, effectId, patch = {}, { notify = false } = {}) {
  if (game?.user?.isGM !== true) return notGmResult();
  if (!actor?.effects) return notActorResult();
  const effect = findSw25Effect(actor, effectId);
  if (!effect) {
    return { ok: false, code: "no-effect", error: "No system effect with that id exists on the actor." };
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, code: "invalid-refresh", error: "refresh needs at least one of: cast/successValue, remainingDuration, durationAnchor." };
  }

  const updateData = {};

  // Success Value: direct number or the casting-context contract (DEC-6).
  if (patch.successValue !== undefined && patch.successValue !== null) {
    const direct = resolveSw25CastSuccessValue({ successValue: patch.successValue });
    if (!direct.ok) return { ok: false, code: direct.code, error: direct.error };
    updateData["system.successValue"] = direct.successValue;
  } else if (patch.cast !== undefined) {
    const cast = resolveSw25CastSuccessValue(patch.cast);
    if (!cast.ok) return { ok: false, code: cast.code, error: cast.error };
    updateData["system.successValue"] = cast.successValue;
  }

  // Remaining duration (DEC-23). If the document keeps an initialDuration,
  // remaining must stay <= initial for the bookkeeping to stay coherent.
  // Counted COMBAT scales (rounds/turns, and legacy scale-less counters)
  // keep integer counters — the duration engine counts them. The unified
  // NON-COMBAT time counter (minutes/hours/days) stores WHOLE MINUTES only
  // (Phase 3 corrections, 2026-11-23): a minutes value must be an integer,
  // and a legacy hours/days value must equal a whole number of minutes
  // (1.5 h = 90 min is accepted; 1.234 h = 74.04 min is refused). No
  // fractional minute total is ever persisted.
  if (patch.remainingDuration !== undefined) {
    const value = patch.remainingDuration;
    const scale = typeof effect.system?.durationScale === "string" ? effect.system.durationScale : null;
    const timeScale = SW25_TIME_DURATION_SCALES.includes(scale);
    let wholeMinuteFailure = false;
    if (timeScale && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      const totalMinutes = value * SW25_TIME_SCALE_UNIT_MINUTES[scale];
      wholeMinuteFailure = Math.abs(totalMinutes - Math.round(totalMinutes)) > 1e-9;
    }
    if (value === null) {
      updateData["system.remainingDuration"] = null;
    } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0
      || (!timeScale && !Number.isInteger(value)) || wholeMinuteFailure) {
      return {
        ok: false,
        code: "invalid-duration",
        error: timeScale
          ? "remainingDuration must be a whole number of minutes in the effect's unit (or null to clear the time counter)."
          : "remainingDuration must be an integer >= 0 (or null to clear the round bookkeeping)."
      };
    } else {
      const initial = typeof effect.system?.initialDuration === "number" ? effect.system.initialDuration : null;
      if (initial !== null && value > initial) {
        return { ok: false, code: "invalid-duration", error: `remainingDuration (${value}) cannot exceed the effect's initialDuration (${initial}).` };
      }
      updateData["system.remainingDuration"] = value;
    }
  }

  // Duration anchor patch (T5.3, D5 degradation path): a FULL replacement of
  // the persisted anchor, validated with the same rules as apply (the
  // deferred state stays reserved for the future preparation flow). The
  // scale compatibility is checked against the EFFECT's persisted scale.
  if (patch.durationAnchor !== undefined) {
    const anchorProblem = durationAnchorPatchRejection(effect, patch.durationAnchor);
    if (anchorProblem) {
      return { ok: false, code: anchorProblem, error: DURATION_ANCHOR_ERRORS[anchorProblem] ?? "The durationAnchor patch is not valid for this effect." };
    }
    updateData["system.durationAnchor"] = normalizeDurationAnchor(patch.durationAnchor);
  }

  if (!Object.keys(updateData).length) {
    return { ok: false, code: "invalid-refresh", error: "refresh needs at least one of: cast/successValue, remainingDuration, durationAnchor." };
  }
  try {
    await runAuthorizedServiceWrite(() => effect.update(updateData));
    if (notify) ui?.notifications?.info?.("Effect refreshed.");
    return { ok: true, code: "refreshed", effectId, updated: updateData };
  } catch (error) {
    return { ok: false, code: "write-failed", error: String(error?.message ?? error) };
  }
}

/**
 * `set-duration`: edit the unified NON-COMBAT time counter of one effect —
 * the GM and the owning user adjust the remaining amount, expressed in a
 * chosen entry unit (minutes / hours / days). The counter IS the DEC-23
 * `initialDuration` / `remainingDuration` pair; no parallel field exists.
 *
 * Whole-minute storage (Phase 3 corrections, 2026-11-23): the counter of
 * record is the MINUTE. Every successful edit stores
 * `durationScale: "minutes"` with integer counters — fractional hour/day
 * representations ("1.5 hours", "1.25 days") and fractional minutes
 * ("2.78 minutes") never exist as stored values.
 *
 *   - The `unit` is the unit the `amount` is EXPRESSED in, not the stored
 *     scale: `amount × 60` (hours) or `× 1440` (days) must be a whole number
 *     of minutes, otherwise the edit is refused (`unrepresentable`) — never
 *     silently rounded.
 *   - An edit without `amount` migrates the stored counters to whole minutes
 *     (legacy hours/days with exact minute totals; duration preserved
 *     exactly). Inexact legacy counters are refused (`unrepresentable`):
 *     they need an explicit amount. An already-minutes effect is `no-change`.
 *   - An explicit `amount` replaces the remaining value (in whole minutes);
 *     the initial is raised when the amount exceeds it so the bookkeeping
 *     stays coherent (remaining ≤ initial). A legacy inexact initial becomes
 *     its whole-minute CEILING — an upper bound may only extend.
 *
 * Combat rounds are a SEPARATE representation: `rounds`/`turns` effects are
 * rejected (`combat-scale`), and manual `other`/`permanent` scales are outside
 * the unified counter (`not-time-scale`). The write goes through
 * runAuthorizedServiceWrite (the sole write path, DEC-36/DEC-45).
 *
 * @param {Actor} actor - Owning actor.
 * @param {string} effectId - Id of the effect document to edit.
 * @param {object} patch - { unit: "minutes"|"hours"|"days", amount?: number }.
 * @param {object} [options]
 * @param {boolean} [options.notify] - Notify this client of the outcome.
 * @returns {Promise<{ok: boolean, code: string, updated?: object, error?: string}>}
 */
export async function setSw25EffectTimeDuration(actor, effectId, patch = {}, { notify = false } = {}) {
  if (game?.user?.isGM !== true) return notGmResult();
  if (!actor?.effects) return notActorResult();
  const effect = findSw25Effect(actor, effectId);
  if (!effect) {
    return { ok: false, code: "no-effect", error: "No system effect with that id exists on the actor." };
  }
  const unit = typeof patch?.unit === "string" ? patch.unit.trim() : "";
  if (!SW25_TIME_DURATION_SCALES.includes(unit)) {
    return { ok: false, code: "invalid-unit", error: "unit must be one of: minutes, hours, days." };
  }
  const scale = typeof effect.system?.durationScale === "string" ? effect.system.durationScale : null;
  if (SW25_COMBAT_DURATION_SCALES.includes(scale)) {
    return {
      ok: false,
      code: "combat-scale",
      error: "Combat rounds keep a SEPARATE representation: this operation edits only the non-combat time counter (minutes/hours/days)."
    };
  }
  if (!SW25_TIME_DURATION_SCALES.includes(scale)) {
    return { ok: false, code: "not-time-scale", error: "The effect is not on the unified non-combat time counter (minutes/hours/days)." };
  }
  const amount = patch.amount;
  if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)) {
    return { ok: false, code: "invalid-amount", error: "amount must be a positive finite number." };
  }

  // Whole-minute conversion with IEEE-754 tolerance: the entry amount and
  // every migrated counter must land on an exact whole minute.
  const WHOLE_MINUTES_EPSILON = 1e-9;
  const wholeMinutes = total => {
    const rounded = Math.round(total);
    return Math.abs(total - rounded) <= WHOLE_MINUTES_EPSILON ? rounded : null;
  };
  const storedToMinutes = value => {
    // Legacy counters read through their exact minute equivalent; `null`
    // marks a value that is not a whole number of minutes.
    return wholeMinutes(value * SW25_TIME_SCALE_UNIT_MINUTES[scale]);
  };

  // The explicit amount is authoritative: it must BE a whole number of
  // minutes in the chosen entry unit.
  let amountMinutes = null;
  if (amount !== undefined) {
    amountMinutes = wholeMinutes(amount * SW25_TIME_SCALE_UNIT_MINUTES[unit]);
    if (amountMinutes === null) {
      return {
        ok: false,
        code: "unrepresentable",
        error: `The amount must be a whole number of minutes (${amount} ${unit} is not). Fractional minute durations are never stored.`
      };
    }
  }

  const storedInitial = typeof effect.system?.initialDuration === "number" && Number.isFinite(effect.system.initialDuration)
    ? effect.system.initialDuration : null;
  const storedRemaining = typeof effect.system?.remainingDuration === "number" && Number.isFinite(effect.system.remainingDuration)
    ? effect.system.remainingDuration : null;

  // Without an amount the operation preserves the duration: migrate the
  // stored counters to whole minutes (a minutes effect is already canonical).
  let nextInitial;
  let nextRemaining;
  if (amountMinutes === null) {
    if (scale === "minutes") {
      return { ok: false, code: "no-change", error: "The effect already uses that unit; provide an amount to change the counter." };
    }
    const migratedInitial = storedInitial === null ? null : storedToMinutes(storedInitial);
    const migratedRemaining = storedRemaining === null ? null : storedToMinutes(storedRemaining);
    if ((storedInitial !== null && migratedInitial === null)
      || (storedRemaining !== null && migratedRemaining === null)) {
      return {
        ok: false,
        code: "unrepresentable",
        error: "The stored counters are not a whole number of minutes and cannot be migrated without an explicit amount."
      };
    }
    nextInitial = migratedInitial;
    nextRemaining = migratedRemaining;
  } else {
    nextRemaining = amountMinutes;
    if (storedInitial === null) {
      nextInitial = amountMinutes;
    } else {
      const initialMinutes = storedToMinutes(storedInitial);
      // An inexact legacy initial becomes its whole-minute ceiling: the
      // initial is an upper bound (remaining ≤ initial) and a ceiling can
      // only extend it, never truncate the real duration.
      nextInitial = initialMinutes ?? Math.ceil(storedInitial * SW25_TIME_SCALE_UNIT_MINUTES[scale]);
      if (nextInitial < amountMinutes) nextInitial = amountMinutes;
    }
  }

  try {
    const updated = await runAuthorizedServiceWrite(() => effect.update({
      "system.durationScale": "minutes",
      "system.initialDuration": nextInitial,
      "system.remainingDuration": nextRemaining
    }));
    // A cancelled update resolves to undefined/null (Foundry v14): report the
    // failure instead of claiming a change that was never persisted.
    if (!updated && effect.system?.durationScale !== "minutes") {
      return { ok: false, code: "update-failed", error: "The duration edit was cancelled before it was persisted." };
    }
    if (notify) ui?.notifications?.info?.("Effect duration updated.");
    return {
      ok: true,
      code: "updated",
      updated: { durationScale: "minutes", initialDuration: nextInitial, remainingDuration: nextRemaining }
    };
  } catch (error) {
    return { ok: false, code: "update-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Delegated T1.3 repair write: the service performs the document update of
 * one repair normalization inside its write-authorization window (DEC-36).
 *
 * This keeps the T1.3 repair contract intact (GM authority, no write when
 * nothing changed, future versions protected, irrecoverable data kept and
 * reported) while ensuring the repair layer has NO write path of its own:
 * EffectService executes the document write. Called ONLY by
 * `repairSw25Effect` (module/effects/effect-repair.mjs); it is not a general
 * write permission — the payload must be a repair update plan (flattened
 * `system.*` fields) produced by the T1.3 normalizer.
 *
 * @param {object} effect - The effect document to write the repair onto.
 * @param {object} updateData - Flattened `system.*` update plan (non-empty).
 * @returns {Promise<{ok: boolean, code: string, updateData?: object, error?: string}>}
 */
export async function performSw25EffectRepairWrite(effect, updateData) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can repair effect data." };
  }
  if (!effect || typeof effect.update !== "function") {
    return { ok: false, code: "no-effect", error: "No effect was given to repair." };
  }
  if (!updateData || typeof updateData !== "object" || Object.keys(updateData).length === 0) {
    return { ok: false, code: "no-changes", error: "No repair update plan was given." };
  }
  try {
    await runAuthorizedServiceWrite(() => effect.update(updateData));
    return { ok: true, code: "repaired", updateData };
  } catch (error) {
    return { ok: false, code: "update-failed", error: String(error?.message ?? error) };
  }
}

// ── Reads: available on EVERY client, never through the GM (T2.5, DEC-36) ───

/**
 * List the actor's system effects as prepared display data. Read-only, local:
 * works on player clients without the GM relay. Delegates to the T1.5
 * preparation (`prepareSw25EffectRows`) so there is exactly one read path.
 * Presentation visibility: `system.gmOnly` effects are NOT listed (the safe
 * player-view default); GM-side callers that legitimately need them must use
 * `prepareSw25EffectRows` with `{ includeGmOnly: true }` or read the
 * documents directly.
 * @param {Actor} actor - The actor whose effects are listed.
 * @param {Function|null} [resolve] - Optional UUID resolver override.
 * @returns {{rows: Array, needsReviewCount: number, futureCount: number}}
 */
export function listSw25Effects(actor, resolve = null) {
  return prepareSw25EffectRows(actor?.effects ? [...actor.effects] : [], resolve);
}

/**
 * Read one of the actor's system effects by id as prepared display data.
 * Read-only, local (no relay, no GM). Returns null when absent or foreign.
 * Presentation visibility: a `system.gmOnly` effect reads as null here (the
 * safe player-view default of `prepareSw25EffectRows`).
 * @param {Actor} actor - Owning actor.
 * @param {string} effectId - Effect document id.
 * @param {Function|null} [resolve] - Optional UUID resolver override.
 * @returns {object|null} The prepared row, or null.
 */
export function getSw25Effect(actor, effectId, resolve = null) {
  if (typeof effectId !== "string" || effectId === "") return null;
  const effect = findSw25Effect(actor, effectId);
  if (!effect) return null;
  return prepareSw25EffectRows([effect], resolve).rows[0] ?? null;
}

// ── T5.5: combat-end disposition of rounds/turns scale effects ──────────────

/**
 * `purgeSw25CombatDurationEffects`: end-of-combat disposition of every
 * `sw25Effect` document whose `system.durationScale` is `rounds` or `turns`
 * (the combat-lifecycle scales), from every actor in the world. Called when a
 * Combat encounter ends.
 *
 * Disposition (user directive, 2026-11-22 — minute-preserving purge; whole
 * minute semantics per the 2026-11-23 corrections directive):
 *   - `rounds` with a finite remainingDuration ≥ 6 (≥ 1 minute) is CONVERTED
 *     in place to the manual `minutes` scale. The result derives from the
 *     REMAINING counter only — NEVER from `initialDuration` (task §3): BOTH
 *     counters receive `Math.floor(remaining / 6)` WHOLE minutes (never
 *     fractional — 11 rounds → 1, 12 → 2, 17 → 2, 24 → 4) and the combat
 *     anchor is cleared. The effect survives the combat and continues as
 *     GM-managed time (DEC-39/DEC-42). This closes the loop with the T5.6
 *     combat-entry conversion (minutes → rounds below the 10-minute
 *     threshold), and no whitelist restricts the minute value.
 *   - `rounds` with a remaining below 6 (less than one convertible minute)
 *     or a non-finite/absent counter, and every `turns` effect (turns have no
 *     temporal meaning outside the encounter's turn structure), is REMOVED.
 *
 * Survives untouched: minutes, hours, days, permanent, other, native, none,
 * legacy effects without a recognized scale, and non-sw25Effect subtypes.
 * Disposition is based on durationScale + counters only — not on anchor
 * availability or state. No anchor completion, no degradation recalculation,
 * no partial expiry.
 *
 * GM authority: writes go through removeSw25Effect and
 * runAuthorizedServiceWrite (the sole write paths). Idempotent: a second call
 * finds nothing combat-scale. No retries, no queues, no parallel storage, no
 * deletion ledger.
 * @returns {Promise<{ok: boolean, code: string, removed: number, converted: number, scanned: number, errors: Array}>}
 */
export async function purgeSw25CombatDurationEffects() {
  if (game?.user?.isGM !== true) return notGmResult();
  if (!game?.actors) return { ok: false, code: "no-actors", error: "No actor collection available.", removed: 0, converted: 0, scanned: 0, errors: [] };

  const combatScales = new Set(SW25_COMBAT_DURATION_SCALES); // ["rounds", "turns"]
  let removed = 0;
  let converted = 0;
  let scanned = 0;
  const errors = [];

  for (const actor of game.actors.contents) {
    if (!actor?.effects) continue;
    const effects = actor.effects.contents ?? actor.effects;
    for (const effect of [...effects]) {
      if (effect.type !== SW25_EFFECT_SUBTYPE) continue;
      const scale = effect.system?.durationScale;
      if (!combatScales.has(scale)) continue;
      scanned += 1;
      if (scale === "rounds") {
        const remaining = Number(effect.system?.remainingDuration);
        if (Number.isFinite(remaining) && remaining >= SW25_ROUNDS_PER_MINUTE) {
          // Both counters derive from the REMAINING rounds (task §3): a
          // conversion never reports an initial duration that no longer
          // corresponds to what is left. WHOLE minutes only (corrections
          // directive, 2026-11-23): `Math.floor(remaining / 6)` — fractional
          // minutes (2.8333…, 1.5) are never persisted.
          const minutes = Math.floor(remaining / SW25_ROUNDS_PER_MINUTE);
          const updated = await runAuthorizedServiceWrite(() => effect.update({
            "system.durationScale": "minutes",
            "system.durationAnchor": null,
            "system.initialDuration": minutes,
            "system.remainingDuration": minutes
          }));
          // A cancelled update resolves to undefined/null (Foundry v14):
          // the document keeps its combat scale and the failure is reported,
          // never silent.
          if (!updated && effect.system?.durationScale === "rounds") {
            errors.push({ actorId: actor.id, effectId: effect.id, code: "convert-failed", error: "The minutes conversion was cancelled before it was persisted." });
            continue;
          }
          converted += 1;
          continue;
        }
      }
      const result = await removeSw25Effect(actor, effect.id);
      if (result.ok) {
        removed += 1;
      } else {
        errors.push({ actorId: actor.id, effectId: effect.id, code: result.code, error: result.error });
      }
    }
  }

  return { ok: errors.length === 0, code: errors.length === 0 ? "purged" : "partial", removed, converted, scanned, errors };
}

// ── T5.6: combat-start entry of the non-combat time counter ─────────────────

/**
 * Tolerance for exact floating-point conversions: 17/6 minutes × 6 rounds is
 * 17.000000000000004 in IEEE-754 and must be read as the exact 17; a real
 * fractional value (1.7 × 6 = 10.2) is far outside this window.
 */
const EXACT_COUNTER_EPSILON = 1e-9;

/**
 * Collapse floating-point noise around an exact integer WITHOUT ever rounding
 * a genuinely fractional value.
 * @param {*} value - Candidate counter.
 * @returns {number|null} The exact integer, or null when not finite/integral.
 */
function exactCounter(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Math.abs(value - rounded) <= EXACT_COUNTER_EPSILON ? rounded : null;
}

/**
 * The authored seconds identity of an effect (Phase 3 corrections): the
 * normalized `system.sourceDuration` (`{ unit, amount }`, written only by the
 * Instant/X out-of-combat fallback — never inferred from display text) when
 * it marks a positive seconds amount.
 * @param {object} effect - Candidate effect document.
 * @returns {{amount: number}|null} `{ amount }` for a seconds-based effect,
 *   null otherwise.
 */
function sw25SecondsSourceDuration(effect) {
  const source = effect.system?.sourceDuration;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  if (source.unit !== "seconds") return null;
  const amount = source.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  return { amount };
}

/**
 * Collect the combat-entry candidates of one encounter (read-only; no writes,
 * no prompts), from the participant actors' `sw25Effect` documents:
 *   - effects on the unified NON-COMBAT counter (`minutes`) with a finite
 *     remaining amount > 0;
 *   - seconds-based effects applied OUTSIDE combat (`durationScale: "other"`
 *     with a positive `system.sourceDuration` of unit "seconds", Phase 3
 *     corrections): they have no countdown of their own, but combat start is
 *     where their combat-equivalent rounds are (re)established through the
 *     SAME confirmation flow.
 *
 * Hours/days never convert to rounds; counterless time effects have no
 * computable remaining duration and stay under manual GM management (DEC-39/
 * DEC-42) — there is nothing to convert and nothing to ask. Combat-scale
 * effects (rounds/turns) are already in combat representation. Plain "other"
 * effects without a seconds identity stay GM-managed with no invented
 * semantics.
 * @param {Combat} combat - The starting encounter.
 * @returns {{participants: Array<{actor: object, combatant: object}>, candidates: Array<{actor: object, effect: object}>}}
 */
export function collectSw25CombatEntryCandidates(combat) {
  const participants = [];
  const seen = new Set();
  for (const combatant of [...(combat?.combatants ?? [])]) {
    const actor = combatant?.actor;
    const key = actor?.id ?? actor?.uuid;
    if (!actor?.effects || !key || seen.has(key)) continue;
    seen.add(key);
    participants.push({ actor, combatant });
  }
  const candidates = [];
  for (const { actor } of participants) {
    const effects = actor.effects?.contents ?? actor.effects ?? [];
    for (const effect of [...effects]) {
      if (effect?.type !== SW25_EFFECT_SUBTYPE) continue;
      if (effect.system?.durationScale === "minutes") {
        const remaining = effect.system?.remainingDuration;
        if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining <= 0) continue;
      } else if (!sw25SecondsSourceDuration(effect)) {
        continue;
      }
      candidates.push({ actor, effect });
    }
  }
  return { participants, candidates };
}

/**
 * `combat-start`: bring the participants' non-combat durations into combat
 * tracking through ONE confirmation window (2026-11-23 unification directive;
 * seconds-based effects per the Phase 3 corrections).
 *
 * For every participant effect that is a candidate — a `minutes` effect with
 * a finite remaining amount, OR a seconds-based effect applied outside combat
 * (`durationScale: "other"` + positive `system.sourceDuration` of unit
 * "seconds"):
 *   1. The user is ASKED whether the effect is still active (`decide`
 *      callback). Outside combat the elapsed wall-clock time cannot be
 *      established, so the system never silently assumes the original
 *      duration is fully available: `false` → the effect is REMOVED through
 *      EffectService; no answer (null) → untouched (`undecided`).
 *   2. A confirmed `minutes` effect is thresholded on its STORED remaining:
 *      strictly below 10 minutes converts to counted `rounds` (×6) with the
 *      D5 default anchor; at or above 10 minutes it stays on the time counter
 *      (`kept`).
 *   3. A confirmed SECONDS-based effect is ALREADY combat-equivalent: the
 *      minute threshold never applies. It converts to its exact equivalent
 *      rounds (10 s = 1 round, both counters; seconds ÷ 10). A non-integer
 *      result is REPORTED as incompatible and the effect is left untouched —
 *      never rounded.
 *   4. A conversion yielding a non-integer round count (minutes: only with
 *      arbitrary fractional legacy minutes, e.g. 1.7 → 10.2) is REPORTED as
 *      incompatible and the effect is left untouched — never rounded.
 *
 * The minutes initial counter converts proportionally when it yields an exact
 * round count; otherwise it falls back to the (integer) remaining rounds.
 * Hours and days never convert; plain "other" effects without a seconds
 * identity are never touched. The engine's anchors, its decrement and the D5
 * degradation are untouched — a converted effect is an ordinary counted
 * rounds effect from then on.
 *
 * @param {Combat} combat - The starting encounter.
 * @param {object} [options]
 * @param {Function|null} [options.decide] - async (actor, effect) =>
 *   true (still active) | false (remove) | null (no answer). Without it every
 *   candidate stays undecided — never converted, never removed.
 * @returns {Promise<{ok: boolean, code: string, scanned: number,
 *   converted: number, kept: number, removed: number, undecided: number,
 *   skipped: number, unresolved: Array, errors: Array}>}
 */
export async function enterSw25CombatDurationEffects(combat, { decide = null } = {}) {
  if (game?.user?.isGM !== true) return notGmResult();
  if (!combat?.combatants) {
    return {
      ok: false, code: "no-combat", error: "A combat encounter with combatants is required.",
      scanned: 0, converted: 0, kept: 0, removed: 0, undecided: 0, skipped: 0, unresolved: [], errors: []
    };
  }
  const { participants } = collectSw25CombatEntryCandidates(combat);

  // Combatant identity maps. Two tokens of the same Actor are independent
  // combatants; the first is a stable, documented choice for the anchor.
  const byCasterUuid = new Map();
  const byActorId = new Map();
  for (const combatant of [...combat.combatants]) {
    const actor = combatant?.actor;
    if (actor?.uuid && !byCasterUuid.has(actor.uuid)) byCasterUuid.set(actor.uuid, combatant);
    if (actor?.id && !byActorId.has(actor.id)) byActorId.set(actor.id, combatant);
  }

  let scanned = 0;
  let converted = 0;
  let kept = 0;
  let removed = 0;
  let undecided = 0;
  let skipped = 0;
  const unresolved = [];
  const errors = [];

  // The ONE conversion writer of this flow (minutes below the threshold and
  // confirmed seconds-based effects share it — no duplicated transition
  // logic): counted rounds + the D5 default anchor (`casterTurn`/`begin`;
  // combatant resolved from the effect's `casterUUID` when that actor
  // participates, otherwise the effect's OWNER, a participant by
  // construction). Returns true when the conversion was persisted.
  async function convertCandidateToRounds(actor, effect, rounds, initialRounds, reportRemaining) {
    const casterUUID = typeof effect.system?.casterUUID === "string" ? effect.system.casterUUID : null;
    const anchorCombatant = (casterUUID ? byCasterUuid.get(casterUUID) : null) ?? byActorId.get(actor.id) ?? null;
    if (!anchorCombatant) {
      unresolved.push({
        actorId: actor.id, effectId: effect.id, name: effect.name ?? null,
        remaining: reportRemaining, reason: "no-anchor-combatant"
      });
      return false;
    }
    try {
      const updated = await runAuthorizedServiceWrite(() => effect.update({
        "system.durationScale": "rounds",
        "system.initialDuration": initialRounds,
        "system.remainingDuration": rounds,
        "system.durationAnchor": {
          regime: "casterTurn",
          edge: "begin",
          combatantId: anchorCombatant.id ?? null,
          tokenId: anchorCombatant.tokenId ?? null,
          state: "resolved"
        }
      }));
      // A cancelled update resolves to undefined/null (Foundry v14): the
      // document keeps its time counter and the failure is reported.
      if (!updated && effect.system?.durationScale !== "rounds") {
        errors.push({ actorId: actor.id, effectId: effect.id, code: "convert-failed", error: "The rounds conversion was cancelled before it was persisted." });
        return false;
      }
      return true;
    } catch (error) {
      errors.push({ actorId: actor.id, effectId: effect.id, code: "convert-failed", error: String(error?.message ?? error) });
      return false;
    }
  }

  for (const { actor } of participants) {
    const effects = actor.effects?.contents ?? actor.effects ?? [];
    for (const effect of [...effects]) {
      if (effect?.type !== SW25_EFFECT_SUBTYPE) continue;
      scanned += 1;
      const seconds = sw25SecondsSourceDuration(effect);
      let remaining = null;
      if (effect.system?.durationScale === "minutes") {
        remaining = effect.system?.remainingDuration;
        if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining <= 0) {
          skipped += 1;
          continue;
        }
      } else if (!seconds) {
        skipped += 1;
        continue;
      }

      let answer = null;
      if (typeof decide === "function") {
        try {
          answer = await decide(actor, effect);
        } catch (error) {
          answer = null;
          console.warn("[SW25 EffectService] Combat-entry decision failed; the effect stays undecided.", error);
        }
      }
      if (answer === false) {
        const result = await removeSw25Effect(actor, effect.id);
        if (result.ok) removed += 1;
        else errors.push({ actorId: actor.id, effectId: effect.id, code: result.code, error: result.error });
        continue;
      }
      if (answer !== true) {
        undecided += 1;
        continue;
      }

      if (seconds) {
        // A seconds-authored duration is ALREADY combat-equivalent: the
        // 10-minute minute-based threshold never applies to it (corrections
        // directive, 2026-11-23). The confirmed-active conversion is the
        // exact equivalent rounds (10 s = 1 round); a non-integer result is
        // reported, never rounded. Both counters become those rounds.
        const rounds = exactCounter(seconds.amount / SW25_SECONDS_PER_ROUND);
        if (rounds === null || rounds < 1) {
          unresolved.push({
            actorId: actor.id, effectId: effect.id, name: effect.name ?? null,
            remaining: seconds.amount, rounds: seconds.amount / SW25_SECONDS_PER_ROUND, reason: "fractional-rounds"
          });
          continue;
        }
        if (await convertCandidateToRounds(actor, effect, rounds, rounds, seconds.amount)) converted += 1;
        continue;
      }

      if (remaining >= SW25_COMBAT_ENTRY_THRESHOLD_MINUTES) {
        kept += 1;
        continue;
      }

      const rounds = exactCounter(remaining * SW25_ROUNDS_PER_MINUTE);
      if (rounds === null || rounds < 1) {
        unresolved.push({
          actorId: actor.id, effectId: effect.id, name: effect.name ?? null,
          remaining, rounds: remaining * SW25_ROUNDS_PER_MINUTE, reason: "fractional-rounds"
        });
        continue;
      }
      const storedInitial = effect.system?.initialDuration;
      const initialRounds = exactCounter(typeof storedInitial === "number"
        ? storedInitial * SW25_ROUNDS_PER_MINUTE
        : null) ?? rounds;
      if (await convertCandidateToRounds(actor, effect, rounds, initialRounds, remaining)) converted += 1;
    }
  }

  // Visible summary (D10 discrete level): never silent, never a dialog
  // without a result.
  if (converted > 0) {
    ui?.notifications?.info?.(`Combat duration: ${converted} effect${converted === 1 ? "" : "s"} entered round-based tracking.`);
  }
  if (removed > 0) {
    ui?.notifications?.info?.(`Combat duration: ${removed} expired effect${removed === 1 ? "" : "s"} removed after confirmation.`);
  }
  if (unresolved.length > 0) {
    ui?.notifications?.warn?.(`Combat duration: ${unresolved.length} effect${unresolved.length === 1 ? "" : "s"} cannot be represented in rounds (fractional result or no anchor); left on the time counter for GM review.`);
    console.warn("[SW25 EffectService] Combat-entry conversions left unresolved:", unresolved);
  }
  if (errors.length > 0) {
    ui?.notifications?.error?.("Combat duration: some effects could not be updated; correct them manually through EffectService.");
    console.warn("[SW25 EffectService] Combat-entry errors:", errors);
  }

  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? "entered" : "partial",
    scanned, converted, kept, removed, undecided, skipped, unresolved, errors
  };
}
