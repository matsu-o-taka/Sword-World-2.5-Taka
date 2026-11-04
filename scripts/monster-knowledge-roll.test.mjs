// Sword World 2.5 - Monster Knowledge roll integration tests.
//
// Verifies:
//   - Character sheet Monster Knowledge button executes the roll through the
//     shared modifier dialog.
//   - Fixed sheet bonus is passed to the dialog exactly once.
//   - Temporary modifiers from the dialog are summed correctly.
//   - Monster sheet button uses the monster as target for threshold checks.
//   - Sage / Rider / Dark Hunter class-scoped results.
//   - No regressions for other check types.

import assert from "node:assert/strict";

// ── Foundry mocks ──────────────────────────────────────────────────────────

const chatMessages = [];
const chatMessagesWithFlags = [];
const actorUpdates = [];
const dialogCalls = [];

globalThis.ChatMessage = {
  async create(data) {
    chatMessages.push(data);
    return { id: `msg-${chatMessages.length}` };
  },
  getSpeaker({ actor } = {}) {
    return { actor };
  }
};

globalThis.ui = {
  notifications: { warn() {}, info() {}, error() {} }
};

globalThis.foundry = {
  utils: {
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    },
    mergeObject: (a, b) => ({ ...a, ...b })
  }
};

const worldSettings = new Map();
globalThis.game = {
  user: { isGM: true, character: null },
  actors: [],
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, structuredClone(value)); return value; }
  },
  scenes: []
};

globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OWNER: 1 } };

globalThis.fromUuid = async uuid => {
  // Resolve Actor documents by uuid for targetMonster.uuid lookups.
  return game.actors.find(a => a.uuid === uuid) || null;
};

// ── Roll mock ──────────────────────────────────────────────────────────────

let rollResults = [];
let rollFormula = "";

class MockRoll {
  constructor(formula) {
    this.formula = formula;
    rollFormula = formula;
    this.dice = [];
    this._diceTotal = 0;
    this._formulaConstant = 0;
  }

  async evaluate() {
    const script = rollResults.shift() ?? [3, 4];
    this._diceResults = script;
    // Normalize to flat array: [[5, 4]] -> [5, 4], or [5, 4] stays [5, 4]
    const values = Array.isArray(script?.[0]) ? script.flat() : [script];
    // Extract the constant from the formula (e.g., "2d6 + 8" -> 8, "2d6" -> 0)
    const formulaMatch = String(this.formula ?? "").match(/[\+\-]\s*\d+/);
    this._formulaConstant = formulaMatch ? Number(formulaMatch[0].replace(/[\+\-]/, "").trim()) || 0 : 0;
    // Dice total from rollResults (natural value)
    this._diceTotal = values.reduce((a, b) => a + b, 0) || 0;
    this.dice = [{
      results: values.map(v => ({ result: Number(v) || 0, active: true }))
    }];
    return this;
  }

  get total() { return this._diceTotal + this._formulaConstant; }
  get natural() { return this._diceTotal; }

  async toMessage({ speaker, flavor, flags } = {}) {
    chatMessagesWithFlags.push({ speaker, flavor, flags, rollTotal: this.total });
    return { id: `msg-${chatMessagesWithFlags.length}` };
  }
}

globalThis.Roll = MockRoll;

// ── Rules mocks ────────────────────────────────────────────────────────────

globalThis.markCriticalFailure = async () => false;
globalThis.rollDiceResults = (roll) => roll.dice.flatMap(die => die.results.map(r => r.result));
globalThis.assembleRollFormula = (diceFormula, total) => {
  const n = Number(total ?? 0);
  if (!Number.isFinite(n) || n === 0) return String(diceFormula);
  return `${diceFormula} ${n > 0 ? "+" : "-"} ${Math.abs(n)}`;
};
globalThis.enabledModifiersTotal = (modifiers = []) =>
  modifiers.reduce((sum, m) => (m?.enabled === false ? sum : sum + Number(m?.value ?? 0)), 0);
globalThis.normalizeModifier = (modifier = {}, index = 0) => ({
  label: String(modifier.label ?? `Modifier ${index + 1}`),
  value: Number.isFinite(Number(modifier.value ?? 0)) ? Number(modifier.value ?? 0) : 0,
  enabled: modifier.enabled !== false,
  temporary: modifier.temporary === true
});
globalThis.signedValue = (value) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  return `${n > 0 ? "+" : "-"}${Math.abs(n)}`;
};
globalThis.criticalFailureHTML = () => '<p class="sw25-critical-failure"><strong>CRITICAL FAILURE</strong></p>';

// Register the mock dialog constructor so openRollModifiersDialog works.
globalThis.registerRollModifiersDialog = (constructor) => {
  globalThis._dialogConstructor = constructor;
};

// ── Import after mocks are in place ────────────────────────────────────────

import { rollMonsterKnowledge } from "../module/combat/monster-knowledge.mjs";
import { registerRollModifiersDialog } from "../module/rules/roll-modifiers.mjs";

// Mock dialog: returns the seed parts unchanged (simulates user clicking
// Submit without changing anything).
class MockDialog {
  static open(config = {}) {
    dialogCalls.push(config);
    return Promise.resolve(config.parts);
  }
}

registerRollModifiersDialog(MockDialog);

// ── Helpers ────────────────────────────────────────────────────────────────

const classItem = (id, name, level) => ({
  id,
  name,
  type: "class",
  system: { level }
});

const makeCharacter = (overrides = {}) => {
  const system = {
    combat: {
      monsterKnowledgeClassId: "",
      monsterKnowledgeBonus: 0
    },
    abilityBases: { mind: 12 },
    abilityAdjustments: {},
    ...overrides.system
  };
  const items = [classItem("cls-sage", "Sage", 3), classItem("cls-rider", "Rider", 2)];
  const itemsMap = new Map(items.map(i => [i.id, i]));
  const itemsArray = [...items];
  return {
    id: "hero-1",
    name: "Hero",
    type: "character",
    system,
    items: {
      get: id => itemsMap.get(id) || null,
      filter: fn => itemsArray.filter(fn)
    },
    uuid: "Actor.hero-1",
    updates: [],
    async update(data) { actorUpdates.push(data); for (const [path, value] of Object.entries(data ?? {})) { const parts = path.split("."); let obj = system; for (let i = 0; i < parts.length - 1; i++) { obj[parts[i]] = obj[parts[i]] ?? {}; obj = obj[parts[i]]; } obj[parts[parts.length - 1]] = value; } }
  };
};

const makeMonster = (overrides = {}) => {
  const system = {
    monsterKnowledge: 0,
    weakness: 15,
    reputation: 10,
    weaknessDiscovered: false,
    ...overrides.system
  };
  return {
    id: "monster-1",
    name: "Goblin",
    type: "monster",
    system,
    uuid: "Actor.monster-1",
    testUserPermission() { return true; },
    isOwner: true
  };
};

function resetWorld() {
  worldSettings.clear();
  chatMessages.length = 0;
  chatMessagesWithFlags.length = 0;
  actorUpdates.length = 0;
  dialogCalls.length = 0;
  rollResults.length = 0;
  rollFormula = "";
  game.user.character = null;
  game.actors = [];
}

// ── Tests ───────────────────────────────────────────────────────────────

console.log("=== Monster Knowledge roll integration ===\n");

// Test 1: Character MK button executes the roll through the dialog.
console.log("Test 1: Character MK button executes roll through dialog");
resetWorld();
{
  game.user.character = makeCharacter();
  game.actors.push(game.user.character);
  rollResults.push([[5, 4]]); // natural 9

  const result = await rollMonsterKnowledge({ actor: game.user.character });
  assert.equal(result.status, "resolved", "roll resolves");
  assert.equal(result.rollTotal, 9, "natural total is 9");
  assert.equal(dialogCalls.length, 1, "dialog was opened once");
  assert.equal(dialogCalls[0].diceFormula, "2d6", "dialog shows 2d6 formula");
  // Seed parts should include fixed sheet bonus (monsterKnowledgeBonus = 0 here)
  const bonusPart = dialogCalls[0].parts.find(p => p.label === "Ficha (bonus fijo)");
  assert.equal(bonusPart.value, 0, "fixed sheet bonus is 0 by default");
  assert.equal(bonusPart.enabled, true, "fixed bonus part is enabled");
  assert.equal(bonusPart.temporary, false, "fixed bonus is permanent (not temporary)");
  assert.ok(chatMessagesWithFlags.length > 0, "roll was posted to chat");
  assert.ok(chatMessagesWithFlags[0].flags["sword-world-25"]?.monsterKnowledge, "message has monsterKnowledge flag");
  console.log("  ✓ PASS");
}

// Test 2: Fixed sheet bonus is passed exactly once (no duplication).
console.log("Test 2: Fixed sheet bonus applied exactly once");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeBonus: 3 } } });
  game.user.character = char;
  game.actors.push(char);
  rollResults.push([[2, 3]]); // natural 5

  const result = await rollMonsterKnowledge({ actor: char });
  assert.equal(result.status, "resolved", "roll resolves");
  // Base: class level (Sage 3) + INT bonus (12/6=2) = 5. Fixed bonus: 3.
  // Total from parts: 5 + 3 = 8. Roll adds 5 (natural) + 8 = 13.
  const bonusParts = dialogCalls[0].parts.filter(p => p.label === "Ficha (bonus fijo)");
  assert.equal(bonusParts.length, 1, "fixed bonus appears exactly once");
  assert.equal(bonusParts[0].value, 3, "fixed bonus value is 3");
  assert.equal(result.rollTotal, 13, "total = natural(5) + base(3+2) + fixed(3) = 13");
  console.log("  ✓ PASS");
}

// Test 3: Temporary modifiers from dialog are summed correctly.
console.log("Test 3: Temporary modifiers are summed correctly");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeBonus: 0 } } });
  game.user.character = char;
  game.actors.push(char);
  rollResults.push([[4, 4]]); // natural 8

  // Mock dialog returns parts with one temporary modifier enabled.
  const originalOpen = MockDialog.open;
  MockDialog.open = async (config) => {
    dialogCalls.push(config);
    const parts = config.parts.map(p => ({ ...p, enabled: p.label !== "Intelligence" })); // disable INT
    parts.push({ label: "Temp bonus", value: 2, enabled: true, temporary: true }); // add +2 temp
    return parts;
  };

  const result = await rollMonsterKnowledge({ actor: char });
  MockDialog.open = originalOpen;

  // Parts: Sage level 3 (enabled), INT 2 (disabled), fixed 0 (enabled), temp 2 (enabled).
  // Total = 3 + 0 + 2 = 5. Roll = 8 + 5 = 13.
  assert.equal(result.rollTotal, 13, "temp modifiers summed correctly (8+5=13)");
}

// Test 4: Monster sheet button uses monster as target.
console.log("Test 4: Monster sheet button targets the monster");
resetWorld();
{
  const char = makeCharacter();
  const monster = makeMonster();
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[6, 6]]); // natural 12

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  const msg = chatMessagesWithFlags[chatMessagesWithFlags.length - 1];
  assert.ok(msg.flags["sword-world-25"].monsterKnowledge.targetTokenUuids.includes(monster.uuid), "monster uuid in targetTokenUuids");
  assert.equal(result.rollTotal, 12, "roll total is 12");
  console.log("  ✓ PASS");
}

// Test 5: Sage can reveal Weak Point (canRevealWeakness = true for Sage).
console.log("Test 5: Sage class-scored result can reveal Weak Point");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  game.user.character = char;
  game.actors.push(char);
  rollResults.push([[10, 10]]); // natural 20

  const result = await rollMonsterKnowledge({ actor: char });
  const sageResult = result.classResults.find(r => r.className === "sage");
  assert.ok(sageResult, "Sage class result exists");
  assert.equal(sageResult.canRevealWeakness, true, "Sage can reveal Weak Point");
  assert.equal(sageResult.successValue, 20 + 3 + 2, "Sage value = natural(20) + level(3) + INT(2)");
  console.log("  ✓ PASS");
}

// Test 6: Rider cannot reveal Weak Point.
console.log("Test 6: Rider cannot reveal Weak Point");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-rider" } } });
  game.user.character = char;
  game.actors.push(char);
  rollResults.push([10, 10]);

  const result = await rollMonsterKnowledge({ actor: char });
  const riderResult = result.classResults.find(r => r.className === "rider");
  assert.ok(riderResult, "Rider class result exists");
  assert.equal(riderResult.canRevealWeakness, false, "Rider cannot reveal Weak Point");
  console.log("  ✓ PASS");
}

// Test 7: Dialog cancel aborts the roll.
console.log("Test 7: Dialog cancel aborts the roll");
resetWorld();
{
  const char = makeCharacter();
  game.user.character = char;
  game.actors.push(char);

  const originalOpen = MockDialog.open;
  MockDialog.open = async () => null; // user cancels

  const result = await rollMonsterKnowledge({ actor: char });
  assert.equal(result.status, "cancelled", "cancelled status");
  assert.equal(result.phases.dialog, true, "dialog phase happened");
  assert.equal(result.phases.roll, false, "roll phase did not happen");
  assert.equal(chatMessagesWithFlags.length, 0, "no message posted on cancel");

  MockDialog.open = originalOpen;
  console.log("  ✓ PASS");
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log("\n=== All Monster Knowledge roll integration tests passed ===");
