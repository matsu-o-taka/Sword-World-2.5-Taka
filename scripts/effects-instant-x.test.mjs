// Sword World 2.5 - Instant/X effect application test suite (T5.7).
//
// Exercises module/effects/instant-x.mjs `applySw25InstantXEffect` in a single
// headless process, verifying the DEC-40/DEC-49 separation:
//
//   - The immediate part is resolved during casting, exactly once, and is
//     NEVER persisted as an ActiveEffect.
//   - The persistent component is an ActiveEffect created through EffectService
//     (sole writer, DEC-36), representing only the pending resolution queue.
//   - No persistent `instantX` field is stored on the effect (DEC-49).
//   - The persistent effect integrates with T5.2 durationScale/durationAnchor
//     and the T5.3 duration engine; no parallel temporal system.
//
// 9 cases:
//   1. Immediate part is not stored as an ActiveEffect (only the persistent
//      part creates an effect).
//   2. Persistent part is created through EffectService's write path.
//   3. No `instantX` field on the persistent effect's system.*.
//   4. Manual duration scale (minutes) without an anchor is accepted.
//   5. Combat duration scale (rounds) requires a combat anchor (D4 rejection).
//   6. Rounds-scale persistent effect is processable by T5.3 duration engine.
//   7. Re-processing does not store any immediate-part-executed flag.
//   8. EffectService write guard blocks direct ActiveEffect writes.
//   9. Function returns effectId/successValue for the caller to resolve the
//      immediate part during casting.

import assert from "node:assert/strict";

// ── Global Foundry environment mock (before any effect-module import) ──────

const notifications = [];
const socketEmissions = [];
const registeredHooks = new Map();
const gameUsers = [];

const actorsCollection = [];
actorsCollection.get = id => actorsCollection.find(a => a.id === id || a.uuid === id) ?? null;

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
    this.deleted = false;
  }
  async update(changes) {
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
    const owner = actorsCollection.find(actor => actor.effects.includes(this));
    if (owner) owner.effects = actor.effects.filter(effect => effect !== this);
    return this;
  }
}

class MockActor {
  constructor(id, name, type = "character") {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.name = name;
    this.type = type;
    this.effects = [];
    this.createCalls = [];
    this.deleteCalls = [];
    this.directCreateBlocked = false;
  }
  async createEmbeddedDocuments(type, dataArray) {
    const created = [];
    for (const data of dataArray) {
      const effect = new MockEffect({ ...data, id: `ef-${nextMockId++}` });
      const blocked = await fireWriteHook("preCreateActiveEffect", effect, structuredClone(data), {}, game.user.id ?? null);
      if (blocked) { this.directCreateBlocked = true; created.push(null); continue; }
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
    this.deleteCalls.push({ type, ids: [...ids] });
    this.effects = this.effects.filter(effect => !removed.includes(effect));
    removed.forEach(effect => { effect.deleted = true; });
    return removed;
  }
  getFlag() { return undefined; }
  async update() { return this; }
}

globalThis.game = {
  user: { isGM: false, id: "player-1" },
  actors: actorsCollection,
  users: {
    get(id) { return gameUsers.find(u => u.id === id || u._id === id) ?? null; },
    filter(fn) { return gameUsers.filter(fn); },
    get activeGM() { return gameUsers.find(u => u.isGM && u.active) ?? null; }
  },
  socket: {
    async emit(channel, payload) {
      socketEmissions.push({ channel, payload });
    },
    on() {}
  },
  combats: { get: () => null },
  combat: null
};

async function fireWriteHook(name, ...args) {
  let blocked = false;
  for (const listener of registeredHooks.get(name) ?? []) {
    const result = await listener(...args);
    if (result === false) blocked = true;
  }
  return blocked;
}

globalThis.Hooks = {
  on(name, fn) {
    const list = registeredHooks.get(name) ?? [];
    list.push(fn);
    registeredHooks.set(name, list);
  }
};

globalThis.ui = {
  notifications: {
    warn(message) { notifications.push({ kind: "warn", message }); },
    info(message) { notifications.push({ kind: "info", message }); },
    error(message) { notifications.push({ kind: "error", message }); }
  }
};

globalThis.fromUuid = async uuid => actorsCollection.find(a => a.uuid === uuid) ?? null;

globalThis.foundry = {
  data: {
    ActiveEffectTypeDataModel: class ActiveEffectTypeDataModelStub {}
  },
  utils: {
    escapeHtml: value => String(value),
    randomID() { return `r${Math.random().toString(36).slice(2, 12)}`; }
  }
};

function setPlayer(id = "player-1") {
  game.user.isGM = false;
  game.user.id = id;
}

function setGm() {
  game.user.isGM = true;
  game.user.id = "gm-user";
}

// ── Module imports (after the environment mock) ────────────────────────────

const service = await import("../module/effects/effect-service.mjs");
const instantX = await import("../module/effects/instant-x.mjs");
const engine = await import("../module/effects/duration-engine.mjs");
const effectsTab = await import("../module/effects/effects-tab.mjs");

const {
  applySw25Effect,
  registerSw25StackingResolver,
  initializeEffectService
} = service;
const { applySw25InstantXEffect } = instantX;
const { processSw25DurationEvent } = engine;
const { SW25_EFFECT_SUBTYPE } = effectsTab;

// Register the stacking resolver and service guards (production wiring).
registerSw25StackingResolver(() => ({ outcome: "accumulate" }));
initializeEffectService();

gameUsers.push(
  { id: "gm-user", _id: "gm-user", isGM: true, active: true, name: "GameMaster" },
  { id: "player-1", _id: "player-1", isGM: false, active: true, name: "Player One" }
);

const record = label => console.log(`  ${label}`);

// ── Fixtures ───────────────────────────────────────────────────────────────

function applyPayload(overrides = {}) {
  return { family: "Protection", rank: 1, cast: { successValue: 7 }, ...overrides };
}

// ── 1. Immediate part is not stored as an ActiveEffect ─────────────────────

{
  setGm();
  const actor = new MockActor("a1", "Target");
  const result = await applySw25InstantXEffect(actor, applyPayload({
    durationScale: "minutes" // persistent part only; no `instantX` marker
  }));
  assert.equal(result.ok, true, "Instant/X apply should succeed");
  assert.equal(actor.effects.length, 1, "Exactly one persistent ActiveEffect is created");
  assert.equal(actor.effects[0].type, SW25_EFFECT_SUBTYPE, "The created effect is a sw25Effect");
  // No effect carries an `instantX` flag or any immediate-part-executed marker.
  assert.equal(actor.effects[0].system.instantX, undefined, "No `instantX` field on the persistent effect");
  assert.equal(actor.createCalls.length, 1, "Exactly one createEmbeddedDocuments call (EffectService write path)");
  record("case 1: immediate part not stored as ActiveEffect; one persistent effect created");
}

// ── 2. Persistent part is created through EffectService's write path ───────

{
  setGm();
  const actor = new MockActor("a2", "Target");
  const result = await applySw25InstantXEffect(actor, applyPayload({
    durationScale: "minutes",
    changes: [{ key: "attrs.protection.value", value: 5 }]
  }));
  assert.equal(result.ok, true, "Apply should succeed");
  assert.equal(result.code, "applied", "EffectService reports applied");
  assert.equal(actor.effects.length, 1, "One effect created through the service");
  assert.equal(actor.effects[0].system.changes.length, 1, "Persistent changes are stored");
  assert.equal(actor.effects[0].system.changes[0].key, "attrs.protection.value", "Change key preserved");
  record("case 2: persistent part created through EffectService write path");
}

// ── 3. No `instantX` field on the persistent effect ────────────────────────

{
  setGm();
  const actor = new MockActor("a3", "Target");
  const result = await applySw25InstantXEffect(actor, applyPayload({
    durationScale: "hours"
  }));
  assert.equal(result.ok, true);
  const systemKeys = Object.keys(actor.effects[0].system);
  assert.ok(!systemKeys.includes("instantX"), "No instantX key in system.* (DEC-49)");
  assert.ok(!systemKeys.includes("stackKey"), "No stackKey key in system.* (DEC-49)");
  assert.ok(!systemKeys.includes("familyKey"), "No familyKey key in system.* (DEC-49)");
  assert.ok(!systemKeys.includes("canonicalName"), "No canonicalName key in system.* (DEC-49)");
  record("case 3: no instantX or other DEC-49-forbidden fields on the effect");
}

// ── 4. Manual duration scale without anchor is accepted ────────────────────

{
  setGm();
  const actor = new MockActor("a4", "Target");
  const result = await applySw25InstantXEffect(actor, applyPayload({
    durationScale: "minutes"
  }));
  assert.equal(result.ok, true, "Manual scale without anchor should be accepted");
  assert.equal(actor.effects[0].system.durationScale, "minutes");
  assert.equal(actor.effects[0].system.durationAnchor, null, "No anchor on manual scale");
  record("case 4: manual scale (minutes) without anchor accepted");
}

// ── 5. Combat duration scale requires an anchor (D4 rejection) ─────────────

{
  setGm();
  const actor = new MockActor("a5", "Target");
  const result = await applySw25InstantXEffect(actor, applyPayload({
    durationScale: "rounds"
    // No durationAnchor — D4 requires one for combat scales
  }));
  assert.equal(result.ok, false, "Combat scale without anchor should be rejected");
  assert.equal(result.code, "anchor-required", "Rejection code is anchor-required (D4)");
  assert.equal(actor.effects.length, 0, "No effect persisted when anchor is missing");
  record("case 5: combat scale (rounds) requires combat anchor (D4)");
}

// ── 6. Rounds-scale persistent effect is processable by T5.3 engine ────────

{
  setGm();
  const actor = new MockActor("a6", "Target");
  const applied = await applySw25InstantXEffect(actor, applyPayload({
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-caster-A" },
    initialDuration: 3,
    remainingDuration: 3
  }));
  assert.equal(applied.ok, true, "Rounds-scale Instant/X effect applied");
  assert.equal(actor.effects[0].system.remainingDuration, 3, "Initial counter set");

  // Process a turn-end event for the anchor combatant (T5.3 engine).
  // combatants is an array (iterable) with a .get lookup, mirroring MockCombat.
  const combatants = [{ id: "cmbt-caster-A", name: "Caster", actor, defeated: false, tokenId: "tkn-A", token: { id: "tkn-A" } }];
  combatants.get = cid => combatants.find(c => c.id === cid) ?? null;
  const combat = {
    id: "combat-1",
    round: 1,
    turn: null,
    started: true,
    combatants
  };

  const summary = await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-caster-A" });
  assert.equal(summary.ok, true, "Duration engine processed the event");
  assert.equal(actor.effects[0].system.remainingDuration, 2, "Counter decremented by the engine");
  record("case 6: rounds-scale persistent effect processable by T5.3 engine");
}

// ── 7. Re-processing does not store any immediate-part-executed flag ───────

{
  setGm();
  const actor = new MockActor("a7", "Target");
  const first = await applySw25InstantXEffect(actor, applyPayload({ durationScale: "minutes" }));
  const second = await applySw25InstantXEffect(actor, applyPayload({ durationScale: "minutes" }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(actor.effects.length, 2, "Two separate persistent effects (accumulate)");
  for (const effect of actor.effects) {
    assert.equal(effect.system.instantX, undefined, "No instantX flag on re-processed effect");
    assert.equal(effect.system.immediateExecuted, undefined, "No immediate-part-executed flag");
    assert.equal(effect.system.immediateResolved, undefined, "No immediate-part-resolved flag");
  }
  record("case 7: re-processing stores no immediate-part-executed flag");
}

// ── 8. EffectService write guard blocks direct ActiveEffect writes ─────────

{
  setGm();
  const actor = new MockActor("a8", "Target");
  // Direct write outside EffectService's authorization window: the guard
  // registered by initializeEffectService blocks it (serviceWriteDepth === 0).
  const direct = await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: SW25_EFFECT_SUBTYPE,
    name: "Direct Write",
    system: { schemaVersion: 1, family: "Protection", rank: 0, successValue: 0 }
  }]);
  assert.equal(actor.directCreateBlocked, true, "Direct write was blocked by the guard");
  assert.equal(direct[0], null, "Direct create returned no effect");
  assert.equal(actor.effects.length, 0, "No effect persisted from the direct write");
  record("case 8: EffectService write guard blocks direct ActiveEffect writes");
}

// ── 9. Function returns effectId/successValue for the caller ───────────────

{
  setGm();
  const actor = new MockActor("a9", "Target");
  const result = await applySw25InstantXEffect(actor, applyPayload({
    durationScale: "minutes",
    cast: { successValue: 12 }
  }));
  assert.equal(result.ok, true);
  assert.equal(typeof result.effectId, "string", "Returns effectId");
  assert.equal(result.effectId, actor.effects[0].id, "effectId matches the created effect");
  assert.equal(result.successValue, 12, "Returns the successValue for the caller");
  // The caller can now resolve the immediate part during casting (e.g. deal
  // damage, apply healing) without storing it as an ActiveEffect.
  record("case 9: function returns effectId/successValue for the caller");
}

// ── Completion ─────────────────────────────────────────────────────────────

console.log("T5.7 Instant/X: all 9 cases passed.");
process.exit(0);
