// Sword World 2.5 - EFFECT_TARGETS + effective values test suite (T3.1-T3.4).
//
// Exercises module/effects/targets.mjs (the versioned destination catalog)
// and module/effects/effective-values.mjs (the single processing point of the
// system's persistent effects inside the Actor preparation flow, DEC-28) in a
// single headless process.
//
// Scope: catalog version/structure/coverage, known/unknown/reserved target
// resolution, the absence of maxOfGroup (DEC-37/DEC-44), ledger production
// (fresh object per preparation, add/subtract accumulation, foreign subtypes
// excluded, disabled effects skipped, diagnostics instead of silent
// application), exact restoration when effects are removed, no double
// counting across re-preparations, base values never overwritten, and the
// consumption contract (effective ability bonuses for rolls, the
// sw25EffectModifier accessor used by the sheet/spell/weapon consumers).
//
// No stacking policies, durations, special-target treatments (Bloques 6/7)
// or the Bloque 4 resolver belong to this suite.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── Global mock (before any import of the effect module graph) ──────────────

globalThis.foundry = {
  data: {
    ActiveEffectTypeDataModel: class ActiveEffectTypeDataModelStub {}
  },
  utils: { escapeHTML: value => String(value) }
};

const targets = await import("../module/effects/targets.mjs");
const effectiveValues = await import("../module/effects/effective-values.mjs");
const { SW25_EFFECT_SUBTYPE } = await import("../module/effects/effect-model.mjs");
const { abilityBonus } = await import("../module/rules/weapon-damage.mjs");

const {
  EFFECT_TARGETS,
  EFFECT_TARGETS_VERSION,
  EFFECT_TARGET_GROUPS,
  SPECIAL_TARGET_PREFIXES,
  SKILL_TARGET_PREFIX,
  isKnownSw25EffectTargetKey,
  resolveSw25EffectTargetKey
} = targets;
const {
  SW25_EFFECT_MODS_KEY,
  APPLIED_SW25_CHANGE_TYPES,
  buildEmptySw25EffectLedger,
  prepareSw25EffectiveValues,
  sw25EffectLedger,
  sw25EffectModifier,
  installSw25EffectiveValues
} = effectiveValues;

const record = (label) => console.log(`  ${label}`);

// ── Catalog: version, structure and DEC-28 coverage ─────────────────────────

{
  assert.equal(EFFECT_TARGETS_VERSION, 1);
  assert.equal(typeof EFFECT_TARGETS, "object");
  record("catalog version is 1");

  // Every DEC-28 destination class is covered; the exact approved key set.
  const required = [
    "ability.strength", "ability.agility", "ability.dexterity",
    "ability.vitality", "ability.intelligence", "ability.spirit",
    "resistance.fortitude", "resistance.willpower",
    "combat.accuracy", "combat.evasion", "combat.defense",
    "combat.magicalDefense", "combat.initiative", "combat.magicPower",
    "combat.additionalDamage",
    "resource.hpMax", "resource.mpMax",
    "special.damageMatrix", "special.powerTable.potency",
    "special.powerTable.index", "special.powerTable.result"
  ];
  for (const key of required) {
    assert.ok(EFFECT_TARGETS[key], `missing catalog entry: ${key}`);
  }
  record("all DEC-28 destinations declared (abilities, resistances, combat, HP/MP)");

  // No free keys outside the catalog: every entry is well-formed.
  for (const [catalogKey, entry] of Object.entries(EFFECT_TARGETS)) {
    assert.equal(entry.key, catalogKey, `entry ${catalogKey} carries its own key`);
    assert.ok(["abilities", "resistances", "combat", "resources", "special"].includes(entry.group));
    assert.ok(["arithmetic", "special"].includes(entry.nature));
    assert.ok(["roll", "final"].includes(entry.phase));
    assert.ok(typeof entry.label === "string" && entry.label.length > 0);
    if (entry.nature === "arithmetic") {
      assert.equal(entry.treatment, "accumulate");
      assert.match(entry.ledger, /^[a-z]+\.[a-zA-Z]+$/, `ledger path of ${entry.key}`);
    } else {
      assert.equal(entry.treatment, "reserved");
      assert.equal(entry.ledger, null);
    }
  }
  record("entries well-formed (nature/phase/group/ledger/treatment)");

  // Arithmetic vs special classification.
  for (const key of ["ability.strength", "combat.defense", "resource.hpMax"]) {
    assert.equal(EFFECT_TARGETS[key].nature, "arithmetic");
  }
  for (const key of ["special.damageMatrix", "special.powerTable.potency",
    "special.powerTable.index", "special.powerTable.result"]) {
    assert.equal(EFFECT_TARGETS[key].nature, "special");
    assert.equal(EFFECT_TARGETS[key].treatment, "reserved");
  }
  assert.ok(SPECIAL_TARGET_PREFIXES.includes("special."));
  record("arithmetic vs special classification");

  // DEC-37/DEC-44: no maxOfGroup change type, no provisional policy rule.
  assert.ok(!("maxOfGroup" in EFFECT_TARGETS));
  assert.ok(!Object.keys(EFFECT_TARGETS).some(key => key.toLowerCase().includes("maxofgroup")));
  assert.ok(!Object.values(EFFECT_TARGETS).some(entry => String(entry.treatment).includes("max")));
  assert.ok(!APPLIED_SW25_CHANGE_TYPES.has("maxOfGroup"));
  record("no maxOfGroup change type (conflicts belong to the policy layer)");

  assert.ok(Object.values(EFFECT_TARGET_GROUPS).every(group => typeof group === "string"));
}

// ── Catalog: resolution of known / reserved / unknown targets ───────────────

{
  // Known exact targets.
  const defense = resolveSw25EffectTargetKey("combat.defense");
  assert.equal(defense.ok, true);
  assert.equal(defense.code, "known-target");
  assert.equal(defense.target.ledger, "combat.defense");
  assert.ok(isKnownSw25EffectTargetKey("resource.mpMax"));

  // Parameterized skill-check family validated against the skill definitions.
  const skill = resolveSw25EffectTargetKey("skill.climb-agility");
  assert.equal(skill.ok, true);
  assert.equal(skill.code, "known-target");
  assert.equal(skill.target.group, "skills");
  assert.equal(skill.target.ledger, "skills.climb-agility");
  assert.equal(resolveSw25EffectTargetKey("skill.not-a-skill").ok, false);
  assert.equal(resolveSw25EffectTargetKey(`${SKILL_TARGET_PREFIX}`).ok, false);

  // Reserved special destinations resolve to a declared (never applied)
  // identity; undeclared special keys stay reserved-diagnosed as well.
  const matrix = resolveSw25EffectTargetKey("special.damageMatrix");
  assert.equal(matrix.ok, true);
  assert.equal(matrix.code, "reserved-target");
  assert.equal(matrix.target.nature, "special");
  assert.equal(resolveSw25EffectTargetKey("special.powerTable.index").code, "reserved-target");
  assert.equal(resolveSw25EffectTargetKey("special.powerTable.result").code, "reserved-target");
  assert.equal(resolveSw25EffectTargetKey("special.unregistered").code, "reserved-target");

  // Unknown keys are never silently accepted.
  assert.equal(resolveSw25EffectTargetKey("combat.accuracyX").ok, false);
  assert.equal(resolveSw25EffectTargetKey("system.attributes.defense").ok, false);
  assert.equal(resolveSw25EffectTargetKey("").ok, false);
  assert.equal(resolveSw25EffectTargetKey(null).ok, false);
  record("known / skill family / reserved / unknown resolution");
}

// ── Mock actor and effect factories ─────────────────────────────────────────

let nextEffectId = 1;
const sw25Effect = (changes, options = {}) => ({
  id: `ef-${nextEffectId++}`,
  type: options.type ?? SW25_EFFECT_SUBTYPE,
  name: options.name ?? "Probe Effect",
  disabled: options.disabled ?? false,
  system: { changes, ...(options.system ?? {}) }
});

const makeActor = (effects = []) => ({
  id: "actor-1",
  name: "Probe",
  type: "character",
  effects,
  system: {
    hp: { value: 5, max: 10 },
    mp: { value: 2, max: 7 },
    abilityBases: { skill: 3, body: 6, mind: 4 },
    abilityAdjustments: { c: { growth: 0, correction: 0, temporary: 0 } }
  }
});

const zeroLedger = buildEmptySw25EffectLedger();
const zeroed = ledger => {
  assert.deepEqual(ledger.abilities, zeroLedger.abilities);
  assert.deepEqual(ledger.resistances, zeroLedger.resistances);
  assert.deepEqual(ledger.combat, zeroLedger.combat);
  assert.deepEqual(ledger.resources, zeroLedger.resources);
  assert.deepEqual(ledger.skills, {});
};

// ── Actor preparation: no effects (no-regression) ───────────────────────────

{
  const actor = makeActor([]);
  const { ledger, diagnostics } = prepareSw25EffectiveValues(actor);
  zeroed(ledger);
  assert.equal(diagnostics.length, 0);
  assert.equal(actor.system[SW25_EFFECT_MODS_KEY], ledger);
  // The zero ledger keeps every consumer identical to pre-integration.
  assert.equal(sw25EffectModifier(actor, "combat.defense"), 0);
  assert.equal(sw25EffectModifier(actor, "combat.accuracy"), 0);
  assert.equal(abilityBonus(actor.system, "strength"), 1); // floor(6/6)
  record("actor without effects: zero ledger, no diagnostics");
}

// ── Actor preparation: one +2 Defense effect ────────────────────────────────

{
  const actor = makeActor([sw25Effect([{ key: "combat.defense", type: "add", value: 2 }])]);
  const { ledger, diagnostics } = prepareSw25EffectiveValues(actor);
  assert.equal(diagnostics.length, 0);
  assert.equal(ledger.combat.defense, 2);
  assert.equal(sw25EffectModifier(actor, "combat.defense"), 2);
  record("effect with +2 Defense produces the prepared effective value");
}

// ── Removal restores the zero ledger exactly; base values never written ─────

{
  const actor = makeActor([sw25Effect([
    { key: "combat.defense", type: "add", value: 2 },
    { key: "resource.hpMax", type: "add", value: 3 }
  ])]);
  prepareSw25EffectiveValues(actor);
  assert.equal(sw25EffectLedger(actor).combat.defense, 2);
  assert.equal(sw25EffectLedger(actor).resources.hpMax, 3);
  // The stored base is never modified by the pipeline (DEC-28).
  assert.equal(actor.system.hp.max, 10);
  assert.equal(actor.system.mp.max, 7);
  assert.equal(actor.system.abilityBases.body, 6);

  actor.effects = []; // effect removed
  const { ledger } = prepareSw25EffectiveValues(actor);
  zeroed(ledger);
  // Base still intact after removal: exact restoration, nothing to rebuild.
  assert.equal(actor.system.hp.max, 10);
  record("removal restores the zero ledger exactly; base stays stored");
}

// ── Re-preparation never double-counts (fresh ledger replaces the old) ──────

{
  const actor = makeActor([sw25Effect([{ key: "combat.defense", type: "add", value: 2 }])]);
  prepareSw25EffectiveValues(actor);
  const first = actor.system[SW25_EFFECT_MODS_KEY];
  assert.equal(first.combat.defense, 2);
  for (let round = 0; round < 3; round++) {
    const { ledger } = prepareSw25EffectiveValues(actor);
    assert.notEqual(ledger, first, "each preparation assigns a fresh ledger");
    assert.equal(ledger.combat.defense, 2, "no accumulation across preparations");
  }
  record("repeated preparations replace the ledger without double counting");
}

// ── Several effects: each modification processed exactly once ───────────────

{
  const actor = makeActor([
    sw25Effect([{ key: "combat.defense", type: "add", value: 2 }], { name: "A" }),
    sw25Effect([{ key: "combat.defense", type: "add", value: 1 }], { name: "B" }),
    sw25Effect([
      { key: "combat.evasion", type: "subtract", value: 1 },
      { key: "combat.evasion", type: "add", value: -2 }
    ], { name: "C" })
  ]);
  const { ledger } = prepareSw25EffectiveValues(actor);
  assert.equal(ledger.combat.defense, 3, "both effects accumulate");
  assert.equal(ledger.combat.evasion, -3, "subtract and negative add both reduce");
  record("several effects: every modification counted exactly once");
}

// ── Foreign subtypes and disabled effects never join the flow ───────────────

{
  const actor = makeActor([
    sw25Effect([{ key: "combat.defense", type: "add", value: 5 }], { type: "base", name: "Native" }),
    sw25Effect([{ key: "combat.defense", type: "add", value: 4 }], { disabled: true, name: "Disabled" })
  ]);
  const { ledger, diagnostics } = prepareSw25EffectiveValues(actor);
  assert.equal(ledger.combat.defense, 0);
  assert.equal(diagnostics.length, 0, "foreign/disabled documents are simply not processed");
  record("foreign subtypes and disabled effects excluded from the flow");
}

// ── Diagnostics: unknown, reserved, unsupported type, unsupported value ─────

{
  const actor = makeActor([sw25Effect([
    { key: "combat.unknownStat", type: "add", value: 2 },        // unknown key
    { key: "special.powerTable.potency", type: "add", value: 1 }, // reserved
    { key: "combat.defense", type: "upgrade", value: 2 },         // policy layer
    { key: "combat.evasion", type: "add", value: "@str" },        // not a number
    { key: "combat.accuracy", type: "add", value: 1 }             // applied
  ])]);
  const { ledger, diagnostics } = prepareSw25EffectiveValues(actor);
  assert.deepEqual(ledger.combat, { ...zeroLedger.combat, accuracy: 1 });
  const codes = diagnostics.map(d => d.code).sort();
  assert.deepEqual(codes, ["reserved-target", "unknown-target", "unsupported-change-type", "unsupported-value"]);
  for (const diagnostic of diagnostics) assert.ok(diagnostic.effectId, "diagnostics identify the source effect");
  record("unknown/reserved/unsupported changes diagnosed, never applied silently");
}

// ── Skill-check family produces ledger entries ──────────────────────────────

{
  const actor = makeActor([sw25Effect([{ key: "skill.climb-agility", type: "add", value: 2 }])]);
  const { ledger } = prepareSw25EffectiveValues(actor);
  assert.equal(ledger.skills["climb-agility"], 2);
  record("skill-check target accumulates over the skills ledger");
}

// ── Consumers: effective ability bonuses (rolls) ────────────────────────────

{
  // Base: body 6 → Strength bonus 1. With ability.strength +3 the effective
  // score is 9 → bonus 1 stays 1; +8 makes the bonus grow (floor semantics).
  const baseActor = makeActor([]);
  prepareSw25EffectiveValues(baseActor);
  assert.equal(abilityBonus(baseActor.system, "strength"), 1);
  const boosted = makeActor([sw25Effect([{ key: "ability.strength", type: "add", value: 3 }])]);
  prepareSw25EffectiveValues(boosted);
  assert.equal(abilityBonus(boosted.system, "strength"), 1); // floor(9/6)
  const boostedMore = makeActor([sw25Effect([{ key: "ability.strength", type: "add", value: 8 }])]);
  prepareSw25EffectiveValues(boostedMore);
  assert.equal(abilityBonus(boostedMore.system, "strength"), 2); // floor(14/6)
  // Dexterity reads the skill-group base and stays ledger-aware.
  assert.equal(abilityBonus(baseActor.system, "dexterity"), 0);
  assert.equal(abilityBonus(boosted.system, "agility"), 0);
  record("ability bonuses derive from the effective score (rolls consume prepared values)");
}

// ── Consumers: the sw25EffectModifier accessor ───────────────────────────────

{
  const actor = makeActor([sw25Effect([{ key: "combat.magicPower", type: "add", value: 1 }])]);
  prepareSw25EffectiveValues(actor);
  assert.equal(sw25EffectModifier(actor, "combat.magicPower"), 1);
  assert.equal(sw25EffectModifier(actor, "resource.mpMax"), 0);
  // Unprepared/stub actors read the zero structure.
  assert.equal(sw25EffectModifier({ system: {} }, "combat.defense"), 0);
  assert.equal(sw25EffectModifier(null, "combat.defense"), 0);
  // Unknown keys warn and return 0: no consumer can invent a destination.
  assert.equal(sw25EffectModifier(actor, "made.up.key"), 0);
  record("sw25EffectModifier accessor (sheet/spell/weapon consumption contract)");
}

// ── Consumers: weapon damage roll uses the prepared values ──────────────────

{
  // Deterministic 2d6 = [3, 4] (no critical failure).
  globalThis.Roll = class MockRoll {
    constructor() { this.dice = [{ results: [{ result: 3, active: true }, { result: 4, active: true }] }]; }
    async evaluate() { this.total = 7; return this; }
    async toMessage(message) { globalThis.Roll.messages.push(message); }
  };
  globalThis.Roll.messages = [];
  globalThis.ChatMessage = { getSpeaker: () => ({}) };
  globalThis.game = { actors: { get: () => null } };

  const { rollWeaponDamage } = await import("../module/rules/weapon-roll.mjs");

  const actor = makeActor([sw25Effect([
    { key: "combat.additionalDamage", type: "add", value: 3 },
    { key: "ability.strength", type: "add", value: 3 }
  ])]);
  actor.system.combat = { additionalDamage: 2 }; // stored base situational damage
  prepareSw25EffectiveValues(actor); // simulated actor preparation

  const weapon = { name: "Sword", id: "w1", system: { powerTable: { 7: 9 }, additionalDamage: 1, critical: 13 } };
  const attackingClass = { id: "c1", name: "Fighter", system: { level: 3 } };
  await rollWeaponDamage({ actor, weapon, attackingClass });

  assert.equal(globalThis.Roll.messages.length, 1);
  const flavor = globalThis.Roll.messages[0].flavor;
  // total = table 9 + class 3 + strength bonus 1 (effective) + weapon extra 1
  //         + situational 2 (base) + effect extra 3 (ledger) = 19
  assert.ok(flavor.includes("sw25-damage-breakdown-final\"><strong>Final damage:</strong> 19"), `expected effective total 19 in expanded breakdown:\n${flavor}`);
  assert.ok(flavor.includes("Extra Damage:</strong> +10"), "class, ability and extra damage modifiers are included in the expanded breakdown");
  assert.ok(flavor.includes("sw25-damage-result-value\">19"), "final damage is the primary visible value");
  assert.ok(flavor.includes("Power Table"), "the pure roll and Power Table output are visible");
  assert.ok(flavor.includes('data-target="weapon-damage-'), "weapon damage details use a card-specific target");
  assert.ok(flavor.includes("sw25-damage-stat-detail"), "expandable weapon damage details remain available");
  assert.ok(flavor.includes('data-sw25-chat-action="apply-damage"'), "targetless weapon result still offers application controls");
  assert.ok(!flavor.includes('data-actor-id="'), "targetless weapon card does not capture a global target");
  record("weapon damage roll consumes effective strength bonus and Extra Damage ledger");
}

// ── Wiring: production entry points consume the prepared values ─────────────

{
  const sw25Source = readFileSync(new URL("../sw25.mjs", import.meta.url), "utf8");
  const sheetSource = readFileSync(new URL("../module/actor/actor-sheet.mjs", import.meta.url), "utf8");
  const rollSource = readFileSync(new URL("../module/rules/weapon-roll.mjs", import.meta.url), "utf8");
  const damageSource = readFileSync(new URL("../module/rules/weapon-damage.mjs", import.meta.url), "utf8");
  const spellDamageSource = readFileSync(new URL("../module/rules/spell-damage.mjs", import.meta.url), "utf8");

  // sw25.mjs: pipeline installed at init; spell damage uses effective Magic Power.
  assert.ok(sw25Source.includes("installSw25EffectiveValues()"), "sw25.mjs installs the effective-values pipeline");
  assert.ok(spellDamageSource.includes('sw25EffectModifier(actor, "combat.magicPower")'), "spell damage consumes the Magic Power ledger from rules/spell-damage.mjs");
  // Sheet: Accuracy roll parts include the prepared Effects entry.
  assert.ok(sheetSource.includes('sw25EffectModifier(this.actor, "combat.accuracy")'), "sheet Accuracy parts consume the ledger");
  assert.ok(sheetSource.includes('label: "Effects"'), "Effects part is visible in the Accuracy breakdown");
  // Weapon roll: situational damage adds the ledger entry.
  assert.ok(rollSource.includes('sw25EffectModifier(actor, "combat.additionalDamage")'), "weapon roll consumes the Extra Damage ledger");
  // Weapon damage: ability bonus reads the prepared ability ledger.
  assert.ok(damageSource.includes("sw25EffectMods"), "abilityBonus derives from the effective score");
  record("production wiring: sheet, weapon roll, spell damage, ability bonus");
}

// ── Installation into the Actor preparation flow ────────────────────────────

{
  let basePrepareCalls = 0;
  class MockPreparedActor {
    constructor(effects) { this.effects = effects; this.system = {}; }
    prepareData() { basePrepareCalls += 1; this.system.prepared = true; } // core pipeline stub
  }
  globalThis.foundry.documents = { Actor: MockPreparedActor };

  assert.equal(installSw25EffectiveValues(), true);
  const wrapper = MockPreparedActor.prototype.prepareData;
  assert.notEqual(wrapper, undefined);
  // Idempotent installation: a second call does not double-patch.
  assert.equal(installSw25EffectiveValues(), true);
  assert.equal(MockPreparedActor.prototype.prepareData, wrapper);

  const actor = new MockPreparedActor([sw25Effect([{ key: "combat.defense", type: "add", value: 2 }])]);
  actor.prepareData();
  assert.equal(basePrepareCalls, 1, "the core preparation runs untouched");
  assert.equal(actor.system.prepared, true, "core preparation side effects preserved");
  assert.equal(actor.system[SW25_EFFECT_MODS_KEY].combat.defense, 2, "the ledger is prepared after the core pipeline");
  record("install: Actor#prepareData wrapper runs core first, then prepares the ledger");
}

console.log("effects-targets.test.mjs: all catalog/effective-values assertions passed.");
