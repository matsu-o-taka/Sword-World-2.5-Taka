// Sword World 2.5 - duration engine test suite (T5.3).
//
// Exercises the system's own expiration engine
// (module/effects/duration-engine.mjs) through BOTH paths:
//   - the engine API directly (processSw25DurationEvent /
//     sw25AnchorAvailability), and
//   - the REAL production dispatch: handleAction
//     (module/combat/side-initiative.mjs) is the same GM-side dispatcher the
//     socket, the GM-relay whisper and the window buttons reach; the engine
//     is invoked from it after every persisted transition (D9).
//
// Covered per the task: casterTurn/targetTurn edges, counted turns and
// condition-based turn edges, roundEnd once per
// confirmed transition, per-combatant independence, two tokens of the same
// Actor, the four D5 availability cases (not acted / ended / defeated /
// incapacitated / removed / token gone), degradation without restarting the
// duration and without reassignment, scale behavior (rounds/turns counters,
// condition-based turns, manual scales, legacy, rounds-without-counter per the adopted
// 5.1 decision), direct roundEnd applications (adopted 5.2 decision), the
// adopted internal per-combat FIFO (5.3), deferred anchors, no double
// discounts, no writes outside EffectService, failure isolation with visible
// GM notification (effect + event), no retry after saveState, preserved
// initialDuration, remaining coherence, and full native-expiry isolation.
//
// Out of scope (later T5 tasks): manual-scale timers, Encounter-end purge
// (T5.5), flag migration (T5.6), Instant/X (T5.7), the preparation flow.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── Global Foundry environment mock (before any module import) ──────────────

const notifications = [];
const registeredHooks = new Map();
const chatMessages = [];
const socketEmits = [];

let nextMockId = 1;

function applyFlattened(target, changes) {
  for (const [path, value] of Object.entries(changes)) {
    const parts = path.split(".");
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor[parts[i]] ??= {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  }
}

async function fireWriteHook(name, ...args) {
  let blocked = false;
  for (const listener of registeredHooks.get(name) ?? []) {
    const result = await listener(...args);
    if (result === false) blocked = true;
  }
  return blocked;
}

class MockEffect {
  constructor(data) {
    this.id = data.id ?? `ef-${nextMockId++}`;
    this.uuid = `ActiveEffect.${this.id}`;
    this.type = data.type ?? null;
    this.name = data.name ?? null;
    this.img = data.img ?? null;
    this.origin = data.origin ?? null;
    this.duration = data.duration ? structuredClone(data.duration) : null;
    this.disabled = data.disabled ?? undefined;
    this.system = structuredClone(data.system ?? {});
    this.updates = [];
    this.updateAttempts = 0;
    this.deleted = false;
    this.failNextUpdate = data.failNextUpdate ?? false;
  }
  async update(changes) {
    this.updateAttempts += 1;
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("mock update failure");
    }
    const blocked = await fireWriteHook("preUpdateActiveEffect", this, structuredClone(changes), {}, game.user.id ?? null);
    if (blocked) return null;
    this.updates.push(structuredClone(changes));
    applyFlattened(this, changes);
    return this;
  }
  async delete() {
    const blocked = await fireWriteHook("preDeleteActiveEffect", this, {}, game.user.id ?? null);
    if (blocked) return null;
    this.deleted = true;
    const owner = mockActors.find(actor => actor.effects.includes(this));
    if (owner) owner.effects = owner.effects.filter(effect => effect !== this);
    return this;
  }
}

const mockActors = [];

class MockActor {
  constructor(id, name, type = "character") {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.name = name;
    this.type = type;
    this.effects = [];
    this.createCalls = [];
    mockActors.push(this);
  }
  async createEmbeddedDocuments(type, dataArray) {
    const created = [];
    for (const data of dataArray) {
      const effect = new MockEffect({ ...data, id: `ef-${nextMockId++}` });
      const blocked = await fireWriteHook("preCreateActiveEffect", effect, structuredClone(data), {}, game.user.id ?? null);
      if (blocked) { created.push(null); continue; }
      this.effects.push(effect);
      this.createCalls.push({ type, count: 1 });
      created.push(effect);
    }
    return created;
  }
  async deleteEmbeddedDocuments(type, ids) {
    const removed = [];
    for (const id of ids) {
      const effect = this.effects.find(candidate => candidate.id === id);
      if (effect) removed.push(effect);
    }
    this.effects = this.effects.filter(effect => !removed.includes(effect));
    removed.forEach(effect => { effect.deleted = true; });
    return removed;
  }
  getFlag() { return undefined; }
  async update() { return this; }
}

class MockCombatant {
  constructor(id, actor, { defeated = false, tokenId = null, token = undefined, isDefeated = undefined } = {}) {
    this.id = id;
    this.name = actor.name;
    this.actor = actor;
    this.initiative = 10;
    this.defeated = defeated;
    this.tokenId = tokenId;
    // Native v14 getter simulation: `Combatant#token` resolves the scene
    // token document. A placed token resolves to a document; `token: null`
    // explicitly models a token that no longer exists (case D).
    if (token !== undefined) this.token = token;
    else if (tokenId) this.token = { id: tokenId };
    if (isDefeated !== undefined) this.isDefeated = isDefeated; // simulated native getter
  }
}

const combatRegistry = new Map();

class MockCombat {
  constructor({ id = "combat-1", round = 1, combatants = [] } = {}) {
    this.id = id;
    this.round = round;
    this.turn = null;
    this.started = true;
    this.combatants = combatants;
    this.combatants.get = cid => this.combatants.find(c => c.id === cid) ?? null;
    this.updates = [];
    combatRegistry.set(id, this);
  }
  getFlag(scope, key) { return this.flags?.get(key) ?? null; }
  async setFlag(scope, key, value) {
    this.flags ??= new Map();
    this.flags.set(key, structuredClone(value));
  }
  async update(data) {
    this.updates.push(structuredClone(data));
    Object.assign(this, data);
    return this;
  }
  async startCombat() { this.started = true; }
  async setInitiative() {}
}

globalThis.ChatMessage = {
  async create(data) { chatMessages.push(data); return { id: `msg-${chatMessages.length}` }; },
  getSpeaker() { return {}; },
  getWhisperRecipients() { return [{ id: "user-gm", name: "GM" }]; }
};

globalThis.ui = {
  notifications: {
    warn(message) { notifications.push({ kind: "warn", message }); },
    info(message) { notifications.push({ kind: "info", message }); },
    error(message) { notifications.push({ kind: "error", message }); }
  },
  combat: undefined
};

globalThis.Hooks = {
  on(name, fn) {
    const list = registeredHooks.get(name) ?? [];
    list.push(fn);
    registeredHooks.set(name, list);
  }
};

globalThis.foundry = {
  data: {
    ActiveEffectTypeDataModel: class ActiveEffectTypeDataModelStub {}
  },
  utils: {
    escapeHtml: value => String(value ?? ""),
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    },
    mergeObject: (a, b) => ({ ...a, ...b }),
    deepClone: value => structuredClone(value),
    randomID() { return `r${Math.random().toString(36).slice(2, 12)}`; }
  }
};

globalThis.game = {
  user: { isGM: true, id: "user-gm" },
  users: {
    get: id => (id ? { id, name: id } : null),
    activeGM: { id: "user-gm", isGM: true }
  },
  socket: {
    async emit(channel, payload) { socketEmits.push({ channel, payload }); },
    on() {}
  },
  combats: { get: id => combatRegistry.get(id) },
  combat: null,
  actors: { get: () => null },
  settings: { get() { return {}; } }
};

globalThis.Application = class { render() {} async close() {} };

// ── Module imports (after the environment mock) ─────────────────────────────

const engine = await import("../module/effects/duration-engine.mjs");
const service = await import("../module/effects/effect-service.mjs");
const side = await import("../module/combat/side-initiative.mjs");
const configurator = await import("../module/effects/effect-configurator.mjs");
const configuredEffects = await import("../module/effects/configured-effect.mjs");

const { processSw25DurationEvent, sw25AnchorAvailability } = engine;
const {
  applySw25Effect,
  removeSw25Effect,
  initializeEffectService
} = service;
const { handleAction } = side;
const { buildSw25GenericEffectConfiguration } = configurator;
const { applySw25ConfiguredEffect } = configuredEffects;

// Production wiring equivalent (sw25.mjs ready): the write guard must be
// active so "no writes outside EffectService" is verified through the REAL
// authorization window.
initializeEffectService();

const record = label => console.log(`  ${label}`);

// ── Fixtures ────────────────────────────────────────────────────────────────

const FLAG_SCOPE = "sw25-taka";
const FLAG_KEY = "sideInitiative";

/** Apply one effect through the service (the only authorized write path). */
async function applyEffect(actor, payload) {
  const result = await applySw25Effect(actor, { cast: { successValue: 5 }, ...payload });
  assert.ok(result.ok, `apply should succeed: ${JSON.stringify(result)}`);
  return actor.effects.find(effect => effect.id === result.effectId);
}

/** Persist a raw system effect bypassing apply (review/legacy data only). */
function handBuiltEffect(actor, system, name = "HandBuilt") {
  const effect = new MockEffect({ name, type: "sw25Effect", system: structuredClone(system) });
  actor.effects.push(effect);
  return effect;
}

function makeCombatant(id, actor, options = {}) {
  return new MockCombatant(id, actor, options);
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

const lastNotifications = () => notifications.splice(0, notifications.length);

// ════════════════════════════════════════════════════════════════════════════

// ── 1. casterTurn, edge begin: discount at the caster's turn BEGIN ──────────

console.log("=== 1. casterTurn + edge begin discounts at the caster's turn begin ===");
{
  const casterActor = new MockActor("caster-a", "Caster");
  const targetActor = new MockActor("target-a", "Target");
  const caster = makeCombatant("cmbt-caster", casterActor, { tokenId: "tok-caster" });
  const target = makeCombatant("cmbt-target", targetActor, { tokenId: "tok-target" });
  const combat = new MockCombat({ combatants: [caster, target] });

  const effect = await applyEffect(targetActor, {
    family: "Protection",
    initialDuration: 3,
    remainingDuration: 3,
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-caster", tokenId: "tok-caster" }
  });

  // The caster's turn END does not discount a begin-edge effect.
  await processSw25DurationEvent(combat, { kind: "turn-end", combatantId: "cmbt-caster" });
  assert.equal(effect.system.remainingDuration, 3, "turn end does not discount a begin-edge casterTurn effect");
  assert.equal(effect.deleted, false, "effect survives the non-matching edge");

  // The caster's turn BEGIN discounts by one (absolute write through refresh).
  const summary = await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-caster" });
  assert.equal(summary.ok, true, "engine summary ok");
  assert.equal(effect.system.remainingDuration, 2, "remaining discounted to the absolute 2");
  assert.equal(effect.system.initialDuration, 3, "initialDuration preserved (DEC-23)");
  assert.equal(summary.discounted.length, 1, "one effect discounted");
  assert.equal(effect.duration?.value ?? null, null, "native duration.value never written (D1/D6/D11)");
  assert.equal(effect.duration?.expiry ?? null, null, "native duration.expiry never written");
  record("begin edge discounts, end edge does not; initial preserved; native duration untouched");
}

// ── 2. casterTurn, edge end: discount at the caster's turn END ──────────────

console.log("=== 2. casterTurn + edge end discounts at the caster's turn end ===");
{
  const casterActor = new MockActor("caster-b", "Caster B");
  const targetActor = new MockActor("target-b", "Target B");
  const caster = makeCombatant("cmbt-c2", casterActor);
  const target = makeCombatant("cmbt-t2", targetActor);
  const combat = new MockCombat({ combatants: [caster, target] });

  const effect = await applyEffect(targetActor, {
    family: "Ward",
    initialDuration: 4,
    remainingDuration: 4,
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "end", combatantId: "cmbt-c2" }
  });

  await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-c2" });
  assert.equal(effect.system.remainingDuration, 4, "turn begin does not discount an end-edge effect");
  await processSw25DurationEvent(combat, { kind: "turn-end", combatantId: "cmbt-c2" });
  assert.equal(effect.system.remainingDuration, 3, "turn end discounts the end-edge effect");
  record("end edge discounts at finish, begin edge untouched");
}

// ── 3. targetTurn edges on the target's own combatant ───────────────────────

console.log("=== 3. targetTurn edges (exceptional regime) on the target combatant ===");
{
  const casterActor = new MockActor("caster-c", "Caster C");
  const targetActor = new MockActor("target-c", "Target C");
  const caster = makeCombatant("cmbt-c3", casterActor);
  const target = makeCombatant("cmbt-t3", targetActor);
  const combat = new MockCombat({ combatants: [caster, target] });

  const beginEffect = await applyEffect(targetActor, {
    family: "Aura",
    initialDuration: 2,
    remainingDuration: 2,
    durationScale: "rounds",
    durationAnchor: { regime: "targetTurn", edge: "begin", combatantId: "cmbt-t3" }
  });
  const endEffect = await applyEffect(targetActor, {
    family: "Mark",
    initialDuration: 2,
    remainingDuration: 2,
    durationScale: "rounds",
    durationAnchor: { regime: "targetTurn", edge: "end", combatantId: "cmbt-t3" }
  });

  // The CASTER's edges never touch targetTurn effects anchored to the target.
  await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-c3" });
  await processSw25DurationEvent(combat, { kind: "turn-end", combatantId: "cmbt-c3" });
  assert.equal(beginEffect.system.remainingDuration, 2, "caster's edges do not discount targetTurn anchors");
  assert.equal(endEffect.system.remainingDuration, 2, "caster's edges do not discount targetTurn anchors");

  // The TARGET's own edges process both effects on their configured edge.
  await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-t3" });
  assert.equal(beginEffect.system.remainingDuration, 1, "target's turn begin discounts the begin-edge targetTurn effect");
  assert.equal(endEffect.system.remainingDuration, 2, "target's turn begin does not discount the end-edge effect");
  await processSw25DurationEvent(combat, { kind: "turn-end", combatantId: "cmbt-t3" });
  assert.equal(endEffect.system.remainingDuration, 1, "target's turn end discounts the end-edge targetTurn effect");
  record("targetTurn begin/end processed on the target's own edges only");
}

// ── 4. roundEnd regime: one discount per confirmed transition (5.2) ─────────

console.log("=== 4. roundEnd regime: a direct application discounts once per transition ===");
{
  const actor = new MockActor("roundend-a", "RoundEnd Carrier");
  const carrier = makeCombatant("cmbt-r1", actor);
  const combat = new MockCombat({ combatants: [carrier] });

  // Adopted decision 5.2: a DIRECT roundEnd application stays admissible
  // (identity optional — provenance only) and the engine processes it like
  // any degraded one.
  const effect = await applyEffect(actor, {
    family: "RoundBlade",
    initialDuration: 2,
    remainingDuration: 2,
    durationScale: "rounds",
    durationAnchor: { regime: "roundEnd" }
  });

  const summary = await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });
  assert.equal(effect.system.remainingDuration, 1, "one discount for the confirmed transition");
  assert.equal(summary.discounted.length, 1, "summary records the discount");
  assert.equal(effect.system.initialDuration, 2, "initial preserved");

  // A second transition discounts again — each call IS one confirmed
  // transition; the once-per-transition wiring is proven by integration (14).
  // Reaching zero REMOVES the effect (via the service) without writing a
  // persisted 0; the last persisted value stays at the last discounted one.
  const secondSummary = await processSw25DurationEvent(combat, { kind: "round-end", round: 3 });
  assert.equal(secondSummary.expired.length, 1, "the second transition expired the effect at zero");
  assert.equal(effect.deleted, true, "the effect is removed when the duration runs out (via service)");
  assert.equal(effect.system.remainingDuration, 1, "the last persisted value before removal (no persisted zero)");
  record("direct roundEnd application accepted and processed once per transition; removal at zero");
}

// ── 5. Independence between different combatants' effects ───────────────────

console.log("=== 5. effects of different combatants do not interfere ===");
{
  const a1 = new MockActor("ind-1", "Ind One");
  const a2 = new MockActor("ind-2", "Ind Two");
  const c1 = makeCombatant("cmbt-i1", a1);
  const c2 = makeCombatant("cmbt-i2", a2);
  const combat = new MockCombat({ combatants: [c1, c2] });

  const e1 = await applyEffect(a1, {
    family: "First",
    initialDuration: 3, remainingDuration: 3, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-i1" }
  });
  const e2 = await applyEffect(a2, {
    family: "Second",
    initialDuration: 3, remainingDuration: 3, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-i2" }
  });

  await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-i1" });
  assert.equal(e1.system.remainingDuration, 2, "combatant one's effect discounted");
  assert.equal(e2.system.remainingDuration, 3, "combatant two's effect untouched");
  record("each combatant's anchor drives only its own effects");
}

// ── 6. Two tokens of the same Actor: independent anchors ────────────────────

console.log("=== 6. two combatants of the same Actor keep independent anchors ===");
{
  const sharedActor = new MockActor("shared-a", "Shared");
  const tokenOne = makeCombatant("cmbt-s1", sharedActor, { tokenId: "tok-s1" });
  const tokenTwo = makeCombatant("cmbt-s2", sharedActor, { tokenId: "tok-s2" });
  const combat = new MockCombat({ combatants: [tokenOne, tokenTwo] });

  const e1 = await applyEffect(sharedActor, {
    family: "SharedEffect",
    initialDuration: 2, remainingDuration: 2, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-s1", tokenId: "tok-s1" }
  });
  const e2 = await applyEffect(sharedActor, {
    family: "SharedEffect II",
    initialDuration: 5, remainingDuration: 5, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-s2", tokenId: "tok-s2" }
  });

  await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-s1" });
  assert.equal(e1.system.remainingDuration, 1, "token one's anchor discounted");
  assert.equal(e2.system.remainingDuration, 5, "token two's anchor untouched");
  assert.deepEqual(e1.system.durationAnchor.combatantId, "cmbt-s1", "anchor identity untouched");
  record("per-combatant independence inside a shared Actor (no inheritance)");
}

// ── 7. Availability: the four D5 cases (unit) ───────────────────────────────

console.log("=== 7. sw25AnchorAvailability distinguishes the D5 cases ===");
{
  const actor = new MockActor("avail-a", "Avail");
  const combat = new MockCombat({ combatants: [
    makeCombatant("cmbt-ok", actor),
    makeCombatant("cmbt-dead", actor, { defeated: true }),
    makeCombatant("cmbt-status", actor, { isDefeated: true }),
    makeCombatant("cmbt-token", actor, { tokenId: "tok-gone", token: null })
  ] });
  const anchorOf = id => ({ regime: "casterTurn", edge: "begin", combatantId: id });

  // Case A: the combatant has not acted yet — still present, anchor valid.
  assert.deepEqual(sw25AnchorAvailability(combat, anchorOf("cmbt-ok")), { available: true, reason: null }, "case A: not acted is available");
  // Case B: having ENDED its actuation does not invalidate the anchor
  // (turnStates are never consulted for availability).
  assert.deepEqual(sw25AnchorAvailability(combat, anchorOf("cmbt-ok")), { available: true, reason: null }, "case B: ended is available");
  // Case C: defeated (flag) and incapacitated (DEFEATED status) unavailable.
  assert.deepEqual(sw25AnchorAvailability(combat, anchorOf("cmbt-dead")), { available: false, reason: "combatant-defeated" }, "case C: defeated unavailable");
  assert.deepEqual(sw25AnchorAvailability(combat, anchorOf("cmbt-status")), { available: false, reason: "combatant-defeated" }, "case C: DEFEATED status unavailable");
  // Case D: token gone and combatant removed from the tracker.
  assert.deepEqual(sw25AnchorAvailability(combat, anchorOf("cmbt-token")), { available: false, reason: "token-gone" }, "case D: token gone unavailable");
  assert.deepEqual(sw25AnchorAvailability(combat, anchorOf("cmbt-missing")), { available: false, reason: "combatant-absent" }, "case D: removed from the tracker unavailable");
  record("the four availability cases distinguished with real signals only");
}

// ── 8. Case B: an ended-but-present anchor is NOT degraded ──────────────────

console.log("=== 8. round sweep does not degrade an anchor that already ended its turn ===");
{
  const casterActor = new MockActor("ended-c", "Ended Caster");
  const targetActor = new MockActor("ended-t", "Ended Target");
  const caster = makeCombatant("cmbt-e1", casterActor);
  const target = makeCombatant("cmbt-e2", targetActor);
  const combat = new MockCombat({ combatants: [caster, target] });

  const effect = await applyEffect(targetActor, {
    family: "Lasting",
    initialDuration: 5, remainingDuration: 5, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-e1" }
  });

  const summary = await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });
  assert.equal(summary.degraded.length, 0, "an available (ended) anchor is not degraded");
  assert.equal(effect.system.durationAnchor.regime, "casterTurn", "regime unchanged");
  assert.equal(effect.updates.length, 0, "no write on an available anchor");
  record("case B: ended anchor stays casterTurn, no write");
}

// ── 9. Case C defeated: degradation at the round transition ─────────────────

console.log("=== 9. defeated anchor degrades to roundEnd without discounting ===");
{
  const casterActor = new MockActor("dead-c", "Dead Caster");
  const targetActor = new MockActor("dead-t", "Dead Target");
  const deadCaster = makeCombatant("cmbt-d1", casterActor, { defeated: true });
  const target = makeCombatant("cmbt-d2", targetActor);
  const combat = new MockCombat({ combatants: [deadCaster, target] });

  const effect = await applyEffect(targetActor, {
    family: "Doom",
    initialDuration: 4, remainingDuration: 4, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-d1", tokenId: "tok-d1" }
  });

  const summary = await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });
  assert.equal(summary.degraded.length, 1, "the unavailable anchor degraded");
  assert.equal(effect.system.durationAnchor.regime, "roundEnd", "regime degraded to roundEnd");
  assert.equal(effect.system.durationAnchor.combatantId, "cmbt-d1", "combatant identity kept as provenance");
  assert.equal(effect.system.durationAnchor.tokenId, "tok-d1", "token identity kept as provenance");
  assert.equal(effect.system.durationAnchor.state, "resolved", "anchor state resolved");
  assert.equal(effect.system.remainingDuration, 4, "NO discount in the degradation transition (no double processing)");
  assert.equal(effect.system.initialDuration, 4, "duration NOT restarted");
  assert.equal(effect.deleted, false, "the effect stays on its target (D5)");
  assert.ok(notifications.some(n => n.kind === "warn" && /Doom/.test(n.message)), "discrete GM notice identifies the effect");

  // From the NEXT round end on, the degraded effect discounts like roundEnd.
  await processSw25DurationEvent(combat, { kind: "round-end", round: 3 });
  assert.equal(effect.system.remainingDuration, 3, "degraded effect counts down from the next round end");
  record("case C: degraded to roundEnd, provenance kept, no restart, counts from the next transition");
}

// ── 10. Case C incapacitated via the DEFEATED status effect ─────────────────

console.log("=== 10. incapacitated anchor (DEFEATED status) degrades too ===");
{
  const casterActor = new MockActor("out-c", "Out Caster");
  const targetActor = new MockActor("out-t", "Out Target");
  const outCaster = makeCombatant("cmbt-o1", casterActor, { isDefeated: true });
  const combat = new MockCombat({ combatants: [outCaster, makeCombatant("cmbt-o2", targetActor)] });

  const effect = await applyEffect(targetActor, {
    family: "Bind",
    initialDuration: 3, remainingDuration: 3, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-o1" }
  });

  await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });
  assert.equal(effect.system.durationAnchor.regime, "roundEnd", "the incapacitated (status) anchor degraded");
  record("case C via status effect: same degradation path as defeat");
}

// ── 11. Case D: anchor combatant removed from the tracker ───────────────────

console.log("=== 11. anchor combatant removed from the tracker degrades (no reassignment) ===");
{
  const casterActor = new MockActor("gone-c", "Gone Caster");
  const targetActor = new MockActor("gone-t", "Gone Target");
  const otherToken = makeCombatant("cmbt-g2", casterActor, { tokenId: "tok-g2" }); // same Actor, still present
  const combat = new MockCombat({ combatants: [otherToken, makeCombatant("cmbt-g3", targetActor)] });

  const effect = await applyEffect(targetActor, {
    family: "Anchor",
    initialDuration: 3, remainingDuration: 3, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-g1", tokenId: "tok-g1" }
  });

  // The anchor combatant cmbt-g1 was removed from the encounter; a DIFFERENT
  // combatant of the same Actor (cmbt-g2) is still present.
  await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });

  assert.equal(effect.system.durationAnchor.regime, "roundEnd", "the removed anchor degraded");
  assert.equal(effect.system.durationAnchor.combatantId, "cmbt-g1", "the anchor was NOT reassigned to the other token");
  assert.equal(effect.system.remainingDuration, 3, "no discount in the degradation transition");
  record("case D: degraded without inheriting the anchor to another token of the same Actor");
}

// ── 12. counted turns decrement at matching edges; condition turns remain ───

console.log("=== 12. counted turns: matching-edge countdown, zero expiry, condition/manual untouched ===");
{
  const casterActor = new MockActor("scale-c", "Scale Caster");
  const secondCasterActor = new MockActor("scale-c2", "Second Scale Caster");
  const carrier = new MockActor("scale-t", "Scale Carrier");
  const caster = makeCombatant("cmbt-s1", casterActor);
  const secondCaster = makeCombatant("cmbt-s3", secondCasterActor);
  const combat = new MockCombat({ combatants: [caster, makeCombatant("cmbt-s2", carrier), secondCaster] });

  const lastRound = await applyEffect(carrier, {
    family: "Last",
    initialDuration: 1, remainingDuration: 1, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-s1" }
  });
  const condition = await applyEffect(carrier, {
    family: "Stance",
    durationScale: "turns",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-s1" }
  });
  const twoTurns = await applyEffect(carrier, {
    family: "Two Turns",
    initialDuration: 2, remainingDuration: 2, durationScale: "turns",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-s1" }
  });
  const oneTurn = await applyEffect(carrier, {
    family: "One Turn",
    initialDuration: 1, remainingDuration: 1, durationScale: "turns",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-s1" }
  });
  const independent = await applyEffect(carrier, {
    family: "Independent Turns",
    initialDuration: 2, remainingDuration: 2, durationScale: "turns",
    durationAnchor: { regime: "targetTurn", edge: "end", combatantId: "cmbt-s3" }
  });
  const minutes = await applyEffect(carrier, { family: "Long Ritual", durationScale: "minutes" });
  const hours = await applyEffect(carrier, { family: "Longer Ritual", durationScale: "hours" });
  const days = await applyEffect(carrier, { family: "Longest Ritual", durationScale: "days" });
  const permanent = await applyEffect(carrier, { family: "Everlasting", durationScale: "permanent" });
  const other = await applyEffect(carrier, { family: "Strange", durationScale: "other" });
  const legacy = handBuiltEffect(carrier, {
    schemaVersion: 1, family: "Legacy", rank: 0, successValue: 1,
    initialDuration: 2, remainingDuration: 2
  }, "Legacy Flag Effect");

  // Wrong combatant, wrong edge, and round transition do not consume a
  // casterTurn/begin counter.
  await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-s3" });
  await processSw25DurationEvent(combat, { kind: "turn-end", combatantId: "cmbt-s1" });
  await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });
  assert.equal(twoTurns.system.remainingDuration, 2, "unrelated events do not discount the counted turn duration");
  assert.equal(independent.system.remainingDuration, 2, "a different anchor and edge do not discount this effect");

  await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-s1" });

  assert.equal(lastRound.deleted, true, "a rounds effect reaching zero is removed (via service)");
  assert.equal(condition.deleted, true, "a turns condition expires at its edge");
  assert.equal(condition.system.remainingDuration ?? null, null, "turns never touched a numeric counter");
  assert.equal(oneTurn.deleted, true, "N=1 expires on its first matching turn edge");
  assert.equal(twoTurns.deleted, false, "a counted turn effect remains while one turn remains");
  assert.equal(twoTurns.system.remainingDuration, 1, "the matching caster begin edge decrements exactly once");
  assert.equal(independent.system.remainingDuration, 2, "the targetTurn/end effect remains untouched");

  await processSw25DurationEvent(combat, { kind: "turn-end", combatantId: "cmbt-s1" });
  await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-s1" });
  assert.equal(twoTurns.deleted, true, "the second distinct matching begin edge removes the N=2 effect");
  assert.equal(twoTurns.system.remainingDuration, 1, "only the remaining value before removal is retained");
  await processSw25DurationEvent(combat, { kind: "turn-end", combatantId: "cmbt-s3" });
  assert.equal(independent.system.remainingDuration, 1, "its own targetTurn/end anchor decrements independently");
  assert.equal(independent.deleted, false, "independent counted effect remains while turns remain");
  assert.equal(minutes.deleted, false, "minutes untouched");
  assert.equal(hours.deleted, false, "hours untouched");
  assert.equal(days.deleted, false, "days untouched");
  assert.equal(permanent.deleted, false, "permanent untouched");
  assert.equal(other.deleted, false, "other untouched");
  assert.equal(legacy.deleted, false, "legacy scale-less effect untouched");
  assert.equal(legacy.updates.length, 0, "legacy effect received no writes");
  assert.equal(minutes.updates.length + hours.updates.length + days.updates.length + permanent.updates.length + other.updates.length, 0, "manual scales received no writes");

  const persistedZero = handBuiltEffect(carrier, {
    schemaVersion: 1, family: "Persisted Zero Turns", rank: 0, successValue: 5,
    initialDuration: 1, remainingDuration: 0, durationScale: "turns",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-s1", tokenId: null, state: "resolved" }
  }, "Persisted Zero Turns");
  await processSw25DurationEvent(combat, { kind: "turn-end", combatantId: "cmbt-s1" });
  assert.equal(persistedZero.deleted, false, "a persisted zero counter ignores a non-matching edge");
  const zeroSummary = await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-s1" });
  assert.equal(persistedZero.deleted, true, "a persisted zero counted-turn effect expires at its next matching event");
  assert.ok(zeroSummary.expired.some(entry => entry.effectId === persistedZero.id), "zero-counter expiry is reported through the normal summary");
  record("rounds and counted turns expire at zero; condition turns/manual scales/legacy behavior preserved");
}

// ── 13. Deferred anchors are never processed or degraded ────────────────────

console.log("=== 13. deferred anchors: skipped everywhere, never auto-resolved ===");
{
  const actor = new MockActor("def-a", "Deferred Carrier");
  const carrier = makeCombatant("cmbt-f1", actor);
  const combat = new MockCombat({ combatants: [carrier] });

  const effect = handBuiltEffect(actor, {
    schemaVersion: 1, family: "Prepared", rank: 0, successValue: 2,
    initialDuration: 3, remainingDuration: 3,
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: null, tokenId: null, state: "deferred" }
  }, "Prepared");

  await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-f1" });
  await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });

  assert.equal(effect.system.remainingDuration, 3, "deferred anchor never discounted");
  assert.equal(effect.system.durationAnchor.state, "deferred", "deferred state never auto-resolved");
  assert.equal(effect.system.durationAnchor.regime, "casterTurn", "regime never changed");
  assert.equal(effect.updates.length, 0, "no writes on a deferred anchor");
  record("deferred anchors skipped (reserved for the future preparation flow)");
}

// ── 14. Integration: the real handleAction flow across a full round ─────────

console.log("=== 14. integration: handleAction drives begin/end edges and the round transition ===");
{
  const casterActor = new MockActor("flow-c", "Flow Caster");
  const targetActor = new MockActor("flow-t", "Flow Target");
  const monsterActor = new MockActor("flow-m", "Flow Monster", "monster");
  const caster = makeCombatant("cmbt-w1", casterActor, { tokenId: "tok-w1" });
  const target = makeCombatant("cmbt-w2", targetActor);
  const monster = makeCombatant("cmbt-w3", monsterActor);
  const combat = new MockCombat({ combatants: [caster, target, monster] });
  seedSideState(combat, { phase: "players", firstPhase: "players" });

  const beginEffect = await applyEffect(targetActor, {
    family: "FlowProt",
    initialDuration: 3, remainingDuration: 3, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-w1" }
  });
  const roundEffect = await applyEffect(targetActor, {
    family: "FlowRound",
    initialDuration: 2, remainingDuration: 2, durationScale: "rounds",
    durationAnchor: { regime: "roundEnd" }
  });

  // Player phase: the caster begins its individual turn.
  await beginTurn(combat, [caster.id]);
  assert.equal(beginEffect.system.remainingDuration, 2, "begin-turn discounted the casterTurn begin anchor");

  await finishTurn(combat, [caster.id]);

  // Side switch to monsters (firstPhase players): no round transition yet.
  await handleAction({ action: "end-player", combatId: combat.id, combatantIds: [caster.id, target.id], gmOverride: true }, "user-gm");
  const afterSwitch = stateOf(combat);
  assert.equal(afterSwitch.phase, "monsters", "side switch happened");
  assert.equal(combat.round, 1, "no round change on the side switch");

  // Monster phase completes: new round → roundEnd processed ONCE.
  await handleAction({ action: "end-monster", combatId: combat.id, combatantIds: [monster.id], gmOverride: true }, "user-gm");
  const afterRound = stateOf(combat);
  assert.equal(afterRound.phase, "players", "phase back to players");
  assert.equal(combat.round, 2, "the round advanced");
  assert.equal(roundEffect.system.remainingDuration, 1, "roundEnd discounted EXACTLY once per transition");
  assert.equal(beginEffect.system.remainingDuration, 2, "the turn-end edge did not discount the begin-edge effect (no double)");

  // Second round: begin discounts again; the round transition expires the
  // roundEnd effect.
  seedSideState(combat, { phase: "players", firstPhase: "players", round: 2 });
  await beginTurn(combat, [caster.id]);
  assert.equal(beginEffect.system.remainingDuration, 1, "second round begin discounted again");
  await handleAction({ action: "end-player", combatId: combat.id, combatantIds: [caster.id, target.id], gmOverride: true }, "user-gm");
  await handleAction({ action: "end-monster", combatId: combat.id, combatantIds: [monster.id], gmOverride: true }, "user-gm");
  assert.equal(roundEffect.deleted, true, "the roundEnd effect expired at zero (removed via service)");
  assert.equal(combat.round, 3, "second round transition confirmed");
  record("full handleAction flow: edges, once-per-transition roundEnd, expiry at zero");
}

// ── 15. No double discount for an already-ended combatant in end-player ─────

console.log("=== 15. finish-turn then end-player: no second turn-end event ===");
{
  const casterActor = new MockActor("dbl-c", "Double Caster");
  const targetActor = new MockActor("dbl-t", "Double Target");
  const caster = makeCombatant("cmbt-x1", casterActor);
  const target = makeCombatant("cmbt-x2", targetActor);
  const combat = new MockCombat({ combatants: [caster, target] });
  seedSideState(combat, { phase: "players", firstPhase: "monsters" });

  const effect = await applyEffect(targetActor, {
    family: "OnceOnly",
    initialDuration: 5, remainingDuration: 5, durationScale: "turns",
    durationAnchor: { regime: "casterTurn", edge: "end", combatantId: "cmbt-x1" }
  });

  await beginTurn(combat, [caster.id]);
  await finishTurn(combat, [caster.id]);
  assert.equal(effect.system.remainingDuration, 4, "finish-turn discounted once");

  // end-player marks the same combatant again: the ACTUAL transition is
  // already "ended", so no second event may fire.
  await handleAction({ action: "end-player", combatId: combat.id, combatantIds: [caster.id], gmOverride: true }, "user-gm");
  assert.equal(effect.system.remainingDuration, 4, "end-player did not double-discount the ended combatant");
  assert.equal(effect.updateAttempts, 1, "exactly one write attempt on the effect");

  // A NOT-yet-ended combatant in the same end-player call DOES produce the
  // event (its actuation ends with the side).
  await beginTurn(combat, [target.id]);
  const targetEffect = await applyEffect(targetActor, {
    family: "SelfEnd",
    initialDuration: 3, remainingDuration: 3, durationScale: "rounds",
    durationAnchor: { regime: "targetTurn", edge: "end", combatantId: "cmbt-x2" }
  });
  await handleAction({ action: "end-player", combatId: combat.id, combatantIds: [target.id], gmOverride: true }, "user-gm");
  assert.equal(targetEffect.system.remainingDuration, 2, "end-player produced the turn-end event for the combatant that ended now");
  record("no double discount; the actual transition drives the events");
}

// ── 16. Failure isolation, GM notification, no retry after saveState ────────

console.log("=== 16. one failing effect does not stop the others; failure is reported; no retries ===");
{
  const actor = new MockActor("fail-a", "Fail Carrier");
  const carrier = makeCombatant("cmbt-h1", actor);
  const combat = new MockCombat({ combatants: [carrier] });

  const broken = await applyEffect(actor, {
    family: "Broken",
    initialDuration: 3, remainingDuration: 3, durationScale: "rounds",
    durationAnchor: { regime: "roundEnd" }
  });
  const healthy = await applyEffect(actor, {
    family: "Healthy",
    initialDuration: 3, remainingDuration: 3, durationScale: "rounds",
    durationAnchor: { regime: "roundEnd" }
  });
  broken.failNextUpdate = true; // the NEXT write (the discount) fails
  lastNotifications();

  const summary = await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });

  assert.equal(summary.failures.length, 1, "exactly one failure recorded");
  assert.equal(summary.failures[0].effectId, broken.id, "the failure identifies the effect");
  assert.match(summary.failures[0].eventLabel, /round transition to round 2/, "the failure identifies the event");
  assert.equal(summary.discounted.length, 1, "the OTHER effect was still processed (no silent loss)");
  assert.equal(healthy.system.remainingDuration, 2, "the healthy effect discounted");
  assert.equal(broken.system.remainingDuration, 3, "the broken effect unchanged");
  assert.equal(broken.updateAttempts, 1, "no automatic retry: exactly one write attempt");

  const gmErrors = notifications.filter(n => n.kind === "error");
  assert.ok(gmErrors.some(n => /Broken/.test(n.message) && /round transition/.test(n.message)), "visible GM notification identifies the effect AND the event");
  lastNotifications();
  record("per-effect isolation, visible GM notification (effect + event), single write attempt");
}

// ── 17. Failure after saveState: the transition is NOT reverted ─────────────

console.log("=== 17. engine failure after saveState keeps the persisted transition ===");
{
  const casterActor = new MockActor("tr-c", "Transition Caster");
  const targetActor = new MockActor("tr-t", "Transition Target");
  const caster = makeCombatant("cmbt-v1", casterActor);
  const target = makeCombatant("cmbt-v2", targetActor);
  const combat = new MockCombat({ combatants: [caster, target] });
  seedSideState(combat, { phase: "players", firstPhase: "players" });

  const effect = await applyEffect(targetActor, {
    family: "Fragile",
    initialDuration: 3, remainingDuration: 3, durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-v1" }
  });
  effect.failNextUpdate = true;
  lastNotifications();

  await beginTurn(combat, [caster.id]);

  // The transition itself was saved (D9: transition first, processing after;
  // a processing failure never reverts or repeats it — D7).
  const state = stateOf(combat);
  assert.equal(state.turnStates[caster.id], "started", "the individual turn transition was persisted despite the engine failure");
  assert.equal(effect.system.remainingDuration, 3, "the failed discount did not write");
  assert.equal(effect.updateAttempts, 1, "exactly one attempt: no automatic retry");
  assert.ok(notifications.some(n => n.kind === "error" && /Fragile/.test(n.message)), "the GM was notified");
  lastNotifications();
  record("transition persisted, single attempt, GM notified (D7/D9)");
}

// ── 18. Open question 5.1: rounds without a counter ─────────────────────────

console.log("=== 18. rounds without a counter: rejected at apply, skipped by the engine ===");
{
  const actor = new MockActor("cnt-a", "Counter Carrier");
  const before = actor.effects.length;

  const rejected = await applySw25Effect(actor, {
    family: "NoCounter",
    cast: { successValue: 1 },
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-cnt" }
  });
  assert.equal(rejected.ok, false, "the application was rejected");
  assert.equal(rejected.code, "rounds-counter-required", "the rejection code is rounds-counter-required");
  assert.equal(actor.effects.length, before, "nothing was written");

  // A declared initial without an explicit remaining is completed (DEC-23):
  // remaining = initial for a fresh application — no duration invented.
  const stamped = await applyEffect(actor, {
    family: "InitialOnly",
    initialDuration: 3,
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", edge: "begin", combatantId: "cmbt-cnt" }
  });
  assert.equal(stamped.system.remainingDuration, 3, "remaining stamped = initial for a fresh rounds application");
  assert.equal(stamped.system.initialDuration, 3, "initial preserved");

  // A PERSISTED counterless rounds effect (legacy/review data) is skipped
  // with a visible GM failure — never an implicit duration.
  const counterless = handBuiltEffect(actor, {
    schemaVersion: 1, family: "Counterless", rank: 0, successValue: 1,
    initialDuration: null, remainingDuration: null,
    durationScale: "rounds",
    durationAnchor: { regime: "roundEnd", edge: "begin", combatantId: null, tokenId: null, state: "resolved" }
  }, "Counterless");
  lastNotifications();

  const combat = new MockCombat({ combatants: [makeCombatant("cmbt-cnt", actor)] });
  const summary = await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });
  assert.equal(summary.failures.length, 1, "the counterless effect produced a failure entry");
  assert.equal(counterless.updates.length, 0, "no write: no implicit duration");
  assert.ok(notifications.some(n => n.kind === "error" && /Counterless/.test(n.message)), "GM notified with the effect identity");
  lastNotifications();
  record("5.1 adopted: rejection at apply, DEC-23 completion, engine skip with GM failure");
}

// ── 19. Open question 5.3: the internal per-combat FIFO ─────────────────────

console.log("=== 19. concurrent dispatches serialize (no lost updates) ===");
{
  const a1 = new MockActor("fifo-1", "Fifo One");
  const a2 = new MockActor("fifo-2", "Fifo Two");
  const c1 = makeCombatant("cmbt-q1", a1);
  const c2 = makeCombatant("cmbt-q2", a2);
  const combat = new MockCombat({ combatants: [c1, c2] });
  seedSideState(combat, { phase: "players", firstPhase: "players" });

  // Fire two dispatches WITHOUT awaiting the first: the FIFO runs them to
  // completion in arrival order, so the second sees the first's writes.
  const first = beginTurn(combat, [c1.id]);
  const second = beginTurn(combat, [c2.id]);
  await Promise.all([first, second]);

  const state = stateOf(combat);
  assert.equal(state.turnStates[c1.id], "started", "first dispatch registered");
  assert.equal(state.turnStates[c2.id], "started", "second dispatch registered (serialized, not lost)");
  assert.deepEqual(state.turnOrder, [c1.id, c2.id], "arrival order preserved by the FIFO");
  record("5.3 adopted: per-combat FIFO serializes the GM dispatch");
}

// ── 20. Persistence guarantees: service-only writes, native isolation ───────

console.log("=== 20. all writes go through EffectService; native expiry stays untouched ===");
{
  const actor = new MockActor("guard-a", "Guard Carrier");
  const carrier = makeCombatant("cmbt-gu", actor);
  const combat = new MockCombat({ combatants: [carrier] });

  const effect = await applyEffect(actor, {
    family: "Guarded",
    initialDuration: 2, remainingDuration: 2, durationScale: "rounds",
    durationAnchor: { regime: "roundEnd" }
  });

  // A DIRECT write outside the service is cancelled by the registered guard.
  const direct = await effect.update({ "system.remainingDuration": 99 });
  assert.equal(direct, null, "the write guard cancels a direct write outside the service");
  assert.equal(effect.system.remainingDuration, 2, "the direct write had no effect");

  // Engine processing keeps working through the service.
  await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });
  assert.equal(effect.system.remainingDuration, 1, "the engine's service write went through the authorization window");
  assert.equal(effect.duration?.value ?? null, null, "native duration.value still null");
  assert.equal(effect.duration?.expiry ?? null, null, "native duration.expiry still null");
  assert.equal(globalThis.CONFIG, undefined, "CONFIG never created or modified");
  record("service-only writes verified against the real guard; native duration untouched");

  // Source sweep of the engine: no banned API appears anywhere.
  const engineSource = readFileSync(new URL("../module/effects/duration-engine.mjs", import.meta.url), "utf8");
  for (const banned of [
    "createEmbeddedDocuments", "deleteEmbeddedDocuments",
    "expiryEvents", "ActiveEffect.registry", "worldTime", "dawn",
    "endCombat", "expiryAction"
  ]) {
    assert.ok(!engineSource.includes(banned), `the engine source never references ${banned}`);
  }
  assert.ok(!/duration\.value\s*=/.test(engineSource), "the engine never assigns duration.value");
  assert.ok(!/duration\.expiry\s*=/.test(engineSource), "the engine never assigns duration.expiry");
  record("engine source sweep: no native expiry machinery, no direct document writes");
}

// ── 21. Generic creator: fixed SV + counted roundEnd descriptor integration ─

console.log("=== 21. Generic creator descriptors persist and expire through the real roundEnd flow ===");
{
  const actor = new MockActor("generic-duration", "Generic Duration Carrier");
  const carrier = makeCombatant("cmbt-generic-duration", actor);
  const combat = new MockCombat({ combatants: [carrier] });
  const built = buildSw25GenericEffectConfiguration({
    id: "generic-roundend",
    name: "Generic Round Ward",
    description: "A configured persistent effect.",
    magical: "magical",
    successValue: "14",
    effectType: "",
    durationScale: "rounds",
    durationValue: "2"
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.configured.initialDuration, 2);
  assert.deepEqual(built.configured.durationAnchor, { regime: "roundEnd" });

  // This is the same application entry point used by the configurator and by
  // drag-and-drop; no direct ActiveEffect write is introduced for the test.
  const applied = await applySw25ConfiguredEffect(actor, built.configured, { notify: false });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const effect = actor.effects.find(candidate => candidate.id === applied.effectId);
  assert.ok(effect);
  assert.equal(effect.system.successValue, 14);
  assert.equal(effect.system.successValueSource, "fixed");
  assert.equal(effect.system.isMagical, true);
  assert.equal(effect.system.initialDuration, 2);
  assert.equal(effect.system.remainingDuration, 2, "fresh remaining counter initialized by EffectService");
  assert.deepEqual(effect.system.durationAnchor, {
    regime: "roundEnd", edge: "begin", combatantId: null, tokenId: null, state: "resolved"
  });

  const discounted = await processSw25DurationEvent(combat, { kind: "round-end", round: 2 });
  assert.equal(discounted.discounted.length, 1);
  assert.equal(effect.system.remainingDuration, 1);
  assert.equal(effect.system.initialDuration, 2, "the initial counter is not restarted or overwritten");
  const expired = await processSw25DurationEvent(combat, { kind: "round-end", round: 3 });
  assert.equal(expired.expired.length, 1);
  assert.equal(effect.deleted, true, "zero rounds removes the configured effect through EffectService");
  assert.equal(effect.duration?.value ?? null, null);
  assert.equal(effect.duration?.expiry ?? null, null);
  record("generic descriptor → configured application → persisted fixed SV/counters → roundEnd discount and removal");
}

console.log("\nAll duration engine checks passed.");
