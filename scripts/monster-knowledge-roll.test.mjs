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
const socketEmissions = [];
const gameUsers = [];
const socketListeners = [];
let relayAckMode = "registered"; // "registered" | "already-known" | "error" | "silent"

globalThis.ChatMessage = {
  async create(data) {
    chatMessages.push(data);
    return { id: `msg-${chatMessages.length}` };
  },
  getSpeaker({ actor } = {}) {
    return { actor };
  }
};

const warnings = [];
globalThis.ui = {
  notifications: {
    warn(message) { warnings.push(message); },
    info() {},
    error() {}
  }
};

globalThis.foundry = {
  utils: {
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    },
    mergeObject: (a, b) => ({ ...a, ...b }),
    randomID() { return `req-${Math.random().toString(36).slice(2)}`; }
  }
};

const worldSettings = new Map();
globalThis.game = {
  user: { isGM: true, character: null, id: "gm-user" },
  actors: [],
  users: {
    get(id) { return gameUsers.find(u => u.id === id || u._id === id) ?? null; },
    filter(fn) { return gameUsers.filter(fn); },
    get activeGM() { return gameUsers.find(u => u.isGM && u.active) ?? null; }
  },
  socket: {
    emit(action, payload) {
      socketEmissions.push({ action, payload });
      // Simulated GM round-trip for real MK relay requests: the GM side is
      // exercised for real in monster-knowledge-relay.test.mjs. Here the ack
      // is produced synchronously (no timers) so the requesting player's
      // promise settles the way F2-T1 defines, without running the GM
      // handler — the player client therefore never writes the registry.
      if (payload?.action === "mk-discovery-request" && relayAckMode !== "silent") {
        const ack = {
          scope: "sw25-taka",
          action: "mk-discovery-ack",
          requestId: payload.requestId,
          gid: payload.gid,
          requestedBy: payload.requesterId,
          ...(relayAckMode === "already-known"
            ? { status: "already-known", speciesId: payload.evidence.speciesId, recordId: null }
            : relayAckMode === "error"
              ? { status: "error", code: "version-too-new", error: "simulated relay failure" }
              : { status: "registered", speciesId: payload.evidence.speciesId, recordId: "mkd-relay-mock" })
        };
        for (const listener of [...socketListeners]) listener(ack, "gm-user");
      }
      return Promise.resolve();
    },
    on(channel, handler) { socketListeners.push(handler); }
  },
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, structuredClone(value)); return value; }
  },
  scenes: []
};

globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2, OWNER: 1 } };

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

import { rollMonsterKnowledge, isSpeciesWeaknessKnown } from "../module/combat/monster-knowledge.mjs";
import { readMkDiscoveries } from "../module/knowledge/monster-knowledge-registry.mjs";
import { initializeMonsterKnowledgeRelay, pendingMkRelayRequestCount } from "../module/knowledge/mk-relay.mjs";
import { resolveSkillClass } from "../module/rules/skill-resolution.mjs";
import { SKILL_DEFINITION_MAP } from "../module/rules/skill-definitions.mjs";
import { registerRollModifiersDialog } from "../module/rules/roll-modifiers.mjs";

// Register the requester-side relay listener once (acks settle the pending
// promise through the mock socket round-trip above).
initializeMonsterKnowledgeRelay();

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
  const items = overrides.items ?? [classItem("cls-sage", "Sage", 3), classItem("cls-rider", "Rider", 2)];
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
    ...overrides.system
  };
  const ownership = { ...overrides.ownership };
  return {
    id: "monster-1",
    name: "Goblin",
    type: "monster",
    system,
    ownership,
    uuid: "Actor.monster-1",
    testUserPermission(user, permission) {
      // Foundry v14 semantics: GM always has full access; others use effective level.
      if (user?.isGM) return true;
      const perms = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
      const level = this.ownership[user?.id] ?? this.ownership.default ?? perms.NONE;
      const target = (typeof permission === "string") ? (perms[permission] ?? perms.OWNER) : permission;
      return level >= target;
    },
    isOwner: true,
    flags: {},
    async setFlag(scope, key, value) {
      this.flags[scope] ??= {};
      if (value === null) delete this.flags[scope][key];
      else this.flags[scope][key] = structuredClone(value);
    },
    async getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async update(data) {
      for (const [path, value] of Object.entries(data ?? {})) {
        if (path === "ownership") {
          for (const [key, val] of Object.entries(value ?? {})) {
            ownership[key] = val;
          }
          continue;
        }
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
  chatMessagesWithFlags.length = 0;
  actorUpdates.length = 0;
  dialogCalls.length = 0;
  warnings.length = 0;
  socketEmissions.length = 0;
  rollResults.length = 0;
  rollFormula = "";
  relayAckMode = "registered";
  gameUsers.length = 0;
  gameUsers.push({ _id: "gm-user", id: "gm-user", isGM: true, active: true, name: "GameMaster" });
  game.user.isGM = true;
  game.user.id = "gm-user";
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

  const result = await rollMonsterKnowledge({ actor: game.user.character, shiftKey: true });
  assert.equal(result.status, "resolved", "roll resolves");
  // Dice-only roll: rollTotal is the raw dice sum (formula carries no constants).
  assert.equal(result.rollTotal, 9, "roll total is the dice only (9)");
  assert.equal(rollFormula, "2d6", "formula carries no modifier constants");
  // Individual per-class results share the same dice: Sage 3 + INT 2, Rider 2 + INT 2.
  const sage = result.individualResults.find(entry => entry.className === "sage");
  const rider = result.individualResults.find(entry => entry.className === "rider");
  assert.deepEqual(sage?.result, 14, "Sage result = dice 9 + Sage 3 + INT 2");
  assert.deepEqual(rider?.result, 13, "Rider result = dice 9 + Rider 2 + INT 2");
  assert.equal(dialogCalls.length, 1, "dialog was opened once");
  assert.equal(dialogCalls[0].diceFormula, "2d6", "dialog shows 2d6 formula");
  // Seed parts: one class-level part per evaluated class + shared parts.
  assert.ok(dialogCalls[0].parts.some(p => p.label === "Sage level" && p.value === 3), "Sage level part seeded");
  assert.ok(dialogCalls[0].parts.some(p => p.label === "Rider level" && p.value === 2), "Rider level part seeded");
  // Seed parts should include fixed sheet bonus (monsterKnowledgeBonus = 0 here)
  const bonusPart = dialogCalls[0].parts.find(p => p.label === "Bonus fijo");
  assert.equal(bonusPart.value, 0, "fixed sheet bonus is 0 by default");
  assert.equal(bonusPart.enabled, true, "fixed bonus part is enabled");
  assert.equal(bonusPart.temporary, false, "fixed bonus is permanent (not temporary)");
  assert.ok(chatMessagesWithFlags.length > 0, "roll was posted to chat");
  assert.ok(chatMessagesWithFlags[0].flags["sw25-taka"]?.monsterKnowledge, "message has monsterKnowledge flag");
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

  const result = await rollMonsterKnowledge({ actor: char, shiftKey: true });
  assert.equal(result.status, "resolved", "roll resolves");
  // Base per-class: class level + INT bonus (12/6=2). Dice-only roll: total = 5.
  // Sage's individual result adds the shared fixed bonus 3: 5 + 3 + 2 + 3 = 13.
  const bonusParts = dialogCalls[0].parts.filter(p => p.label === "Bonus fijo");
  assert.equal(bonusParts.length, 1, "fixed bonus appears exactly once");
  assert.equal(bonusParts[0].value, 3, "fixed bonus value is 3");
  assert.equal(result.rollTotal, 5, "roll total is the dice only (natural 5)");
  const sage2 = result.individualResults.find(entry => entry.className === "sage");
  assert.equal(sage2.result, 13, "Sage result = dice(5) + level(3) + INT(2) + fixed(3) = 13");
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

  const result = await rollMonsterKnowledge({ actor: char, shiftKey: true });
  MockDialog.open = originalOpen;

  // Parts: Sage level 3 (enabled), INT 2 (disabled), fixed 0 (enabled), temp 2 (enabled).
  // Shared adjustment = 0 (INT off) + 0 + 2 = 2. Dice-only roll: 8.
  // Sage's individual result = 8 + Sage level 3 + shared 2 = 13.
  assert.equal(result.rollTotal, 8, "roll total is the dice only (8)");
  const sage3 = result.individualResults.find(entry => entry.className === "sage");
  assert.equal(sage3.result, 13, "Sage result = dice(8) + level(3) + shared(2), INT disabled");
  console.log("  ✓ PASS");
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
  assert.ok(msg.flags["sw25-taka"].monsterKnowledge.targetTokenUuids.includes(monster.uuid), "monster uuid in targetTokenUuids");
  // Dice-only roll: 12. Sage result 12+3+2 = 17, Rider result 12+2+2 = 16.
  assert.equal(result.rollTotal, 12, "roll total is the dice only (12)");
  const sage4 = result.individualResults.find(entry => entry.className === "sage");
  const rider4 = result.individualResults.find(entry => entry.className === "rider");
  assert.equal(sage4.result, 17, "Sage result = dice 12 + level 3 + INT 2");
  assert.equal(rider4.result, 16, "Rider result = dice 12 + level 2 + INT 2");
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
  // Dice-only roll: classResults.successValue records the shared dice (no
  // constants in the formula); the individual result carries the modifiers.
  assert.equal(sageResult.successValue, 20, "successValue = dice only (natural 20)");
  const sage5 = result.individualResults.find(entry => entry.className === "sage");
  assert.equal(sage5.result, 25, "Sage result = dice(20) + level(3) + INT(2)");
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

  const result = await rollMonsterKnowledge({ actor: char, shiftKey: true });
  assert.equal(result.status, "cancelled", "cancelled status");
  assert.equal(result.phases.dialog, true, "dialog phase happened");
  assert.equal(result.phases.roll, false, "roll phase did not happen");
  assert.equal(chatMessagesWithFlags.length, 0, "no message posted on cancel");

  MockDialog.open = originalOpen;
  console.log("  ✓ PASS");
}

// Test 8: Dark Hunter reveals statistics, identifies the Daemon
// classification and reveals its Weak Point at threshold (Abyss Breaker p. 28).
console.log("Test 8: Dark Hunter stats + identification + Weak Point");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-dh", "Dark Hunter", 5)],
    system: { combat: { monsterKnowledgeClassId: "cls-dh" } }
  });
  // Partial roll: SV = 2+2 + level(5) + INT(2) = 11: below Reputation 12 and
  // Weakness 14 -> only the automatic classification identification.
  rollResults.push([[2, 2]]);
  game.user.character = char;
  game.actors.push(char);

  const partial = await rollMonsterKnowledge({ actor: char, targetMonster: makeDaemon({ weakness: 14, reputation: 12 }) });
  assert.equal(partial.status, "resolved", "roll resolves against a Daemon");
  assert.deepEqual(partial.discoveries.map(d => d.type), ["classification"], "only classification identified below both thresholds");
  assert.ok(partial.discoveries[0].classification === "daemon", "classification recorded");
  const partialMsg = chatMessagesWithFlags[0];
  assert.ok(partialMsg.flags["sw25-taka"].monsterKnowledge.usedClasses?.[0]?.className === "dark hunter", "used Dark Hunter");
  assert.ok(partialMsg.flavor.includes("Partial success — Classification identified"), "classification verdict on the partial roll");

  // Second roll above weakness -> stats + identification + Weak Point.
  const daemon = makeDaemon({ weakness: 14, species: "Legion Daemon" });
  game.actors.push(daemon);
  rollResults.push([[6, 5]]); // SV = 11 + 5 + 2 = 18 >= 14
  const result = await rollMonsterKnowledge({ actor: char, targetMonster: daemon });
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "classification", "weakness"], "stats, identification and Weak Point at threshold");
  assert.equal(isSpeciesWeaknessKnown("legion daemon"), true, "weakness registered for species");
  const successMsg = chatMessagesWithFlags[1];
  assert.ok(successMsg.flavor.includes("Success — Weakness revealed"), "weakness verdict on the successful roll");
  console.log("  ✓ PASS");
}

function makeDaemon(system = {}) {
  return makeMonster({ system: { monsterType: "Daemon", species: "Legion Daemon", weakness: 14, reputation: 10, ...system } });
}

// Test 9: Dark Hunter is limited to Daemons (Abyss Breaker p. 28). When the
// user manually selects Dark Hunter against a non-Daemon, the check publishes
// a card with the Dark Hunter result as main result and a restriction warning,
// instead of refusing in silence.
console.log("Test 9: Dark Hunter manual vs non-Daemon shows card with warning");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-dh", "Dark Hunter", 5)],
    system: { combat: { monsterKnowledgeClassId: "cls-dh" } }
  });
  const barbarous = makeMonster({ system: { monsterType: "Barbarous", species: "Ogre" } });
  game.user.character = char;
  game.actors.push(char, barbarous);
  rollResults.push([[3, 4]]); // dice 7

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: barbarous });
  assert.equal(result.status, "resolved", "card published instead of silent refusal");
  assert.equal(result.manualIneligible, true, "manual class flagged as ineligible");
  assert.equal(result.manualClass.className, "dark hunter", "manual class is Dark Hunter");
  assert.equal(result.manualClass.level, 5, "manual class level 5");
  // Main result is the manually selected Dark Hunter result (dice 7 + DH 5 + INT 2 = 14).
  assert.equal(result.mainResult.className, "dark hunter", "main result is the manually selected Dark Hunter");
  assert.equal(result.mainResult.result, 14, "main result = dice 7 + DH 5 + INT 2");
  // No class is eligible, so no effects are discovered.
  assert.deepEqual(result.discoveries.map(d => d.type), [], "no effects without eligible classes");
  // The card carries a restriction warning.
  assert.equal(chatMessagesWithFlags.length, 1, "one card published");
  assert.ok(chatMessagesWithFlags[0].flavor.includes("sw25-mk-warning"), "restriction warning on the card");
  assert.ok(chatMessagesWithFlags[0].flavor.includes("Dark Hunter"), "warning names Dark Hunter");
  assert.ok(chatMessagesWithFlags[0].flavor.includes("daemon"), "warning names the Daemon limitation");
  console.log("  ✓ PASS");
}

// Test 10: ◯Monster Watch (Abyss Breaker p. 31) expands the Dark Hunter to
// Barbarous and Undead targets.
console.log("Test 10: Monster Watch expands Dark Hunter targets to Barbarous and Undead");
resetWorld();
{
  const char = makeCharacter({
    items: [
      classItem("cls-dh", "Dark Hunter", 3),
      { id: "feat-mw", name: "Monster Watch", type: "feat", system: {} }
    ],
    system: { combat: { monsterKnowledgeClassId: "cls-dh" } }
  });
  const undead = makeMonster({ system: { monsterType: "Undead", species: "Ghoul", weakness: 14, reputation: 10 } });
  game.user.character = char;
  game.actors.push(char, undead);
  rollResults.push([[5, 5]]); // SV = 10 + 3 + 2 = 15 >= weakness 14

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: undead });
  assert.equal(result.status, "resolved", "Undead target is valid with Monster Watch");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "classification", "weakness"], "stats, identification and Weak Point reachable on Undead");
  assert.equal(isSpeciesWeaknessKnown("ghoul"), true, "weakness registered");
  console.log("  ✓ PASS");
}

// Test 11: Monster Watch level 5+ treats Daemon weakness as -4, never below
// reputation (Abyss Breaker p. 31).
console.log("Test 11: Monster Watch level 5+ weakens Daemon weakness by 4 (floor reputation)");
resetWorld();
{
  const character = makeCharacter({
    items: [
      classItem("cls-dh", "Dark Hunter", 5),
      { id: "feat-mw", name: "Monster Watch", type: "feat", system: {} }
    ],
    system: { combat: { monsterKnowledgeClassId: "cls-dh" } }
  });
  // weakness 15 -> threshold max(reputation 10, 15-4=11) = 11.
  const daemon = makeDaemon({ weakness: 15, species: "Legion Daemon" });
  game.user.character = character;
  game.actors.push(character, daemon);
  rollResults.push([[2, 3]]); // SV = 5 + 5 + 2 = 12: >= 11 with -4, < 15 without

  const result = await rollMonsterKnowledge({ actor: character, targetMonster: daemon });
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "classification", "weakness"], "weakness reached with -4 (12 >= 11)");
  console.log("  ✓ PASS");
}

// Test 11b: the same roll without Monster Watch needs the full weakness.
console.log("Test 11b: Without Monster Watch the full Daemon weakness applies");
resetWorld();
{
  const character = makeCharacter({
    items: [classItem("cls-dh", "Dark Hunter", 5)],
    system: { combat: { monsterKnowledgeClassId: "cls-dh" } }
  });
  const daemon = makeDaemon({ weakness: 15, species: "Legion Daemon" });
  game.user.character = character;
  game.actors.push(character, daemon);
  rollResults.push([[2, 3]]); // SV = 5 + 5 + 2 = 12 < 15

  const result = await rollMonsterKnowledge({ actor: character, targetMonster: daemon });
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "classification"], "no weak point without Monster Watch reduction");
  assert.equal(isSpeciesWeaknessKnown("legion daemon"), false, "species not registered");
  console.log("  ✓ PASS");
}

// Test 12: Sage automatic success (double 6s) reveals Weak Point and stats
// even below the recorded difficulty (CR I p. 383).
console.log("Test 12: Sage automatic success detects Weak Point below threshold");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  const dragon = makeMonster({ system: { weakness: 18, reputation: 16, species: "Elder Dragon", monsterType: "Beast" } });
  game.user.character = char;
  game.actors.push(char, dragon);
  rollResults.push([[6, 6]]); // SV = 12 + 3 + 2 = 17 < weakness 18, < reputation 16

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: dragon });
  assert.equal(result.automaticSuccess, true, "double 6s marked as automatic success");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "weakness"], "stats and Weak Point on automatic success");
  console.log("  ✓ PASS");
}

// Test 13: Rider automatic success reveals statistics but never Weak Point.
console.log("Test 13: Rider automatic success reveals stats, never Weak Point");
resetWorld();
{
  // Rider-only native class list: no Sage available to pick up the Weak Point.
  const char = makeCharacter({
    items: [classItem("cls-rider", "Rider", 2)],
    system: { combat: { monsterKnowledgeClassId: "cls-rider" } }
  });
  // SV = 12 + level(2) + INT(2) = 16 < weakness 17, >= reputation 15 anyway.
  // Use reputation 17 too so stats come strictly from the automatic success.
  const dragon = makeMonster({ system: { weakness: 18, reputation: 20, species: "Goblin Chief", monsterType: "Barbarous" } });
  game.user.character = char;
  game.actors.push(char, dragon);
  rollResults.push([[6, 6]]);

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: dragon });
  assert.equal(result.automaticSuccess, true, "double 6s marked as automatic success");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats"], "stats on automatic success, never Weak Point");
  assert.equal(isSpeciesWeaknessKnown("goblin chief"), false, "Rider never registers weaknesses");
  console.log("  ✓ PASS");
}

// ── Multi-class scenario tests (single roll, all applicable natives) ──────

// Scenario 1: Sage + Rider against a valid target: ONE roll; both classes
// applicable; statistics from either; Weak Point only via Sage.
console.log("Test 14: Sage + Rider single roll, both evaluated");
resetWorld();
{
  const char = makeCharacter(); // Sage 3 + Rider 2, no saved selection
  const monster = makeMonster({ system: { weakness: 15, reputation: 10, species: "Goblin Scout" } });
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[6, 5]]); // SV = 11 + sage 3 + INT 2 = 16

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.equal(result.status, "resolved", "single roll resolves");
  assert.equal(chatMessagesWithFlags.length, 1, "exactly ONE roll message");
  assert.deepEqual(result.usedClasses.map(c => c.className).sort(), ["rider", "sage"], "both native classes applicable");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "weakness"], "stats (any) plus Weak Point (Sage)");
  assert.equal(isSpeciesWeaknessKnown("goblin scout"), true, "Weak Point registered via Sage");
  console.log("  ✓ PASS");
}

// Scenario 2: Sage + Dark Hunter against a Daemon: ONE roll; both evaluated.
console.log("Test 15: Sage + Dark Hunter vs Daemon, both evaluated");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 3), classItem("cls-dh", "Dark Hunter", 5)]
  });
  const daemon = makeDaemon({ weakness: 14 });
  game.user.character = char;
  game.actors.push(char, daemon);
  rollResults.push([[5, 4]]); // SV = 9 + Dark Hunter 5 (highest eligible) + INT 2 = 16

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: daemon });
  assert.deepEqual(result.usedClasses.map(c => c.className).sort(), ["dark hunter", "sage"], "both native classes applicable");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "classification", "weakness"], "stats + identification + Weak Point");
  assert.deepEqual(result.formulaClass?.className, "dark hunter", "automatic formula picks the highest eligible (Dark Hunter 5)");
  console.log("  ✓ PASS");
}

// Scenario 3: Sage + Dark Hunter against a Barbarous without Monster Watch:
// Dark Hunter excluded, Sage still resolves; the check is NOT rejected.
console.log("Test 16: Sage + Dark Hunter vs Barbarous without Monster Watch");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 3), classItem("cls-dh", "Dark Hunter", 5)]
  });
  const barbarous = makeMonster({ system: { monsterType: "Barbarous", species: "Ogre", weakness: 15, reputation: 10 } });
  game.user.character = char;
  game.actors.push(char, barbarous);
  rollResults.push([[5, 4]]); // SV = 9 + Sage 3 + INT 2 = 14

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: barbarous });
  assert.equal(result.status, "resolved", "check NOT rejected for the whole character");
  assert.deepEqual(result.usedClasses.map(c => c.className), ["sage"], "only Sage applicable");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats"], "Sage-only capabilities: no classification this time");
  assert.deepEqual(result.formulaClass?.className, "sage", "formula falls back to the eligible native, not the highest level");
  console.log("  ✓ PASS");
}

// Scenario 4: Sage + Dark Hunter against a Barbarous WITH Monster Watch:
// both applicable and evaluated with the same roll.
console.log("Test 17: Sage + Dark Hunter vs Barbarous with Monster Watch");
resetWorld();
{
  const char = makeCharacter({
    items: [
      classItem("cls-sage", "Sage", 3),
      classItem("cls-dh", "Dark Hunter", 5),
      { id: "feat-mw", name: "Monster Watch", type: "feat", system: {} }
    ]
  });
  const barbarous = makeMonster({ system: { monsterType: "Barbarous", species: "Ogre", weakness: 15, reputation: 10 } });
  game.user.character = char;
  game.actors.push(char, barbarous);
  rollResults.push([[5, 4]]); // SV = 9 + Dark Hunter 5 + INT 2 = 16

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: barbarous });
  assert.deepEqual(result.usedClasses.map(c => c.className).sort(), ["dark hunter", "sage"], "both applicable with Monster Watch");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "classification", "weakness"], "union of both classes' capabilities");
  console.log("  ✓ PASS");
}

// Scenario 5: Manual selection of Rider with Sage also available: selection
// must not suppress Sage's Weak Point capability.
console.log("Test 18: Manual Rider selection does not suppress Sage's Weak Point");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-rider" } } }); // Sage 3 + Rider 2
  const monster = makeMonster({ system: { weakness: 15, reputation: 10, species: "Goblin Scout" } });
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[6, 6]]); // SV = 12 + Rider 2 + INT 2 = 16

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.equal(result.status, "resolved", "roll resolves");
  assert.deepEqual(result.formulaClass?.className, "rider", "manual selection shapes the roll (Rider 2)");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "weakness"], "Weak Point still discovered via Sage");
  assert.equal(isSpeciesWeaknessKnown("goblin scout"), true, "weakness registered");
  console.log("  ✓ PASS");
}

// Scenario 6: Manual selection of Dark Hunter with Sage also available
// against a Daemon: both classes evaluated.
console.log("Test 19: Manual Dark Hunter with Sage vs Daemon");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 3), classItem("cls-dh", "Dark Hunter", 5)],
    system: { combat: { monsterKnowledgeClassId: "cls-dh" } }
  });
  const daemon = makeDaemon({ weakness: 14 });
  game.user.character = char;
  game.actors.push(char, daemon);
  rollResults.push([[5, 4]]); // SV = 9 + Dark Hunter 5 + INT 2 = 16

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: daemon });
  assert.deepEqual(result.formulaClass?.className, "dark hunter", "manual selection feeds the roll");
  assert.deepEqual(result.usedClasses.map(c => c.className).sort(), ["dark hunter", "sage"], "both evaluated");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "classification", "weakness"], "union preserved");
  console.log("  ✓ PASS");
}

// Scenario 7: Automatic selection with multiple eligible native classes must
// not reduce resolution to the selected class (covered by Scenarios 2/5 too);
// Scenario 7 asserts the automatic choice is the highest ELIGIBLE native.
console.log("Test 20: Automatic selection picks highest eligible, not highest level");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 3), classItem("cls-dh", "Dark Hunter", 9)]
  });
  const barbarous = makeMonster({ system: { monsterType: "Barbarous", species: "Ogre", weakness: 15, reputation: 10 } });
  game.user.character = char;
  game.actors.push(char, barbarous);
  rollResults.push([[5, 4]]); // SV = 9 + Sage 3 + INT 2 = 14 (Dark Hunter 9 ineligible here)

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: barbarous });
  assert.deepEqual(result.formulaClass?.className, "sage", "ineligible Dark Hunter 9 not auto-selected");
  assert.equal(result.rollTotal, 9, "roll total = dice only (9)");
  const sage20 = result.individualResults.find(entry => entry.className === "sage");
  assert.equal(sage20.result, 14, "Sage result = dice 9 + Sage 3 + INT 2 (not Dark Hunter 9)");
  assert.deepEqual(result.usedClasses.map(c => c.className), ["sage"], "only Sage applicable");
  console.log("  ✓ PASS");
}

// Scenarios 10 & 11: Druid and Daemonologist are manual options and never
// automatic candidates — verified with the production sheet resolver.
console.log("Test 21: Druid/Daemonologist available manually, excluded automatically");
resetWorld();
{
  const def = SKILL_DEFINITION_MAP.get("monster-knowledge-intelligence");
  const classes = [
    classItem("cls-sage", "Sage", 1),
    classItem("cls-druid", "Druid", 9),
    classItem("cls-daemonologist", "Daemonologist", 4)
  ];
  const resolved = resolveSkillClass({ classes, def, savedValue: "" });
  assert.equal(resolved.classId, "cls-sage", "automatic selection is the native Sage 1, never Druid 9");
  const optionLabels = resolved.options.map(o => o.label);
  assert.ok(optionLabels.includes("Druid"), "Druid present in the selector");
  assert.ok(optionLabels.includes("Daemonologist"), "Daemonologist present in the selector");
  const savedDruid = resolveSkillClass({ classes, def, savedValue: "cls-druid" });
  assert.equal(savedDruid.classId, "cls-druid", "manual Druid selection is preserved");
  const savedDaemonologist = resolveSkillClass({ classes, def, savedValue: "cls-daemonologist" });
  assert.equal(savedDaemonologist.classId, "cls-daemonologist", "manual Daemonologist selection is preserved");
  console.log("  ✓ PASS");
}

// Scenario 11 (roll flow): Druid higher level than all natives is never
// the automatic formula class.
console.log("Test 22: Higher-level Druid never auto-selected");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 3), classItem("cls-druid", "Druid", 9)]
  });
  const monster = makeMonster({ system: { weakness: 15, reputation: 10 } });
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[5, 4]]); // SV = 9 + Sage 3 + INT 2 = 14, not Druid 9 (= 20)

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.formulaClass?.className, "sage", "automatic formula is the native Sage");
  assert.equal(result.rollTotal, 9, "roll total = dice only (9)");
  const sage22 = result.individualResults.find(entry => entry.className === "sage");
  assert.equal(sage22.result, 14, "Sage result = dice 9 + Sage 3 + INT 2, never Druid 9");
  assert.deepEqual(result.usedClasses.map(c => c.className), ["sage"], "Druid is not a native candidate");
  console.log("  ✓ PASS");
}

// Scenario 12: Manual Druid selection must not treat Druid as a native
// automatic candidate nor suppress Sage's capabilities; Druid IS added to
// the evaluation (Monstrous Lore p. 21, Animals/Plants only).
console.log("Test 23: Manual Druid evaluation keeps native resolution intact");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 3), classItem("cls-druid", "Druid", 9)],
    system: { combat: { monsterKnowledgeClassId: "cls-druid" } }
  });
  const monster = makeMonster({ system: { monsterType: "Animal", weakness: 15, reputation: 10, species: "Wolf" } });
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[5, 4]]); // dice 9

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.equal(chatMessagesWithFlags.length, 1, "ONE dice roll, ONE message");
  assert.deepEqual(result.formulaClass?.className, "druid", "manual Druid selection shapes the roll");
  assert.deepEqual(result.usedClasses.map(c => c.className).sort(), ["druid", "sage"], "Druid evaluated alongside the native Sage");
  const sage23 = result.individualResults.find(entry => entry.className === "sage");
  const druid23 = result.individualResults.find(entry => entry.className === "druid");
  assert.equal(sage23.result, 14, "Sage result = 9 + Sage 3 + INT 2");
  assert.equal(druid23.result, 20, "Druid result = 9 + Druid 9 + INT 2 (same formula)");
  assert.deepEqual(result.discoveries.map(d => d.type).sort(), ["stats", "weakness"], "Sage capabilities intact, Druid also evaluated");
  assert.equal(isSpeciesWeaknessKnown("wolf"), true, "weakness registered");
  console.log("  ✓ PASS");
}

// ── Spell-class evaluation tests (Druid / Daemonologist, manual only) ─────

// Scenario 8: Manual Druid selection adds Druid to the evaluation alongside
// the applicable native classes, using `Druid level + Intelligence modifier`
// (no Nature Magic Power), Monstrous Lore p. 21.
console.log("Test 24: Manual Druid evaluated alongside Sage (Animal target)");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 3), classItem("cls-druid", "Druid", 9)],
    system: { combat: { monsterKnowledgeClassId: "cls-druid" } }
  });
  const beast = makeMonster({ system: { monsterType: "Animal", species: "Wolf", weakness: 12, reputation: 8 } });
  game.user.character = char;
  game.actors.push(char, beast);
  rollResults.push([[5, 4]]); // dice 9

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: beast });
  assert.equal(chatMessagesWithFlags.length, 1, "ONE dice roll, ONE message (Scenario 13)");
  assert.equal(rollFormula, "2d6", "Scenario 14: formula is dice only — no Nature Magic Power");
  assert.deepEqual(result.formulaClass?.className, "druid", "manual Druid shapes the roll display");
  assert.deepEqual(result.usedClasses.map(c => c.className).sort(), ["druid", "sage"], "Druid added alongside the native Sage");
  const sage24 = result.individualResults.find(entry => entry.className === "sage");
  const druid = result.individualResults.find(entry => entry.className === "druid");
  assert.equal(sage24.result, 14, "Sage result = 9 + Sage 3 + INT 2");
  assert.equal(druid.result, 20, "Druid result = 9 + Druid 9 + INT 2 (same formula)");
  assert.deepEqual(result.discoveries.map(d => d.type).sort(), ["stats", "weakness"], "stats + Weak Point resolved");
  // Both classes reach every threshold: the weakness tier is credited to
  // both, so the main result is the higher individual result (Druid).
  assert.equal(result.mainResult?.className, "druid", "main result: Druid (higher result, same top tier)");
  assert.equal(result.mainResult?.result, 20, "main result value 20");
  assert.ok(chatMessagesWithFlags[0].flavor.includes("sw25-mk-total"), "main result block on the card");
  assert.ok(chatMessagesWithFlags[0].flavor.includes("sw25-mk-class-results"), "individual results list on the card");
  console.log("  ✓ PASS");
}

// Scenario 9: Manual Daemonologist adds Daemonologist alongside Sage against
// a Daemon; classification is credited to Daemonologist ([Another's
// Knowledge], ML p. 41) with `Daemonologist level + Intelligence modifier`
// (no Summoning Arts Power).
console.log("Test 25: Manual Daemonologist evaluated alongside Sage (Daemon target)");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 3), classItem("cls-daemonologist", "Daemonologist", 4)],
    system: { combat: { monsterKnowledgeClassId: "cls-daemonologist" } }
  });
  const daemon = makeDaemon({ weakness: 20, reputation: 10 });
  game.user.character = char;
  game.actors.push(char, daemon);
  rollResults.push([[5, 4]]); // dice 9

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: daemon });
  assert.equal(chatMessagesWithFlags.length, 1, "ONE dice roll, ONE message");
  assert.equal(rollFormula, "2d6", "formula is dice only — no Summoning Arts Power");
  assert.deepEqual(result.formulaClass?.className, "daemonologist", "manual Daemonologist shapes the roll display");
  assert.deepEqual(result.usedClasses.map(c => c.className).sort(), ["daemonologist", "sage"], "Daemonologist added alongside Sage");
  const sage25 = result.individualResults.find(entry => entry.className === "sage");
  const daemonologist = result.individualResults.find(entry => entry.className === "daemonologist");
  assert.equal(sage25.result, 14, "Sage result = 9 + Sage 3 + INT 2");
  assert.equal(daemonologist.result, 15, "Daemonologist result = 9 + Daemonologist 4 + INT 2");
  // Sage 14 and Daemonologist 15 both reach Reputation 10: stats. The
  // classification is credited to the Daemonologist; no Weak Point (20).
  assert.deepEqual(result.discoveries.map(d => d.type).sort(), ["classification", "stats"], "stats + classification, no Weak Point");
  const classification = result.discoveries.find(d => d.type === "classification");
  assert.equal(classification.className, "daemonologist", "classification attributed to Daemonologist");
  const stats = result.discoveries.find(d => d.type === "stats");
  assert.equal(stats.className, "sage", "stats attributed to the first reaching class");
  // Main result: top tier is stats; among Sage 14 / Daemonologist 15 the
  // higher individual result wins.
  assert.equal(result.mainResult?.className, "daemonologist", "main result: Daemonologist 15");
  assert.equal(rollResults.length, 0, "Scenario 13: exactly one dice roll consumed");
  console.log("  ✓ PASS");
}

// Scenarios 11 & 12: independent class effects + main result selection.
// A lower individual result achieves a class-specific effect the higher
// result does not provide (Dark Hunter classification, automatic), and the
// main displayed result belongs to the class achieving the highest
// applicable EFFECT, not the biggest number.
console.log("Test 26: Independent effects — lower result class-specific effect");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 9), classItem("cls-dh", "Dark Hunter", 2)]
  });
  const daemon = makeDaemon({ weakness: 17, reputation: 13 });
  game.user.character = char;
  game.actors.push(char, daemon);
  rollResults.push([[3, 2]]); // dice 5

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: daemon });
  assert.equal(chatMessagesWithFlags.length, 1, "ONE dice roll, ONE message");
  const sage26 = result.individualResults.find(entry => entry.className === "sage");
  const dh26 = result.individualResults.find(entry => entry.className === "dark hunter");
  assert.equal(sage26.result, 16, "Sage result = 5 + Sage 9 + INT 2");
  assert.equal(dh26.result, 9, "Dark Hunter result = 5 + Dark Hunter 2 + INT 2");
  // Sage 16 >= Reputation 13: statistics; 16 < 17: no Weak Point.
  // Dark Hunter 9 < 13: no statistics, but classification is automatic.
  assert.deepEqual(result.discoveries.map(d => d.type).sort(), ["classification", "stats"], "both independent effects resolved");
  const discoveryBy = type => result.discoveries.find(d => d.type === type).className;
  assert.equal(discoveryBy("classification"), "dark hunter", "lower result (DH 9) provides classification");
  assert.equal(discoveryBy("stats"), "sage", "higher result (Sage 16) provides statistics");
  assert.deepEqual(result.mainResult?.className, "sage", "main result: Sage (stats tier above classification)");
  assert.equal(result.mainResult?.result, 16, "main result value 16");
  const flavor26 = chatMessagesWithFlags[0].flavor;
  assert.ok(flavor26.includes("sw25-mk-class-results"), "individual list present");
  assert.ok(flavor26.includes("Dark Hunter"), "lower individual result not discarded");
  console.log("  ✓ PASS");
}

// Scenario 12 (main-result rank): the main result belongs to the class
// achieving the highest applicable effect even when ANOTHER class has a
// bigger number: Rider (stats only) 19 vs Sage (Weak Point) 12.
console.log("Test 27: Main result = highest effect, not highest number");
resetWorld();
{
  const char = makeCharacter({
    items: [classItem("cls-sage", "Sage", 1), classItem("cls-rider", "Rider", 8)]
  });
  const monster = makeMonster({ system: { weakness: 12, reputation: 6, species: "Goblin Scout" } });
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[5, 4]]); // dice 9

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  const sage27 = result.individualResults.find(entry => entry.className === "sage");
  const rider27 = result.individualResults.find(entry => entry.className === "rider");
  assert.equal(sage27.result, 12, "Sage result = 9 + Sage 1 + INT 2");
  assert.equal(rider27.result, 19, "Rider result = 9 + Rider 8 + INT 2 (bigger number)");
  // Rider: stats only, never Weak Point (12 >= 6: stats). Sage 12 >= 12:
  // Weak Point (tier 3, above stats).
  assert.deepEqual(result.discoveries.map(d => d.type).sort(), ["stats", "weakness"], "both effects resolved independently");
  assert.equal(result.discoveries.find(d => d.type === "stats").className, "rider", "stats credited to Rider");
  assert.equal(result.discoveries.find(d => d.type === "weakness").className, "sage", "Weak Point credited to Sage");
  assert.equal(result.mainResult?.className, "sage", "main result: Sage (Weak Point beats stats tier)");
  assert.equal(result.mainResult?.result, 12, "main result value 12 — NOT Rider 19");
  // usedClasses order is level-desc (Rider 8 first): results [19, 12].
  assert.deepEqual(result.individualResults.map(entry => entry.result), [19, 12], "Rider 19 and Sage 12 both retained");
  console.log("  ✓ PASS");
}

// ── OBSERVER permission tests (Fase 4 model) ──────────────────────────────

// Test 28: Player Statistics discovery NEVER requests an Observer grant on the
// original Actor. Reputation is persisted through the GM relay instead, with
// the reputation level and the rolling character's attribution.
console.log("Test 28: Player Statistics persists Reputation via GM relay, no Observer grant");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  // weakness 25: Sage SV 17 reaches Reputation (8) but not Weakness, so only
  // one relay request (reputation) is expected.
  const monster = makeMonster({ system: { weakness: 25, reputation: 8, species: "Goblin" }, ownership: { default: 0 } });
  game.user.isGM = false;
  game.user.id = "player-1";
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[4, 4]]); // dice 8, SV = 8 + 3 + 2 = 13 >= reputation 8, < weakness 25

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats"], "stats discovered");
  const observerRequests = socketEmissions.filter(e => e.payload?.action === "mk-grant-observer");
  assert.equal(observerRequests.length, 0, "NO Observer ownership request on the original Actor (Fase 4)");
  assert.equal(monster.ownership.default, 0, "the original Actor's ownership is untouched");
  const relayRequests = socketEmissions.filter(e => e.payload?.action === "mk-discovery-request");
  assert.equal(relayRequests.length, 1, "the reputation discovery is relayed to the GM");
  assert.equal(relayRequests[0].payload.gid, "gm-user", "relay targets the active GM");
  assert.equal(relayRequests[0].payload.requesterId, "player-1", "relay carries the rolling player's id");
  assert.equal(relayRequests[0].payload.evidence.level, "reputation", "evidence level is reputation");
  assert.equal(relayRequests[0].payload.evidence.actorUuid, "Actor.hero-1", "evidence carries the rolling character's uuid");
  assert.equal(relayRequests[0].payload.evidence.actorName, "Hero", "evidence carries the rolling character's name");
  assert.equal(isSpeciesWeaknessKnown("Goblin"), false, "player client performs no local registry write");
  console.log("  ✓ PASS");
}

// Test 29: Player already at OBSERVER on the original: ownership stays, and
// the reputation discovery still goes through the relay (Fase 4: originals
// are never modified regardless of the player's effective permission).
console.log("Test 29: Already observable: originals untouched, relay carries the discovery");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  const monster = makeMonster({ system: { weakness: 25, reputation: 8, species: "Goblin" }, ownership: { default: 0, "player-1": 2 } });
  game.user.isGM = false;
  game.user.id = "player-1";
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[4, 4]]); // dice 8, SV = 8 + 3 + 2 = 13 >= reputation 8, < weakness 25

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats"], "stats discovered");
  assert.equal(socketEmissions.filter(e => e.payload?.action === "mk-grant-observer").length, 0, "no Observer request regardless of current permission");
  assert.equal(socketEmissions.filter(e => e.payload?.action === "mk-discovery-request").length, 1, "reputation discovery relayed");
  assert.deepEqual(monster.ownership, { default: 0, "player-1": 2 }, "ownership untouched, no pendingObserver flag changes");
  console.log("  ✓ PASS");
}

// Test 30: Player with higher explicit permission (OWNER) is not downgraded.
console.log("Test 30: Higher explicit permission preserved");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  const monster = makeMonster({ system: { weakness: 10, reputation: 8, species: "Goblin" }, ownership: { default: 0, "player-1": 3 } });
  game.user.isGM = false;
  game.user.id = "player-1";
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[6, 6]]);

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type).sort(), ["stats", "weakness"], "stats discovered");
  assert.equal(socketEmissions.filter(e => e.payload?.action === "mk-grant-observer").length, 0, "no socket request for OWNER player");
  assert.equal(monster.ownership["player-1"], 3, "OWNER entry not downgraded");
  console.log("  ✓ PASS");
}

// Test 31: Explicit per-user entries of other users survive; the legacy
// grant/withdraw ownership mutations no longer exist at all.
console.log("Test 31: Explicit per-user ownership entries survive untouched");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  const monster = makeMonster({
    system: { weakness: 25, reputation: 8, species: "Goblin" },
    ownership: { default: 0, "player-abc": 3 }
  });
  game.user.isGM = false;
  game.user.id = "player-1";
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[4, 4]]); // dice 8, SV = 8 + 3 + 2 = 13 >= reputation 8, < weakness 25

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats"], "stats discovered");
  assert.equal(socketEmissions.filter(e => e.payload?.action === "mk-grant-observer").length, 0, "no Observer ownership flow exists");
  assert.deepEqual(monster.ownership, { default: 0, "player-abc": 3 }, "ownership object deeply unchanged");
  console.log("  ✓ PASS");
}

// Test 32: Weak Point only (no Statistics) does not request OBSERVER.
console.log("Test 32: Weak Point only does not grant OBSERVER");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  // reputation 25, weakness 10: SV 20 reaches Weakness but not Reputation.
  const monster = makeMonster({ system: { weakness: 10, reputation: 25, species: "Ogre" }, ownership: { default: 0 } });
  game.user.isGM = false;
  game.user.id = "player-1";
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[10, 5]]); // dice 15, SV = 15 + 3 + 2 = 20 >= weakness 10, < reputation 25

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), ["weakness"], "only Weak Point discovered");
  // F2-T1: the player roll reaches weakness threshold and the discovery is
  // handed to the connected GM through the MK relay. The mock's socket
  // round-trip answers the ack but never executes the GM-side write, so the
  // player client still does not persist anything locally — the registry
  // write only ever happens on the GM client (GM-authoritative persistence).
  const relayRequests = socketEmissions.filter(e => e.payload?.action === "mk-discovery-request");
  assert.equal(relayRequests.length, 1, "weakness discovery is relayed to the GM");
  assert.equal(relayRequests[0].payload.gid, "gm-user", "relay targets the active GM");
  assert.equal(relayRequests[0].payload.requesterId, "player-1", "relay carries the rolling player's id");
  assert.equal(relayRequests[0].payload.evidence.discoveredBy, "player-1", "discoveredBy is the rolling player");
  assert.equal(isSpeciesWeaknessKnown("Ogre"), false, "player client performs no local registry write");
  assert.equal(socketEmissions.filter(e => e.payload?.action === "mk-grant-observer").length, 0, "no OBSERVER request without Statistics");
  assert.equal(monster.ownership.default, 0, "ownership unchanged");
  console.log("  ✓ PASS");
}

// Test 33: No Statistics discovery: failed Reputation does not request OBSERVER.
console.log("Test 33: No Statistics discovery: ownership unchanged");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  const monster = makeMonster({ system: { weakness: 15, reputation: 20, species: "Orc" }, ownership: { default: 0 } });
  game.user.isGM = false;
  game.user.id = "player-1";
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[3, 3]]); // dice 6, SV = 6 + 3 + 2 = 11 < reputation 20, < weakness 15

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), [], "no discoveries");
  assert.equal(socketEmissions.filter(e => e.payload?.action === "mk-grant-observer" || e.payload?.action === "mk-discovery-request").length, 0, "no OBSERVER or relay request");
  assert.equal(monster.ownership.default, 0, "ownership unchanged");
  console.log("  ✓ PASS");
}

// Test 34: Stats by any eligible class (Sage or Rider) persists Reputation
// through the GM relay; a single reputation discovery per roll.
console.log("Test 34: Stats by any eligible class relays reputation once");
resetWorld();
{
  const char = makeCharacter(); // Sage 3 + Rider 2
  const monster = makeMonster({ system: { weakness: 25, reputation: 8, species: "Goblin" }, ownership: { default: 0 } });
  game.user.isGM = false;
  game.user.id = "player-1";
  game.user.character = char;
  game.actors.push(char, monster);
  rollResults.push([[4, 4]]); // dice 8, Sage SV = 8 + 3 + 2 = 13 >= 8; Rider SV = 8 + 2 + 2 = 12 >= 8

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type).sort(), ["stats"], "stats discovered (Sage and/or Rider)");
  const relayRequests = socketEmissions.filter(e => e.payload?.action === "mk-discovery-request");
  assert.equal(relayRequests.length, 1, "a single reputation discovery per roll regardless of class count");
  assert.equal(relayRequests[0].payload.evidence.level, "reputation", "evidence level is reputation");
  assert.equal(socketEmissions.filter(e => e.payload?.action === "mk-grant-observer").length, 0, "no Observer ownership request");
  console.log("  ✓ PASS");
}

// Test 35: GM Statistics discovery resolves without any Observer grant attempt.
console.log("Test 35: GM Statistics discovery: no grant, no socket request");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-rider" } } });
  const monster = makeMonster({ system: { weakness: 20, reputation: 8, species: "Goblin" }, ownership: { default: 0 } });
  game.actors.push(char, monster);
  rollResults.push([[4, 3]]); // dice 7, Rider SV = 7 + 2 + 2 = 11 >= 8 stats; < weakness 20

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats"], "Statistics discovered by GM roll");
  assert.equal(socketEmissions.length, 0, "no socket request for GM roll");
  assert.deepEqual(monster.ownership, { default: 0 }, "ownership untouched for GM roll");
  assert.equal(actorUpdates.some(u => u.ownership !== undefined), false, "no ownership update issued for GM roll");
  console.log("  ✓ PASS");
}

// Test 36: GM Weak Point discovery registers in the persistent registry.
console.log("Test 36: GM Weak Point discovery registers in persistent registry");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  // reputation 25, weakness 10: SV 20 reaches Weakness but not Reputation.
  const monster = makeMonster({ system: { weakness: 10, reputation: 25, species: "Ogre" }, ownership: { default: 0 } });
  game.actors.push(char, monster);
  rollResults.push([[10, 5]]); // dice 15, Sage SV = 15 + 3 + 2 = 20 >= weakness 10, < reputation 25

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), ["weakness"], "only Weak Point discovered by GM");
  assert.equal(isSpeciesWeaknessKnown("Ogre"), true, "Weak Point registered in persistent registry for GM discovery");
  assert.equal(socketEmissions.length, 0, "no OBSERVER request for GM roll");
  assert.deepEqual(monster.ownership, { default: 0 }, "ownership untouched for GM roll");
  console.log("  ✓ PASS");
}

// Test 37: GM Statistics + Weak Point: both effects resolve, no grant attempted.
console.log("Test 37: GM stats + Weak Point both resolve, no grant");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  const monster = makeMonster({ system: { weakness: 10, reputation: 8, species: "Goblin" }, ownership: { default: 0 } });
  game.actors.push(char, monster);
  rollResults.push([[6, 6]]); // automatic success, SV = 12 + 3 + 2 = 17 >= 8

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats", "weakness"], "both effects resolve for GM roll");
  assert.equal(isSpeciesWeaknessKnown("Goblin"), true, "Weak Point registered for GM discovery");
  assert.equal(socketEmissions.length, 0, "no socket request for GM roll");
  assert.deepEqual(monster.ownership, { default: 0 }, "no ownership change for GM roll");
  console.log("  ✓ PASS");
}

// Test 38: GM failed roll registers nothing and requests nothing.
console.log("Test 38: GM failed roll registers nothing");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  const monster = makeMonster({ system: { weakness: 15, reputation: 20, species: "Orc" }, ownership: { default: 0 } });
  game.actors.push(char, monster);
  rollResults.push([[3, 3]]); // dice 6, SV = 6 + 3 + 2 = 11 < reputation 20, < weakness 15

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), [], "no discoveries on failed GM roll");
  assert.equal(isSpeciesWeaknessKnown("Orc"), false, "nothing registered on failed GM roll");
  assert.equal(socketEmissions.length, 0, "no OBSERVER request");
  assert.deepEqual(monster.ownership, { default: 0 }, "ownership untouched");
  console.log("  ✓ PASS");
}

// Test 39: Player roll without a connected GM is not performed at all:
// informative notice, no roll, no socket emission, no pending request.
console.log("Test 39: Player roll without a connected GM does not happen");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  const monster = makeMonster({ system: { weakness: 10, reputation: 8, species: "Goblin" }, ownership: { default: 0 } });
  game.user.isGM = false;
  game.user.id = "player-1";
  game.user.character = char;
  gameUsers.length = 0; // no user at all: no active GM
  game.actors.push(char, monster);
  rollResults.push([[6, 6]]); // would be an automatic success if the roll happened

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.equal(result.status, "no-gm", "roll refuses with an explicit no-gm status");
  assert.deepEqual(result.phases, { dialog: false, roll: false }, "dialog and roll phases never start");
  assert.ok(warnings.some(w => String(w).includes("Game Master")), "informative notice about the missing GM is shown");
  assert.equal(socketEmissions.length, 0, "nothing is emitted: no relay request, no OBSERVER request");
  assert.equal(pendingMkRelayRequestCount(), 0, "no pending relay request is created");
  assert.equal(isSpeciesWeaknessKnown("Goblin"), false, "no local write happened");
  assert.deepEqual(monster.ownership, { default: 0 }, "ownership untouched");
  console.log("  ✓ PASS");
}

// Test 40: GM Statistics discovery persists a Reputation record with level
// and the rolling character's attribution; no ownership changes anywhere.
console.log("Test 40: GM Reputation discovery persists with level and character attribution");
resetWorld();
{
  const char = makeCharacter({ system: { combat: { monsterKnowledgeClassId: "cls-sage" } } });
  const monster = makeMonster({ system: { weakness: 25, reputation: 8, species: "Lamia" }, ownership: { default: 0 } });
  game.actors.push(char, monster);
  rollResults.push([[4, 4]]); // dice 8, Sage SV 13 >= reputation 8, < weakness 25 (stats only)

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats"], "Statistics discovered by GM roll");
  const discoveries = readMkDiscoveries();
  assert.equal(discoveries.ok, true, "registry readable");
  const records = discoveries.data.filter(d => d.speciesId === "lamia");
  assert.equal(records.length, 1, "exactly one reputation discovery registered");
  assert.equal(records[0].level, "reputation", "level is reputation (weakness must not be forced)");
  assert.equal(records[0].actorUuid, "Actor.hero-1", "discovering character uuid persisted");
  assert.equal(records[0].actorName, "Hero", "discovering character name persisted");
  assert.equal(records[0].source, "roll", "source is the roll origin");
  assert.equal(socketEmissions.filter(e => e.payload?.action === "mk-grant-observer").length, 0, "no Observer ownership request on the original");
  assert.deepEqual(monster.ownership, { default: 0 }, "original Actor ownership untouched");
  console.log("  ✓ PASS");
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log("\n=== All Monster Knowledge roll integration tests passed ===");
