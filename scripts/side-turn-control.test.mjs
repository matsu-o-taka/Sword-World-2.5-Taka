// Sword World 2.5 - individual turn control test suite (T5.1, DEC-51).
//
// Exercises the individual turn controls added to
// module/combat/side-initiative.mjs ("begin-turn" / "finish-turn") through the
// REAL production path: handleAction is the same GM-side dispatcher the socket
// and the GM-relay whisper reach, and requestIndividualTurn is the same client
// entry point the tracker window buttons call.
//
// Scope: per-combatant alternation (not started -> started -> ended), refusal
// of incoherent transitions, free actuation order inside a side (recorded,
// never imposed), per-combatant state independence, phase gating (a combatant
// only acts while its side's phase is active), the player whisper relay path
// with ownership filtering, and full preservation of the previous side-switch
// behavior (end-player / end-monster) with the additive coherence that ending
// a side turn also ends that combatant's individual turn, and the per-phase
// reset of the individual states.
//
// Out of scope (later T5 tasks): expiration of ActiveEffects, casterTurn/
// targetTurn anchors, native Foundry expiration hooks, round duration
// management, Encounter-end purge, flag-effects migration (T5.6).

import assert from "node:assert/strict";

// ── Foundry mocks (before importing the module) ─────────────────────────────

const chatMessages = [];
const warnings = [];
const infos = [];
const errors = [];
const socketEmits = [];

globalThis.ChatMessage = {
  async create(data) { chatMessages.push(data); return { id: `msg-${chatMessages.length}` }; },
  getSpeaker() { return {}; },
  getWhisperRecipients() { return [{ id: "user-gm", name: "GM" }]; },
};

globalThis.ui = {
  notifications: {
    warn(message) { warnings.push(message); },
    info(message) { infos.push(message); },
    error(message) { errors.push(message); },
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
  users: {
    get: id => (id ? { id, name: id } : null),
    activeGM: { id: "user-gm", isGM: true },
  },
  socket: {
    emit(channel, payload) { socketEmits.push({ channel, payload }); },
    on() {},
  },
  combats: { get: id => combatRegistry.get(id) },
  combat: null,
  actors: { get: () => null },
  settings: { get() { return {}; } },
};

globalThis.Application = class { render() {} async close() {} };

// ── Import after mocks ───────────────────────────────────────────────────────

const {
  handleAction,
  requestIndividualTurn,
  individualTurnState,
} = await import("../module/combat/side-initiative.mjs");

const FLAG_SCOPE = "sw25-taka";
const FLAG_KEY = "sideInitiative";

// ── Fixtures ────────────────────────────────────────────────────────────────

let idCounter = 0;

function makeActor(id, type, { isOwner = true } = {}) {
  const getFlagCalls = [];
  return {
    id,
    type,
    name: id,
    isOwner,
    getFlag(scope, key) { getFlagCalls.push(`${scope}.${key}`); return undefined; },
    getFlagCalls,
    async update() { return this; },
  };
}

function makeCombatant(actor) {
  return {
    id: `cb-${++idCounter}`,
    name: actor.name,
    initiative: 10,
    defeated: false,
    actor,
  };
}

function makeCombat({ players = [], monsters = [] } = {}) {
  const flags = new Map();
  const combat = {
    id: "combat-1",
    round: 1,
    turn: null,
    started: true,
    combatants: [...players, ...monsters],
    getFlag(scope, key) { return flags.get(key) ?? null; },
    async setFlag(scope, key, value) { flags.set(key, structuredClone(value)); },
    async startCombat() { this.started = true; },
    async update(data) { Object.assign(this, data); },
    async setInitiative() {},
  };
  combat.combatants.get = id => combat.combatants.find(c => c.id === id) ?? null;
  combatRegistry.set(combat.id, combat);
  return combat;
}

/** Seed the side state exactly like activateSideTurnsFromTracker persists it. */
function seedSideState(combat, {
  phase = "players",
  firstPhase = "players",
  playersDone = [],
  monstersDone = [],
  turnStates = {},
  turnOrder = [],
  round = 1
} = {}) {
  combat.setFlag(FLAG_SCOPE, FLAG_KEY, {
    active: true,
    phase,
    firstPhase,
    playersDone: [...playersDone],
    monstersDone: [...monstersDone],
    turnStates: { ...turnStates },
    turnOrder: [...turnOrder],
    playerInitiatives: {},
    monsterInitiative: 0,
    round
  });
}

const stateOf = combat => combat.getFlag(FLAG_SCOPE, FLAG_KEY);
const beginTurn = (combat, ids) =>
  handleAction({ action: "begin-turn", combatId: combat.id, combatantIds: ids, gmOverride: true }, "user-gm");
const finishTurn = (combat, ids) =>
  handleAction({ action: "finish-turn", combatId: combat.id, combatantIds: ids, gmOverride: true }, "user-gm");

const record = label => console.log(`  ${label}`);

// ── 1. A combatant can begin its turn ───────────────────────────────────────

console.log("=== 1. begin-turn registers the individual start ===");
{
  const actor = makeActor("pc-1", "character");
  const p1 = makeCombatant(actor);
  const combat = makeCombat({ players: [p1] });
  seedSideState(combat, { phase: "players" });

  await beginTurn(combat, [p1.id]);

  const state = stateOf(combat);
  assert.equal(state.turnStates[p1.id], "started", "combatant registered as started");
  assert.deepEqual(state.turnOrder, [p1.id], "begin order recorded (real chosen order)");
  assert.equal(individualTurnState(combat, p1.id), "started", "read API reflects the state");
  assert.equal(state.phase, "players", "no side switch happened");
  assert.deepEqual(state.playersDone, [], "playersDone untouched by the individual control");
  record("begin-turn -> started, order recorded, side switch untouched");
}

// ── 2. The same combatant can finish its turn ───────────────────────────────

console.log("=== 2. finish-turn registers the individual end ===");
{
  const actor = makeActor("pc-1", "character");
  const p1 = makeCombatant(actor);
  const combat = makeCombat({ players: [p1] });
  seedSideState(combat, { phase: "players" });
  await beginTurn(combat, [p1.id]);
  await finishTurn(combat, [p1.id]);

  const state = stateOf(combat);
  assert.equal(state.turnStates[p1.id], "ended", "combatant registered as ended");
  assert.deepEqual(state.turnOrder, [p1.id], "finish does not duplicate the order entry");
  assert.equal(individualTurnState(combat, p1.id), "ended", "read API reflects the end");
  assert.deepEqual(state.playersDone, [], "playersDone still untouched (independent of the side switch)");
  record("finish-turn -> ended, order entry preserved once");
}

// ── 3. Alternation rejects incoherent transitions ───────────────────────────

console.log("=== 3. strict alternation, no incoherent transitions ===");
{
  const actor = makeActor("pc-1", "character");
  const p1 = makeCombatant(actor);
  const combat = makeCombat({ players: [p1] });
  seedSideState(combat, { phase: "players" });

  // finish without begin: refused, no state written.
  const before = structuredClone(stateOf(combat));
  await finishTurn(combat, [p1.id]);
  assert.deepEqual(stateOf(combat), before, "finish without begin leaves the state untouched");

  // begin twice: the second begin is refused (already started).
  await beginTurn(combat, [p1.id]);
  const started = structuredClone(stateOf(combat));
  await beginTurn(combat, [p1.id]);
  assert.deepEqual(stateOf(combat), started, "begin while started leaves the state untouched");

  // begin after ended (same phase): refused — one actuation per round.
  await finishTurn(combat, [p1.id]);
  const ended = structuredClone(stateOf(combat));
  await beginTurn(combat, [p1.id]);
  assert.deepEqual(stateOf(combat), ended, "begin after ended is refused until the phase resets");
  record("incoherent transitions refused without any state change");
}

// ── 4. Free order inside the side, recorded as chosen ───────────────────────

console.log("=== 4. two combatants, arbitrary actuation order ===");
{
  const a = makeCombatant(makeActor("pc-a", "character"));
  const b = makeCombatant(makeActor("pc-b", "character"));
  const combat = makeCombat({ players: [a, b] });
  seedSideState(combat, { phase: "players" });

  await beginTurn(combat, [b.id]); // B first, although A is listed first
  await beginTurn(combat, [a.id]);
  assert.deepEqual(stateOf(combat).turnOrder, [b.id, a.id], "chosen order B->A recorded");

  await finishTurn(combat, [b.id]);
  await finishTurn(combat, [a.id]);
  const state = stateOf(combat);
  assert.equal(state.turnStates[a.id], "ended");
  assert.equal(state.turnStates[b.id], "ended");
  assert.deepEqual(state.turnOrder, [b.id, a.id], "finish order does not rewrite the begin order");
  assert.deepEqual(state.playersDone, [], "side switch still independent");
  record("free order inside the side preserved and registered (DEC-51)");
}

// ── 5. Per-combatant state independence ─────────────────────────────────────

console.log("=== 5. one combatant's state does not touch the others ===");
{
  const a = makeCombatant(makeActor("pc-a", "character"));
  const b = makeCombatant(makeActor("pc-b", "character"));
  const combat = makeCombat({ players: [a, b] });
  seedSideState(combat, { phase: "players" });

  await beginTurn(combat, [a.id]);
  assert.equal(stateOf(combat).turnStates[b.id], undefined, "B untouched by A's begin");
  await finishTurn(combat, [a.id]);
  assert.equal(stateOf(combat).turnStates[b.id], undefined, "B untouched by A's finish");
  await beginTurn(combat, [b.id]);
  assert.equal(stateOf(combat).turnStates[a.id], "ended", "A keeps its own state while B begins");
  assert.deepEqual(stateOf(combat).turnOrder, [a.id, b.id]);
  record("states are strictly per combatant");
}

// ── 6. Side switch keeps the previous behavior (and resets individuals) ─────

console.log("=== 6. end-player / end-monster side switch preserved ===");
{
  // 6a. Players phase completes -> monster phase, individuals reset.
  const a = makeCombatant(makeActor("pc-a", "character"));
  const b = makeCombatant(makeActor("pc-b", "character"));
  const combat = makeCombat({ players: [a, b] });
  seedSideState(combat, { phase: "players", firstPhase: "players", turnStates: { [a.id]: "started" }, turnOrder: [a.id] });

  await handleAction({ action: "end-player", combatId: combat.id, combatantIds: [a.id, b.id], gmOverride: true }, "user-gm");

  const state = stateOf(combat);
  assert.equal(state.phase, "monsters", "side switch to monsters as before");
  assert.deepEqual(state.playersDone.sort(), [a.id, b.id].sort(), "playersDone as before");
  assert.deepEqual(state.monstersDone, [], "monstersDone reset as before");
  assert.equal(state.turnStates, null, "individual states reset at the side switch");
  assert.equal(state.turnOrder, null, "individual order reset at the side switch");
  assert.match(chatMessages.at(-1).content, /Monster Turn/, "transition announcement preserved");
  record("end-player side switch: same transition, individuals reset for the next phase");

  // 6b. Processed combatants got their individual turn ended coherently
  // (additive) on the INCOMPLETE path.
  const c = makeCombatant(makeActor("pc-c", "character"));
  const d = makeCombatant(makeActor("pc-d", "character"));
  const combat2 = makeCombat({ players: [c, d] });
  seedSideState(combat2, { phase: "players", firstPhase: "players", turnStates: { [c.id]: "started" }, turnOrder: [c.id] });
  await handleAction({ action: "end-player", combatId: combat2.id, combatantIds: [c.id], gmOverride: true }, "user-gm");
  const partial = stateOf(combat2);
  assert.equal(partial.phase, "players", "phase unchanged while players remain");
  assert.deepEqual(partial.playersDone, [c.id], "playersDone as before");
  assert.equal(partial.turnStates[c.id], "ended", "ending the side turn ended the individual turn (coherence)");
  assert.equal(partial.turnStates[d.id], undefined, "unprocessed combatant untouched");
  assert.deepEqual(partial.turnOrder, [c.id], "order preserved on the incomplete path");
  record("end-player incomplete: processed combatant's individual turn registered as ended");

  // 6c. New round path (firstPhase monsters): round advances, all reset.
  const combat3 = makeCombat({ players: [c, d] });
  combat3.round = 2; // the combat document's round is the source of truth
  seedSideState(combat3, { phase: "players", firstPhase: "monsters", round: 2, turnStates: { [c.id]: "ended" }, turnOrder: [c.id] });
  await handleAction({ action: "end-player", combatId: combat3.id, combatantIds: [c.id, d.id], gmOverride: true }, "user-gm");
  const nextRound = stateOf(combat3);
  assert.equal(nextRound.round, 3, "round advanced as before");
  assert.equal(nextRound.phase, "monsters", "monsters act first in the new round as before");
  assert.deepEqual(nextRound.playersDone, [], "playersDone reset as before");
  assert.equal(nextRound.turnStates, null, "individual states reset for the new round");
  record("end-player new round: same transition, individuals reset");

  // 6d. Monster phase completes (players went first -> NEW ROUND):
  // sideTransition advances the round and everything resets, as before.
  const m1 = makeCombatant(makeActor("m-orc", "monster"));
  const m2 = makeCombatant(makeActor("m-slime", "monster"));
  const combat4 = makeCombat({ monsters: [m1, m2] });
  seedSideState(combat4, { phase: "monsters", firstPhase: "players", turnStates: { [m1.id]: "started" }, turnOrder: [m1.id] });
  await handleAction({ action: "end-monster", combatId: combat4.id, combatantIds: [m1.id, m2.id], gmOverride: true }, "user-gm");
  const newRoundState = stateOf(combat4);
  assert.equal(newRoundState.phase, "players", "players act first in the new round as before");
  assert.equal(newRoundState.round, 2, "round advanced as before");
  assert.deepEqual(newRoundState.playersDone, [], "playersDone reset as before");
  assert.deepEqual(newRoundState.monstersDone, [], "monstersDone reset as before (new round)");
  assert.equal(newRoundState.turnStates, null, "individual states reset at the round rollover");
  assert.equal(newRoundState.turnOrder, null, "individual order reset at the round rollover");
  assert.match(chatMessages.at(-1).content, /Players act first/, "new round announcement preserved");
  record("end-monster completion (new round): sideTransition preserved, individuals reset");

  // 6d2. Monster phase completes (monsters went first -> same round):
  // back to players, monstersDone kept as before.
  const m3 = makeCombatant(makeActor("m-goblin", "monster"));
  const combat4b = makeCombat({ monsters: [m3] });
  seedSideState(combat4b, { phase: "monsters", firstPhase: "monsters" });
  await handleAction({ action: "end-monster", combatId: combat4b.id, combatantIds: [m3.id], gmOverride: true }, "user-gm");
  const backToPlayers = stateOf(combat4b);
  assert.equal(backToPlayers.phase, "players", "side switch back to players as before");
  assert.deepEqual(backToPlayers.monstersDone, [m3.id], "monstersDone kept as before (same round)");
  assert.deepEqual(backToPlayers.playersDone, [], "playersDone reset as before");
  assert.equal(backToPlayers.turnStates, null, "individual states reset at the side switch");
  assert.match(chatMessages.at(-1).content, /Player Turn/, "monster completion announcement preserved");
  record("end-monster completion (same round): sideTransition preserved, individuals reset");

  // 6e. Monster incomplete path keeps the phase and registers coherence.
  const combat5 = makeCombat({ monsters: [m1, m2] });
  seedSideState(combat5, { phase: "monsters", firstPhase: "players", turnStates: { [m1.id]: "started" }, turnOrder: [m1.id] });
  await handleAction({ action: "end-monster", combatId: combat5.id, combatantIds: [m1.id], gmOverride: true }, "user-gm");
  const monsterPartial = stateOf(combat5);
  assert.equal(monsterPartial.phase, "monsters", "phase unchanged while monsters remain");
  assert.deepEqual(monsterPartial.monstersDone, [m1.id], "monstersDone as before");
  assert.equal(monsterPartial.turnStates[m1.id], "ended", "marked-acted monster's individual turn registered as ended");
  record("end-monster incomplete: same marking, individual coherence registered");
}

// ── 7. Regeneration / natural power hooks still run on end-player ───────────

console.log("=== 7. end-player still runs the per-actor turn effects ===");
{
  const a = makeCombatant(makeActor("pc-a", "character"));
  const combat = makeCombat({ players: [a] });
  seedSideState(combat, { phase: "players" });
  chatMessages.length = 0;
  await handleAction({ action: "end-player", combatId: combat.id, combatantIds: [a.id], gmOverride: true }, "user-gm");
  assert.ok(actorOf(combat, a.id).getFlagCalls.includes(`${FLAG_SCOPE}.timedRegeneration`),
    "processRegenerationTurn consulted the actor's stored effects");
  assert.ok(actorOf(combat, a.id).getFlagCalls.includes(`${FLAG_SCOPE}.naturalPower`),
    "expireNaturalPower consulted the actor's natural power");
  record("end-player behavior (regeneration / natural power) untouched");
}

function actorOf(combat, combatantId) {
  return combat.combatants.get(combatantId).actor;
}

// ── 8. State conserved across combat updates and saves ──────────────────────

console.log("=== 8. individual state survives combat updates ===");
{
  const a = makeCombatant(makeActor("pc-a", "character"));
  const combat = makeCombat({ players: [a] });
  seedSideState(combat, { phase: "players" });
  await beginTurn(combat, [a.id]);

  await combat.update({ round: 5, turn: 0 });
  const after = stateOf(combat);
  assert.equal(after.turnStates[a.id], "started", "flag state not wiped by a combat update");
  assert.equal(combat.round, 5, "update applied normally");
  assert.equal(individualTurnState(combat, a.id), "started", "read API consistent after the update");

  // saveState round-trip keeps the rest of the state intact.
  await finishTurn(combat, [a.id]);
  const final = stateOf(combat);
  assert.equal(combat.round, 5, "combat round preserved across an individual-control save");
  assert.equal(final.phase, "players", "phase preserved across an individual-control save");
  assert.equal(final.turnStates[a.id], "ended");
  record("state conserved after combat.update and further saves");
}

// ── 9. Phase gating: a combatant acts only in its side's phase ──────────────

console.log("=== 9. phase gating ===");
{
  const a = makeCombatant(makeActor("pc-a", "character"));
  const m1 = makeCombatant(makeActor("m-orc", "monster"));
  const combat = makeCombat({ players: [a], monsters: [m1] });

  // Player during the monsters phase: refused.
  seedSideState(combat, { phase: "monsters", firstPhase: "players" });
  const monstersPhase = structuredClone(stateOf(combat));
  await beginTurn(combat, [a.id]);
  assert.deepEqual(stateOf(combat), monstersPhase, "player cannot begin during the monsters phase");

  // Monster during the players phase: refused even for the GM.
  seedSideState(combat, { phase: "players", firstPhase: "players" });
  const playersPhase = structuredClone(stateOf(combat));
  await beginTurn(combat, [m1.id]);
  assert.deepEqual(stateOf(combat), playersPhase, "monster cannot begin during the players phase");

  // Monster during the monsters phase (GM): works.
  seedSideState(combat, { phase: "monsters", firstPhase: "players" });
  await beginTurn(combat, [m1.id]);
  assert.equal(stateOf(combat).turnStates[m1.id], "started", "monster begins during its phase");
  await finishTurn(combat, [m1.id]);
  assert.equal(stateOf(combat).turnStates[m1.id], "ended", "monster finishes during its phase");

  // Player during the players phase: works.
  seedSideState(combat, { phase: "players", firstPhase: "players" });
  await beginTurn(combat, [a.id]);
  assert.equal(stateOf(combat).turnStates[a.id], "started", "player begins during its phase");
  record("phase gating verified for both sides");
}

// ── 10. Player whisper relay path (ownership filter) ────────────────────────

console.log("=== 10. player individual turn requests through the GM relay ===");
{
  const mine = makeCombatant(makeActor("pc-mine", "character", { isOwner: true }));
  const foreign = makeCombatant(makeActor("pc-other", "character", { isOwner: false }));
  const combat = makeCombat({ players: [mine, foreign] });
  seedSideState(combat, { phase: "players", firstPhase: "players" });

  game.user.isGM = false;
  game.user.id = "user-player";
  chatMessages.length = 0;
  await requestIndividualTurn(combat, "begin-turn", [mine.id, foreign.id]);

  assert.equal(chatMessages.length, 1, "one whisper created");
  const whisper = chatMessages[0];
  assert.deepEqual(whisper.whisper, ["user-gm"], "whispered to the GM");
  const request = whisper.flags[FLAG_SCOPE].sideTurnRequest;
  assert.equal(request.action, "begin-turn");
  assert.deepEqual(request.combatantIds, [mine.id], "only OWNED combatants travel");
  assert.equal(request.userId, "user-player");
  assert.match(infos.at(-1), /sent to the GM/, "player notified");

  // The GM client processes the relayed request through the same dispatcher.
  game.user.isGM = true;
  game.user.id = "user-gm";
  await handleAction(request, request.userId);
  const state = stateOf(combat);
  assert.equal(state.turnStates[mine.id], "started", "GM executed the relayed begin");
  assert.equal(state.turnStates[foreign.id], undefined, "foreign combatant untouched");
  assert.deepEqual(state.turnOrder, [mine.id]);

  // Wrong phase for a player request: refused client-side without whisper.
  game.user.isGM = false;
  game.user.id = "user-player";
  seedSideState(combat, { phase: "monsters", firstPhase: "players", turnStates: { [mine.id]: "ended" }, turnOrder: [mine.id] });
  chatMessages.length = 0;
  await requestIndividualTurn(combat, "begin-turn", [mine.id]);
  assert.equal(chatMessages.length, 0, "no whisper outside the players phase");
  assert.match(warnings.at(-1), /phase/, "player warned about the phase");

  // Unknown action refused.
  await requestIndividualTurn(combat, "end-player", [mine.id]);
  assert.match(warnings.at(-1), /Unknown individual turn control/, "unknown action refused");

  game.user.isGM = true;
  game.user.id = "user-gm";
  record("player relay path: ownership filter, GM execution, phase gating");
}

// ── 11. Inactive combat and defeated combatants ─────────────────────────────

console.log("=== 11. guards ===");
{
  const a = makeCombatant(makeActor("pc-a", "character"));
  const combat = makeCombat({ players: [a] });
  // No side state seeded: individualTurnState is null, requests warned.
  assert.equal(individualTurnState(combat, a.id), null, "no state -> null");
  const before = warnings.length;
  await beginTurn(combat, [a.id]);
  assert.equal(warnings.length, before, "inactive combat: dispatcher silently ignored (existing guard)");

  // Defeated combatants are outside both pools (existing filters).
  a.defeated = true;
  seedSideState(combat, { phase: "players" });
  await beginTurn(combat, [a.id]);
  assert.equal(stateOf(combat).turnStates[a.id], undefined, "defeated combatant cannot begin");
  record("guards: inactive combat and defeated combatants");
}

console.log("\nAll side-turn-control assertions passed.");
