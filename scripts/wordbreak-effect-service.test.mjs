// Wordbreak cancellation through the REAL EffectService and GM relay.
//
// The Actor/ActiveEffect documents and socket are headless Foundry mocks. The
// production activateWordbreak -> requestSw25EffectOperation -> relay ->
// removeSw25Effect -> ActiveEffect.delete path is not replaced or injected.

import assert from "node:assert/strict";

const chats = [];
const notifications = [];
const socketEmissions = [];
const socketListeners = [];
const registeredHooks = new Map();
const embeddedDocuments = new Map();
const blockedDeletionIds = new Set();
const authoritativeActorOverrides = new Map();

const actorsCollection = [];
actorsCollection.get = id => actorsCollection.find(actor => actor.id === id || actor.uuid === id) ?? null;
const gameUsers = [
  { id: "gm-user", _id: "gm-user", isGM: true, active: true, name: "GameMaster" },
  { id: "player-1", _id: "player-1", isGM: false, active: true, name: "Player One" }
];
const currentUser = { id: "gm-user", isGM: true, targets: new Set() };

function actorDocuments() {
  const documents = [...actorsCollection];
  for (const token of canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (actor && !documents.some(document => document.uuid === actor.uuid)) documents.push(actor);
  }
  return documents;
}

function resolveActorDocument(uuid) {
  if (currentUser.isGM && authoritativeActorOverrides.has(uuid)) return authoritativeActorOverrides.get(uuid);
  return actorDocuments().find(actor => actor.uuid === uuid) ?? null;
}

async function fireWriteHook(name, ...args) {
  let blocked = false;
  for (const listener of registeredHooks.get(name) ?? []) {
    if (await listener(...args) === false) blocked = true;
  }
  return blocked;
}

class MockEffect {
  constructor(owner, id, system = {}, extra = {}) {
    this.id = id;
    this.uuid = `${owner.uuid}.ActiveEffect.${id}`;
    this.type = "sw25Effect";
    this.name = extra.name ?? system.family ?? id;
    this.origin = extra.origin ?? null;
    this.disabled = false;
    this.system = {
      family: id,
      rank: 0,
      successValue: 10,
      successValueSource: "fixed",
      isMagical: false,
      durationScale: "minutes",
      initialDuration: null,
      remainingDuration: null,
      effectType: null,
      castId: null,
      effectScope: null,
      gmOnly: false,
      ...system
    };
    this.deleteCalls = [];
  }

  async delete() {
    this.deleteCalls.push(game.user.id);
    if (blockedDeletionIds.has(this.id)) return undefined;
    const blocked = await fireWriteHook("preDeleteActiveEffect", this, {}, game.user.id);
    if (blocked) return undefined;
    const owner = actorDocuments().find(actor => actor.effects.includes(this));
    if (owner) owner.effects = owner.effects.filter(effect => effect !== this);
    return this;
  }
}

class MockActor {
  constructor(id, name = id) {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.name = name;
    this.type = "character";
    this.items = [];
    this.effects = [];
    this.system = {
      abilityBases: { mind: 0 },
      abilityAdjustments: { e: {} },
      combat: {}
    };
  }
}

async function deliverAs(userId, payload, senderId) {
  const savedId = currentUser.id;
  const savedIsGM = currentUser.isGM;
  const receiver = gameUsers.find(user => user.id === userId);
  currentUser.id = receiver?.id ?? userId;
  currentUser.isGM = receiver?.isGM === true;
  try {
    for (const listener of [...socketListeners]) await listener(payload, senderId);
  } finally {
    currentUser.id = savedId;
    currentUser.isGM = savedIsGM;
  }
}

globalThis.game = {
  user: currentUser,
  actors: actorsCollection,
  items: new Map(),
  users: {
    get(id) { return gameUsers.find(user => user.id === id) ?? null; },
    get activeGM() { return gameUsers.find(user => user.isGM && user.active) ?? null; }
  },
  socket: {
    async emit(channel, payload) {
      const senderId = currentUser.id;
      socketEmissions.push({ channel, payload, senderId });
      if (payload?.action === "effect-request") {
        const receiver = gameUsers.find(user => user.id === payload.gid && user.isGM);
        if (receiver) await deliverAs(receiver.id, payload, senderId);
      } else if (payload?.action === "effect-ack") {
        const receiver = gameUsers.find(user => user.id === payload.requestedBy);
        if (receiver) await deliverAs(receiver.id, payload, senderId);
      }
    },
    on(channel, handler) { socketListeners.push(handler); }
  }
};

globalThis.Hooks = {
  on(name, listener) {
    const listeners = registeredHooks.get(name) ?? [];
    listeners.push(listener);
    registeredHooks.set(name, listeners);
  }
};
globalThis.ui = {
  notifications: {
    info(message) { notifications.push({ kind: "info", message }); },
    warn(message) { notifications.push({ kind: "warn", message }); },
    error(message) { notifications.push({ kind: "error", message }); }
  }
};
globalThis.ChatMessage = {
  getSpeaker({ actor } = {}) { return { actor: actor?.uuid ?? null }; },
  async create(data) { chats.push(data); return data; }
};
globalThis.fromUuid = async uuid => resolveActorDocument(uuid);
globalThis.foundry = {
  data: { ActiveEffectTypeDataModel: class {} },
  utils: {
    escapeHTML: value => String(value ?? ""),
    randomID() { return `r${Math.random().toString(36).slice(2, 12)}`; },
    fromUuidSync(uuid) { return embeddedDocuments.get(uuid) ?? null; }
  }
};
globalThis.canvas = { scene: { grid: { distance: 5 } }, grid: {}, tokens: { placeables: [] } };

const { initializeEffectService } = await import("../module/effects/effect-service.mjs");
const { initializeEffectRelay } = await import("../module/effects/effect-relay.mjs");
const { activateWordbreak } = await import("../module/rules/wordbreak.mjs");
initializeEffectService();
initializeEffectRelay();

const castingClass = { type: "class", name: "Sorcerer", system: { level: 0 } };
let caster;
let target;
let targetToken;

function resetWorld() {
  actorsCollection.length = 0;
  chats.length = 0;
  notifications.length = 0;
  socketEmissions.length = 0;
  blockedDeletionIds.clear();
  embeddedDocuments.clear();
  authoritativeActorOverrides.clear();
  caster = new MockActor("caster", "Caster");
  target = new MockActor("target", "Target");
  actorsCollection.push(caster, target);
  targetToken = { actor: target };
  canvas.tokens.placeables = [targetToken];
  currentUser.id = "gm-user";
  currentUser.isGM = true;
  currentUser.targets = new Set([targetToken]);
}

function addEffect(actor, id, system = {}, extra = {}) {
  const effect = new MockEffect(actor, id, system, extra);
  actor.effects.push(effect);
  return effect;
}

function controlledDialogs(effectId, successValue, offered = null) {
  return {
    declareEffect: async ({ candidates }) => {
      if (offered) offered.push(...candidates.map(candidate => candidate.effect.id));
      const chosen = candidates.find(candidate => candidate.effect.id === effectId);
      assert.ok(chosen, `${effectId} must be offered for declaration`);
      return { selection: { actorUuid: chosen.target.uuid, effectId: chosen.effect.id } };
    },
    rollCheck: async () => ({ successValue })
  };
}

async function activate(effectId, successValue = 12, offered = null) {
  return activateWordbreak({
    actor: caster,
    targets: [targetToken],
    castingClass,
    dialogs: controlledDialogs(effectId, successValue, offered)
  });
}

// GM local authority: non-magical effects are eligible; only the declaration
// is removed, while unrelated and ineligible documents remain untouched.
{
  resetWorld();
  const selected = addEffect(target, "selected", { successValue: 10 });
  addEffect(target, "unrelated", { successValue: 1 });
  addEffect(target, "curse", { effectType: "Curse", successValue: 1 });
  addEffect(target, "permanent", { durationScale: "permanent", successValue: 1 });
  addEffect(target, "physical", { effectType: "grabbed", successValue: 1 });
  const offered = [];
  const result = await activate("selected", 12, offered);
  assert.equal(result.code, "cancelled");
  assert.deepEqual(offered.sort(), ["selected", "unrelated"], "only eligible effects reach declaration");
  assert.deepEqual(target.effects.map(effect => effect.id).sort(), ["curse", "permanent", "physical", "unrelated"]);
  assert.deepEqual(selected.deleteCalls, ["gm-user"], "the real service deletes with GM authority");
  assert.equal(socketEmissions.length, 0, "GM activation uses the local service shortcut");
  assert.ok(chats.at(-1).content.includes("the effect is cancelled"));
  console.log("  GM local: eligible non-magical effect removed; all other effects preserved");
}

// A tied contested check never reaches the authoritative removal operation.
{
  resetWorld();
  const selected = addEffect(target, "equal-sv", { successValue: 12, successValueSource: "check" });
  const result = await activate("equal-sv", 12);
  assert.equal(result.code, "resisted");
  assert.equal(result.results[0].cancelled, false);
  assert.equal(target.effects.length, 1);
  assert.equal(selected.deleteCalls.length, 0);
  assert.ok(chats.at(-1).content.includes("ties do not cancel"));
  console.log("  comparison: equality fails without calling removal");
}

// /Space is one cast group. The real service removes every representation of
// that cast and no representation of another cast.
{
  resetWorld();
  const other = new MockActor("other", "Other");
  actorsCollection.push(other);
  const tokenOnly = new MockActor("token-only", "Token Only");
  tokenOnly.uuid = "Scene.scene.Token.token-only.Actor.token-only";
  canvas.tokens.placeables.push({ actor: tokenOnly });
  addEffect(target, "space-selected", { family: "Shared Area", castId: "cast-a", effectScope: "space", successValue: 2 });
  addEffect(other, "space-other", { family: "Shared Area", castId: "cast-a", effectScope: "space", successValue: 2 });
  addEffect(tokenOnly, "space-token-only", { family: "Shared Area", castId: "cast-a", effectScope: "space", successValue: 2 });
  addEffect(other, "space-unrelated", { family: "Shared Area", castId: "cast-b", effectScope: "space", successValue: 2 });
  const result = await activate("space-selected", 12);
  assert.equal(result.code, "cancelled");
  assert.equal(target.effects.length, 0);
  assert.equal(tokenOnly.effects.length, 0, "unlinked token Actors belong to the same /Space removal group");
  assert.deepEqual(other.effects.map(effect => effect.id), ["space-unrelated"]);
  console.log("  cast group: /Space removes only the selected castId across world and token Actors");
}

// Player activation travels through the real socket handler. The designated
// GM resolves Actor.<id> + effectId, executes removeSw25Effect and acknowledges.
{
  resetWorld();
  const selected = addEffect(target, "relay-selected", { successValue: 2 });
  addEffect(target, "relay-unrelated", { successValue: 1 });
  currentUser.id = "player-1";
  currentUser.isGM = false;
  const result = await activate("relay-selected", 12);
  assert.equal(result.code, "cancelled");
  assert.deepEqual(selected.deleteCalls, ["gm-user"], "the GM client, not the player, performs the delete");
  assert.deepEqual(target.effects.map(effect => effect.id), ["relay-unrelated"]);
  const request = socketEmissions.find(emission => emission.payload.action === "effect-request");
  assert.equal(request.senderId, "player-1");
  assert.equal(request.payload.operation, "remove");
  assert.deepEqual(request.payload.request, { actorUuid: target.uuid, effectId: selected.id });
  const ack = socketEmissions.find(emission => emission.payload.action === "effect-ack");
  assert.equal(ack.senderId, "gm-user");
  assert.equal(ack.payload.status, "removed");
  assert.equal(ack.payload.code, "removed");
  assert.equal(ack.payload.effectId, selected.id);
  console.log("  player relay: request -> GM EffectService removal -> real ack");
}

// The player's declaration can be stale by the time the GM executes it. The
// authoritative no-effect result is a failure, not a successful cancellation.
{
  resetWorld();
  const selected = addEffect(target, "already-missing", { successValue: 2 });
  const authoritativeTarget = new MockActor(target.id, target.name);
  authoritativeActorOverrides.set(target.uuid, authoritativeTarget);
  currentUser.id = "player-1";
  currentUser.isGM = false;
  const result = await activate("already-missing", 12);
  assert.equal(result.code, "resisted");
  assert.equal(result.results[0].cancelled, false);
  assert.equal(selected.deleteCalls.length, 0);
  assert.equal(target.effects.length, 1, "the stale player-side document is not reported as removed");
  const ack = socketEmissions.find(emission => emission.payload.action === "effect-ack");
  assert.equal(ack.payload.status, "error");
  assert.equal(ack.payload.code, "no-effect");
  assert.ok(chats.at(-1).content.includes("Removal failed"));
  assert.ok(!chats.at(-1).content.includes("the effect is cancelled."));
  console.log("  already missing: GM no-effect acknowledgement is not success");
}

// Foundry v14 Document.delete() returns undefined when a pre-delete hook
// cancels the write. That is a failed removal, never a successful cancellation.
{
  resetWorld();
  const selected = addEffect(target, "relay-blocked", { successValue: 2 });
  blockedDeletionIds.add(selected.id);
  currentUser.id = "player-1";
  currentUser.isGM = false;
  const result = await activate("relay-blocked", 12);
  assert.equal(result.code, "resisted");
  assert.equal(result.results[0].cancelled, false);
  assert.equal(target.effects.length, 1, "a cancelled document deletion leaves the effect in place");
  const ack = socketEmissions.find(emission => emission.payload.action === "effect-ack");
  assert.equal(ack.payload.status, "error");
  assert.equal(ack.payload.code, "write-failed");
  assert.ok(chats.at(-1).content.includes("Removal failed"), "the chat reports the authoritative failure");
  assert.ok(!chats.at(-1).content.includes("the effect is cancelled."), "failed persistence is not described as successful cancellation");
  console.log("  removal failure: cancelled delete is acknowledged as failure, not success");
}

console.log("wordbreak-effect-service.test.mjs: all real service/relay integration assertions passed.");
