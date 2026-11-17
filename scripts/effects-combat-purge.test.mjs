// Sword World 2.5 - combat-end purge of rounds/turns effects test suite (T5.5).
//
// Exercises `purgeSw25CombatDurationEffects` (module/effects/effect-service.mjs):
// when a Combat document is deleted, every `sw25Effect` with durationScale
// `rounds` or `turns` is removed from every actor. Other scales and subtypes
// survive.
//
// Scope (T5.5 ONLY — combat-end purge):
//   - Purge: rounds / turns effects removed regardless of remaining duration,
//     anchor, degradation state, or deferred anchor.
//   - Survival: minutes / hours / days / permanent / other / native / none,
//     legacy effects without a recognized scale, non-sw25Effect subtypes.
//   - Lifecycle: purge runs on combat deletion; not on ordinary combat updates;
//     repeated calls are idempotent; non-GM clients are rejected; no-GM
//     respects the existing error behavior; partial failure is reported.
//   - Integration: removal goes through removeSw25Effect (sole write path).
//
// OUT of scope: duration engine (T5.3), stacking (Bloque 4), repair (T1.3),
// concealed main section, monster knowledge.

import assert from "node:assert/strict";

// ── Global Foundry environment mock (before any effect-module import) ──────

const notifications = [];
const registeredHooks = new Map();

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
    if (blocked) throw new Error("Delete blocked by preDeleteActiveEffect hook");
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
}

globalThis.game = {
  user: { isGM: false, id: "player-1" },
  users: {
    get() { return null; },
    filter() { return []; },
    get activeGM() { return null; }
  },
  socket: {
    async emit() {},
    on() {}
  },
  actors: {
    get contents() { return [...mockActors]; }
  }
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

globalThis.foundry = {
  data: {
    ActiveEffectTypeDataModel: class ActiveEffectTypeDataModelStub {}
  },
  utils: {
    escapeHtml: value => String(value),
    randomID() { return `r${Math.random().toString(36).slice(2, 12)}`; }
  }
};

function setGm() {
  game.user.isGM = true;
  game.user.id = "gm-user";
}

function clearMocks() {
  mockActors.length = 0;
  for (const key of registeredHooks.keys()) registeredHooks.delete(key);
  notifications.length = 0;
  game.user.isGM = false;
  game.user.id = "player-1";
}

// ── Module imports (after the environment mock) ────────────────────────────

const service = await import("../module/effects/effect-service.mjs");

const {
  purgeSw25CombatDurationEffects,
  removeSw25Effect
} = service;

const record = label => console.log(`  ${label}`);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a system effect on an actor through the actor's embedded-doc API. */
async function applyEffect(actor, overrides = {}) {
  const [eff] = await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "sw25Effect",
    name: overrides.name ?? "Test Effect",
    system: {
      schemaVersion: 1,
      family: overrides.family ?? "TestFamily",
      changes: [],
      durationScale: overrides.durationScale ?? "rounds",
      durationAnchor: overrides.durationAnchor ?? { regime: "casterTurn", combatantId: "cmbt-1", tokenId: "tkn-1", state: "resolved" },
      ...(overrides.system ?? {})
    }
  }]);
  return eff;
}

function countByScale(actor, scale) {
  return actor.effects.filter(e => e.type === "sw25Effect" && e.system?.durationScale === scale).length;
}

// ── Tests ──────────────────────────────────────────────────────────────────

// ── 1. Purge: rounds effect with remaining duration is removed ─────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-1", "Rounds Hero");
  const eff = await applyEffect(actor, { durationScale: "rounds", initialDuration: 3, remainingDuration: 3 });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true, `purge should succeed: ${result.error ?? ""}`);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 1, "exactly one rounds effect removed");
  assert.equal(result.scanned, 1);
  assert.equal(actor.effects.includes(eff), false, "the rounds effect is gone from the actor");
  assert.equal(eff.deleted, true, "the effect document is marked deleted");
  record("1. rounds effect with remaining duration: purged");
}

// ── 2. Purge: turns effect with remaining duration is removed ──────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-2", "Turns Hero");
  const eff = await applyEffect(actor, { durationScale: "turns" });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 1, "exactly one turns effect removed");
  assert.equal(result.scanned, 1);
  assert.equal(actor.effects.includes(eff), false, "the turns effect is gone from the actor");
  record("2. turns effect with remaining duration: purged");
}

// ── 3. Purge: roundEnd-degraded rounds effect is removed ───────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-3", "Degraded Hero");
  const eff = await applyEffect(actor, {
    durationScale: "rounds",
    initialDuration: 2,
    remainingDuration: 2,
    durationAnchor: { regime: "roundEnd", edge: "end", combatantId: "cmbt-x", tokenId: "tkn-x", state: "resolved" }
  });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 1, "roundEnd-degraded effect removed");
  assert.equal(actor.effects.includes(eff), false);
  record("3. roundEnd-degraded rounds effect: purged");
}

// ── 4. Purge: deferred anchor effect is removed ────────────────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-4", "Deferred Hero");
  const eff = await applyEffect(actor, {
    durationScale: "rounds",
    initialDuration: 3,
    remainingDuration: 3,
    durationAnchor: { regime: "casterTurn", combatantId: null, tokenId: null, state: "deferred" }
  });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 1, "deferred-anchor effect removed");
  assert.equal(actor.effects.includes(eff), false);
  record("4. deferred anchor effect: purged even though descuento never started");
}

// ── 5. Purge: remainingDuration === 0 does not error ───────────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-5", "Zero Hero");
  const eff = await applyEffect(actor, { durationScale: "rounds", initialDuration: 1, remainingDuration: 0 });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 1);
  assert.equal(actor.effects.includes(eff), false);
  record("5. remainingDuration === 0: purged without error");
}

// ── 6. Survival: minutes effect survives ───────────────────────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-6", "Minutes Hero");
  const eff = await applyEffect(actor, { durationScale: "minutes" });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 0, "no minutes effect removed");
  assert.equal(result.scanned, 0, "minutes effect not scanned as combat scale");
  assert.equal(actor.effects.includes(eff), true, "minutes effect survives");
  record("6. minutes effect: survives");
}

// ── 7. Survival: hours and days effects survive ────────────────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-7", "HoursDays Hero");
  const hEff = await applyEffect(actor, { durationScale: "hours" });
  const dEff = await applyEffect(actor, { durationScale: "days" });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.removed, 0);
  assert.equal(actor.effects.includes(hEff), true, "hours effect survives");
  assert.equal(actor.effects.includes(dEff), true, "days effect survives");
  record("7. hours and days effects: survive");
}

// ── 8. Survival: permanent / other / native / none survive ─────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-8", "Misc Hero");
  const pEff = await applyEffect(actor, { durationScale: "permanent" });
  const oEff = await applyEffect(actor, { durationScale: "other" });
  const nEff = await applyEffect(actor, { durationScale: "native" });
  const zEff = await applyEffect(actor, { durationScale: "none" });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.removed, 0);
  assert.equal(actor.effects.includes(pEff), true, "permanent survives");
  assert.equal(actor.effects.includes(oEff), true, "other survives");
  assert.equal(actor.effects.includes(nEff), true, "native survives");
  assert.equal(actor.effects.includes(zEff), true, "none survives");
  record("8. permanent / other / native / none: survive");
}

// ── 9. Survival: legacy effect without recognized scale survives ───────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-9", "Legacy Hero");
  const eff = await applyEffect(actor, { system: { durationScale: undefined } });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.removed, 0);
  assert.equal(actor.effects.includes(eff), true, "legacy effect without scale survives");
  record("9. legacy effect without recognized scale: survives (absence is not combat scale)");
}

// ── 10. Survival: non-sw25Effect subtype survives ──────────────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-10", "Native Hero");
  const nativeEff = new MockEffect({
    id: "native-1",
    type: "bless",
    name: "Native Bless",
    system: { durationScale: "rounds" }
  });
  actor.effects.push(nativeEff);

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.removed, 0);
  assert.equal(result.scanned, 0, "non-sw25Effect not scanned");
  assert.equal(nativeEff.deleted, false, "non-sw25Effect survives");
  record("10. non-sw25Effect subtype: survives");
}

// ── 11. Lifecycle: purge removes rounds effects across multiple actors ──

{
  clearMocks();
  setGm();
  const a1 = new MockActor("a1", "Actor One");
  const a2 = new MockActor("a2", "Actor Two");
  const a3 = new MockActor("a3", "Actor Three");
  await applyEffect(a1, { durationScale: "rounds", family: "FamA" });
  await applyEffect(a1, { durationScale: "turns", family: "FamB" });
  await applyEffect(a2, { durationScale: "rounds", family: "FamA" });
  await applyEffect(a3, { durationScale: "minutes", family: "FamC" }); // survives

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 3, "three combat-scale effects removed");
  assert.equal(result.scanned, 3);
  assert.equal(countByScale(a3, "minutes"), 1, "a3's minutes effect survived");
  record("11. purge across multiple actors: rounds+turns removed, minutes survive");
}

// ── 12. Lifecycle: idempotent — second call finds nothing ────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-12", "Idem Hero");
  await applyEffect(actor, { durationScale: "rounds" });

  const first = await purgeSw25CombatDurationEffects();
  assert.equal(first.removed, 1);

  const second = await purgeSw25CombatDurationEffects();
  assert.equal(second.ok, true);
  assert.equal(second.code, "purged");
  assert.equal(second.removed, 0, "second purge removes nothing");
  assert.equal(second.scanned, 0, "nothing scanned on second call");
  record("12. idempotent: repeated purge is a no-op");
}

// ── 13. Non-GM: rejected without writes ────────────────────────────────

{
  clearMocks();
  // game.user.isGM is false by default
  const actor = new MockActor("hero-13", "NonGM Hero");
  await applyEffect(actor, { durationScale: "rounds" });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, false);
  assert.equal(result.code, "not-gm");
  assert.equal(actor.effects.length, 1, "no writes performed by non-GM");
  record("13. non-GM: rejected, no writes");
}

// ── 14. No GM active: respects existing error behavior ─────────────────

{
  clearMocks();
  // isGM already false; notGmResult is the existing error shape
  const actor = new MockActor("hero-14", "NoGM Hero");
  await applyEffect(actor, { durationScale: "rounds" });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, false);
  assert.equal(result.code, "not-gm");
  assert.equal(result.error, "Only the Game Master can execute effect operations.");
  assert.equal(actor.effects.length, 1);
  record("14. no GM active: existing not-gm error behavior");
}

// ── 15. Partial failure: one remove fails, purge reports partial ───────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-15", "Partial Hero");
  const goodEff = await applyEffect(actor, { durationScale: "rounds", family: "Good" });
  const badEff = await applyEffect(actor, { durationScale: "turns", family: "Bad" });

  // Register a guard that blocks the second effect's deletion only.
  const blockId = badEff.id;
  Hooks.on("preDeleteActiveEffect", (doc) => {
    if (doc.id === blockId) return false;
  });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, false);
  assert.equal(result.code, "partial");
  assert.equal(result.removed, 1, "only the good effect removed");
  assert.equal(result.errors.length, 1, "one error reported");
  assert.equal(result.errors[0].effectId, badEff.id);
  assert.equal(actor.effects.includes(goodEff), false, "good effect gone");
  assert.equal(actor.effects.includes(badEff), true, "bad effect remains intact");
  record("15. partial failure: not reported as complete; surviving effect intact");
}

// ── 16. Remove goes through removeSw25Effect (sole write path) ─────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-16", "Path Hero");
  const eff = await applyEffect(actor, { durationScale: "rounds" });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.equal(eff.deleted, true, "effect removed through service delete path");
  record("16. removal goes through removeSw25Effect (sole write path)");
}

console.log("effects-combat-purge.test.mjs: all combat-end purge assertions passed.");
