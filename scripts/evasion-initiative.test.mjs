import assert from "node:assert/strict";
import { isWarriorClass } from "../module/rules/weapon-damage.mjs";
import { playerInitiativeModifier } from "../module/combat/side-initiative.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const featNameKey = value => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const classItem = (id, name, level, classType = "") => ({
  id,
  name,
  type: "class",
  system: { level, classType }
});

const featItem = (id, name) => ({
  id,
  name,
  type: "feat",
  system: {}
});

const makeActor = (items = [], combat = {}) => {
  const itemsMap = new Map(items.map(i => [i.id, i]));
  const itemsArray = [...items];
  return {
    id: "actor-test",
    name: "Test Actor",
    type: "character",
    system: { combat },
    items: {
      get(id) { return itemsMap.get(id) || null; },
      filter(fn) { return itemsArray.filter(fn); },
      find(fn) { return itemsArray.find(fn); }
    },
    getFlag() { return undefined; }
  };
};

// ---------------------------------------------------------------------------
// 1. Marksman is a warrior-class name (baseline)
// ---------------------------------------------------------------------------

console.log("=== Marksman baseline ===");
assert.equal(isWarriorClass(classItem("c-marksman", "Marksman", 5)), true, "Marksman matches warrior class names");
assert.equal(isWarriorClass(classItem("c-fighter", "Fighter", 3)), true, "Fighter is a warrior class");
assert.equal(isWarriorClass(classItem("c-sage", "Sage", 3)), false, "Sage is not a warrior class");

// ---------------------------------------------------------------------------
// 2. Archer's Grace feat detection by normalized name
// ---------------------------------------------------------------------------

console.log("=== Archer's Grace feat detection ===");
const ARCHERS_GRACE_FEAT = "Archer's Grace";
const expectedKey = featNameKey(ARCHERS_GRACE_FEAT);
assert.equal(expectedKey, "archersgrace", "Normalized key for Archer's Grace");

const actorWithFeat = makeActor([featItem("f-1", "Archer's Grace")]);
const actorWithoutFeat = makeActor([featItem("f-2", "Dodge")]);
const actorWithVariantFeat = makeActor([featItem("f-3", "archer's grace")]);

const hasFeat = (actor, name) => {
  const target = featNameKey(name);
  return (actor.items.filter(item => item.type === "feat") ?? []).some(item => featNameKey(item.name) === target);
};

assert.equal(hasFeat(actorWithFeat, ARCHERS_GRACE_FEAT), true, "Detects Archer's Grace feat");
assert.equal(hasFeat(actorWithoutFeat, ARCHERS_GRACE_FEAT), false, "Does not detect other feats as Archer's Grace");
assert.equal(hasFeat(actorWithVariantFeat, ARCHERS_GRACE_FEAT), true, "Normalized name match is case/punctuation insensitive");

// ---------------------------------------------------------------------------
// 3. Marksman filtering for Defensive Combat Stats
// ---------------------------------------------------------------------------

console.log("=== Marksman filtering for Evasion ===");

const warriorClassesFor = (actor, hasGrace) => {
  const all = actor.items.filter(isWarriorClass);
  return hasGrace
    ? all
    : all.filter(item => String(item.name ?? "").trim().toLowerCase() !== "marksman");
};

// Fighter-only actor: Marksman never appears (not present anyway)
const actorFighter = makeActor([classItem("c-fighter", "Fighter", 3)]);
const fighterChoices = warriorClassesFor(actorFighter, false);
assert.equal(fighterChoices.length, 1, "Fighter-only: one warrior class");
assert.equal(fighterChoices[0].name, "Fighter", "Fighter-only: choice is Fighter");

// Fighter + Marksman, no feat: Marksman excluded
const actorFighterMarksman = makeActor([
  classItem("c-fighter", "Fighter", 3),
  classItem("c-marksman", "Marksman", 5)
]);
const noGraceChoices = warriorClassesFor(actorFighterMarksman, false);
assert.equal(noGraceChoices.length, 1, "Fighter+Marksman without feat: Marksman excluded");
assert.equal(noGraceChoices[0].name, "Fighter", "Fighter+Marksman without feat: only Fighter");

// Fighter + Marksman, with feat: Marksman included
const actorWithGrace = makeActor([
  classItem("c-fighter", "Fighter", 3),
  classItem("c-marksman", "Marksman", 5),
  featItem("f-1", "Archer's Grace")
]);
const withGraceChoices = warriorClassesFor(actorWithGrace, true);
assert.equal(withGraceChoices.length, 2, "Fighter+Marksman with feat: both classes available");
assert.ok(withGraceChoices.some(c => c.name === "Fighter"), "Fighter present");
assert.ok(withGraceChoices.some(c => c.name === "Marksman"), "Marksman present when feat known");

// Marksman-only actor, no feat: no warrior classes for evasion
const actorMarksmanOnly = makeActor([classItem("c-marksman", "Marksman", 5)]);
const marksmanOnlyNoGrace = warriorClassesFor(actorMarksmanOnly, false);
assert.equal(marksmanOnlyNoGrace.length, 0, "Marksman-only without feat: no evasion-eligible classes");

// Marksman-only actor, with feat: Marksman available
const marksmanOnlyWithGrace = warriorClassesFor(actorMarksmanOnly, true);
assert.equal(marksmanOnlyWithGrace.length, 1, "Marksman-only with feat: Marksman available");
assert.equal(marksmanOnlyWithGrace[0].name, "Marksman");

// ---------------------------------------------------------------------------
// 4. Initiative Class auto-selection
// ---------------------------------------------------------------------------

console.log("=== Initiative Class selection ===");

const initiativeClassesFor = (classes) => classes.filter(item =>
  /^(scout|tactician)$/i.test(String(item.name ?? "").trim())
);

const selectInitiativeClass = (initiativeClasses, savedId) => {
  if (initiativeClasses.some(item => item.id === savedId)) return String(savedId);
  return String(initiativeClasses[0]?.id || "");
};

const initiativeLevelFor = (classes, selectedId) => {
  const item = classes.find(c => c.id === selectedId);
  return item ? Number(item.system.level ?? 0) : 0;
};

// Scout only
const actorScout = makeActor([classItem("c-scout", "Scout", 4)]);
const scoutClasses = initiativeClassesFor(actorScout.items.filter(i => i.type === "class"));
assert.equal(scoutClasses.length, 1, "Scout only: one initiative class");
const scoutSelected = selectInitiativeClass(scoutClasses, "");
assert.equal(scoutSelected, "c-scout", "Scout only: auto-selects Scout");
assert.equal(initiativeLevelFor(actorScout.items.filter(i => i.type === "class"), scoutSelected), 4, "Scout level is 4");

// Tactician only
const actorTactician = makeActor([classItem("c-tactician", "Tactician", 6)]);
const tacticianClasses = initiativeClassesFor(actorTactician.items.filter(i => i.type === "class"));
const tacticianSelected = selectInitiativeClass(tacticianClasses, "");
assert.equal(tacticianSelected, "c-tactician", "Tactician only: auto-selects Tactician");

// Both Scout and Tactician: higher level wins
const actorBoth = makeActor([
  classItem("c-scout", "Scout", 3),
  classItem("c-tactician", "Tactician", 7)
]);
const bothClasses = initiativeClassesFor(actorBoth.items.filter(i => i.type === "class"));
// context.classes is sorted by level desc, so filter preserves order
const bothSorted = [...bothClasses].sort((a, b) => Number(b.system.level ?? 0) - Number(a.system.level ?? 0));
const bothSelected = selectInitiativeClass(bothSorted, "");
assert.equal(bothSelected, "c-tactician", "Both: auto-selects higher-level Tactician (Lv7)");
assert.equal(initiativeLevelFor(actorBoth.items.filter(i => i.type === "class"), bothSelected), 7, "Tactician level is 7");

// Manual selection preserved when valid
const manualSelected = selectInitiativeClass(bothSorted, "c-scout");
assert.equal(manualSelected, "c-scout", "Manual Scout selection preserved");

// Fallback when saved class removed
const actorScoutOnly = makeActor([classItem("c-scout", "Scout", 2)]);
const scoutOnlyClasses = initiativeClassesFor(actorScoutOnly.items.filter(i => i.type === "class"));
const fallbackSelected = selectInitiativeClass(scoutOnlyClasses, "c-tactician");
assert.equal(fallbackSelected, "c-scout", "Stale Tactician selection falls back to Scout");

// No Scout or Tactician
const actorNone = makeActor([classItem("c-fighter", "Fighter", 3)]);
const noneClasses = initiativeClassesFor(actorNone.items.filter(i => i.type === "class"));
assert.equal(noneClasses.length, 0, "No Scout/Tactician: no initiative classes");
const noneSelected = selectInitiativeClass(noneClasses, "");
assert.equal(noneSelected, "", "No Scout/Tactician: no selection");

// ---------------------------------------------------------------------------
// 5. Initiative formula preserved
// ---------------------------------------------------------------------------

console.log("=== Initiative formula ===");

// playerInitiativeModifier(selectedLevel, 0, agilityMod, bonus)
// Formula: classLevel > 0 ? classLevel + agilityMod : 0, + bonus
assert.equal(playerInitiativeModifier(4, 0, 2, 1), 7, "Scout Lv4 + Agility +2 + Bonus +1 = 7");
assert.equal(playerInitiativeModifier(7, 0, 1, 0), 8, "Tactician Lv7 + Agility +1 = 8");
assert.equal(playerInitiativeModifier(0, 0, 3, 0), 0, "No class: initiative is 0 (ability modifier alone never added)");
assert.equal(playerInitiativeModifier(5, 0, 0, 2), 7, "Class Lv5 + Bonus +2 = 7");

// ---------------------------------------------------------------------------
console.log("\nAll evasion & initiative tests passed.");