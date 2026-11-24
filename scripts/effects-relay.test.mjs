// Sword World 2.5 - EffectService + effect relay test suite (T2.1/T2.2).
//
// Exercises the full player -> GM -> EffectService -> ack cycle of
// module/effects/effect-relay.mjs plus the service contract of
// module/effects/effect-service.mjs in a single headless process. The mock
// socket re-dispatches payloads between "clients" by impersonating the
// receiver (request payloads go to the designated GM, ack payloads to the
// requesting player), exactly like two real Foundry clients exchanging
// messages over the shared system channel. No timers are used anywhere:
// promises settle only through real acks or the event-driven expiry path.
//
// Scope: the four operations (apply/remove/toggle/refresh), the casting
// context and Success Value contract (DEC-6/DEC-50), the write guard that
// keeps non-GM clients from writing system effects directly (DEC-36), the
// resolveStacking extension point (Bloque 4), GM-relay guarantees (no-gm,
// gm-offline, duplicate memoization, sender validation, forged-ack
// rejection) and GM-free reads (T2.5). No stacking policies, durations or
// expiry rules belong to this suite.

import assert from "node:assert/strict";

// ── Global Foundry environment mock ────────────────────────────────────────

const notifications = [];
const socketEmissions = [];
const socketListeners = [];
const registeredHooks = new Map();
const gameUsers = [];
let blockEffectDelivery = false;

const actorsCollection = [];
actorsCollection.get = id => actorsCollection.find(a => a.id === id || a.uuid === id) ?? null;

// ── Mock effect / actor documents ──────────────────────────────────────────

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
    this.duration = data.duration ?? null;
    this.flags = structuredClone(data.flags ?? {});
    this.disabled = data.disabled ?? undefined;
    this.system = structuredClone(data.system ?? {});
    this.updates = [];
    this.deleted = false;
  }
  async update(changes) {
    // Real-Foundry semantics: the write hook runs before the write; a false
    // return cancels it (no update recorded, no data changed).
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
    if (owner) owner.effects = owner.effects.filter(effect => effect !== this);
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
  }
  async createEmbeddedDocuments(type, dataArray) {
    const created = [];
    for (const data of dataArray) {
      const effect = new MockEffect({ ...data, id: `ef-${nextMockId++}` });
      const blocked = await fireWriteHook("preCreateActiveEffect", effect, structuredClone(data), {}, game.user.id ?? null);
      if (blocked) { created.push(null); continue; } // creation prevented
      this.effects.push(effect);
      this.createCalls.push({ type, count: 1 });
      created.push(effect);
    }
    return created;
  }
  writeCount() {
    return this.createCalls.reduce((total, call) => total + call.count, 0)
      + this.effects.reduce((total, effect) => total + effect.updates.length, 0);
  }
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
    // Single-process game.socket: request payloads are delivered to the
    // designated GM client and ack payloads to the requesting client,
    // impersonating the receiver while dispatching the module listener.
    async emit(channel, payload) {
      const senderId = game.user.id ?? null;
      socketEmissions.push({ channel, payload, senderId });
      if (payload?.action === "effect-request") {
        if (blockEffectDelivery) return;
        const receiver = payload.gid ? game.users.get(payload.gid) : null;
        if (!receiver?.isGM) return; // undeliverable: no such GM client
        await deliverAs(receiver.id ?? payload.gid, payload, senderId);
      } else if (payload?.action === "effect-ack") {
        const receiver = payload.requestedBy ? game.users.get(payload.requestedBy) : null;
        if (!receiver) return;
        await deliverAs(receiver.id ?? payload.requestedBy, payload, senderId);
      }
    },
    on(channel, handler) { socketListeners.push(handler); }
  }
};

// Deliver a socket payload while impersonating one client, then restore the
// mocking context. Mirrors how Foundry hands a payload to every other client.
async function deliverAs(userId, payload, senderId) {
  const savedIsGM = game.user.isGM;
  const savedId = game.user.id;
  const receiver = game.users.get(userId);
  game.user.isGM = receiver?.isGM === true;
  game.user.id = receiver?.id ?? userId;
  try {
    for (const listener of [...socketListeners]) {
      await listener(payload, senderId);
    }
  } finally {
    game.user.isGM = savedIsGM;
    game.user.id = savedId;
  }
}

// Fire document hooks manually (headless: no real hook dispatcher).
async function fireEvent(name, ...args) {
  for (const listener of registeredHooks.get(name) ?? []) await listener(...args);
}

// Fire a WRITE hook with real-Foundry cancel semantics: any false return
// cancels the write (the write guard is the listener here).
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
    randomID() { return `r${Math.random().toString(36).slice(2, 12)}`; }
  }
};

function resetWorld() {
  notifications.length = 0;
  socketEmissions.length = 0;
  gameUsers.length = 0;
  gameUsers.push(
    { id: "gm-user", _id: "gm-user", isGM: true, active: true, name: "GameMaster" },
    { id: "gm2-user", _id: "gm2-user", isGM: true, active: true, name: "GameMaster Two" },
    { id: "player-1", _id: "player-1", isGM: false, active: true, name: "Player One" },
    { id: "player-2", _id: "player-2", isGM: false, active: true, name: "Player Two" }
  );
  actorsCollection.length = 0;
  blockEffectDelivery = false;
  setPlayer("player-1");
}

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
const relay = await import("../module/effects/effect-relay.mjs");
const { EFFECT_SCHEMA_VERSION } = await import("../module/effects/effect-repair.mjs");
const { buildSw25CanonicalName } = await import("../module/effects/effect-identity.mjs");
const {
  applySw25ConfiguredEffect,
  buildSw25ConfiguredEffect
} = await import("../module/effects/configured-effect.mjs");
const { buildSw25GenericEffectConfiguration } = await import("../module/effects/effect-configurator.mjs");

const {
  applySw25Effect,
  removeSw25Effect,
  toggleSw25Effect,
  refreshSw25Effect,
  resolveSw25CastSuccessValue,
  guardSw25EffectWrite,
  initializeEffectService,
  listSw25Effects,
  getSw25Effect,
  registerSw25StackingResolver,
  getSw25StackingResolver,
  isSw25EffectServiceWriteActive,
  performSw25EffectRepairWrite
} = service;
const repairLayer = await import("../module/effects/effect-repair.mjs");

const {
  requestSw25EffectOperation,
  initializeEffectRelay,
  listPendingEffectRequests,
  pendingEffectRequestCount,
  expirePendingEffectRequests,
  generateEffectRequestId
} = relay;

resetWorld();
initializeEffectService();
initializeEffectRelay();

// ── Casting context and Success Value (DEC-6/DEC-50) ───────────────────────

{
  assert.deepEqual(resolveSw25CastSuccessValue({ successValue: 7 }), { ok: true, successValue: 7 });
  // SV 0 is legitimate (minor-action casting, DEC-6).
  assert.deepEqual(resolveSw25CastSuccessValue({ successValue: 0 }), { ok: true, successValue: 0 });
  assert.equal(resolveSw25CastSuccessValue({ successValue: -1 }).code, "invalid-success-value");
  assert.equal(resolveSw25CastSuccessValue({ successValue: 2.5 }).code, "invalid-success-value");
  // Minor mode: SV 0, no components accepted.
  assert.deepEqual(resolveSw25CastSuccessValue({ mode: "minor" }), { ok: true, successValue: 0 });
  assert.equal(resolveSw25CastSuccessValue({ mode: "minor", dieTotal: 5 }).code, "ambiguous-cast");
  // Major mode: SV = dieTotal + magicPower.
  assert.deepEqual(resolveSw25CastSuccessValue({ mode: "major", dieTotal: 7, magicPower: 2 }), { ok: true, successValue: 9 });
  // Critical natural 12: SV = 12 + 5 + magicPower (DEC-6).
  assert.deepEqual(resolveSw25CastSuccessValue({ mode: "major", dieTotal: 12, magicPower: 2 }), { ok: true, successValue: 19 });
  assert.equal(resolveSw25CastSuccessValue({ mode: "major", dieTotal: 13, magicPower: 2 }).code, "invalid-cast");
  assert.equal(resolveSw25CastSuccessValue({ mode: "major", dieTotal: 1, magicPower: 2 }).code, "invalid-cast");
  assert.equal(resolveSw25CastSuccessValue({ mode: "major", dieTotal: 7 }).code, "invalid-cast");
  // Mixing a direct value with mode components is rejected, not guessed.
  assert.equal(resolveSw25CastSuccessValue({ successValue: 5, mode: "major", dieTotal: 3, magicPower: 1 }).code, "ambiguous-cast");
  assert.equal(resolveSw25CastSuccessValue({ mode: "minor", successValue: 0 }).code, "ambiguous-cast");
  assert.equal(resolveSw25CastSuccessValue(null).code, "no-cast-context");
  assert.equal(resolveSw25CastSuccessValue({ mode: "teleport" }).code, "invalid-cast");
  console.log("  casting context / Success Value contract (DEC-6/DEC-50)");
}

// ── Service GM gate (defense in depth) ─────────────────────────────────────

{
  const actor = new MockActor("actor-a", "Probe A");
  actorsCollection.push(actor);
  assert.equal((await applySw25Effect(actor, { family: "Protection", cast: { successValue: 5 } })).code, "not-gm");
  assert.equal((await removeSw25Effect(actor, "x")).code, "not-gm");
  assert.equal((await toggleSw25Effect(actor, "x")).code, "not-gm");
  assert.equal((await refreshSw25Effect(actor, "x", { successValue: 1 })).code, "not-gm");
  assert.equal(actor.writeCount(), 0, "no writes happen without GM authority");
  console.log("  service not-gm gate blocks all four operations");
}

// ── Write guard: EffectService is the only writer (DEC-36) ─────────────────

{
  // A non-GM user attempting a direct write of a system effect is rejected.
  setGm();
  const systemEffect = { type: "sw25Effect", name: "Protection" };
  assert.equal(guardSw25EffectWrite(systemEffect, {}, {}, "player-1"), false);
  assert.equal(guardSw25EffectWrite(systemEffect, { disabled: true }, {}, "player-2"), false);
  // The GM no longer bypasses the service either: direct GM writes are
  // rejected exactly like player writes (create / update / delete).
  assert.equal(guardSw25EffectWrite(systemEffect, {}, {}, "gm-user"), false);
  assert.equal(guardSw25EffectWrite(systemEffect, { disabled: true }, {}, "gm-user"), false);
  // Service-owned writes in flight are authorized...
  assert.equal(isSw25EffectServiceWriteActive(), false);
  const authorized = await applySw25Effect(new MockActor("actor-guard", "Guard Probe"), { family: "Guarded", cast: { successValue: 1 } });
  assert.equal(authorized.code, "applied");
  // ...but the window closes as soon as the write settles.
  assert.equal(isSw25EffectServiceWriteActive(), false);
  // Foreign (non-system) effects are never guarded: compatibility untouched.
  assert.equal(guardSw25EffectWrite({ type: "base", name: "Native" }, {}, {}, "player-1"), true);
  assert.equal(guardSw25EffectWrite({ type: "base", name: "Native" }, {}, {}, "gm-user"), true);
  setPlayer();
  // Guards registered on all three write hooks.
  assert.ok((registeredHooks.get("preCreateActiveEffect") ?? []).includes(guardSw25EffectWrite));
  assert.ok((registeredHooks.get("preUpdateActiveEffect") ?? []).includes(guardSw25EffectWrite));
  assert.ok((registeredHooks.get("preDeleteActiveEffect") ?? []).includes(guardSw25EffectWrite));
  console.log("  write guard: only service-owned writes pass (GM included)");
}

// ── Write exclusivity through the real hook path (GM direct writes) ────────

{
  // The mocks fire the registered write hooks before every write, like real
  // Foundry: direct GM writes are cancelled by the guard, service writes pass.
  setGm();
  const actor = new MockActor("actor-exclusive", "Probe Exclusive");
  actorsCollection.push(actor);

  // Direct create by the GM: rejected, nothing written.
  const directCreate = await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "sw25Effect", name: "Rogue", system: { family: "Rogue", schemaVersion: 1 }
  }]);
  assert.equal(directCreate[0], null, "direct GM create is cancelled by the guard");
  assert.equal(actor.effects.length, 0);
  assert.equal(actor.writeCount(), 0);

  // Service apply: authorized, the document is written.
  const applied = await applySw25Effect(actor, { family: "Protection", rank: 2, cast: { successValue: 3 } });
  assert.ok(applied.ok, `service apply should pass its own guard: ${JSON.stringify(applied)}`);
  assert.equal(actor.effects.length, 1);

  // Direct update and delete by the GM: rejected, document unchanged.
  const effect = actor.effects[0];
  assert.equal(await effect.update({ disabled: true }), null, "direct GM update is cancelled");
  assert.equal(effect.updates.length, 0);
  assert.equal(await effect.delete(), null, "direct GM delete is cancelled");
  assert.equal(actor.effects.length, 1);

  // The same operations through the service: authorized.
  const toggled = await toggleSw25Effect(actor, effect.id, { active: true });
  assert.ok(toggled.ok && toggled.disabled === false);
  const removed = await removeSw25Effect(actor, effect.id);
  assert.ok(removed.ok && removed.code === "removed");
  assert.equal(actor.effects.length, 0);

  // Foreign subtype: direct GM writes are NOT guarded (compatibility).
  const native = await actor.createEmbeddedDocuments("ActiveEffect", [{ type: "base", name: "Native" }]);
  assert.ok(native[0], "foreign-subtype direct create is untouched");
  setPlayer();
  console.log("  GM direct create/update/delete rejected; service operations pass");
}

// ── Full relay cycle: player applies, GM executes, player gets the ack ─────

{
  const actor = new MockActor("actor-b", "Probe B");
  actorsCollection.push(actor);
  const result = await requestSw25EffectOperation("apply", {
    actorUuid: actor.uuid,
    family: "Protection",
    rank: 2,
    cast: { mode: "major", dieTotal: 7, magicPower: 2 },
    name: "arbitrary label", // must NOT reach the document: name is canonical
    origin: actor.uuid,
    casterUUID: actor.uuid,
    initialDuration: 4,
    remainingDuration: 3,
    changes: [{ key: "system.attributes.defense", type: "add", value: 2 }]
  });
  assert.ok(result.ok, `relay apply should succeed: ${JSON.stringify(result)}`);
  assert.equal(result.status, "applied");
  assert.equal(result.successValue, 9, "SV = 7 + 2 (DEC-6)");
  assert.ok(result.effectId, "the ack carries the created effect id");

  const effect = actor.effects[0];
  assert.ok(effect, "one persistent effect was created by the GM");
  assert.equal(effect.type, "sw25Effect");
  assert.equal(effect.system.family, "Protection");
  assert.equal(effect.system.rank, 2);
  assert.equal(effect.system.successValue, 9);
  assert.equal(effect.system.initialDuration, 4);
  assert.equal(effect.system.remainingDuration, 3);
  assert.equal(effect.system.schemaVersion, EFFECT_SCHEMA_VERSION);
  assert.deepEqual(effect.system.changes, [{ key: "system.attributes.defense", type: "add", value: 2 }]);
  // The native name is ALWAYS the canonical name from family + rank; the
  // payload's arbitrary name never reaches the document (DEC-16/DEC-49).
  assert.equal(effect.name, "Protection II");
  assert.equal(effect.name, buildSw25CanonicalName("Protection", 2));
  // No duplicated identity fields are ever persisted (DEC-49).
  for (const forbidden of ["canonicalName", "familyKey", "stackKey"]) {
    assert.ok(!(forbidden in effect.system), `${forbidden} must never be persisted`);
  }
  assert.equal(actor.writeCount(), 1);

  // Duplicate delivery of the SAME request: one processing, one write.
  const delivered = socketEmissions.find(emission => emission.payload?.action === "effect-request");
  const writesBefore = actor.writeCount();
  await deliverAs("gm-user", structuredClone(delivered.payload), "player-1");
  assert.equal(actor.writeCount(), writesBefore, "a duplicated delivery must not write twice");
  console.log("  player apply -> GM execution -> ack (with duplicate protection)");
}

// ── Configured-effect player drop: preserve rules and descriptor metadata ──

{
  const actor = new MockActor("actor-configured-relay", "Configured Relay Probe");
  actorsCollection.push(actor);
  const built = buildSw25ConfiguredEffect({
    id: "relay-fire-weakness",
    name: "Relayed Fire Weakness",
    description: "A player-dragged configured effect.",
    origin: null,
    isMagical: true,
    successValue: 12,
    successValueSource: "fixed",
    effectType: "prone",
    durationScale: "rounds",
    initialDuration: 2,
    gmOnly: true,
    rules: [{
      key: "damageVulnerability", value: 3, category: "physical", element: "fire", source: null
    }]
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  const result = await applySw25ConfiguredEffect(actor, built.configured, { notify: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  const effect = actor.effects.find(candidate => candidate.id === result.effectId);
  assert.ok(effect, "the designated GM created the relayed configured effect");
  assert.deepEqual(effect.system.rules, built.configured.rules, "Damage Vulnerability survives player transport");
  assert.equal(effect.system.gmOnly, true);
  assert.deepEqual(effect.flags, {
    "sw25-taka": {
      configuredEffectId: "relay-fire-weakness",
      configuredEffectDescription: "A player-dragged configured effect."
    }
  });
  assert.equal(effect.origin, null, "manual configured effects do not acquire an origin");
  assert.equal(effect.system.isMagical, true);
  assert.equal(effect.system.effectType, "prone");
  assert.equal(effect.system.successValue, 12);
  assert.equal(effect.system.successValueSource, "fixed");
  assert.equal(effect.system.durationScale, "rounds");
  assert.equal(effect.system.initialDuration, 2);
  assert.equal(effect.system.remainingDuration, 2);
  assert.deepEqual(effect.system.durationAnchor, {
    regime: "roundEnd", edge: "begin", combatantId: null, tokenId: null, state: "resolved"
  });

  const generic = buildSw25GenericEffectConfiguration({
    id: "relay-generic",
    name: "Relayed Generic Effect",
    description: "Generic metadata must survive the same player drop.",
    magical: "magical",
    successValue: "9",
    effectType: "curse",
    durationScale: "rounds",
    durationValue: "3"
  });
  assert.equal(generic.ok, true, JSON.stringify(generic));
  const genericResult = await applySw25ConfiguredEffect(actor, generic.configured, { notify: false });
  assert.equal(genericResult.ok, true, JSON.stringify(genericResult));
  const genericEffect = actor.effects.find(candidate => candidate.id === genericResult.effectId);
  assert.ok(genericEffect);
  assert.deepEqual(genericEffect.system.rules, []);
  assert.equal(genericEffect.origin, null);
  assert.equal(genericEffect.system.isMagical, true);
  assert.equal(genericEffect.system.effectType, "curse");
  assert.equal(genericEffect.system.successValue, 9);
  assert.equal(genericEffect.system.successValueSource, "fixed");
  assert.equal(genericEffect.system.initialDuration, 3);
  assert.equal(genericEffect.system.remainingDuration, 3);
  assert.deepEqual(genericEffect.flags, {
    "sw25-taka": {
      configuredEffectId: "relay-generic",
      configuredEffectDescription: "Generic metadata must survive the same player drop."
    }
  });
  console.log("  configured player drops preserve Generic/Damage Vulnerability rules, flags, fixed SV and counted duration");
}

// ── Native name coherence with Family + Rank (DEC-16/DEC-49) ───────────────

{
  setGm();
  const actor = new MockActor("actor-name", "Probe Name");
  actorsCollection.push(actor);
  // Rank 0: no numeral (family only).
  const rank0 = await applySw25Effect(actor, { family: "Power Strike", rank: 0, cast: { successValue: 1 }, name: "wrong label" });
  assert.ok(rank0.ok);
  assert.equal(actor.effects[0].name, buildSw25CanonicalName("Power Strike", 0));
  assert.equal(actor.effects[0].name, "Power Strike");
  // Ranks 1..10 keep the approved numeral format, in every casting mode.
  for (const rank of [1, 5, 10]) {
    const applied = await applySw25Effect(actor, {
      family: "Protection", rank,
      cast: rank === 5 ? { mode: "minor" } : { mode: "major", dieTotal: 4, magicPower: 1 },
      name: "another wrong label"
    });
    assert.ok(applied.ok);
    const effect = actor.effects[actor.effects.length - 1];
    assert.equal(effect.name, buildSw25CanonicalName("Protection", rank), `canonical name for rank ${rank}`);
  }
  assert.equal(actor.effects[1].name, "Protection I");
  assert.equal(actor.effects[2].name, "Protection V");
  assert.equal(actor.effects[3].name, "Protection X");
  // No duplicated identity fields in any of the created documents.
  for (const effect of actor.effects) {
    for (const forbidden of ["canonicalName", "familyKey", "stackKey"]) {
      assert.ok(!(forbidden in effect.system));
    }
  }
  // Repair delegation sanity: the T1.3 layer writes through the service.
  assert.equal((await performSw25EffectRepairWrite(null, { "system.family": "X" })).code, "no-effect");
  assert.equal((await performSw25EffectRepairWrite(actor.effects[0], {})).code, "no-changes");
  setPlayer();
  assert.equal((await performSw25EffectRepairWrite(actor.effects[0], { "system.successValue": 2 })).code, "not-gm");
  setGm();
  const dirty = actor.effects[0];
  const updatedOk = await performSw25EffectRepairWrite(dirty, { "system.successValue": 7 });
  assert.equal(updatedOk.ok, true);
  assert.equal(dirty.system.successValue, 7, "the delegated repair write persisted through the service");
  setPlayer();
  console.log("  native name always canonical (rank 0 and 1..10); repair write delegated to the service");
}

// ── Relay through the four operations ──────────────────────────────────────

{
  const actor = new MockActor("actor-c", "Probe C");
  actorsCollection.push(actor);
  const applied = await requestSw25EffectOperation("apply", {
    actorUuid: actor.uuid,
    family: "Power Strike",
    cast: { successValue: 0 }, // minor-action SV 0 is persisted, not defaulted
    initialDuration: 3,
    remainingDuration: 2
  });
  assert.ok(applied.ok);
  assert.equal(applied.successValue, 0);
  const effectId = applied.effectId;

  const toggled = await requestSw25EffectOperation("toggle", { actorUuid: actor.uuid, effectId });
  assert.ok(toggled.ok && toggled.status === "toggled");
  assert.equal(toggled.disabled, true);

  const reactivated = await requestSw25EffectOperation("toggle", { actorUuid: actor.uuid, effectId, active: true });
  assert.ok(reactivated.ok && reactivated.disabled === false);

  const refreshed = await requestSw25EffectOperation("refresh", {
    actorUuid: actor.uuid,
    effectId,
    cast: { successValue: 6 },
    remainingDuration: 1
  });
  assert.ok(refreshed.ok && refreshed.status === "refreshed");
  const refreshedEffect = actor.effects.find(effect => effect.id === effectId);
  assert.equal(refreshedEffect.system.successValue, 6);
  assert.equal(refreshedEffect.system.remainingDuration, 1);

  const removed = await requestSw25EffectOperation("remove", { actorUuid: actor.uuid, effectId });
  assert.ok(removed.ok && removed.status === "removed");
  assert.equal(actor.effects.length, 0);
  console.log("  remove / toggle / refresh round-trip through the relay");
}

// ── Validation rejections at the source (no writes) ────────────────────────

{
  const actor = new MockActor("actor-d", "Probe D");
  actorsCollection.push(actor);
  setGm();
  assert.equal((await applySw25Effect(actor, { cast: { successValue: 1 } })).code, "invalid-family");
  assert.equal((await applySw25Effect(actor, { family: "   ", cast: { successValue: 1 } })).code, "invalid-family");
  assert.equal((await applySw25Effect(actor, { family: "Protection", rank: 11, cast: { successValue: 1 } })).code, "invalid-rank");
  assert.equal((await applySw25Effect(actor, { family: "Protection", rank: 2.5, cast: { successValue: 1 } })).code, "invalid-rank");
  assert.equal((await applySw25Effect(actor, { family: "Protection", cast: { successValue: 1 }, remainingDuration: 5, initialDuration: 2 })).code, "invalid-duration");
  assert.equal((await applySw25Effect(actor, { family: "Protection", cast: { successValue: 1 }, changes: "nope" })).code, "invalid-changes");
  assert.equal((await applySw25Effect(actor, { family: "Protection", cast: { successValue: 1 }, changes: [{ key: "  ", value: 1 }] })).code, "invalid-changes");
  assert.equal((await applySw25Effect(actor, { family: "Protection", cast: { successValue: 1 }, changes: [{ key: "x" }] })).code, "invalid-changes");
  assert.equal((await applySw25Effect(actor, { family: "Protection" })).code, "no-cast-context");
  assert.equal((await applySw25Effect(actor, null)).code, "invalid-application");
  assert.equal(actor.writeCount(), 0, "rejected applications never write");
  setPlayer();
  console.log("  invalid applications rejected at the source without writes");
}

// ── resolveStacking extension point (Bloque 4 plugs in; nothing invented) ──

{
  const actor = new MockActor("actor-e", "Probe E");
  actorsCollection.push(actor);
  setGm();
  // No resolver registered: the documented default is "accumulate".
  assert.equal(getSw25StackingResolver(), null);
  const applied = await applySw25Effect(actor, { family: "Protection", cast: { successValue: 3 } });
  assert.ok(applied.ok);
  assert.equal(actor.effects.length, 1);

  registerSw25StackingResolver(() => ({ outcome: "refused", code: "policy-refused", error: "family policy rejects the recast" }));
  const refused = await applySw25Effect(actor, { family: "Protection", cast: { successValue: 3 } });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "policy-refused");
  assert.equal(actor.writeCount(), 1, "a refused stacking decision never writes");

  // Bloque 4: a "replace" decision now HAS write semantics — create the new
  // effect and delete the replaced ids (here the decision carries none, so
  // the new effect is simply created as its own application).
  registerSw25StackingResolver(() => ({ outcome: "replace" }));
  const replaceAttempt = await applySw25Effect(actor, { family: "Protection", cast: { successValue: 3 } });
  assert.ok(replaceAttempt.ok, "a bare replace decision creates the new effect (nothing to delete)");
  assert.equal(actor.writeCount(), 2);

  // An "unresolved" decision still refuses: the service never invents an
  // outcome for an undecidable state (DEC-44).
  registerSw25StackingResolver(() => ({ outcome: "unresolved" }));
  const unresolvedAttempt = await applySw25Effect(actor, { family: "Protection", cast: { successValue: 3 } });
  assert.equal(unresolvedAttempt.ok, false);
  assert.equal(unresolvedAttempt.code, "stacking-unresolved");
  assert.equal(actor.writeCount(), 2);

  registerSw25StackingResolver(null);
  const afterClear = await applySw25Effect(actor, { family: "Protection", cast: { successValue: 3 } });
  assert.ok(afterClear.ok, "clearing the resolver restores the accumulate default");
  setPlayer();
  console.log("  resolveStacking extension point: accumulate default / refused / unresolved");
}

// ── Reads without GM: no relay, no gate (T2.5) ─────────────────────────────

{
  const actor = new MockActor("actor-f", "Probe F");
  actorsCollection.push(actor);
  actor.effects.push(new MockEffect({
    type: "sw25Effect",
    system: { schemaVersion: 1, family: "Protection", rank: 2, successValue: 9 }
  }));
  actor.effects.push(new MockEffect({ type: "base", system: {} }));
  setPlayer(); // a player client reads without the GM
  const listed = listSw25Effects(actor);
  assert.equal(listed.rows.length, 1, "only the system's subtype is listed");
  assert.equal(listed.rows[0].displayName, "Protection II");
  const single = getSw25Effect(actor, actor.effects[0].id);
  assert.equal(single.family, "Protection");
  assert.equal(getSw25Effect(actor, "missing-id"), null);
  console.log("  reads work on any client without GM or relay (T2.5)");
}

// ── Relay: no GM connected ─────────────────────────────────────────────────

{
  const actor = new MockActor("actor-g", "Probe G");
  actorsCollection.push(actor);
  socketEmissions.length = 0; // isolate this scenario's emission count
  // No active GM: gameUsers has no active GM in this scenario.
  gameUsers.length = 0;
  gameUsers.push({ id: "gm-user", isGM: true, active: false, name: "GameMaster" });
  const result = await requestSw25EffectOperation("toggle", { actorUuid: actor.uuid, effectId: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-gm");
  assert.equal(socketEmissions.length, 0, "no-gm rejects without emitting anything");
  assert.equal(pendingEffectRequestCount(), 0, "no-gm leaves no pending request");
  assert.equal(actor.writeCount(), 0, "no-gm performs no local fallback write");
  resetWorld();
  console.log("  no-gm: explicit immediate rejection, no pending, no local write");
}

// ── Relay: GM disappears while a request is in flight ──────────────────────

{
  const actor = new MockActor("actor-h", "Probe H");
  actorsCollection.push(actor);
  blockEffectDelivery = true; // the request reaches no GM client
  const inFlight = requestSw25EffectOperation("apply", { actorUuid: actor.uuid, family: "Protection", cast: { successValue: 1 } });
  await Promise.resolve(); // let the emit settle without delivery
  assert.equal(pendingEffectRequestCount(), 1, "the request stays pending without a timeout");
  // Event-driven lifecycle: the targeted GM disappears through updateUser.
  await fireEvent("updateUser", { isGM: true, active: false, id: "gm-user" });
  const settled = await inFlight;
  assert.equal(settled.ok, false);
  assert.equal(settled.code, "gm-offline");
  assert.equal(pendingEffectRequestCount(), 0);
  assert.equal(actor.writeCount(), 0, "an expired request never writes");
  // deleteUser path settles too.
  blockEffectDelivery = true;
  const second = requestSw25EffectOperation("apply", { actorUuid: actor.uuid, family: "Cura", cast: { successValue: 2 } });
  await Promise.resolve();
  await fireEvent("deleteUser", { isGM: true, id: "gm-user" });
  assert.equal((await second).code, "gm-offline");
  resetWorld();
  console.log("  gm-offline: in-flight requests settle with an explicit failure (no timeout)");
}

// ── Relay: sender validation and forged-ack rejection ──────────────────────

{
  const actor = new MockActor("actor-i", "Probe I");
  actorsCollection.push(actor);
  // A claimed requester that does not match the socket sender is rejected.
  const forgedPayload = {
    scope: "sw25-taka",
    action: "effect-request",
    requestId: generateEffectRequestId(),
    gid: "gm-user",
    requesterId: "player-1",
    operation: "apply",
    request: { actorUuid: actor.uuid, family: "Protection", cast: { successValue: 1 } }
  };
  await deliverAs("gm-user", structuredClone(forgedPayload), "player-2");
  assert.equal(actor.writeCount(), 0, "a mismatched sender never writes");
  // An unknown sender is rejected as well.
  await deliverAs("gm-user", structuredClone({ ...forgedPayload, requestId: generateEffectRequestId() }), "ghost-user");
  assert.equal(actor.writeCount(), 0);
  // A forged ack from a player client cannot settle a pending request.
  const inFlight = requestSw25EffectOperation("toggle", { actorUuid: actor.uuid, effectId: "x" });
  await Promise.resolve();
  await deliverAs("player-2", {
    scope: "sw25-taka",
    action: "effect-ack",
    requestId: (listPendingEffectRequests()[0] ?? {}).requestId,
    requestedBy: "player-1",
    status: "applied"
  }, "player-2");
  assert.equal(pendingEffectRequestCount(), 1, "a forged ack does not settle the promise");
  const pendingId = listPendingEffectRequests()[0].requestId;

  // An ack from a DIFFERENT (valid) GM cannot settle the request: only the
  // designated GM (the stored gid) may resolve it.
  await deliverAs("gm2-user", {
    scope: "sw25-taka",
    action: "effect-ack",
    requestId: pendingId,
    requestedBy: "player-1",
    gid: "gm-user",
    status: "applied",
    code: "applied"
  }, "gm2-user");
  assert.equal(pendingEffectRequestCount(), 1, "an ack from a non-designated GM does not settle");

  // The designated GM whose ack carries a mismatching gid field is rejected.
  await deliverAs("gm-user", {
    scope: "sw25-taka",
    action: "effect-ack",
    requestId: pendingId,
    requestedBy: "player-1",
    gid: "gm2-user",
    status: "applied",
    code: "applied"
  }, "gm-user");
  assert.equal(pendingEffectRequestCount(), 1, "a mismatching gid field does not settle");

  // An ack for an UNKNOWN requestId changes no pending state.
  await deliverAs("gm-user", {
    scope: "sw25-taka",
    action: "effect-ack",
    requestId: "efr-unknown-id",
    requestedBy: "player-1",
    gid: "gm-user",
    status: "applied"
  }, "gm-user");
  assert.equal(pendingEffectRequestCount(), 1);

  // A malformed ack (missing action) from even the designated GM is ignored.
  await deliverAs("gm-user", {
    scope: "sw25-taka",
    requestId: pendingId,
    status: "applied"
  }, "gm-user");
  assert.equal(pendingEffectRequestCount(), 1);

  await fireEvent("deleteUser", { isGM: true, id: "gm-user" }); // settle for cleanup
  assert.equal((await inFlight).code, "gm-offline", "gm-offline lifecycle still works after the ack validations");
  resetWorld();
  console.log("  sender validation, forged-ack rejection and designated-GM ack validation");
}

// ── Relay: GM client executes locally (direct authority, T2.4 manual use) ──

{
  const actor = new MockActor("actor-j", "Probe J");
  actorsCollection.push(actor);
  setGm();
  const result = await requestSw25EffectOperation("apply", {
    actorUuid: actor.uuid,
    family: "Protection",
    cast: { successValue: 4 }
  });
  assert.ok(result.ok, "a GM client executes the operation locally");
  assert.equal(result.status, "applied");
  assert.equal(actor.effects.length, 1);
  assert.equal(socketEmissions.filter(emission => emission.payload?.action === "effect-request").length, 0,
    "the local path emits no transport payload");
  setPlayer();
  console.log("  GM local execution through the same entry point (manual GM use)");
}

// ── Relay: unknown operation and unusable request ──────────────────────────

{
  assert.equal((await requestSw25EffectOperation("teleport", { actorUuid: "Actor.x" })).code, "invalid-operation");
  assert.equal((await requestSw25EffectOperation("apply", { family: "Protection" })).code, "invalid-request");
  assert.equal((await requestSw25EffectOperation("apply", { actorUuid: "", family: "Protection" })).code, "invalid-request");
  console.log("  unknown operations and unusable requests rejected before transport");
}

console.log("effects-relay.test.mjs: all relay/service assertions passed.");
