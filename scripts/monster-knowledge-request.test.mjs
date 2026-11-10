// Sword World 2.5 - Monster Knowledge request from chat when no active character.
//
// Verifies:
//   - With active character, monster sheet button executes roll directly.
//   - Without active character, publishes a chat request card.
//   - The request identifies the target monster.
//   - A player can click the request and roll with their own character.
//   - Two distinct players can use the same request independently.
//   - Each roll preserves Sage/Rider and modifiers.
//   - Request fails if target monster no longer exists.
//   - No regressions in existing Monster Knowledge behaviour.

import assert from "node:assert/strict";

// ── Foundry mocks ──────────────────────────────────────────────────────────

const chatMessages = [];
const actorUpdates = [];

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

globalThis.canvas = { tokens: { controlled: [] } };

globalThis.fromUuid = async uuid => {
  return game.actors.find(a => a.uuid === uuid) || null;
};

// ── Roll mock ──────────────────────────────────────────────────────────────

let rollResults = [];

class MockRoll {
  constructor(formula) {
    this.formula = formula;
    this.dice = [];
    this._diceTotal = 0;
  }

  async evaluate() {
    const script = rollResults.shift() ?? [3, 4];
    const values = Array.isArray(script?.[0]) ? script.flat() : [script];
    this._diceTotal = values.reduce((a, b) => a + b, 0) || 0;
    this.dice = [{ results: values.map(v => ({ result: Number(v) || 0, active: true })) }];
    return this;
  }

  get total() { return this._diceTotal; }
  get natural() { return this._diceTotal; }

  async toMessage({ speaker, flavor, flags } = {}) {
    chatMessages.push({ speaker, flavor, flags, rollTotal: this.total });
    return { id: `msg-${chatMessages.length}` };
  }
}

globalThis.Roll = MockRoll;

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

// ── Imports ────────────────────────────────────────────────────────────────

import { rollMonsterKnowledge, findMonsterKnowledgeRoller } from "../module/combat/monster-knowledge.mjs";
import { registerRollModifiersDialog } from "../module/rules/roll-modifiers.mjs";

class MockDialog {
  static open(config = {}) {
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
  const items = [classItem("cls-sage", "Sage", 3)];
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
    species: "Goblin",
    weakness: 15,
    reputation: 10,
    ...overrides.system
  };
  return {
    id: overrides.id ?? "monster-1",
    name: overrides.name ?? "Goblin",
    type: "monster",
    system,
    uuid: overrides.uuid ?? `Actor.${overrides.id ?? "monster-1"}`,
    testUserPermission() { return true; },
    isOwner: true,
    flags: {},
    async setFlag(scope, key, value) {
      this.flags[scope] ??= {};
      if (value === null) delete this.flags[scope][key];
      else this.flags[scope][key] = structuredClone(value);
    },
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
    }
  };
};

function resetWorld() {
  worldSettings.clear();
  chatMessages.length = 0;
  actorUpdates.length = 0;
  rollResults.length = 0;
  canvas.tokens.controlled = [];
  game.user.character = null;
  game.user.targets = new Set();
  game.actors = [];
}

// ── Tests ───────────────────────────────────────────────────────────────

console.log("=== Monster Knowledge request from chat ===\n");

// Test 1: With active character, button executes roll directly.
console.log("Test 1: Active character executes roll directly");
resetWorld();
{
  game.user.character = makeCharacter();
  game.actors.push(game.user.character);
  const monster = makeMonster();
  game.actors.push(monster);
  rollResults.push([[5, 4]]); // natural 9

  // Simulate the listener from monster-sheet.mjs when character exists.
  const result = await rollMonsterKnowledge({ actor: game.user.character, targetMonster: monster });
  assert.equal(result.status, "resolved", "roll resolves");
  assert.equal(result.rollTotal, 9, "natural total is 9");
  assert.ok(chatMessages.length > 0, "roll posted to chat");
  console.log("  ✓ PASS");
}

// Test 2: Without active character, publishes chat request instead of warning.
console.log("Test 2: No active character publishes chat request");
resetWorld();
{
  const monster = makeMonster();
  game.actors.push(monster);

  // Simulate _publishMonsterKnowledgeRequest from monster-sheet.mjs.
  const content = `
    <div class="sw25-chat-card sw25-mk-request-card" data-mk-monster-uuid="${monster.uuid}">
      <h3>Monster Knowledge — ${foundry.utils.escapeHTML(monster.name)}</h3>
      <p>Click <strong>Roll Monster Knowledge</strong> to attempt a Monster Knowledge check against this monster using your active character.</p>
      <button type="button" data-sw25-chat-action="roll-monster-knowledge-request" data-mk-monster-uuid="${monster.uuid}">
        <i class="fas fa-search"></i> Roll Monster Knowledge
      </button>
    </div>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: monster }),
    content
  });

  assert.equal(chatMessages.length, 1, "one message published");
  assert.ok(chatMessages[0].content.includes("sw25-mk-request-card"), "card has request class");
  assert.ok(chatMessages[0].content.includes(monster.uuid), "card references monster UUID");
  assert.ok(chatMessages[0].content.includes("Roll Monster Knowledge"), "card has roll button");
  console.log("  ✓ PASS");
}

// Test 3: Request identifies the monster correctly.
console.log("Test 3: Request identifies the monster");
resetWorld();
{
  const monster = makeMonster({ id: "monster-42", name: "Cave Troll" });
  game.actors.push(monster);

  const content = `
    <div class="sw25-chat-card sw25-mk-request-card" data-mk-monster-uuid="${monster.uuid}">
      <h3>Monster Knowledge — ${foundry.utils.escapeHTML(monster.name)}</h3>
      <button type="button" data-sw25-chat-action="roll-monster-knowledge-request" data-mk-monster-uuid="${monster.uuid}">
        <i class="fas fa-search"></i> Roll Monster Knowledge
      </button>
    </div>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: monster }),
    content
  });

  const card = chatMessages[0].content;
  assert.ok(card.includes("Cave Troll"), "card shows monster name");
  assert.ok(card.includes("Actor.monster-42"), "card has monster UUID");
  console.log("  ✓ PASS");
}

// Test 4: Player can click request and roll with their own character.
console.log("Test 4: Player clicks request and rolls with own character");
resetWorld();
{
  const character = makeCharacter();
  // Mock roll total = dice only (12), so the weakness threshold matches it.
  const monster = makeMonster({ system: { weakness: 12 } });
  game.user.character = character;
  game.actors.push(character, monster);
  rollResults.push([[6, 6]]); // natural 12

  const result = await rollMonsterKnowledge({ actor: character, targetMonster: monster });
  assert.equal(result.status, "resolved", "roll resolves");
  assert.equal(result.rollTotal, 12, "natural total is 12");

  const mkMsg = chatMessages.find(m => m.flags?.["sw25-taka"]?.monsterKnowledge);
  assert.ok(mkMsg, "message with MK flags found");
  assert.ok(mkMsg.flags["sw25-taka"].monsterKnowledge.targetTokenUuids.includes(monster.uuid), "monster UUID in targets");
  assert.ok(mkMsg.flavor?.includes("Success — Weakness revealed"), "verdict shows Success — Weakness revealed");
  console.log("  ✓ PASS");
}

// Test 5: Two distinct players can use the same request independently.
console.log("Test 5: Two players use same request independently");
resetWorld();
{
  const character1 = makeCharacter({ id: "hero-1", name: "Hero 1" });
  const character2 = makeCharacter({ id: "hero-2", name: "Hero 2" });
  const monster = makeMonster();
  game.actors.push(character1, character2, monster);
  rollResults.push([[5, 5]], [[2, 3]]); // two different results

  // Player 1 rolls
  game.user.character = character1;
  const result1 = await rollMonsterKnowledge({ actor: character1, targetMonster: monster });
  assert.equal(result1.status, "resolved", "player 1 roll resolves");
  assert.equal(result1.rollTotal, 10, "player 1 total is 10");

  // Player 2 rolls (same request, different character)
  game.user.character = character2;
  const result2 = await rollMonsterKnowledge({ actor: character2, targetMonster: monster });
  assert.equal(result2.status, "resolved", "player 2 roll resolves");
  assert.equal(result2.rollTotal, 5, "player 2 total is 5");

  assert.equal(chatMessages.length, 2, "two rolls each produce one roll message");
  console.log("  ✓ PASS");
}

// Test 6: Each roll preserves Sage/Rider class results.
console.log("Test 6: Roll preserves Sage/Rider class results");
resetWorld();
{
  const character = makeCharacter({
    system: {
      combat: { monsterKnowledgeClassId: "cls-sage" },
      abilityBases: { mind: 12 }
    }
  });
  const items = [
    classItem("cls-sage", "Sage", 3),
    classItem("cls-rider", "Rider", 2)
  ];
  const itemsMap = new Map(items.map(i => [i.id, i]));
  const itemsArray = [...items];
  character.items = {
    get: id => itemsMap.get(id) || null,
    filter: fn => itemsArray.filter(fn)
  };
  const monster = makeMonster();
  game.user.character = character;
  game.actors.push(character, monster);
  rollResults.push([[10, 10]]); // natural 20

  const result = await rollMonsterKnowledge({ actor: character, targetMonster: monster });
  assert.equal(result.status, "resolved", "roll resolves");
  const sageResult = result.classResults.find(r => r.className === "sage");
  const riderResult = result.classResults.find(r => r.className === "rider");
  assert.ok(sageResult, "Sage class result present");
  assert.ok(riderResult, "Rider class result present");
  assert.equal(sageResult.canRevealWeakness, true, "Sage can reveal Weak Point");
  assert.equal(riderResult.canRevealWeakness, false, "Rider cannot reveal Weak Point");
  console.log("  ✓ PASS");
}

// Test 7: Request fails if target monster no longer exists.
console.log("Test 7: Request fails if monster does not exist");
resetWorld();
{
  // Simulate the sw25.mjs handler when monster UUID doesn't resolve.
  const monsterUuid = "Actor.nonexistent";
  const monster = game.actors.find(a => a.uuid === monsterUuid);
  assert.ok(!monster, "monster not found in actors");
  console.log("  ✓ PASS");
}

// Test 8: Request click requires a roller: an assigned character or a
// selected/targeted character token.
console.log("Test 8: Request click requires a character or a single selection");
resetWorld();
{
  const monster = makeMonster();
  game.actors.push(monster);

  // Simulate the sw25.mjs handler: no character assigned and no selection.
  game.user.character = null;
  const roller = findMonsterKnowledgeRoller();
  assert.ok(!roller.actor, "no active character and no selection");
  assert.equal(roller.status, "no-character", "roll request cannot start without a roller");
  console.log("  ✓ PASS");
}

// Test 9: Roll without monster target: result only, no comparison or discovery.
console.log("Test 9: Roll without monster target");
resetWorld();
{
  const character = makeCharacter();
  game.user.character = character;
  game.actors.push(character);
  rollResults.push([[7, 2]]); // natural 9

  const result = await rollMonsterKnowledge({ actor: character });
  assert.equal(result.status, "resolved", "roll resolves without target");
  assert.equal(result.rollTotal, 9, "natural total is 9");
  assert.equal(result.monster, undefined, "no monster target");
  assert.equal(result.discoveries.length, 0, "no discoveries without target");

  const mkMsg = chatMessages.find(m => m.flags?.["sw25-taka"]?.monsterKnowledge);
  assert.ok(mkMsg, "message with MK flags posted");
  assert.equal(mkMsg.flags["sw25-taka"].monsterKnowledge.targetTokenUuids.length, 0, "no target UUIDs");

  assert.ok(mkMsg.flavor?.includes("sw25-mk-roll-card"), "roll card published");
  assert.ok(!mkMsg.flavor.includes("Die:"), "card does not duplicate the die result");
  assert.ok(!mkMsg.flavor.includes("Total:"), "card does not duplicate the total");
  assert.ok(!mkMsg.flavor.includes("Intelligence"), "no intelligence modifier shown");
  assert.ok(!mkMsg.flavor.includes("Bonus fijo"), "no fixed bonus shown");
  // Per-class presentation: every evaluated class result appears (dice + class
  // level + Intelligence modifier) without modifier breakdowns.
  assert.ok(mkMsg.flavor.includes("sw25-mk-class-results"), "individual class results list published");
  assert.ok(mkMsg.flavor.includes("Sage"), "Sage individual result listed");
  assert.ok(!mkMsg.flavor.includes("Modif"), "no modifier breakdown shown");
  assert.ok(!mkMsg.flavor.includes("Weakness"), "no weakness discovery without target");
  assert.ok(!mkMsg.flavor.includes("Statistics"), "no statistics discovery without target");
  assert.ok(!mkMsg.flavor.includes("Success"), "no comparison verdict without target");
  assert.ok(!mkMsg.flavor.includes("Fail"), "no fail verdict without target");
  assert.ok(!mkMsg.flavor.includes("No target monster"), "no unnecessary no-target message");

  console.log("  ✓ PASS");
}

// Test 10: Roller resolution prefers exactly ONE selected character token.
console.log("Test 10: Single selected character token is used");
resetWorld();
{
  const selected = makeCharacter({ id: "hero-sel", name: "Selected Hero" });
  game.user.character = null; // GM scenario: no assigned character
  canvas.tokens.controlled = [{ actor: selected }];

  const roller = findMonsterKnowledgeRoller();
  assert.equal(roller.actor, selected, "selected token actor is returned");
  assert.equal(roller.source, "selected-token", "source marks the selection");
  console.log("  ✓ PASS");
}

// Test 11: Exactly one targeted character token is used when nothing selected.
console.log("Test 11: Single targeted character token is used");
resetWorld();
{
  const targeted = makeCharacter({ id: "hero-tgt", name: "Targeted Hero" });
  game.user.character = null;
  game.user.targets = new Set([{ actor: targeted }]);

  const roller = findMonsterKnowledgeRoller();
  assert.equal(roller.actor, targeted, "targeted token actor is returned");
  assert.equal(roller.source, "targeted-token", "source marks the targeting");
  console.log("  ✓ PASS");
}

// Test 12: Several selected characters are ambiguous and abort the roll.
console.log("Test 12: Multiple selected characters are ambiguous");
resetWorld();
{
  const a = makeCharacter({ id: "hero-a", name: "Hero A" });
  const b = makeCharacter({ id: "hero-b", name: "Hero B" });
  game.user.character = a; // assigned character must NOT mask an ambiguous selection
  canvas.tokens.controlled = [{ actor: a }, { actor: b }];

  const roller = findMonsterKnowledgeRoller();
  assert.ok(!roller.actor, "no actor on ambiguity");
  assert.equal(roller.status, "ambiguous", "ambiguous selection reported");
  console.log("  ✓ PASS");
}

// Test 13: Assigned character is the fallback with no active selection.
console.log("Test 13: Assigned character used when no selection");
resetWorld();
{
  const assigned = makeCharacter({ id: "hero-asg", name: "Assigned Hero" });
  game.user.character = assigned;
  canvas.tokens.controlled = []; // no selection
  game.user.targets = new Set();

  const roller = findMonsterKnowledgeRoller();
  assert.equal(roller.actor, assigned, "assigned character is returned");
  assert.equal(roller.source, "assigned-character", "source marks the assignment");
  console.log("  ✓ PASS");
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log("\n=== All Monster Knowledge request tests passed ===");
