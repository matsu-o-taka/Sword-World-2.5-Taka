// Sword World 2.5 - combat-end conversion of rounds/turns effects test suite.
//
// Exercises `purgeSw25CombatDurationEffects` (module/effects/effect-service.mjs):
// when a Combat document is deleted, every `sw25Effect` with durationScale
// `rounds` on every actor is either converted to the non-combat `minutes`
// counter (remaining ≥ 6 rounds, both counters = remaining/6) or removed
// (remaining < 6); every `turns` effect is removed. Other scales and subtypes
// survive.
//
// Scope (combat-end disposition ONLY):
//   - Conversion: rounds remaining ≥ 6 → minutes (exact, never rounded, from
//     the REMAINING counter); the effect survives, the anchor is cleared.
//   - Removal: rounds remaining < 6 / non-finite, and every turns effect,
//     regardless of anchor or degradation state.
//   - Survival: minutes / hours / days / permanent / other / native / none,
//     legacy effects without a recognized scale, non-sw25Effect subtypes.
//   - Lifecycle: runs on combat deletion; not on ordinary combat updates;
//     repeated calls are idempotent; non-GM clients are rejected; no-GM
//     respects the existing error behavior; partial failure is reported.
//   - Integration: writes go through removeSw25Effect /
//     runAuthorizedServiceWrite (sole write paths).
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

// ── 1. Purge: rounds effect below the conversion threshold is removed ──

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-1", "Rounds Hero");
  const eff = await applyEffect(actor, {
    durationScale: "rounds",
    system: { initialDuration: 3, remainingDuration: 3 }
  });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true, `purge should succeed: ${result.error ?? ""}`);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 1, "exactly one rounds effect removed (3 remaining rounds < 1 minute)");
  assert.equal(result.scanned, 1);
  assert.equal(actor.effects.includes(eff), false, "the rounds effect is gone from the actor");
  assert.equal(eff.deleted, true, "the effect document is marked deleted");
  record("1. rounds effect below the conversion threshold (3 rounds): purged");
}

// ── 2. Purge: turns effect is removed (never converted) ────────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-2", "Turns Hero");
  const eff = await applyEffect(actor, {
    durationScale: "turns",
    system: { initialDuration: 3, remainingDuration: 3 }
  });

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
    system: { initialDuration: 2, remainingDuration: 2 },
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
    system: { initialDuration: 3, remainingDuration: 3 },
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
  const eff = await applyEffect(actor, { durationScale: "rounds", system: { initialDuration: 1, remainingDuration: 0 } });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 1);
  assert.equal(actor.effects.includes(eff), false);
  record("5. remainingDuration === 0: purged without error");
}

// ── 5b. Conversion: rounds remaining ≥ 6 → minutes, preserved ──────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-5b", "Long Buff Hero");
  const eff = await applyEffect(actor, {
    durationScale: "rounds",
    system: { initialDuration: 18, remainingDuration: 17 }
  });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true, `purge should succeed: ${result.error ?? ""}`);
  assert.equal(result.code, "purged");
  assert.equal(result.removed, 0, "convertible rounds effects are NOT removed");
  assert.equal(result.converted, 1, "one effect converted");
  assert.equal(result.scanned, 1);
  assert.equal(actor.effects.includes(eff), true, "the converted effect survives");
  assert.equal(eff.system.durationScale, "minutes", "converted to the manual minutes scale");
  assert.equal(eff.system.initialDuration, 2, "both counters derive from the REMAINING rounds — the initial never decides the conversion");
  assert.equal(eff.system.remainingDuration, 2, "17 rounds → 2 whole minutes (floored, never fractional)");
  assert.equal(eff.system.durationAnchor, null, "the manual scale carries no combat anchor");
  const second = await purgeSw25CombatDurationEffects();
  assert.equal(second.converted, 0, "idempotent: converted effects are no longer combat-scale");
  record("5b. rounds remaining ≥ 6: converted to minutes (÷6) from the remaining counter, preserved, anchor cleared");
}

// ── 5c. Conversion: exactly 6 remaining rounds → 1 minute ──────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-5c", "Boundary Hero");
  const eff = await applyEffect(actor, {
    durationScale: "rounds",
    system: { initialDuration: 6, remainingDuration: 6 }
  });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.converted, 1);
  assert.equal(actor.effects.includes(eff), true);
  assert.equal(eff.system.durationScale, "minutes");
  assert.equal(eff.system.initialDuration, 1);
  assert.equal(eff.system.remainingDuration, 1);
  record("5c. exactly 6 remaining rounds: converted to 1 minute");
}

// ── 5d. Below threshold: remaining < 6 cannot become a minute ──────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-5d", "Short Buff Hero");
  const eff = await applyEffect(actor, {
    durationScale: "rounds",
    system: { initialDuration: 18, remainingDuration: 5 }
  });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.removed, 1, "fewer than 6 remaining rounds: removed (cannot convert)");
  assert.equal(result.converted, 0);
  assert.equal(actor.effects.includes(eff), false);
  record("5d. remaining < 6: still purged (no convertible minute)");
}

// ── 5d2. Conversion table: floor(remaining / 6), never fractional ──────

{
  clearMocks();
  setGm();
  // User directive (2026-11-23): the combat exit derives WHOLE minutes from
  // the remaining rounds — `Math.floor(remaining / 6)`. Fractions are never
  // stored: 11 rounds → 1 minute, 7 rounds → 1 minute, 12 rounds → 2, 24 → 4.
  const table = [
    { initial: 18, remaining: 11, minutes: 1 },
    { initial: 18, remaining: 7, minutes: 1 },
    { initial: 24, remaining: 12, minutes: 2 },
    { initial: 24, remaining: 24, minutes: 4 }
  ];
  const actor = new MockActor("hero-5d2", "Floor Table Hero");
  const effects = [];
  for (const row of table) {
    effects.push({ row, eff: await applyEffect(actor, {
      durationScale: "rounds",
      system: { initialDuration: row.initial, remainingDuration: row.remaining }
    }) });
  }

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true, `purge should succeed: ${result.error ?? ""}`);
  assert.equal(result.removed, 0, "every row is convertible to at least one whole minute");
  assert.equal(result.converted, table.length);
  for (const { row, eff } of effects) {
    assert.equal(eff.system.durationScale, "minutes", `${row.remaining} rounds → minutes scale`);
    assert.equal(eff.system.initialDuration, row.minutes, `${row.remaining} rounds → ${row.minutes} whole minute(s) (initial)`);
    assert.equal(eff.system.remainingDuration, row.minutes, `${row.remaining} rounds → ${row.minutes} whole minute(s) (remaining)`);
    assert.equal(Number.isInteger(eff.system.remainingDuration), true, "no fractional minutes are ever persisted");
  }
  record("5d2. conversion table: floor(remaining/6) — 11→1, 7→1, 12→2, 24→4, never fractional");
}

// ── 5e. turns are never converted, regardless of remaining ─────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-5e", "Turns Hero");
  const eff = await applyEffect(actor, {
    durationScale: "turns",
    system: { initialDuration: 12, remainingDuration: 12 }
  });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.removed, 1, "turns have no temporal meaning outside the encounter: removed");
  assert.equal(result.converted, 0);
  assert.equal(actor.effects.includes(eff), false);
  record("5e. turns: never converted, purged");
}

// ── 5f. Mixed batch: one converted, one removed, manual minutes intact ──

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-5f", "Mixed Hero");
  const longBuff = await applyEffect(actor, { durationScale: "rounds", family: "Long", system: { initialDuration: 24, remainingDuration: 24 } });
  const shortBuff = await applyEffect(actor, { durationScale: "rounds", family: "Short", system: { initialDuration: 4, remainingDuration: 4 } });
  const manual = await applyEffect(actor, { durationScale: "minutes", family: "Manual", system: { initialDuration: 2, remainingDuration: 2 } });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true);
  assert.equal(result.removed, 1);
  assert.equal(result.converted, 1);
  assert.equal(actor.effects.includes(longBuff), true, "converted effect survives");
  assert.equal(longBuff.system.durationScale, "minutes");
  assert.equal(longBuff.system.remainingDuration, 4, "24 rounds → 4 minutes");
  assert.equal(actor.effects.includes(shortBuff), false, "sub-threshold effect removed");
  assert.equal(actor.effects.includes(manual), true, "a pre-existing manual minutes effect is untouched");
  assert.equal(manual.system.remainingDuration, 2, "manual counters untouched");
  record("5f. mixed batch: conversion and purge coexist; manual minutes untouched");
}

// ── 5g. Conversion write failure is reported as partial ────────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-5g", "Failing Hero");
  const convertible = await applyEffect(actor, {
    durationScale: "rounds",
    family: "Convertible",
    system: { initialDuration: 12, remainingDuration: 12 }
  });

  Hooks.on("preUpdateActiveEffect", (doc) => {
    if (doc.id === convertible.id) return false;
  });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, false);
  assert.equal(result.code, "partial", "a failed conversion is reported, never silent");
  assert.equal(result.converted, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].effectId, convertible.id);
  assert.equal(actor.effects.includes(convertible), true, "the effect survives the failed conversion");
  assert.equal(convertible.system.durationScale, "rounds", "no partial conversion was written");
  record("5g. conversion write failure: reported as partial, effect intact");
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
