// Sword World 2.5 - duration scale + combat anchor fields test suite (T5.2).
//
// Exercises the Bloque 5 additive fields of module/effects/effect-model.mjs
// (`durationScale`, `durationAnchor`, T5.0-R consolidation D1–D12) through the
// T1.3 normalizer/repair layer and the EffectService `apply`/`remove`/`toggle`/
// `refresh`/`list` operations, in one headless process.
//
// Scope (T5.2 ONLY — fields, validation and normalization):
//   - approved scales: combat (`rounds`, `turns`) vs manual (`minutes`,
//     `hours`, `days`, `permanent`, `other`);
//   - anchor regimes (`casterTurn` default / `targetTurn` exceptional /
//     `roundEnd` degradation) and edges, per combatant identity (two tokens of
//     the same Actor are independent combatants);
//   - D4 validation at application time (combat scales require a resolvable
//     anchor; manual scales never carry one; the `deferred` state is reserved
//     for the future preparation flow and is NOT a general fallback);
//   - native isolation (D1/D6/D11): no finite native `duration.value`, no
//     `duration.expiry`, no `CONFIG.ActiveEffect.expiryEvents` registration,
//     the global `expiryAction` untouched;
//   - legacy effects (without the new fields) normalize losslessly and keep
//     working; repair is deterministic and idempotent.
//
// OUT of scope (later tasks): the expiry engine (T5.3), duration discounting,
// turn-transition processing, anchor-availability detection, degradation to
// `roundEnd`, end-of-combat purge (T5.5), flags migration (T5.6), Instant/X
// (T5.7), FIFO queueing, the D10 notice UI and the preparation flow itself.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
    // Native duration: kept byte-identical to what the service writes, so the
    // suite can assert the D1/D6/D11 isolation on the REAL created payload.
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

// ── Module imports (after the environment mock) ────────────────────────────

const service = await import("../module/effects/effect-service.mjs");
const resolverModule = await import("../module/effects/stacking-resolver.mjs");
const repair = await import("../module/effects/effect-repair.mjs");
const model = await import("../module/effects/effect-model.mjs");

const {
  applySw25Effect,
  removeSw25Effect,
  toggleSw25Effect,
  refreshSw25Effect,
  listSw25Effects,
  getSw25Effect,
  registerSw25StackingResolver,
  initializeEffectService
} = service;
const { resolveSw25Stacking } = resolverModule;
const { normalizeSw25EffectSystem, repairSw25Effect } = repair;
const {
  SW25_DURATION_SCALES,
  SW25_COMBAT_DURATION_SCALES,
  SW25_ANCHOR_REGIMES,
  SW25_ANCHOR_EDGES,
  SW25_ANCHOR_STATES
} = model;

// Production wiring equivalent (sw25.mjs init): the suite exercises the REAL
// resolver through the service, so "existing operations keep working" is
// verified against the shipped configuration.
registerSw25StackingResolver(resolveSw25Stacking);
initializeEffectService();

setGm();

const record = label => console.log(`  ${label}`);

// ── Fixtures ────────────────────────────────────────────────────────────────

let familyCounter = 0;
const nextFamily = prefix => `${prefix}-${++familyCounter}`;

function appliedSystem(result, actor) {
  assert.equal(result.ok, true, `expected the application to succeed: ${result.error ?? ""}`);
  const effect = actor.effects.find(candidate => candidate.id === result.effectId);
  assert.ok(effect, "the applied effect must exist on the actor");
  assert.equal(effect.type, "sw25Effect");
  return { effect, system: effect.system };
}

/** Every created system effect must be invisible to the native expiry engine. */
function assertNativeIsolation(actor) {
  for (const effect of actor.effects) {
    if (effect.type !== "sw25Effect") continue;
    const duration = effect.duration ?? {};
    if ("value" in duration) {
      assert.equal(Number.isFinite(Number(duration.value)), false,
        "a system effect must never carry a finite native duration.value");
    }
    assert.equal(duration.expiry ?? null, null,
      "a system effect must never carry a native duration.expiry");
  }
}

// ── 1. casterTurn anchor (default regime) on the rounds scale ───────────────

{
  const actor = new MockActor("hero-caster-turn", "Caster Turn Hero");
  const result = await applySw25Effect(actor, {
    family: nextFamily("Bless"),
    rank: 1,
    cast: { mode: "minor" },
    initialDuration: 4,
    remainingDuration: 4,
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-caster-A", tokenId: "tkn-caster-A" },
    casterUUID: "Actor.caster-one"
  });
  const { system } = appliedSystem(result, actor);
  assert.equal(system.durationScale, "rounds");
  assert.deepEqual(system.durationAnchor, {
    regime: "casterTurn",
    edge: "begin",                    // approved default applied deterministically
    combatantId: "cmbt-caster-A",
    tokenId: "tkn-caster-A",
    state: "resolved"
  });
  assertNativeIsolation(actor);
  record("1. casterTurn anchor on the rounds scale: applied with the canonical five-key shape");
}

// ── 2. targetTurn anchor: representable, NOT treated as the default ─────────

{
  const actor = new MockActor("hero-target-turn", "Target Turn Hero");
  const result = await applySw25Effect(actor, {
    family: nextFamily("Curse"),
    cast: { mode: "minor" },
    durationScale: "turns",           // turn-edge condition scale (no counter)
    durationAnchor: { regime: "targetTurn", edge: "end", combatantId: "cmbt-target-B", tokenId: "tkn-target-B" }
  });
  const { system } = appliedSystem(result, actor);
  assert.equal(system.durationScale, "turns");
  assert.equal(system.initialDuration, null, "the turns scale carries no round counter");
  assert.equal(system.remainingDuration, null);
  assert.deepEqual(system.durationAnchor, {
    regime: "targetTurn",             // persisted EXACTLY as requested
    edge: "end",
    combatantId: "cmbt-target-B",
    tokenId: "tkn-target-B",
    state: "resolved"
  });
  assertNativeIsolation(actor);
  record("2. targetTurn anchor (exceptional regime, custom edge): persisted verbatim");
}

// ── 3. roundEnd regime: representable (degradation, D5) ─────────────────────

{
  const actor = new MockActor("hero-round-end", "Round End Hero");
  const result = await applySw25Effect(actor, {
    family: nextFamily("Degraded"),
    cast: { mode: "minor" },
    durationScale: "rounds",
    initialDuration: 2,
    remainingDuration: 2,
    durationAnchor: { regime: "roundEnd" }
  });
  const { system } = appliedSystem(result, actor);
  assert.deepEqual(system.durationAnchor, {
    regime: "roundEnd",
    edge: "begin",
    combatantId: null,                // the regime decrements at every round end
    tokenId: null,                    // (identity is provenance only)
    state: "resolved"
  });
  assertNativeIsolation(actor);
  record("3. roundEnd regime: representable without a combatant identity");
}

// ── 4. Manual scales: anchorless applications succeed ───────────────────────

{
  const actor = new MockActor("hero-manual", "Manual Scales Hero");
  for (const scale of ["minutes", "hours", "days", "permanent", "other"]) {
    const result = await applySw25Effect(actor, {
      family: nextFamily(`Manual-${scale}`),
      cast: { mode: "minor" },
      durationScale: scale
      // no durationAnchor — manual scales never require one (and never reject)
    });
    const { system } = appliedSystem(result, actor);
    assert.equal(system.durationScale, scale);
    assert.equal(system.durationAnchor, null);
  }
  assertNativeIsolation(actor);
  record("4. manual scales (minutes/hours/days/permanent/other): applied without an anchor");
}

// ── 5. D4: a combat scale without a resolvable anchor is rejected ───────────

{
  const actor = new MockActor("hero-d4", "D4 Hero");
  for (const scale of SW25_COMBAT_DURATION_SCALES) {
    const result = await applySw25Effect(actor, {
      family: nextFamily("Anchored"),
      cast: { mode: "minor" },
      durationScale: scale
      // no anchor on a combat scale: D4 rejects the application
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "anchor-required");
  }
  assert.equal(actor.effects.length, 0, "a rejected application must not write anything");
  record("5. D4: rounds/turns applications without an anchor are rejected with no write");
}

// ── 6. An anchor on a manual scale (or without a scale) is rejected ─────────

{
  const actor = new MockActor("hero-no-anchor-scale", "Anchorless Scale Hero");
  const withManualScale = await applySw25Effect(actor, {
    family: nextFamily("Misanchored"),
    cast: { mode: "minor" },
    durationScale: "minutes",
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-x" }
  });
  assert.equal(withManualScale.ok, false);
  assert.equal(withManualScale.code, "anchor-not-required");

  const withoutScale = await applySw25Effect(actor, {
    family: nextFamily("Scaleless"),
    cast: { mode: "minor" },
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-x" }
  });
  assert.equal(withoutScale.ok, false);
  assert.equal(withoutScale.code, "anchor-not-required");
  assert.equal(actor.effects.length, 0, "no contradictory write");
  record("6. anchors on manual/scale-less applications are rejected (anchor-not-required)");
}

// ── 7. The deferred anchor state is NOT a general fallback (D4) ─────────────

{
  const actor = new MockActor("hero-deferred", "Deferred Hero");
  const plainDeferred = await applySw25Effect(actor, {
    family: nextFamily("Deferred"),
    cast: { mode: "minor" },
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", state: "deferred" }
  });
  assert.equal(plainDeferred.ok, false);
  assert.equal(plainDeferred.code, "anchor-deferred");

  const deferredWithCombatant = await applySw25Effect(actor, {
    family: nextFamily("Deferred"),
    cast: { mode: "minor" },
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", state: "deferred", combatantId: "cmbt-y" }
  });
  assert.equal(deferredWithCombatant.ok, false);
  assert.equal(deferredWithCombatant.code, "anchor-deferred");
  assert.equal(actor.effects.length, 0);
  // The representation stays available at the DATA level (normalizer accepts
  // it for the future preparation flow), it just cannot enter through the
  // ordinary apply path.
  const normalized = normalizeSw25EffectSystem({
    schemaVersion: 1,
    family: "prep",
    changes: [],
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", state: "deferred" }
  });
  assert.equal(
    normalized.issues.some(issue => issue.severity === "review"), false,
    "the deferred representation must not carry review issues");
  assert.deepEqual(normalized.data.durationAnchor, {
    regime: "casterTurn", edge: "begin", combatantId: null, tokenId: null, state: "deferred"
  });
  record("7. deferred anchors: rejected on ordinary apply, representable in the data model");
}

// ── 8. Incomplete or irresoluble anchor identities are rejected ─────────────

{
  const actor = new MockActor("hero-incomplete", "Incomplete Anchor Hero");
  const cases = [
    { durationAnchor: { regime: "casterTurn", state: "resolved" } },             // no combatant
    { durationAnchor: { regime: "targetTurn" } },                                // no combatant
    { durationAnchor: { regime: "casterTurn", combatantId: "  " } },             // blank identity
    { durationAnchor: { regime: "moonPhase", combatantId: "cmbt-1" } },          // unknown regime
    { durationAnchor: { regime: "casterTurn", edge: "midpoint", combatantId: "c" } }, // unknown edge
    { durationAnchor: { regime: "casterTurn", combatantId: "c", state: "pending" } }, // unknown state
    { durationAnchor: "casterTurn" },                                            // not an object
    { durationAnchor: {} }                                                       // empty
  ];
  for (const extra of cases) {
    const result = await applySw25Effect(actor, {
      family: nextFamily("Broken"),
      cast: { mode: "minor" },
      durationScale: "rounds",
      ...extra
    });
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(extra)}`);
    assert.equal(result.code, "invalid-anchor");
  }
  assert.equal(actor.effects.length, 0);
  record("8. incomplete/irresoluble identities: rejected with invalid-anchor, no write");
}

// ── 9. Unknown or malformed durationScale is rejected ───────────────────────

{
  const actor = new MockActor("hero-scale", "Scale Hero");
  const unknown = await applySw25Effect(actor, {
    family: nextFamily("Weeks"), cast: { mode: "minor" }, durationScale: "weeks"
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "invalid-duration-scale");

  const wrongType = await applySw25Effect(actor, {
    family: nextFamily("Weeks"), cast: { mode: "minor" }, durationScale: 7
  });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.code, "invalid-duration-scale");
  assert.equal(actor.effects.length, 0);
  record("9. unknown/malformed scales: rejected with invalid-duration-scale");
}

// ── 10. Two combatants sharing one Actor are independent anchors ────────────

{
  const actor = new MockActor("hero-shared-actor", "Shared Actor Hero");
  const first = await applySw25Effect(actor, {
    family: nextFamily("Mark"),
    cast: { mode: "minor" },
    durationScale: "rounds",
    initialDuration: 3,
    remainingDuration: 3,
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-token-1", tokenId: "tkn-token-1" },
    casterUUID: "Actor.shared-caster"
  });
  const second = await applySw25Effect(actor, {
    family: nextFamily("Mark"),
    cast: { mode: "minor" },
    durationScale: "rounds",
    initialDuration: 3,
    remainingDuration: 3,
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-token-2", tokenId: "tkn-token-2" },
    casterUUID: "Actor.shared-caster"
  });
  const one = appliedSystem(first, actor).system.durationAnchor;
  const two = appliedSystem(second, actor).system.durationAnchor;
  assert.equal(one.combatantId, "cmbt-token-1");
  assert.equal(two.combatantId, "cmbt-token-2");
  assert.equal(one.tokenId, "tkn-token-1");
  assert.equal(two.tokenId, "tkn-token-2");
  assert.notEqual(one.combatantId, two.combatantId, "the two anchors must stay independent");
  record("10. two tokens of one Actor: two independent combatant anchors, no inheritance");
}

// ── 11. Native isolation: the native duration engine is never driven ────────

{
  const actor = new MockActor("hero-native", "Native Isolation Hero");
  const withFiniteValue = await applySw25Effect(actor, {
    family: nextFamily("Native"), cast: { mode: "minor" },
    durationScale: "rounds",
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-n" },
    duration: { value: 5 }
  });
  assert.equal(withFiniteValue.ok, false);
  assert.equal(withFiniteValue.code, "native-duration-forbidden");

  const withStringValue = await applySw25Effect(actor, {
    family: nextFamily("Native"), cast: { mode: "minor" }, duration: { value: "5" }
  });
  assert.equal(withStringValue.ok, false);
  assert.equal(withStringValue.code, "native-duration-forbidden");

  const withExpiry = await applySw25Effect(actor, {
    family: nextFamily("Native"), cast: { mode: "minor" }, duration: { expiry: 12345 }
  });
  assert.equal(withExpiry.ok, false);
  assert.equal(withExpiry.code, "native-duration-forbidden");
  assert.equal(actor.effects.length, 0, "no native-driven application may persist");

  // duration.units is presentation-only and stays allowed.
  const withUnits = await applySw25Effect(actor, {
    family: nextFamily("Units"), cast: { mode: "minor" },
    durationScale: "minutes",
    duration: { units: "minutes" }
  });
  const { effect, system } = appliedSystem(withUnits, actor);
  assert.deepEqual(effect.duration, { units: "minutes" }, "presentation units pass through");
  assert.equal(system.durationAnchor, null);
  assertNativeIsolation(actor);

  // No CONFIG, no expiryEvents, no expiryAction were ever touched.
  assert.equal(globalThis.CONFIG, undefined,
    "no effect module may create or modify the global CONFIG (expiryEvents/expiryAction stay untouched)");
  record("11. native isolation: value/expiry rejected, units allowed, CONFIG untouched");
}

// ── 12. Legacy callers keep working (no scale, no anchor) ───────────────────

{
  const actor = new MockActor("hero-legacy", "Legacy Hero");
  const result = await applySw25Effect(actor, {
    family: nextFamily("Legacy"),
    rank: 2,
    cast: { mode: "major", dieTotal: 9, magicPower: 3 },
    initialDuration: 4,
    remainingDuration: 4,
    changes: [{ key: "system.evasion", type: "upgrade", value: 2 }]
  });
  const { system } = appliedSystem(result, actor);
  assert.equal(system.successValue, 12);
  assert.equal(system.durationScale, null, "the scale is never inferred from the durations");
  assert.equal(system.durationAnchor, null);
  assert.equal(system.initialDuration, 4);
  assert.equal(system.remainingDuration, 4);
  assertNativeIsolation(actor);
  record("12. legacy applications without the new fields: applied unchanged");
}

// ── 13. Existing EffectService operations keep working on anchored effects ──

{
  const actor = new MockActor("hero-ops", "Ops Hero");
  const applyResult = await applySw25Effect(actor, {
    family: nextFamily("Ops"),
    cast: { mode: "minor" },
    durationScale: "rounds",
    initialDuration: 5,
    remainingDuration: 5,
    durationAnchor: { regime: "casterTurn", combatantId: "cmbt-ops", tokenId: "tkn-ops" }
  });
  const { effect } = appliedSystem(applyResult, actor);
  const effectId = effect.id;

  // list/get read anchored effects without any write.
  const listed = listSw25Effects(actor);
  assert.ok(listed.rows.some(row => row.id === effectId), "listSw25Effects must include the anchored effect");
  const got = getSw25Effect(actor, effectId);
  assert.ok(got, "getSw25Effect must find the anchored effect");
  assert.equal(got.id, effectId);

  // toggle flips the disabled state without touching the anchor.
  const toggled = await toggleSw25Effect(actor, effectId, { active: false });
  assert.equal(toggled.ok, true);
  assert.equal(toggled.code, "toggled");
  const toggledEffect = actor.effects.find(candidate => candidate.id === effectId);
  assert.equal(toggledEffect.disabled, true);
  assert.equal(toggledEffect.system.durationAnchor.combatantId, "cmbt-ops", "toggle must not alter the anchor");

  // refresh advances the remaining rounds (the DEC-23 absolute write) without
  // touching the scale or the anchor.
  const refreshed = await refreshSw25Effect(actor, effectId, { remainingDuration: 4 });
  assert.equal(refreshed.ok, true, `refresh failed: ${refreshed.error ?? ""}`);
  const refreshedEffect = actor.effects.find(candidate => candidate.id === effectId);
  assert.equal(refreshedEffect.system.remainingDuration, 4);
  assert.equal(refreshedEffect.system.durationScale, "rounds");
  assert.deepEqual(refreshedEffect.system.durationAnchor, {
    regime: "casterTurn", edge: "begin", combatantId: "cmbt-ops", tokenId: "tkn-ops", state: "resolved"
  });

  // remove deletes the anchored effect through the service.
  const removed = await removeSw25Effect(actor, effectId);
  assert.equal(removed.ok, true);
  assert.equal(removed.code, "removed");
  assert.equal(actor.effects.some(candidate => candidate.id === effectId), false);
  assertNativeIsolation(actor);
  record("13. list/get/toggle/refresh/remove keep working on anchored effects");
}

// ── 14. Repair: deterministic, idempotent, review data kept (DEC-41) ────────

{
  // A messy (but recoverable) T5.2 payload: whitespace, absent edge/state.
  globalThis.game = { user: { isGM: true } };
  const messy = {
    schemaVersion: 1,
    family: "Repair",
    changes: [],
    durationScale: "  rounds  ",
    durationAnchor: { regime: "  casterTurn  ", combatantId: "  cmbt-r  ", tokenId: "  " }
  };
  const stubUpdates = [];
  const stub = {
    name: "Repair Probe",
    id: "repair-1",
    toObject: () => structuredClone({ system: messy }),
    updates: stubUpdates,
    async update(data) {
      stubUpdates.push(structuredClone(data));
      for (const [path, value] of Object.entries(data)) {
        assert.ok(path.startsWith("system."), "repair writes flattened system.* paths");
        messy[path.slice("system.".length)] = structuredClone(value);
      }
      return messy;
    }
  };
  const first = await repairSw25Effect(stub);
  assert.equal(first.ok, true);
  assert.equal(first.code, "repaired");
  const written = Object.fromEntries(stubUpdates.flatMap(update => Object.entries(update)));
  assert.deepEqual(written["system.durationScale"], "rounds");
  assert.deepEqual(written["system.durationAnchor"], {
    regime: "casterTurn", edge: "begin", combatantId: "cmbt-r", tokenId: null, state: null
  });

  // Idempotency: the second repair performs NO write.
  const second = await repairSw25Effect(stub);
  assert.equal(second.ok, true);
  assert.equal(second.code, "no-changes");
  assert.equal(stubUpdates.length, 1, "the second repair must not write");

  // Review data (deferred + combatant) is KEPT and reported, never dropped.
  // The payload also carries a lossless fix (the absent edge), so the repair
  // writes the normalized anchor with the review values untouched inside it.
  const review = {
    schemaVersion: 1,
    family: "Review",
    changes: [],
    durationAnchor: { regime: "casterTurn", state: "deferred", combatantId: "cmbt-9" }
  };
  const reviewStub = {
    name: "Review Probe",
    id: "repair-2",
    toObject: () => structuredClone({ system: review }),
    updates: [],
    async update(data) {
      for (const [path, value] of Object.entries(data)) {
        assert.ok(path.startsWith("system."), "repair writes flattened system.* paths");
        review[path.slice("system.".length)] = structuredClone(value);
      }
      this.updates.push(structuredClone(data));
      return review;
    }
  };
  const reviewResult = await repairSw25Effect(reviewStub);
  assert.equal(reviewResult.ok, true);
  assert.equal(reviewResult.code, "repaired");
  assert.ok(reviewResult.issues.some(issue => issue.code === "durationAnchor-deferred-with-combatant"),
    "the review issue is reported to the GM");
  // The written anchor keeps the review-flagged data byte-identical; only the
  // approved edge default was applied.
  assert.equal(reviewStub.updates.length, 1);
  assert.deepEqual(reviewStub.updates[0]["system.durationAnchor"], {
    regime: "casterTurn", edge: "begin", combatantId: "cmbt-9", tokenId: null, state: "deferred"
  });
  assert.equal(review.durationAnchor.state, "deferred", "no silent reinterpretation of the state");
  assert.equal(review.durationAnchor.combatantId, "cmbt-9", "no silent discard of the identity");
  record("14. repair: deterministic fix, idempotent no-write, review data kept + reported");
}

// ── 15. Source-level isolation guarantees (D6/D11) ──────────────────────────

{
  // Static guard: the effect modules never ASSIGN to the native expiry
  // machinery (`expiryAction`, `CONFIG.ActiveEffect.expiryEvents`) nor to a
  // finite native `duration.value` on system effects. Comments may mention
  // them (documentation); assignments may not.
  const sources = [
    "../module/effects/effect-model.mjs",
    "../module/effects/effect-service.mjs",
    "../module/effects/effect-repair.mjs"
  ].map(relative => new URL(relative, import.meta.url));
  for (const url of sources) {
    const text = readFileSync(url, "utf8");
    assert.equal(/expiryAction\s*=/m.test(text), false, `${url.pathname} must never assign expiryAction`);
    assert.equal(/expiryEvents\s*[:=]/m.test(text), false, `${url.pathname} must never register expiryEvents`);
    assert.equal(/\.duration\s*=\s*\{?\s*value/m.test(text), false, `${url.pathname} must never stamp a native duration value`);
  }
  // The approved vocabularies are exactly the T5.0-R sets.
  assert.deepEqual(SW25_DURATION_SCALES, ["rounds", "turns", "minutes", "hours", "days", "permanent", "other"]);
  assert.deepEqual(SW25_COMBAT_DURATION_SCALES, ["rounds", "turns"]);
  assert.deepEqual(SW25_ANCHOR_REGIMES, ["casterTurn", "targetTurn", "roundEnd"]);
  assert.deepEqual(SW25_ANCHOR_EDGES, ["begin", "end"]);
  assert.deepEqual(SW25_ANCHOR_STATES, ["resolved", "deferred"]);
  record("15. source scan: no expiryAction/expiryEvents assignments; vocabularies exact");
}

console.log("effects-durations.test.mjs: all duration/anchor assertions passed.");
