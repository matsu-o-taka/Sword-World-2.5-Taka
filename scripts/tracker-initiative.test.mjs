// Sword World 2.5 - Native tracker initiative interception tests
//
// Covers:
//   characterInitiativeModifier (shared sheet-parity calculation):
//     - Saved Scout class + Agility bonus + saved bonus
//     - Saved selection invalid â†’ automatic highest-level fallback
//     - No Scout/Tactician â†’ ability modifier never added (RAW)
//     - Agility score from abilityBases + abilityAdjustments (floor/6)
//   rollCharacterTrackerInitiative (native tracker dice for characters):
//     - 2d6 + modifier roll, chat message, initiative on all combatants
//     - Critical failure parity with the sheet button
//     - Non-character combatants are refused
//   resolveTrackerRollAction (native tracker actions under Side rules):
//     - "rollInitiative": characters roll, monsters get fixed value (no dice),
//       other types untouched (inert native formula)
//     - "rollAll": every character rolls, every monster gets fixed value
//     - "rollNPC": only monsters receive fixed values
//     - Unknown actions/actions without a valid combatant â†’ native fallback
//   No 2d6 is ever rolled for monsters through the tracker path.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// â”€â”€ Foundry mocks (defined before importing the module) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const chatMessages = [];
const warnings = [];
const infos = [];
const rollLog = [];

globalThis.ChatMessage = {
  async create(data) { chatMessages.push(data.content ?? JSON.stringify(data)); return { id: `msg-${chatMessages.length}` }; },
  getSpeaker({ actor } = {}) { return { actor: actor?.id ?? null }; },
  getWhisperRecipients() { return []; },
};

globalThis.ui = {
  notifications: {
    warn(message) { warnings.push(message); },
    info(message) { infos.push(message); },
    error() {},
  },
  combat: undefined,
};

globalThis.foundry = {
  utils: {
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    },
    mergeObject: (a, b) => ({ ...a, ...b }),
    deepClone: value => structuredClone(value),
  },
};

const combatRegistry = new Map();

globalThis.game = {
  user: { isGM: true, id: "user-gm" },
  users: { get: () => ({ id: "user-gm" }) },
  socket: { emit() {} },
  combats: { get: id => combatRegistry.get(id) },
  combat: null,
  actors: { get: () => null },
  settings: { get() { return {}; } },
};

globalThis.Application = class { render() {} async close() {} };

let rollScripts = [];

class MockRoll {
  constructor(formula) {
    this.formula = formula;
    rollLog.push(formula);
    this._script = rollScripts.shift() ?? [3, 4];
    this._total = 0;
  }

  async evaluate() {
    const values = Array.isArray(this._script) ? this._script : [this._script];
    this.dice = [{ results: values.map(v => ({ result: Number(v), active: true })) }];
    const m = String(this.formula).match(/2d6 \+ (-?\d+)/);
    const modifier = m ? Number(m[1]) : 0;
    this._total = values.reduce((a, b) => a + b, 0) + modifier;
    return this;
  }

  get total() { return this._total; }

  async toMessage({ flavor } = {}) {
    chatMessages.push(JSON.stringify({ flavor, rollTotal: this.total }));
    return { id: `msg-${chatMessages.length}` };
  }
}

globalThis.Roll = MockRoll;

// â”€â”€ Import after mocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const {
  characterInitiativeModifier,
  rollCharacterTrackerInitiative,
  resolveTrackerRollAction,
} = await import("../module/combat/side-initiative.mjs");

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let idCounter = 0;

function classItem(id, name, level) {
  return { id, name, type: "class", system: { level } };
}

function makeCharacter(id, { classes = [], system = {} } = {}) {
  return {
    id,
    type: "character",
    name: id,
    system,
    items: [...classes],
    isToken: false,
    async update() { return this; },
    getFlag: () => undefined,
  };
}

function makeMonster(id, initiative) {
  return { id, type: "monster", name: id, system: { initiative }, getFlag: () => undefined };
}

function makeCombatant({ actor, initiative = null, defeated = false }) {
  return {
    id: `cb-${++idCounter}`,
    name: actor.name,
    initiative,
    defeated,
    actor,
  };
}

const setCalls = [];

function makeCombat({ players = [], monsters = [], others = [], state = null, round = 1 } = {}) {
  const flags = new Map();
  if (state) flags.set("sideInitiative", structuredClone(state));
  const combat = {
    id: "combat-1",
    round,
    turn: null,
    started: true,
    combatants: [...players, ...monsters, ...others],
    getFlag(scope, key) { return flags.get(key); },
    async setFlag(scope, key, value) { flags.set(key, structuredClone(value)); },
    async startCombat() { this.started = true; },
    async update(data) { Object.assign(this, data); },
    async setInitiative(id, value) {
      const combatant = this.combatants.find(c => c.id === id);
      if (!combatant) throw new Error(`unknown combatant ${id}`);
      combatant.initiative = Number(value);
      setCalls.push([id, Number(value)]);
    },
  };
  // Foundry's Combat.combatants is a Collection; mirror the .get() lookup.
  combat.combatants.get = id => combat.combatants.find(c => c.id === id) ?? null;
  combatRegistry.set(combat.id, combat);
  return combat;
}

// â”€â”€ 1. characterInitiativeModifier â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log("=== 1. characterInitiativeModifier ===");

// 1a. Saved Scout class + Agility bonus + saved bonus
{
  const actor = makeCharacter("pc-1", {
    classes: [classItem("c-scout", "Scout", 4), classItem("c-fighter", "Fighter", 5)],
    system: {
      abilityBases: { skill: 8 },
      abilityAdjustments: { b: { growth: 1, correction: 0, temporary: 0 } },
      combat: { initiativeClassId: "c-scout", initiativeBonus: 1 }
    }
  });
  // Agility score = 8 + 1 = 9 â†’ bonus floor(9/6) = 1; modifier = 4 + 1 + 1 = 6
  assert.equal(characterInitiativeModifier(actor), 6, "Scout Lv4 + Agility bonus 1 + bonus 1 = 6");
}

// 1b. Saved selection invalid â†’ automatic highest-level fallback
{
  const actor = makeCharacter("pc-2", {
    classes: [classItem("c-scout", "Scout", 3), classItem("c-tactician", "Tactician", 6)],
    system: {
      abilityBases: { skill: 7 },
      abilityAdjustments: {},
      combat: { initiativeClassId: "c-scout", initiativeBonus: 0 }
    }
  });
  // Saved c-scout IS valid (Scout owned) â†’ level 3; agility floor(7/6)=1
  assert.equal(characterInitiativeModifier(actor), 4, "saved Scout Lv3 + Agility 1 = 4");

  const actor2 = makeCharacter("pc-2b", {
    classes: [classItem("c-scout", "Scout", 3), classItem("c-tactician", "Tactician", 6)],
    system: {
      abilityBases: { skill: 7 },
      abilityAdjustments: {},
      combat: { initiativeClassId: "c-unknown", initiativeBonus: 0 }
    }
  });
  // Saved selection no longer valid â†’ highest-level valid class (Tactician 6)
  assert.equal(characterInitiativeModifier(actor2), 7, "invalid saved selection falls back to Tactician Lv6 + Agility 1");
}

// 1c. No Scout/Tactician â†’ bonus only (ability modifier never added, RAW)
{
  const actor = makeCharacter("pc-3", {
    classes: [classItem("c-fighter", "Fighter", 5)],
    system: {
      abilityBases: { skill: 12 },
      abilityAdjustments: {},
      combat: { initiativeBonus: 2 }
    }
  });
  assert.equal(characterInitiativeModifier(actor), 2, "no class: bonus 2 only, agility never added");
}

// 1d. Tactician saved selection is honored like the sheet does
{
  const actor = makeCharacter("pc-4", {
    classes: [classItem("c-tactician", "Tactician", 7)],
    system: {
      abilityBases: { skill: 6 },
      abilityAdjustments: { b: { growth: 2, correction: 3, temporary: 1 } },
      combat: { initiativeClassId: "c-tactician", initiativeBonus: 0 }
    }
  });
  // Agility score = 6+2+3+1 = 12 â†’ bonus 2; modifier = 7 + 2 = 9
  assert.equal(characterInitiativeModifier(actor), 9, "Tactician Lv7 + Agility bonus 2 = 9");
}

// â”€â”€ 2. rollCharacterTrackerInitiative â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log("=== 2. rollCharacterTrackerInitiative ===");

// 2a. 2d6 + modifier, chat message, initiative on all combatants of the actor
{
  const actor = makeCharacter("pc-1", {
    classes: [classItem("c-scout", "Scout", 4)],
    system: {
      abilityBases: { skill: 6 },
      abilityAdjustments: {},
      combat: { initiativeClassId: "c-scout", initiativeBonus: 0 }
    }
  });
  const c1 = makeCombatant({ actor });
  const c2 = makeCombatant({ actor });
  const combat = makeCombat({ players: [c1, c2] });
  game.combat = combat;
  rollLog.length = 0;
  rollScripts = [[5, 3]];
  const result = await rollCharacterTrackerInitiative(c1);
  assert.equal(result, true, "handled");
  assert.equal(rollLog[0], "2d6 + 5", "formula is 2d6 + Scout Lv4 + Agility bonus 1");
  assert.equal(c1.initiative, 13, "combatant 1 receives roll total");
  assert.equal(c2.initiative, 13, "combatant 2 (same actor) receives roll total");
  assert.match(chatMessages.at(-1), /Initiative Check/, "chat flavor is Initiative Check");
}

// 2b. Critical failure parity with the sheet button
{
  const actor = makeCharacter("pc-5", { classes: [], system: { combat: {} } });
  const c = makeCombatant({ actor });
  makeCombat({ players: [c] });
  game.combat = combatRegistry.get("combat-1");
  rollScripts = [[1, 1]];
  const result = await rollCharacterTrackerInitiative(c);
  assert.equal(result, true, "handled");
  assert.match(chatMessages.at(-1), /CRITICAL FAILURE/, "critical failure flagged like the sheet roll");
}

// 2c. Non-character combatants are refused
{
  const npcActor = { id: "npc-1", type: "npc", name: "npc-1", system: {}, items: [] };
  const c = makeCombatant({ actor: npcActor });
  rollLog.length = 0;
  const result = await rollCharacterTrackerInitiative(c);
  assert.equal(result, false, "non-character refused");
  assert.equal(rollLog.length, 0, "no dice rolled for non-characters");
}

// â”€â”€ 3. resolveTrackerRollAction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log("=== 3. resolveTrackerRollAction ===");

// 3a. rollInitiative: character rolls, monster gets fixed value without dice
{
  const pc = makeCharacter("pc-1", {
    classes: [classItem("c-scout", "Scout", 4)],
    system: { abilityBases: { skill: 6 }, abilityAdjustments: {}, combat: { initiativeClassId: "c-scout", initiativeBonus: 0 } }
  });
  const p1 = makeCombatant({ actor: pc });
  const monActor = makeMonster("m-orc", 9);
  const m1 = makeCombatant({ actor: monActor });
  const combat = makeCombat({ players: [p1], monsters: [m1] });
  game.combat = combat;
  rollLog.length = 0;
  rollScripts = [[4, 2]];
  assert.equal(await resolveTrackerRollAction(combat, "rollInitiative", p1.id), "character", "character handled");
  assert.equal(p1.initiative, 11, "2d6(6) + Scout Lv4 + Agility bonus 1");
  assert.equal(await resolveTrackerRollAction(combat, "rollInitiative", m1.id), "monster", "monster handled");
  assert.equal(m1.initiative, 9, "fixed initiative 9");
  assert.equal(rollLog.length, 1, "no dice rolled for the monster");
  assert.equal(await resolveTrackerRollAction(combat, "rollInitiative", "cb-unknown"), false, "unknown combatant â†’ native fallback");
}

// 3b. rollInitiative: npc/fellow untouched (inert native formula)
{
  const npcActor = { id: "npc-1", type: "npc", name: "npc-1", system: {}, items: [] };
  const n1 = makeCombatant({ actor: npcActor });
  const combat = makeCombat({ others: [n1] });
  game.combat = combat;
  rollLog.length = 0;
  assert.equal(await resolveTrackerRollAction(combat, "rollInitiative", n1.id), false, "npc not handled");
  assert.equal(n1.initiative, null, "npc initiative untouched");
  assert.equal(rollLog.length, 0, "no dice for npc");
}

// 3c. rollAll: every character rolls its own modifier, every monster fixed
{
  const pcA = makeCharacter("pc-a", {
    classes: [classItem("c-scout", "Scout", 2)],
    system: { abilityBases: { skill: 6 }, abilityAdjustments: {}, combat: { initiativeClassId: "c-scout", initiativeBonus: 0 } }
  });
  const pcB = makeCharacter("pc-b", { classes: [], system: { combat: { initiativeBonus: 1 } } });
  const pa = makeCombatant({ actor: pcA });
  const pb = makeCombatant({ actor: pcB });
  const monActorA = makeMonster("m-orc", 8);
  const monActorB = makeMonster("m-slime", 2);
  const ma = makeCombatant({ actor: monActorA });
  const mb = makeCombatant({ actor: monActorB });
  const npcActor = { id: "npc-1", type: "npc", name: "npc-1", system: {}, items: [] };
  const n1 = makeCombatant({ actor: npcActor });
  const combat = makeCombat({ players: [pa, pb], monsters: [ma, mb], others: [n1] });
  game.combat = combat;
  rollLog.length = 0;
  setCalls.length = 0;
  rollScripts = [[6, 1], [2, 1]];
  assert.equal(await resolveTrackerRollAction(combat, "rollAll"), "all", "rollAll handled");
  assert.equal(pa.initiative, 10, "pcA: 2d6(7) + Scout Lv2 + Agility bonus 1");
  assert.equal(pb.initiative, 4, "pcB: 2d6(3) + bonus 1 (no class)");
  assert.equal(ma.initiative, 8, "orc fixed 8");
  assert.equal(mb.initiative, 2, "slime fixed 2");
  assert.equal(n1.initiative, null, "npc untouched by rollAll");
  assert.equal(rollLog.length, 2, "exactly two dice rolls (characters only)");
}

// 3d. rollNPC: only monsters receive fixed values
{
  const pc = makeCharacter("pc-a", {
    classes: [classItem("c-scout", "Scout", 3)],
    system: { abilityBases: { skill: 6 }, abilityAdjustments: {}, combat: { initiativeClassId: "c-scout", initiativeBonus: 0 } }
  });
  const pa = makeCombatant({ actor: pc, initiative: 7 });
  const monActor = makeMonster("m-orc", 8);
  const ma = makeCombatant({ actor: monActor });
  const combat = makeCombat({ players: [pa], monsters: [ma] });
  game.combat = combat;
  rollLog.length = 0;
  assert.equal(await resolveTrackerRollAction(combat, "rollNPC"), "npc", "rollNPC handled");
  assert.equal(ma.initiative, 8, "monster fixed 8");
  assert.equal(pa.initiative, 7, "character untouched by rollNPC");
  assert.equal(rollLog.length, 0, "no dice rolled by rollNPC");
}

// 3e. Unknown actions â†’ native fallback
{
  const combat = makeCombat({ players: [makeCombatant({ actor: makeCharacter("pc-1", { system: { combat: {} } }) })] });
  game.combat = combat;
  assert.equal(await resolveTrackerRollAction(combat, "roll-defeated"), false, "unknown action refused");
  assert.equal(await resolveTrackerRollAction(null, "rollAll"), false, "null combat refused");
}

// â”€â”€ 4. Monster tracker dice never produce random values â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log("=== 4. Monster tracker path has no dice ===");

{
  const systemJson = JSON.parse(readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "system.json"), "utf8"));
  assert.equal(systemJson.initiative, "0", "native formula stays inert: no random values for any type");
}

console.log("\nAll tracker initiative tests passed.");
