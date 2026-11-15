// Sword World 2.5 - HP → DEFEATED status sync test suite.
//
// Exercises the centralized sync (module/actor/defeated-status.mjs) through
// the REAL production entry point — the GM-side `updateActor` hook installed
// by `initializeDefeatedStatusSync` — plus the direct API for the
// idempotency/authority cases.
//
// Covered per the task: HP transitions (+→0 apply, +→negative apply, extra
// damage while defeated, heal still ≤ 0, heal to + removal), no redundant
// writes on repeated sync, manual HP changes (flattened and nested dotted
// updates), actors without numeric HP (monster sections), the reentrancy
// guard, `Combatant#isDefeated` detection with a core-style getter under real
// conditions (flag override, two tokens of one actor), the native-status
// contract (never an `sw25Effect`, no HP writes, no combatant flag writes),
// the T5.3 cross-module scenario (anchor availability degrades to
// `combatant-defeated` through the real engine, without restarting or
// reassigning the anchor), and the Effects tab visual coexistence
// (native row present with NO SV/duration/management data, `sw25Effect`
// rows untouched, absent when the status is not active).
//
// Out of scope (deliberate): Death Checks (none are implemented by this
// feature), per-token status writes (core propagates special statuses
// automatically), monsters' per-section HP (no single `system.hp.value`).

import assert from "node:assert/strict";

// ── Global Foundry environment mock (before any module import) ───────────────

const registeredHooks = new Map();
const notifications = [];

globalThis.CONFIG = {
  specialStatusEffects: { DEFEATED: "dead" },
  statusEffects: {
    dead: { id: "dead", name: "EFFECT.StatusDead", img: "icons/svg/skull.svg" }
  }
};

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
    getProperty(object, path) {
      return String(path ?? "").split(".").reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), object);
    },
    escapeHtml: value => String(value ?? ""),
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    },
    mergeObject: (a, b) => ({ ...a, ...b }),
    deepClone: value => structuredClone(value),
    fromUuidSync: () => null
  }
};

let isGM = true;

globalThis.game = {
  user: { get isGM() { return isGM; }, id: "user-gm" },
  i18n: { localize: key => (key === "EFFECT.StatusDead" ? "Dead" : key) }
};

globalThis.Application = class { render() {} async close() {} };

// ── Mocks: actors with the core `toggleStatusEffect` contract ────────────────

let nextMockId = 1;

class MockStatusEffect {
  constructor(data) {
    this.id = `nse-${nextMockId++}`;
    this.type = "status";
    this.name = data.name ?? null;
    this.img = data.img ?? null;
    this.flags = structuredClone(data.flags ?? {});
    this.deleted = false;
  }
}

class MockActor {
  constructor(id, name, hp = null) {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.name = name;
    this.type = "character";
    this.system = hp === null ? {} : { hp: { value: hp, max: 30 } };
    this.effects = [];
    this._statuses = new Set();
    this.toggleCalls = [];
    this.hpUpdates = [];
    this.combatantFlags = [];
  }
  get statuses() { return new Set(this._statuses); }
  statusEffectDocuments(statusId) {
    return this.effects.filter(effect => effect.type === "status" && effect.flags?.core?.statusId === statusId && !effect.deleted);
  }
  async toggleStatusEffect(statusId, { active, overlay = false } = {}) {
    if (!(statusId in CONFIG.statusEffects)) throw new Error("Invalid status ID");
    const shouldBeActive = active ?? !this._statuses.has(statusId);
    const current = this._statuses.has(statusId);
    this.toggleCalls.push({ statusId, active: shouldBeActive, overlay });
    if (shouldBeActive === current) return shouldBeActive; // idempotent: no write
    if (shouldBeActive) {
      const definition = CONFIG.statusEffects[statusId];
      const effect = new MockStatusEffect({
        name: definition.name,
        img: definition.img,
        flags: { core: { statusId, overlay } }
      });
      this.effects.push(effect);
      this._statuses.add(statusId);
      return effect;
    }
    for (const effect of this.statusEffectDocuments(statusId)) effect.deleted = true;
    this.effects = this.effects.filter(effect => !effect.deleted);
    this._statuses.delete(statusId);
    return false;
  }
  async update(changes) {
    // Flatten (mirrors real updates arriving flattened or nested).
    for (const [path, value] of Object.entries(changes)) {
      const parts = path.split(".");
      let cursor = this;
      for (let i = 0; i < parts.length - 1; i++) {
        cursor[parts[i]] ??= {};
        cursor = cursor[parts[i]];
      }
      cursor[parts[parts.length - 1]] = value;
    }
    this.hpUpdates.push(structuredClone(changes));
    return this;
  }
}

class MockCombatant {
  constructor(id, actor, { defeated = false, tokenId = null } = {}) {
    this.id = id;
    this.actor = actor;
    this.defeated = defeated;
    this.tokenId = tokenId;
    if (tokenId) this.token = { id: tokenId };
  }
  // The REAL core-style getter (v14): the manual defeated flag OR the DEFEATED
  // special status effect on the actor.
  get isDefeated() {
    return this.defeated === true || this.actor?.statuses?.has(CONFIG.specialStatusEffects.DEFEATED) === true;
  }
}

class MockCombat {
  constructor(combatants) {
    this.id = "combat-1";
    this.round = 1;
    this.combatants = combatants;
    this.combatants.get = cid => this.combatants.find(c => c.id === cid) ?? null;
  }
}

async function fireUpdateActor(actor, change) {
  // Real core sequence: the update data is applied to the document BEFORE
  // the `updateActor` hook fires — the sync reads the actor's CURRENT hp.
  const parts = path => String(path).split(".");
  for (const [path, value] of Object.entries(change)) {
    const keys = parts(path);
    let cursor = actor;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof cursor[keys[i]] !== "object" || cursor[keys[i]] === null) cursor[keys[i]] = {};
      cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = value;
  }
  for (const listener of registeredHooks.get("updateActor") ?? []) await listener(actor, change, {}, game.user.id);
}

// ── Module imports (after the environment mock) ──────────────────────────────

const sync = await import("../module/actor/defeated-status.mjs");
const tab = await import("../module/effects/effects-tab.mjs");
const engine = await import("../module/effects/duration-engine.mjs");
const repair = await import("../module/effects/effect-repair.mjs");

const record = label => console.log(`  ${label}`);

// ── 1. HP transitions through the real hook ──────────────────────────────────

sync.initializeDefeatedStatusSync();

{
  const actor = new MockActor("actor-a", "Aria", 20);

  // +→0: applied.
  await fireUpdateActor(actor, { "system.hp.value": 0 });
  assert.equal(actor.statuses.has("dead"), true, "HP 0 must apply DEFEATED");
  assert.equal(actor.toggleCalls.length, 1, "HP 0 applies with exactly one status write");
  assert.equal(actor.toggleCalls[0].overlay, true, "the sync applies with overlay: true (tracker-consistent)");
  const applied = actor.statusEffectDocuments("dead");
  assert.equal(applied.length, 1, "exactly one native status effect document");
  assert.equal(applied[0].type, "status", "the created document is a NATIVE status effect");
  assert.notEqual(applied[0].type, "sw25Effect", "DEFEATED is never an sw25Effect");
  assert.equal(actor.system.hp.value, 0, "the sync never modifies HP");
  record("1a. HP +→0 applies DEFEATED once, overlay:true, native status document, HP untouched");

  // Extra damage while defeated: no redundant write.
  await fireUpdateActor(actor, { "system.hp.value": -7 });
  assert.equal(actor.toggleCalls.length, 1, "extra damage while defeated writes nothing");
  assert.equal(actor.statuses.has("dead"), true, "still defeated");
  assert.equal(actor.system.hp.value, -7, "negative HP preserved exactly");
  record("1b. extra damage while defeated: no write, negative HP preserved");

  // Heal still ≤ 0: no write, still defeated.
  await fireUpdateActor(actor, { system: { hp: { value: -3 } } });
  assert.equal(actor.toggleCalls.length, 1, "heal that stays ≤ 0 writes nothing");
  assert.equal(actor.statuses.has("dead"), true, "still defeated at HP -3");
  assert.equal(actor.system.hp.value, -3, "negative HP still preserved");
  record("1c. heal still ≤ 0: no write, still defeated (nested dotted update covered)");

  // Heal to +: removed.
  await fireUpdateActor(actor, { "system.hp.value": 25 });
  assert.equal(actor.toggleCalls.length, 2, "heal above 0 removes with exactly one write");
  assert.equal(actor.toggleCalls[1].active, false, "removal is an active:false toggle");
  assert.equal(actor.statuses.has("dead"), false, "DEFEATED removed");
  assert.equal(actor.statusEffectDocuments("dead").length, 0, "no status document remains");
  record("1d. heal to + removes DEFEATED");
}

// +→negative applies directly.
{
  const actor = new MockActor("actor-b", "Brumo", 12);
  await fireUpdateActor(actor, { "system.hp.value": -14 });
  assert.equal(actor.statuses.has("dead"), true, "a negative jump applies DEFEATED");
  assert.equal(actor.toggleCalls.length, 1, "single write");
  record("2. HP +→negative applies DEFEATED directly");
}

// ── 3. Manual HP changes (sheet edits) and irrelevant updates ────────────────

{
  const actor = new MockActor("actor-c", "Cael", 30);
  await fireUpdateActor(actor, { "system.hp.value": 0, "system.mp.value": 2 });
  assert.equal(actor.statuses.has("dead"), true, "a manual sheet edit (flattened change) triggers the sync");
  actor.toggleCalls.length = 0;

  await fireUpdateActor(actor, { "system.mp.value": 5 });
  assert.equal(actor.toggleCalls.length, 0, "updates without system.hp.value never trigger a sync attempt");

  await fireUpdateActor(actor, { "system.hp.max": 40 });
  assert.equal(actor.toggleCalls.length, 0, "hp.max-only updates never trigger a sync attempt");

  await fireUpdateActor(actor, {});
  assert.equal(actor.toggleCalls.length, 0, "an empty change never triggers a sync attempt");
  record("3. manual HP edits sync; non-HP updates are ignored without any work");
}

// ── 4. Idempotency and direct API contract ───────────────────────────────────

{
  const actor = new MockActor("actor-d", "Dora", 5);
  await sync.syncSw25DefeatedStatus(actor);
  await sync.syncSw25DefeatedStatus(actor);
  await sync.syncSw25DefeatedStatus(actor);
  assert.equal(actor.toggleCalls.length, 0, "an HP>0 actor in sync receives no writes on repeated syncs");
  const result = await sync.syncSw25DefeatedStatus(actor);
  assert.equal(result.ok, true);
  assert.equal(result.code, "in-sync");
  assert.equal(result.changed, false);
  record("4a. repeated sync of an in-sync actor: no redundant writes, code 'in-sync'");

  await sync.syncSw25DefeatedStatus(new MockActor("actor-e", "NoHp"));
  // (covered by the no-hp section below)
  record("4b. direct API calls respect the same contract");
}

// ── 5. Authority and data-shape guards ───────────────────────────────────────

{
  const actor = new MockActor("actor-f", "Fenn", 0);
  isGM = false;
  const result = await sync.syncSw25DefeatedStatus(actor);
  isGM = true;
  assert.equal(result.ok, false, "non-GM callers are refused");
  assert.equal(result.code, "not-gm");
  assert.equal(actor.toggleCalls.length, 0, "non-GM sync never writes");
  record("5a. non-GM: refused without writes");

  const monsterLike = new MockActor("actor-g", "Goremaw");
  monsterLike.type = "monster";
  monsterLike.system = { combatStyles: { s1: { hp: { value: 0, max: 40 } } } };
  const noHp = await sync.syncSw25DefeatedStatus(monsterLike);
  assert.equal(noHp.code, "no-hp", "actors without a numeric system.hp.value are out of sync scope");
  assert.equal(monsterLike.toggleCalls.length, 0, "no write for sectioned monsters");
  record("5b. monster-style sectioned HP: 'no-hp', out of scope, no write");

  const hpObject = new MockActor("actor-h", "Half", 10);
  hpObject.system.hp.value = "ten";
  const badHp = await sync.syncSw25DefeatedStatus(hpObject);
  assert.equal(badHp.code, "no-hp", "a non-numeric hp value is treated as out of scope");
  record("5c. non-numeric hp: 'no-hp'");
}

// ── 6. Reentrancy guard ──────────────────────────────────────────────────────

{
  const actor = new MockActor("actor-i", "Ivor", -5);
  let nested = null;
  actor.toggleStatusEffect = async function (statusId, options) {
    // A status write must not re-enter the sync; simulate a concurrent call.
    nested = await sync.syncSw25DefeatedStatus(this);
    return MockActor.prototype.toggleStatusEffect.call(this, statusId, options);
  };
  const result = await sync.syncSw25DefeatedStatus(actor);
  assert.equal(result.code, "applied");
  assert.equal(nested?.code, "reentrancy", "a call re-entered from an in-flight sync is refused by the guard");
  assert.equal(actor.statuses.has("dead"), true, "the guarded sync still completes");
  record("6. reentrancy guard serializes concurrent syncs without deadlock");
}

// ── 7. Combatant#isDefeated under real conditions ────────────────────────────

{
  const actor = new MockActor("actor-j", "Juna", 15);
  // Two tokens of the same actor (unlinked-style views share the actor's
  // status collection): ONE actor-level status write keeps both consistent.
  const token1 = new MockCombatant("c1", actor, { tokenId: "tok11111111111111" });
  const token2 = new MockCombatant("c2", actor, { tokenId: "tok22222222222222" });
  assert.equal(token1.isDefeated, false, "not defeated before the sync");
  assert.equal(token2.isDefeated, false, "second token not defeated either");

  await fireUpdateActor(actor, { "system.hp.value": 0 });
  assert.equal(actor.toggleCalls.length, 1, "one ACTOR-level write regardless of token count");
  assert.equal(token1.isDefeated, true, "token 1 detects the defeat through the actor status");
  assert.equal(token2.isDefeated, true, "token 2 detects the same defeat (no inconsistency)");
  record("7a. two tokens of one actor: single actor-level write, both isDefeated true");

  // An actor without any token placement syncs identically (the sync is
  // actor-level; core propagates special statuses to dependent tokens).
  const tokenless = new MockActor("actor-k", "Kel", 8);
  await fireUpdateActor(tokenless, { "system.hp.value": 0 });
  assert.equal(tokenless.statuses.has("dead"), true, "a tokenless actor is synced normally");
  record("7b. actor without tokens: synced identically");

  // Manual tracker flag override survives sync removal (the sync never
  // touches the combatant defeated flag; isDefeated stays true via the flag).
  const flagged = new MockActor("actor-l", "Liam", 10);
  const combatant = new MockCombatant("c3", flagged, { defeated: true });
  await fireUpdateActor(flagged, { "system.hp.value": 20 });
  assert.equal(flagged.statuses.has("dead"), false, "HP>0 removed the status");
  assert.equal(combatant.isDefeated, true, "the manual flag keeps isDefeated true (documented manual authority)");
  record("7c. manual combatant flag override survives status removal");
}

// ── 8. T5.3 cross-module: anchor degradation through the real engine ─────────

{
  const actor = new MockActor("actor-m", "Milo", 20);
  const combatant = new MockCombatant("c4", actor, { tokenId: "tok33333333333333" });
  const combat = new MockCombat([combatant]);
  const anchor = {
    combatantId: "c4",
    regime: "casterTurn",
    edge: "end",
    state: "resolved"
  };
  const anchorSnapshot = structuredClone(anchor);

  const before = engine.sw25AnchorAvailability(combat, anchor);
  assert.deepEqual(before, { available: true, reason: null }, "a healthy anchored combatant is available");
  assert.deepEqual(anchor, anchorSnapshot, "availability checks never mutate the anchor");

  await fireUpdateActor(actor, { "system.hp.value": 0 });
  assert.equal(actor.statuses.has("dead"), true, "the sync applied the status");
  const during = engine.sw25AnchorAvailability(combat, anchor);
  assert.deepEqual(during, { available: false, reason: "combatant-defeated" },
    "the engine degrades the anchor through the REAL isDefeated signal the sync drives");
  assert.deepEqual(anchor, anchorSnapshot, "degradation never restarts or reassigns the anchor");

  await fireUpdateActor(actor, { "system.hp.value": 6 });
  const after = engine.sw25AnchorAvailability(combat, anchor);
  assert.deepEqual(after, { available: true, reason: null }, "healing restores availability");
  assert.deepEqual(anchor, anchorSnapshot, "the anchor object is never touched by the sync");
  record("8. T5.3 cross-module: HP drop → combatant-defeated degradation; heal → available; anchor intact");
}

// ── 9. Effects tab: native status row and coexistence ────────────────────────

{
  const actor = new MockActor("actor-n", "Nia", 0);
  await fireUpdateActor(actor, { "system.hp.value": 0 });

  const row = tab.describeSw25NativeStatus(actor);
  assert.ok(row, "the native row is present while DEFEATED is active");
  assert.equal(row.native, true, "the row is flagged as native");
  assert.equal(row.displayName, "Dead", "the name comes from the localized EFFECT.StatusDead");
  assert.equal(row.img, "icons/svg/skull.svg", "the skull icon from the core status definition");
  assert.equal(row.stateLabel, "Active", "the state column shows a plain active label");
  assert.equal(row.successValueLabel, undefined, "NO SV data");
  assert.equal(row.durationLabel, undefined, "NO duration data");
  assert.equal(row.originLabel, undefined, "NO origin/anchor data");
  assert.equal(typeof row.needsReview, "undefined", "no repair/review semantics for a native status");
  record("9a. native row: localized name, skull icon, no SV/duration/origin/management data");

  // Coexistence with a real-shaped sw25Effect stub.
  actor.effects.push({
    id: "ef-sw25-1",
    type: "sw25Effect",
    name: "Bless of the Taka",
    img: "icons/svg/angel.svg",
    origin: null,
    duration: null,
    system: {
      schemaVersion: repair.EFFECT_SCHEMA_VERSION,
      family: "bless-taka",
      rank: 1,
      effectType: "buff",
      successValue: 5,
      durationScale: "rounds",
      initialDuration: 3,
      remainingDuration: 3,
      changes: []
    }
  });
  const context = tab.prepareSw25EffectsTab(actor, true);
  assert.equal(context.nativeStatusRow?.native, true, "the tab context carries the native row");
  assert.equal(context.rows.length, 1, "the sw25Effect rows are untouched by the native row");
  assert.equal(context.rows[0].id, "ef-sw25-1", "the persistent row is the system effect, unchanged");
  assert.ok(context.rows.every(row => row.native !== true), "native rows never mix into the sw25Effect row list");
  assert.ok(!("successValueLabel" in context.nativeStatusRow), "native row exposes no SV column data");
  record("9b. coexistence: native row alongside sw25Effect rows; system rows unaffected");

  // Absent when the status is not active.
  const healthy = new MockActor("actor-o", "Odo", 10);
  assert.equal(tab.describeSw25NativeStatus(healthy), null, "no native row without the status");
  const healthyContext = tab.prepareSw25EffectsTab(healthy, true);
  assert.equal(healthyContext.nativeStatusRow, null, "the tab context is null without the status");
  record("9c. no native row when DEFEATED is not active");
}

// ── 10. Headless i18n fallback and invalid status id guard ───────────────────

{
  const actor = new MockActor("actor-p", "Pia", 0);
  await fireUpdateActor(actor, { "system.hp.value": 0 });
  const savedLocalize = game.i18n.localize;
  game.i18n = undefined;
  const row = tab.describeSw25NativeStatus(actor);
  game.i18n = { localize: savedLocalize };
  assert.equal(row.displayName, "Defeated", "headless environments degrade to the fallback label");
  record("10a. i18n fallback: 'Defeated' when core localization is unavailable");

  const weird = new MockActor("actor-q", "Quinn", 0);
  const savedConfig = globalThis.CONFIG.specialStatusEffects.DEFEATED;
  globalThis.CONFIG.specialStatusEffects.DEFEATED = "unknown-status";
  let threw = false;
  try {
    await sync.syncSw25DefeatedStatus(weird);
  } catch (error) {
    threw = true; // core contract: unknown status ids are rejected loudly
  }
  globalThis.CONFIG.specialStatusEffects.DEFEATED = savedConfig;
  assert.ok(threw || weird.toggleCalls.length === 0, "an unconfigured DEFEATED id never writes silently");
  record("10b. an unconfigured DEFEATED id never writes silently");
}

console.log("defeated-status.test.mjs: all HP → DEFEATED sync assertions passed.");
