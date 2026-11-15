// Sword World 2.5 - central stacking resolver (Bloque 4, T4.1/T4.4).
//
// The versioned, pure, headless resolver of the system's stacking rules
// (DEC-44): it determines what happens when a new `sw25Effect` application
// interacts with the effects already present on an Actor. It decides NOTHING
// that belongs to the target (DEC-3 step 3): when the rules give the target a
// choice it returns `choice-required` with the comparison data of the DEC-22
// window, and EffectService collects the decision before any write.
//
// Separation of responsibilities:
//   - Identity: `family` (compared through `normalizeSw25FamilyKey`) is the
//     ONLY stacking identity (DEC-1/DEC-16/DEC-44). `rank` is hierarchy, never
//     identity; `sourceType`/`sourceUUID`/`casterUUID` are provenance
//     metadata and never participate. No visual-name matching; the canonical
//     name in the choice data is presentation reconstructed with
//     `buildSw25CanonicalName` and is never persisted (DEC-49).
//   - Policy selection: `familyPolicy` (persisted on every effect, Bloque 4
//     additive schema field) selects WHICH central policy applies. Absent /
//     null means "spell" (DEC-3: "Implementación inicial: solo spell usa este
//     flujo"). An unknown id produces `unresolved` — never a silent outcome.
//   - Duration result: the same-family replacement merges durations as the
//     maximum between the previous remaining duration and the new complete
//     duration (DEC-4/DEC-18; DEC-18 explicitly does NOT restrict this
//     protection by category). Only the round-managed bookkeeping (DEC-23)
//     participates: an incomparable pair (one side managed, the other
//     GM-tracked) is a GM decision (`duration-incomparable-gm`), never an
//     invented value.
//   - Mechanical parameters of a replacement are ALWAYS the new
//     application's (DEC-3/DEC-18): this module never merges change arrays.
//
// Scope guards (documented, not invented):
//   - Effects with an unknown `familyPolicy` belong to no policy scope: they
//     stay inert here (the T1.3 repair layer reports them for GM review).
//   - Disabled effects remain inside their policy scope: the conservative
//     reading of "activo en el mismo objetivo" (DEC-3) prefers an explicit
//     decision over a silent accumulation.
//   - Spatial representation (Spellsong area intersection, weapon-object
//     scoping, Geograph presence) is NOT in the persisted data yet: the
//     affected policies resolve at Actor level and the real spatial contracts
//     belong to Bloque 6 (each limitation is marked on its policy).

import { normalizeSw25FamilyKey, buildSw25CanonicalName } from "./effect-identity.mjs";

/**
 * Version of the resolver contract itself (DEC-44: versioned and testable).
 * Bump when the decision contract changes shape.
 * @type {number}
 */
export const SW25_STACKING_RESOLVER_VERSION = 1;

/**
 * The explicit outcomes the resolver may produce (DEC-3/DEC-44).
 * @type {string[]}
 */
export const SW25_STACKING_OUTCOMES = Object.freeze([
  "accumulate",
  "replace",
  "refused",
  "choice-required",
  "unresolved"
]);

/** Default policy id when the application carries no `familyPolicy` (DEC-3). */
export const SW25_STACKING_DEFAULT_POLICY = "spell";

/** The policy ids the central registry knows about (T4.4). */
export const SW25_STACKING_POLICY_IDS = Object.freeze([
  "spell",
  "feat",
  "technique",
  "stratagem",
  "spellsong",
  "aspect",
  "weaponEnchant"
]);

// ── Small pure helpers ──────────────────────────────────────────────────────

/**
 * The `system.*` view of a document OR of an application payload: stored
 * effects carry their data under `system`, while the incoming application is
 * a flat payload. The readers below work uniformly on both shapes.
 * @param {object} document - An effect document or an application payload.
 * @returns {object}
 */
function systemLike(document) {
  if (document && typeof document.system === "object" && document.system !== null) return document.system;
  return document ?? {};
}

/** Stable stacking-identity key of an application's `family` (DEC-1). */
function applicationFamilyKey(application) {
  return normalizeSw25FamilyKey(application?.family);
}

/** Stable stacking-identity key of a stored effect's `system.family`. */
function effectFamilyKey(effect) {
  return normalizeSw25FamilyKey(effect?.system?.family);
}

/**
 * Effective stacking-policy id of a stored effect: its `familyPolicy`, or the
 * DEC-3 default ("spell") when absent/null. Unknown ids are returned as-is so
 * they fall outside every registered policy's scope.
 * @param {object} effect - A stored `sw25Effect` document.
 * @returns {string}
 */
function effectivePolicyOf(effect) {
  const stored = effect?.system?.familyPolicy;
  if (typeof stored === "string" && stored.trim() !== "") return stored.trim();
  return SW25_STACKING_DEFAULT_POLICY;
}

/** Success Value of an effect or application (DEC-6; 0 is a legitimate value). */
function successValueOf(document) {
  const value = systemLike(document).successValue;
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

/** Round-managed remaining duration of an effect or application, or null. */
function remainingDurationOf(document) {
  const value = systemLike(document).remainingDuration;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Elemental attribute of a document's/applications's damageType, or null. */
function elementalAttributeOf(document) {
  const value = systemLike(document).damageType?.attribute;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Whether a document/effect is PERMANENT for the DEC-21 rule: no round
 * bookkeeping AND no native measurable duration (`duration.seconds`, the v14
 * field that carries minutes/hours). Effects on neither scale are GM-managed
 * (DEC-32) and read as permanent here.
 * @param {object} document - An effect document or an application payload.
 * @returns {boolean}
 */
function isPermanent(document) {
  if (remainingDurationOf(document) !== null) return false;
  const seconds = document?.duration?.seconds;
  return !(typeof seconds === "number" && seconds > 0);
}

/**
 * Whether the incoming application is temporal (opposite of `isPermanent`).
 * @param {object} application - The application payload.
 * @returns {boolean}
 */
function isApplicationTemporal(application) {
  return !isPermanent(application);
}

/**
 * The replacement duration plan (DEC-4/DEC-18): the maximum between the
 * previous remaining duration(s) and the new complete duration, normalized to
 * the new effect's bookkeeping. Only round-managed durations participate
 * (DEC-23): one measurable side and one GM-tracked side are incomparable.
 *
 * @param {object[]} replacedEffects - The effects the plan will delete.
 * @param {object} application - The incoming application payload.
 * @returns {{initialDuration: number|null, remainingDuration: number|null}|null}
 *   The merged durations, or null when the pair is incomparable (GM decision,
 *   DEC-4/DEC-32).
 */
function resolveReplacementDurations(replacedEffects, application) {
  const newInitial = remainingDurationOf({ remainingDuration: application?.initialDuration });
  const previous = replacedEffects
    .map(effect => remainingDurationOf(effect))
    .filter(value => value !== null);
  if (newInitial === null && previous.length === 0) {
    return { initialDuration: null, remainingDuration: null }; // both GM-managed
  }
  if (newInitial === null || previous.length === 0) return null; // incomparable
  const max = Math.max(newInitial, ...previous);
  return { initialDuration: max, remainingDuration: max };
}

/** Presentation data of one stored effect for the DEC-22 choice window. */
function describeEffect(effect) {
  const system = effect?.system ?? {};
  return {
    id: typeof effect?.id === "string" ? effect.id : null,
    name: buildSw25CanonicalName(system.family, system.rank) ?? (typeof effect?.name === "string" ? effect.name : null),
    family: typeof system.family === "string" ? system.family : null,
    rank: typeof system.rank === "number" ? system.rank : 0,
    successValue: successValueOf(effect),
    remainingDuration: remainingDurationOf(effect),
    familyPolicy: typeof system.familyPolicy === "string" && system.familyPolicy.trim() !== "" ? system.familyPolicy.trim() : null,
    damageType: system.damageType && typeof system.damageType === "object"
      ? { nature: system.damageType.nature ?? null, attribute: system.damageType.attribute ?? null }
      : null
  };
}

/** Presentation data of the incoming application for the DEC-22 window. */
function describeApplication(application) {
  return {
    name: buildSw25CanonicalName(application?.family, application?.rank ?? 0) ?? (typeof application?.family === "string" ? application.family : null),
    family: typeof application?.family === "string" ? application.family : null,
    rank: typeof application?.rank === "number" ? application.rank : 0,
    successValue: successValueOf(application),
    remainingDuration: remainingDurationOf({ remainingDuration: application?.initialDuration }),
    familyPolicy: typeof application?.familyPolicy === "string" && application.familyPolicy.trim() !== "" ? application.familyPolicy.trim() : null,
    damageType: application?.damageType && typeof application.damageType === "object"
      ? { nature: application.damageType.nature ?? null, attribute: application.damageType.attribute ?? null }
      : null
  };
}

/**
 * The standard decision payload for a target choice (DEC-3 step 3 / DEC-22):
 * both sides complete, the field that carries the decision, and the replace
 * plan the service executes when the target accepts.
 */
function buildChoice({ policy, code, replaceIds, durations, application, existing }) {
  return {
    outcome: "choice-required",
    code,
    policy,
    replaceIds: [...replaceIds],
    durations: durations ?? null,
    choice: {
      field: "acceptReplace",
      existing: existing.map(describeEffect),
      incoming: describeApplication(application)
    }
  };
}

function unresolved(code, error) {
  return { outcome: "unresolved", code, error };
}

// ── Policy registry (T4.4) ──────────────────────────────────────────────────

/**
 * Registered stacking policies, by `familyPolicy` id. Each policy is a pure
 * function `({ actor, application, existing }) => decision` where `existing`
 * is the actor's current `sw25Effect` documents.
 * @type {Map<string, Function>}
 */
const stackingPolicies = new Map();

/**
 * Register one stacking policy (extension point, T4.4). Registering an
 * already-known id REPLACES it; the built-in policies are registered when
 * this module is imported and can be re-registered to recover them.
 * @param {string} policyId - The `familyPolicy` id the policy answers to.
 * @param {Function} policy - Pure policy function.
 * @returns {void}
 */
export function registerSw25StackingPolicy(policyId, policy) {
  if (typeof policyId !== "string" || policyId.trim() === "") {
    throw new Error("A stacking policy needs a non-blank familyPolicy id.");
  }
  if (typeof policy !== "function") {
    throw new Error("A stacking policy must be a function.");
  }
  stackingPolicies.set(policyId.trim(), policy);
}

/**
 * Currently registered stacking policy ids (diagnostics/tests).
 * @returns {string[]}
 */
export function listSw25StackingPolicies() {
  return [...stackingPolicies.keys()];
}

// ── Built-in policy: spell (DEC-2 / DEC-3 / DEC-4) ──────────────────────────

/**
 * `spell` (also the DEC-3 default): different families accumulate; the same
 * family never coexists — the target decides (DEC-3): accept replaces the
 * previous application with the merged DEC-4 duration, reject discards the
 * new application whole. The resolver only detects and prepares (DEC-3 step
 * 2); it never accepts on the target's behalf.
 * @param {object} context - { actor, application, existing }.
 * @returns {object} The stacking decision.
 */
function spellPolicy({ application, existing }) {
  const key = applicationFamilyKey(application);
  const sameFamily = existing.filter(effect =>
    effectivePolicyOf(effect) === SW25_STACKING_DEFAULT_POLICY && effectFamilyKey(effect) === key);
  if (sameFamily.length === 0) {
    return { outcome: "accumulate", code: "different-family-accumulate" };
  }
  const durations = resolveReplacementDurations(sameFamily, application);
  if (durations === null) {
    return unresolved("duration-incomparable-gm",
      "The previous application is round-managed while the new one is GM-tracked (or vice versa): which duration prevails is a GM decision (DEC-4/DEC-32). Nothing was written.");
  }
  return buildChoice({
    policy: "spell",
    code: "same-family-recast",
    replaceIds: sameFamily.map(effect => effect.id),
    durations,
    application,
    existing: sameFamily
  });
}

// ── Built-in policy: feat (DEC-19 Combat Feats + DEC-38) ────────────────────

/**
 * `feat`: persistent feat effects always accumulate as independent
 * applications (DEC-19: the declaration restriction "una dote no puede
 * declararse varias veces para una misma acción" is a per-action declaration
 * rule, NOT a persistence rule; the same bullet states the effects may
 * coexist on the sheet). Risks and penalties of coexisting applications
 * accumulate (DEC-38.4). The per-action declaration validation belongs to the
 * declaration flow (§56.1 item 21), not to this policy.
 * @param {object} context - { actor, application, existing }.
 * @returns {object} The stacking decision.
 */
function featPolicy() {
  return { outcome: "accumulate", code: "feat-applications-coexist" };
}

// ── Built-in policy: technique (DEC-19 Enhancer Techniques) ─────────────────

/**
 * Technique families whose uses may accumulate per an express rule (DEC-19:
 * "excepciones expresas de las propias reglas, como Dragon Tail"). Keys are
 * DEC-1 comparison keys. Dragon Tail's accumulation LIMIT ("hasta el límite
 * indicado") is not yet in the system's data: it is not enforced here and the
 * limitation is documented (T4.4 extension point, no invented rule).
 * @type {Set<string>}
 */
const ACCUMULABLE_TECHNIQUE_FAMILIES = new Set(["dragon tail"]);

/**
 * `technique`: different techniques coexist; a technique does not accumulate
 * with itself except where an express rule allows it (Dragon Tail). A
 * non-accumulable same-family application is replaced deterministically (no
 * target choice in DEC-19): the new application's parameters win, duration
 * merged per DEC-4/DEC-18.
 * @param {object} context - { actor, application, existing }.
 * @returns {object} The stacking decision.
 */
function techniquePolicy({ application, existing }) {
  const key = applicationFamilyKey(application);
  const sameFamily = existing.filter(effect =>
    effectivePolicyOf(effect) === "technique" && effectFamilyKey(effect) === key);
  if (sameFamily.length === 0 || ACCUMULABLE_TECHNIQUE_FAMILIES.has(key)) {
    return { outcome: "accumulate", code: ACCUMULABLE_TECHNIQUE_FAMILIES.has(key) ? "technique-accumulable-family" : "different-family-accumulate" };
  }
  const durations = resolveReplacementDurations(sameFamily, application);
  if (durations === null) {
    return unresolved("duration-incomparable-gm",
      "The previous technique is round-managed while the new one is GM-tracked (or vice versa): which duration prevails is a GM decision (DEC-4/DEC-32). Nothing was written.");
  }
  return {
    outcome: "replace",
    code: "same-technique-overwrite",
    replaceIds: sameFamily.map(effect => effect.id),
    durations
  };
}

// ── Built-in policy: stratagem (DEC-19 Tactician Stratagems) ────────────────

/**
 * `stratagem`: a character maintains ONLY ONE active strategy (DEC-19).
 * Applying a new strategy while any is active (same OR different family)
 * requires the character's choice of which to keep. Accepting the new removes
 * ALL active stratagem applications (any family); the new application keeps
 * its OWN durations — the DEC-4 maximum rule is a same-family rule and does
 * not apply across families. Stratagems coexist with Spellsongs (DEC-19): no
 * interaction with other policy scopes.
 *
 * Bloque 6 note: stratagems are personal abilities, so the Actor-level scope
 * matches the rule here; the spatial contracts (DEC-24) belong to Bloque 6.
 * @param {object} context - { actor, application, existing }.
 * @returns {object} The stacking decision.
 */
function stratagemPolicy({ application, existing }) {
  const active = existing.filter(effect => effectivePolicyOf(effect) === "stratagem");
  if (active.length === 0) {
    return { outcome: "accumulate", code: "no-active-stratagem" };
  }
  return buildChoice({
    policy: "stratagem",
    code: "single-active-stratagem",
    replaceIds: active.map(effect => effect.id),
    durations: null, // different family (or fresh application): its own durations
    application,
    existing: active
  });
}

// ── Built-in policy: spellsong (DEC-19 Bard Spellsongs + DEC-21 + DEC-23) ───

/**
 * `spellsong`: same family → the target decides the recast (DEC-3 flow, as
 * for spells). Different families → the Songs' areas may overlap and in the
 * intersection only the song with the HIGHER Success Value applies (DEC-21):
 * an incoming song strictly above every active SV replaces the lower-SV
 * applications on this target; otherwise it is refused (ties: the effect
 * applied FIRST prevails per DEC-19, and the passive side wins ties per
 * DEC-21 — so an incoming song never wins an SV tie).
 *
 * Bloque 6 limitation: the persisted data carries no area geometry, so this
 * policy treats the Actor as the conflict scope ("EN ESTE objetivo"); the
 * real intersection resolution arrives with the spatial representation
 * (DEC-24/Bloque 6). The application-order tiebreak (DEC-23 elapsed = initial
 * − remaining) is conservatively folded into the strict-SV comparison: an
 * equal-SV incoming song is refused without needing elapsed data.
 * @param {object} context - { actor, application, existing }.
 * @returns {object} The stacking decision.
 */
function spellsongPolicy({ application, existing }) {
  const key = applicationFamilyKey(application);
  const songs = existing.filter(effect => effectivePolicyOf(effect) === "spellsong");
  const sameFamily = songs.filter(effect => effectFamilyKey(effect) === key);
  if (sameFamily.length > 0) {
    const durations = resolveReplacementDurations(sameFamily, application);
    if (durations === null) {
      return unresolved("duration-incomparable-gm",
        "The previous Spellsong is round-managed while the new one is GM-tracked (or vice versa): which duration prevails is a GM decision (DEC-4/DEC-32). Nothing was written.");
    }
    return buildChoice({
      policy: "spellsong",
      code: "same-family-recast",
      replaceIds: sameFamily.map(effect => effect.id),
      durations,
      application,
      existing: sameFamily
    });
  }
  if (songs.length === 0) {
    return { outcome: "accumulate", code: "no-active-spellsong" };
  }
  const incomingSv = successValueOf(application);
  const maxActiveSv = Math.max(...songs.map(successValueOf));
  if (incomingSv > maxActiveSv) {
    // DEC-21: the higher SV prevails; every active song here has a lower SV.
    const replaced = songs.filter(song => successValueOf(song) < incomingSv);
    return {
      outcome: "replace",
      code: "overlapping-area-higher-sv",
      replaceIds: replaced.map(effect => effect.id),
      durations: null // different families: the new song keeps its own durations
    };
  }
  return {
    outcome: "refused",
    code: "overlapping-area-lower-sv-or-tie",
    error: "The incoming Spellsong does not strictly exceed the Success Value of the active one(s): the higher SV prevails and ties keep the first-applied/passive effect (DEC-19/DEC-21). Nothing was written."
  };
}

// ── Built-in policy: aspect (DEC-19 Geomancer Aspects) ──────────────────────

/**
 * `aspect`: different Aspects accumulate while the Geograph is deployed; the
 * same Aspect overwrites its previous application (deterministic, DEC-19: no
 * target choice), duration merged per DEC-4/DEC-18 (DEC-18 is not
 * category-restricted).
 *
 * Documented dependencies NOT invented here (T4.4/Bloque 5): the Geograph
 * presence precondition and the end-of-turn joint application are rule-level
 * contracts of the Geomancer flow; this policy resolves stacking only.
 * @param {object} context - { actor, application, existing }.
 * @returns {object} The stacking decision.
 */
function aspectPolicy({ application, existing }) {
  const key = applicationFamilyKey(application);
  const sameFamily = existing.filter(effect =>
    effectivePolicyOf(effect) === "aspect" && effectFamilyKey(effect) === key);
  if (sameFamily.length === 0) {
    return { outcome: "accumulate", code: "different-aspect-accumulate" };
  }
  const durations = resolveReplacementDurations(sameFamily, application);
  if (durations === null) {
    return unresolved("duration-incomparable-gm",
      "The previous Aspect is round-managed while the new one is GM-tracked (or vice versa): which duration prevails is a GM decision (DEC-4/DEC-32). Nothing was written.");
  }
  return {
    outcome: "replace",
    code: "same-aspect-overwrite",
    replaceIds: sameFamily.map(effect => effect.id),
    durations
  };
}

// ── Built-in policy: weaponEnchant (DEC-20 + DEC-21) ────────────────────────

/**
 * `weaponEnchant` (DEC-20 table + DEC-21 permanent-over-temporary):
 *   - Same Family → the previous application is substituted (never stacks).
 *   - Different families, non-elemental incoming (no `damageType.attribute`)
 *     → accumulates with anything (non-elemental + non-elemental, and
 *     non-elemental + elemental alike).
 *   - Different families, same elemental attribute → accumulates, bonuses
 *     included.
 *   - Different families, different elements → INCOMPATIBLE: the target
 *     chooses (DEC-20/DEC-21/DEC-22). Accepting cancels the previous
 *     elemental enchantment COMPLETELY (attribute, bonuses and side effects
 *     — the whole application, not only the Damage Type); rejecting keeps the
 *     previous one intact.
 *   - A TEMPORAL incoming enchantment incompatible with a PERMANENT elemental
 *     property fails WITHOUT a choice (DEC-21: no target decision offered).
 *     Permanence is read from the persisted data: no round bookkeeping and no
 *     measurable native duration (minutes/hours via `duration.seconds`).
 *
 * Bloque 6 limitation: the persisted data carries no weapon-object scoping
 * (DEC-24 "Objeto"), so the conflict scope is the Actor; per-weapon scoping
 * arrives with the item-level contracts.
 * @param {object} context - { actor, application, existing }.
 * @returns {object} The stacking decision.
 */
function weaponEnchantPolicy({ application, existing }) {
  const key = applicationFamilyKey(application);
  const enchants = existing.filter(effect => effectivePolicyOf(effect) === "weaponEnchant");
  const sameFamily = enchants.filter(effect => effectFamilyKey(effect) === key);
  if (sameFamily.length > 0) {
    // DEC-20 row 1: same family does not accumulate; it substitutes. The
    // substitution is deterministic; the duration merges per DEC-4/DEC-18.
    const durations = resolveReplacementDurations(sameFamily, application);
    if (durations === null) {
      return unresolved("duration-incomparable-gm",
        "The previous enchantment is round-managed while the new one is GM-tracked (or vice versa): which duration prevails is a GM decision (DEC-4/DEC-32). Nothing was written.");
    }
    return {
      outcome: "replace",
      code: "same-enchant-family-substitute",
      replaceIds: sameFamily.map(effect => effect.id),
      durations
    };
  }
  const incomingAttribute = elementalAttributeOf(application);
  if (incomingAttribute === null) {
    // DEC-20 rows 2/3: a non-elemental enchantment accumulates (with other
    // non-elemental ones and with elemental ones alike).
    return { outcome: "accumulate", code: "non-elemental-accumulate" };
  }
  const elementalExisting = enchants.filter(effect => elementalAttributeOf(effect) !== null);
  if (elementalExisting.length === 0) {
    // The incoming enchantment brings the weapon's first element.
    return { outcome: "accumulate", code: "non-elemental-accumulate" };
  }
  const conflicting = elementalExisting.filter(effect => elementalAttributeOf(effect) !== incomingAttribute);
  if (conflicting.length === 0) {
    // DEC-20 row 4: different families, same element → accumulate.
    return { outcome: "accumulate", code: "same-element-accumulate" };
  }
  // DEC-20 row 5 / DEC-21: incompatible elements. A permanent elemental
  // property prevails over a temporary incompatible enchantment: it fails
  // without effect and NO choice is offered (DEC-21).
  if (isApplicationTemporal(application) && conflicting.some(effect => isPermanent(effect))) {
    return {
      outcome: "refused",
      code: "permanent-enchant-incompatible",
      error: "A temporary enchantment incompatible with a permanent elemental property of the weapon fails without effect; no choice is offered (DEC-21). Nothing was written."
    };
  }
  return buildChoice({
    policy: "weaponEnchant",
    code: "incompatible-element",
    replaceIds: conflicting.map(effect => effect.id),
    durations: null, // different families: the new enchantment keeps its own durations
    application,
    existing: conflicting
  });
}

// Built-in registration (T4.4): importing this module installs every approved
// policy. Production wiring registers `resolveSw25Stacking` as THE service
// resolver from sw25.mjs init; headless suites that don't keep the service's
// documented default ("accumulate").
registerSw25StackingPolicy("spell", spellPolicy);
registerSw25StackingPolicy("feat", featPolicy);
registerSw25StackingPolicy("technique", techniquePolicy);
registerSw25StackingPolicy("stratagem", stratagemPolicy);
registerSw25StackingPolicy("spellsong", spellsongPolicy);
registerSw25StackingPolicy("aspect", aspectPolicy);
registerSw25StackingPolicy("weaponEnchant", weaponEnchantPolicy);

// ── The central resolver entry point (DEC-44) ───────────────────────────────

/**
 * Resolve the stacking interaction of one incoming application against the
 * actor's current system effects (DEC-44 central resolution; DEC-3 contract).
 *
 * PURE: no write, no UI, no Foundry API. The service consults it BEFORE any
 * write and executes the returned plan (create / delete plan / nothing).
 *
 * Decision contract (v1):
 *   - `{ outcome: "accumulate", code?, policy }` — the application may be
 *     created as its own effect.
 *   - `{ outcome: "replace", code?, policy, replaceIds: string[],
 *        durations: { initialDuration, remainingDuration }|null }` — create
 *     the new effect with `durations` (null = the application's own) and
 *     delete `replaceIds`; the service executes it as one transactional
 *     plan (create first, then delete, rollback the create on failure).
 *   - `{ outcome: "refused", code?, error?, policy }` — nothing is written.
 *   - `{ outcome: "choice-required", code?, policy, replaceIds, durations,
 *        choice: { field: "acceptReplace", existing[], incoming } }` — the
 *     rules give the target a decision (DEC-3/DEC-22); the service collects
 *     it (decision provider or `acceptReplace`) BEFORE writing anything.
 *   - `{ outcome: "unresolved", code?, error?, policy }` — the resolver
 *     cannot decide (unregistered policy, incomparable durations, invalid
 *     data); nothing is written and nothing is invented.
 *
 * @param {object} context - { actor, application, existing }.
 * @param {object} context.application - The incoming application payload
 *   (family required; `familyPolicy` selects the policy; `successValue`
 *   derived by the service from the casting context; optional
 *   `damageType`/`initialDuration`).
 * @param {object[]} [context.existing] - The actor's current `sw25Effect`
 *   documents (already filtered by the service).
 * @returns {object} The decision (contract above).
 */
export function resolveSw25Stacking({ actor, application, existing } = {}) {
  void actor; // policies receive the full context; none needs the actor yet
  if (!application || typeof application !== "object" || Array.isArray(application)) {
    return unresolved("stacking-invalid-application", "The stacking resolver needs an application payload object.");
  }
  const requested = typeof application.familyPolicy === "string" && application.familyPolicy.trim() !== ""
    ? application.familyPolicy.trim()
    : SW25_STACKING_DEFAULT_POLICY;
  const policy = stackingPolicies.get(requested);
  if (!policy) {
    return unresolved("stacking-policy-unregistered",
      `No stacking policy is registered for familyPolicy "${requested}"; the application is neither accumulated nor replaced and nothing is written (DEC-44: no silent outcomes).`);
  }
  const context = { actor, application, existing: Array.isArray(existing) ? existing : [] };
  let decision;
  try {
    decision = policy(context);
  } catch (error) {
    return unresolved("stacking-policy-failed", `The "${requested}" stacking policy failed: ${String(error?.message ?? error)}`);
  }
  if (!decision || typeof decision !== "object" || !SW25_STACKING_OUTCOMES.includes(decision.outcome)) {
    return unresolved("invalid-stacking-decision", `The "${requested}" stacking policy returned no approved outcome.`);
  }
  return { policy: requested, ...decision };
}
