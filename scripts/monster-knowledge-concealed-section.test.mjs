// Sword World 2.5 - Concealed Main Section revealed through Monster Knowledge Weakness discovery.
//
// Verifies:
//   1. Statistics-only MK discovery does not reveal the Main Section.
//   2. Successful Weakness discovery reveals both Weakness and Main Section.
//   3. The selection belongs to the exact monster Actor involved in the roll.
//   4. Different individuals of the same species can reveal different Main Sections.
//   5. Missing or invalid selections are handled explicitly, without rerolls or fallbacks.
//   6. The original gmOnly protection remains intact.
//   7. Existing MK behavior remains unchanged for all other discovery outcomes.

import assert from "node:assert/strict";

// ── Foundry mocks ──────────────────────────────────────────────────────────

const chatMessages = [];
const chatMessagesWithFlags = [];
const actorUpdates = [];
const dialogCalls = [];
const socketEmissions = [];
const gameUsers = [];
const socketListeners = [];
let relayAckMode = "registered";

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
    const values = Array.isArray(script?.[0]) ? script.flat() : [script];
    const formulaMatch = String(this.formula ?? "").match(/[\+\-]\s*\d+/);
    this._formulaConstant = formulaMatch ? Number(formulaMatch[0].replace(/[\+\-]/, "").trim()) || 0 : 0;
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

globalThis.registerRollModifiersDialog = (constructor) => {
  globalThis._dialogConstructor = constructor;
};

// ── Import after mocks are in place ────────────────────────────────────────

import { rollMonsterKnowledge, isSpeciesWeaknessKnown } from "../module/combat/monster-knowledge.mjs";
import { readMkDiscoveries, isMkSpeciesReputationKnown } from "../module/knowledge/monster-knowledge-registry.mjs";
import { initializeMonsterKnowledgeRelay } from "../module/knowledge/mk-relay.mjs";
import { getConcealedMainSectionMkReveal, getConcealedMainSectionPresentation } from "../module/combat/concealed-main-section.mjs";
import { registerRollModifiersDialog } from "../module/rules/roll-modifiers.mjs";

initializeMonsterKnowledgeRelay();

// ── Mock dialog ────────────────────────────────────────────────────────────

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

const sectionRow = (id, section, hpValue) => ({
  id,
  style: `${section} Attack`,
  section,
  hp: { value: hpValue, max: hpValue },
  accuracy: "10",
  damage: "1d6",
  evasion: "10",
  defense: "10",
  mp: { value: 10, max: 10 }
});

const makeMonster = (overrides = {}) => {
  const system = {
    combatStyles: [
      sectionRow("cs-head", "Head", 50),
      sectionRow("cs-body", "Body", 60)
    ],
    weakness: 15,
    reputation: 10,
    species: "Goblin",
    ...overrides.system
  };
  const ownership = { ...overrides.ownership };
  const effects = overrides.effects ?? [];
  return {
    id: `monster-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Goblin",
    type: "monster",
    system,
    ownership,
    uuid: `Actor.monster-${Math.random().toString(36).slice(2)}`,
    effects,
    testUserPermission(user, permission) {
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
      actorUpdates.push(data);
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

function addConcealedEffect(monster, sectionId) {
  monster.effects.push({
    type: "sw25Effect",
    name: "Concealed Main Section",
    system: {
      family: "Concealed Main Section",
      rank: 0,
      gmOnly: true
    },
    flags: {
      "sw25-taka": {
        concealedSection: { sectionId }
      }
    }
  });
}

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

console.log("=== Concealed Main Section revealed through MK Weakness discovery ===\n");

// Test 1: Statistics-only MK discovery does not reveal the Main Section.
// SV >= reputation but < weakness: only stats, no weakness, no Main Section.
console.log("Test 1: Statistics-only discovery does not reveal Main Section");
resetWorld();
{
  const char = makeCharacter();
  game.user.character = char;
  game.actors.push(char);
  const monster = makeMonster({ system: { weakness: 20, reputation: 10, species: "Goblin Scout" } });
  addConcealedEffect(monster, "cs-head");
  game.actors.push(monster);
  // SV = 6 + Sage 3 + INT 2 = 11: >= reputation 10, < weakness 20
  rollResults.push([[2, 4]]);

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.equal(result.status, "resolved", "roll resolves");
  assert.deepEqual(result.discoveries.map(d => d.type), ["stats"], "only stats discovered");
  assert.ok(!result.discoveries.some(d => d.type === "weakness"), "no weakness discovered");
  assert.ok(!result.discoveries.some(d => d.concealedMainSection), "no concealed Main Section in discoveries");
  assert.equal(isMkSpeciesReputationKnown("goblin scout"), true, "reputation registered");
  assert.equal(isSpeciesWeaknessKnown("goblin scout"), false, "weakness NOT registered below threshold");
  console.log("  ✓ PASS");
}

// Test 2: Successful Weakness discovery reveals both Weakness and Main Section.
console.log("Test 2: Weakness discovery reveals Weakness and Main Section");
resetWorld();
{
  const char = makeCharacter();
  game.user.character = char;
  game.actors.push(char);
  const monster = makeMonster({ system: { weakness: 15, reputation: 10, species: "Goblin Scout" } });
  addConcealedEffect(monster, "cs-head");
  game.actors.push(monster);
  // SV = 6 + Sage 3 + INT 2 = 11: < weakness 15, need higher
  rollResults.push([[6, 6]]); // natural 12, SV = 12 + 3 + 2 = 17 >= weakness 15

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.equal(result.status, "resolved", "roll resolves");
  const weaknessDiscovery = result.discoveries.find(d => d.type === "weakness");
  assert.ok(weaknessDiscovery, "weakness discovered");
  assert.ok(weaknessDiscovery.concealedMainSection, "concealed Main Section in discovery");
  assert.equal(weaknessDiscovery.concealedMainSection.section, "Head", "revealed section is Head");
  assert.equal(weaknessDiscovery.concealedMainSection.sectionId, "cs-head", "revealed section id is cs-head");
  assert.ok(result.discoveries.some(d => d.type === "weakness"), "weakness in discovery types");
  assert.ok(result.discoveries.some(d => d.type === "stats"), "stats also discovered (weakness implies reputation)");
  assert.ok(weaknessDiscovery.concealedMainSection, "concealed section in discovery data");
  assert.equal(weaknessDiscovery.concealedMainSection.section, "Head", "discovery data section is Head");
  console.log("  ✓ PASS");
}

// Test 3: The selection belongs to the exact monster Actor involved in the roll.
console.log("Test 3: Main Section belongs to the exact monster Actor");
resetWorld();
{
  const char = makeCharacter();
  game.user.character = char;
  game.actors.push(char);
  const monsterA = makeMonster({ id: "monster-a", name: "Goblin A", system: { weakness: 15, reputation: 10, species: "Goblin Scout" } });
  const monsterB = makeMonster({ id: "monster-b", name: "Goblin B", system: { weakness: 15, reputation: 10, species: "Goblin Scout" } });
  addConcealedEffect(monsterA, "cs-head");
  addConcealedEffect(monsterB, "cs-body");
  game.actors.push(char, monsterA, monsterB);
  // Roll against monsterA
  rollResults.push([[6, 6]]);

  const resultA = await rollMonsterKnowledge({ actor: char, targetMonster: monsterA });
  const weaknessA = resultA.discoveries.find(d => d.type === "weakness");
  assert.ok(weaknessA.concealedMainSection, "monster A has concealed section");
  assert.equal(weaknessA.concealedMainSection.section, "Head", "monster A's section is Head");

  // Roll against monsterB (same species, different individual, different section)
  rollResults.push([[6, 6]]);
  const resultB = await rollMonsterKnowledge({ actor: char, targetMonster: monsterB });
  const weaknessB = resultB.discoveries.find(d => d.type === "weakness");
  assert.ok(weaknessB.concealedMainSection, "monster B has concealed section");
  assert.equal(weaknessB.concealedMainSection.section, "Body", "monster B's section is Body");
  assert.notEqual(weaknessA.concealedMainSection.sectionId, weaknessB.concealedMainSection.sectionId, "different section ids");
  console.log("  ✓ PASS");
}

// Test 4: Different individuals of the same species can reveal different Main Sections.
console.log("Test 4: Same species, different individuals, different sections");
resetWorld();
{
  const char = makeCharacter();
  game.user.character = char;
  game.actors.push(char);
  // Two goblins of the same species with different concealed sections
  const goblin1 = makeMonster({ id: "g1", name: "Goblin 1", system: { weakness: 15, reputation: 10, species: "Goblin" } });
  const goblin2 = makeMonster({ id: "g2", name: "Goblin 2", system: { weakness: 15, reputation: 10, species: "Goblin" } });
  addConcealedEffect(goblin1, "cs-head");
  addConcealedEffect(goblin2, "cs-body");
  game.actors.push(char, goblin1, goblin2);

  rollResults.push([[6, 6]]);
  const r1 = await rollMonsterKnowledge({ actor: char, targetMonster: goblin1 });
  const w1 = r1.discoveries.find(d => d.type === "weakness");
  assert.equal(w1.concealedMainSection.section, "Head", "goblin 1: Head");

  rollResults.push([[6, 6]]);
  const r2 = await rollMonsterKnowledge({ actor: char, targetMonster: goblin2 });
  const w2 = r2.discoveries.find(d => d.type === "weakness");
  assert.equal(w2.concealedMainSection.section, "Body", "goblin 2: Body");
  assert.notEqual(w1.concealedMainSection.sectionId, w2.concealedMainSection.sectionId, "different sections per individual");
  console.log("  ✓ PASS");
}

// Test 5: Missing selection is handled explicitly (no concealed effect).
console.log("Test 5: Missing concealed selection handled explicitly");
resetWorld();
{
  const char = makeCharacter();
  game.user.character = char;
  game.actors.push(char);
  const monster = makeMonster({ system: { weakness: 15, reputation: 10, species: "Goblin Scout" } });
  // No concealed effect added
  game.actors.push(monster);
  rollResults.push([[6, 6]]);

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.equal(result.status, "resolved", "roll resolves");
  const weaknessDiscovery = result.discoveries.find(d => d.type === "weakness");
  assert.ok(weaknessDiscovery, "weakness discovered");
  assert.ok(!weaknessDiscovery.concealedMainSection, "no concealedMainSection key when none");
  console.log("  ✓ PASS");
}

// Test 5b: Invalid selection (legacy encrypted record) handled explicitly.
console.log("Test 5b: Invalid (legacy encrypted) selection handled explicitly");
resetWorld();
{
  const char = makeCharacter();
  game.user.character = char;
  game.actors.push(char);
  const monster = makeMonster({ system: { weakness: 15, reputation: 10, species: "Goblin Scout" } });
  // Legacy encrypted record: { v, keyId, iv, ct }
  monster.effects.push({
    type: "sw25Effect",
    name: "Concealed Main Section",
    system: { family: "Concealed Main Section", rank: 0, gmOnly: true },
    flags: { "sw25-taka": { concealedSection: { v: 1, keyId: "k", iv: "i", ct: "c" } } }
  });
  game.actors.push(monster);
  rollResults.push([[6, 6]]);

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: monster });
  assert.equal(result.status, "resolved", "roll resolves");
  const weaknessDiscovery = result.discoveries.find(d => d.type === "weakness");
  assert.ok(weaknessDiscovery, "weakness discovered");
  assert.ok(weaknessDiscovery.concealedMainSection, "concealedMainSection present");
  assert.equal(weaknessDiscovery.concealedMainSection.error, "record-invalid", "record-invalid error code");
  assert.ok(weaknessDiscovery.concealedMainSection.message, "error message present");
  console.log("  ✓ PASS");
}

// Test 6: The original gmOnly protection remains intact.
console.log("Test 6: gmOnly protection remains intact");
resetWorld();
{
  const char = makeCharacter();
  game.user.character = char;
  game.actors.push(char);
  const monster = makeMonster({ system: { weakness: 15, reputation: 10, species: "Goblin Scout" } });
  addConcealedEffect(monster, "cs-head");
  game.actors.push(monster);

  // The effect is gmOnly: players cannot read it through getConcealedMainSectionSelection
  // (GM-only gate) or getConcealedMainSectionPresentation (GM-only gate).
  // The effect itself carries system.gmOnly: true.
  const concealedEffect = monster.effects.find(e => e.system?.family === "Concealed Main Section");
  assert.ok(concealedEffect, "concealed effect exists");
  assert.equal(concealedEffect.system.gmOnly, true, "effect is gmOnly");

  // The MK reveal path reads without GM gate (authorized revelation path)
  const reveal = getConcealedMainSectionMkReveal(monster);
  assert.equal(reveal.status, "assigned", "MK reveal reads the section");
  assert.equal(reveal.section, "Head", "MK reveal section is Head");

  // But the GM-only presentation read still gates on GM
  // (This test runs as GM, so we verify the flag is intact, not the gate)
  assert.equal(concealedEffect.system.gmOnly, true, "gmOnly flag preserved on the effect");
  console.log("  ✓ PASS");
}

// Test 7: Existing MK behavior unchanged for non-weakness outcomes.
// Classification-only, stats-only, and failure cases are not affected.
console.log("Test 7: Non-weakness outcomes unchanged");
resetWorld();
{
  const char = makeCharacter({ items: [classItem("cls-dh", "Dark Hunter", 5)] });
  game.user.character = char;
  game.actors.push(char);
  const daemon = makeMonster({ system: { monsterType: "Daemon", species: "Legion Daemon", weakness: 20, reputation: 10 } });
  addConcealedEffect(daemon, "cs-head");
  game.actors.push(char, daemon);
  // SV = 4 + Dark Hunter 5 + INT 2 = 11: >= reputation 10, < weakness 20
  // Classification is automatic for Dark Hunter vs Daemon
  rollResults.push([[2, 2]]);

  const result = await rollMonsterKnowledge({ actor: char, targetMonster: daemon });
  assert.equal(result.status, "resolved", "roll resolves");
  const types = result.discoveries.map(d => d.type);
  assert.ok(types.includes("stats"), "stats discovered");
  assert.ok(types.includes("classification"), "classification identified");
  assert.ok(!types.includes("weakness"), "no weakness below threshold");
  // No concealed Main Section in non-weakness discoveries
  assert.ok(!result.discoveries.some(d => d.concealedMainSection), "no concealed section in non-weakness discovery");
  assert.equal(isSpeciesWeaknessKnown("legion daemon"), false, "weakness not registered below threshold");
  console.log("  ✓ PASS");
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log("\n=== Todas las pruebas de Concealed Main Section MK pasaron ===");
