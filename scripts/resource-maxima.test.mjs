// Sword World 2.5 - unified HP/MP resource maxima test
// Verifies the unified maximum persistence (module/actor/resource-maxima.mjs):
//   - both formulas (rules/resources.mjs) and the unified accessor,
//   - the updateActor change detector (nested v14 hook shape + flat dotted
//     programmatic shapes, irrelevant changes rejected),
//   - syncActorMaxima persistence (write only on diff, idempotence, no loop),
//   - persistent-decrease clamping against the effective maximum,
//   - persistent increases never touching the current value,
//   - the effective maxima exposure in the preparation pipeline,
//   - hook wiring and the GM-side migration.

import assert from "node:assert/strict";
import {
  characterHPMaximum,
  characterMPMaximum,
  characterResourceMaximum,
  characterResourceValue,
  updateCharacterResourceValue,
  wizardClassLevels
} from "../module/rules/resources.mjs";
import {
  computeCharacterMaxima,
  initializeResourceMaxima,
  maximaSyncRelevantChange,
  migrateResourceMaxima,
  syncActorMaxima
} from "../module/actor/resource-maxima.mjs";
import {
  prepareSw25EffectiveValues,
  sw25EffectiveResourceMaximum
} from "../module/effects/effective-values.mjs";

/* ── stub helpers ─────────────────────────────────────────────────────── */

let stubIdCounter = 0;
function classItem(name, classType, level) {
  stubIdCounter += 1;
  return { id: `cls${stubIdCounter}`, type: "class", name, system: { classType, level } };
}

function stubActor({ type = "character", isOwner = true, system = {}, items = [], effects = [] } = {}) {
  return {
    type,
    isOwner,
    name: "Stub",
    id: "stub",
    system,
    items,
    effects,
    updates: [],
    async update(data, options) {
      this.updates.push({ data, options });
      /* Mirror the real document behaviour: writes land on system (the keys
         are actor-relative, so the leading "system" segment is consumed). */
      for (const [key, value] of Object.entries(data)) {
        const parts = key.split(".");
        const segments = parts[0] === "system" ? parts.slice(1) : parts;
        let node = this.system;
        for (let i = 0; i < segments.length - 1; i += 1) {
          node[segments[i]] ??= {};
          node = node[segments[i]];
        }
        node[segments[segments.length - 1]] = value;
      }
    }
  };
}

function hpEffect(key, value, type = "add") {
  return { id: "fx", type: "sw25Effect", disabled: false, name: "Effect", system: { changes: [{ key, type, value }] } };
}

/* ── formulas ─────────────────────────────────────────────────────────── */

console.log("=== formulas (rules/resources.mjs) ===");

const system = { abilityBases: { body: 4, mind: 6 }, abilityAdjustments: { d: { growth: 1 }, f: { correction: 2 } } };
const classes = [classItem("Fighter", "warrior", 2), classItem("Wizard", "wizard", 3), classItem("Sage", "magician", 1)];

assert.equal(characterAdventurerLevelGuard(classes), 3, "adventurer level is the highest class level");
assert.equal(wizardClassLevels(classes), 9, "only wizard-type class levels contribute (3 × 3)");
assert.equal(characterHPMaximum(system, classes), 3 * 3 + (4 + 1), "HP max = adventurer level × 3 + Vitality");
assert.equal(characterMPMaximum(system, classes), 9 + (6 + 2), "MP max = wizard levels × 3 + Spirit adjustments");
assert.equal(characterMPMaximum({ abilityBases: { mind: 5 } }, []), 5, "MP max without classes is just Spirit");

function characterAdventurerLevelGuard(items) {
  return Array.from(items).reduce((highest, item) => Math.max(highest, Number(item.system.level ?? 0)), 0);
}

console.log("=== current-resource normalization and scalar writes ===");

const currentCases = [
  [20, 20],
  ["20", 20],
  [[20], 20],
  [[20, 20], 20],
  [["20", "20"], 20],
  [[null, 30, null, null], 30],
  [[null, "", "17", 19], 17],
  [[NaN, "bad", 12], 12]
];
for (const [caseIndex, [raw, expected]] of currentCases.entries()) {
  const actor = stubActor({ system: { mp: { value: Array.isArray(raw) ? [...raw] : raw } } });
  assert.equal(characterResourceValue(actor, "mp"), expected, `current MP normalization case ${caseIndex + 1}`);
  if (Array.isArray(raw)) assert.deepEqual(actor.system.mp.value, raw, "reading never mutates the persisted legacy array");
}
for (const raw of [[], null, undefined, "", "bad", NaN, Infinity]) {
  const actor = stubActor({ system: { mp: { value: raw } } });
  assert.equal(characterResourceValue(actor, "mp"), 0, "missing and non-finite current values safely become zero");
}
assert.equal(characterResourceValue(null, "mp"), 0, "no actor current value → 0");
assert.equal(characterResourceValue(stubActor(), "spell"), 0, "unknown current resource → 0");

const scalarWriteActor = stubActor({ system: { mp: { value: [20, 20] } } });
await updateCharacterResourceValue(scalarWriteActor, "mp", "24", { render: false });
assert.equal(scalarWriteActor.system.mp.value, 24, "the writer persists a numeric scalar");
assert.equal(typeof scalarWriteActor.system.mp.value, "number", "the persisted value is not a string or array");
assert.deepEqual(scalarWriteActor.updates[0], { data: { "system.mp.value": 24 }, options: { render: false } }, "the writer uses only the canonical path and forwards update options");
await updateCharacterResourceValue(scalarWriteActor, "mp", [null, "", "19", 22]);
assert.equal(scalarWriteActor.system.mp.value, 19, "legacy array input is normalized before persistence");
await updateCharacterResourceValue(scalarWriteActor, "mp", "bad");
assert.equal(scalarWriteActor.system.mp.value, 0, "invalid UI input can never persist NaN");

console.log("=== unified accessor (characterResourceMaximum) ===");

assert.equal(characterResourceMaximum(null, "hp"), 0, "no actor → 0");
assert.equal(characterResourceMaximum(system, "spell"), 0, "unknown resource → 0");
assert.equal(
  characterResourceMaximum({ system: { hp: { max: 13 } }, items: [] }, "hp"),
  13,
  "stored HP max is read first"
);assert.equal(
  characterResourceMaximum({ system: { mp: { max: 15 } }, items: [] }, "mp"),
  15,
  "stored MP max is read first"
);
assert.equal(
  characterResourceMaximum({ system: { hp: { max: 0 }, abilityBases: { body: 4 }, abilityAdjustments: { d: { growth: 1 } } }, items: classes }, "hp"),
  14,
  "zero HP max falls back to the formula"
);
assert.equal(
  characterResourceMaximum({ system: system, items: classes }, "mp"),
  17,
  "missing MP max falls back to the formula"
);
assert.equal(
  characterResourceMaximum({ system: { hp: { max: 9 } }, items: classes }, "hp"),
  9,
  "a non-zero stored HP max wins over the formula"
);

/* ── change detection ─────────────────────────────────────────────────── */

console.log("=== updateActor change detection (nested + flat shapes) ===");

assert.equal(maximaSyncRelevantChange({ system: { abilityBases: { body: 7 } } }), true, "nested abilityBases diff");
assert.equal(maximaSyncRelevantChange({ system: { abilityAdjustments: { f: { growth: 1 } } } }), true, "nested abilityAdjustments diff");
assert.equal(maximaSyncRelevantChange({ "system.abilityBases.body": 7 }), true, "flat abilityBases path");
assert.equal(maximaSyncRelevantChange({ "system.abilityAdjustments.f.correction": 2 }), true, "flat abilityAdjustments path");
assert.equal(maximaSyncRelevantChange({ system: { body: 4, mind: 6, abilityBases: { body: 4 } } }), true, "whole-system replacement carrying the formula keys");
assert.equal(maximaSyncRelevantChange({ _id: "x", system: { abilityBases: { body: 7 } } }), true, "nested diff with _id (real hook payload)");
assert.equal(maximaSyncRelevantChange({ system: { hp: { value: 5 } } }), false, "HP value write is irrelevant");
assert.equal(maximaSyncRelevantChange({ system: { hp: { max: 13 } } }), false, "the sync's own max write is irrelevant (no loop)");
assert.equal(maximaSyncRelevantChange({ system: { mp: { value: 3, max: 15 } } }), false, "MP value/max writes are irrelevant");
assert.equal(maximaSyncRelevantChange({ flags: { "sw25-taka": { sheetStyle: "light" } } }), false, "flag writes are irrelevant");
assert.equal(maximaSyncRelevantChange({ name: "Renamed" }), false, "name writes are irrelevant");
assert.equal(maximaSyncRelevantChange(null), false, "null payload");
assert.equal(maximaSyncRelevantChange({}), false, "empty payload");

/* ── synchronization ──────────────────────────────────────────────────── */

console.log("=== syncActorMaxima: persistence and idempotence ===");

const freshActor = stubActor({
  system: { abilityBases: { body: 4, mind: 6 }, abilityAdjustments: { d: { growth: 1 }, f: { correction: 2 } } },
  items: classes
});
assert.equal(await syncActorMaxima(freshActor), true, "missing maxima are persisted");
assert.deepEqual(
  freshActor.updates[0].data,
  { "system.hp.max": 14, "system.mp.max": 17 },
  "both maxima are written in one update"
);
assert.deepEqual(freshActor.updates[0].options, { render: false }, "maximum-only writes skip the sheet re-render");

const before = freshActor.updates.length;
assert.equal(await syncActorMaxima(freshActor), false, "second sync is a no-op (idempotent)");
assert.equal(freshActor.updates.length, before, "no update written when values already match");

/* no loop: the sync's own payload is irrelevant to the detector */
assert.equal(maximaSyncRelevantChange(freshActor.updates[0].data), false, "sync payload never re-triggers the listener");

console.log("=== syncActorMaxima: authority and scope ===");

assert.equal(await syncActorMaxima(stubActor({ type: "monster", system: {} })), false, "non-character actors are never synced");
const nonOwner = stubActor({ system: {}, items: classes, isOwner: false });
assert.equal(await syncActorMaxima(nonOwner), false, "non-owner clients never write");
assert.equal(nonOwner.updates.length, 0, "non-owner write skipped");

console.log("=== syncActorMaxima: decrease clamps to the effective maximum ===");

const decreaseActor = stubActor({
  system: {
    abilityBases: { body: 4, mind: 6 },
    hp: { max: 20, value: 18 },
    mp: { max: 30, value: 28 },
    sw25EffectMods: { resources: { hpMax: 2, mpMax: 0 } }
  },
  items: [classItem("Wizard", "wizard", 1)] // adventurer 1 → HP 3+4=7; wizard 1 → MP 3+6=9
});
assert.equal(await syncActorMaxima(decreaseActor), true, "decrease is persisted");
assert.deepEqual(
  decreaseActor.updates[0].data,
  { "system.hp.max": 7, "system.hp.value": 9, "system.mp.max": 9, "system.mp.value": 9 },
  "decreased maxima clamp current values to base + effect modifiers (7 + 2 HP, 9 MP)"
);
assert.deepEqual(decreaseActor.updates[0].options, {}, "value-clamping writes re-render open sheets");

const legacyArrayDecrease = stubActor({
  system: {
    abilityBases: { body: 4, mind: 6 },
    hp: { max: 7, value: 5 },
    mp: { max: 30, value: [28, 28] }
  },
  items: [classItem("Wizard", "wizard", 1)]
});
await syncActorMaxima(legacyArrayDecrease);
assert.deepEqual(
  legacyArrayDecrease.updates[0].data,
  { "system.mp.max": 9, "system.mp.value": 9 },
  "a legacy MP array is normalized before applying a persistent-maximum decrease"
);

const fittingActor = stubActor({
  system: {
    abilityBases: { body: 4, mind: 6 },
    hp: { max: 20, value: 5 },
    sw25EffectMods: { resources: { hpMax: 2, mpMax: 0 } }
  },
  items: [classItem("Wizard", "wizard", 1)]
});
await syncActorMaxima(fittingActor);
assert.deepEqual(fittingActor.updates[0].data, { "system.hp.max": 7, "system.mp.max": 9 }, "a current value that still fits inside the new effective maximum is conserved (MP maximum also missing → persisted)");

console.log("=== syncActorMaxima: increases never touch the current value ===");

const increaseActor = stubActor({
  system: { abilityBases: { body: 4, mind: 6 }, hp: { max: 7, value: 5 }, mp: { max: 9, value: 3 } },
  items: [classItem("Fighter", "warrior", 2), classItem("Wizard", "wizard", 3)]
});
assert.equal(await syncActorMaxima(increaseActor), true, "increase is persisted");
assert.deepEqual(
  increaseActor.updates[0].data,
  { "system.hp.max": 13, "system.mp.max": 15 },
  "current values are untouched on an increase"
);

console.log("=== syncActorMaxima: effect-raised maximum above the decrease cap ===");

const shieldedActor = stubActor({
  system: {
    abilityBases: { body: 4, mind: 6 },
    hp: { max: 20, value: 12 },
    sw25EffectMods: { resources: { hpMax: 5, mpMax: 0 } }
  },
  items: [classItem("Wizard", "wizard", 1)] // new base 7 + 5 effect = 12 effective
});
await syncActorMaxima(shieldedActor);
assert.deepEqual(
  shieldedActor.updates[0].data,
  { "system.hp.max": 7, "system.mp.max": 9 },
  "a current value inside the effective maximum survives a persistent decrease (12 ≤ 12)"
);
assert.equal(shieldedActor.updates[0].data["system.hp.value"], undefined, "value write present only when the cap is exceeded");

const clampedShieldedActor = stubActor({
  system: {
    abilityBases: { body: 4, mind: 6 },
    hp: { max: 20, value: 15 },
    sw25EffectMods: { resources: { hpMax: 5, mpMax: 0 } }
  },
  items: [classItem("Wizard", "wizard", 1)] // cap = 7 + 5 = 12
});
await syncActorMaxima(clampedShieldedActor);
assert.deepEqual(
  clampedShieldedActor.updates[0].data,
  { "system.hp.max": 7, "system.hp.value": 12, "system.mp.max": 9 },
  "a value above the effective maximum is clamped to it"
);

/* ── preparation pipeline: prepared effective maxima ───────────────────── */

console.log("=== prepared effective maxima (effective-values pipeline) ===");

const preparedActor = stubActor({
  system: {
    hp: { max: 13, value: 6 },
    mp: { max: 17, value: 9 }
  },
  effects: [hpEffect("resource.mpMax", 4)]
});
prepareSw25EffectiveValues(preparedActor);
assert.equal(preparedActor.system.hp.maxEffective, 13, "HP maxEffective = base when no effect touches it");
assert.equal(preparedActor.system.mp.maxEffective, 21, "MP maxEffective = base + resource.mpMax ledger");
assert.equal(sw25EffectiveResourceMaximum(preparedActor, "mp"), 21, "sw25EffectiveResourceMaximum reads the same sum");
assert.equal(sw25EffectiveResourceMaximum(preparedActor, "hp"), 13, "HP effective matches");
assert.equal(sw25EffectiveResourceMaximum(preparedActor, "spell"), 0, "unknown resource → 0");

const nonCharacterPrepared = stubActor({ type: "monster", system: { hp: { max: 10 } } });
prepareSw25EffectiveValues(nonCharacterPrepared);
assert.equal(nonCharacterPrepared.system.hp.maxEffective, undefined, "non-character actors keep their own resource layout");

const unpreparedActor = stubActor({ system: { hp: { max: 13 } } });
assert.equal(sw25EffectiveResourceMaximum(unpreparedActor, "hp"), 13, "unprepared actors get the base maximum (zero ledger)");

/* ── hook wiring ──────────────────────────────────────────────────────── */

console.log("=== hook wiring ===");

function stubHooks() {
  const handlers = { on: {}, once: {} };
  return {
    handlers,
    on(name, fn) { (handlers.on[name] ??= []).push(fn); },
    once(name, fn) { (handlers.once[name] ??= []).push(fn); }
  };
}

const hooks = stubHooks();
assert.equal(initializeResourceMaxima(), false, "without a Hooks global the registration is skipped (Node)");
assert.equal(initializeResourceMaxima(hooks), true, "hooks register on first call");
assert.equal((hooks.handlers.on.updateActor ?? []).length, 1, "one updateActor listener");
assert.equal((hooks.handlers.on.createItem ?? []).length, 1, "one createItem listener");
assert.equal((hooks.handlers.on.updateItem ?? []).length, 1, "one updateItem listener");
assert.equal((hooks.handlers.on.deleteItem ?? []).length, 1, "one deleteItem listener");
assert.equal((hooks.handlers.once.ready ?? []).length, 1, "one ready migration hook");
assert.equal(initializeResourceMaxima(stubHooks()), true, "second registration is a no-op");

const savedHooks = globalThis.Hooks;
globalThis.Hooks = hooks;
try {
  const listener = hooks.handlers.on.updateActor[0];
  const hookActor = stubActor({ system: { abilityBases: { body: 4, mind: 6 } }, items: classes });
  await listener(hookActor, { _id: "x", system: { abilityBases: { body: 7 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hookActor.updates.length, 1, "a relevant nested change triggers the sync");

  const irrelevantActor = stubActor({ system: { hp: { value: 1 } } });
  await listener(irrelevantActor, { system: { hp: { value: 5 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(irrelevantActor.updates.length, 0, "an irrelevant change does not sync");

  const itemListener = hooks.handlers.on.updateItem[0];
  const parentActor = stubActor({ system: {}, items: [classItem("Wizard", "wizard", 3)] });
  await itemListener({ type: "class", parent: parentActor });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(parentActor.updates.length, 1, "a class item update syncs the parent actor");

  const untouchedParent = stubActor({ system: {} });
  await itemListener({ type: "feat", parent: untouchedParent });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(untouchedParent.updates.length, 0, "non-formula item types do not sync");
} finally {
  if (savedHooks === undefined) delete globalThis.Hooks; else globalThis.Hooks = savedHooks;
}

/* ── migration ────────────────────────────────────────────────────────── */

console.log("=== migration ===");

const savedGame = globalThis.game;
globalThis.game = { user: { isGM: true } };
try {
  const legacyActor = stubActor({ system: { abilityBases: { body: 4, mind: 6 }, abilityAdjustments: { f: { correction: 2 } } }, items: classes });
  const alreadySynced = stubActor({ system: { abilityBases: { body: 4, mind: 6 }, abilityAdjustments: { d: { growth: 1 }, f: { correction: 2 } }, hp: { max: 14 }, mp: { max: 17 } }, items: classes });
  const monster = stubActor({ type: "monster", system: {} });
  const count = await migrateResourceMaxima([legacyActor, alreadySynced, monster]);
  assert.equal(count, 1, "only the legacy character needed a write");
  assert.deepEqual(legacyActor.updates[0].data, { "system.hp.max": 13, "system.mp.max": 17 }, "migration persists both maxima");
  assert.equal(alreadySynced.updates.length, 0, "already-synced actors are left alone (idempotent)");
  assert.equal(monster.updates.length, 0, "monsters keep their own editable maxima");

  globalThis.game = { user: { isGM: false } };
  const blockedActor = stubActor({ system: {}, items: classes });
  assert.equal(await migrateResourceMaxima([blockedActor]), 0, "non-GM clients never migrate");
  assert.equal(blockedActor.updates.length, 0, "no writes from a non-GM migration");
} finally {
  globalThis.game = savedGame;
}

console.log("\nAll resource maxima tests passed.");
