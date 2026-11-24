// Sword World 2.5 - Unified non-combat duration + combat round transitions.
//
// Phase 3 test suite (TDD). Covers:
//   - the single editable non-combat time counter on the existing DEC-23
//     counters, normalized to WHOLE MINUTES (durationScale "minutes" with
//     integer values; hours/days are entry units and legacy readable scales);
//   - explicit amount editing in any entry unit (minutes/hours/days) with
//     whole-minute storage — fractional minute totals are refused;
//   - refresh precision: the time counter stores whole minutes only, while
//     counted combat scales keep integer counters;
//   - combat entry: minutes below the 10-minute threshold convert to rounds
//     (1 round = 10 s → 1 min = 6 rounds) with the casterTurn/begin anchor;
//     ≥ 10 minutes stay; hours/days never convert; fractional round results
//     are reported, never rounded;
//   - the pre-existing-effect decision flow (decide callback: active →
//     threshold; not active → removed; no answer → untouched);
//   - combat exit: both result counters derive from the REMAINING rounds
//     (initial = remaining = floor(remaining/6) WHOLE minutes; no whitelist;
//     < 6 removed);
//   - unit-aware display labels (no more "rounds" on minute counters, no raw
//     float presentation).
//
// The temporal engine suites (effects-duration-engine, effects-durations,
// effects-instant-x-application) remain the regression pins for casterTurn /
// targetTurn / round / begin / degradation and run separately.

import assert from "node:assert/strict";

// ── Minimal Foundry environment mock (same shape as the purge/schema suites) ──

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
const effectsTab = await import("../module/effects/effects-tab.mjs");
const model = await import("../module/effects/effect-model.mjs");
const prompt = await import("../module/effects/combat-duration-prompt.mjs");

const {
  purgeSw25CombatDurationEffects,
  refreshSw25Effect,
  setSw25EffectTimeDuration,
  enterSw25CombatDurationEffects
} = service;

const {
  SW25_TIME_DURATION_SCALES,
  SW25_TIME_SCALE_UNIT_MINUTES,
  SW25_COMBAT_ENTRY_THRESHOLD_MINUTES,
  SW25_ROUNDS_PER_MINUTE,
  SW25_SECONDS_PER_ROUND
} = model;

const record = label => console.log(`  ${label}`);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create one system effect through the actor's embedded-document API. */
async function createEffect(actor, { scale = "minutes", initial, remaining, casterUUID = null, sourceDuration = null, name = "Time Effect" } = {}) {
  const system = {
    schemaVersion: 1,
    family: "TestFamily",
    changes: []
  };
  if (scale !== null) system.durationScale = scale;
  if (initial !== undefined) system.initialDuration = initial;
  if (remaining !== undefined) system.remainingDuration = remaining;
  if (casterUUID !== null) system.casterUUID = casterUUID;
  if (sourceDuration !== null) system.sourceDuration = sourceDuration;
  const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "sw25Effect",
    name,
    system
  }]);
  return effect;
}

/** Mock combat with the participants the service reads (actor + token identity). */
function makeCombat(combatants) {
  return {
    combatants: combatants.map(entry => ({
      id: entry.id,
      actor: entry.actor,
      tokenId: entry.tokenId ?? null
    }))
  };
}

/** Plain effect stub for the display/inspection layer (no document methods). */
function displayStub(system) {
  return {
    id: "eff-display",
    name: "Display",
    type: "sw25Effect",
    img: null,
    origin: null,
    duration: null,
    disabled: false,
    system
  };
}

function inspectionFor(system) {
  return effectsTab.buildSw25EffectInspection(displayStub({
    schemaVersion: 1,
    family: "Test",
    rank: 1,
    successValue: 0,
    changes: [],
    ...system
  }), null);
}

// ── 0. Shared constants ────────────────────────────────────────────────────

{
  assert.deepEqual(SW25_TIME_DURATION_SCALES, ["minutes", "hours", "days"], "the unified counter units are minutes/hours/days");
  assert.deepEqual(SW25_TIME_SCALE_UNIT_MINUTES, { minutes: 1, hours: 60, days: 1440 }, "mathematical unit factors");
  assert.equal(SW25_COMBAT_ENTRY_THRESHOLD_MINUTES, 10, "combat entry threshold is strictly below 10 minutes");
  assert.equal(SW25_ROUNDS_PER_MINUTE, 6, "1 round = 10 s → 1 minute = 6 rounds");
  assert.equal(SW25_SECONDS_PER_ROUND, 10, "1 round = 10 seconds (seconds-based entry conversion)");
  record("0. shared constants: units, factors, 10-minute threshold, 6 rounds/minute, 10 seconds/round");
}

// ── 1. Display: one unit-aware non-combat counter ──────────────────────────

{
  // Minutes with counters: the compound natural display (corrections
  // directive, 2026-11-23) — whole minutes minimum, never "1.5 hours".
  const minutes = inspectionFor({ durationScale: "minutes", initialDuration: 90, remainingDuration: 2 });
  assert.equal(minutes.initialDurationLabel, "1 hour and 30 minutes");
  assert.equal(minutes.remainingDurationLabel, "2 minutes");
  assert.equal(minutes.durationLabel, "Remaining 2 minutes of 1 hour and 30 minutes");

  // Compound day/hour decomposition: 1500 min = 1 day and 1 hour.
  const compound = inspectionFor({ durationScale: "minutes", initialDuration: 1500, remainingDuration: 1441 });
  assert.equal(compound.initialDurationLabel, "1 day and 1 hour");
  assert.equal(compound.remainingDurationLabel, "1 day and 1 minute");
  assert.equal(compound.durationLabel, "Remaining 1 day and 1 minute of 1 day and 1 hour");

  // Legacy hours read as their exact minute equivalent when they ARE whole
  // minutes; the stored scale is never rewritten by a display path.
  const hours = inspectionFor({ durationScale: "hours", initialDuration: 1.5, remainingDuration: 0.5 });
  assert.equal(hours.initialDurationLabel, "1 hour and 30 minutes");
  assert.equal(hours.remainingDurationLabel, "30 minutes");
  assert.equal(hours.durationLabel, "Remaining 30 minutes of 1 hour and 30 minutes");
  assert.equal(hours.durationScale, "hours", "display never rewrites the stored scale");

  const days = inspectionFor({ durationScale: "days", initialDuration: 2, remainingDuration: 1 });
  assert.equal(days.initialDurationLabel, "2 days");
  assert.equal(days.remainingDurationLabel, "1 day", "singular unit for a value of one");
  assert.equal(days.durationLabel, "Remaining 1 day of 2 days");

  // Fractional minutes (legacy data only): presentation-only raw fallback,
  // never the raw floating-point expansion; the stored value is untouched.
  const fractional = inspectionFor({ durationScale: "minutes", initialDuration: 17 / 6, remainingDuration: 17 / 6 });
  assert.equal(fractional.initialDurationLabel, "2.8333 minutes");
  assert.equal(fractional.remainingDurationLabel, "2.8333 minutes");
  assert.equal(fractional.durationLabel, "Remaining 2.8333 minutes of 2.8333 minutes");

  // Counted rounds keep their existing presentation.
  const rounds = inspectionFor({ durationScale: "rounds", initialDuration: 4, remainingDuration: 3 });
  assert.equal(rounds.initialDurationLabel, "4 rounds");
  assert.equal(rounds.remainingDurationLabel, "3 rounds");
  assert.equal(rounds.durationLabel, "Remaining 3 of 4 rounds");

  // Counterless manual scales keep the unit-only presentation.
  const counterless = inspectionFor({ durationScale: "minutes" });
  assert.equal(counterless.durationLabel, "Minutes");
  assert.equal(counterless.initialDurationLabel, "—");
  assert.equal(counterless.remainingDurationLabel, "—");

  // Presentation formatter (never used for stored data).
  assert.equal(effectsTab.formatSw25DurationValue(17 / 6), "2.8333");
  assert.equal(effectsTab.formatSw25DurationValue(6), "6");
  assert.equal(effectsTab.formatSw25DurationValue(1.5), "1.5");
  assert.equal(effectsTab.formatSw25DurationValue(0.5), "0.5");
  assert.equal(effectsTab.formatSw25DurationValue(null), "—");

  // Compound natural formatter (corrections directive): whole-minute totals
  // decompose into days/hours/minutes with singular units; totals that are
  // not a whole number of minutes fall back to the raw unit form.
  assert.equal(effectsTab.formatSw25NaturalDuration("minutes", 90), "1 hour and 30 minutes");
  assert.equal(effectsTab.formatSw25NaturalDuration("minutes", 1500), "1 day and 1 hour");
  assert.equal(effectsTab.formatSw25NaturalDuration("minutes", 60), "1 hour");
  assert.equal(effectsTab.formatSw25NaturalDuration("minutes", 45), "45 minutes");
  assert.equal(effectsTab.formatSw25NaturalDuration("minutes", 1), "1 minute");
  assert.equal(effectsTab.formatSw25NaturalDuration("minutes", 1441), "1 day and 1 minute");
  assert.equal(effectsTab.formatSw25NaturalDuration("minutes", 0), "0 minutes");
  assert.equal(effectsTab.formatSw25NaturalDuration("minutes", 1.5), "1.5 minutes", "non-whole minutes are a legacy-only fallback");
  assert.equal(effectsTab.formatSw25NaturalDuration("hours", 1.5), "1 hour and 30 minutes", "exact legacy hours read as minutes");
  assert.equal(effectsTab.formatSw25NaturalDuration("hours", 1.234), "1.234 hours", "inexact legacy hours keep the raw form");
  assert.equal(effectsTab.formatSw25NaturalDuration("days", 1.25), "1 day and 6 hours", "exact legacy days read as minutes");
  assert.equal(effectsTab.formatSw25NaturalDuration("days", 2), "2 days");
  assert.equal(effectsTab.formatSw25NaturalDuration("minutes", null), "—");

  // Entry-unit conversion helper (inspector unit switch): exact round trips
  // are exact; inexact ones are rounded for DISPLAY only — the save then
  // rejects them, so nothing inexact is ever persisted silently.
  assert.equal(effectsTab.convertSw25TimeAmount(90, "minutes", "hours"), 1.5);
  assert.equal(effectsTab.convertSw25TimeAmount(1.5, "hours", "minutes"), 90);
  assert.equal(effectsTab.convertSw25TimeAmount(2880, "minutes", "days"), 2);
  assert.equal(effectsTab.convertSw25TimeAmount(45, "minutes", "hours"), 0.75);
  assert.equal(effectsTab.convertSw25TimeAmount(50, "minutes", "hours"), 0.833333, "display-only rounding");
  assert.equal(effectsTab.convertSw25TimeAmount("", "minutes", "hours"), "", "an empty field stays empty");

  // Inspector editor context (U6): the unified counter only, with the
  // viewer's permission — GM or owning user, never a silent global editor.
  const editor = effectsTab.buildSw25TimeCounterEditor(
    { durationScale: "hours", initialDuration: 2, remainingDuration: 1.5 },
    { isGM: true, isOwner: false, editableDocument: true }
  );
  assert.equal(editor.scale, "hours");
  assert.equal(editor.amount, 1.5, "the editor edits the REMAINING amount in the current unit");
  assert.equal(editor.canEdit, true, "the GM may edit");
  assert.deepEqual(editor.units.map(unit => unit.value), ["minutes", "hours", "days"]);
  assert.equal(editor.units.find(unit => unit.selected).value, "hours");
  assert.equal(
    effectsTab.buildSw25TimeCounterEditor({ durationScale: "days", remainingDuration: 1 }, {
      isGM: false, isOwner: true, editableDocument: true
    }).canEdit,
    true,
    "the owning user may edit"
  );
  assert.equal(
    effectsTab.buildSw25TimeCounterEditor({ durationScale: "days", remainingDuration: 1 }, {
      isGM: false, isOwner: false, editableDocument: true
    }).canEdit,
    false,
    "an unrelated user may not edit"
  );
  assert.equal(
    effectsTab.buildSw25TimeCounterEditor({ durationScale: "rounds", remainingDuration: 3 }, {
      isGM: true, isOwner: true, editableDocument: true
    }),
    null,
    "combat rounds have no time-counter editor"
  );

  record("1. display: compound natural counters, singular/plural, legacy fallbacks, editor context");
}

// ── 2. Editing: whole-minute counter, unit-faceted amount entry ─────────────

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-edit", "Editor");

  // The unified counter normalizes to WHOLE MINUTES (corrections directive,
  // 2026-11-23): every edit stores the minutes scale with integer counters,
  // whatever entry unit was chosen. The entry unit alone never changes the
  // stored representation.
  const normalized = await createEffect(actor, { scale: "minutes", initial: 90, remaining: 30 });
  const unitOnly = await setSw25EffectTimeDuration(actor, normalized.id, { unit: "hours" });
  assert.equal(unitOnly.ok, false, "a unit-only edit on whole-minutes storage changes nothing");
  assert.equal(unitOnly.code, "no-change", "the storage is already the canonical whole-minutes form");
  assert.equal(normalized.system.durationScale, "minutes", "no fractional hours are ever stored");

  // Legacy hours with exact minute totals migrate on edit (duration
  // preserved exactly, no loss).
  const legacy = await createEffect(actor, { scale: "hours", initial: 1.5, remaining: 0.5 });
  const migrated = await setSw25EffectTimeDuration(actor, legacy.id, { unit: "hours" });
  assert.equal(migrated.ok, true, `legacy migration should succeed: ${migrated.error ?? ""}`);
  assert.equal(legacy.system.durationScale, "minutes");
  assert.equal(legacy.system.initialDuration, 90);
  assert.equal(legacy.system.remainingDuration, 30);

  // Legacy inexact counters cannot migrate without an explicit amount.
  const inexact = await createEffect(actor, { scale: "hours", initial: 1.234, remaining: 1 });
  const refused = await setSw25EffectTimeDuration(actor, inexact.id, { unit: "hours" });
  assert.equal(refused.ok, false, "an inexact legacy counter is never silently rounded");
  assert.equal(refused.code, "unrepresentable");
  assert.equal(inexact.system.durationScale, "hours", "the refusal wrote nothing");

  // With an explicit amount the edit succeeds: remaining is the given whole
  // minutes; the legacy inexact initial becomes its whole-minute ceiling (an
  // upper bound can only extend).
  const explicit = await setSw25EffectTimeDuration(actor, inexact.id, { unit: "hours", amount: 1 });
  assert.equal(explicit.ok, true, `explicit amount should succeed: ${explicit.error ?? ""}`);
  assert.equal(inexact.system.durationScale, "minutes");
  assert.equal(inexact.system.initialDuration, 75, "ceil(74.04) — the initial stays an upper bound");
  assert.equal(inexact.system.remainingDuration, 60);

  // Explicit amounts: the amount is authoritative in the given unit.
  const amount = await createEffect(actor, { scale: "minutes", initial: 90, remaining: 30 });
  const raise = await setSw25EffectTimeDuration(actor, amount.id, { unit: "minutes", amount: 45 });
  assert.equal(raise.ok, true);
  assert.equal(amount.system.remainingDuration, 45, "explicit amount replaces the remaining value");
  assert.equal(amount.system.initialDuration, 90, "initial stays as the historical starting value");

  const beyond = await setSw25EffectTimeDuration(actor, amount.id, { unit: "minutes", amount: 120 });
  assert.equal(beyond.ok, true);
  assert.equal(amount.system.remainingDuration, 120);
  assert.equal(amount.system.initialDuration, 120, "an amount above the initial raises the initial to stay coherent");

  // Amounts in hours/days convert to the whole-minute storage.
  const inHours = await setSw25EffectTimeDuration(actor, amount.id, { unit: "hours", amount: 2 });
  assert.equal(inHours.ok, true);
  assert.equal(amount.system.durationScale, "minutes", "hours are an ENTRY unit, never the stored scale");
  assert.equal(amount.system.initialDuration, 120);
  assert.equal(amount.system.remainingDuration, 120);

  const inDays = await setSw25EffectTimeDuration(actor, amount.id, { unit: "days", amount: 1 });
  assert.equal(inDays.ok, true);
  assert.equal(amount.system.remainingDuration, 1440, "1 day = 1440 whole minutes");

  // Whole minutes minimum: fractional minute totals are rejected in every
  // unit ("2.78 minutes", "0.5 minutes", "1.234 hours").
  for (const patch of [
    { unit: "minutes", amount: 2.78 },
    { unit: "minutes", amount: 0.5 },
    { unit: "hours", amount: 1.234 }
  ]) {
    const rejectedAmount = await setSw25EffectTimeDuration(actor, amount.id, patch);
    assert.equal(rejectedAmount.ok, false, `${patch.amount} ${patch.unit} must be rejected`);
    assert.equal(rejectedAmount.code, "unrepresentable", "not a whole number of minutes");
  }
  assert.equal(amount.system.remainingDuration, 1440, "rejections wrote nothing");

  // Counterless time effect: an explicit amount starts the counter.
  const bare = await createEffect(actor, { scale: "minutes" });
  const bareAmount = await setSw25EffectTimeDuration(actor, bare.id, { unit: "minutes", amount: 5 });
  assert.equal(bareAmount.ok, true);
  assert.equal(bare.system.initialDuration, 5);
  assert.equal(bare.system.remainingDuration, 5);

  // Rejections (nothing written).
  const before = amount.updates.length;
  for (const badAmount of [0, -1, Number.NaN, "3"]) {
    const rejected = await setSw25EffectTimeDuration(actor, normalized.id, { unit: "minutes", amount: badAmount });
    assert.equal(rejected.ok, false, `amount ${String(badAmount)} must be rejected`);
    assert.equal(rejected.code, "invalid-amount");
  }
  assert.equal((await setSw25EffectTimeDuration(actor, normalized.id, { unit: "seconds" })).code, "invalid-unit");
  assert.equal((await setSw25EffectTimeDuration(actor, normalized.id, {})).code, "invalid-unit", "a unit is mandatory");
  assert.equal((await setSw25EffectTimeDuration(actor, normalized.id, { unit: "minutes" })).code, "no-change");
  assert.equal((await setSw25EffectTimeDuration(actor, "missing-id", { unit: "hours" })).code, "no-effect");

  const rounds = await createEffect(actor, { scale: "rounds", initial: 3, remaining: 3 });
  assert.equal((await setSw25EffectTimeDuration(actor, rounds.id, { unit: "minutes" })).code, "combat-scale", "rounds are a separate combat representation");

  const other = await createEffect(actor, { scale: "other" });
  assert.equal((await setSw25EffectTimeDuration(actor, other.id, { unit: "minutes" })).code, "not-time-scale");

  game.user.isGM = false;
  assert.equal((await setSw25EffectTimeDuration(actor, normalized.id, { unit: "hours" })).code, "not-gm");
  assert.equal(amount.updates.length, before, "rejections wrote nothing");

  record("2. editing: whole-minute storage, unit-faceted amounts, legacy migration, rejections");
}

// ── 3. Refresh: time counters are whole minutes; combat counters integral ──

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-refresh", "Refresher");

  const minutes = await createEffect(actor, { scale: "minutes", initial: 3, remaining: 3 });
  const whole = await refreshSw25Effect(actor, minutes.id, { remainingDuration: 2 });
  assert.equal(whole.ok, true, `whole minutes accepted: ${whole.error ?? ""}`);
  assert.equal(minutes.system.remainingDuration, 2);

  const fractionalMinutes = await refreshSw25Effect(actor, minutes.id, { remainingDuration: 2.5 });
  assert.equal(fractionalMinutes.ok, false, "the non-combat counter never stores fractional minutes");
  assert.equal(fractionalMinutes.code, "invalid-duration");

  // Legacy scales still speak minutes: 1.5 hours = 90 whole minutes is
  // accepted in the legacy scale; an inexact total is refused.
  const hours = await createEffect(actor, { scale: "hours", initial: 3, remaining: 3 });
  const legacyHours = await refreshSw25Effect(actor, hours.id, { remainingDuration: 1.5 });
  assert.equal(legacyHours.ok, true, `1.5 hours = 90 whole minutes: ${legacyHours.error ?? ""}`);
  assert.equal(hours.system.remainingDuration, 1.5);

  const inexactHours = await refreshSw25Effect(actor, hours.id, { remainingDuration: 1.234 });
  assert.equal(inexactHours.ok, false, "74.04 minutes is not a whole-minute duration");
  assert.equal(inexactHours.code, "invalid-duration");

  const rounds = await createEffect(actor, { scale: "rounds", initial: 3, remaining: 3 });
  const fractionalRounds = await refreshSw25Effect(actor, rounds.id, { remainingDuration: 2.5 });
  assert.equal(fractionalRounds.ok, false, "counted combat rounds stay integers");
  assert.equal(fractionalRounds.code, "invalid-duration");

  const over = await refreshSw25Effect(actor, minutes.id, { remainingDuration: 99 });
  assert.equal(over.ok, false, "remaining can never exceed the initial bookkeeping");
  assert.equal(over.code, "invalid-duration");

  record("3. refresh: whole-minute time counters only; combat counters stay integral");
}

// ── 4. Combat entry: threshold, anchor, confirmation, reporting ────────────

{
  clearMocks();
  setGm();
  const caster = new MockActor("caster-1", "Caster");
  const target = new MockActor("target-1", "Target");
  const combat = makeCombat([
    { id: "cmbt-caster", actor: caster, tokenId: "tkn-caster" },
    { id: "cmbt-target", actor: target, tokenId: "tkn-target" }
  ]);

  // Below the threshold: converted to counted rounds with the casterTurn/begin anchor.
  const below = await createEffect(target, { scale: "minutes", initial: 9, remaining: 9, casterUUID: caster.uuid });
  const belowResult = await enterSw25CombatDurationEffects(combat, { decide: async () => true });
  assert.equal(belowResult.ok, true, `entry should succeed: ${belowResult.error ?? ""}`);
  assert.equal(belowResult.converted, 1);
  assert.equal(below.system.durationScale, "rounds");
  assert.equal(below.system.initialDuration, 54);
  assert.equal(below.system.remainingDuration, 54);
  assert.deepEqual(below.system.durationAnchor, {
    regime: "casterTurn", edge: "begin", combatantId: "cmbt-caster", tokenId: "tkn-caster", state: "resolved"
  }, "the D5 default anchor is resolved from the caster's combatant");

  // Exactly 10 minutes and above stay in the time counter.
  const ten = await createEffect(target, { scale: "minutes", initial: 10, remaining: 10 });
  const above = await createEffect(target, { scale: "minutes", initial: 600, remaining: 600 });
  const keptResult = await enterSw25CombatDurationEffects(combat, { decide: async () => true });
  assert.equal(keptResult.converted, 0);
  assert.equal(keptResult.kept, 2, "10 and 600 minutes remain non-combat time");
  assert.equal(ten.system.durationScale, "minutes");
  assert.equal(above.system.durationScale, "minutes");

  // Hours/days never convert.
  const hours = await createEffect(target, { scale: "hours", initial: 2, remaining: 2 });
  const hoursResult = await enterSw25CombatDurationEffects(combat, { decide: async () => true });
  assert.equal(hoursResult.converted, 0);
  assert.equal(hours.system.durationScale, "hours");

  // Float round-trip: a converted 17/6 minute value converts back to 17 rounds.
  const roundTrip = await createEffect(target, { scale: "minutes", initial: 17 / 6, remaining: 17 / 6 });
  const tripResult = await enterSw25CombatDurationEffects(combat, { decide: async () => true });
  assert.equal(tripResult.converted, 1);
  assert.equal(roundTrip.system.durationScale, "rounds");
  assert.equal(roundTrip.system.remainingDuration, 17, "exact float results are not misread as fractional");
  assert.equal(roundTrip.system.initialDuration, 17);
  assert.equal(roundTrip.system.durationAnchor.combatantId, "cmbt-target", "no casterUUID → the owner's combatant");

  // Initial counter converted proportionally when it is an exact round value;
  // an inexact initial falls back to the remaining rounds.
  const initialConverted = await createEffect(target, { scale: "minutes", initial: 12, remaining: 9 });
  await enterSw25CombatDurationEffects(combat, { decide: async () => true });
  assert.equal(initialConverted.system.initialDuration, 72);
  assert.equal(initialConverted.system.remainingDuration, 54);
  const initialInexact = await createEffect(target, { scale: "minutes", initial: 3.4, remaining: 3 });
  await enterSw25CombatDurationEffects(combat, { decide: async () => true });
  assert.equal(initialInexact.system.remainingDuration, 18);
  assert.equal(initialInexact.system.initialDuration, 18, "an inexact initial falls back to the remaining rounds");

  // An arbitrary fractional minute value (1.7 → 10.2 rounds) is REPORTED, not altered.
  const incompatible = await createEffect(target, { scale: "minutes", initial: 1.7, remaining: 1.7 });
  const incompatibleResult = await enterSw25CombatDurationEffects(combat, { decide: async () => true });
  assert.equal(incompatibleResult.converted, 0);
  assert.equal(incompatibleResult.unresolved.length, 1, "the incompatible conversion is reported");
  assert.equal(incompatible.system.durationScale, "minutes", "the effect is not silently altered");
  assert.equal(incompatible.system.remainingDuration, 1.7);

  record("4a. entry: < 10 min → rounds, ≥ 10 min stays, hours never, float round-trip, reporting");

  // Confirmation flow: not active → removed; no answer → untouched; active → threshold.
  clearMocks();
  setGm();
  const owner = new MockActor("owner-1", "Owner");
  const soloCombat = makeCombat([{ id: "cmbt-owner", actor: owner, tokenId: "tkn-owner" }]);

  const expired = await createEffect(owner, { scale: "minutes", initial: 5, remaining: 5 });
  const removedResult = await enterSw25CombatDurationEffects(soloCombat, { decide: async () => false });
  assert.equal(removedResult.removed, 1);
  assert.equal(owner.effects.includes(expired), false, "a confirmed no-longer-active effect is removed");

  const undecided = await createEffect(owner, { scale: "minutes", initial: 5, remaining: 5 });
  const undecidedResult = await enterSw25CombatDurationEffects(soloCombat, { decide: async () => null });
  assert.equal(undecidedResult.undecided, 1);
  assert.equal(undecidedResult.removed, 0);
  assert.equal(undecided.system.durationScale, "minutes", "a dismissed question never assumes the full duration");

  // Counterless time effects are not candidates (nothing to convert; GM-managed).
  clearMocks();
  setGm();
  const bareOwner = new MockActor("bare-owner", "Bare Owner");
  const bareCombat = makeCombat([{ id: "cmbt-bare", actor: bareOwner, tokenId: "tkn-bare" }]);
  let decideCalls = 0;
  const bare = await createEffect(bareOwner, { scale: "minutes" });
  const bareResult = await enterSw25CombatDurationEffects(bareCombat, {
    decide: async () => { decideCalls += 1; return true; }
  });
  assert.equal(decideCalls, 0, "counterless effects are never prompted");
  assert.equal(bareResult.converted, 0);
  assert.equal(bare.system.durationScale, "minutes");

  // Non-GM clients cannot run the conversion; a missing combat is rejected.
  game.user.isGM = false;
  assert.equal((await enterSw25CombatDurationEffects(soloCombat, { decide: async () => true })).code, "not-gm");
  game.user.isGM = true;
  assert.equal((await enterSw25CombatDurationEffects(null, { decide: async () => true })).code, "no-combat");

  record("4b. entry: no-longer-active removal, dismissed question untouched, GM gate");
}

// ── 5. Combat exit: both counters from the remaining rounds, no whitelist ──

{
  clearMocks();
  setGm();
  const actor = new MockActor("hero-purge", "Purge");

  const table = [
    [36, 6], [30, 5], [24, 4], [18, 3], [12, 2], [6, 1], [7, 1], [11, 1]
  ];
  const converted = [];
  for (const [rounds] of table) {
    converted.push(await createEffect(actor, { scale: "rounds", initial: 20, remaining: rounds }));
  }
  const expired = [];
  for (const rounds of [5, 3, 1]) {
    expired.push(await createEffect(actor, { scale: "rounds", initial: 5, remaining: rounds }));
  }
  const untouchedHours = await createEffect(actor, { scale: "hours", initial: 2, remaining: 2 });

  const result = await purgeSw25CombatDurationEffects();
  assert.equal(result.ok, true, `purge should succeed: ${result.error ?? ""}`);
  assert.equal(result.converted, table.length, "every ≥ 6-round effect converts");
  assert.equal(result.removed, expired.length, "every < 6-round effect is removed");

  for (let i = 0; i < table.length; i += 1) {
    const [rounds, minutes] = table[i];
    const effect = converted[i];
    assert.equal(effect.system.durationScale, "minutes", `${rounds} rounds convert to the non-combat counter`);
    assert.equal(effect.system.remainingDuration, minutes, `${rounds} rounds → ${String(minutes)} minutes`);
    assert.equal(effect.system.initialDuration, minutes, "both counters derive from the REMAINING rounds (never the initial)");
    assert.equal(effect.system.durationAnchor, null, "the combat anchor is cleared");
  }
  for (const effect of expired) assert.equal(effect.deleted, true, "below one minute the effect expires");
  assert.equal(untouchedHours.system.durationScale, "hours", "effects never tracked in rounds keep their time counter");
  assert.equal(untouchedHours.deleted, false);

  record("5. exit: floor(remaining/6) — 36→6, 30→5, 24→4, 18→3, 12→2, 7→1, 11→1; 5/3/1 removed; hours untouched");
}

// ── 6. Combat-entry prompt: one window, per-effect confirmation ────────────

{
  clearMocks();
  setGm();
  const hero = new MockActor("hero-prompt", "Prompt Hero");
  const short = await createEffect(hero, { scale: "minutes", initial: 5, remaining: 5, name: "Short" });
  const oneMinute = await createEffect(hero, { scale: "minutes", initial: 1, remaining: 1, name: "One Minute" });
  await createEffect(hero, { scale: "hours", initial: 2, remaining: 2, name: "Hours" });
  const combat = makeCombat([{ id: "cmbt-prompt", actor: hero, tokenId: "tkn-prompt" }]);

  const rows = prompt.buildSw25CombatEntryPromptRows(combat);
  assert.equal(rows.length, 2, "only counted minute effects are candidates");
  assert.equal(rows[0].actorName, "Prompt Hero");
  assert.equal(rows[0].remainingLabel, "5 minutes", "the prompt shows the unit-aware counter");
  assert.equal(rows[1].remainingLabel, "1 minute", "singular unit in the prompt too");
  assert.equal(rows[0].key, prompt.buildSw25CombatEntryPromptRows(combat)[0].key, "row identity is stable");

  // Compound natural display in the prompt too (corrections directive).
  await createEffect(hero, { scale: "minutes", initial: 90, remaining: 90, name: "Long Buff" });
  const compoundRows = prompt.buildSw25CombatEntryPromptRows(combat);
  assert.equal(compoundRows.length, 3, "a 90-minute effect is also a candidate");
  assert.equal(compoundRows[2].remainingLabel, "1 hour and 30 minutes", "compound natural label in the prompt");

  const decide = prompt.buildSw25CombatEntryDecisionMap(rows, [rows[0].key]);
  assert.equal(decide(hero, short), true, "a checked effect is still active");
  assert.equal(decide(hero, oneMinute), false, "an unchecked effect is expired");

  // Confirm: the checked keys drive the service (5 min → 30 rounds).
  const fakeDialog = {
    wait: async config => {
      assert.equal(config.modal, true, "the entry window is modal");
      assert.ok(config.content.includes('type="checkbox"'), "the window offers per-effect checkboxes");
      return [rows[0].key];
    }
  };
  const confirmed = await prompt.promptSw25CombatEntryDecisions(combat, { dialog: fakeDialog });
  assert.equal(confirmed.decide(hero, short), true);
  assert.equal(confirmed.decide(hero, oneMinute), false);

  // Dismissal: null answers leave every candidate undecided (untouched).
  const cancelled = await prompt.promptSw25CombatEntryDecisions(combat, { dialog: { wait: async () => null } });
  assert.equal(cancelled.decide(hero, short), null, "a dismissed window never assumes the effect is active");
  assert.equal(cancelled.decide(hero, oneMinute), null);

  // No candidates → no window at all.
  const emptyCombat = makeCombat([]);
  assert.equal(await prompt.promptSw25CombatEntryDecisions(emptyCombat), null, "nothing to ask, nothing shown");

  // Non-GM clients never act on the hook.
  game.user.isGM = false;
  assert.equal(await prompt.handleSw25CombatStart(combat), null, "the player client performs no entry conversion");

  // GM hook integration: confirm everything on a 5-minute effect.
  clearMocks();
  setGm();
  const gmHero = new MockActor("hero-hook", "Hook Hero");
  const five = await createEffect(gmHero, { scale: "minutes", initial: 5, remaining: 5 });
  const hookCombat = makeCombat([{ id: "cmbt-hook", actor: gmHero, tokenId: "tkn-hook" }]);
  const hookRows = prompt.buildSw25CombatEntryPromptRows(hookCombat);
  const hookResult = await prompt.handleSw25CombatStart(hookCombat, {
    dialog: { wait: async () => hookRows.map(row => row.key) }
  });
  assert.equal(hookResult.code, "entered", `hook entry should succeed: ${hookResult.error ?? ""}`);
  assert.equal(hookResult.converted, 1);
  assert.equal(five.system.durationScale, "rounds");
  assert.equal(five.system.remainingDuration, 30, "5 minutes → 30 rounds");
  assert.equal(five.system.durationAnchor?.regime, "casterTurn", "the D5 default anchor is applied");
  assert.equal(five.system.durationAnchor?.edge, "begin");

  record("6. prompt: checkbox window, checked=active/unchecked=expired, dismissal=undecided, GM hook converts");
}

// ── 7. Seconds-based effects at combat entry (Phase 3 corrections) ──────────

{
  clearMocks();
  setGm();
  const hero = new MockActor("hero-seconds", "Seconds Hero");
  const combat = makeCombat([{ id: "cmbt-seconds", actor: hero, tokenId: "tkn-seconds" }]);

  const seconds30 = await createEffect(hero, {
    scale: "other", name: "Seconds Buff",
    sourceDuration: { unit: "seconds", amount: 30 }
  });
  const minutes5 = await createEffect(hero, { scale: "minutes", initial: 5, remaining: 5, name: "Minute Buff" });
  await createEffect(hero, { scale: "other", name: "Plain Other" });
  await createEffect(hero, { scale: "other", name: "Minute Source", sourceDuration: { unit: "minutes", amount: 3 } });

  // Candidates: the minutes effect AND the seconds-based identity; a plain
  // "other" effect and a non-seconds identity are never candidates.
  const rows = prompt.buildSw25CombatEntryPromptRows(combat);
  assert.equal(rows.length, 2, "minutes + seconds-based candidates only");
  const secondsRow = rows.find(row => row.name === "Seconds Buff");
  const minutesRow = rows.find(row => row.name === "Minute Buff");
  assert.equal(secondsRow.remainingLabel, "30 seconds", "the seconds row shows the authored seconds");
  assert.equal(minutesRow.remainingLabel, "5 minutes");

  // Confirmed active: the seconds effect converts to its EXACT equivalent
  // rounds (30 s ÷ 10 = 3) with the same D5 default anchor as a minutes
  // conversion; the 10-minute threshold never applies to seconds.
  const result = await enterSw25CombatDurationEffects(combat, { decide: async () => true });
  assert.equal(result.ok, true, `entry should succeed: ${result.error ?? ""}`);
  assert.equal(result.converted, 2, "both candidates convert");
  assert.equal(result.kept, 0, "no threshold applies to the seconds flavor");
  assert.equal(seconds30.system.durationScale, "rounds", "the seconds effect joins the combat representation");
  assert.equal(seconds30.system.initialDuration, 3, "10 s = 1 round → 30 s = 3 rounds (initial)");
  assert.equal(seconds30.system.remainingDuration, 3, "10 s = 1 round → 30 s = 3 rounds (remaining)");
  assert.deepEqual(seconds30.system.durationAnchor, {
    regime: "casterTurn", edge: "begin", combatantId: "cmbt-seconds", tokenId: "tkn-seconds", state: "resolved"
  }, "the same D5 default anchor as a minutes conversion");
  assert.equal(minutes5.system.remainingDuration, 30, "the minutes effect still converts through its own threshold (5 × 6)");

  // No-threshold proof: a 600-second identity converts even though its
  // equivalent (10 minutes) would be KEPT under the minute threshold.
  clearMocks();
  setGm();
  const longOwner = new MockActor("hero-600s", "Ten Minute Seconds");
  const longEffect = await createEffect(longOwner, {
    scale: "other", name: "Long Seconds",
    sourceDuration: { unit: "seconds", amount: 600 }
  });
  const combat600 = makeCombat([{ id: "cmbt-600s", actor: longOwner, tokenId: "tkn-600s" }]);
  const longResult = await enterSw25CombatDurationEffects(combat600, { decide: async () => true });
  assert.equal(longResult.converted, 1, "seconds convert regardless of the minute threshold");
  assert.equal(longEffect.system.remainingDuration, 60, "600 s = 60 rounds");

  // Expired → removed; dismissed → untouched with the identity preserved.
  clearMocks();
  setGm();
  const owner = new MockActor("owner-seconds", "Seconds Owner");
  const combatOwner = makeCombat([{ id: "cmbt-owner-seconds", actor: owner, tokenId: "tkn-owner-seconds" }]);
  const expiredSeconds = await createEffect(owner, {
    scale: "other", name: "Expired Seconds",
    sourceDuration: { unit: "seconds", amount: 30 }
  });
  const dismissedSeconds = await createEffect(owner, {
    scale: "other", name: "Dismissed Seconds",
    sourceDuration: { unit: "seconds", amount: 30 }
  });
  const removedResult = await enterSw25CombatDurationEffects(combatOwner, {
    decide: async (actor, effect) => (effect.name === "Expired Seconds" ? false : null)
  });
  assert.equal(removedResult.removed, 1, "a confirmed-expired seconds effect is removed through EffectService");
  assert.equal(owner.effects.includes(expiredSeconds), false);
  assert.equal(removedResult.undecided, 1, "the dismissed effect stays undecided");
  assert.equal(dismissedSeconds.system.durationScale, "other", "a dismissed question never assumes expiry");
  assert.deepEqual(dismissedSeconds.system.sourceDuration, { unit: "seconds", amount: 30 }, "the authored identity survives dismissal");

  // Non-integer equivalents are reported, never rounded; the effects stay
  // untouched on their manual scale.
  clearMocks();
  setGm();
  const fractionalOwner = new MockActor("owner-frac-seconds", "Fractional Seconds");
  const combatFrac = makeCombat([{ id: "cmbt-frac", actor: fractionalOwner, tokenId: "tkn-frac" }]);
  const fractional25 = await createEffect(fractionalOwner, {
    scale: "other", name: "25 Seconds",
    sourceDuration: { unit: "seconds", amount: 25 }
  });
  const tiny5 = await createEffect(fractionalOwner, {
    scale: "other", name: "5 Seconds",
    sourceDuration: { unit: "seconds", amount: 5 }
  });
  const fracResult = await enterSw25CombatDurationEffects(combatFrac, { decide: async () => true });
  assert.equal(fracResult.converted, 0);
  assert.equal(fracResult.unresolved.length, 2, "2.5 and 0.5 rounds are reported incompatible");
  assert.equal(fractional25.system.durationScale, "other", "untouched");
  assert.equal(tiny5.system.durationScale, "other", "untouched");

  // Only a positive seconds amount is a candidate; a fractional amount is a
  // candidate whose conversion is reported (mirroring the fractional-minutes
  // behavior), never silently dropped or rounded.
  clearMocks();
  setGm();
  const badOwner = new MockActor("owner-bad-source", "Bad Source");
  const combatBad = makeCombat([{ id: "cmbt-bad", actor: badOwner, tokenId: "tkn-bad" }]);
  await createEffect(badOwner, { scale: "other", name: "Zero Amount", sourceDuration: { unit: "seconds", amount: 0 } });
  const fractionalAmount = await createEffect(badOwner, {
    scale: "other", name: "Fractional Amount",
    sourceDuration: { unit: "seconds", amount: 10.5 }
  });
  const badRows = prompt.buildSw25CombatEntryPromptRows(combatBad);
  assert.equal(badRows.length, 1, "zero/negative amounts are not candidates");
  assert.equal(badRows[0].name, "Fractional Amount");
  const badResult = await enterSw25CombatDurationEffects(combatBad, { decide: async () => true });
  assert.equal(badResult.converted, 0, "10.5 s = 1.05 rounds is reported, never rounded");
  assert.equal(badResult.unresolved.length, 1);
  assert.equal(fractionalAmount.system.durationScale, "other", "untouched");

  // Apply-path transport: the service persists the identity verbatim and
  // rejects a malformed one at the source.
  const transport = await service.applySw25Effect(hero, {
    family: "TransportTest",
    cast: { successValue: 10 },
    durationScale: "other",
    sourceDuration: { unit: "seconds", amount: 10 },
    changes: []
  });
  assert.equal(transport.ok, true, `apply should accept a seconds identity: ${transport.error ?? ""}`);
  const transportEffect = hero.effects.find(eff => eff.name === "TransportTest");
  assert.ok(transportEffect, "the transport effect was created");
  assert.deepEqual(transportEffect.system.sourceDuration, { unit: "seconds", amount: 10 });
  const malformed = await service.applySw25Effect(hero, {
    family: "TransportTest", cast: { successValue: 10 },
    durationScale: "other", sourceDuration: { unit: "seconds", amount: -1 }, changes: []
  });
  assert.equal(malformed.ok, false, "a malformed identity is rejected at the source");
  assert.equal(malformed.code, "invalid-source-duration");

  record("7. seconds at entry: candidates, 30 s → 3 rounds, no minute threshold, removal/dismissal, fractional reported, transport validated");
}

console.log("effects-unified-duration.test.mjs: all unified-duration assertions passed.");
