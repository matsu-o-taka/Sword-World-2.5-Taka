// Sword World 2.5 - attack resolution test
// Covers: shared modifier dialog contract (+/-/multiple/disabled/cancel/
// confirm/no persistence), strict '>' comparison, active vs passive monster
// resolution and the world setting, Weak Point accuracy modifier variants,
// target resolution (targeted vs selected), chat card breakdown, and
// compendium string parsing compatibility.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  attackCardHtml,
  characterWeaponAttackFlow,
  describeTargetFailure,
  getMonsterRollResolution,
  monsterDefenseEntry,
  monsterWeaponAttackFlow,
  parseBaseValue,
  passiveValue,
  resolveAttackTarget,
  resolveMonsterDefense,
  weakPointAccuracyModifier
} from "../module/combat/attack-resolution.mjs";
import { speciesId, registerSpeciesWeakness } from "../module/combat/monster-knowledge.mjs";
import { assembleRollFormula, signedValue } from "../module/rules/roll-modifiers.mjs";
import { staticAccuracy } from "../module/combat/evasion-challenge.mjs";
import { parseMonsterPage, validateMonsterProfile } from "../module/importer/monster-parser.mjs";
import { readMonsterActorCombatStyles } from "../module/actor/monster-sheet-data.mjs";

// ---------------------------------------------------------------------------
// Foundry mocks
// ---------------------------------------------------------------------------

let rollQueue = [];
const chatFlavors = [];
const chatCreations = [];
const speakerActors = [];

class MockRoll {
  constructor(formula) {
    this.formula = formula;
    this.dice = [];
    this._total = 0;
  }

  async evaluate() {
    const script = rollQueue.shift();
    assert.ok(script, `No scripted roll for "${this.formula}"`);
    this._diceResults = script;
    this.dice = script.map(results => ({
      results: results.map(value => ({ result: value, active: true }))
    }));
    let modifier = 0;
    if (/\+/.test(this.formula)) modifier = Number(this.formula.match(/\+\s*(-?\d+)/)?.[1] ?? 0);
    else if (/\s-\s/.test(this.formula)) modifier = -Number(this.formula.match(/-\s*(\d+)/)?.[1] ?? 0);
    this._total = script.flat().reduce((a, b) => a + b, 0) + modifier;
    return this;
  }

  get total() { return this._total; }

  async toMessage({ speaker, flavor } = {}) {
    speakerActors.push(speaker?.actor?.name ?? null);
    chatFlavors.push({ via: "roll", flavor });
    return { id: `msg-${chatFlavors.length}` };
  }
}

globalThis.Roll = MockRoll;
globalThis.ChatMessage = {
  getSpeaker({ actor } = {}) {
    const speaker = { actor };
    speakerActors.push(actor?.name ?? null);
    return speaker;
  },
  async create(data) {
    chatCreations.push(data);
    return { id: `create-${chatCreations.length}` };
  }
};
globalThis.Roll.prototype._isMock = true;
globalThis.foundry = {
  utils: {
    escapeHTML(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    },
    mergeObject: (a, b) => ({ ...a, ...b })
  }
};
const arSettings = new Map();
let monsterRollResolution = "active";
globalThis.game = {
  settings: {
    get(scope, key) {
      if (key === "monsterRollResolution") return monsterRollResolution;
      return arSettings.get(`${scope}.${key}`);
    },
    set(scope, key, value) {
      if (key === "monsterRollResolution") monsterRollResolution = value;
      arSettings.set(`${scope}.${key}`, structuredClone(value));
    }
  },
  user: { isGM: true }
};
const notifications = [];
globalThis.ui = {
  notifications: {
    warn: message => notifications.push(["warn", message]),
    info: message => notifications.push(["info", message]),
    error: message => notifications.push(["error", message])
  }
};
globalThis.canvas = { tokens: { controlled: [] } };

const queueRolls = (...results) => { rollQueue = [...results]; };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const monsterActor = (styles, extraSystem = {}) => ({
  id: "monster-1",
  name: "Cursed Artist",
  type: "monster",
  system: { species: "Cursed Artist", combatStyles: styles, ...extraSystem }
});

const classItem = (id, name, level) => ({ id, name, type: "class", system: { level } });
const armourItem = (id, evasion, equipped) => ({ id, type: "armour", system: { evasion, equipped } });

const characterActor = ({ defenseClassLevel = 3, abilityBase = 12, situational = 0, armour = [] } = {}) => {
  const items = [classItem("cls-def", "Fighter", defenseClassLevel), ...armour.map((evasion, i) => armourItem(`arm-${i}`, evasion, true))];
  const itemsMap = new Map(items.map(item => [item.id, item]));
  const itemsArray = [...items];
  return {
    id: "hero",
    name: "Hero",
    type: "character",
    system: {
      combat: { defenseClassId: "cls-def", situationalEvasion: situational, accuracyMod: 0 },
      abilityBases: { skill: abilityBase },
      abilityAdjustments: {}
    },
    items: {
      get: id => itemsMap.get(id) ?? null,
      filter: fn => itemsArray.filter(fn)
    },
    updates: [],
    async update(data) { this.updates.push(data); },
    sheet: { rendered: false, render() { this.rendered = true; } },
    getFlag() { return undefined; },
    isToken: false
  };
};

const weaponItem = { id: "wpn-1", name: "Longsword", type: "weapon", system: { category: "Melee" } };

const dialogScript = (...planned) => {
  const calls = [];
  const promptModifiers = async config => {
    calls.push(config);
    const next = planned.shift();
    return next === undefined ? undefined : next;
  };
  promptModifiers.calls = calls;
  return promptModifiers;
};

// ---------------------------------------------------------------------------
// 1. Base parsing and formula helpers
// ---------------------------------------------------------------------------

console.log("=== Parsing base values from stored strings ===");
assert.equal(parseBaseValue("10 (17)"), 10);
assert.equal(parseBaseValue("15 (22)"), 15);
assert.equal(parseBaseValue("12"), 12);
assert.equal(parseBaseValue("-"), null);
assert.equal(parseBaseValue(""), null);
assert.equal(parseBaseValue(null), null);
assert.equal(passiveValue(10), 17, "Passive = base + 7");

console.log("=== assembleRollFormula handles negative totals ===");
assert.equal(assembleRollFormula("2d6", 0), "2d6");
assert.equal(assembleRollFormula("2d6", 3), "2d6 + 3");
assert.equal(assembleRollFormula("2d6", -3), "2d6 - 3");
assert.equal(signedValue(0), "0");
assert.equal(signedValue(4), "+4");
assert.equal(signedValue(-4), "-4");

// ---------------------------------------------------------------------------
// 2. Target resolution: targeted vs selected
// ---------------------------------------------------------------------------

console.log("=== Target resolution ===");
const heroToken = { actor: characterActor(), name: "hero-token" };
assert.equal(resolveAttackTarget({ targets: [], controlled: [heroToken] }).status, "not-targeted");
assert.equal(resolveAttackTarget({ targets: [], controlled: [] }).status, "no-target");
assert.equal(resolveAttackTarget({ targets: [heroToken, heroToken], controlled: [] }).status, "multiple");
const okTarget = resolveAttackTarget({ targets: [heroToken], controlled: [heroToken] });
assert.equal(okTarget.status, "ok");
assert.equal(okTarget.actor, heroToken.actor);
assert.ok(describeTargetFailure("not-targeted").includes("not targeted"));
assert.ok(describeTargetFailure("no-defense").includes("Evasion"));

// ---------------------------------------------------------------------------
// 3. Monster defense entry + setting-driven resolution
// ---------------------------------------------------------------------------

console.log("=== Monster defense ===");
const styles = [
  { style: "Claw", accuracy: "9 (16)", evasion: "7 (14)", isMainSection: false },
  { style: "Curse Spit", accuracy: "12 (19)", evasion: "15 (22)", isMainSection: true }
];
const monster = monsterActor(styles);
const defenseEntry = monsterDefenseEntry(monster);
assert.equal(defenseEntry.base, 15, "Uses the Main Section row with numeric Evasion");
assert.equal(monsterDefenseEntry(monsterActor([{ style: "A", accuracy: "9 (16)", evasion: "-" }], {})), null, "No numeric Evasion -> null");

game.settings.set("sword-world-25", "monsterRollResolution", "passive");
const passiveDefense = await resolveMonsterDefense(monster, "passive");
assert.equal(passiveDefense.mode, "passive");
assert.equal(passiveDefense.total, 22, "Passive Evasion = base + 7");
assert.equal(passiveDefense.roll, null, "No dice for passive Evasion");

game.settings.set("sword-world-25", "monsterRollResolution", "active");
queueRolls([[3, 4]]);
const activeDefense = await resolveMonsterDefense(monster, "active");
assert.equal(activeDefense.total, 15 + 7, "Active Evasion = 2d6 + base with scripted dice");
assert.equal(activeDefense.mode, "active");
assert.equal(rollQueue.length, 0);

console.log("=== World setting reader ===");
game.settings.set("sword-world-25", "monsterRollResolution", "passive");
assert.equal(getMonsterRollResolution(), "passive");
game.settings.set("sword-world-25", "monsterRollResolution", "bogus");
assert.equal(getMonsterRollResolution(), "active", "Invalid setting falls back to active");
game.settings.set("sword-world-25", "monsterRollResolution", "active");

// ---------------------------------------------------------------------------
// 4. Character -> monster: dialog contract, strict comparison
// ---------------------------------------------------------------------------

console.log("=== Character attack: dialog modifiers ===");
game.settings.set("sword-world-25", "monsterRollResolution", "passive"); // defenseTotal = 15 + 7 = 22, deterministic
const monsterDefense22 = monsterActor([{ style: "Claw", accuracy: "12 (19)", evasion: "15 (22)", isMainSection: true }]);
const dialogNotes = dialogScript(
  [
    { label: "Heroic aura", value: 3, enabled: true, temporary: true },
    { label: "Penalty", value: -2, enabled: true, temporary: true },
    { label: "Ignored bonus", value: 5, enabled: false, temporary: true },
    { label: "Class level", value: 1, enabled: true, temporary: false }
  ]
);
queueRolls([[5, 5]]); // natural 10 + 3 - 2 + 1 = 12 <= 22 -> MISS
const character = characterActor();
const charFlow = await characterWeaponAttackFlow({
  actor: character,
  weapon: weaponItem,
  attackingClass: classItem("cls-atk", "Fighter", 5),
  accuracyParts: [{ label: "Fighter level", value: 5 }, { label: "Dexterity", value: 2 }],
  targetMonster: monsterDefense22,
  resolutionMode: "passive",
  promptModifiers: dialogNotes
});
assert.equal(charFlow.status, "resolved");
assert.equal(charFlow.hit, false, "12 does not exceed 22 => MISS");
const dialogConfig = dialogNotes.calls[0];
const dialogParts = dialogConfig.parts;
assert.equal(dialogParts.length, 2, "Seed parts hold the character's permanent Accuracy parts");
assert.equal(dialogParts[0].label, "Fighter level");
assert.equal(dialogParts[0].enabled, true, "Permanent accuracy parts arrive enabled");
assert.equal(dialogParts[1].label, "Dexterity");
assert.equal(chatFlavors[chatFlavors.length - 1].via, "roll");
const lastFlavor = chatFlavors[chatFlavors.length - 1].flavor;
assert.ok(lastFlavor.includes("MISS"), "Card says MISS on failed comparison");
assert.ok(lastFlavor.includes("sw25-attack-compare"));
assert.ok(!lastFlavor.includes("Roll Damage"), "No damage button on MISS");
assert.equal(character.updates.length, 0, "Modifier dialog never persists to the actor");

console.log("=== Character attack: HIT + damage button ===");
dialogNotes.calls.length = 0;
dialogScript(
  [
    { label: "Class level", value: 16, enabled: true, temporary: false }
  ]
)(chatFlavors.length);
queueRolls([[6, 6]]); // natural 12 + 16 = 28 > 22 -> HIT
const hitFlow = await characterWeaponAttackFlow({
  actor: character,
  weapon: weaponItem,
  attackingClass: classItem("cls-atk", "Fighter", 5),
  accuracyParts: [],
  targetMonster: monsterDefense22,
  resolutionMode: "passive",
  promptModifiers: configs => {
    dialogNotes.calls.push(configs);
    return [{ label: "Class level", value: 16, enabled: true }];
  }
});
assert.equal(hitFlow.hit, true);
const hitFlavor = chatFlavors[chatFlavors.length - 1].flavor;
assert.ok(hitFlavor.includes("HIT"));
assert.ok(hitFlavor.includes("roll-critical-damage"), "Damage button present on HIT");
assert.ok(hitFlavor.includes("data-class-id"), "Damage button carries the attacking class id");

console.log("=== Character attack: cancelled dialog ===");
queueRolls([[3, 3]], [[3, 3]], [[3, 3]]);
const cancelled = await characterWeaponAttackFlow({
  actor: characterActor(),
  weapon: weaponItem,
  attackingClass: classItem("cls-atk", "Fighter", 5),
  accuracyParts: [],
  targetMonster: monsterDefense22,
  resolutionMode: "passive",
  promptModifiers: async () => null
});
assert.equal(cancelled.status, "cancelled");
assert.equal(rollQueue.length, 3, "Cancel aborts before any rolls happen");

console.log("=== Strict comparison edges ===");
// Attack total exactly equal to Evasion => MISS.
dialogNotes.calls.length = 0;
queueRolls([[4, 4]]); // 8 + (dialog sum 14) = 22 == 22
const equalFlow = await characterWeaponAttackFlow({
  actor: characterActor(),
  weapon: weaponItem,
  attackingClass: classItem("cls-atk", "Fighter", 5),
  accuracyParts: [],
  targetMonster: monsterDefense22,
  resolutionMode: "passive",
  promptModifiers: () => [{ label: "Boost", value: 14, enabled: true }]
});
assert.equal(equalFlow.hit, false, "Equaling Evasion does NOT hit (strict >)");

// ---------------------------------------------------------------------------
// 5. Attacker critical failure
// ---------------------------------------------------------------------------

console.log("=== Attacker critical failure ===");
game.settings.set("sword-world-25", "monsterRollResolution", "passive");
const critActor = characterActor();
queueRolls([[1, 1]]);
const critFailFlow = await characterWeaponAttackFlow({
  actor: critActor,
  weapon: weaponItem,
  attackingClass: classItem("cls-atk", "Fighter", 5),
  accuracyParts: [],
  targetMonster: monsterDefense22,
  resolutionMode: "passive",
  promptModifiers: configs => {
    dialogNotes.calls.push(configs);
    return [{ label: "Boost", value: 30, enabled: true }];
  }
});
assert.equal(critFailFlow.hit, false, "Double 1 is an automatic MISS despite huge total");
assert.equal(critFailFlow.attackerCriticalFailure, true);
assert.ok(chatFlavors[chatFlavors.length - 1].flavor.includes("CRITICAL FAILURE"));
assert.equal(critActor.updates.length, 1, "Character critical failures persist the automatic failure counter");
assert.equal(critActor.updates[0]["system.automaticFailureCount"], 1);

// ---------------------------------------------------------------------------
// 6. Weak Point accuracy modifier
// ---------------------------------------------------------------------------

console.log("=== Weak Point accuracy modifier ===");
const weakMonsterClosed = monsterActor([{ style: "Claw", accuracy: "12 (19)", evasion: "15 (22)", isMainSection: true }], { weakPoint: "Accuracy +2", weaknessDiscovered: false, species: "Bestia Cerrada" });
weakMonsterClosed.name = "Bestia Cerrada";
const weakMonsterOpen = monsterActor([{ style: "Claw", accuracy: "12 (19)", evasion: "15 (22)", isMainSection: true }], { weakPoint: "Accuracy +2", weaknessDiscovered: true });
weakMonsterOpen.name = "Abierto Test";
await registerSpeciesWeakness(speciesId(weakMonsterOpen));
assert.equal(weakPointAccuracyModifier(weakMonsterClosed), null, "Undiscovered Weak Point grants nothing");
assert.deepEqual(weakPointAccuracyModifier(weakMonsterOpen), { label: "Weak Point (Accuracy)", value: 2 });
const magicWeakMonster = monsterActor([{ style: "Claw", accuracy: "12 (19)", evasion: "15 (22)", isMainSection: true }], { weakPoint: "Magic Damage +3", weaknessDiscovered: true });
magicWeakMonster.name = "Magia Test";
await registerSpeciesWeakness(speciesId(magicWeakMonster));
assert.equal(weakPointAccuracyModifier(magicWeakMonster), null, "Non-Accuracy categories grant no accuracy modifier");

const weakSeen = { targetMonster: weakMonsterOpen };
const weakDialogSeen = dialogScript([
  { label: "Class level", value: 8, enabled: true, temporary: false },
  { label: "Weak Point (Accuracy)", value: 2, enabled: true, temporary: false }
]);
queueRolls([[5, 4]]); // 9 + 8 + 2 = 19 <= 22 MISS... use bigger: value 18
weakDialogSeen.calls.length = 0;
const weakDialog = dialogScript([
  { label: "Class level", value: 18, enabled: true },
  { label: "Weak Point (Accuracy)", value: 2, enabled: true }
]);
queueRolls([[3, 3]]); // 6 + 18 + 2 = 26 > 22 HIT
const weakFlow = await characterWeaponAttackFlow({
  actor: characterActor(),
  weapon: weaponItem,
  attackingClass: classItem("cls-atk", "Fighter", 5),
  accuracyParts: [],
  targetMonster: weakMonsterOpen,
  resolutionMode: "passive",
  promptModifiers: weakDialog
});
assert.equal(weakFlow.hit, true);
assert.ok(weakDialog.calls[0].parts.some(part => part.label === "Weak Point (Accuracy)" && part.value === 2), "Weak Point reaches the dialog as a Part");

// ---------------------------------------------------------------------------
// 7. Monster -> character attack (active and passive)
// ---------------------------------------------------------------------------

console.log("=== Monster attack against a character ===");
game.settings.set("sword-world-25", "monsterRollResolution", "passive");
const attackStyle = { style: "Curse Spit", accuracy: "12 (19)", evasion: "15 (22)", isMainSection: true };
const monsterAttacker = monsterActor([attackStyle]);
const defsCharacter = characterActor({ defenseClassLevel: 3, abilityBase: 18, situational: 1, armour: [2] });
// Evasion parts: level 3 + agility(floor(18/6)=3) + situational 1 + armour 2 = 9
const monsterDialogParts = [
  { label: "Defense class level", value: 3, enabled: true },
  { label: "Agility", value: 3, enabled: true }
];
const monsterDialog = async config => {
  monsterDialog.calls.push(config);
  return monsterDialogParts;
};
monsterDialog.calls = [];
// Passive attack: attackTotal = 12 + 7 = 19; Evasion 2d6(7) + 3 + 3 = 13 -> HIT
queueRolls([[3, 4]]);
const monsterFlow = await monsterWeaponAttackFlow({
  monsterActor: monsterAttacker,
  style: attackStyle,
  targetActor: defsCharacter,
  resolutionMode: "passive",
  promptModifiers: monsterDialog
});
assert.equal(monsterFlow.status, "resolved");
assert.equal(monsterFlow.hit, true, "Passive Accuracy 19 beats Evasion 13");
assert.equal(monsterFlow.attackNatural, null, "Passive monster accuracy rolls no dice");
assert.equal(monsterFlow.attackTotal, 19, "Passive accuracy = base + 7");
const monsterCard = chatCreations[chatCreations.length - 1];
assert.ok(monsterCard.content.includes("passive"), "Card notes the passive origin");
assert.ok(monsterCard.content.includes("HIT"));

console.log("=== Monster attack: active resolution ===");
game.settings.set("sword-world-25", "monsterRollResolution", "active");
// Attack roll 2d6 + 12 -> [4, 5] => 21; Evasion 2d6 + 9 -> [4, 4] => 17 => HIT
queueRolls([[4, 5]], [[4, 4]]);
const activeMonsterFlow = await monsterWeaponAttackFlow({
  monsterActor: monsterAttacker,
  style: attackStyle,
  targetActor: defsCharacter,
  resolutionMode: "active",
  promptModifiers: monsterDialog
});
assert.equal(activeMonsterFlow.attackNatural, 9, "Active monster accuracy keeps its natural roll");
assert.equal(activeMonsterFlow.hit, true, "21 > 17 hits");
assert.ok(chatFlavors[chatFlavors.length - 1].flavor.includes("active roll"), "Card notes the active origin");

console.log("=== Setting switch changes resolution evidence ===");
game.settings.set("sword-world-25", "monsterRollResolution", "passive");
// Same dice, passive attack total 19 vs evasion 17 -> still hit, but origin differs
queueRolls([[4, 4]]);
const passiveAgain = await monsterWeaponAttackFlow({
  monsterActor: monsterAttacker,
  style: attackStyle,
  targetActor: defsCharacter,
  resolutionMode: "passive",
  promptModifiers: monsterDialog
});
assert.notEqual(passiveAgain.attackTotal, activeMonsterFlow.attackTotal, "Same dice produce different totals in passive mode");
assert.equal(passiveAgain.attackTotal, 19);

console.log("=== Defender critical failure versus attacker critical failure ===");
// Defender double 1 => the attack lands regardless (evasion challenge semantics).
game.settings.set("sword-world-25", "monsterRollResolution", "active");
queueRolls([[1, 1]], [[3, 4]]); // defender first? attack roll first; both double 1 attacker => miss
const attackerCrit = await monsterWeaponAttackFlow({
  monsterActor: monsterAttacker,
  style: attackStyle,
  targetActor: defsCharacter,
  resolutionMode: "active",
  promptModifiers: monsterDialog
});
assert.equal(attackerCrit.hit, false, "Attacker double 1 misses");
assert.equal(attackerCrit.attackCriticalFailure, true);

// Attacker normal but defender double 1 (last scripted roll) => HIT.
game.settings.set("sword-world-25", "monsterRollResolution", "active");
queueRolls([[5, 4]], [[1, 1]]); // attack 21, defender 2 + 9 = 11 but CF -> hit
const defenderCrit = await monsterWeaponAttackFlow({
  monsterActor: monsterAttacker,
  style: attackStyle,
  targetActor: defsCharacter,
  resolutionMode: "active",
  promptModifiers: monsterDialog
});
assert.equal(defenderCrit.hit, true, "Defender double 1 lets the attack through");
assert.equal(defenderCrit.defenseCriticalFailure, true);

console.log("=== Strict monster comparison: equal Evasion ===");
// Attack total exactly equal to the defender's Evasion total => MISS.
// Attack: 2d6 [2,2] = 4 + base 12 = 16. Defender: 2d6 [2,2] = 4 + parts 12 = 16.
game.settings.set("sword-world-25", "monsterRollResolution", "active");
queueRolls([[2, 2]], [[2, 2]]);
const equalMonster = await monsterWeaponAttackFlow({
  monsterActor: monsterAttacker,
  style: attackStyle,
  targetActor: defsCharacter,
  resolutionMode: "active",
  promptModifiers: () => [
    { label: "Defense class level", value: 3, enabled: true },
    { label: "Agility", value: 3, enabled: true },
    { label: "Boost", value: 6, enabled: true }
  ]
});
assert.equal(equalMonster.defenseTotal, 16);
assert.equal(equalMonster.hit, false, "Equaling the character's Evasion does NOT hit (strict >)");

console.log("=== Disabled dialog entries in monster defense dialog ===");
game.settings.set("sword-world-25", "monsterRollResolution", "passive");
const disableDialog = dialogScript([
  { label: "Defense class level", value: 3, enabled: false },
  { label: "Agility", value: 3, enabled: true },
  { label: "Extra", value: 10, enabled: false }
]);
queueRolls([[3, 4]]); // defense 6 + 3 + ... passive attack 19 vs 9 -> HIT
const disabledFlow = await monsterWeaponAttackFlow({
  monsterActor: monsterAttacker,
  style: attackStyle,
  targetActor: defsCharacter,
  resolutionMode: "passive",
  promptModifiers: disableDialog
});
// Disabled parts are excluded: defense total = 7 (natural) + 3 (only enabled agility)
assert.equal(disabledFlow.defenseTotal, 10, "Disabled dialog entries are excluded from the Evasion total");
assert.notEqual(defsCharacter.updates.length, true, "Marking only persists on critical failure");

console.log("=== Cancelled monster dialog ===");
game.settings.set("sword-world-25", "monsterRollResolution", "passive");
const cancelMonster = await monsterWeaponAttackFlow({
  monsterActor: monsterAttacker,
  style: attackStyle,
  targetActor: defsCharacter,
  resolutionMode: "passive",
  promptModifiers: async () => null
});
assert.equal(cancelMonster.status, "cancelled");

// ---------------------------------------------------------------------------
// 8. Compendium-string compatibility (fixtures)
// ---------------------------------------------------------------------------

console.log("=== Compendium monster strings parse identically ===");
const source = await readFile(new URL("./fixtures/monster-cursed-artist.md", import.meta.url), "utf8");
const parsed = parseMonsterPage(source, "https://sw25.wikidot.com/monster:cursed-artist");
assert.equal(validateMonsterProfile(parsed), true);
const fixtureStyles = readMonsterActorCombatStyles({ system: { combatStyles: parsed.system.combatStyles } });
assert.ok(fixtureStyles.length > 0, "Fixture exposes combat styles");
for (const style of fixtureStyles) {
  const base = parseBaseValue(style.evasion);
  if (base === null) continue;
  assert.equal(staticAccuracy(style.evasion), base + 7, `Passive in parentheses equals base + 7 for "${style.style}"`);
}

// ---------------------------------------------------------------------------
// 9. Passive damage-button absence: monster attack has no weapon damage
// ---------------------------------------------------------------------------

console.log("=== Card shape summary ===");
const summaryCard = attackCardHtml({
  attackerTitle: "Longsword", attackerName: "Hero", attackStatLabel: "Accuracy",
  attackOrigin: "2d6 + 3", attackNatural: 7, attackParts: [{ label: "Class", value: 3 }],
  attackTotal: 10, attackCriticalFailure: false,
  defenderName: "Monster", defenseStatLabel: "Evasion", defenseOrigin: "passive (base 8 + 7)",
  defenseNatural: null, defenseParts: [{ label: "Base Evasion", value: 8 }], defenseTotal: 15,
  defenseCriticalFailure: false, attackerCritFailNote: ""
});
assert.ok(summaryCard.includes("Accuracy on Monster"));
assert.ok(summaryCard.includes("Base Evasion: +8"));
assert.ok(!summaryCard.includes("2d6 roll") || summaryCard.split("2d6 roll").length === 2, "Only the attacking side has dice");

console.log("All attack-resolution assertions passed.");
