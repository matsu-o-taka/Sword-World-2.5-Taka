// ---------------------------------------------------------------------------
// spell-consumer-migration.test.mjs — Phase 2 canonical spell consumer
// migration (task: migrate spell consumers to canonical names and
// system.durationData; preserve the effect engine and temporal architecture).
//
// Covered consumers:
//   - rules/spell-data.mjs    getSpellDurationData (centralized duration read)
//   - rules/spell-effects.mjs isInstantXSpell / getInstantXSpellData /
//                             getInstantXSpellIdentity / regenerationSpellData
//   - effects/effect-identity.mjs normalizeSw25FamilyKey (leading ⏩/△ are
//                             authoring metadata, never stacking identity)
//   - rules/spell-cast.mjs    Instant/X immediate-handler registry (canonical
//                             keys) and the Combat Preparation ledger
//
// Validated against the FULL audited compendium corpus
// (spell-normalization-corpus.json, 656 spells) + synthetic cases.
//
// Corpus Instant/X facts pinned here (computed from the corpus, see the
// Phase 2 report): 61 Instant/X spells — 47 counted rounds (27 from seconds,
// 20 from minutes) and 14 manual (4 hours, 5 days, 2 permanent, 3 other);
// 23 of the 61 are written with a space before the slash (all previously
// missed by the raw-text detector); 192 pure Instant spells are NOT Instant/X.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── Minimal Foundry environment mock (before module imports) ────────────────

const consoleWarnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  consoleWarnings.push(args.map(String).join(" "));
  originalWarn(...args);
};

globalThis.game = {
  user: { isGM: true, id: "gm-user" },
  actors: [],
  items: { get: () => null },
  users: { get: () => null, filter: () => [], get activeGM() { return null; } },
  socket: { async emit() {}, on() {} },
  combats: { get: () => null },
  combat: null
};
globalThis.Hooks = { on() {} };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.ChatMessage = { async create() { return {}; }, getSpeaker: () => ({}) };
globalThis.fromUuid = async () => null;
globalThis.foundry = {
  data: { ActiveEffectTypeDataModel: class ActiveEffectTypeDataModelStub {} },
  utils: {
    escapeHTML: value => String(value),
    escapeHtml: value => String(value),
    randomID() { return "r-test-id"; }
  }
};

// ── Module imports (after the environment mock) ─────────────────────────────

const spellData = await import("../module/rules/spell-data.mjs");
const spellEffects = await import("../module/rules/spell-effects.mjs");
const spellCast = await import("../module/rules/spell-cast.mjs");
const effectIdentity = await import("../module/effects/effect-identity.mjs");

const {
  canonicalSpellName,
  parseSpellDurationData,
  getSpellDurationData
} = spellData;
const {
  isInstantXSpell,
  getInstantXSpellData,
  getInstantXSpellIdentity,
  regenerationSpellData
} = spellEffects;
const {
  registerSw25InstantXImmediateHandler,
  resolveCastImmediateComponents,
  spellAlreadyCastInCombatPreparation
} = spellCast;
const { normalizeSw25FamilyKey } = effectIdentity;

let passed = 0;
const record = label => { passed++; console.log(`  PASS: ${label}`); };

const corpus = JSON.parse(readFileSync(new URL("./spell-normalization-corpus.json", import.meta.url), "utf8"));
const spells = corpus.spells;

// ── 1. getSpellDurationData: the centralized duration read path ────────────

{
  const storedData = {
    raw: "Instant / 3 minutes",
    immediate: true,
    persistent: { scale: "rounds", amount: 18, unit: "rounds", sourceUnit: "minutes", sourceAmount: 3, nonIntegerRounds: false }
  };
  const trusted = { system: { duration: "Instant / 3 minutes", durationData: storedData } };
  // A stored durationData whose raw matches the stored expression is trusted
  // byte-for-byte (the same object, no re-derivation, no write).
  assert.equal(getSpellDurationData(trusted), storedData, "matching stored durationData is trusted");
  assert.equal(trusted.system.durationData, storedData, "the read path never writes");

  // A STALE stored durationData (duration edited after normalization) is
  // re-derived from the stored expression; the stored text is never rewritten.
  const stale = { system: { duration: "Instant / 2 hours", durationData: storedData } };
  const repaired = getSpellDurationData(stale);
  assert.notEqual(repaired, storedData, "stale durationData is not trusted");
  assert.equal(repaired.raw, "Instant / 2 hours");
  assert.equal(repaired.persistent.scale, "hours");
  assert.equal(stale.system.durationData, storedData, "the stale value is left untouched (read path)");

  // Absent durationData (legacy document) derives from the raw expression.
  const legacy = { system: { duration: "Instant/10 seconds (1 round)" } };
  const derived = getSpellDurationData(legacy);
  assert.equal(derived.raw, "Instant/10 seconds (1 round)");
  assert.equal(derived.immediate, true);
  assert.equal(derived.persistent.amount, 1);
  assert.equal(legacy.system.durationData, undefined, "derivation does not write back");

  // Malformed stored values are never trusted.
  for (const junk of ["junk", 42, { raw: "Instant", immediate: "yes", persistent: null }, { raw: "Instant" }]) {
    const spell = { system: { duration: "Instant", durationData: junk } };
    const data = getSpellDurationData(spell);
    assert.equal(data.immediate, true, `malformed stored value ${JSON.stringify(junk)} is re-derived`);
    assert.equal(data.persistent, null);
  }

  // Missing duration: the empty reading.
  assert.deepEqual(getSpellDurationData({ system: {} }), { raw: "", immediate: false, persistent: null });
  assert.deepEqual(getSpellDurationData({ system: { durationData: { raw: "", immediate: false, persistent: null } } }),
    { raw: "", immediate: false, persistent: null }, "an empty stored reading is trusted");
  record("getSpellDurationData: trusted/stale/legacy/malformed stored values, never writes");
}

// ── 2. isInstantXSpell over the full corpus (durationData-based) ────────────

{
  let detected = 0;
  let spaceSlash = 0;
  let pureInstant = 0;
  let nonInstant = 0;
  for (const spell of spells) {
    const raw = String(spell.duration ?? "").trim();
    const candidate = { system: { duration: spell.duration } };
    const result = isInstantXSpell(candidate);
    if (/^instant$/i.test(raw)) {
      pureInstant++;
      assert.equal(result, false, `pure Instant is NOT Instant/X: ${spell.name}`);
    } else if (/^instant\s*\//i.test(raw)) {
      detected++;
      assert.equal(result, true, `Instant/X detected: ${spell.name}`);
      if (/^instant\s+\//i.test(raw)) spaceSlash++;
    } else {
      nonInstant++;
      assert.equal(result, false, `non-instant is NOT Instant/X: ${spell.name}`);
    }
  }
  assert.equal(detected, 61, "all 61 Instant/X spells are identified");
  assert.equal(spaceSlash, 23, "the 23 space-before-slash expressions are recognized");
  assert.equal(pureInstant, 192, "192 pure Instant spells stay distinguishable");
  assert.equal(nonInstant, 403, "403 non-instant spells are not Instant/X");
  record(`isInstantXSpell over 656 spells: 61 detected (23 space-slash), 192 pure Instant excluded, 403 others excluded`);
}

// ── 3. getInstantXSpellData over the full corpus (durationData mapping) ─────

{
  const totals = { countedRounds: 0, fromSeconds: 0, fromMinutes: 0, hours: 0, days: 0, permanent: 0, other: 0 };
  for (const spell of spells) {
    const raw = String(spell.duration ?? "").trim();
    if (!/^instant\s*\//i.test(raw) || /^instant$/i.test(raw)) continue;
    const candidate = { system: { duration: spell.duration } };
    const mapping = getInstantXSpellData(candidate);
    const persistent = parseSpellDurationData(raw).persistent;
    assert.ok(mapping, `mapping exists for ${spell.name}`);
    assert.ok(mapping.outOfCombat === null || (typeof mapping.outOfCombat === "object" && mapping.outOfCombat !== null),
      `outOfCombat is null or an object for ${spell.name}`);

    if (persistent.scale === "rounds" && Number.isInteger(persistent.amount) && persistent.amount >= 1) {
      // Counted combat scale: the normalized round value drives the counter.
      assert.equal(mapping.durationScale, "rounds", `counted rounds for ${spell.name}`);
      assert.equal(mapping.initialDuration, persistent.amount, `counter from the normalized value: ${spell.name}`);
      assert.equal(mapping.remainingDuration, persistent.amount, `remaining starts at the normalized value: ${spell.name}`);
      assert.equal(typeof persistent.nonIntegerRounds, "boolean");
      totals.countedRounds++;
      const unit = String(persistent.sourceUnit ?? "");
      if (unit.startsWith("minute")) {
        totals.fromMinutes++;
        assert.deepEqual(mapping.outOfCombat,
          { durationScale: "minutes", initialDuration: persistent.sourceAmount, remainingDuration: persistent.sourceAmount },
          `minute-derived out-of-combat fallback keeps the authored minutes: ${spell.name}`);
      } else if (unit.startsWith("second")) {
        totals.fromSeconds++;
        assert.deepEqual(mapping.outOfCombat,
          { durationScale: "other", initialDuration: null, remainingDuration: null,
            sourceDuration: { unit: "seconds", amount: persistent.sourceAmount } },
          `second-derived out-of-combat fallback is GM-managed and carries the authored seconds identity: ${spell.name}`);
      }
    } else if (persistent.scale === "turns" && Number.isInteger(persistent.amount) && persistent.amount >= 1) {
      assert.equal(mapping.durationScale, "turns");
      assert.equal(mapping.initialDuration, persistent.amount);
      assert.equal(mapping.outOfCombat, null, "authored turns keep the D4 skip out of combat");
      totals.turns = (totals.turns ?? 0) + 1;
    } else if (persistent.scale === "rounds") {
      // Fractional normalized rounds cannot drive the integer engine counter
      // (documented incompatibility): GM-managed "other", never rounded.
      assert.equal(mapping.durationScale, "other", `fractional rounds → other: ${spell.name}`);
      assert.equal(mapping.initialDuration, null);
      assert.equal(mapping.outOfCombat, null);
      totals.fractional = (totals.fractional ?? 0) + 1;
    } else {
      const expectedScale = persistent.scale === "permanent" ? "permanent" : persistent.scale;
      assert.equal(mapping.durationScale, expectedScale, `manual scale for ${spell.name}`);
      assert.equal(mapping.initialDuration, null, `no invented counter: ${spell.name}`);
      assert.equal(mapping.remainingDuration, null, `no invented counter: ${spell.name}`);
      assert.equal(mapping.outOfCombat, null);
      totals[expectedScale] = (totals[expectedScale] ?? 0) + 1;
    }
  }
  assert.equal(totals.countedRounds, 47, "47 counted-rounds Instant/X spells (27 seconds + 20 minutes)");
  assert.equal(totals.fromSeconds, 27, "27 derived from seconds");
  assert.equal(totals.fromMinutes, 20, "20 derived from minutes");
  assert.equal(totals.hours, 4, "4 hours-scale");
  assert.equal(totals.days, 5, "5 days-scale");
  assert.equal(totals.permanent, 2, "2 permanent-scale");
  assert.equal(totals.other, 3, "3 other-scale");
  assert.equal((totals.fractional ?? 0), 0, "no fractional rounds in the corpus");
  assert.equal((totals.turns ?? 0), 0, "no authored-turn Instant/X in the corpus");
  record("getInstantXSpellData over corpus: 47 counted (27s+20min) + 4h/5d/2perm/3other manual, fallbacks consistent");
}

// ── 4. Spot mappings: Daemon Buster, minutes, hours, permanent, fractional ──

{
  const byName = name => spells.find(spell => spell.name === name);
  const daemonBuster = byName("Daemon Buster");
  assert.ok(daemonBuster, "Daemon Buster is in the corpus");
  assert.equal(String(daemonBuster.duration).trim(), "Instant / 10 seconds", "Daemon Buster carries no (N rounds) parenthetical");
  assert.deepEqual(getInstantXSpellData({ system: { duration: daemonBuster.duration } }),
    { durationScale: "rounds", initialDuration: 1, remainingDuration: 1,
      outOfCombat: { durationScale: "other", initialDuration: null, remainingDuration: null,
        sourceDuration: { unit: "seconds", amount: 10 } } },
    "Daemon Buster: 10 seconds = 1 round; the out-of-combat fallback preserves the authored seconds identity");

  const discriminate = byName("Discriminate");
  assert.equal(String(discriminate.duration).trim(), "Instant / 3 minutes (18 rounds)");
  assert.deepEqual(getInstantXSpellData({ system: { duration: discriminate.duration } }),
    { durationScale: "rounds", initialDuration: 18, remainingDuration: 18,
      outOfCombat: { durationScale: "minutes", initialDuration: 3, remainingDuration: 3 } },
    "minute-derived durations count their normalized 18 rounds in combat");

  const holyTree = byName("Holy Tree");
  assert.equal(String(holyTree.duration).trim(), "Instant / 1 Hour");
  assert.deepEqual(getInstantXSpellData({ system: { duration: holyTree.duration } }),
    { durationScale: "hours", initialDuration: null, remainingDuration: null, outOfCombat: null },
    "hours stay outside automatic combat countdown");

  assert.deepEqual(getInstantXSpellData({ system: { duration: "Instant / Permanent" } }),
    { durationScale: "permanent", initialDuration: null, remainingDuration: null, outOfCombat: null },
    "Instant/Permanent maps to the permanent manual scale");
  assert.deepEqual(getInstantXSpellData({ system: { duration: "Instant/Various (see below)" } }),
    { durationScale: "other", initialDuration: null, remainingDuration: null, outOfCombat: null },
    "unresolvable Instant/X stays GM-managed other");

  // Fractional normalized rounds: never rounded — GM-managed other.
  const fractional = { system: { duration: "Instant / 5 seconds" } };
  assert.equal(getSpellDurationData(fractional).persistent.nonIntegerRounds, true, "5 seconds = 0.5 rounds is flagged");
  assert.deepEqual(getInstantXSpellData(fractional),
    { durationScale: "other", initialDuration: null, remainingDuration: null, outOfCombat: null },
    "fractional rounds cannot drive the integer counter: GM-managed, never rounded");

  // Authored rounds/turns keep the D4 skip out of combat (existing pin).
  assert.deepEqual(getInstantXSpellData({ system: { duration: "Instant/3 rounds" } }),
    { durationScale: "rounds", initialDuration: 3, remainingDuration: 3, outOfCombat: null });
  assert.deepEqual(getInstantXSpellData({ system: { duration: "Instant/3 turns" } }),
    { durationScale: "turns", initialDuration: 3, remainingDuration: 3, outOfCombat: null });

  // Pure Instant and non-instant spells have no persistent mapping.
  assert.equal(getInstantXSpellData({ system: { duration: "Instant" } }), null);
  const holography = byName("Holography");
  assert.ok(holography, "Holography is in the corpus");
  assert.equal(String(holography.duration).trim(), "3 minutes", "Holography carries no parenthetical");
  assert.equal(isInstantXSpell({ system: { duration: holography.duration } }), false, "Holography is NOT Instant/X");
  assert.equal(getInstantXSpellData({ system: { duration: holography.duration } }), null);
  assert.deepEqual(getSpellDurationData({ system: { duration: holography.duration } }).persistent,
    { scale: "rounds", amount: 18, unit: "rounds", sourceUnit: "minutes", sourceAmount: 3, nonIntegerRounds: false },
    "Holography: mathematically derived 3 minutes = 18 rounds in durationData");
  record("spot mappings: Daemon Buster 1 round, minutes counted, hours/permanent manual, fractional → other, Holography data");
}

// ── 5. Identity: leading ⏩/△ never affect family/rank (†/‡ preserved) ──────

{
  assert.deepEqual(getInstantXSpellIdentity({ name: "⏩△Wing Flyer II" }), { family: "Wing Flyer", rank: 2 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "△Take the Lead I" }), { family: "Take the Lead", rank: 1 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "⏩Take The Lead II" }), { family: "Take The Lead", rank: 2 });
  // The comparison key of the markered and clean spellings is the same.
  assert.equal(normalizeSw25FamilyKey(getInstantXSpellIdentity({ name: "△Take the Lead I" }).family),
    normalizeSw25FamilyKey(getInstantXSpellIdentity({ name: "Take the Lead" }).family),
    "markered and clean names share one stacking identity");
  // †/‡ are NOT action markers: they stay in the family.
  assert.deepEqual(getInstantXSpellIdentity({ name: "‡Fear" }), { family: "‡Fear", rank: 0 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "⏩Healing Bullet" }), { family: "Healing Bullet", rank: 0 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "Healing Bullet" }), { family: "Healing Bullet", rank: 0 });
  // A stored integer rank still wins over the name numeral.
  assert.deepEqual(getInstantXSpellIdentity({ name: "⏩△Wing Flyer II", system: { rank: 6 } }), { family: "Wing Flyer", rank: 6 });
  record("identity: leading ⏩/△ stripped from the family, †/‡ preserved, rank rules unchanged");
}

// ── 6. normalizeSw25FamilyKey: leading action markers are never identity ────

{
  assert.equal(normalizeSw25FamilyKey("⏩Healing Bullet"), "healing bullet");
  assert.equal(normalizeSw25FamilyKey("△Take the Lead"), "take the lead");
  assert.equal(normalizeSw25FamilyKey("⏩△Wing Flyer"), "wing flyer");
  assert.equal(normalizeSw25FamilyKey("⏩△ Wing Flyer"), "wing flyer", "whitespace left by the marker run is consumed");
  assert.equal(normalizeSw25FamilyKey("⏩Healing Bullet"), normalizeSw25FamilyKey("Healing Bullet"));
  // †/‡ stay part of the identity.
  assert.equal(normalizeSw25FamilyKey("‡Fear"), "‡fear");
  assert.notEqual(normalizeSw25FamilyKey("‡Fear"), normalizeSw25FamilyKey("Fear"));
  // Established normalizations unchanged.
  assert.equal(normalizeSw25FamilyKey("PROTECTION"), "protection");
  assert.equal(normalizeSw25FamilyKey("  protection  "), "protection");
  assert.equal(normalizeSw25FamilyKey("Ｐｒｏｔｅｃｔｉｏｎ"), "protection");
  // Idempotence and invalid inputs.
  const key = normalizeSw25FamilyKey("⏩△Wing Flyer");
  assert.equal(normalizeSw25FamilyKey(key), key, "normalizing an already-normalized key is a no-op");
  assert.equal(normalizeSw25FamilyKey(null), null);
  assert.equal(normalizeSw25FamilyKey(42), null);
  assert.equal(normalizeSw25FamilyKey(""), "");
  record("normalizeSw25FamilyKey: leading ⏩/△ stripped, †/‡ kept, DEC-1 normalization otherwise unchanged");
}

// ── 7. Instant/X immediate handlers resolve through canonical names ─────────

{
  const target = { id: "target-1", uuid: "Actor.target-1", name: "Target" };
  const spell = name => ({ type: "spell", name, uuid: `Item.${name}`, system: { duration: "Instant/3 rounds" } });
  const silenceWarn = () => { console.warn = (...args) => { consoleWarnings.push(args.map(String).join(" ")); }; };
  const restoreWarn = () => { console.warn = originalWarn; };

  // A handler registered under a MARKERED name is found by the clean name…
  let firstCalls = 0;
  const unregisterFirst = registerSw25InstantXImmediateHandler("⏩Test Marker Spell", async () => {
    firstCalls++;
    return { kind: "test-first" };
  });
  try {
    silenceWarn();
    for (const lookupName of ["⏩Test Marker Spell", "Test Marker Spell"]) {
      const components = await resolveCastImmediateComponents({
        spell: spell(lookupName),
        targetResults: [{ target, resisted: false }]
      });
      assert.equal(components.length, 1, `handler resolves for "${lookupName}"`);
      assert.equal(components[0].kind, "test-first");
    }
    assert.equal(firstCalls, 2);
  } finally {
    unregisterFirst();
    restoreWarn();
  }

  // …and one registered under the CLEAN name is found by the markered spelling.
  let secondCalls = 0;
  const unregisterSecond = registerSw25InstantXImmediateHandler("Clean Name Spell", async () => {
    secondCalls++;
    return { kind: "test-second" };
  });
  try {
    silenceWarn();
    const components = await resolveCastImmediateComponents({
      spell: spell("⏩Clean Name Spell"),
      targetResults: [{ target, resisted: false }]
    });
    assert.equal(components.length, 1);
    assert.equal(secondCalls, 1);
  } finally {
    unregisterSecond();
    restoreWarn();
  }

  // Unregistered spells still warn and resolve nothing (existing contract).
  silenceWarn();
  try {
    const none = await resolveCastImmediateComponents({
      spell: spell("⏩Unregistered Spell"),
      targetResults: [{ target, resisted: false }]
    });
    assert.deepEqual(none, []);
    assert.ok(consoleWarnings.some(line => line.includes("no explicit Instant/X immediate handler")));
  } finally {
    restoreWarn();
  }
  record("handler registry: canonical keys both directions, unregistered contract unchanged");
}

// ── 8. Combat Preparation ledger: canonical names, once per spell ───────────

{
  const makeActor = names => ({
    flags: {},
    getFlag(scope, key) { return this.flags[`${scope}:${key}`] ?? null; },
    async setFlag(scope, key, value) { this.flags[`${scope}:${key}`] = value; }
  });
  const ledgerKey = "sw25-taka:combatPreparationCasts";
  const spell = name => ({ name, system: { combatPreparation: true } });

  // OLD-format ledger entry (raw markered lowercase, recorded before the
  // migration): a markered or clean spell name must still match it.
  game.combat = { id: "combat-1" };
  const oldLedgerActor = makeActor();
  oldLedgerActor.flags[ledgerKey] = { combatId: "combat-1", names: ["⏩ward sigil"] };
  assert.equal(spellAlreadyCastInCombatPreparation(oldLedgerActor, spell("△Ward Sigil")), true,
    "markered spell matches an old raw-marker ledger entry");
  assert.equal(spellAlreadyCastInCombatPreparation(oldLedgerActor, spell("Ward Sigil")), true,
    "clean spell matches an old raw-marker ledger entry");
  assert.equal(spellAlreadyCastInCombatPreparation(oldLedgerActor, spell("Other Ward")), false,
    "a different spell is not blocked");

  // NEW-format ledger entry (canonical): markered spell names still match.
  const newLedgerActor = makeActor();
  newLedgerActor.flags[ledgerKey] = { combatId: "combat-1", names: ["ward sigil"] };
  assert.equal(spellAlreadyCastInCombatPreparation(newLedgerActor, spell("△Ward Sigil")), true,
    "markered spell matches a canonical ledger entry");

  // A ledger from a DIFFERENT combat never applies.
  const staleCombatActor = makeActor();
  staleCombatActor.flags[ledgerKey] = { combatId: "combat-2", names: ["ward sigil"] };
  assert.equal(spellAlreadyCastInCombatPreparation(staleCombatActor, spell("△Ward Sigil")), false,
    "ledger entries from another combat do not apply");

  // Without a combat there is no preparation window at all.
  game.combat = null;
  assert.equal(spellAlreadyCastInCombatPreparation(newLedgerActor, spell("△Ward Sigil")), false,
    "no combat → no shared preparation window");
  record("combat preparation ledger: canonical matching across old/new ledger formats, combat-scoped");
}

// ── 9. regenerationSpellData: marker-tolerant special matching ──────────────

{
  const spec = regenerationSpellData({ name: "⏩Reproducer/Bloody Petal", system: {} });
  assert.deepEqual(spec, { sourceKey: "reproducer-bloody-petal", healing: 5, turns: 6 },
    "a markered special spell name still resolves its regeneration spec");
  assert.deepEqual(regenerationSpellData({ name: "Bloody Petal", system: {} }),
    { sourceKey: "reproducer-bloody-petal", healing: 5, turns: 6 });
  assert.ok(!regenerationSpellData({ name: "⏩Fire Bolt", system: {} }), "unrelated spells resolve nothing");
  record("regenerationSpellData: special matching tolerates leading action markers");
}

console.log(`spell-consumer-migration.test.mjs: ${passed} groups passed.`);
