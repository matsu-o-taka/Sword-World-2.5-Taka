// Sword World 2.5 - effect type data model schema test suite.
//
// Exercises the schema definition of module/effects/effect-model.mjs in a
// headless process, without registering the subtype in Foundry (registration
// belongs to the follow-up integration task). The global mock reproduces the
// pieces of the v14 Foundry contract this model relies on, mirroring the real
// `ActiveEffectTypeDataModel.defineSchema()` and field option semantics
// verified against the installed client and the official v14 docs.
//
// Scope: schema structure, inheritance of the native `changes` structure,
// field options, and field-option semantics (initial / nullable / integer /
// min / blank) as documented for Foundry v14 fields. No repair, migration,
// stacking, expiry or GM authority behavior belongs to this suite.

import assert from "node:assert/strict";

// ── Minimal field mocks (record options; expose documented semantics) ───────

class MockField {
  constructor(options = {}) {
    this.options = options;
  }
}

class NumberField extends MockField {}
class StringField extends MockField {}
class BooleanField extends MockField {}
class DocumentUUIDField extends MockField {}
class AnyField extends MockField {}

class SchemaField extends MockField {
  constructor(fields, options = {}) {
    super(options);
    this.fields = fields;
  }
}

class ArrayField extends MockField {
  constructor(element, options = {}) {
    super(options);
    this.element = element;
  }
}

class ObjectField extends MockField {}

// Mirrors the real ActiveEffectTypeDataModel.defineSchema (verified in the
// installed v14 client source: common/data/active-effect.mjs).
class MockActiveEffectTypeDataModel {
  static defineSchema() {
    const fields = globalThis.foundry.data.fields;
    return {
      changes: new ArrayField(new SchemaField({
        key: new StringField({ required: true }),
        type: new StringField({
          required: true, blank: false, initial: "add",
          validate: MockActiveEffectTypeDataModel.#validateType
        }),
        value: new AnyField({ required: true, nullable: true, serializable: true, initial: "" }),
        phase: new StringField({ required: true, blank: false, initial: "initial" }),
        priority: new NumberField()
      }))
    };
  }

  /** Mirrors the real #validateType contract for change type strings. */
  static #validateType(type) {
    if (type.length < 3) throw new Error("must be at least three characters long");
    if (!/^custom\.-?\d+$/.test(type) && !type.split(".").every(s => /^[a-z0-9]+$/i.test(s))) {
      throw new Error("A change type must be dot-delimited alpha-numeric substrings or \"custom.{number}\"");
    }
    return true;
  }
}

globalThis.foundry = {
  data: {
    fields: { NumberField, StringField, BooleanField, DocumentUUIDField, AnyField, SchemaField, ArrayField, ObjectField },
    ActiveEffectTypeDataModel: MockActiveEffectTypeDataModel
  }
};

// ── Import under test (after the global mock is in place) ───────────────────

const {
  SW25EffectModel,
  SW25_EFFECT_SCHEMA_VERSION,
  SW25_DURATION_SCALES,
  SW25_COMBAT_DURATION_SCALES,
  SW25_ANCHOR_REGIMES,
  SW25_ANCHOR_EDGES,
  SW25_ANCHOR_STATES
} = await import("../module/effects/effect-model.mjs");

{
  // Approved T5.2 vocabularies (T5.0-R consolidation): combat scales are a
  // subset of the approved scales; the anchor vocabularies are disjoint.
  assert.deepEqual(SW25_COMBAT_DURATION_SCALES.filter(id => !SW25_DURATION_SCALES.includes(id)), []);
  for (const id of ["rounds", "turns"]) assert.ok(SW25_COMBAT_DURATION_SCALES.includes(id));
  for (const id of ["minutes", "hours", "days", "permanent", "other"]) {
    assert.ok(!SW25_COMBAT_DURATION_SCALES.includes(id), `${id} is manual and needs no anchor`);
  }
  assert.deepEqual(SW25_ANCHOR_REGIMES, ["casterTurn", "targetTurn", "roundEnd"]);
  assert.deepEqual(SW25_ANCHOR_EDGES, ["begin", "end"]);
  assert.deepEqual(SW25_ANCHOR_STATES, ["resolved", "deferred"]);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Apply the documented v14 field-option semantics for the option subset used
 * by this schema: initial, nullable, required, integer, min, blank. Returns
 * { ok, value } or { ok: false, error }.
 */
function cleanField(field, value) {
  if (value === undefined) value = field.options.initial;
  if (value === undefined) {
    // Missing value with no initial: required fields fail, optional fields stay undefined.
    return field.options.required ? { ok: false, error: "required" } : { ok: true, value: undefined };
  }
  if (value === null) {
    return field.options.nullable
      ? { ok: true, value: null }
      : { ok: false, error: "not nullable" };
  }
  if (field instanceof NumberField) {
    if (field.options.integer && !Number.isInteger(value)) return { ok: false, error: "not an integer" };
    if (field.options.min !== undefined && value < field.options.min) return { ok: false, error: "below min" };
  }
  if (field instanceof StringField && field.options.blank === false && value === "") {
    return { ok: false, error: "blank" };
  }
  return { ok: true, value };
}

// ── Tests ────────────────────────────────────────────────────────────────────

{
  // The model extends the ActiveEffect-specific TypeDataModel (T1.0 / v14 docs),
  // not the generic TypeDataModel and not the document class.
  assert.equal(Object.getPrototypeOf(SW25EffectModel), MockActiveEffectTypeDataModel,
    "SW25EffectModel must extend foundry.data.ActiveEffectTypeDataModel");
}

{
  // DEC-41: the first real schema version is 1.
  assert.equal(SW25_EFFECT_SCHEMA_VERSION, 1);
  assert.equal(SW25EffectModel.defineSchema().schemaVersion.options.initial, 1);
}

{
  const schema = SW25EffectModel.defineSchema();

  // Expected field set: identity, SV, durations, provenance, classification.
  for (const key of ["changes", "schemaVersion", "family", "rank", "successValue",
    "initialDuration", "remainingDuration", "casterUUID", "effectType",
    "isMagical", "resistance"]) {
    assert.ok(key in schema, `schema must define ${key}`);
  }

  // Deliberately absent fields (DEC-49 and related decisions).
  const absent = [
    "stackKey", "canonicalName",           // DEC-49: single identity, no duplicate name
    "stackable", "replaceOnRecast", "survivesCombatEnd", // DEC-49: no generic booleans
    "casterIsMinorPrep",                   // DEC-49: reflected in successValue instead
    "instantX",                            // DEC-49/DEC-40: only the persistent queue
    "sourceUUID",                          // carried by the native document `origin` field
    "casterTurn", "targetTurn", "anchor"   // T5.2: these names were replaced by
                                           // `durationScale` + `durationAnchor`
                                           // (T5.0-R consolidation, D3/D5)
  ];
  for (const key of absent) {
    assert.ok(!(key in schema), `schema must NOT define ${key}`);
  }
}

{
  // Native changes structure inherited and preserved untouched (key / type /
  // value / phase / priority, with the native initial values and validator).
  const schema = SW25EffectModel.defineSchema();
  assert.ok(schema.changes instanceof ArrayField, "changes must stay an ArrayField");
  const changeFields = schema.changes.element.fields;
  assert.equal(changeFields.key.options.required, true);
  assert.equal(changeFields.type.options.initial, "add");
  assert.equal(typeof changeFields.type.options.validate, "function");
  assert.equal(changeFields.value.options.nullable, true);
  assert.equal(changeFields.phase.options.initial, "initial");
  assert.ok("priority" in changeFields);
  // The native validator contract is preserved.
  assert.equal(changeFields.type.options.validate("add"), true);
  assert.equal(changeFields.type.options.validate("custom.3"), true);
  assert.throws(() => changeFields.type.options.validate("ab"), { message: /three characters/ });
  assert.throws(() => changeFields.type.options.validate("Bad Key!"), { message: /dot-delimited/ });
}

{
  // Schema versioning field options (DEC-41).
  const schema = SW25EffectModel.defineSchema();
  const f = schema.schemaVersion;
  assert.ok(f instanceof NumberField);
  assert.deepEqual(f.options, { required: true, nullable: false, integer: true, initial: 1 });
  assert.equal(cleanField(f, undefined).value, 1);
  assert.equal(cleanField(f, 3).value, 3);
  assert.equal(cleanField(f, 1.5).ok, false, "schemaVersion must reject non-integers");
}

{
  // Stacking identity fields (DEC-1/DEC-16/DEC-49).
  const schema = SW25EffectModel.defineSchema();
  const family = schema.family;
  assert.ok(family instanceof StringField);
  assert.equal(family.options.required, true, "family is mandatory for sw25 effects");
  assert.equal(family.options.nullable, false);
  assert.equal(family.options.blank, false);
  assert.equal(cleanField(family, "protection").value, "protection");
  assert.equal(cleanField(family, "").ok, false, "family must reject blank");
  assert.equal(cleanField(family, undefined).ok, false, "family has no initial: it must be provided");

  const rank = schema.rank;
  assert.deepEqual(rank.options, { required: true, nullable: false, integer: true, min: 0, initial: 0 });
  assert.equal(cleanField(rank, undefined).value, 0, "rank defaults to 0 (no numeral)");
  assert.equal(cleanField(rank, 2).value, 2);
  assert.equal(cleanField(rank, -1).ok, false, "rank must reject negatives");
  assert.equal(cleanField(rank, 1.5).ok, false, "rank must reject non-integers");
}

{
  // Success Value (DEC-6): persists for the effect's whole life; 0 is valid.
  const schema = SW25EffectModel.defineSchema();
  const sv = schema.successValue;
  assert.deepEqual(sv.options, { required: true, nullable: false, integer: true, initial: 0 });
  assert.equal(cleanField(sv, undefined).value, 0);
  assert.equal(cleanField(sv, 12).value, 12);
  assert.equal(cleanField(sv, 17).value, 17, "SV 12+5+MP fits an integer");
  assert.equal(cleanField(sv, 2.5).ok, false, "SV must reject non-integers");
  assert.equal(cleanField(sv, null).ok, false, "SV must not be nullable");
}

{
  // Duration bookkeeping (DEC-23 + the 2026-11-22 combat-end minutes
  // conversion): nullable finite numbers ≥ 0 expressed in the unit of the
  // effect's durationScale — integral combat rounds for the counted scales,
  // fractional MINUTES after the purge conversion (17 rounds → 2.8333…).
  // Integrality of counted scales remains a service-level rule. Null means
  // the effect is not counted (manual scales under GM management).
  const schema = SW25EffectModel.defineSchema();
  for (const key of ["initialDuration", "remainingDuration"]) {
    const f = schema[key];
    assert.ok(f instanceof NumberField, `${key} must be a NumberField`);
    assert.equal(f.options.nullable, true, `${key} must be nullable`);
    assert.equal(f.options.integer, undefined, `${key} accepts finite non-integers (converted minutes)`);
    assert.equal(f.options.min, 0, `${key} must reject negatives`);
    assert.equal(f.options.initial, null, `${key} defaults to null (not counted)`);
    assert.equal(cleanField(f, undefined).value, null);
    assert.equal(cleanField(f, null).value, null, "null is legitimate for manual scales");
    assert.equal(cleanField(f, 4).value, 4, "rounds value accepted");
    assert.equal(cleanField(f, 17 / 6).value, 17 / 6, "converted fractional minutes accepted (never rounded)");
    assert.equal(cleanField(f, -2).ok, false, "durations must reject negatives");
  }
}

{
  // Provenance and classification fields (DEC-49, DEC-9/DEC-10).
  const schema = SW25EffectModel.defineSchema();
  const caster = schema.casterUUID;
  assert.ok(caster instanceof DocumentUUIDField);
  assert.equal(caster.options.nullable, true, "casterUUID is optional (GM-created effects)");
  assert.equal(caster.options.initial, null);

  const effectType = schema.effectType;
  assert.ok(effectType instanceof StringField);
  assert.equal(effectType.options.required, false, "effectType is optional (DEC-9/10)");
  assert.equal(effectType.options.nullable, true);
  assert.equal(effectType.options.blank, false, "an effectType, when present, must be non-blank");
  assert.equal(cleanField(effectType, undefined).value, null);
  assert.equal(cleanField(effectType, "").ok, false);
  assert.equal(cleanField(effectType, "buff").value, "buff");
}

{
  // Cancellation eligibility fields (DEC-7/§55): the magical flag and the
  // emitting effect's Resistance notation. `isMagical` is strictly boolean:
  // false covers non-magical and unconfirmed effects, including legacy data.
  const schema = SW25EffectModel.defineSchema();
  const isMagical = schema.isMagical;
  assert.ok(isMagical instanceof BooleanField);
  assert.equal(isMagical.options.required, true, "isMagical is always present after schema initialization");
  assert.equal(isMagical.options.nullable, false, "null is never valid");
  assert.equal(isMagical.options.initial, false);
  assert.equal(cleanField(isMagical, undefined).value, false);
  assert.equal(cleanField(isMagical, null).ok, false);
  assert.equal(cleanField(isMagical, true).value, true);
  assert.equal(cleanField(isMagical, false).value, false);

  const resistance = schema.resistance;
  assert.ok(resistance instanceof StringField);
  assert.equal(resistance.options.required, false);
  assert.equal(resistance.options.nullable, true);
  assert.equal(resistance.options.blank, false, "a stored resistance notation must be non-blank");
  assert.equal(cleanField(resistance, undefined).value, null);
  assert.equal(cleanField(resistance, "").ok, false);
  assert.equal(cleanField(resistance, "cant").value, "cant");
}

{
  // Bloque 6 additive fields (T6.1, DEC-7/DEC-8): Success Value provenance
  // and casting identity/scope. All are optional and nullable: an absent
  // value means "not recorded" and is never invented.
  const schema = SW25EffectModel.defineSchema();
  for (const key of ["successValueSource", "castId", "effectScope"]) {
    const field = schema[key];
    assert.ok(field instanceof StringField, `${key} is a StringField`);
    assert.equal(field.options.required, false, `${key} is optional`);
    assert.equal(field.options.nullable, true, `${key} is nullable (not recorded)`);
    assert.equal(field.options.blank, false, `${key}, when present, must be non-blank`);
    assert.equal(field.options.initial, null);
    assert.equal(cleanField(field, undefined).value, null);
    assert.equal(cleanField(field, "").ok, false);
  }
  assert.equal(cleanField(schema.successValueSource, "automatic").value, "automatic");
  assert.equal(cleanField(schema.castId, "cast-abc123").value, "cast-abc123");
  assert.equal(cleanField(schema.effectScope, "space").value, "space");
}

{
  // The model defines no schema-side helpers for repair/migration/stacking:
  // those belong to later tasks (T1.3, T4.x, T5.x).
  const schema = SW25EffectModel.defineSchema();
  // 9 T1.x groups + familyPolicy + damageType (Bloque 4 additive fields,
  // DEC-3/T4.4 and DEC-9/DEC-20) + durationScale + durationAnchor (Bloque 5,
  // T5.2; schema stays v1, DEC-41) + gmOnly (presentation visibility,
  // additive optional field, schema stays v1) + isMagical + resistance
  // (DEC-7/§55, additive fields, v1) + successValueSource + castId +
  // effectScope (Bloque 6, T6.1 cancellation identity, additive optional
  // fields, schema stays v1) + rules (configured rule elements, additive
  // optional field, schema stays v1) + sourceDuration (authored source
  // duration identity, Phase 3 corrections, additive optional field, schema
  // stays v1).
  assert.equal(Object.keys(schema).length, 21, "v1 defines exactly the twenty-one approved field groups");
  assert.equal(typeof SW25EffectModel.migrateSource, "undefined");
}

{
  // Configured rule elements: `system.rules` is an optional array of plain
  // objects whose semantics belong to the rule-element registry. The schema
  // only guarantees "array of objects" (each rule family owns its parameters).
  const schema = SW25EffectModel.defineSchema();
  const rules = schema.rules;
  assert.ok(rules instanceof ArrayField, "rules is an ArrayField");
  assert.ok(rules.element instanceof ObjectField, "rules elements are plain objects");
  assert.equal(rules.options.required, false, "rules is optional (legacy effects have none)");
  assert.equal(rules.options.nullable, false, "rules is an array, never null");
}

{
  // Bloque 4 additive fields (T4.4): familyPolicy and damageType.
  const schema = SW25EffectModel.defineSchema();
  const familyPolicy = schema.familyPolicy;
  assert.ok(familyPolicy instanceof StringField);
  assert.equal(familyPolicy.options.required, false, "familyPolicy is optional (absent = spell, DEC-3)");
  assert.equal(familyPolicy.options.nullable, true);
  assert.equal(familyPolicy.options.blank, false, "a familyPolicy, when present, must be non-blank");
  assert.equal(cleanField(familyPolicy, undefined).value, null);
  assert.equal(cleanField(familyPolicy, "spell").value, "spell");

  const damageType = schema.damageType;
  assert.ok(damageType instanceof SchemaField, "damageType is the approved two-key schema field (DEC-9)");
  assert.equal(damageType.options.nullable, true, "damageType is optional");
  const nature = damageType.fields?.nature ?? damageType.element?.fields?.nature;
  const attribute = damageType.fields?.attribute ?? damageType.element?.fields?.attribute;
  assert.ok(nature instanceof StringField, "damageType.nature is a StringField");
  assert.ok(attribute instanceof StringField, "damageType.attribute is a StringField");
}

{
  // Bloque 5 additive fields (T5.2): durationScale and durationAnchor.
  const schema = SW25EffectModel.defineSchema();
  const scale = schema.durationScale;
  assert.ok(scale instanceof StringField);
  assert.equal(scale.options.required, false, "durationScale is optional (legacy effects have none)");
  assert.equal(scale.options.nullable, true);
  assert.equal(scale.options.blank, false, "a durationScale, when present, must be non-blank");
  assert.equal(scale.options.initial, null);
  assert.equal(cleanField(scale, undefined).value, null);
  assert.equal(cleanField(scale, null).value, null);
  assert.equal(cleanField(scale, "rounds").value, "rounds");
  assert.equal(cleanField(scale, "").ok, false);

  const anchor = schema.durationAnchor;
  assert.ok(anchor instanceof SchemaField, "durationAnchor is the approved five-key schema field (T5.0-R §3.3)");
  assert.equal(anchor.options.required, false, "durationAnchor is optional (manual scales never carry one)");
  assert.equal(anchor.options.nullable, true);
  assert.equal(anchor.options.initial, null);
  for (const key of ["regime", "edge", "combatantId", "tokenId", "state"]) {
    const sub = anchor.fields?.[key] ?? anchor.element?.fields?.[key];
    assert.ok(sub instanceof StringField, `durationAnchor.${key} is a StringField`);
    assert.equal(sub.options.required, false, `durationAnchor.${key} is optional`);
    assert.equal(sub.options.nullable, true, `durationAnchor.${key} is nullable`);
    assert.equal(sub.options.blank, false, `durationAnchor.${key}, when present, must be non-blank`);
    assert.equal(sub.options.initial, null);
  }
  // Native isolation (D1/D6/D11): the schema defines no native-duration
  // duplication — the document `duration` field stays native-only, and no
  // expiry machinery exists on the system model (T5.3's concern).
  for (const key of ["value", "expiry", "expiryAction"]) {
    assert.ok(!(key in schema), `the system schema must not redefine native duration machinery (${key})`);
  }
}

{
  // Presentation visibility (gmOnly): additive optional boolean with the
  // `false` initial — backward compatible with effects written before the
  // field existed, and never part of any stacking identity (DEC-1/16/44).
  const schema = SW25EffectModel.defineSchema();
  const gmOnly = schema.gmOnly;
  assert.ok(gmOnly instanceof BooleanField, "gmOnly is a BooleanField");
  assert.equal(gmOnly.options.required, false, "gmOnly is optional");
  assert.equal(gmOnly.options.nullable, false, "gmOnly is non-nullable (absent ≡ false)");
  assert.equal(gmOnly.options.initial, false, "gmOnly defaults to false (ordinary visibility)");
}

console.log("effects-effect-model.test.mjs: all schema assertions passed.");
