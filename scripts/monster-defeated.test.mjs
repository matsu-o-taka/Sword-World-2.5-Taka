// Sword World 2.5 - Multi-section monster DEFEATED sync test suite.
//
// Exercises the monster branch of the centralized sync
// (module/actor/defeated-status.mjs + module/actor/monster-section-state.mjs)
// through the REAL production entry point — the GM-side `updateActor` hook
// installed by `initializeDefeatedStatusSync` — plus direct API and pure
// derivation cases.
//
// Covered per the task: normal characters stay on the HP path intact;
// single-section monsters (`any`); multi-section `any` (one destroyed main
// incapacitates); `all` (one destroyed main does not, all do); `none`
// (partial destruction does not, all sections destroyed do); secondary-only
// destruction without global condition; negative section HP preserved;
// recovery (heal above the condition removes DEFEATED); damage, heal and
// manual edits through flattened and nested updates; no redundant writes;
// `Combatant#isDefeated` through the core-style getter and the REAL T5.3
// engine (anchor availability degrades/restores without touching the engine);
// existing monsters without an explicit policy (default `any`; recovered
// `all`/`none` from the imported `mainSection.type`); policy-change re-sync;
// non-numeric HP rows; the pure `readMonsterSectionState` contract; and the
// Concealed Main Section (special) flow: the ActiveEffect-based GM-only
// selection drives the same sync (no selection → documented degradation;
// hidden section destroyed → DEFEATED; secondary destruction inert;
// re-selection re-syncs; per-token adoption/fallback; policy switches
// preserve the selection; GM-only presentation checks — players never see
// the selection or its effect through the system UI).
//
// Out of scope (deliberate): Death Checks (not implemented) and per-token
// writes (core propagates special statuses).

import assert from "node:assert/strict";

// ── Global Foundry environment mock (before any module import) ───────────────

const registeredHooks = new Map();

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
    info(msg) { notificationLog.info.push(String(msg)); },
    warn(msg) { notificationLog.warn.push(String(msg)); },
    error(msg) { notificationLog.error.push(String(msg)); }
  }
};

// ── EffectService mock (ActiveEffect-based storage, replaces Journal) ────────
//
// `applySw25Effect` creates an `sw25Effect` document on `actor.effects` whose
// flags carry the ENCRYPTED concealed record (`flags["sw25-taka"]
// .concealedSection`); `removeSw25Effect` deletes one. `game.user.isGM` gates
// GM-only writes (defense in depth).
const effectsByActor = new WeakMap();
let nextEffectId = 1;

globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 } };

// Real `game.settings` mock (the ONLY settings API in Foundry v14) with
// faithful scope semantics: client-scope values live ONLY in this simulated
// GM browser store (they never replicate anywhere); reading an unregistered
// setting throws exactly like the real ClientSettings.
const registeredSettings = new Map();
const clientStore = new Map(); // the simulated GM browser (localStorage)
const worldStore = new Map();
const settingsApi = {
  register(moduleId, key, options = {}) {
    registeredSettings.set(`${moduleId}.${key}`, { ...options, moduleId, key });
  },
  get(moduleId, key) {
    const id = `${moduleId}.${key}`;
    if (!registeredSettings.has(id)) throw new Error(`"${id}" is not a registered game setting`);
    const options = registeredSettings.get(id);
    const store = options.scope === "client" ? clientStore : worldStore;
    return store.has(id) ? structuredClone(store.get(id)) : structuredClone(options.default);
  },
  async set(moduleId, key, value) {
    const id = `${moduleId}.${key}`;
    if (!registeredSettings.has(id)) throw new Error(`"${id}" is not a registered game setting`);
    const options = registeredSettings.get(id);
    (options.scope === "client" ? clientStore : worldStore).set(id, structuredClone(value));
    return structuredClone(value);
  }
};

function actorEffects(actor) {
  let effects = effectsByActor.get(actor);
  if (!effects) {
    effects = [];
    effectsByActor.set(actor, effects);
  }
  return effects;
}

function findSw25EffectById(actor, effectId) {
  return actorEffects(actor).find(effect => effect.type === "sw25Effect" && effect.id === effectId) ?? null;
}

globalThis.applySw25Effect = async (actor, payload) => {
  if (game?.user?.isGM !== true) return { ok: false, code: "not-gm" };
  if (!actor?.effects) return { ok: false, code: "no-actor" };
  const id = `sw25-${nextEffectId++}`;
  const effect = {
    id,
    uuid: `ActiveEffect.${id}`,
    type: "sw25Effect",
    name: payload.family ?? "Concealed Main Section",
    system: {
      family: payload.family,
      rank: payload.rank ?? 0
    },
    flags: structuredClone(payload.flags ?? {}),
    disabled: false,
    deleted: false,
    async delete() {
      const effects = actorEffects(actor);
      const idx = effects.findIndex(e => e.id === id);
      if (idx >= 0) effects.splice(idx, 1);
      const actorIdx = actor.effects.findIndex(e => e.id === id);
      if (actorIdx >= 0) actor.effects.splice(actorIdx, 1);
      this.deleted = true;
    },
    async update(data) {
      Object.assign(this, data);
    }
  };
  actorEffects(actor).push(effect);
  actor.effects.push(effect); // Mirror to actor.effects so findConcealedEffect can locate it
  return { ok: true, code: "applied", effectId: id, effectUuid: effect.uuid };
};

globalThis.removeSw25Effect = async (actor, effectId) => {
  if (game?.user?.isGM !== true) return { ok: false, code: "not-gm" };
  if (!actor?.effects) return { ok: false, code: "no-actor" };
  const effect = findSw25EffectById(actor, effectId);
  if (!effect) return { ok: false, code: "no-effect" };
  await effect.delete(); // delete() now removes from both WeakMap and actor.effects
  return { ok: true, code: "removed", effectId };
};

globalThis.foundry = {
  utils: {
    getProperty(object, path) {
      return String(path ?? "").split(".").reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), object);
    },
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    },
    mergeObject: (a, b) => ({ ...a, ...b }),
    deepClone: value => structuredClone(value)
  }
};

let isGM = true;

const notificationLog = { info: [], warn: [], error: [] };

globalThis.game = {
  user: { get isGM() { return isGM; }, id: "user-gm" },
  scenes: [],
  world: { id: "test-world" },
  actors: [],
  settings: settingsApi
};

globalThis.Application = class { render() {} async close() {} };

// ── Mocks: monster actors with the core `toggleStatusEffect` contract ────────

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

class MockMonsterActor {
  constructor(id, name, system = {}) {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.name = name;
    this.type = "monster";
    this.system = structuredClone(system);
    this.effects = [];
    this.flags = {};
    this._statuses = new Set();
    this.toggleCalls = [];
    this.updates = [];
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
    if (shouldBeActive === current) return shouldBeActive;
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
  async createEmbeddedDocuments(type, docs) {
    if (type !== "ActiveEffect") throw new Error("Only ActiveEffect is supported in this mock");
    const created = structuredClone(docs[0]);
    created.id = `sw25-${nextMockId++}`;
    created.uuid = `ActiveEffect.${created.id}`;
    created.type = "sw25Effect";
    created.system = {
      family: docs[0].system?.family,
      rank: docs[0].system?.rank ?? 0,
      gmOnly: docs[0].system?.gmOnly === true
    };
    created.flags = structuredClone(docs[0].flags ?? {});
    created.disabled = false;
    created.deleted = false;
    created.delete = async () => {
      const idx = this.effects.findIndex(e => e.id === created.id);
      if (idx >= 0) this.effects.splice(idx, 1);
      created.deleted = true;
    };
    created.update = async (data) => { Object.assign(created, data); };
    this.effects.push(created);
    return [created];
  }
  async update(changes) {
    // Real core sequence: apply, THEN fire the hook (see fireUpdateActor).
    applyChange(this, changes);
    this.updates.push(structuredClone(changes));
    for (const listener of registeredHooks.get("updateActor") ?? []) await listener(this, structuredClone(changes), {}, game.user.id);
    return this;
  }
}

function applyChange(target, change) {
  for (const [path, value] of Object.entries(change)) {
    const keys = String(path).split(".");
    let cursor = target;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof cursor[keys[i]] !== "object" || cursor[keys[i]] === null) cursor[keys[i]] = {};
      cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = structuredClone(value);
  }
}

// Concealed-capable monster: adds placed-token access the actor-level
// selection uses.
class MockConcealedActor extends MockMonsterActor {
  constructor(id, name, system = {}) {
    super(id, name, system);
    this.tokens = [];
  }
  getActiveTokens() { return this.tokens; }
}

function makeConcealedToken(actor, id, flags = {}) {
  const token = {
    id,
    uuid: `Scene.scene.Token.${id}`,
    name: `${actor.name} ${id}`,
    actor,
    flags: structuredClone(flags),
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) {
      this.flags[scope] ??= {};
      this.flags[scope][key] = structuredClone(value);
    }
  };
  token.document = token;
  return token;
}

// Cursed-Artist-shaped system (CR III p. 368): two sections, the Main
// Section secretly selected from them, import identification "special".
const concealedSystem = () => ({
  sourceUrl: "https://sw25.wikidot.com/monster:cursed-artist",
  mainSection: { type: "special", sourceValue: "Special" },
  uniqueSkills: [{ title: "◯Concealed Main Section" }],
  combatStyles: [
    sectionRow("cs-musician", "Musician", 115),
    sectionRow("cs-instrument", "Instrument", 106)
  ]
});

const flushQueuedSync = () => new Promise(resolve => setTimeout(resolve, 10));

// The updateActor listener is fire-and-forget by design, and the special
// policy adds async selection reads BEFORE the status write, so the special
// flow needs a determinism flush after a hooked update (mock-env only; in the
// live client the update flow re-renders on completion regardless).
async function fireSpecialSectionUpdate(actor, change) {
  await fireUpdateActor(actor, change);
  await flushQueuedSync();
}

async function fireUpdateActor(actor, change) {
  // The update data is applied to the document BEFORE the hook fires.
  applyChange(actor, change);
  for (const listener of registeredHooks.get("updateActor") ?? []) await listener(actor, structuredClone(change), {}, game.user.id);
}

class MockCombatant {
  constructor(id, actor, { defeated = false } = {}) {
    this.id = id;
    this.actor = actor;
    this.defeated = defeated;
  }
  get isDefeated() {
    return this.defeated === true || this.actor?.statuses?.has(CONFIG.specialStatusEffects.DEFEATED) === true;
  }
}

class MockCombat {
  constructor(combatants) {
    this.id = "combat-m";
    this.round = 1;
    this.combatants = combatants;
    this.combatants.get = cid => this.combatants.find(c => c.id === cid) ?? null;
  }
}

// Section row factory: `combatStyles` rows as the sheet/importer persist them.
const sectionRow = (id, section, hp, { isMainSection = false, sectionLabel } = {}) => ({
  id, style: `${section} attack`, section, sectionLabel: sectionLabel ?? section,
  hp: { value: hp, max: 40 }, mp: { value: 10, max: 10 }, isMainSection
});

const record = label => console.log(`  ${label}`);

// The concealed effect flags carry the PLAINTEXT selection record
// (`{ sectionId }`), hidden from players by the effect's `system.gmOnly:
// true` presentation flag (no encryption anywhere).
function assertConcealedRecord(effect, expectedSectionId) {
  const record = effect?.flags?.["sw25-taka"]?.concealedSection;
  assert.ok(record && typeof record === "object", "the effect carries the concealed selection record");
  assert.equal(record.sectionId, expectedSectionId, "the record stores the chosen section id as plaintext");
  assert.equal(effect.system?.gmOnly, true, "the concealed effect is marked GM-only");
}

// ── Module imports (after the environment mock) ──────────────────────────────

const sync = await import("../module/actor/defeated-status.mjs");
const sectionState = await import("../module/actor/monster-section-state.mjs");
const concealed = await import("../module/combat/concealed-main-section.mjs");
const effectsTab = await import("../module/effects/effects-tab.mjs");
const engine = await import("../module/effects/duration-engine.mjs");

sync.initializeDefeatedStatusSync();

// ── 1. Normal characters: the character path is intact ───────────────────────

{
  const character = new MockMonsterActor("mc-a", "Plain Fighter");
  character.type = "character";
  character.system = { hp: { value: 15, max: 30 } };
  await fireUpdateActor(character, { "system.hp.value": 0 });
  assert.equal(character.statuses.has("dead"), true, "character HP 0 applies DEFEATED");
  await fireUpdateActor(character, { "system.hp.value": 12 });
  assert.equal(character.statuses.has("dead"), false, "character heal removes DEFEATED");
  assert.equal(character.toggleCalls.length, 2, "character path writes exactly twice");
  record("1. normal character: HP path intact through the same hook");
}

// ── 2. Single-section monster, policy any (default) ──────────────────────────

{
  const single = new MockMonsterActor("mc-b", "One Headed", {
    combatStyles: [sectionRow("cs-1", "Body", 30, { isMainSection: true })]
  });
  // Section damage does NOT incapacitate while the HP stay above 0.
  await fireUpdateActor(single, { "system.combatStyles": [sectionRow("cs-1", "Body", 1, { isMainSection: true })] });
  assert.equal(single.statuses.has("dead"), false, "1 HP section: active");
  assert.equal(single.toggleCalls.length, 0, "no status write above the condition");
  // Section reaches 0: incapacitated (any, default).
  await fireUpdateActor(single, { "system.combatStyles.0.hp.value": 0 });
  assert.equal(single.statuses.has("dead"), true, "single main section at 0 incapacitates (any)");
  assert.equal(single.toggleCalls.length, 1, "single write");
  // Extra damage drives the section negative: no redundant write.
  await fireUpdateActor(single, { "system.combatStyles.0.hp.value": -5 });
  assert.equal(single.toggleCalls.length, 1, "negative overflow writes nothing while defeated");
  assert.equal(single.system.combatStyles[0].hp.value, -5, "negative section HP preserved");
  // Heal back: removed.
  await fireUpdateActor(single, { "system.combatStyles.0.hp.value": 10 });
  assert.equal(single.statuses.has("dead"), false, "healed section removes DEFEATED");
  assert.equal(single.toggleCalls.length, 2, "removal is a single write");
  record("2. single-section monster (any): 0 HP incapacitates, negatives preserved, recovery removes");
}

// ── 3. Multi-section any: one destroyed main incapacitates ───────────────────

{
  const hydraAny = new MockMonsterActor("mc-c", "Hydra (any)", {
    mainSection: { type: "named", sourceValue: "Neck, Head", combatStyleIds: ["cs-2", "cs-3"] },
    combatStyles: [
      sectionRow("cs-1", "Body", 40),
      sectionRow("cs-2", "Neck", 30, { isMainSection: true }),
      sectionRow("cs-3", "Head", 30, { isMainSection: true })
    ]
  });
  // Destroying a SECONDARY section must not incapacitate.
  await fireUpdateActor(hydraAny, { "system.combatStyles.0.hp.value": 0 });
  assert.equal(hydraAny.statuses.has("dead"), false, "secondary destroyed: active");
  assert.equal(hydraAny.toggleCalls.length, 0, "secondary destruction writes nothing");
  // Destroying ONE main section (several noted, no (All)): incapacitates.
  await fireUpdateActor(hydraAny, { "system.combatStyles.2.hp.value": 0 });
  assert.equal(hydraAny.statuses.has("dead"), true, "one of the noted main sections at 0 incapacitates (any)");
  assert.equal(hydraAny.toggleCalls.length, 1, "single write");
  // Healing only the destroyed main restores the monster (other main alive).
  await fireUpdateActor(hydraAny, { "system.combatStyles.2.hp.value": 15 });
  assert.equal(hydraAny.statuses.has("dead"), false, "healing the destroyed main removes DEFEATED");
  record("3. multi any: secondary destruction inert; one destroyed main incapacitates; recovery");
}

// ── 4. Multi-section all ((All) recovery and explicit) ───────────────────────

{
  const hydraAll = new MockMonsterActor("mc-d", "Hydra (all)", {
    // Imported (All) profile WITHOUT an explicit policy: recovered as `all`.
    mainSection: { type: "all", sourceValue: "Neck (All)", combatStyleIds: ["cs-2"] },
    combatStyles: [
      sectionRow("cs-1", "Body", 40),
      sectionRow("cs-2", "Neck", 30, { isMainSection: true })
    ]
  });
  await fireUpdateActor(hydraAll, { "system.combatStyles.1.hp.value": 0 });
  assert.equal(hydraAll.statuses.has("dead"), true, "the ONLY specified main section at 0 incapacitates (all)");
  assert.equal(hydraAll.toggleCalls.length, 1, "single write");
  await fireUpdateActor(hydraAll, { "system.combatStyles.1.hp.value": 20 });
  assert.equal(hydraAll.statuses.has("dead"), false, "healed main restores the monster");
  record("4a. (All) recovered from import data without explicit policy");

  const twinAll = new MockMonsterActor("mc-e", "Twin Hydra (all)", {
    mainSectionPolicy: "all",
    combatStyles: [
      sectionRow("cs-1", "Body", 40, { isMainSection: true }),
      sectionRow("cs-2", "Neck", 30, { isMainSection: true }),
      sectionRow("cs-3", "Head", 30, { isMainSection: true })
    ]
  });
  // All policy: every section is a main section, so incapacitation needs ALL
  // sections destroyed — a partial destruction stays inert.
  await fireUpdateActor(twinAll, { "system.combatStyles.1.hp.value": -3 });
  assert.equal(twinAll.statuses.has("dead"), false, "one of three mains destroyed: active (all)");
  assert.equal(twinAll.system.combatStyles[1].hp.value, -3, "negative HP of the destroyed main preserved");
  await fireUpdateActor(twinAll, { "system.combatStyles.2.hp.value": 0 });
  assert.equal(twinAll.statuses.has("dead"), false, "two of three mains destroyed: still active (all)");
  await fireUpdateActor(twinAll, { "system.combatStyles.0.hp.value": 0 });
  assert.equal(twinAll.statuses.has("dead"), true, "all mains destroyed incapacitates (all)");
  assert.equal(twinAll.toggleCalls.length, 1, "exactly one status write across all transitions");
  // Heal one main: condition no longer met, DEFEATED removed.
  await fireUpdateActor(twinAll, { "system.combatStyles.2.hp.value": 12 });
  assert.equal(twinAll.statuses.has("dead"), false, "healing one main removes DEFEATED (all)");
  record("4b. multi all (explicit policy): all sections are mains; partial destruction inert; recovery");
}

// ── 5. Multi-section none: all sections must be destroyed ────────────────────

{
  const blobNone = new MockMonsterActor("mc-f", "Blob (none)", {
    mainSectionPolicy: "none",
    combatStyles: [
      sectionRow("cs-1", "Mass A", 25),
      sectionRow("cs-2", "Mass B", 25),
      sectionRow("cs-3", "Mass C", 25)
    ]
  });
  await fireUpdateActor(blobNone, { "system.combatStyles.0.hp.value": 0 });
  assert.equal(blobNone.statuses.has("dead"), false, "one of three destroyed: active (none)");
  await fireUpdateActor(blobNone, { "system.combatStyles.1.hp.value": -2 });
  assert.equal(blobNone.statuses.has("dead"), false, "two of three destroyed: still active (none)");
  await fireUpdateActor(blobNone, { "system.combatStyles.2.hp.value": 0 });
  assert.equal(blobNone.statuses.has("dead"), true, "ALL sections destroyed incapacitates (none)");
  assert.equal(blobNone.toggleCalls.length, 1, "exactly one status write across all transitions");
  // Recovering any ONE section de-incapacitates.
  await fireUpdateActor(blobNone, { "system.combatStyles.1.hp.value": 8 });
  assert.equal(blobNone.statuses.has("dead"), false, "one healed section restores the monster (none)");
  record("5. multi none: partial destruction inert; all destroyed incapacitates; partial recovery removes");
}

// ── 6. Damage / heal / manual edits, flattened and nested ────────────────────

{
  const monster = new MockMonsterActor("mc-g", "Edit Hydra", {
    mainSectionPolicy: "any",
    combatStyles: [sectionRow("cs-1", "Body", 30, { isMainSection: true })]
  });
  // Nested (non-flattened) programmatic update.
  await fireUpdateActor(monster, { system: { combatStyles: [sectionRow("cs-1", "Body", 0, { isMainSection: true })] } });
  assert.equal(monster.statuses.has("dead"), true, "a nested whole-array update triggers the sync");
  assert.equal(monster.toggleCalls.length, 1, "single write");
  // Whole-array update (the sheet submit path) that changes nothing relevant.
  monster.toggleCalls.length = 0;
  await fireUpdateActor(monster, { "system.combatStyles": monster.system.combatStyles });
  assert.equal(monster.toggleCalls.length, 0, "an unchanged whole-array update writes nothing");
  // Manual heal via dotted path.
  await fireUpdateActor(monster, { "system.combatStyles.0.hp.value": 22 });
  assert.equal(monster.statuses.has("dead"), false, "manual dotted heal removes DEFEATED");
  record("6. damage/heal/manual edits through nested, whole-array and dotted updates");
}

// ── 7. No redundant writes and irrelevant updates ────────────────────────────

{
  const monster = new MockMonsterActor("mc-h", "Quiet Hydra", {
    mainSectionPolicy: "any",
    combatStyles: [sectionRow("cs-1", "Body", 0, { isMainSection: true })]
  });
  // Establish the defeated state first (one legitimate write).
  await fireUpdateActor(monster, { "system.combatStyles.0.hp.value": -1 });
  assert.equal(monster.statuses.has("dead"), true, "the destroyed main applied the status");
  assert.equal(monster.toggleCalls.length, 1, "one legitimate write to establish the state");
  monster.toggleCalls.length = 0;
  await fireUpdateActor(monster, { "system.combatStyles.0.hp.value": -2 });
  // Repeated explicit syncs: idempotent.
  await sync.syncSw25DefeatedStatus(monster);
  await sync.syncSw25DefeatedStatus(monster);
  assert.equal(monster.toggleCalls.length, 0, "repeated syncs write nothing");
  const result = await sync.syncSw25DefeatedStatus(monster);
  assert.equal(result.code, "in-sync");
  assert.equal(result.changed, false);
  record("7. no redundant writes; repeated syncs are pure 'in-sync' reads");
}

// ── 8. Policy change re-syncs without HP changes ─────────────────────────────

{
  const monster = new MockMonsterActor("mc-i", "Reclassified", {
    mainSectionPolicy: "none",
    combatStyles: [
      sectionRow("cs-1", "Body", 20),
      sectionRow("cs-2", "Tail", 0, { isMainSection: true })
    ]
  });
  // Marked main destroyed, policy none: only the ALL-sections condition counts.
  await fireUpdateActor(monster, { "system.combatStyles.1.hp.value": 0 });
  assert.equal(monster.statuses.has("dead"), false, "none: a destroyed marked main is not enough (Body alive)");
  // Policy switch alone flips the condition: the destroyed marked main now
  // incapacitates under `any` without any HP write.
  await monster.update({ "system.mainSectionPolicy": "any" });
  assert.equal(monster.statuses.has("dead"), true, "policy change to any re-applies DEFEATED without any HP write");
  await monster.update({ "system.mainSectionPolicy": "none" });
  assert.equal(monster.statuses.has("dead"), false, "policy change back to none removes DEFEATED");
  assert.equal(monster.updates.filter(update => "system.mainSectionPolicy" in update).length, 2, "exactly two policy updates");
  assert.equal(monster.updates.filter(update => "system.combatStyles" in update).length, 0, "no HP write happened for the re-sync");
  record("8. policy change re-syncs the condition without touching HP");
}

// ── 9. Existing monsters without any configuration: default any ──────────────

{
  const legacy = new MockMonsterActor("mc-j", "Legacy Import", {
    combatStyles: [
      sectionRow("cs-1", "Body", 30),
      sectionRow("cs-2", "Tail", 30, { isMainSection: true })
    ]
  });
  assert.equal(sectionState.resolveMonsterSectionPolicy(legacy.system).policy, "any");
  assert.equal(sectionState.resolveMonsterSectionPolicy(legacy.system).source, "default");
  await fireUpdateActor(legacy, { "system.combatStyles.1.hp.value": 0 });
  assert.equal(legacy.statuses.has("dead"), true, "legacy monster behaves as any (marked main at 0)");
  await fireUpdateActor(legacy, { "system.combatStyles.1.hp.value": 5 });
  assert.equal(legacy.statuses.has("dead"), false, "legacy monster recovers");
  record("9. existing monster without explicit config or recoverable type: any");
}

// ── 10. Non-numeric HP rows never count; empty section list is out of scope ──

{
  const weird = new MockMonsterActor("mc-k", "Placeholder Hydra", {
    mainSectionPolicy: "none",
    combatStyles: [
      { id: "cs-1", style: "Bite", section: "Head", hp: { value: "-", max: 40 }, isMainSection: true },
      sectionRow("cs-2", "Body", 0)
    ]
  });
  // The numeric row is destroyed. Placeholder rows ("-" HP) are NOT countable
  // sections: they can never be destroyed, and per the documented neutral
  // semantics they do not block the condition either — the condition counts
  // only HP-bearing sections (never a vacuous instant defeat: a monster with
  // zero countable sections is never incapacitated, never immortal).
  await fireUpdateActor(weird, { "system.combatStyles.1.hp.value": 0 });
  assert.equal(weird.statuses.has("dead"), true,
    "uncountable rows do not block the condition: the only countable section destroyed incapacitates (none)");
  const state = sectionState.readMonsterSectionState(weird.system);
  assert.equal(state.sections.length, 2, "rows are listed");
  assert.equal(state.mainSectionIndices.length, 0, "the placeholder main row is excluded from main counting");
  assert.equal(state.incapacitated, true, "only countable sections participate in the condition");

  const empty = new MockMonsterActor("mc-l", "No Sections", {});
  const result = await sync.syncSw25DefeatedStatus(empty);
  assert.equal(result.code, "no-hp", "a monster without sections is out of scope");
  assert.equal(empty.toggleCalls.length, 0, "no write for sectionless monsters");
  record("10. non-numeric rows never count; sectionless monsters are out of scope");
}

// ── 11. Pure readMonsterSectionState cases ───────────────────────────────────

{
  // Named multi-main with a count annotation recovered by name.
  const annotated = {
    mainSection: { type: "all", sourceValue: "Neck (All)", combatStyleIds: [] },
    combatStyles: [sectionRow("cs-1", "Body", 10), sectionRow("cs-2", "Neck x 7-9", 10)]
  };
  const annotatedState = sectionState.readMonsterSectionState(annotated);
  assert.equal(annotatedState.policy, "all", "(All) recovered");
  assert.deepEqual(annotatedState.mainSectionIndices, [1], "count annotations match by name");
  assert.equal(annotatedState.incapacitated, false);

  // Incomplete profile (multi rows, no main info): degrades to the
  // all-sections condition, never a vacuous instant defeat.
  const incomplete = {
    combatStyles: [sectionRow("cs-1", "Body", 10), sectionRow("cs-2", "Tail", 10)]
  };
  const incompleteState = sectionState.readMonsterSectionState(incomplete);
  assert.deepEqual(incompleteState.mainSectionIndices, [], "no main info: empty main set");
  assert.equal(incompleteState.incapacitated, false, "healthy sections: not incapacitated");
  incomplete.combatStyles[1].hp.value = 0;
  incomplete.combatStyles[0].hp.value = 0;
  assert.equal(sectionState.readMonsterSectionState(incomplete).incapacitated, true,
    "incomplete profile degrades to all-sections-destroyed, not instant defeat");

  // Negative HP never clamped by the derivation.
  const negative = { combatStyles: [sectionRow("cs-1", "Body", -7, { isMainSection: true })] };
  const negativeState = sectionState.readMonsterSectionState(negative);
  assert.equal(negativeState.sections[0].hp, -7, "raw negative HP preserved in the derived state");
  assert.equal(negativeState.sections[0].destroyed, true, "negative HP counts as destroyed");
  assert.equal(negativeState.incapacitated, true);
  record("11. pure derivation: named (All) recovery, incomplete profiles, negatives, placeholders");
}

// ── 11b. Special policy: special-rule resolution in the pure state ───────

{
  // Manual Resolution: the system never derives incapacitation from section
  // destruction — incapacitated is always false while sections stay readable.
  const manual = {
    mainSectionPolicy: "special",
    mainSectionSpecialRule: "manual",
    combatStyles: [sectionRow("cs-1", "Body", 0), sectionRow("cs-2", "Tail", 0)]
  };
  const manualState = sectionState.readMonsterSectionState(manual);
  assert.equal(manualState.policy, "special", "policy preserved");
  assert.equal(manualState.specialRule, "manual", "rule resolved");
  assert.equal(manualState.specialUnconfigured, false, "rule selected: not unconfigured");
  assert.equal(manualState.incapacitated, false, "Manual Resolution never auto-defeats");
  assert.deepEqual(manualState.sections.map(s => s.destroyed), [true, true], "both sections destroyed but still not incapacitated");

  // Special with NO selected rule: controlled unconfigured state (never
  // silently resolved as Any).
  const unconfigured = {
    mainSectionPolicy: "special",
    mainSectionSpecialRule: null,
    combatStyles: [sectionRow("cs-1", "Body", 0)]
  };
  const unconfiguredState = sectionState.readMonsterSectionState(unconfigured);
  assert.equal(unconfiguredState.specialRule, null, "no rule resolved");
  assert.equal(unconfiguredState.specialUnconfigured, true, "controlled unconfigured state exposed");
  assert.equal(unconfiguredState.incapacitated, false, "unconfigured special does not auto-defeat");

  // Special + Concealed Main Section with no injected selection degrades to
  // all-sections-destroyed (not instant defeat).
  const concealedEmpty = {
    mainSectionPolicy: "special",
    mainSectionSpecialRule: "concealedMainSection",
    combatStyles: [sectionRow("cs-1", "Body", 10), sectionRow("cs-2", "Tail", 10)]
  };
  const concealedState = sectionState.readMonsterSectionState(concealedEmpty);
  assert.equal(concealedState.specialRule, "concealedMainSection", "concealed rule resolved");
  assert.deepEqual(concealedState.mainSectionIndices, [], "no injected selection: empty main set");
  assert.equal(concealedState.incapacitated, false, "no selection: not instant defeat");

  // Special + Concealed Main Section with injected selection behaves like Any
  // (single selected section destroyed incapacitates).
  const concealedSelected = {
    mainSectionPolicy: "special",
    mainSectionSpecialRule: "concealedMainSection",
    combatStyles: [sectionRow("cs-1", "Body", 10), sectionRow("cs-2", "Tail", 0)]
  };
  const selectedState = sectionState.readMonsterSectionState(concealedSelected, {
    concealedSectionId: "cs-2"
  });
  assert.deepEqual(selectedState.mainSectionIndices, [1], "injected selection is THE main section");
  assert.equal(selectedState.incapacitated, true, "selected section destroyed: incapacitated (any-like)");

  // Stale ordinary main-section markers never leak into the special rule:
  // ordinary flags are ignored entirely under special + concealed rule.
  const staleFlags = {
    mainSectionPolicy: "special",
    mainSectionSpecialRule: "concealedMainSection",
    combatStyles: [sectionRow("cs-1", "Body", 0, { isMainSection: true })]
  };
  const staleState = sectionState.readMonsterSectionState(staleFlags, { concealedSectionId: "cs-1" });
  assert.deepEqual(staleState.mainSectionIndices, [0], "selection by id only, flags ignored");
  record("11b. special-rule resolution: Manual Resolution, unconfigured, concealed valid, stale flags ignored");
}

// ── 12. defeatedSyncRelevantChange contract ──────────────────────────────────

{
  assert.equal(sync.defeatedSyncRelevantChange({ "system.hp.value": 0 }), true, "character HP path");
  assert.equal(sync.defeatedSyncRelevantChange({ "system.combatStyles": [] }), true, "whole array");
  assert.equal(sync.defeatedSyncRelevantChange({ "system.combatStyles.0.hp.value": 5 }), true, "dotted section HP");
  assert.equal(sync.defeatedSyncRelevantChange({ "system.mainSectionPolicy": "all" }), true, "policy");
  assert.equal(sync.defeatedSyncRelevantChange({ "system.mainSection": { type: "all" } }), true, "import record");
  assert.equal(sync.defeatedSyncRelevantChange({ system: { combatStyles: [] } }), true, "nested whole array");
  // The REAL v14 hook delivers the nested expanded data diff — both the
  // policy and the imported Main Section record must react in that shape.
  assert.equal(sync.defeatedSyncRelevantChange({ system: { mainSectionPolicy: "all" } }), true, "nested policy (real hook shape)");
  assert.equal(sync.defeatedSyncRelevantChange({ system: { mainSection: { type: "all" } } }), true, "nested import record (real hook shape)");
  assert.equal(sync.defeatedSyncRelevantChange({ system: { combatStyles: [{ hp: { value: 0 } }] } }), true, "nested section HP array (real hook shape)");
  assert.equal(sync.defeatedSyncRelevantChange({ "system.mp.value": 3 }), false, "irrelevant MP update");
  assert.equal(sync.defeatedSyncRelevantChange({}), false, "empty change");
  assert.equal(sync.defeatedSyncRelevantChange(null), false, "null change");
  assert.equal(sync.defeatedSyncRelevantChange({ "system.combatStyles.0.hp.max": 50 }), false, "hp.max-only is irrelevant");
  assert.equal(sync.defeatedSyncRelevantChange({ system: { mp: { value: 3 } } }), false, "nested MP-only is irrelevant");
  record("12. defeatedSyncRelevantChange: all section-HP shapes react; unrelated paths ignore");
}

// ── 13. Combatant#isDefeated + REAL T5.3 engine with a monster ───────────────

{
  const monster = new MockMonsterActor("mc-m", "Engine Hydra", {
    mainSectionPolicy: "any",
    combatStyles: [
      sectionRow("cs-1", "Body", 40),
      sectionRow("cs-2", "Neck", 30, { isMainSection: true })
    ]
  });
  const combatant = new MockCombatant("cm-1", monster);
  const combat = new MockCombat([combatant]);
  const anchor = { combatantId: "cm-1", regime: "casterTurn", edge: "end", state: "resolved" };
  const anchorSnapshot = structuredClone(anchor);

  assert.equal(combatant.isDefeated, false, "healthy monster: not defeated");
  assert.deepEqual(engine.sw25AnchorAvailability(combat, anchor), { available: true, reason: null },
    "the engine sees an available anchored monster");

  // Destroy the MAIN section through the real hook.
  await fireUpdateActor(monster, { "system.combatStyles.1.hp.value": 0 });
  assert.equal(monster.statuses.has("dead"), true, "the sync applied the native status");
  assert.equal(combatant.isDefeated, true, "Combatant#isDefeated reads the native status");
  assert.deepEqual(engine.sw25AnchorAvailability(combat, anchor), { available: false, reason: "combatant-defeated" },
    "the engine degrades the anchor through the real isDefeated signal");
  assert.deepEqual(anchor, anchorSnapshot, "the anchor object is never touched");

  // Secondary still has HP; healing the main restores availability.
  await fireUpdateActor(monster, { "system.combatStyles.1.hp.value": 14 });
  assert.equal(combatant.isDefeated, false, "recovered monster: not defeated");
  assert.deepEqual(engine.sw25AnchorAvailability(combat, anchor), { available: true, reason: null },
    "healing restores availability through the same native signal");
  assert.deepEqual(anchor, anchorSnapshot, "the anchor survived both transitions untouched");
  record("13. T5.3 engine with a monster: degradation and restoration without engine changes");
}

// ── 15. Concealed Main Section (special): the ActiveEffect secret drives the same sync ──

{
  const artist = new MockConcealedActor("cs-a", "Cursed Artist", concealedSystem());
  assert.equal(sectionState.resolveMonsterSectionPolicy(artist.system).policy, "special", "special recovered from the import identification");
  assert.equal(sectionState.resolveMonsterSectionPolicy(artist.system).source, "derived");

  // No valid selection yet: the profile degrades to the all-sections
  // condition — destroying ONE section does not incapacitate.
  await fireSpecialSectionUpdate(artist, { "system.combatStyles.0.hp.value": 0 });
  assert.equal(artist.statuses.has("dead"), false, "no selection: degraded, not defeated");
  assert.equal(artist.toggleCalls.length, 0, "the degraded state writes nothing");

  // GM assigns the hidden role through the concealed module (dialog path).
  const assigned = await concealed.setConcealedMainSectionSelection(artist, "Musician");
  assert.equal(assigned.section, "Musician");
  await flushQueuedSync();
  assert.equal(artist.statuses.has("dead"), true, "the destroyed hidden main incapacitates after the assignment");
  assert.equal(artist.toggleCalls.length, 1, "exactly one status write from the queued re-sync");

  // Privacy: the secret lives ONLY in the ActiveEffect flags. No actor
  // system field, no actor flag carries the section name.
  assert.equal(artist.system.concealedMainSection, undefined, "no system field carries the secret");
  assert.equal(artist.system.mainSection.type, "special", "the import identification is untouched");
  assert.equal(JSON.stringify(artist.flags).includes("Musician"), false, "the actor flag carries no section name");
  const concealedEffects = artist.effects.filter(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section");
  assert.equal(concealedEffects.length, 1, "exactly one concealed effect on the actor");
  assertConcealedRecord(concealedEffects[0], "cs-musician");

  // Non-GM callers receive nothing through either selection reader.
  isGM = false;
  assert.equal(await concealed.getConcealedMainSectionSelection(artist), null, "non-GM selection read is null");
  await assert.rejects(concealed.setConcealedMainSectionSelection(artist, "Instrument"), /Only a GM/, "non-GM assignment refused");
  isGM = true;

  // Healing the hidden main restores the monster.
  await fireSpecialSectionUpdate(artist, { "system.combatStyles.0.hp.value": 60 });
  assert.equal(artist.statuses.has("dead"), false, "healing the hidden main removes DEFEATED");

  // Re-selection re-syncs: switch the secret to the other (alive) section.
  await concealed.setConcealedMainSectionSelection(artist, "Instrument");
  await flushQueuedSync();
  assert.equal(artist.statuses.has("dead"), false, "the new hidden main is alive: not defeated");
  const concealedEffects2 = artist.effects.filter(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section");
  assert.equal(concealedEffects2.length, 1, "re-selection keeps exactly one effect (replaced, not duplicated)");
  assertConcealedRecord(concealedEffects2[0], "cs-instrument");
  // Destroy the new hidden main: DEFEATED again.
  await fireSpecialSectionUpdate(artist, { "system.combatStyles.1.hp.value": 0 });
  assert.equal(artist.statuses.has("dead"), true, "the new hidden main destroyed incapacitates");
  record("15. special policy: degradation without selection, secret destroyed defeats, re-selection re-syncs");
}

// ── 16. Special: secondary destruction inert; recovery; per-token flow ──────

{
  const artist = new MockConcealedActor("cs-b", "Cursed Artist Two", concealedSystem());
  await concealed.setConcealedMainSectionSelection(artist, "Instrument");
  await flushQueuedSync();
  assert.equal(artist.statuses.has("dead"), false, "healthy secret: active");

  // Destroying the SECONDARY section is inert.
  await fireSpecialSectionUpdate(artist, { "system.combatStyles.0.hp.value": 0 });
  assert.equal(artist.statuses.has("dead"), false, "secondary destroyed: active");
  assert.equal(artist.toggleCalls.length, 0, "secondary destruction writes nothing");

  // Destroying the SECRET section incapacitates; negatives preserved.
  await fireSpecialSectionUpdate(artist, { "system.combatStyles.1.hp.value": -4 });
  assert.equal(artist.statuses.has("dead"), true, "the hidden main destroyed incapacitates");
  assert.equal(artist.system.combatStyles[1].hp.value, -4, "negative hidden-main HP preserved");
  // Recovery.
  await fireSpecialSectionUpdate(artist, { "system.combatStyles.1.hp.value": 40 });
  assert.equal(artist.statuses.has("dead"), false, "healing the hidden main restores the monster");
  record("16. special: secondary destruction inert; negative HP preserved; recovery");

  // A placed token ADOPTS the actor-level assignment (no fresh random pick).
  const adopter = new MockConcealedActor("cs-c", "Adopting Artist", concealedSystem());
  await concealed.setConcealedMainSectionSelection(adopter, "Instrument");
  const adoptToken = makeConcealedToken(adopter, "cs-c-t1");
  adopter.tokens.push(adoptToken);
  // Token adoption: the actor-level assignment is what the DEFEATED sync
  // reads (via actor.effects), not a per-token record. The token carries no
  // concealed selection of its own.
  assert.equal(adopter.effects.filter(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section").length, 1,
    "the actor carries exactly one concealed effect");
  assertConcealedRecord(
    adopter.effects.find(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section"),
    "cs-instrument"
  );

  // Without an actor-level assignment, the DEFEATED sync degrades: no
  // concealed effect → special degrades to all-sections condition.
  const wild = new MockConcealedActor("cs-d", "Wild Artist", concealedSystem());
  const wildResult = await sync.syncSw25DefeatedStatus(wild);
  assert.equal(wildResult.code, "in-sync", "no concealed effect: degraded, no write");
  assert.equal(wild.toggleCalls.length, 0, "the degraded read writes nothing");
  record("16b. token adoption, per-token fallback absent (ActiveEffect is actor-level), malformed-record degradation");
}

// ── 17. Special: pure derivation with injected selections ────────────────────

{
  const system = {
    mainSection: { type: "special", sourceValue: "Special" },
    combatStyles: [sectionRow("cs-musician", "Musician", 115), sectionRow("cs-instrument", "Instrument", 106)]
  };
  assert.deepEqual(sectionState.MAIN_SECTION_POLICIES, ["any", "all", "none", "special"], "special joined the approved vocabulary");

  // No selection: empty main set, degraded condition.
  let state = sectionState.readMonsterSectionState(system);
  assert.equal(state.policy, "special");
  assert.deepEqual(state.mainSectionIndices, [], "no selection: empty main set");
  assert.equal(state.incapacitated, false, "degraded and healthy: not incapacitated");

  // By name and by stable id.
  state = sectionState.readMonsterSectionState(system, { concealedSectionName: "Musician" });
  assert.deepEqual(state.mainSectionIndices, [0], "name matching");
  state = sectionState.readMonsterSectionState(system, { concealedSectionId: "cs-instrument" });
  assert.deepEqual(state.mainSectionIndices, [1], "id matching");
  state = sectionState.readMonsterSectionState(system, { concealedSectionName: "Guitar" });
  assert.deepEqual(state.mainSectionIndices, [], "an unknown section never matches");

  // Destroy the secret section: incapacitated through the selection alone.
  system.combatStyles[0].hp.value = 0;
  state = sectionState.readMonsterSectionState(system, { concealedSectionName: "Musician" });
  assert.equal(state.incapacitated, true, "the destroyed secret section incapacitates");
  assert.equal(state.sections[0].hp, 0, "raw HP untouched by the derivation");

  // With BOTH destroyed and no selection: the degraded all-sections condition.
  system.combatStyles[1].hp.value = -2;
  assert.equal(sectionState.readMonsterSectionState(system).incapacitated, true,
    "no selection, all sections destroyed: the degraded condition holds");
  system.combatStyles[0].hp.value = 20;
  assert.equal(sectionState.readMonsterSectionState(system).incapacitated, false,
    "no selection, one section alive: the degraded condition does not hold");
  record("17. pure derivation: special policy selection injection and degradation");
}

// ── 18. Special ↔ normal policy switches preserve the secret record ──────────

{
  const artist = new MockConcealedActor("cs-f", "Switching Artist", concealedSystem());
  await concealed.setConcealedMainSectionSelection(artist, "Musician");
  const effectId = artist.effects.find(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section")?.id;

  // Switch to a normal policy: the secret effect survives untouched, and the
  // GM-only reader still reports it (the policy dialog uses that to preview
  // the preserved assignment). The SYNC is what ignores the secret under a
  // normal policy — it never consults the selection unless the resolved
  // policy is special.
  await artist.update({ "system.mainSectionPolicy": "any" });
  const persisted = artist.effects.find(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section");
  assert.ok(persisted, "switching away keeps the concealed effect");
  assert.equal((await concealed.getConcealedMainSectionSelection(artist))?.section, "Musician",
    "the preserved assignment stays readable by the GM (dialog preview)");

  // Proof the sync ignores the secret under `any`: destroying the HIDDEN
  // section does not incapacitate (no flagged rows → degraded all-sections
  // condition; the other section is alive).
  await fireSpecialSectionUpdate(artist, { "system.combatStyles.0.hp.value": 0 });
  assert.equal(artist.statuses.has("dead"), false, "policy any: the sync does not consult the secret");
  assert.equal(artist.toggleCalls.length, 0, "policy any: the ignored secret writes nothing");

  // Reactivate Special: restore the previously selected rule (concealed
  // Main Section, which was activated earlier) without generating a new
  // selection; the SAME effect is reused (no duplicate effect).
  await artist.update({ "system.mainSectionPolicy": "special", "system.mainSectionSpecialRule": "concealedMainSection" });
  const persisted2 = artist.effects.find(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section");
  assert.equal(persisted2?.id, effectId, "the original effect id is preserved (single stable identity)");
  const concealedCount = artist.effects.filter(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section").length;
  assert.equal(concealedCount, 1, "no duplicate effect was created");
  assert.equal((await concealed.getConcealedMainSectionSelection(artist)).section, "Musician",
    "the assignment is recoverable on re-activation");
  await flushQueuedSync();
  // The recovered secret immediately drives the condition again: that very
  // section is destroyed, so DEFEATED returns without any further HP write.
  assert.equal(artist.statuses.has("dead"), true, "the recovered secret drives DEFEATED again");
  assert.equal(artist.toggleCalls.length, 1, "re-activation wrote the status once");
  record("18. special ↔ normal switches preserve the secret; re-activation reuses the effect");
}

// ── 19. Plaintext record in a GM-only effect: stability, stateless reload ────

{
  const artist = new MockConcealedActor("cs-g", "Stable Artist", concealedSystem());
  const first = await concealed.setConcealedMainSectionSelection(artist, "Musician");
  const effect = artist.effects.find(e => e.type === "sw25Effect" && e.system?.family === "Concealed Main Section");
  assertConcealedRecord(effect, "cs-musician");
  // The record is PLAINTEXT by design (the agreed presentation trade-off);
  // the hiding happens at the interface layer through `system.gmOnly`.
  assert.equal(effect.flags["sw25-taka"].concealedSection.sectionId, "cs-musician",
    "the record is readable plaintext (no ciphertext, no key state to maintain)");

  // Repeated calls return the existing selection: no reroll, no new effect.
  const idBefore = effect.id;
  const again = await concealed.selectConcealedMainSection(artist);
  assert.deepEqual(again, first, "re-select returns the stable selection");
  assert.equal(artist.effects.find(e => e.type === "sw25Effect" && e.system?.family === "Concealed Main Section").id, idBefore,
    "re-select creates no new effect");

  // "Reload": the reader is stateless now — there is no key cache to
  // rebuild; the same read resolves the same selection anywhere, on any
  // browser, in any session.
  assert.equal((await concealed.getConcealedMainSectionSelection(artist)).sectionId, first.sectionId,
    "the selection survives a reload without any key state");
  record("19. plaintext record in a GM-only effect, stable re-selection, stateless reload");
}

// ── 20. GM-only presentation: players never see the effect through our UI ────

{
  const artist = new MockConcealedActor("cs-h", "Presentation Artist", concealedSystem());
  const assigned = await concealed.setConcealedMainSectionSelection(artist, "Instrument");

  // The effect document is GM-only in the system's presentation model.
  const effect = artist.effects.find(e => e.type === "sw25Effect" && e.system?.family === "Concealed Main Section");
  assert.equal(effect.system.gmOnly, true, "the concealed effect is created gmOnly");

  // Player view: the selection reader returns null...
  isGM = false;
  assert.equal(await concealed.getConcealedMainSectionSelection(artist), null,
    "a player never reads the selection through the module");
  await assert.rejects(concealed.setConcealedMainSectionSelection(artist, "Musician"), /Only a GM/,
    "a player cannot change the selection");
  // ...and the tab row preparation hides the effect from players while the
  // GM view lists it (presentation filtering only).
  const playerRows = effectsTab.prepareSw25EffectRows([...artist.effects]);
  assert.equal(playerRows.rows.some(row => row.id === effect.id), false,
    "gmOnly effects are absent from the player-facing rows");
  const gmRows = effectsTab.prepareSw25EffectRows([...artist.effects], null, { includeGmOnly: true });
  assert.equal(gmRows.rows.some(row => row.id === effect.id), true,
    "the GM view lists the gmOnly effect");
  // The sync presentation read is GM-gated identically: a player caller
  // receives "none" without reading anything (no sheet label can ever reach
  // a player render).
  const playerPresentation = concealed.getConcealedMainSectionPresentation(artist);
  assert.equal(playerPresentation.status, "none", "the sync presentation reads as none for players");
  isGM = true;

  // GM sync presentation: the assigned state carries the readable section,
  // the effect id (to attach the label onto the right row) and no error.
  const gmPresentation = concealed.getConcealedMainSectionPresentation(artist);
  assert.deepEqual(
    { status: gmPresentation.status, section: gmPresentation.section, sectionId: gmPresentation.sectionId, effectId: gmPresentation.effectId, code: gmPresentation.code },
    { status: "assigned", section: "Instrument", sectionId: assigned.sectionId, effectId: effect.id, code: null },
    "the GM sync presentation reports the assigned selection"
  );
  // Explicit error states surface as data (never thrown, never fallback):
  // malformed/legacy record and removed section.
  const broken = new MockConcealedActor("cs-q", "Broken Presentation Artist", concealedSystem());
  await broken.createEmbeddedDocuments("ActiveEffect", [{
    type: "sw25Effect",
    name: "Concealed Main Section",
    system: { family: "Concealed Main Section", rank: 0 },
    flags: { "sw25-taka": { concealedSection: { v: 1, keyId: "k", iv: "i", ct: "c" } } }
  }]);
  const brokenPresentation = concealed.getConcealedMainSectionPresentation(broken);
  assert.equal(brokenPresentation.status, "error", "a legacy encrypted record is an explicit error state");
  assert.equal(brokenPresentation.code, "record-invalid", "the legacy encrypted record reports record-invalid");
  assert.ok(brokenPresentation.message, "the error carries a GM-facing message");
  await assert.rejects(concealed.getConcealedMainSectionSelection(broken), /malformed/,
    "the async reader keeps throwing the explicit error (now through the presentation core)");

  // Backward compatibility: an effect WITHOUT the gmOnly field (or with the
  // schema initial false) stays visible to everyone.
  const plain = new MockConcealedActor("cs-p", "Plain Effect Artist", concealedSystem());
  await plain.createEmbeddedDocuments("ActiveEffect", [{
    type: "sw25Effect",
    name: "Plain",
    system: { family: "Plain Family", rank: 0 },
    flags: {}
  }]);
  assert.equal(effectsTab.prepareSw25EffectRows([...plain.effects]).rows.length, 1,
    "an effect without the gmOnly field is visible in the player view (backward compatible)");

  // The documents themselves are never removed or hidden from the
  // collection: GM-side mechanical consumers keep working normally.
  assert.equal(artist.effects.filter(e => e.type === "sw25Effect" && e.system?.family === "Concealed Main Section").length, 1,
    "gmOnly filtering never touches the underlying document collection");
  assert.ok(assigned.sectionId, "the selection stays resolvable for the GM");
  record("20. GM-only presentation: player rows hide the effect, GM rows list it, documents untouched");
}

// ── 21. Candidate config persisted through a REAL actor update ───────────────

{
  const artist = new MockConcealedActor("cs-j", "Configuring Artist", concealedSystem());
  artist.system.combatStyles.push(sectionRow("cs-guitar", "Guitar", 90)); // 3 sections so one exclusion keeps 2
  assert.equal(artist.updates.length, 0, "no updates yet");
  const config = await concealed.setConcealedMainSectionConfig(artist, { excluded: ["cs-instrument"] });
  assert.deepEqual(config, { version: 1, excluded: ["cs-instrument"] });
  assert.deepEqual(artist.system.concealedMainSectionConfig, config, "the config reached the actor system data");
  assert.equal(artist.updates.length, 1, "exactly one persisted update");
  assert.ok("system.concealedMainSectionConfig" in artist.updates[0], "the update carries the config key");
  // Changing config does not touch an existing selection effect.
  await concealed.setConcealedMainSectionSelection(artist, "Musician");
  const effectId = artist.effects.find(e => e.type === "sw25Effect" && e.system?.family === "Concealed Main Section")?.id;
  await concealed.setConcealedMainSectionConfig(artist, { excluded: [] });
  assert.equal(artist.effects.find(e => e.type === "sw25Effect" && e.system?.family === "Concealed Main Section")?.id, effectId,
    "a config change never rerolls the existing selection");
  // Below-minimum config is rejected without writing.
  await assert.rejects(concealed.setConcealedMainSectionConfig(artist, { excluded: ["cs-musician", "cs-instrument"] }),
    /At least 2 candidate sections/);
  assert.equal(artist.updates.length, 2, "the rejected attempt wrote nothing");
  record("21. candidate config persisted through a real actor update; validation intact; no reroll");
}

// ── 22. Legacy marker recovery; transplanted records fail authentication ─────

{
  // A pre-cipher marker effect (flags without a record) reads as "no valid
  // selection" (controlled state) and an explicit selection replaces it.
  const legacy = new MockConcealedActor("cs-k", "Legacy Artist", concealedSystem());
  await legacy.createEmbeddedDocuments("ActiveEffect", [{
    type: "sw25Effect",
    name: "Concealed Main Section",
    system: { family: "Concealed Main Section", rank: 0 },
    flags: {}
  }]);
  assert.equal(await concealed.getConcealedMainSectionSelection(legacy), null,
    "legacy marker: no valid selection (controlled state)");
  const assigned = await concealed.setConcealedMainSectionSelection(legacy, "Musician");
  assert.ok(assigned, "an explicit selection replaces the legacy marker");
  assert.equal(legacy.effects.filter(e => e.type === "sw25Effect" && e.system?.family === "Concealed Main Section").length, 1,
    "the legacy marker was replaced, not duplicated");

  // A record transplanted onto another actor is validated against the
  // VICTIM's own candidates: a section id that matches none of its
  // candidate sections is the explicit "selection-invalid" state, and the
  // DEFEATED sync refuses to evaluate instead of degrading silently.
  // (Section ids are public monster data; a record transplanted between
  // identical section layouts WOULD resolve — the accepted presentation-
  // boundary trade-off of the plaintext storage.)
  const sourceActor = new MockConcealedActor("cs-l", "Source Artist", concealedSystem());
  await concealed.setConcealedMainSectionSelection(sourceActor, "Musician");
  const stolenRecord = structuredClone(
    sourceActor.effects.find(e => e.type === "sw25Effect" && e.system?.family === "Concealed Main Section")
      .flags["sw25-taka"].concealedSection
  );
  const victimSystem = concealedSystem();
  victimSystem.combatStyles = [sectionRow("vx-head", "Head", 30), sectionRow("vx-torso", "Torso", 40)];
  const victim = new MockConcealedActor("cs-m", "Victim Artist", victimSystem);
  await victim.createEmbeddedDocuments("ActiveEffect", [{
    type: "sw25Effect",
    name: "Concealed Main Section",
    system: { family: "Concealed Main Section", rank: 0 },
    flags: { "sw25-taka": { concealedSection: stolenRecord } }
  }]);
  await assert.rejects(concealed.getConcealedMainSectionSelection(victim), /no longer valid/i,
    "a transplanted record fails the candidate validation");
  const victimSync = await sync.syncSw25DefeatedStatus(victim);
  assert.equal(victimSync.code, "concealed-selection-unavailable", "transplanted record: the sync refuses to evaluate");
  record("22. legacy marker recovery; transplanted records fail the candidate validation");
}

// ── 14. Authority: non-GM sync is refused ────────────────────────────────────

{
  const monster = new MockMonsterActor("mc-n", "Player View", {
    combatStyles: [sectionRow("cs-1", "Body", 0, { isMainSection: true })]
  });
  isGM = false;
  const result = await sync.syncSw25DefeatedStatus(monster);
  isGM = true;
  assert.equal(result.code, "not-gm", "non-GM callers are refused");
  assert.equal(monster.toggleCalls.length, 0, "non-GM sync never writes");
  record("14. non-GM: refused without writes (same authority contract)");
}

console.log("monster-defeated.test.mjs: all multi-section DEFEATED sync assertions passed.");
