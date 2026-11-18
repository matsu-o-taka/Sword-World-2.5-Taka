// ---------------------------------------------------------------------------
// spell-data.test.mjs — Spell data model shared logic (rules/spell-data.mjs).
//
// Covers: class→school mapping, spell family/rank identity (shared with the
// Effects engine), duration reading, resistance/Fortitude parsing, target
// variants (individual labels + composite area notation), range parsing,
// magical propagation parsing, damage type derivation, casting markers, and
// the idempotent migration normalization (old schema → new schema).
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import {
  CLASS_SCHOOLS,
  SPELL_SCHOOL_ORDER,
  SPELL_TARGET_LABELS,
  SPELL_RESISTANCE_IDS,
  schoolForClassName,
  parseSpellNameIdentity,
  readSpellDurationText,
  getSpellDuration,
  normalizeResistanceValue,
  parseSpellResistanceEntry,
  getSpellResistance,
  parseSpellAreaTarget,
  parseSpellTarget,
  parseSpellRange,
  parseSpellPropagation,
  spellDamageNature,
  readSpellDamageAttributeFromMetadata,
  parseSw25SpellDamageAttribute,
  deriveSpellFields,
  normalizeSpellData
} from "../module/rules/spell-data.mjs";

let passed = 0;
const record = label => { passed++; console.log(`  PASS: ${label}`); };

// ── 1. Class → school mapping (centralized) ────────────────────────────────

assert.equal(CLASS_SCHOOLS.size, 10, "All 10 magical classes mapped");
assert.equal(schoolForClassName("Sorcerer"), "Truespeech Magic");
assert.equal(schoolForClassName("conjurer"), "Spiritualism Magic");
assert.equal(schoolForClassName("PRIEST"), "Divine Magic");
assert.equal(schoolForClassName("Artificer"), "Magitech");
assert.equal(schoolForClassName("Fairy Tamer"), "Fairy Magic");
assert.equal(schoolForClassName("Druid"), "Nature Magic");
assert.equal(schoolForClassName("Daemonologist"), "Daemonology");
assert.equal(schoolForClassName("Bard"), "Spellsongs");
assert.equal(schoolForClassName("Alchemist"), "Alchemy");
assert.equal(schoolForClassName("Geomancer"), "Geomancy");
assert.equal(schoolForClassName("Fighter"), null, "Non-magical classes have no school");
assert.equal(schoolForClassName(""), null);
assert.equal(schoolForClassName(null), null);
assert.ok(SPELL_SCHOOL_ORDER.includes("Truespeech Magic"));
assert.equal(new Set(SPELL_SCHOOL_ORDER).size, SPELL_SCHOOL_ORDER.length, "No duplicate schools in the canonical order");
record("centralized class→school mapping (10 classes, name-keyed, case-insensitive)");

// ── 2. Spell family/rank identity (shared with the Effects engine) ─────────

assert.deepEqual(parseSpellNameIdentity("Mana Max"), { family: "Mana Max", rank: 0 });
assert.deepEqual(parseSpellNameIdentity("Mana Max II"), { family: "Mana Max", rank: 2 });
assert.deepEqual(parseSpellNameIdentity("Summon Fairy IV"), { family: "Summon Fairy", rank: 4 });
assert.deepEqual(parseSpellNameIdentity("Summon Fairy X"), { family: "Summon Fairy", rank: 10 });
assert.deepEqual(parseSpellNameIdentity("保護Ⅳ"), { family: "保護", rank: 4 }, "Attached full-width numeral");
assert.deepEqual(parseSpellNameIdentity("Mana Max ii"), { family: "Mana Max ii", rank: 0 }, "Lowercase is never a numeral");
assert.deepEqual(parseSpellNameIdentity("‡Fear"), { family: "‡Fear", rank: 0 }, "Authoring markers stay in the family");
assert.deepEqual(parseSpellNameIdentity(""), { family: "", rank: 0 });
record("shared spell name identity (family + integer rank)");

// ── 3. Duration (Effects-engine representation) ────────────────────────────

assert.equal(readSpellDurationText("Duration: Instant"), "Instant");
assert.equal(readSpellDurationText("duration: 3 minutes (18 rounds)"), "3 minutes (18 rounds)");
assert.equal(readSpellDurationText("Target: Self\nDuration: Instant/3 rounds\nResistance: Half"), "Instant/3 rounds");
assert.equal(readSpellDurationText("Target: Self"), null);
assert.equal(getSpellDuration({ system: { duration: "Instant/2 rounds" } }), "Instant/2 rounds");
assert.equal(getSpellDuration({ system: { duration: null } }), null);
assert.equal(getSpellDuration({ system: {} }), null);
record("duration reads the stored structured field (Effects-engine text form)");

// ── 4. Resistance and Fortitude ────────────────────────────────────────────

assert.equal(normalizeResistanceValue("Half"), "half");
assert.equal(normalizeResistanceValue("Negates"), "neg");
assert.equal(normalizeResistanceValue("Neg"), "neg");
assert.equal(normalizeResistanceValue("Can't"), "cant");
assert.equal(normalizeResistanceValue("Can’t"), "cant");
assert.equal(normalizeResistanceValue("Optional"), "optional");
assert.equal(normalizeResistanceValue("None"), "none");
assert.equal(normalizeResistanceValue("Temporary"), "temporary");
assert.equal(normalizeResistanceValue("garbled"), null);

assert.deepEqual(parseSpellResistanceEntry("Half"), { usesFortitude: false, resistance: "half", warning: null });
assert.deepEqual(parseSpellResistanceEntry("Negates"), { usesFortitude: false, resistance: "neg", warning: null });
assert.deepEqual(parseSpellResistanceEntry(""), { usesFortitude: false, resistance: null, warning: null });
assert.deepEqual(
  parseSpellResistanceEntry("Fortitude/Half"),
  { usesFortitude: true, resistance: "half", warning: null },
  "Fortitude does NOT imply Negate: the type after the slash is independent"
);
assert.deepEqual(parseSpellResistanceEntry("Fortitude/Negates"), { usesFortitude: true, resistance: "neg", warning: null });
assert.equal(parseSpellResistanceEntry("Fortitude/garbled").usesFortitude, true, "Fortitude prefix recognized even with an unknown type");
assert.ok(parseSpellResistanceEntry("Fortitude/garbled").warning, "Unknown type after Fortitude/ is reported");
assert.equal(parseSpellResistanceEntry("Willpower/Half").resistance, null, "No Willpower/ prefix exists; unknown prefix is reported");
assert.ok(parseSpellResistanceEntry("Willpower/Half").warning);
assert.ok(parseSpellResistanceEntry("Mind-Controlled").warning, "Unrecognized value is reported, never invented");

assert.equal(getSpellResistance({ system: { resistance: "half" } }), "half");
assert.equal(getSpellResistance({ system: { resistance: "bogus" } }), null);
assert.equal(getSpellResistance({ system: {} }), null);
assert.equal(SPELL_RESISTANCE_IDS.size, 6);
record("resistance vocabulary + Fortitude/ prefix parsing");

// ── 5. Target: discrete labels ─────────────────────────────────────────────

assert.ok(SPELL_TARGET_LABELS.has("caster") && SPELL_TARGET_LABELS.has("character")
  && SPELL_TARGET_LABELS.has("entire-character") && SPELL_TARGET_LABELS.has("character-x")
  && SPELL_TARGET_LABELS.has("object") && SPELL_TARGET_LABELS.has("point")
  && SPELL_TARGET_LABELS.has("touch"), "All seven discrete labels exist");

assert.equal(parseSpellTarget("Caster"), "caster");
assert.equal(parseSpellTarget("Self"), "caster");
assert.equal(parseSpellTarget("1 character"), "character");
assert.equal(parseSpellTarget("Character"), "character");
assert.equal(parseSpellTarget("1 enemy"), "character");
assert.equal(parseSpellTarget("Entire Character"), "entire-character");
assert.equal(parseSpellTarget("1 entire character"), "entire-character");
assert.equal(parseSpellTarget("1 character X"), "character-x", "'1 character X' maps to its own discrete label");
assert.equal(parseSpellTarget("Object"), "object");
assert.equal(parseSpellTarget("1 object"), "object");
assert.equal(parseSpellTarget("Any 3 points"), "point");
assert.equal(parseSpellTarget("1 point"), "point");
assert.equal(parseSpellTarget("Any point"), "point", "Numeral-less 'Any point' is the same rules label");
assert.equal(parseSpellTarget("Touch"), "touch");
assert.equal(parseSpellTarget("Touched character"), "touch");
assert.equal(parseSpellTarget("1 bullet"), null, "'1 bullet' is not in the vocabulary: reported, not invented");
assert.equal(parseSpellTarget(""), null);
record("discrete individual target labels (never grouped)");

// ── 6. Target: composite area notation ─────────────────────────────────────

assert.deepEqual(parseSpellAreaTarget("1 area (3m radius)/5"), {
  type: "area", areaCount: 1, radius: 3, selection: "limited", maxTargets: 5
});
assert.deepEqual(parseSpellAreaTarget("1 area (6m radius) / All"), {
  type: "area", areaCount: 1, radius: 6, selection: "all", maxTargets: null
});
assert.deepEqual(parseSpellAreaTarget("1 area (5m Radius)/Space"), {
  type: "area", areaCount: 1, radius: 5, selection: "space", maxTargets: null
});
assert.deepEqual(parseSpellAreaTarget("1 area (3m radius)"), {
  type: "area", areaCount: 1, radius: 3, selection: null, maxTargets: null
}, "Bare area: no selection mode authored");
assert.equal(parseSpellAreaTarget("1 character"), null);
assert.equal(parseSpellAreaTarget("1 area (3m radius)/Everyone"), null, "Unrecognized suffix is reported, not guessed");
assert.deepEqual(parseSpellTarget("1 area (3m radius)/15"), parseSpellAreaTarget("1 area (3m radius)/15"), "Target routes area notation to the composite object");
record("composite area target notation (limited/space/all kept distinct)");

// ── 7. Range ───────────────────────────────────────────────────────────────

assert.deepEqual(parseSpellRange("2 (30m)"), { areas: 2, distance: 30 });
assert.deepEqual(parseSpellRange("1 (10 m)"), { areas: 1, distance: 10 });
assert.equal(parseSpellRange("Caster"), null, "Non-uniform range values are reported, not invented");
assert.equal(parseSpellRange(""), null);
record("structured range { areas, distance }");

// ── 8. Magical propagation ─────────────────────────────────────────────────

assert.equal(parseSpellPropagation("Target"), "target");
assert.equal(parseSpellPropagation("Shot"), "shot");
assert.equal(parseSpellPropagation("Line"), "line");
assert.equal(parseSpellPropagation("Breakthrough"), "breakthrough");
assert.equal(parseSpellPropagation("-"), null, "Explicit '-' means no projected area");
assert.equal(parseSpellPropagation(""), null);
assert.equal(parseSpellPropagation("Bounce"), null, "Unknown propagation is reported, not invented");
record("propagation vocabulary (target/shot/line/breakthrough/null)");

// ── 9. Damage type (DEC-9 bidimensional model) ─────────────────────────────

assert.equal(spellDamageNature([], true), "magical");
assert.equal(spellDamageNature([], false), null);
assert.equal(spellDamageNature([{ damageType: "physical" }], false), "physical");
assert.equal(spellDamageNature([{ damageType: "magical" }], true), "magical");
assert.equal(spellDamageNature([{ damageType: "physical" }, { damageType: "magical" }], false), null, "Mixed bands: unknown, never guessed");
assert.equal(readSpellDamageAttributeFromMetadata("Type: Poison"), "Poison");
assert.equal(readSpellDamageAttributeFromMetadata("Type: Psychic (Weak)"), "Psychic", "Weakness qualifiers are not the attribute");
assert.equal(readSpellDamageAttributeFromMetadata("Cost: MP6"), null);
assert.equal(parseSw25SpellDamageAttribute({ system: { damageType: { nature: "magical", attribute: "Poison" } } }), "Poison");
assert.equal(parseSw25SpellDamageAttribute({ system: { damageType: null } }), null);
record("damage nature + attribute derivation");

// ── 10. Full derivation from source data ───────────────────────────────────

{
  const derived = deriveSpellFields({
    name: "⏩△Invisibility",
    metadata: "Target: Caster\nRange/Area: Caster\nDuration: 3 minutes (18 rounds)\nResistance: Half\nType: Psychic (Weak)",
    specialDamageBands: [],
    hasPowerTable: false
  });
  assert.equal(derived.rank, 0);
  assert.equal(derived.minorAction, true, "⏩ marker → minorAction");
  assert.equal(derived.combatPreparation, true, "△ marker → combatPreparation");
  assert.equal(derived.target, "caster");
  assert.equal(derived.range, null, "Non-uniform range reported as null");
  assert.ok(derived.warnings.some(w => w.includes("Range")), "Unrecognized range is reported");
  assert.equal(derived.area, null);
  assert.equal(derived.duration, "3 minutes (18 rounds)");
  assert.equal(derived.resistance, "half");
  assert.equal(derived.usesFortitude, false);
  assert.deepEqual(derived.damageType, { nature: null, attribute: "Psychic" });

  const areaSpell = deriveSpellFields({
    name: "Fireball",
    metadata: "Target: 1 area (3m radius)/5\nRange/Area: 2 (30m) / Shot\nDuration: Instant\nResistance: Can't",
    specialDamageBands: [],
    hasPowerTable: true
  });
  assert.deepEqual(areaSpell.target, { type: "area", areaCount: 1, radius: 3, selection: "limited", maxTargets: 5 });
  assert.deepEqual(areaSpell.range, { areas: 2, distance: 30 });
  assert.equal(areaSpell.area, "shot");
  assert.equal(areaSpell.duration, "Instant");
  assert.equal(areaSpell.resistance, "cant");
  assert.deepEqual(areaSpell.damageType, { nature: "magical", attribute: null });

  const fortSpell = deriveSpellFields({
    name: "Mana Max II",
    metadata: "Target: Caster\nDuration: Instant\nResistance: Fortitude/Half",
    specialDamageBands: [],
    hasPowerTable: false
  });
  assert.equal(fortSpell.usesFortitude, true);
  assert.equal(fortSpell.resistance, "half");
  assert.equal(fortSpell.rank, 2);

  const physicalSpell = deriveSpellFields({
    name: "Wolf's Bite",
    metadata: "Target: 1 character\nRange/Area: 1 (10m) / Target\nDuration: Instant",
    specialDamageBands: [{ min: 2, max: 6, bonus: 0, damageType: "physical", text: "Magic Power points as physical damage." }],
    hasPowerTable: false
  });
  assert.deepEqual(physicalSpell.damageType, { nature: "physical", attribute: null });
  assert.equal(physicalSpell.area, "target");
  record("full structured derivation (markers, rank, target/range/area, duration, resistance, damageType)");
}

// ── 11. Migration normalization (old schema → new schema, idempotent) ──────

{
  const oldSystem = {
    favourite: true,
    school: "Sorcerer",
    classId: "cls-1",
    className: "Sorcerer",
    level: 1,
    mpCost: 5,
    power: 10,
    critical: 10,
    criticalModifier: 0,
    hasPowerTable: true,
    powerTable: { "3": 1, "12": 7 },
    specialDamageBands: [],
    featureType: "spell",
    requirement: "Truespeech Spell, Level 1 Sorcerer Required",
    cost: "MP 5",
    metadata: "Target: 1 character\nRange/Area: 2 (30m) / Shot\nDuration: Instant\nResistance: Half",
    resourceData: { hpCost: "" },
    sourceUrl: "https://sw25.wikidot.com/spell:energy-bolt",
    description: "Creates an arrow of mana."
  };
  const first = normalizeSpellData({ ...oldSystem }, { name: "Energy Bolt" });
  const system = first.system;

  // Obsolete fields removed; Power is retained as the catalog row selector.
  for (const key of ["school", "cost", "featureType", "resourceData"]) {
    assert.equal(system[key], undefined, `obsolete field "${key}" removed`);
  }
  // Retained fields preserved.
  assert.equal(system.favourite, true);
  assert.equal(system.classId, "cls-1");
  assert.equal(system.className, "Sorcerer");
  assert.equal(system.mpCost, 5);
  assert.equal(system.power, 10);
  assert.equal(system.critical, 10);
  assert.equal(system.sourceUrl, "https://sw25.wikidot.com/spell:energy-bolt");
  assert.match(system.metadata, /Range\/Area: 2 \(30m\)/, "metadata preserved verbatim");
  // Structured fields derived.
  assert.equal(system.rank, 0);
  assert.equal(system.resistance, "half");
  assert.equal(system.usesFortitude, false);
  assert.equal(system.target, "character");
  assert.deepEqual(system.range, { areas: 2, distance: 30 });
  assert.equal(system.area, "shot");
  assert.equal(system.duration, "Instant");
  assert.deepEqual(system.damageType, { nature: "magical", attribute: null });
  assert.equal(system.minorAction, false);
  assert.equal(system.combatPreparation, false);

  // Idempotency: a second pass changes nothing.
  const second = normalizeSpellData({ ...system }, { name: "Energy Bolt" });
  assert.deepEqual(second.system, system, "normalization is idempotent");
  assert.deepEqual(second.warnings, []);

  // Existing structured values are never overwritten — EXCEPT a stored
  // modality `false` next to an authored marker (the marker is authoritative).
  const manual = normalizeSpellData({ ...oldSystem, resistance: "neg", rank: 3, minorAction: true }, { name: "Energy Bolt" });
  assert.equal(manual.system.resistance, "neg");
  assert.equal(manual.system.rank, 3);
  assert.equal(manual.system.minorAction, true);
  const legacyMarker = normalizeSpellData(
    { ...oldSystem, minorAction: false, combatPreparation: false },
    { name: "⏩△Wing Flyer" }
  );
  assert.equal(legacyMarker.system.minorAction, true, "a stored false next to a ⏩ marker is repaired");
  assert.equal(legacyMarker.system.combatPreparation, true, "a stored false next to a △ marker is repaired");
  const userUnmarked = normalizeSpellData({ ...oldSystem, minorAction: true, combatPreparation: true }, { name: "Energy Bolt" });
  assert.equal(userUnmarked.system.minorAction, true, "a stored true without a marker is a user edit and is kept");
  assert.equal(userUnmarked.system.combatPreparation, true);
  record("migration normalization: old schema → new schema, idempotent, never overwrites (markers repair legacy modality booleans)");
}

// ── 12. Rank parsing through the migration path ────────────────────────────

{
  const ranked = normalizeSpellData(
    { metadata: "Duration: Instant\nResistance: Half" },
    { name: "Summon Fairy IV" }
  );
  assert.equal(ranked.system.rank, 4, "rank derived from the shared identity parser");
  assert.equal(ranked.system.family, undefined, "family is not persisted on Spell Items");
  record("rank derivation via shared identity (integer, 0 = base)");
}

console.log(`spell-data.test.mjs: ${passed} groups passed.`);
