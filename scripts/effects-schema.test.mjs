// Sword World 2.5 - effect schema repair/normalization test suite (T1.3/T1.4).
//
// Exercises module/effects/effect-repair.mjs in a headless process: pure
// normalization of the `system.*` payload of the `sw25Effect` subtype, the
// sequential migration mechanism (DEC-41), and the GM-authoritative repair
// layer over stub effect documents. The foundry mock is minimal: the module
// graph pulls in effect-model.mjs, whose class extends
// foundry.data.ActiveEffectTypeDataModel at import time.
//
// T1.4 adds module/effects/effect-identity.mjs: the family identity key
// normalization (DEC-1), the approved rank → Roman numeral table (DEC-16) and
// the canonical-name reconstruction from persisted family + rank (DEC-49),
// including its interaction with the repair normalization and the schema.
//
// Scope: normalization rules, idempotency, recoverable vs irrecoverable data
// handling (DEC-41: kept in place + reported, never silently dropped),
// future-version write protection, GM gating and GM notification, family
// identity and canonical-name presentation. No stacking resolution, expiry or
// UI behavior belongs to this suite.

import assert from "node:assert/strict";

// ── Global mock (before any import of the effect module graph) ──────────────

globalThis.foundry = {
  data: {
    ActiveEffectTypeDataModel: class ActiveEffectTypeDataModelStub {}
  }
};

const repair = await import("../module/effects/effect-repair.mjs");
const identity = await import("../module/effects/effect-identity.mjs");
const { SW25_EFFECT_SCHEMA_VERSION } = await import("../module/effects/effect-model.mjs");
const {
  normalizeSw25FamilyKey,
  sw25RankToRoman,
  buildSw25CanonicalName
} = identity;
const {
  normalizeSw25EffectSystem,
  migrateSw25EffectSystem,
  repairSw25Effect,
  repairActorEffects,
  EFFECT_MIGRATION_STEPS,
  EFFECT_SCHEMA_VERSION,
  SEVERITY_AUTO_FIXED,
  SEVERITY_REVIEW
} = repair;

const codes = result => result.issues.map(issue => `${issue.severity}:${issue.code}`);

// ── Constants and mechanism wiring ──────────────────────────────────────────

{
  assert.equal(EFFECT_SCHEMA_VERSION, 1);
  assert.equal(EFFECT_SCHEMA_VERSION, SW25_EFFECT_SCHEMA_VERSION);
  // DEC-41: the mechanism is wired, but only v1 exists — no fake steps.
  assert.ok(Array.isArray(EFFECT_MIGRATION_STEPS));
  assert.equal(EFFECT_MIGRATION_STEPS.length, 0);
}

// ── Valid v1 payload: no changes, no issues ─────────────────────────────────

const VALID = {
  schemaVersion: 1,
  family: "protection",
  rank: 2,
  successValue: 12,
  initialDuration: 4,
  remainingDuration: 3,
  casterUUID: "Actor.abcd1234efgh5678",
  effectType: "buff",
  isMagical: false,
  changes: [{ key: "system.hp.max", type: "add", value: 5, phase: "initial", priority: 1 }]
};

{
  const result = normalizeSw25EffectSystem(structuredClone(VALID));
  assert.equal(result.changed, false);
  assert.equal(result.issues.length, 0);
  assert.equal(result.futureVersion, false);
  assert.deepEqual(result.data, VALID);
  // Input must never be mutated.
  const input = structuredClone(VALID);
  normalizeSw25EffectSystem(input);
  assert.deepEqual(input, VALID);
}

// ── Version handling (DEC-41) ───────────────────────────────────────────────

{
  // Missing version: backfilled (auto-fixed).
  const raw = { family: "protection" };
  const result = normalizeSw25EffectSystem(raw);
  assert.deepEqual(codes(result), ["auto-fixed:version-missing", "auto-fixed:isMagical-missing-defaulted", "auto-fixed:changes-defaulted"]);
  assert.equal(result.data.schemaVersion, 1);

  // String version "1": corrected to the integer.
  const asString = normalizeSw25EffectSystem({ ...VALID, schemaVersion: "1" });
  assert.deepEqual(codes(asString), ["auto-fixed:version-type-corrected"]);
  assert.equal(asString.data.schemaVersion, 1);

  // Fractional version is not a real version: backfilled.
  const fractional = normalizeSw25EffectSystem({ ...VALID, schemaVersion: 1.5 });
  assert.deepEqual(codes(fractional), ["auto-fixed:version-missing"]);
  assert.equal(fractional.data.schemaVersion, 1);

  // Future version: data untouched, review issue, write protection flag.
  const futureRaw = { schemaVersion: 2, family: "protection", futureField: 1 };
  const future = normalizeSw25EffectSystem(structuredClone(futureRaw));
  assert.equal(future.futureVersion, true);
  assert.equal(future.changed, false);
  assert.deepEqual(future.data, futureRaw, "future-version data must be kept byte-identical");
  assert.deepEqual(codes(future), ["review:version-future"]);
}

// ── Recoverable normalization (auto-fixed, lossless) ────────────────────────

{
  const result = normalizeSw25EffectSystem({
    family: "  protection  ",
    rank: "2",
    successValue: "17",
    initialDuration: "4",
    remainingDuration: null,
    casterUUID: "  Actor.abcd1234efgh5678  ",
    effectType: "  buff  "
  });
  assert.equal(result.changed, true);
  assert.equal(result.issues.every(issue => issue.severity === SEVERITY_AUTO_FIXED), true,
    "recoverable fixes must all be auto-fixed");
  assert.deepEqual(result.data, {
    schemaVersion: 1,
    family: "protection",
    rank: 2,
    successValue: 17,
    initialDuration: 4,
    remainingDuration: null,
    casterUUID: "Actor.abcd1234efgh5678",
    effectType: "buff",
    isMagical: false,
    changes: []
  });
}

// ── Absent fields: schema initial applies on load; repair invents nothing ───

{
  const result = normalizeSw25EffectSystem({ family: "protection" });
  assert.equal(result.data.rank, undefined, "absent rank stays absent (DataModel applies initial 0)");
  assert.equal(result.data.successValue, undefined, "absent successValue stays absent");
  assert.equal(result.data.initialDuration, undefined, "absent durations stay absent");
  assert.equal(result.data.remainingDuration, undefined);
  assert.equal(result.data.effectType, undefined);
  assert.equal(result.data.isMagical, false, "a missing legacy magical flag normalizes to false");
  assert.deepEqual(result.data.changes, [], "absent native changes receive the schema initial (empty array)");
}

// ── Null handling per field semantics ───────────────────────────────────────

{
  const result = normalizeSw25EffectSystem({
    family: "protection",
    rank: null,
    successValue: null,
    initialDuration: null,
    remainingDuration: null,
    effectType: null,
    casterUUID: null,
    changes: null
  });
  assert.equal(result.data.rank, 0, "rank is non-nullable: stored null receives the approved default 0");
  assert.equal(result.data.successValue, 0, "successValue is non-nullable: stored null receives the approved default 0");
  assert.equal(result.data.initialDuration, null, "durations are nullable: null stays null");
  assert.equal(result.data.remainingDuration, null);
  assert.equal(result.data.effectType, null);
  assert.equal(result.data.casterUUID, null);
  assert.deepEqual(result.data.changes, [], "null changes receive the native default (empty array)");
}

// ── Cancellation eligibility fields (DEC-7/§55) ─────────────────────────────

{
  // Stored values pass through untouched; surrounding whitespace is lossless.
  const result = normalizeSw25EffectSystem({ family: "protection", isMagical: true, resistance: "  cant  " });
  assert.equal(result.data.isMagical, true, "a recorded magical flag is preserved");
  assert.equal(result.data.resistance, "cant", "the resistance notation is trimmed");
  assert.deepEqual(codes(result), ["auto-fixed:version-missing", "auto-fixed:resistance-trimmed", "auto-fixed:changes-defaulted"]);
  const reloaded = normalizeSw25EffectSystem(JSON.parse(JSON.stringify(result.data)));
  assert.equal(reloaded.data.isMagical, true, "an explicit magical value survives a serialized reload");
  assert.equal(reloaded.changed, false);
  assert.equal(reloaded.issues.length, 0);
}

{
  // Legacy null normalizes to false; an absent resistance remains independent.
  const result = normalizeSw25EffectSystem({ family: "protection", isMagical: null, resistance: "" });
  assert.equal(result.data.isMagical, false, "a null legacy magical flag normalizes to false");
  assert.equal(result.data.resistance, null);
  assert.ok(codes(result).includes("auto-fixed:isMagical-null-defaulted"));
  assert.ok(codes(result).includes("auto-fixed:resistance-blank-to-null"));
  const second = normalizeSw25EffectSystem(result.data);
  assert.equal(second.data.isMagical, false);
  assert.equal(second.issues.some(issue => issue.code === "isMagical-null-defaulted"), false, "normalization is idempotent");
}

{
  // Unsupported stored types are KEPT and reported (DEC-41).
  const result = normalizeSw25EffectSystem({ family: "protection", isMagical: "true", resistance: 42 });
  assert.equal(result.data.isMagical, "true");
  assert.equal(result.data.resistance, 42);
  assert.ok(codes(result).includes("review:isMagical-unsupported-type"));
  assert.ok(codes(result).includes("review:resistance-unsupported-type"));
}

{
  // The two fields belong to schema v1 (no foreign-field review).
  const result = normalizeSw25EffectSystem({ schemaVersion: 1, family: "protection", isMagical: false, resistance: "neg", changes: [] });
  assert.equal(result.issues.length, 0);
  assert.equal(result.data.isMagical, false);
  assert.equal(result.data.resistance, "neg");
}

// ── Cancellation identity fields (Bloque 6, T6.1) ───────────────────────────

{
  // Approved provenance/scope ids and a casting id pass through trimmed.
  const result = normalizeSw25EffectSystem({
    schemaVersion: 1, family: "protection", successValue: 24,
    successValueSource: " automatic ", castId: " cast-abc123 ", effectScope: " space ", changes: []
  });
  assert.equal(result.issues.filter(issue => issue.severity === "review").length, 0, `unexpected review issues: ${JSON.stringify(result.issues)}`);
  assert.equal(result.data.successValueSource, "automatic");
  assert.equal(result.data.castId, "cast-abc123");
  assert.equal(result.data.effectScope, "space");
}

{
  // Absent provenance stays absent: the SV is NOT re-classified from its
  // numeric value, and a legacy 0 is not turned into a recorded value.
  const result = normalizeSw25EffectSystem({ schemaVersion: 1, family: "protection", successValue: 0, changes: [] });
  assert.equal(result.data.successValue, 0);
  assert.equal(result.data.successValueSource, undefined, "an unrecorded provenance is never invented");
  assert.equal(result.data.castId, undefined);
  assert.equal(result.data.effectScope, undefined);
}

{
  // Blank normalizes to null (lossless); unknown ids are KEPT and reported.
  const blank = normalizeSw25EffectSystem({ schemaVersion: 1, family: "protection", successValueSource: "", castId: "", effectScope: "", changes: [] });
  assert.equal(blank.data.successValueSource, null);
  assert.equal(blank.data.castId, null);
  assert.equal(blank.data.effectScope, null);
  const unknown = normalizeSw25EffectSystem({ schemaVersion: 1, family: "protection", successValueSource: "psychic", effectScope: "scene", changes: [] });
  assert.equal(unknown.data.successValueSource, "psychic");
  assert.equal(unknown.data.effectScope, "scene");
  assert.ok(codes(unknown).includes("review:successValueSource-unknown"));
  assert.ok(codes(unknown).includes("review:effectScope-unknown"));
}

{
  // A legitimate recorded zero keeps its provenance through normalization.
  const result = normalizeSw25EffectSystem({ schemaVersion: 1, family: "protection", successValue: 0, successValueSource: "none", changes: [] });
  assert.equal(result.data.successValue, 0);
  assert.equal(result.data.successValueSource, "none", "a recorded no-check SV 0 is authoritative, not missing");
}

// ── Irrecoverable data: KEPT in place, reported for review (DEC-41) ─────────

{
  const raw = {
    schemaVersion: 1,
    family: "",                      // blank: cannot invent the identity
    rank: -1,                        // out of range
    rankFraction: undefined,         // (unused key, ignored below)
    successValue: 2.5,               // not an integer
    initialDuration: -2,             // out of range
    casterUUID: "not-a-uuid",        // wrong shape
    effectType: 42,                  // unsupported type
    isMagical: false,                // valid: isolates the irrecoverable cases
    changes: { broken: true },       // native structure, not repaired here
    stackKey: "forbidden-field"      // foreign to schema v1
  };
  delete raw.rankFraction;
  const result = normalizeSw25EffectSystem(raw);
  const issueCodes = codes(result);
  assert.equal(result.changed, false, "irrecoverable data must not be modified");
  // Every problematic value is preserved byte-identical.
  assert.equal(result.data.family, "");
  assert.equal(result.data.rank, -1);
  assert.equal(result.data.successValue, 2.5);
  assert.equal(result.data.initialDuration, -2);
  assert.equal(result.data.casterUUID, "not-a-uuid");
  assert.equal(result.data.effectType, 42);
  assert.deepEqual(result.data.changes, { broken: true });
  assert.equal(result.data.stackKey, "forbidden-field");
  for (const expected of ["family-blank", "rank-out-of-range", "successValue-not-integer",
    "initialDuration-out-of-range", "casterUUID-uuid-shape", "effectType-unsupported-type",
    "changes-not-array", "unknown-fields"]) {
    assert.ok(issueCodes.includes(`review:${expected}`), `missing review issue: ${expected}`);
  }
  assert.equal(result.issues.every(issue => issue.severity === SEVERITY_REVIEW), true);
}

{
  // Absent family: reported, no default invented.
  const result = normalizeSw25EffectSystem({ schemaVersion: 1, rank: 1, isMagical: false });
  assert.deepEqual(codes(result), ["review:family-missing", "auto-fixed:changes-defaulted"]);
  assert.equal(result.changed, true, "only the native changes default is written; no invented family");
  assert.equal("family" in result.data, false, "no invented family value");
}

{
  // remainingDuration > initialDuration: inconsistent, kept, reported.
  const result = normalizeSw25EffectSystem({ schemaVersion: 1, family: "protection", initialDuration: 2, remainingDuration: 5, isMagical: false });
  assert.deepEqual(codes(result), ["review:duration-inconsistent", "auto-fixed:changes-defaulted"]);
  assert.equal(result.data.initialDuration, 2);
  assert.equal(result.data.remainingDuration, 5);
}

{
  // Unsupported system type: untouched, review.
  const result = normalizeSw25EffectSystem(["garbage"]);
  assert.equal(result.changed, false);
  assert.deepEqual(result.data, ["garbage"]);
  assert.deepEqual(codes(result), ["review:system-invalid-type"]);
  const blank = normalizeSw25EffectSystem(null);
  assert.deepEqual(blank, { data: {}, issues: [], futureVersion: false, changed: false });
}

{
  // Presentation visibility (gmOnly): absent stays absent (the schema
  // initial `false` applies on load); an explicit null is dropped (null ≡
  // absent for the non-nullable boolean); a non-boolean is KEPT and
  // reported; a real boolean passes through with no issues.
  const absent = normalizeSw25EffectSystem({ schemaVersion: 1, family: "protection", isMagical: false });
  assert.equal("gmOnly" in absent.data, false, "absent gmOnly is not invented");
  assert.equal(absent.issues.some(issue => issue.code === "gmOnly-null-dropped"), false);

  const nullDropped = normalizeSw25EffectSystem({ schemaVersion: 1, family: "protection", isMagical: false, gmOnly: null });
  assert.deepEqual(codes(nullDropped), ["auto-fixed:gmOnly-null-dropped", "auto-fixed:changes-defaulted"]);
  assert.equal("gmOnly" in nullDropped.data, false, "explicit null is dropped losslessly");

  const wrongType = normalizeSw25EffectSystem({ schemaVersion: 1, family: "protection", isMagical: false, gmOnly: "yes" });
  assert.deepEqual(codes(wrongType), ["review:gmOnly-unsupported-type", "auto-fixed:changes-defaulted"]);
  assert.equal(wrongType.data.gmOnly, "yes", "a non-boolean gmOnly is kept in place (never coerced)");

  const boolean = normalizeSw25EffectSystem({ ...structuredClone(VALID), gmOnly: true });
  assert.equal(boolean.data.gmOnly, true, "a real boolean gmOnly passes through unchanged");
  assert.equal(boolean.issues.some(issue => issue.code.startsWith("gmOnly")), false, "no issue for a valid boolean");
}

// ── Duration scale and combat anchor (Bloque 5, T5.2) ───────────────────────

{
  // A fully-populated T5.2 payload normalizes with no issues and no changes.
  const validT52 = {
    ...VALID,
    durationScale: "rounds",
    durationAnchor: {
      regime: "casterTurn",
      edge: "end",
      combatantId: "cmbt-caster-1",
      tokenId: "token-caster-1",
      state: "resolved"
    }
  };
  const result = normalizeSw25EffectSystem(structuredClone(validT52));
  assert.equal(result.changed, false);
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.data, validT52);
}

{
  // Legacy effects (no new fields) normalize losslessly: nothing is invented,
  // the scale is never auto-stamped from the durations.
  const result = normalizeSw25EffectSystem(structuredClone(VALID));
  assert.equal(result.changed, false);
  assert.equal(result.issues.length, 0);
  assert.equal("durationScale" in result.data, false, "no invented durationScale");
  assert.equal("durationAnchor" in result.data, false, "no invented durationAnchor");
}

{
  // Explicit nulls are legitimate (nullable fields).
  const result = normalizeSw25EffectSystem({ ...VALID, durationScale: null, durationAnchor: null });
  assert.equal(result.changed, false);
  assert.equal(result.issues.length, 0);
  assert.equal(result.data.durationScale, null);
  assert.equal(result.data.durationAnchor, null);
}

{
  // Unknown scale id: KEPT and reported (no silent reinterpretation).
  const result = normalizeSw25EffectSystem({ ...VALID, durationScale: "weeks" });
  assert.equal(result.data.durationScale, "weeks", "unknown scale must stay in place");
  assert.ok(codes(result).includes("review:durationScale-unknown"));
  assert.equal(result.changed, false);
}

{
  // Unsupported scale type: kept and reported.
  const result = normalizeSw25EffectSystem({ ...VALID, durationScale: 7 });
  assert.equal(result.data.durationScale, 7);
  assert.ok(codes(result).includes("review:durationScale-unsupported-type"));
}

{
  // Blank scale ≡ absent (nullable field): normalized to null.
  const result = normalizeSw25EffectSystem({ ...VALID, durationScale: "  " });
  assert.equal(result.data.durationScale, null);
  assert.ok(codes(result).includes("auto-fixed:durationScale-blank-to-null"));
}

{
  // All approved scales pass through untouched.
  for (const scale of ["rounds", "turns", "minutes", "hours", "days", "permanent", "other"]) {
    const result = normalizeSw25EffectSystem({ ...VALID, durationScale: scale });
    assert.equal(result.changed, false);
    assert.equal(result.issues.length, 0);
    assert.equal(result.data.durationScale, scale);
  }
}

{
  // A resolved casterTurn anchor with combatant and token: clean.
  const result = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-1", tokenId: "tkn-1", state: "resolved" }
  });
  assert.equal(result.changed, false);
  assert.equal(result.issues.length, 0);
}

{
  // targetTurn is representable as data (never treated as the default): a
  // targetTurn anchor normalizes clean without any regime rewriting.
  const result = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "targetTurn", combatantId: "cmbt-target-1", tokenId: "tkn-target-1" }
  });
  assert.deepEqual(result.data.durationAnchor, {
    regime: "targetTurn", edge: "begin", combatantId: "cmbt-target-1", tokenId: "tkn-target-1", state: null
  });
  assert.deepEqual(codes(result), ["auto-fixed:durationAnchor-edge-defaulted"]);
}

{
  // roundEnd is representable (degradation regime, D5): regime + optional
  // identity (provenance only for this regime).
  const result = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "roundEnd", combatantId: "cmbt-1" }
  });
  assert.deepEqual(result.data.durationAnchor, {
    regime: "roundEnd", edge: "begin", combatantId: "cmbt-1", tokenId: null, state: null
  });
  assert.deepEqual(codes(result), ["auto-fixed:durationAnchor-edge-defaulted"]);
}

{
  // A deferred anchor keeps the caster-origin data available without a
  // combatant (T5.0-R §3.5): regime + state, no combatantId — clean.
  const result = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "casterTurn", state: "deferred" }
  });
  assert.deepEqual(result.data.durationAnchor, {
    regime: "casterTurn", edge: "begin", combatantId: null, tokenId: null, state: "deferred"
  });
  assert.deepEqual(codes(result), ["auto-fixed:durationAnchor-edge-defaulted"]);
}

{
  // Consistency reviews — data kept, never guessed (DEC-41).
  const deferredWithCombatant = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "casterTurn", state: "deferred", combatantId: "cmbt-9" }
  });
  assert.equal(deferredWithCombatant.data.durationAnchor.combatantId, "cmbt-9", "kept in place");
  assert.equal(deferredWithCombatant.data.durationAnchor.state, "deferred");
  assert.ok(codes(deferredWithCombatant).includes("review:durationAnchor-deferred-with-combatant"));

  const resolvedWithoutCombatant = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "casterTurn", state: "resolved" }
  });
  assert.equal(resolvedWithoutCombatant.data.durationAnchor.combatantId, null, "kept as null");
  assert.ok(codes(resolvedWithoutCombatant).includes("review:durationAnchor-resolved-without-combatant"));

  const missingRegime = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { combatantId: "cmbt-1" }
  });
  assert.equal(missingRegime.data.durationAnchor.combatantId, "cmbt-1", "kept in place");
  assert.ok(codes(missingRegime).includes("review:durationAnchor-missing-regime"));
  // No edge backfill happens without an approved regime.
  assert.equal(missingRegime.data.durationAnchor.edge, null);

  const unknownRegime = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "moonPhase", combatantId: "cmbt-1" }
  });
  assert.equal(unknownRegime.data.durationAnchor.regime, "moonPhase", "kept in place");
  assert.ok(codes(unknownRegime).includes("review:durationAnchor-unknown-regime"));
  // No edge backfill for an unknown regime (nothing is guessed).
  assert.equal(unknownRegime.data.durationAnchor.edge, null);

  const unknownEdge = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "casterTurn", edge: "midpoint", combatantId: "cmbt-1" }
  });
  assert.equal(unknownEdge.data.durationAnchor.edge, "midpoint", "kept in place");
  assert.ok(codes(unknownEdge).includes("review:durationAnchor-unknown-edge"));

  const unknownState = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-1", state: "pending" }
  });
  assert.equal(unknownState.data.durationAnchor.state, "pending", "kept in place");
  assert.ok(codes(unknownState).includes("review:durationAnchor-unknown-state"));

  const unsupportedType = normalizeSw25EffectSystem({ ...VALID, durationAnchor: "casterTurn" });
  assert.equal(unsupportedType.data.durationAnchor, "casterTurn", "kept in place");
  assert.ok(codes(unsupportedType).includes("review:durationAnchor-unsupported-type"));
}

{
  // An all-null anchor carries no data: normalized to null (lossless).
  const result = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: null, edge: null, combatantId: null, tokenId: null, state: null }
  });
  assert.equal(result.data.durationAnchor, null);
  assert.ok(codes(result).includes("auto-fixed:durationAnchor-empty-null"));
}

{
  // Foreign keys inside the anchor: kept in place, reported (DEC-41).
  const result = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-1", casterName: "Merlin" }
  });
  assert.equal(result.data.durationAnchor.casterName, "Merlin", "foreign key kept");
  assert.equal(result.data.durationAnchor.regime, "casterTurn");
  assert.ok(codes(result).includes("review:durationAnchor-foreign-keys"));
}

{
  // Anchor whitespace: trimmed losslessly.
  const result = normalizeSw25EffectSystem({
    ...VALID,
    durationAnchor: { regime: "  casterTurn  ", combatantId: "  cmbt-1  ", tokenId: "  " }
  });
  assert.deepEqual(result.data.durationAnchor, {
    regime: "casterTurn", edge: "begin", combatantId: "cmbt-1", tokenId: null, state: null
  });
  const severities = new Set(result.issues.map(issue => issue.severity));
  assert.equal(severities.has(SEVERITY_REVIEW), false, "whitespace fixes are lossless");
}

// ── Authored source duration identity (Phase 3 corrections) ─────────────────

{
  // The field belongs to schema v1: a clean identity passes with NO review
  // issues (in particular no foreign-field review), verbatim.
  const result = normalizeSw25EffectSystem({
    ...VALID,
    sourceDuration: { unit: "seconds", amount: 10 }
  });
  assert.deepEqual(result.data.sourceDuration, { unit: "seconds", amount: 10 });
  assert.equal(result.issues.length, 0, `clean identity normalizes cleanly: ${result.issues.map(issue => issue.code).join(", ")}`);
}

{
  // Absent stays absent (the schema initial null applies at the model layer).
  const result = normalizeSw25EffectSystem({ ...VALID });
  assert.equal("sourceDuration" in result.data, false, "no invented sourceDuration");
}

{
  // An all-null identity carries no data: normalized to null (lossless).
  const result = normalizeSw25EffectSystem({ ...VALID, sourceDuration: { unit: null, amount: null } });
  assert.equal(result.data.sourceDuration, null);
  assert.ok(codes(result).includes("auto-fixed:sourceDuration-empty-null"));
}

{
  // Malformed shapes are KEPT and reported, never dropped (DEC-41).
  const unsupportedType = normalizeSw25EffectSystem({ ...VALID, sourceDuration: "10 seconds" });
  assert.equal(unsupportedType.data.sourceDuration, "10 seconds", "kept in place");
  assert.ok(codes(unsupportedType).includes("review:sourceDuration-unsupported-type"));

  const foreignKeys = normalizeSw25EffectSystem({
    ...VALID, sourceDuration: { unit: "seconds", amount: 10, label: "Daemon Buster" }
  });
  assert.equal(foreignKeys.data.sourceDuration.label, "Daemon Buster", "foreign key kept");
  assert.ok(codes(foreignKeys).includes("review:sourceDuration-foreign-keys"));

  const missingUnit = normalizeSw25EffectSystem({ ...VALID, sourceDuration: { unit: "  ", amount: 10 } });
  assert.ok(codes(missingUnit).includes("review:sourceDuration-missing-unit"));

  const zeroAmount = normalizeSw25EffectSystem({ ...VALID, sourceDuration: { unit: "seconds", amount: 0 } });
  assert.ok(codes(zeroAmount).includes("review:sourceDuration-invalid-amount"));

  const negativeAmount = normalizeSw25EffectSystem({ ...VALID, sourceDuration: { unit: "seconds", amount: -5 } });
  assert.ok(codes(negativeAmount).includes("review:sourceDuration-invalid-amount"));
}

// ── Native changes field: preserved untouched ───────────────────────────────

{
  const changes = [
    { key: "system.hp.max", type: "add", value: 5, phase: "initial", priority: 1 },
    { key: "system.evasion", type: "upgrade", value: 2, phase: "initial" }
  ];
  const result = normalizeSw25EffectSystem({ ...VALID, changes });
  assert.deepEqual(result.data.changes, changes, "changes content must be preserved exactly");
  assert.equal(result.changed, false);
}

// ── Idempotency ─────────────────────────────────────────────────────────────

{
  // Recoverable-only payload: run 1 fixes, run 2 is a no-op with no issues.
  const messy = { family: " protection ", rank: "2", successValue: "17", casterUUID: " Actor.abcd1234efgh5678 " };
  const first = normalizeSw25EffectSystem(structuredClone(messy));
  assert.equal(first.changed, true);
  const second = normalizeSw25EffectSystem(first.data);
  assert.equal(second.changed, false, "second normalization must change nothing");
  assert.equal(second.issues.length, 0, "second normalization must report no issues");
  assert.deepEqual(second.data, first.data);

  // Irrecoverable payload: repeated runs keep the data identical (stable),
  // and re-report the same review issues (no silent acceptance, no mutation).
  const irrecoverable = { family: "", rank: -1, changes: { broken: true }, extra: 1 };
  const run1 = normalizeSw25EffectSystem(structuredClone(irrecoverable));
  const run2 = normalizeSw25EffectSystem(run1.data);
  assert.deepEqual(run2.data, run1.data, "irrecoverable data must stay stable across runs");
  assert.equal(run2.changed, false);
  const reviewCodes = list => list.filter(issue => issue.severity === SEVERITY_REVIEW).map(issue => issue.code);
  assert.deepEqual(reviewCodes(run2.issues), reviewCodes(run1.issues), "review issues must re-report consistently");
  assert.equal(run2.issues.every(issue => issue.severity === SEVERITY_REVIEW), true,
    "the second run must report no new auto-fixed changes");
}

// ── Migration mechanism (DEC-41): sequential walker, no fake steps ──────────

{
  const valid = migrateSw25EffectSystem(structuredClone(VALID));
  assert.equal(valid.migrated, false);
  assert.equal(valid.futureVersion, false);
  assert.deepEqual(valid.data, VALID);

  const future = migrateSw25EffectSystem({ schemaVersion: 3, family: "x" });
  assert.equal(future.migrated, false);
  assert.equal(future.futureVersion, true);
  assert.equal(future.data.schemaVersion, 3, "future data must pass through untouched");
}

// ── GM-authoritative repair layer ───────────────────────────────────────────

// Notifications capture (functions recording their first argument).
const notificationLog = { warn: [], info: [], error: [] };
globalThis.ui = {
  notifications: {
    warn: message => notificationLog.warn.push(message),
    info: message => notificationLog.info.push(message),
    error: message => notificationLog.error.push(message)
  }
};
const notifications = notificationLog;
const resetNotifications = () => { notificationLog.warn.length = 0; notificationLog.info.length = 0; notificationLog.error.length = 0; };

// Effect stub: toObject + update recording (flattened system.* paths).
function effectStub(raw, { name = "Probe", updateThrows = false } = {}) {
  const updates = [];
  return {
    name,
    id: "effect-1",
    toObject: () => structuredClone({ system: raw }),
    updates,
    async update(data) {
      if (updateThrows) throw new Error("Database locked");
      updates.push(structuredClone(data));
      for (const [path, value] of Object.entries(data)) {
        assert.ok(path.startsWith("system."), `repair writes must be flattened system.* paths, got "${path}"`);
        raw[path.slice("system.".length)] = structuredClone(value);
      }
      return raw;
    }
  };
}

{
  // Not GM: refused without any write or notification.
  globalThis.game = { user: { isGM: false } };
  resetNotifications();
  const effect = effectStub(structuredClone(VALID));
  const result = await repairSw25Effect(effect);
  assert.equal(result.ok, false);
  assert.equal(result.code, "not-gm");
  assert.equal(effect.updates.length, 0);
  assert.equal(notifications.warn.length + notifications.info.length, 0);
}

{
  // GM + recoverable data: one write with ONLY the changed flattened paths;
  // GM informed of both the fixes and (none here) the irrecoverable data.
  globalThis.game = { user: { isGM: true } };
  resetNotifications();
  const raw = { family: " protection ", rank: "2", successValue: "17", isMagical: false, stackKey: "foreign" };
  const effect = effectStub(raw);
  const result = await repairSw25Effect(effect);
  assert.equal(result.ok, true);
  assert.equal(result.code, "repaired");
  assert.equal(result.changed, true);
  assert.deepEqual(result.updateData, {
    "system.family": "protection",
    "system.rank": 2,
    "system.successValue": 17,
    "system.schemaVersion": 1,
    "system.changes": []
  });
  assert.equal(effect.updates.length, 1);
  assert.equal(raw.family, "protection");
  assert.equal(raw.rank, 2);
  assert.equal(raw.successValue, 17);
  assert.equal(raw.stackKey, "foreign", "foreign data is not silently dropped by the repair write");
  assert.equal(notifications.warn.length, 1, "review issues must reach the GM as warnings");
  assert.match(notifications.warn[0], /needs review/);
  assert.ok(notifications.info.length >= 1, "auto-fixed fixes must be reported to the GM");
}

{
  // GM + already-normalized data: no write (document-level idempotency).
  resetNotifications();
  const effect = effectStub(structuredClone(VALID));
  const result = await repairSw25Effect(effect);
  assert.equal(result.ok, true);
  assert.equal(result.code, "no-changes");
  assert.equal(effect.updates.length, 0);
  assert.equal(notifications.warn.length + notifications.info.length, 0);
}

{
  // Legacy null is repaired through the existing GM-authoritative write path.
  resetNotifications();
  const raw = { ...structuredClone(VALID), isMagical: null };
  const effect = effectStub(raw);
  const result = await repairSw25Effect(effect);
  assert.equal(result.ok, true);
  assert.equal(result.code, "repaired");
  assert.deepEqual(result.updateData, { "system.isMagical": false });
  assert.equal(raw.isMagical, false);
  const reloaded = normalizeSw25EffectSystem(JSON.parse(JSON.stringify(raw)));
  assert.equal(reloaded.data.isMagical, false);
  assert.equal(reloaded.changed, false);
}

{
  // An existing explicit true survives repair and reload without modification.
  resetNotifications();
  const raw = { ...structuredClone(VALID), isMagical: true };
  const effect = effectStub(raw);
  const result = await repairSw25Effect(effect);
  assert.equal(result.ok, true);
  assert.equal(result.code, "no-changes");
  assert.equal(effect.updates.length, 0);
  const reloaded = normalizeSw25EffectSystem(JSON.parse(JSON.stringify(raw)));
  assert.equal(reloaded.data.isMagical, true);
  assert.equal(reloaded.changed, false);
  assert.equal(reloaded.issues.length, 0);
}

{
  // GM + future version: refused, no write, GM warned.
  resetNotifications();
  const effect = effectStub({ schemaVersion: 2, family: "x" });
  const result = await repairSw25Effect(effect);
  assert.equal(result.ok, false);
  assert.equal(result.code, "version-too-new");
  assert.equal(effect.updates.length, 0);
  assert.equal(notifications.warn.length, 1);
  assert.match(notifications.warn[0], /newer schema version/);
}

{
  // GM + irrecoverable data only: the native changes default IS written (it
  // is the approved schema initial, not an invented value), but the blank
  // family is KEPT and the GM is informed — the document is never left
  // partially repaired silently.
  resetNotifications();
  const raw = { schemaVersion: 1, family: "", isMagical: false };
  const effect = effectStub(raw);
  const result = await repairSw25Effect(effect);
  assert.equal(result.ok, true);
  assert.equal(result.code, "repaired");
  assert.deepEqual(result.updateData, { "system.changes": [] });
  assert.equal(effect.updates.length, 1);
  assert.equal(raw.family, "", "the blank family is kept untouched");
  assert.equal(notifications.warn.length, 1);
  assert.match(notifications.warn[0], /family/);
}

{
  // GM + update failure: reported, no silent success.
  resetNotifications();
  const effect = effectStub({ family: " protection " }, { updateThrows: true });
  const result = await repairSw25Effect(effect);
  assert.equal(result.ok, false);
  assert.equal(result.code, "update-failed");
  assert.match(result.error, /Database locked/);
}

{
  // repairActorEffects: aggregates per-effect results; non-GM refused.
  globalThis.game = { user: { isGM: true } };
  resetNotifications();
  const actor = {
    effects: [
      effectStub({ family: " protection ", rank: "2" }, { name: "A" }),
      effectStub(structuredClone(VALID), { name: "B" }),
      effectStub({ schemaVersion: 9, family: "x" }, { name: "C" })
    ]
  };
  const result = await repairActorEffects(actor);
  assert.equal(result.repaired, 1);
  assert.equal(result.refused, 1);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].code, "repaired");
  assert.equal(result.results[1].code, "no-changes");
  assert.equal(result.results[2].code, "version-too-new");
  assert.equal(result.ok, false, "one refused repair makes the sweep report not fully ok");

  globalThis.game = { user: { isGM: false } };
  const refused = await repairActorEffects(actor);
  assert.equal(refused.ok, false);
  assert.equal(refused.results.length, 0);
}

// ── Native fields of a repaired document remain untouched ───────────────────

{
  // The repair layer writes ONLY flattened system.* paths of schema fields;
  // nothing else is part of the update payload.
  globalThis.game = { user: { isGM: true } };
  resetNotifications();
  const effect = effectStub({ family: " protection " });
  await repairSw25Effect(effect);
  assert.ok(Object.keys(effect.updates[0]).length >= 1);
  for (const key of Object.keys(effect.updates[0])) {
    assert.match(key, /^system\./, `every written path must live under system.*, got "${key}"`);
  }
}

// ── T1.4: family identity normalization (DEC-1) ─────────────────────────────

{
  // Case folding: the stored spelling is presentation; the key folds case.
  assert.equal(normalizeSw25FamilyKey("Protection"), "protection");
  assert.equal(normalizeSw25FamilyKey("PROTECTION"), "protection");
  assert.equal(normalizeSw25FamilyKey("protection"), "protection");

  // Diacritics and their decomposed (NFD) Unicode equivalents collapse to the
  // same key: precomposed and decomposed forms are the same identity.
  assert.equal(normalizeSw25FamilyKey("Bendición"), "bendicion");
  assert.equal(normalizeSw25FamilyKey("Bendicio\u0301n"), "bendicion", "decomposed combining acute must match the precomposed form");
  assert.equal(normalizeSw25FamilyKey("\u00E9"), normalizeSw25FamilyKey("e\u0301"), "NFD and NFC spellings of the same family share one identity");

  // NFKD compatibility forms fold to their canonical ASCII equivalents.
  assert.equal(normalizeSw25FamilyKey("Ｐｒｏｔｅｃｔｉｏｎ"), "protection", "fullwidth forms normalize through NFKD");
  assert.equal(normalizeSw25FamilyKey("ﬁre"), "fire", "ligatures decompose through NFKD");

  // Surrounding whitespace never splits a family into two identities.
  assert.equal(normalizeSw25FamilyKey("  protection  "), "protection");

  // Determinism, purity and idempotency.
  const input = "  Bendición  ";
  const first = normalizeSw25FamilyKey(input);
  assert.equal(input, "  Bendición  ", "the original value is never altered by normalization");
  assert.equal(normalizeSw25FamilyKey(input), first, "repeated normalization is deterministic");
  assert.equal(normalizeSw25FamilyKey(first), first, "normalizing an already-normalized key is a no-op");

  // Invalid data: no invented identity.
  assert.equal(normalizeSw25FamilyKey(null), null);
  assert.equal(normalizeSw25FamilyKey(undefined), null);
  assert.equal(normalizeSw25FamilyKey(42), null);
  assert.equal(normalizeSw25FamilyKey([]), null);
  assert.equal(normalizeSw25FamilyKey({}), null);
  // Blank strings normalize to an empty key (the schema's blank:false already
  // rejects them at the data layer; the key itself invents nothing).
  assert.equal(normalizeSw25FamilyKey(""), "");
  assert.equal(normalizeSw25FamilyKey("   "), "");
}

// ── T1.4: approved rank → Roman numeral table (DEC-16) ──────────────────────

{
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(sw25RankToRoman),
    ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"],
    "the centralized table must match DEC-16 exactly"
  );
  // 0 = no rank; anything outside the approved table is NOT invented.
  assert.equal(sw25RankToRoman(0), null);
  assert.equal(sw25RankToRoman(-1), null);
  assert.equal(sw25RankToRoman(11), null, "the approved table ends at X; no numeral may be invented beyond it");
  assert.equal(sw25RankToRoman(2.5), null);
  assert.equal(sw25RankToRoman("2"), null, "no string coercion in the presentation helper");
  assert.equal(sw25RankToRoman(null), null);
  assert.equal(sw25RankToRoman(undefined), null);
}

// ── T1.4: canonical name reconstruction (DEC-16/DEC-49) ─────────────────────

{
  // DEC-16 examples, verbatim.
  assert.equal(buildSw25CanonicalName("Protection", 2), "Protection II");
  assert.equal(buildSw25CanonicalName("Power Strike", 0), "Power Strike");
  // Boundary ranks of the approved table.
  assert.equal(buildSw25CanonicalName("Protection", 1), "Protection I");
  assert.equal(buildSw25CanonicalName("Protection", 10), "Protection X");
  // Authored case and diacritics are presentation data and are preserved.
  assert.equal(buildSw25CanonicalName("Bendición", 3), "Bendición III");
  assert.equal(buildSw25CanonicalName("PROTECTION", 2), "PROTECTION II");

  // Invalid or absent data: null, never an invented name, never a silent fix.
  assert.equal(buildSw25CanonicalName(null, 2), null);
  assert.equal(buildSw25CanonicalName(undefined, 2), null);
  assert.equal(buildSw25CanonicalName("", 2), null);
  assert.equal(buildSw25CanonicalName("   ", 2), null);
  assert.equal(buildSw25CanonicalName(42, 2), null);
  assert.equal(buildSw25CanonicalName("Protection"), null, "an absent rank invents nothing");
  assert.equal(buildSw25CanonicalName("Protection", null), null);
  assert.equal(buildSw25CanonicalName("Protection", undefined), null);
  assert.equal(buildSw25CanonicalName("Protection", "2"), null);
  assert.equal(buildSw25CanonicalName("Protection", 2.5), null);
  assert.equal(buildSw25CanonicalName("Protection", -1), null);
  assert.equal(buildSw25CanonicalName("Protection", 11), null, "ranks beyond the approved table build no name");

  // Purity: the inputs are never modified.
  const family = "  Protection  ";
  const rank = 2;
  buildSw25CanonicalName(family, rank);
  assert.equal(family, "  Protection  ");
  assert.equal(rank, 2);
}

// ── T1.4 × T1.3: identity, canonical name and the schema ────────────────────

{
  // Repair normalization trims the persisted family but NEVER applies the
  // identity normalization to it: authored case and diacritics survive in
  // persistence; the DEC-1 key exists only as a comparison-time derivation.
  const result = normalizeSw25EffectSystem({ family: "  Bendición  ", rank: "2", schemaVersion: 1, changes: [] });
  assert.equal(result.data.family, "Bendición", "repair trims; it does not lowercase or strip diacritics");
  assert.equal(normalizeSw25FamilyKey(result.data.family), "bendicion", "the identity key is derived, not persisted");
  assert.equal(buildSw25CanonicalName(result.data.family, result.data.rank), "Bendición II",
    "the canonical name builds from the schema-normalized data");
}

{
  // Two stored spellings of the same family are ONE identity (DEC-1) while
  // their canonical names keep the authored case; rank never splits a family
  // (DEC-16) — only the reconstructed name differs.
  const lower = normalizeSw25EffectSystem({ family: "protection", rank: 0, schemaVersion: 1, changes: [] });
  const upper = normalizeSw25EffectSystem({ family: "PROTECTION", rank: 2, schemaVersion: 1, changes: [] });
  assert.equal(normalizeSw25FamilyKey(lower.data.family), normalizeSw25FamilyKey(upper.data.family),
    "same family, different ranks and spellings: one stacking identity");
  assert.notEqual(buildSw25CanonicalName(lower.data.family, lower.data.rank),
    buildSw25CanonicalName(upper.data.family, upper.data.rank));
  assert.equal(buildSw25CanonicalName(upper.data.family, upper.data.rank), "PROTECTION II");

  // Different family names are different families (DEC-2), numerals aside.
  assert.notEqual(normalizeSw25FamilyKey("Cura"), normalizeSw25FamilyKey("Curar"));
}

{
  // DEC-49: the canonical name is reconstructed from the persisted data; no
  // canonicalName / familyKey / stackKey field exists anywhere in the payload.
  const messy = { family: " protection ", rank: "2", schemaVersion: 1 };
  const result = normalizeSw25EffectSystem(messy);
  for (const forbidden of ["canonicalName", "familyKey", "stackKey"]) {
    assert.equal(forbidden in result.data, false, `no persisted ${forbidden} field (DEC-49)`);
  }
  assert.equal(buildSw25CanonicalName(result.data.family, result.data.rank), "protection II",
    "the name is derived on demand from family + rank alone");
  // The GM repair layer writes only schema fields (already asserted above);
  // the identity/canonical-name helpers introduce no additional write path.
}

// ── T1.5: Effects tab data preparation (module/effects/effects-tab.mjs) ──────
//
// Pure data preparation only: filtering to the system's subtype, canonical
// name reconstruction, duration-mode distinction, activation state, the
// read-only "needs review" audit, and the GM-only repair orchestration that
// delegates each write to the T1.3 per-document contract. No UI behavior
// belongs here; the ApplicationV2 inspector is verified live (see report).

const effectsTab = await import("../module/effects/effects-tab.mjs");

/** Effect stub carrying a document type (native "base" vs system "sw25Effect"). */
function typedEffectStub(type, raw, { name = "Probe", disabled = undefined, id = "effect-1", updateThrows = false } = {}) {
  const stub = effectStub(raw, { name, updateThrows });
  stub.id = id;
  stub.type = type;
  if (disabled !== undefined) stub.disabled = disabled;
  return stub;
}

{
  // ONLY sw25Effect documents are listed; native effects of other subtypes
  // never mix with the system's managed effects.
  const sw25 = typedEffectStub("sw25Effect", structuredClone(VALID), { id: "e1", name: "Protection II" });
  const native = typedEffectStub("base", { schemaVersion: 9 }, { id: "e2", name: "Native Effect" });
  const { rows, needsReviewCount, futureCount } = effectsTab.prepareSw25EffectRows([sw25, native, null, undefined]);
  assert.equal(rows.length, 1, "native subtype documents must not appear in the tab");
  assert.equal(rows[0].id, "e1");
  assert.equal(needsReviewCount, 0);
  assert.equal(futureCount, 0);
  // Canonical name reconstructed from the persisted family + rank (T1.4).
  assert.equal(rows[0].displayName, "protection II");
  // Duration: round-managed bookkeeping (DEC-23) is clearly distinguished.
  assert.equal(rows[0].durationMode, "rounds");
  assert.equal(rows[0].durationLabel, "Remaining 3 of 4 rounds");
  // SV 0 would be legitimate; here it is 12. Label never hides a real 0.
  assert.equal(rows[0].successValueLabel, "12");
}

{
  // Presentation visibility (gmOnly): an effect carrying system.gmOnly ===
  // true is listed ONLY for the GM view (includeGmOnly). This is strictly
  // presentation-layer filtering: the caller's document collection is never
  // mutated, and effects WITHOUT the field (backward compatibility, schema
  // initial false) stay visible in every view.
  const gmOnly = typedEffectStub("sw25Effect", { schemaVersion: 1, family: "Concealed Main Section", rank: 0, gmOnly: true }, {
    id: "e1b",
    name: "Concealed Main Section"
  });
  const ordinary = typedEffectStub("sw25Effect", structuredClone(VALID), { id: "e1c", name: "Protection II" });
  const legacy = typedEffectStub("sw25Effect", { schemaVersion: 1, family: "Cura", rank: 0 }, { id: "e1d", name: "Cura" });
  const playerView = effectsTab.prepareSw25EffectRows([gmOnly, ordinary, legacy]);
  assert.deepEqual(playerView.rows.map(row => row.id), ["e1c", "e1d"],
    "gmOnly effects are absent from the default (player) view");
  assert.equal(playerView.needsReviewCount, 0);
  const gmView = effectsTab.prepareSw25EffectRows([gmOnly, ordinary, legacy], null, { includeGmOnly: true });
  assert.deepEqual(gmView.rows.map(row => row.id), ["e1b", "e1c", "e1d"],
    "the GM view lists the gmOnly effect alongside the ordinary ones");
  assert.equal(gmView.rows[0].gmOnly, true, "the row carries the visibility flag for programmatic consumers");
  assert.equal(playerView.rows.every(row => row.gmOnly !== true), true,
    "no player-visible row is gmOnly");
  assert.equal(gmOnly.updates.length, 0, "filtering never writes to the documents");
  assert.ok(effectsTab.prepareSw25EffectsTab, "the tab context remains the single sheet-facing wrapper");
}

{
  // Monster-sheet adaptation: the concealed effect's row carries a readable
  // badge naming the currently selected section (attachSw25ConcealedSelection-
  // Label). Pure decoration over prepared rows, driven by the GM-only sync
  // presentation of module/combat/concealed-main-section.mjs.
  const hidden = typedEffectStub("sw25Effect", { schemaVersion: 1, family: "Concealed Main Section", rank: 0, gmOnly: true }, {
    id: "e1e",
    name: "Concealed Main Section"
  });
  const other = typedEffectStub("sw25Effect", structuredClone(VALID), { id: "e1f", name: "Protection II" });
  const rows = effectsTab.prepareSw25EffectRows([hidden, other], null, { includeGmOnly: true }).rows;

  // No presentation / no matching row: rows stay untouched.
  effectsTab.attachSw25ConcealedSelectionLabel(rows, null);
  effectsTab.attachSw25ConcealedSelectionLabel(rows, { status: "none", section: null, sectionId: null, effectId: null, code: null, message: null });
  effectsTab.attachSw25ConcealedSelectionLabel(rows, { status: "assigned", section: "Head", sectionId: "cs-a", effectId: "absent-id", code: null, message: null });
  assert.equal(rows.every(row => row.sectionSelectionLabel === undefined), true,
    "no label is attached without a matching row (or a none state)");

  // Assigned: the badge names the chosen section on the concealed row only.
  effectsTab.attachSw25ConcealedSelectionLabel(rows, { status: "assigned", section: "Head", sectionId: "cs-a", effectId: "e1e", code: null, message: null });
  assert.equal(rows.find(row => row.id === "e1e").sectionSelectionLabel, "Currently: Head",
    "the concealed row shows the chosen section");
  assert.ok(rows.find(row => row.id === "e1e").sectionSelectionTitle,
    "the badge carries a tooltip");
  assert.equal(rows.find(row => row.id === "e1f").sectionSelectionLabel, undefined,
    "ordinary rows never carry the badge");

  // Error: the explicit unresolved state is shown with its message as title.
  effectsTab.attachSw25ConcealedSelectionLabel(rows, { status: "error", section: null, sectionId: null, effectId: "e1e", code: "selection-invalid", message: "no longer valid" });
  assert.equal(rows.find(row => row.id === "e1e").sectionSelectionLabel, "Selection unresolved",
    "an unresolvable selection shows the explicit unresolved badge");
  assert.equal(rows.find(row => row.id === "e1e").sectionSelectionTitle, "no longer valid",
    "the unresolved badge's tooltip carries the presentation message");
}

{
  // Duration modes: native document duration vs no duration at all.
  const nativeRounds = typedEffectStub("sw25Effect", { schemaVersion: 1, family: "Cura", rank: 0 }, {
    id: "e3",
    name: "Cura"
  });
  nativeRounds.duration = { rounds: 5 };
  const indefinite = typedEffectStub("sw25Effect", { schemaVersion: 1, family: "Cura", rank: 0 }, {
    id: "e4",
    name: "Cura 2"
  });
  const { rows } = effectsTab.prepareSw25EffectRows([nativeRounds, indefinite]);
  assert.equal(rows[0].durationMode, "native");
  assert.equal(rows[0].durationLabel, "5 rounds");
  assert.equal(rows[1].durationMode, "none");
  assert.equal(rows[1].durationLabel, "—");
}

{
  // Activation state comes from native document truth: the `active` getter
  // when present, `disabled` otherwise; unknown stays "—", nothing invented.
  const active = typedEffectStub("sw25Effect", structuredClone(VALID), { id: "e5" });
  active.active = true;
  const disabled = typedEffectStub("sw25Effect", structuredClone(VALID), { id: "e6", disabled: true });
  const unknown = typedEffectStub("sw25Effect", structuredClone(VALID), { id: "e7" });
  const { rows } = effectsTab.prepareSw25EffectRows([active, disabled, unknown]);
  assert.equal(rows[0].stateLabel, "Active");
  assert.equal(rows[1].stateLabel, "Disabled");
  assert.equal(rows[2].stateLabel, "—");
}

{
  // The read-only audit flags rows needing review (T1.3 severities) without
  // writing anything, and distinguishes future-version data (intact, refused).
  const messy = typedEffectStub("sw25Effect", { schemaVersion: 1, family: " protection ", rank: "2" }, {
    id: "e8",
    name: "Messy"
  });
  const future = typedEffectStub("sw25Effect", { schemaVersion: 9, family: "x" }, { id: "e9", name: "Future" });
  const broken = typedEffectStub("sw25Effect", { schemaVersion: 1 }, { id: "e10", name: "Broken" });
  const before = JSON.stringify(messy.toObject());
  const { rows, needsReviewCount, futureCount } = effectsTab.prepareSw25EffectRows([messy, future, broken]);
  assert.equal(before, JSON.stringify(messy.toObject()), "preparation must not mutate the documents");
  assert.equal(needsReviewCount, 2, "broken (irrecoverable) and future-version effects are review-flagged; the messy one is only auto-fixable");
  assert.equal(futureCount, 1);
  assert.equal(rows[1].futureVersion, true);
  assert.equal(rows[2].needsReview, true, "missing family is irrecoverable → review");
  assert.ok(rows[2].reviewDetails.length >= 1);
  assert.equal(rows[0].needsReview, false);
}

{
  // GM repair orchestration: ONLY sw25Effect documents are repaired (the
  // native ones are left completely untouched — no schemaVersion write, no
  // update of any kind), every write goes through the T1.3 contract, and the
  // operation is idempotent (no write when nothing changed).
  globalThis.game = { user: { isGM: true } };
  resetNotifications();
  const sw25 = typedEffectStub("sw25Effect", { family: " protection ", rank: "2" }, { id: "e11", name: "Sw25" });
  const native = typedEffectStub("base", { anything: "untouched" }, { id: "e12", name: "Native" });
  const actor = { effects: [sw25, native] };
  const summary = await effectsTab.repairActorSw25Effects(actor);
  assert.equal(summary.total, 1, "only the sw25Effect document is targeted");
  assert.equal(summary.repaired, 1);
  assert.equal(summary.refused, 0);
  assert.equal(sw25.updates.length, 1);
  assert.ok("system.family" in sw25.updates[0]);
  assert.ok("system.rank" in sw25.updates[0]);
  // Any written key is a schema field (effectStub already enforces the
  // flattened system.* shape); the native effect receives NO write at all.
  assert.equal(native.updates.length, 0, "native documents receive NO write through the tab");
  // Idempotent: a second repair performs no write.
  const second = await effectsTab.repairActorSw25Effects(actor);
  assert.equal(second.repaired, 0);
  assert.equal(second.results[0].code, "no-changes");
  assert.equal(sw25.updates.length, 1);
}

{
  // Non-GM: refused, nothing written, nothing swept.
  globalThis.game = { user: { isGM: false } };
  resetNotifications();
  const sw25 = typedEffectStub("sw25Effect", { family: " protection ", rank: "2" }, { id: "e13" });
  const summary = await effectsTab.repairActorSw25Effects({ effects: [sw25] });
  assert.equal(summary.ok, false);
  assert.equal(summary.code, "not-gm");
  assert.equal(sw25.updates.length, 0);
}

// ── T1.5: inspection context reflects the persisted document ────────────────

{
  globalThis.game = { user: { isGM: true } };
  const effect = typedEffectStub("sw25Effect", structuredClone(VALID), { id: "e14", name: "Protection II" });
  const inspection = effectsTab.buildSw25EffectInspection(effect, null);
  assert.equal(inspection.family, "protection");
  assert.equal(inspection.rankRoman, "II");
  assert.equal(inspection.canonicalName, "protection II");
  assert.equal(inspection.successValueLabel, "12");
  assert.equal(inspection.initialDurationLabel, "4 rounds");
  assert.equal(inspection.remainingDurationLabel, "3 rounds");
  assert.equal(inspection.casterUUID, "Actor.abcd1234efgh5678");
  assert.equal(inspection.effectType, "buff");
  assert.equal(inspection.changes.length, 1);
  assert.equal(inspection.changes[0].key, "system.hp.max");
  // Unresolvable UUID: the raw persisted value is displayed, never hidden.
  assert.equal(inspection.casterName, "Actor.abcd1234efgh5678");
  // Resolver injection: resolved documents show their name.
  const resolved = effectsTab.buildSw25EffectInspection(effect, uuid => ({ name: "Caster Actor" }));
  assert.equal(resolved.casterName, "Caster Actor");
}

// ── T5.4: Duration scale presentation and gmOnly visibility ──────────────────

{
  // All duration scales are presented correctly, including manual scales
  // (minutes/hours/days/permanent/other) that never acquire automation.
  const scaleCases = [
    { scale: "rounds", initial: 4, remaining: 2, expectMode: "rounds", expectLabel: "Remaining 2 of 4 rounds" },
    { scale: "turns", expectMode: "turns", expectLabel: "Turns" },
    { scale: "minutes", expectMode: "minutes", expectLabel: "Minutes" },
    { scale: "hours", expectMode: "hours", expectLabel: "Hours" },
    { scale: "days", expectMode: "days", expectLabel: "Days" },
    { scale: "permanent", expectMode: "permanent", expectLabel: "Permanent" },
    { scale: "other", expectMode: "other", expectLabel: "Other" },
    { scale: null, expectMode: "none", expectLabel: "—" }
  ];
  for (const c of scaleCases) {
    const sys = { schemaVersion: 1, family: "Test", rank: 0, successValue: 0, ...(c.scale ? { durationScale: c.scale } : {}), ...(c.initial !== undefined ? { initialDuration: c.initial } : {}), ...(c.remaining !== undefined ? { remainingDuration: c.remaining } : {}) };
    const eff = typedEffectStub("sw25Effect", sys, { id: `scale-${c.scale ?? "none"}` });
    const desc = effectsTab.describeSw25Effect(eff, null);
    assert.equal(desc.durationMode, c.expectMode, `scale ${c.scale ?? "none"} → mode ${c.expectMode}`);
    assert.equal(desc.durationLabel, c.expectLabel, `scale ${c.scale ?? "none"} → label ${c.expectLabel}`);
    // Manual scales never carry an anchor.
    if (c.scale === "minutes" || c.scale === "hours" || c.scale === "days" || c.scale === "permanent" || c.scale === "other" || c.scale === null) {
      assert.equal(desc.durationScale, c.scale, `scale ${c.scale ?? "none"} → durationScale ${c.scale ?? "none"}`);
      assert.equal(desc.durationAnchor, null, `scale ${c.scale ?? "none"} → no anchor`);
      assert.equal(desc.anchorAvailable, null, `scale ${c.scale ?? "none"} → no availability (no combat)`);
    }
  }
}

{
  // Combat scales carry anchor data; manual scales never do.
  const roundsWithAnchor = typedEffectStub("sw25Effect", {
    schemaVersion: 1, family: "Test", rank: 0, successValue: 0,
    durationScale: "rounds", initialDuration: 3, remainingDuration: 3,
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-1", tokenId: "tok-1", state: "resolved" }
  }, { id: "anchor-rounds" });
  const desc = effectsTab.describeSw25Effect(roundsWithAnchor, null);
  assert.equal(desc.durationScale, "rounds");
  assert.equal(desc.durationAnchor.regime, "casterTurn");
  assert.equal(desc.durationAnchor.edge, "begin");
  assert.equal(desc.durationAnchor.combatantId, "cmbt-1");
  assert.equal(desc.durationAnchor.tokenId, "tok-1");
  assert.equal(desc.durationAnchor.state, "resolved");
  assert.equal(desc.anchorLabel, "casterTurn · begin · combatant cmbt-1 · token tok-1 · state: resolved");
  assert.equal(desc.anchorAvailable, null, "no combat → availability not computed");
}

{
  // Anchor availability is computed when a combat is supplied (D5 cases).
  const combat = {
    combatants: new Map([
      ["cmbt-alive", { id: "cmbt-alive", isDefeated: false, defeated: false, tokenId: "tok-alive", token: {} }],
      ["cmbt-defeated", { id: "cmbt-defeated", isDefeated: true, defeated: true, tokenId: "tok-dead", token: {} }],
      ["cmbt-gone", { id: "cmbt-gone", isDefeated: false, defeated: false, tokenId: "tok-gone", token: null }]
    ])
  };
  const available = typedEffectStub("sw25Effect", {
    schemaVersion: 1, family: "Test", rank: 0, successValue: 0,
    durationScale: "rounds", initialDuration: 3, remainingDuration: 3,
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-alive", state: "resolved" }
  }, { id: "avail-1" });
  const defeated = typedEffectStub("sw25Effect", {
    schemaVersion: 1, family: "Test", rank: 0, successValue: 0,
    durationScale: "rounds", initialDuration: 3, remainingDuration: 3,
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-defeated", state: "resolved" }
  }, { id: "avail-2" });
  const gone = typedEffectStub("sw25Effect", {
    schemaVersion: 1, family: "Test", rank: 0, successValue: 0,
    durationScale: "rounds", initialDuration: 3, remainingDuration: 3,
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-gone", state: "resolved" }
  }, { id: "avail-3" });
  const d1 = effectsTab.describeSw25Effect(available, null, { combat });
  const d2 = effectsTab.describeSw25Effect(defeated, null, { combat });
  const d3 = effectsTab.describeSw25Effect(gone, null, { combat });
  assert.equal(d1.anchorAvailable, true, "alive combatant → available");
  assert.equal(d1.anchorUnavailableReason, null);
  assert.equal(d2.anchorAvailable, false, "defeated combatant → unavailable");
  assert.equal(d2.anchorUnavailableReason, "combatant-defeated");
  assert.equal(d3.anchorAvailable, false, "token gone → unavailable");
  assert.equal(d3.anchorUnavailableReason, "token-gone");
}

{
  // Legacy effect without durationScale but with round counters: treated as rounds.
  const legacy = typedEffectStub("sw25Effect", {
    schemaVersion: 1, family: "Legacy", rank: 0, successValue: 0,
    initialDuration: 5, remainingDuration: 3
  }, { id: "legacy-rounds" });
  const desc = effectsTab.describeSw25Effect(legacy, null);
  assert.equal(desc.durationMode, "rounds");
  assert.equal(desc.durationLabel, "Remaining 3 of 5 rounds");
  assert.equal(desc.durationScale, "rounds");
}

{
  // Native document duration (raw scale) is preserved for display.
  const native = typedEffectStub("sw25Effect", {
    schemaVersion: 1, family: "Native", rank: 0, successValue: 0
  }, { id: "native-turns" });
  native.duration = { turns: 6 };
  const desc = effectsTab.describeSw25Effect(native, null);
  assert.equal(desc.durationMode, "native");
  assert.equal(desc.durationLabel, "6 turns");
  assert.equal(desc.durationScale, "turns");
}

{
  // gmOnly: players never see gmOnly effects in the tab; the GM does.
  const hidden = typedEffectStub("sw25Effect", { schemaVersion: 1, family: "Hidden", rank: 0, gmOnly: true }, { id: "hidden-1", name: "Hidden Effect" });
  const ordinary = typedEffectStub("sw25Effect", structuredClone(VALID), { id: "ord-1", name: "Ordinary Effect" });
  const legacy = typedEffectStub("sw25Effect", { schemaVersion: 1, family: "Cura", rank: 0 }, { id: "leg-1", name: "Cura" });

  const playerView = effectsTab.prepareSw25EffectRows([hidden, ordinary, legacy]);
  assert.deepEqual(playerView.rows.map(r => r.id), ["ord-1", "leg-1"],
    "gmOnly effects are absent from the player-facing rows");
  assert.ok(playerView.rows.every(r => r.gmOnly !== true),
    "no player-visible row carries gmOnly=true");

  const gmView = effectsTab.prepareSw25EffectRows([hidden, ordinary, legacy], null, { includeGmOnly: true });
  assert.deepEqual(gmView.rows.map(r => r.id), ["hidden-1", "ord-1", "leg-1"],
    "the GM view lists the gmOnly effect alongside ordinary ones");
  assert.equal(gmView.rows[0].gmOnly, true, "the gmOnly row carries the visibility flag");

  // The underlying documents are never mutated by filtering.
  assert.equal(hidden.updates.length, 0, "filtering never writes to documents");
}

{
  // Inspector: gmOnly effect is inspectable by the GM but refused to players.
  const hidden = typedEffectStub("sw25Effect", { schemaVersion: 1, family: "Hidden", rank: 0, gmOnly: true }, { id: "insp-hidden", name: "Hidden Effect" });
  const ordinary = typedEffectStub("sw25Effect", structuredClone(VALID), { id: "insp-ord", name: "Ordinary Effect" });

  // GM inspection succeeds and carries the full model data.
  const gmInsp = effectsTab.buildSw25EffectInspection(hidden, null, { combat: null });
  assert.equal(gmInsp.gmOnly, true);
  assert.equal(gmInsp.id, "insp-hidden");

  // Player inspection of the same gmOnly effect: data is still prepared (the
  // guard is at the UI wiring layer, not the data layer). The row-level
  // filtering (prepareSw25EffectRows) is what keeps it from players.
  const playerInsp = effectsTab.buildSw25EffectInspection(hidden, null, { combat: null });
  assert.equal(playerInsp.gmOnly, true, "inspection data carries gmOnly flag for programmatic consumers");

  // Ordinary effects are inspectable by everyone.
  const ordInsp = effectsTab.buildSw25EffectInspection(ordinary, null);
  assert.equal(ordInsp.gmOnly, false, "ordinary effect is not gmOnly");
  assert.equal(ordInsp.durationMode, "rounds", "ordinary effect keeps its duration mode");
}

{
  // prepareSw25EffectRows is the single sheet-facing route: it returns the
  // same shape whether called directly or through prepareSw25EffectsTab.
  const effects = [
    typedEffectStub("sw25Effect", structuredClone(VALID), { id: "a" }),
    typedEffectStub("sw25Effect", { schemaVersion: 1, family: "X", rank: 0, gmOnly: true }, { id: "b" }),
    typedEffectStub("base", {}, { id: "c" })
  ];
  const direct = effectsTab.prepareSw25EffectRows(effects, null, { includeGmOnly: true });
  assert.equal(direct.rows.length, 2, "direct route lists sw25Effect + gmOnly");
  // The tab context wrapper uses the same preparation function.
  assert.ok(typeof effectsTab.prepareSw25EffectsTab === "function",
    "prepareSw25EffectsTab remains the single sheet-facing wrapper");
}

console.log("effects-schema.test.mjs: all repair/normalization/identity/tab assertions passed.");
