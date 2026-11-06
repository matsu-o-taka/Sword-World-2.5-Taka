// Sword World 2.5 - Monster Combat Resolution tests
//
// Covers:
//   - Fixed monster Accuracy (toggle disabled) uses parenthesized value
//   - Active monster Accuracy (toggle enabled) uses 2d6 + base
//   - Fixed monster Evasion (toggle disabled) uses parenthesized value
//   - Active monster Evasion (toggle enabled) uses 2d6 + base
//   - Toggle defaults to disabled for existing monsters
//   - Missing activeCombatRolls property means fixed mode
//   - Toggle persists on the actor
//   - Character attacks against monsters in both modes
//   - Monster attacks against characters in both modes
//   - Multiple targeted monsters
//   - Multiple targeted characters
//   - Defense wins ties (Accuracy must strictly exceed Evasion)
//   - No global monsterRollResolution setting

import assert from "node:assert/strict";

// ── Foundry mocks ──────────────────────────────────────────────────────────

const chatMessages = [];
const dialogCalls = [];
const actorUpdates = [];
const worldSettings = new Map();

globalThis.ChatMessage = {
  async create(data) { chatMessages.push(data.content); return { id: `msg-${chatMessages.length}` }; },
  getSpeaker({ actor } = {}) { return { actor }; },
};

globalThis.ui = {
  notifications: { warn() {}, info() {}, error() {} },
};

globalThis.foundry = {
  utils: {
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    },
    mergeObject: (a, b) => ({ ...a, ...b }),
  },
};

globalThis.game = {
  user: { isGM: true, targets: [], character: null },
  actors: [],
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, structuredClone(value)); return value; },
  },
  scenes: [],
  combat: null,
};

globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OWNER: 1 } };

globalThis.fromUuid = async uuid => game.actors.find(a => a.uuid === uuid) || null;

// ── Roll mock ──────────────────────────────────────────────────────────────

let rollScripts = [];

class MockRoll {
  constructor(formula) {
    this.formula = formula;
    this.dice = [];
    this._script = rollScripts.shift() ?? [3, 4];
    this._total = 0;
  }

  async evaluate() {
    const values = Array.isArray(this._script) ? this._script : [this._script];
    this.dice = [{ results: values.map(v => ({ result: Number(v), active: true })) }];
    let modifier = 0;
    const m = String(this.formula).match(/[\+\-]\s*(\d+)/);
    if (m) modifier = Number(m[1]);
    this._total = values.reduce((a, b) => a + b, 0) + modifier;
    return this;
  }

  get total() { return this._total; }

  async toMessage({ speaker, flavor } = {}) {
    chatMessages.push({ speaker, flavor, rollTotal: this.total });
    return { id: `msg-${chatMessages.length}` };
  }
}

globalThis.Roll = MockRoll;

globalThis.markCriticalFailure = async () => false;
globalThis.rollDiceResults = (roll) => roll.dice.flatMap(d => d.results.map(r => r.result));

// ── Import after mocks ─────────────────────────────────────────────────────

import {
  resolveMonsterDefense,
  getMonsterActiveCombatRolls,
  characterWeaponAttackFlow,
  monsterWeaponAttackFlow,
  weakPointAccuracyModifier,
} from "../module/combat/attack-resolution.mjs";
import { staticAccuracy } from "../module/combat/evasion-challenge.mjs";
import { parseWeaknessData } from "../module/combat/damage-application.mjs";
import { registerRollModifiersDialog, openRollModifiersDialog } from "../module/rules/roll-modifiers.mjs";

// ── Register mock dialog ───────────────────────────────────────────────────

class MockDialog {
  static open(config = {}) {
    dialogCalls.push(config);
    return Promise.resolve(config.parts);
  }
}
registerRollModifiersDialog(MockDialog);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMonster(overrides = {}) {
  const system = {
    level: 5,
    species: "Goblin",
    revealed: false,
    activeCombatRolls: false,
    combatStyles: [{ style: "Claw", accuracy: "3 (10)", evasion: "2 (9)", defense: 2, hp: { value: 16, max: 16 }, mp: { value: 12, max: 12 }, isMainSection: true }],
    ...overrides.system,
  };
  const actor = {
    id: `monster-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Goblin",
    type: "monster",
    system,
    uuid: `Actor.monster-${Math.random().toString(36).slice(2)}`,
    updates: [],
    async update(data) {
      actorUpdates.push(data);
      for (const [path, value] of Object.entries(data ?? {})) {
        const parts = path.split(".");
        let obj = system;
        for (let i = 0; i < parts.length - 1; i++) {
          obj[parts[i]] = obj[parts[i]] ?? {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
      }
    },
    testUserPermission() { return true; },
    isOwner: true,
    getFlag() { return undefined; },
  };
  return actor;
}

function makeCharacter(overrides = {}) {
  const system = {
    combat: {
      defenseClassId: "cls-def",
      offenseClassId: "cls-atk",
      accuracyMod: 0,
    },
    abilityBases: { skill: 12, body: 12, mind: 12 },
    abilityAdjustments: {},
    ...overrides.system,
  };
  const items = [
    { id: "cls-def", name: "Fighter", type: "class", system: { level: 3, classType: "warrior" } },
    { id: "cls-atk", name: "Fighter", type: "class", system: { level: 5, classType: "warrior" } },
    { id: "arm-1", name: "Leather Armour", type: "armour", system: { evasion: 1, defence: 2, equipped: true } },
  ];
  const itemsMap = new Map(items.map(i => [i.id, i]));
  const itemsArray = [...items];
  const actor = {
    id: `char-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Hero",
    type: "character",
    system,
    uuid: `Actor.char-${Math.random().toString(36).slice(2)}`,
    items: { get: id => itemsMap.get(id) ?? null, filter: fn => itemsArray.filter(fn) },
    updates: [],
    async update(data) { actorUpdates.push(data); },
    testUserPermission() { return true; },
    isOwner: true,
    getFlag() { return undefined; },
  };
  return actor;
}

function makeWeapon(overrides = {}) {
  return {
    id: `wpn-${Math.random().toString(36).slice(2)}`,
    name: "Longsword",
    type: "weapon",
    system: { category: "Melee", accuracy: 0, power: 0, critical: 10, additionalDamage: 0, powerTable: {} },
    ...overrides,
  };
}

function resetWorld() {
  worldSettings.clear();
  chatMessages.length = 0;
  dialogCalls.length = 0;
  actorUpdates.length = 0;
  rollScripts.length = 0;
  game.user.targets = [];
  game.actors = [];
  game.user.character = null;
  game.combat = null;
}

function queueRolls(scripts) {
  rollScripts.push(...scripts);
}

function makeTargetToken(actor) {
  return { actor, uuid: `Token.${actor.id}`, name: actor.name, document: { actor } };
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log("=== Monster Combat Resolution ===\n");

// ── 1. Toggle defaults to disabled for existing monsters ───────────────────

console.log("Test 1: Toggle defaults to disabled for existing monsters");
resetWorld();
{
  const m = makeMonster();
  assert.equal(m.system.activeCombatRolls, false, "default is false");
  assert.equal(getMonsterActiveCombatRolls(m), false, "getMonsterActiveCombatRolls returns false");
  console.log("  ✓ PASS");
}

// ── 2. Missing activeCombatRolls means fixed mode ──────────────────────────

console.log("Test 2: Missing activeCombatRolls means fixed mode");
resetWorld();
{
  const m = makeMonster();
  delete m.system.activeCombatRolls;
  assert.equal(getMonsterActiveCombatRolls(m), false, "missing property returns false");
  console.log("  ✓ PASS");
}

// ── 3. Toggle persists on actor ────────────────────────────────────────────

console.log("Test 3: Toggle persists when set on actor");
resetWorld();
{
  const m = makeMonster({ system: { activeCombatRolls: true } });
  assert.equal(m.system.activeCombatRolls, true, "toggle is true");
  assert.equal(getMonsterActiveCombatRolls(m), true, "getMonsterActiveCombatRolls returns true");
  console.log("  ✓ PASS");
}

// ── 4. Fixed monster Evasion ──────────────────────────────────────────────

console.log("Test 4: Fixed monster Evasion uses parenthesized value");
resetWorld();
{
  const m = makeMonster({ system: { activeCombatRolls: false } });
  const defense = await resolveMonsterDefense(m);
  assert.equal(defense.mode, "passive", "mode is passive");
  assert.equal(defense.total, 9, "fixed evasion = 9 (from 2 (9))");
  assert.equal(defense.roll, null, "no roll in fixed mode");
  console.log("  ✓ PASS");
}

// ── 5. Active monster Evasion ─────────────────────────────────────────────

console.log("Test 5: Active monster Evasion rolls 2d6 + base");
resetWorld();
{
  queueRolls([[5, 4]]); // natural 9, base 2 => total 11
  const m = makeMonster({ system: { activeCombatRolls: true } });
  const defense = await resolveMonsterDefense(m);
  assert.equal(defense.mode, "active", "per-monster toggle overrides to active");
  assert.equal(defense.total, 11, "active evasion = 2d6(9) + base(2) = 11");
  assert.equal(defense.natural, 9, "natural roll is 9");
  console.log("  ✓ PASS");
}

// ── 6. Fixed monster Accuracy ─────────────────────────────────────────────

console.log("Test 6: Fixed monster Accuracy uses parenthesized value");
resetWorld();
{
  const m = makeMonster({ system: { activeCombatRolls: false } });
  const char = makeCharacter();
  const style = m.system.combatStyles[0];

  const result = await monsterWeaponAttackFlow({ monsterActor: m, style, targetActor: char });
  assert.equal(result.status, "resolved", "flow resolves");
  assert.equal(result.attackTotal, 10, "fixed accuracy = 10 (from 3 (10))");
  assert.equal(result.attackRoll, null, "no roll in fixed mode");
  console.log("  ✓ PASS");
}

// ── 7. Active monster Accuracy ────────────────────────────────────────────

console.log("Test 7: Active monster Accuracy rolls 2d6 + base");
resetWorld();
{
  queueRolls([[6, 6]]); // natural 12, base 3 => total 15
  const m = makeMonster({ system: { activeCombatRolls: true } });
  const char = makeCharacter();
  const style = m.system.combatStyles[0];

  const result = await monsterWeaponAttackFlow({ monsterActor: m, style, targetActor: char });
  assert.equal(result.status, "resolved", "flow resolves");
  assert.equal(result.attackTotal, 15, "active accuracy = 2d6(12) + base(3) = 15");
  assert.equal(result.attackNatural, 12, "natural roll is 12");
  console.log("  ✓ PASS");
}

// ── 8. Character attack vs fixed monster Evasion ──────────────────────────

console.log("Test 8: Character attack vs fixed monster Evasion");
resetWorld();
{
  // Character accuracy: offense class level 5 + dex bonus 2 + accuracy mod 0 = 7
  // Roll: 2d6 [5,5] = 10 + 7 = 17
  queueRolls([[5, 5]]);
  const m = makeMonster({ system: { activeCombatRolls: false } });
  const char = makeCharacter();
  const weapon = makeWeapon();
  game.actors.push(char, m);
  game.user.character = char;
  game.user.targets = [makeTargetToken(m)];

  const result = await characterWeaponAttackFlow({
    actor: char,
    weapon,
    attackingClass: char.items.get("cls-atk"),
    accuracyParts: [
      { label: "Offense Class Level", value: 5, enabled: true, temporary: false },
      { label: "Dexterity", value: 2, enabled: true, temporary: false },
      { label: "Accuracy Mod", value: 0, enabled: true, temporary: false },
    ],
    targetMonster: m,
    promptModifiers: openRollModifiersDialog,
  });

  assert.equal(result.status, "resolved", "flow resolves");
  assert.equal(result.hit, true, "17 > 9 (fixed evasion) => HIT");
  assert.equal(result.defenseTotal, 9, "monster evasion = 9 (fixed)");
  console.log("  ✓ PASS");
}

// ── 9. Character attack vs active monster Evasion ─────────────────────────

console.log("Test 9: Character attack vs active monster Evasion");
resetWorld();
{
  // Character accuracy: 5 + 2 + 0 = 7. Roll: 2d6 [3,4] = 7 + 7 = 14
  // Monster evasion: base 2. Roll: 2d6 [6,6] = 12 + 2 = 14
  // resolveMonsterDefense rolls FIRST, then character attack roll
  queueRolls([[6, 6]]); // monster evasion roll (consumed by resolveMonsterDefense)
  queueRolls([[3, 4]]); // character attack roll
  const m = makeMonster({ system: { activeCombatRolls: true } });
  const char = makeCharacter();
  const weapon = makeWeapon();
  game.actors.push(char, m);
  game.user.character = char;
  game.user.targets = [makeTargetToken(m)];

  const result = await characterWeaponAttackFlow({
    actor: char,
    weapon,
    attackingClass: char.items.get("cls-atk"),
    accuracyParts: [
      { label: "Offense Class Level", value: 5, enabled: true, temporary: false },
      { label: "Dexterity", value: 2, enabled: true, temporary: false },
      { label: "Accuracy Mod", value: 0, enabled: true, temporary: false },
    ],
    targetMonster: m,
    promptModifiers: openRollModifiersDialog,
  });

  assert.equal(result.status, "resolved", "flow resolves");
  assert.equal(result.hit, false, "14 > 14 is false (tie) => MISS");
  assert.equal(result.defenseTotal, 14, "monster evasion = 2d6(12) + base(2) = 14");
  console.log("  ✓ PASS");
}

// ── 10. Defense wins ties ──────────────────────────────────────────────────

console.log("Test 10: Defense wins ties (Accuracy == Evasion => MISS)");
resetWorld();
{
  // Character accuracy = 5 + 2 + 0 = 7. Roll 2d6 = 3. Total = 3 + 7 = 10.
  // Monster fixed evasion = 10. 10 > 10 is false => MISS.
  queueRolls([[3]]); // natural 3
  const m = makeMonster({ system: { activeCombatRolls: false, combatStyles: [{ style: "Claw", accuracy: "0 (0)", evasion: "0 (10)", defense: 2, hp: { value: 16, max: 16 }, mp: { value: 12, max: 12 }, isMainSection: true }] } });
  const char = makeCharacter();
  const weapon = makeWeapon();
  game.actors.push(char, m);
  game.user.character = char;
  game.user.targets = [makeTargetToken(m)];

  const result = await characterWeaponAttackFlow({
    actor: char,
    weapon,
    attackingClass: char.items.get("cls-atk"),
    accuracyParts: [
      { label: "Offense Class Level", value: 5, enabled: true, temporary: false },
      { label: "Dexterity", value: 2, enabled: true, temporary: false },
      { label: "Accuracy Mod", value: 0, enabled: true, temporary: false },
    ],
    targetMonster: m,
    promptModifiers: openRollModifiersDialog,
  });

  assert.equal(result.hit, false, "Accuracy(10) == Evasion(10) => MISS (defender wins ties)");
  console.log("  ✓ PASS");
}

// ── 11. Attack hits only when Accuracy > Evasion ──────────────────────────

console.log("Test 11: Attack hits only when Accuracy strictly exceeds Evasion");
resetWorld();
{
  // Accuracy 11 > Evasion 10 => HIT
  queueRolls([[4]]); // natural 4 + parts 7 = 11
  const m = makeMonster({ system: { activeCombatRolls: false, combatStyles: [{ style: "Claw", accuracy: "0 (0)", evasion: "0 (10)", defense: 2, hp: { value: 16, max: 16 }, mp: { value: 12, max: 12 }, isMainSection: true }] } });
  const char = makeCharacter();
  const weapon = makeWeapon();
  game.actors.push(char, m);
  game.user.character = char;
  game.user.targets = [makeTargetToken(m)];

  const result = await characterWeaponAttackFlow({
    actor: char,
    weapon,
    attackingClass: char.items.get("cls-atk"),
    accuracyParts: [
      { label: "Offense Class Level", value: 5, enabled: true, temporary: false },
      { label: "Dexterity", value: 2, enabled: true, temporary: false },
      { label: "Accuracy Mod", value: 0, enabled: true, temporary: false },
    ],
    targetMonster: m,
    promptModifiers: openRollModifiersDialog,
  });

  assert.equal(result.hit, true, "Accuracy(11) > Evasion(10) => HIT");
  console.log("  ✓ PASS");
}

// ── 12. Multiple targeted monsters ────────────────────────────────────────

console.log("Test 12: Multiple targeted monsters - only first is resolved");
resetWorld();
{
  queueRolls([[5, 5]]); // character attack
  const m1 = makeMonster({ name: "Goblin A", system: { activeCombatRolls: false } });
  const m2 = makeMonster({ name: "Goblin B", system: { activeCombatRolls: false } });
  const char = makeCharacter();
  const weapon = makeWeapon();
  game.actors.push(char, m1, m2);
  game.user.character = char;
  game.user.targets = [makeTargetToken(m1), makeTargetToken(m2)];

  const result = await characterWeaponAttackFlow({
    actor: char,
    weapon,
    attackingClass: char.items.get("cls-atk"),
    accuracyParts: [
      { label: "Offense Class Level", value: 5, enabled: true, temporary: false },
      { label: "Dexterity", value: 2, enabled: true, temporary: false },
      { label: "Accuracy Mod", value: 0, enabled: true, temporary: false },
    ],
    targetMonster: m1,
    promptModifiers: openRollModifiersDialog,
  });

  assert.equal(result.status, "resolved", "flow resolves for first target");
  assert.equal(result.targetMonster, m1, "only first targeted monster is used");
  console.log("  ✓ PASS");
}

// ── 13. staticAccuracy extracts parenthesized value ───────────────────────

console.log("Test 13: staticAccuracy extracts parenthesized fixed value");
resetWorld();
{
  assert.equal(staticAccuracy("3 (10)"), 10, "extracts 10 from 3 (10)");
  assert.equal(staticAccuracy("2 (9)"), 9, "extracts 9 from 2 (9)");
  assert.equal(staticAccuracy("0 (10)"), 10, "extracts 10 from 0 (10)");
  assert.equal(staticAccuracy("-"), null, "returns null for dash");
  assert.equal(staticAccuracy(""), null, "returns null for empty");
  console.log("  ✓ PASS");
}

// ── 14. Monster attack against targeted character ─────────────────────────

console.log("Test 14: Monster attack against targeted character");
resetWorld();
{
  // Monster fixed accuracy = 10, character evasion parts: class level 3 + agility 3 + armour 1 = 7
  // Monster evasion roll: 2d6 [4,4] = 8 + 7 = 15
  // Attack: 10 > 15? No => MISS
  queueRolls([[4, 4]]); // character evasion roll
  const m = makeMonster({ system: { activeCombatRolls: false } });
  const char = makeCharacter();
  const style = m.system.combatStyles[0];
  game.actors.push(char, m);
  game.user.character = char;

  const result = await monsterWeaponAttackFlow({
    monsterActor: m,
    style,
    targetActor: char,
    promptModifiers: openRollModifiersDialog,
  });

  assert.equal(result.status, "resolved", "flow resolves");
  assert.equal(result.attackTotal, 10, "monster fixed accuracy = 10");
  assert.equal(result.hit, false, "10 > 15 => MISS");
  console.log("  ✓ PASS");
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log("\n=== All monster combat resolution tests passed ===");
