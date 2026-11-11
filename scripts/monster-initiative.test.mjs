// Sword World 2.5 - Monster initiative & individual monster tracking tests
//
// Covers:
//   Assignment (beginMonsterInitiative, reused automatic mechanism):
//     - Fixed value from system.initiative
//     - Zero is a valid fixed value (assigned, and never overwritten later)
//     - Multiple combatants of the same Actor
//     - Multiple monster species (each gets its own value)
//     - Previously assigned initiatives are respected
//     - Simultaneous/repeated assignment is idempotent
//     - Mid-combat additions get their value without touching Side state
//     - Non-GM clients never write
//     - Write failures are handled explicitly (warn, no crash, rest assigned)
//   Activation sync (activateSideTurnsFromTracker):
//     - monsterInitiative is Math.max of ALL monsters, never the last Actor
//     - Ties favor the players (>=)
//     - Missing initiatives block activation with a clear warning
//     - monstersDone starts empty
//   Individual monster tracking (markMonstersDone / endMonsterPhase):
//     - Individual marking, duplicate rejection, invalid ID rejection
//     - Automatic phase completion when all monsters have acted
//     - Early end keeps working
//     - playersDone and monstersDone reset on round advance
//   Native formula:
//     - system.json initiative formula is "0" (no 2d6 for monsters)
//     - PCs keep their custom sheet roll (2d6 + modifier)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// ── Foundry mocks (defined before importing the module) ────────────────────

const chatMessages = [];
const warnings = [];
const infos = [];
const consoleWarnings = [];
const realConsoleWarn = console.warn;

globalThis.ChatMessage = {
  async create(data) { chatMessages.push(data.content ?? ""); return { id: `msg-${chatMessages.length}` }; },
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
  settings: { get() { return {}; } },
};

globalThis.Application = class {
  render() {}
  async close() {}
};

console.warn = (...args) => { consoleWarnings.push(args.map(String).join(" ")); };

// ── Import after mocks ─────────────────────────────────────────────────────

// side-initiative.mjs captures globalThis.Application at module evaluation,
// so the import must happen after the mocks above are installed.
const {
  beginMonsterInitiative,
  activateSideTurnsFromTracker,
  markMonstersDone,
  endMonsterPhase,
  requestGMPlayerEnd,
} = await import("../module/combat/side-initiative.mjs");

// ── Helpers ────────────────────────────────────────────────────────────────

let idCounter = 0;

function makeActor(id, type, system = {}) {
  return { id, type, name: id, system, getFlag: () => undefined };
}

function makeCombatant({ actorId, type, name = actorId, initiative = null, defeated = false, failSet = false }) {
  return {
    id: `cb-${++idCounter}`,
    name,
    initiative,
    defeated,
    actor: makeActor(actorId, type),
    _failSet: failSet,
  };
}

const setCalls = [];

function makeCombat({ players = [], monsters = [], round = 1, started = false, state = null } = {}) {
  const flags = new Map();
  if (state) flags.set("sideInitiative", structuredClone(state));
  const combat = {
    id: "combat-1",
    round,
    turn: null,
    started,
    combatants: [...players, ...monsters],
    getFlag(scope, key) { return flags.get(key); },
    async setFlag(scope, key, value) { flags.set(key, structuredClone(value)); },
    async startCombat() { this.started = true; },
    async update(data) { Object.assign(this, data); },
    async setInitiative(id, value) {
      const combatant = this.combatants.find(c => c.id === id);
      if (!combatant) throw new Error(`unknown combatant ${id}`);
      if (combatant._failSet) throw new Error("write failure");
      combatant.initiative = Number(value);
      setCalls.push([id, Number(value)]);
    },
  };
  combatRegistry.set(combat.id, combat);
  return combat;
}

const player = (name, initiative) => makeCombatant({ actorId: name, type: "character", name, initiative });
const monster = (actorId, name, initiative, options = {}) =>
  makeCombatant({ actorId, type: "monster", name, initiative, ...options });

// ── 1. Assignment ──────────────────────────────────────────────────────────

console.log("=== 1. beginMonsterInitiative assignment ===");

// 1a. Fixed value from system.initiative
{
  const actor = makeActor("m-orc", "monster", { initiative: 9 });
  const orc = monster("m-orc", "Orc");
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [orc] });
  game.combat = combat;
  const result = await beginMonsterInitiative(actor, combat);
  assert.equal(result, true, "assignment attempted");
  assert.equal(orc.initiative, 9, "fixed initiative 9 assigned");
}

// 1b. Zero is a valid fixed value and is never overwritten afterwards
{
  const actor = makeActor("m-slime", "monster", { initiative: 0 });
  const slime = monster("m-slime", "Slime");
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [slime] });
  setCalls.length = 0;
  await beginMonsterInitiative(actor, combat);
  assert.equal(slime.initiative, 0, "zero assigned");
  setCalls.length = 0;
  await beginMonsterInitiative(actor, combat); // repeated: idempotent
  assert.equal(setCalls.length, 0, "zero counts as assigned: no rewrite on repeat");
}

// 1c. Multiple combatants of the same Actor
{
  const actor = makeActor("m-goblin", "monster", { initiative: 6 });
  const g1 = monster("m-goblin", "Goblin A");
  const g2 = monster("m-goblin", "Goblin B");
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [g1, g2] });
  await beginMonsterInitiative(actor, combat);
  assert.equal(g1.initiative, 6, "first combatant assigned");
  assert.equal(g2.initiative, 6, "second combatant assigned");
}

// 1d. Two species: each gets its own fixed value
{
  const orcActor = makeActor("m-orc", "monster", { initiative: 8 });
  const slimeActor = makeActor("m-slime", "monster", { initiative: 3 });
  const orc = monster("m-orc", "Orc");
  const slime = monster("m-slime", "Slime");
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [orc, slime] });
  await beginMonsterInitiative(orcActor, combat);
  await beginMonsterInitiative(slimeActor, combat);
  assert.equal(orc.initiative, 8, "orc keeps 8");
  assert.equal(slime.initiative, 3, "slime keeps 3");
}

// 1e. Previously assigned initiatives are respected
{
  const actor = makeActor("m-orc", "monster", { initiative: 9 });
  const orc = monster("m-orc", "Orc", 5); // GM entered 5 by hand
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [orc] });
  setCalls.length = 0;
  await beginMonsterInitiative(actor, combat);
  assert.equal(setCalls.length, 0, "no write over a manually assigned value");
  assert.equal(orc.initiative, 5, "manual value preserved");
}

// 1f. Non-GM clients never write
{
  game.user.isGM = false;
  const actor = makeActor("m-orc", "monster", { initiative: 9 });
  const orc = monster("m-orc", "Orc");
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [orc] });
  setCalls.length = 0;
  const result = await beginMonsterInitiative(actor, combat);
  game.user.isGM = true;
  assert.equal(result, false, "non-GM returns false");
  assert.equal(setCalls.length, 0, "non-GM performs no writes");
  assert.equal(warnings.length, 0, "automatic flow stays silent for non-GM");
}

// 1g. Write failures handled explicitly; remaining combatants still assigned
{
  const actor = makeActor("m-goblin", "monster", { initiative: 6 });
  const bad = monster("m-goblin", "Goblin A", null, { failSet: true });
  const good = monster("m-goblin", "Goblin B");
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [bad, good] });
  consoleWarnings.length = 0;
  const result = await beginMonsterInitiative(actor, combat);
  assert.equal(result, true, "attempt reported");
  assert.equal(bad.initiative, null, "failed combatant stays without initiative");
  assert.equal(good.initiative, 6, "other combatant still assigned");
  assert.equal(consoleWarnings.length, 1, "failure warned through console");
}

// 1h. Actor not present in the combat
{
  const actor = makeActor("m-ghost", "monster", { initiative: 7 });
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [monster("m-orc", "Orc")] });
  const result = await beginMonsterInitiative(actor, combat);
  assert.equal(result, false, "absent actor: nothing attempted");
}

// 1i. Mid-combat addition during an active side phase: value assigned, state untouched
{
  const actor = makeActor("m-goblin", "monster", { initiative: 6 });
  const existing = monster("m-goblin", "Goblin A", 6);
  const g2 = monster("m-goblin", "Goblin B");
  const combat = makeCombat({
    players: [player("p1", 5)],
    monsters: [existing, g2],
    started: true,
    state: { active:true, phase:"monsters", firstPhase:"players", playersDone:["cb-x"], monstersDone:[existing.id], playerInitiatives:{"cb-x":5}, monsterInitiative:6, round:2 }
  });
  await beginMonsterInitiative(actor, combat);
  const state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.equal(g2.initiative, 6, "late addition gets its fixed value");
  assert.equal(state.phase, "monsters", "phase untouched");
  assert.equal(state.round, 2, "round untouched");
  assert.equal(state.monsterInitiative, 6, "snapshot not recalculated by late addition");
  assert.deepEqual(state.monstersDone, [existing.id], "monstersDone untouched");
  assert.deepEqual(state.playersDone, ["cb-x"], "playersDone untouched");
}

// ── 2. Activation sync ─────────────────────────────────────────────────────

console.log("=== 2. activateSideTurnsFromTracker snapshots ===");

// 2a. monsterInitiative = Math.max of all monsters (two species, lower last)
{
  const orc = monster("m-orc", "Orc", 8);
  const slime = monster("m-slime", "Slime", 2);
  const combat = makeCombat({ players: [player("p1", 5), player("p2", 3)], monsters: [orc, slime] });
  game.combat = combat;
  await activateSideTurnsFromTracker(combat);
  const state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.equal(state.monsterInitiative, 8, "monsterInitiative is the maximum, not the last value");
  assert.equal(state.phase, "monsters", "monsters act first when 8 > 5");
  assert.equal(state.firstPhase, "monsters", "firstPhase recorded");
  assert.deepEqual(state.playersDone, [], "playersDone starts empty");
  assert.deepEqual(state.monstersDone, [], "monstersDone starts empty");
  assert.equal(combat.started, true, "combat started");
  assert.equal(state.round, 1, "round 1");
}

// 2b. Tie favors the players
{
  const combat = makeCombat({ players: [player("p1", 8)], monsters: [monster("m-orc", "Orc", 8)] });
  game.combat = combat;
  await activateSideTurnsFromTracker(combat);
  const state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.equal(state.phase, "players", "tie favors players");
}

// 2c. Missing initiative blocks activation with a clear warning
{
  warnings.length = 0;
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [monster("m-orc", "Orc", null)] });
  game.combat = combat;
  await activateSideTurnsFromTracker(combat);
  assert.equal(combat.getFlag("sw25-taka", "sideInitiative"), undefined, "no state saved");
  assert.equal(warnings.length, 1, "warning issued");
  assert.match(warnings[0], /Roll or enter initiative for: Orc/, "warning names the missing combatant");
}

// 2d. Non-GM cannot activate
{
  game.user.isGM = false;
  warnings.length = 0;
  const combat = makeCombat({ players: [player("p1", 5)], monsters: [monster("m-orc", "Orc", 8)] });
  await activateSideTurnsFromTracker(combat);
  game.user.isGM = true;
  assert.equal(combat.getFlag("sw25-taka", "sideInitiative"), undefined, "non-GM cannot activate");
  assert.equal(warnings.length, 1, "non-GM warned");
}

// ── 3. Individual monster tracking ─────────────────────────────────────────

console.log("=== 3. monstersDone tracking ===");

// 3a. Individual marking
{
  const p1 = player("p1", 5);
  const m1 = monster("m-orc", "Orc", 8);
  const m2 = monster("m-slime", "Slime", 2);
  const combat = makeCombat({
    players: [p1], monsters: [m1, m2], started: true, round: 1,
    state: { active:true, phase:"monsters", firstPhase:"players", playersDone:["p1-cb"], monstersDone:[], playerInitiatives:{"p1-cb":5}, monsterInitiative:8, round:1 }
  });
  game.combat = combat;
  chatMessages.length = 0;
  await markMonstersDone(combat, [m1.id]);
  let state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.deepEqual(state.monstersDone, [m1.id], "monster 1 marked");
  assert.equal(state.phase, "monsters", "phase unchanged while monsters remain");

  // 3b. Duplicate request rejected
  consoleWarnings.length = 0;
  await markMonstersDone(combat, [m1.id]);
  state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.deepEqual(state.monstersDone, [m1.id], "duplicate ignored");
  assert.equal(consoleWarnings.length, 1, "duplicate warned in console");

  // 3c. Invalid ID rejected
  consoleWarnings.length = 0;
  await markMonstersDone(combat, ["cb-invalid"]);
  state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.deepEqual(state.monstersDone, [m1.id], "invalid ID ignored");
  assert.equal(consoleWarnings.length, 1, "invalid ID warned");

  // 3d. Automatic completion when the last monster acts (players went first → round advance)
  await markMonstersDone(combat, [m2.id]);
  state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.equal(state.phase, "players", "phase returns to players");
  assert.equal(state.round, 2, "round advanced");
  assert.deepEqual(state.playersDone, [], "playersDone reset on round advance");
  assert.deepEqual(state.monstersDone, [], "monstersDone reset on round advance");
}

// 3e. Monsters went first: completion passes to players in the same round
{
  const m1 = monster("m-orc", "Orc", 8);
  const m2 = monster("m-slime", "Slime", 2);
  const combat = makeCombat({
    players: [player("p1", 5)], monsters: [m1, m2], started: true, round: 1,
    state: { active:true, phase:"monsters", firstPhase:"monsters", playersDone:[], monstersDone:[], playerInitiatives:{"p1-cb":5}, monsterInitiative:8, round:1 }
  });
  await markMonstersDone(combat, [m1.id]);
  await markMonstersDone(combat, [m2.id]);
  const state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.equal(state.phase, "players", "phase passes to players");
  assert.equal(state.round, 1, "same round (players still owe their phase)");
}

// 3f. Early end (endMonsterPhase) still works with pending monsters
{
  const m1 = monster("m-orc", "Orc", 8);
  const m2 = monster("m-slime", "Slime", 2);
  const combat = makeCombat({
    players: [player("p1", 5)], monsters: [m1, m2], started: true, round: 1,
    state: { active:true, phase:"monsters", firstPhase:"players", playersDone:["p1-cb"], monstersDone:[], playerInitiatives:{"p1-cb":5}, monsterInitiative:8, round:1 }
  });
  await endMonsterPhase(combat);
  const state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.equal(state.phase, "players", "early end passes to players");
  assert.equal(state.round, 2, "round advanced on early end");
  assert.deepEqual(state.playersDone, [], "playersDone reset");
  assert.deepEqual(state.monstersDone, [], "monstersDone reset");
}

// 3g. Players finishing second phase (monsters went first): round advance resets both
{
  const combat = makeCombat({
    players: [player("p1", 5)], monsters: [monster("m-orc", "Orc", 8)], started: true, round: 1,
    state: { active:true, phase:"players", firstPhase:"monsters", playersDone:[], monstersDone:[], playerInitiatives:{"p1-cb":5}, monsterInitiative:8, round:1 }
  });
  game.combat = combat;
  await requestGMPlayerEnd(combat); // marks all remaining players
  const state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.equal(state.phase, "monsters", "phase passes to monsters");
  assert.equal(state.round, 2, "round advanced");
  assert.deepEqual(state.playersDone, [], "playersDone reset");
  assert.deepEqual(state.monstersDone, [], "monstersDone reset alongside playersDone");
}

// 3h. Players finishing first phase: direct transition to monsters, monstersDone cleared
{
  const combat = makeCombat({
    players: [player("p1", 5)], monsters: [monster("m-orc", "Orc", 8)], started: true, round: 1,
    state: { active:true, phase:"players", firstPhase:"players", playersDone:[], monstersDone:[], playerInitiatives:{"p1-cb":5}, monsterInitiative:8, round:1 }
  });
  await requestGMPlayerEnd(combat);
  const state = combat.getFlag("sw25-taka", "sideInitiative");
  assert.equal(state.phase, "monsters", "phase passes to monsters");
  assert.equal(state.round, 1, "same round");
  assert.deepEqual(state.playersDone.length, 1, "playersDone keeps completion marks");
  assert.deepEqual(state.monstersDone, [], "monstersDone cleared before the monster phase");
}

// ── 4. Native formula ──────────────────────────────────────────────────────

console.log("=== 4. Native initiative formula ===");

const rootPath = fileURLToPath(new URL("..", import.meta.url));
const systemJson = JSON.parse(readFileSync(join(rootPath, "system.json"), "utf8"));
assert.equal(systemJson.initiative, "0", "native formula is 0: no 2d6 for monsters via tracker");
assert.ok(!String(systemJson.initiative).includes("2d6"), "no 2d6 in the native formula");

const actorSheetSource = readFileSync(join(rootPath, "module/actor/actor-sheet.mjs"), "utf8");
assert.ok(actorSheetSource.includes('new Roll(`2d6 + ${modifier}`)'), "PCs keep their custom 2d6 + modifier sheet roll");

console.log("\nAll monster initiative tests passed.");
