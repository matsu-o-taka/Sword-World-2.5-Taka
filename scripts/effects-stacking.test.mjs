// Sword World 2.5 - central stacking resolver + EffectService integration
// test suite (Bloque 4: T4.1/T4.2/T4.4).
//
// Exercises module/effects/stacking-resolver.mjs (the versioned central
// resolver and its seven registered policies) and the write semantics of
// module/effects/effect-service.mjs `apply` in a single headless process,
// plus the relay transport of the new Bloque 4 fields.
//
// Scope: family-only stacking identity (DEC-1/16/44), rank as hierarchy,
// sourceType as metadata, derived canonical name (never persisted), the
// explicit outcomes (accumulate/replace/refused/choice-required/unresolved),
// the duration merge (DEC-4/DEC-18, incomparable → GM decision), every
// approved policy case (spell/feat/technique/stratagem/spellsong/aspect/
// weaponEnchant, DEC-19/DEC-20/DEC-21), write integrity (no write before the
// decision, refusal without state changes, create-then-delete replacement
// with rollback, no partial replacements, duplicate memoization), GM
// authority and no-regression (Bloque 2 behavior, foreign subtypes, reads
// without GM).
//
// Bloque 5 (durations/anchors/expiry), the spatial contracts (Bloque 6) and
// the declaration-layer validation (§56.1 item 21) are OUT of scope.

import assert from "node:assert/strict";

// ── Global Foundry environment mock (before any effect-module import) ──────

const notifications = [];
const socketEmissions = [];
const socketListeners = [];
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
    this.duration = data.duration ?? null;
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
    this.deleteCalls = [];
    this.failDeleteCalls = 0;
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
    if (this.failDeleteCalls > 0) {
      this.failDeleteCalls -= 1;
      throw new Error("delete failed (mock)");
    }
    // Real-Foundry semantics: the embedded-collection name ("ActiveEffect")
    // selects the collection; the ids select the documents (any subtype).
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
        const receiver = payload.gid ? game.users.get(payload.gid) : null;
        if (!receiver?.isGM) return;
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

const resolverModule = await import("../module/effects/stacking-resolver.mjs");
const service = await import("../module/effects/effect-service.mjs");
const relay = await import("../module/effects/effect-relay.mjs");
const effectsTab = await import("../module/effects/effects-tab.mjs");
const { normalizeSw25EffectSystem } = await import("../module/effects/effect-repair.mjs");
const { buildSw25CanonicalName } = await import("../module/effects/effect-identity.mjs");

const {
  resolveSw25Stacking,
  SW25_STACKING_RESOLVER_VERSION,
  SW25_STACKING_OUTCOMES,
  registerSw25StackingPolicy,
  listSw25StackingPolicies
} = resolverModule;
const {
  applySw25Effect,
  registerSw25StackingResolver,
  initializeEffectService
} = service;

// Production wiring equivalent (sw25.mjs init): the suite exercises the REAL
// resolver through the service.
registerSw25StackingResolver(resolveSw25Stacking);
initializeEffectService();

gameUsers.push(
  { id: "gm-user", _id: "gm-user", isGM: true, active: true, name: "GameMaster" },
  { id: "player-1", _id: "player-1", isGM: false, active: true, name: "Player One" }
);

const record = label => console.log(`  ${label}`);

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeEffect({
  family,
  rank = 0,
  successValue = 0,
  initialDuration = null,
  remainingDuration = null,
  familyPolicy = null,
  damageType = null,
  duration = null,
  disabled = false,
  casterUUID = null
} = {}) {
  return new MockEffect({
    type: "sw25Effect",
    name: buildSw25CanonicalName(family, rank) ?? family,
    duration,
    disabled,
    system: {
      schemaVersion: 1,
      family,
      rank,
      successValue,
      initialDuration,
      remainingDuration,
      casterUUID,
      effectType: null,
      familyPolicy,
      damageType,
      changes: []
    }
  });
}

function applyPayload(overrides = {}) {
  return { family: "Protection", rank: 2, cast: { successValue: 7 }, ...overrides };
}

const { SW25_EFFECT_SUBTYPE } = effectsTab;

// ── 1. Resolver contract and stacking identity (DEC-1/DEC-16/DEC-44) ───────

{
  assert.equal(SW25_STACKING_RESOLVER_VERSION, 1);
  assert.deepEqual(listSw25StackingPolicies().sort(), [
    "aspect", "feat", "spell", "spellsong", "stratagem", "technique", "weaponEnchant"
  ]);
  for (const outcome of ["accumulate", "replace", "refused", "choice-required", "unresolved"]) {
    assert.ok(SW25_STACKING_OUTCOMES.includes(outcome), `missing approved outcome: ${outcome}`);
  }
  record("resolver version 1, seven registered policies, approved outcomes");

  // Family is the ONLY identity: case and diacritics normalize (DEC-1 key).
  const actor1 = new MockActor("a1", "Target");
  actor1.effects.push(makeEffect({ family: "Protection", rank: 2 }));
  const decision1 = resolveSw25Stacking({
    actor: actor1,
    application: applyPayload({ family: "  protection  " }),
    existing: [...actor1.effects]
  });
  assert.equal(decision1.outcome, "choice-required");
  assert.equal(decision1.policy, "spell");
  assert.equal(decision1.code, "same-family-recast");
  record("family identity: case/padding insensitive, same family detected");

  const decision1b = resolveSw25Stacking({
    actor: actor1,
    application: applyPayload({ family: "Protéction" }),
    existing: [...actor1.effects]
  });
  assert.equal(decision1b.outcome, "choice-required");
  record("family identity: diacritic-insensitive (DEC-1 normalization)");

  // Rank is hierarchy, never identity (DEC-16): II vs III still one family.
  // Presentation keeps the authored case of each application (DEC-1: only the
  // comparison key loses case/diacritics); rank 2 vs 2 here because the
  // fixture reuse, not an identity rule.
  assert.equal(decision1.choice.existing[0].name, "Protection II");
  assert.equal(decision1.choice.incoming.name, "protection II");
  assert.equal(decision1.choice.field, "acceptReplace");
  assert.ok(Array.isArray(decision1.replaceIds));
  record("canonical name derived in choice data; rank never an identity");

  // Provenance metadata never participates (DEC-1): different caster/origin,
  // same family → still the same stacking family.
  const actor2 = new MockActor("a2", "Target");
  actor2.effects.push(makeEffect({ family: "Protection", rank: 1, casterUUID: "Actor.other" }));
  const decision2 = resolveSw25Stacking({
    actor: actor2,
    application: applyPayload({ rank: 3 }),
    existing: [...actor2.effects]
  });
  assert.equal(decision2.outcome, "choice-required");
  record("casterUUID/sourceType are metadata, not identity (DEC-1)");

  // Different family → accumulate (DEC-2).
  const decision3 = resolveSw25Stacking({
    actor: actor1,
    application: applyPayload({ family: "Haste" }),
    existing: [...actor1.effects]
  });
  assert.equal(decision3.outcome, "accumulate");
  assert.equal(decision3.code, "different-family-accumulate");
  record("different family accumulates by default (DEC-2)");

  // Unknown policy id → explicit unresolved; nothing is invented (DEC-44).
  const decision4 = resolveSw25Stacking({
    actor: actor1,
    application: applyPayload({ family: "Haste", familyPolicy: "mystery" }),
    existing: []
  });
  assert.equal(decision4.outcome, "unresolved");
  assert.equal(decision4.code, "stacking-policy-unregistered");
  record("unregistered familyPolicy → unresolved, no silent outcome");

  // No familyPolicy on the application → the DEC-3 default ("spell").
  const decision5 = resolveSw25Stacking({
    actor: new MockActor("a3", "Target"),
    application: applyPayload({ family: "Haste", familyPolicy: undefined }),
    existing: []
  });
  assert.equal(decision5.policy, "spell");
  record("absent familyPolicy defaults to spell (DEC-3)");

  // No duplicated identity fields are persisted (DEC-49): the approved v1
  // normalizer flags stackKey/familyKey/canonicalName as foreign.
  const foreign = normalizeSw25EffectSystem({
    schemaVersion: 1, family: "Protection", rank: 1, successValue: 0,
    initialDuration: null, remainingDuration: null, casterUUID: null, effectType: null,
    changes: [], stackKey: "protection", familyKey: "protection", canonicalName: "Protection I"
  });
  assert.ok(foreign.issues.some(issue => issue.code === "unknown-fields"));
  record("stackKey/familyKey/canonicalName stay foreign to the schema (DEC-49)");
}

// ── 2. Duration merge (DEC-4/DEC-18) and comparability ──────────────────────

{
  // The tabulated DEC-4 examples, in the round bookkeeping scale (DEC-23):
  // the tabulated minutes are the GM-tracked alternative, resolved below.
  const existing = [makeEffect({ family: "Protection", rank: 1, initialDuration: 5, remainingDuration: 2 })];

  const more = resolveSw25Stacking({
    actor: new MockActor("d1", "T"),
    application: applyPayload({ rank: 2, initialDuration: 3, remainingDuration: 3 }),
    existing
  });
  assert.equal(more.outcome, "choice-required");
  assert.deepEqual(more.durations, { initialDuration: 3, remainingDuration: 3 });
  record("DEC-4 case 1: new duration 3 > remaining 2 → 3");

  const less = resolveSw25Stacking({
    actor: new MockActor("d2", "T"),
    application: applyPayload({ rank: 2, initialDuration: 1, remainingDuration: 1 }),
    existing
  });
  assert.equal(less.outcome, "choice-required");
  assert.deepEqual(less.durations, { initialDuration: 2, remainingDuration: 2 });
  record("DEC-4 case 2: new duration 1 < remaining 2 → 2 remaining");

  const incomparable1 = resolveSw25Stacking({
    actor: new MockActor("d3", "T"),
    application: applyPayload({ rank: 2, initialDuration: 2, remainingDuration: 2 }),
    existing: [makeEffect({ family: "Protection", rank: 1, remainingDuration: null })]
  });
  assert.equal(incomparable1.outcome, "unresolved");
  assert.equal(incomparable1.code, "duration-incomparable-gm");
  record("round-managed vs GM-tracked → unresolved for the GM (DEC-4/32)");

  const incomparable2 = resolveSw25Stacking({
    actor: new MockActor("d4", "T"),
    application: applyPayload({ rank: 2, initialDuration: null, remainingDuration: null }),
    existing
  });
  assert.equal(incomparable2.outcome, "unresolved");
  assert.equal(incomparable2.code, "duration-incomparable-gm");
  record("GM-tracked new vs round-managed previous → unresolved as well");

  const bothGm = resolveSw25Stacking({
    actor: new MockActor("d5", "T"),
    application: applyPayload({ rank: 2, initialDuration: null, remainingDuration: null }),
    existing: [makeEffect({ family: "Protection", rank: 1, remainingDuration: null })]
  });
  assert.equal(bothGm.outcome, "choice-required");
  assert.deepEqual(bothGm.durations, { initialDuration: null, remainingDuration: null });
  record("both sides GM-tracked → no comparable scale, own durations kept");
}

// ── 3. Policies: normative cases (DEC-19/DEC-20/DEC-21) ─────────────────────

// 3a. Combat Feats (DEC-19): persistence coexists; declaration is per-action.
{
  const existing = [
    makeEffect({ family: "Power Attack", rank: 1, familyPolicy: "feat" }),
    makeEffect({ family: "Power Attack", rank: 1, familyPolicy: "feat", casterUUID: "Actor.x" })
  ];
  const same = resolveSw25Stacking({
    actor: new MockActor("f1", "T"),
    application: applyPayload({ family: "Power Attack", familyPolicy: "feat", rank: 0 }),
    existing
  });
  assert.equal(same.outcome, "accumulate");
  record("feat: same-family applications coexist (DEC-19 last bullet)");

  const other = resolveSw25Stacking({
    actor: new MockActor("f2", "T"),
    application: applyPayload({ family: "Shield Bash", familyPolicy: "feat" }),
    existing
  });
  assert.equal(other.outcome, "accumulate");
  record("feat: different families combine (DEC-19)");
}

// 3b. Enhancer Techniques (DEC-19).
{
  const existing = [makeEffect({ family: "Earth Binding", familyPolicy: "technique", rank: 1, remainingDuration: 3 })];
  const other = resolveSw25Stacking({
    actor: new MockActor("t1", "T"),
    application: applyPayload({ family: "Flame Break", familyPolicy: "technique" }),
    existing
  });
  assert.equal(other.outcome, "accumulate");
  record("technique: different techniques coexist (DEC-19)");

  const same = resolveSw25Stacking({
    actor: new MockActor("t2", "T"),
    application: applyPayload({ family: "Earth Binding", familyPolicy: "technique", initialDuration: 2, remainingDuration: 2 }),
    existing
  });
  assert.equal(same.outcome, "replace");
  assert.equal(same.code, "same-technique-overwrite");
  assert.deepEqual(same.durations, { initialDuration: 3, remainingDuration: 3 });
  assert.deepEqual(same.replaceIds, [existing[0].id]);
  record("technique: a technique does not stack with itself → deterministic replace");

  const dragonTail = resolveSw25Stacking({
    actor: new MockActor("t3", "T"),
    application: applyPayload({ family: "Dragon Tail", familyPolicy: "technique" }),
    existing: [makeEffect({ family: "Dragon Tail", familyPolicy: "technique" })]
  });
  assert.equal(dragonTail.outcome, "accumulate");
  assert.equal(dragonTail.code, "technique-accumulable-family");
  record("technique: express accumulation exception (Dragon Tail, DEC-19)");
}

// 3c. Tactician Stratagems (DEC-19).
{
  const existing = [makeEffect({ family: "Shield Formation", familyPolicy: "stratagem", rank: 1, remainingDuration: 4 })];
  const choice = resolveSw25Stacking({
    actor: new MockActor("s1", "T"),
    application: applyPayload({ family: "Arrow Rain", familyPolicy: "stratagem", initialDuration: 5, remainingDuration: 5 }),
    existing
  });
  assert.equal(choice.outcome, "choice-required");
  assert.equal(choice.code, "single-active-stratagem");
  assert.deepEqual(choice.replaceIds, [existing[0].id]);
  assert.equal(choice.durations, null); // the accepted new keeps ITS OWN duration
  assert.equal(choice.choice.incoming.family, "Arrow Rain");
  record("stratagem: one active strategy → the character chooses (DEC-19)");

  const none = resolveSw25Stacking({
    actor: new MockActor("s2", "T"),
    application: applyPayload({ family: "Arrow Rain", familyPolicy: "stratagem" }),
    existing: []
  });
  assert.equal(none.outcome, "accumulate");
  record("stratagem: nothing active → accumulate");
}

// 3d. Bard Spellsongs (DEC-19/DEC-21) — Actor-level scope (spatial → Bloque 6).
{
  const active = [
    makeEffect({ family: "Song of Lullaby", familyPolicy: "spellsong", successValue: 9, rank: 1, remainingDuration: 4 }),
    makeEffect({ family: "Song of Cheer", familyPolicy: "spellsong", successValue: 6, rank: 0 })
  ];

  const sameFamily = resolveSw25Stacking({
    actor: new MockActor("b1", "T"),
    application: applyPayload({ family: "Song of Lullaby", familyPolicy: "spellsong", initialDuration: 3, remainingDuration: 3 }),
    existing: active
  });
  assert.equal(sameFamily.outcome, "choice-required");
  assert.equal(sameFamily.code, "same-family-recast");
  assert.deepEqual(sameFamily.durations, { initialDuration: 4, remainingDuration: 4 });
  record("spellsong: same-family recast → target decides (DEC-3 flow)");

  const higher = resolveSw25Stacking({
    actor: new MockActor("b2", "T"),
    application: applyPayload({ family: "Song of War", familyPolicy: "spellsong", successValue: 11 }),
    existing: active
  });
  assert.equal(higher.outcome, "replace");
  assert.equal(higher.code, "overlapping-area-higher-sv");
  assert.deepEqual(higher.replaceIds, active.map(effect => effect.id).sort());
  record("spellsong: strictly higher SV replaces the lower-SV songs (DEC-21)");

  const tie = resolveSw25Stacking({
    actor: new MockActor("b3", "T"),
    application: applyPayload({ family: "Song of War", familyPolicy: "spellsong", successValue: 9 }),
    existing: active
  });
  assert.equal(tie.outcome, "refused");
  assert.equal(tie.code, "overlapping-area-lower-sv-or-tie");
  record("spellsong: SV tie keeps the first-applied/passive effect (DEC-19/21)");

  const lower = resolveSw25Stacking({
    actor: new MockActor("b4", "T"),
    application: applyPayload({ family: "Song of War", familyPolicy: "spellsong", successValue: 5 }),
    existing: active
  });
  assert.equal(lower.outcome, "refused");
  record("spellsong: lower SV refused (DEC-21)");
}

// 3e. Geomancer Aspects (DEC-19).
{
  const existing = [makeEffect({ family: "Aspect of Earth", familyPolicy: "aspect", rank: 1, remainingDuration: 6 })];
  const other = resolveSw25Stacking({
    actor: new MockActor("g1", "T"),
    application: applyPayload({ family: "Aspect of Fire", familyPolicy: "aspect" }),
    existing
  });
  assert.equal(other.outcome, "accumulate");
  record("aspect: different Aspects accumulate (DEC-19)");

  const same = resolveSw25Stacking({
    actor: new MockActor("g2", "T"),
    application: applyPayload({ family: "Aspect of Earth", familyPolicy: "aspect", initialDuration: 2, remainingDuration: 2 }),
    existing
  });
  assert.equal(same.outcome, "replace");
  assert.equal(same.code, "same-aspect-overwrite");
  assert.deepEqual(same.durations, { initialDuration: 6, remainingDuration: 6 });
  record("aspect: the same Aspect overwrites its previous application (DEC-19)");
}

// 3f. Weapon enchantments (DEC-20 table + DEC-21 permanent-over-temporary).
{
  const noElement = makeEffect({ family: "Sharp Edge", familyPolicy: "weaponEnchant", rank: 1 });
  const fire = makeEffect({
    family: "Flame Weapon", familyPolicy: "weaponEnchant", rank: 1, remainingDuration: 10,
    damageType: { nature: "Magical", attribute: "Fire" }
  });

  const sameFamily = resolveSw25Stacking({
    actor: new MockActor("e1", "T"),
    application: applyPayload({
      family: "Flame Weapon", familyPolicy: "weaponEnchant", rank: 2,
      damageType: { nature: "Magical", attribute: "Fire" },
      initialDuration: 8, remainingDuration: 8
    }),
    existing: [fire]
  });
  assert.equal(sameFamily.outcome, "replace");
  assert.equal(sameFamily.code, "same-enchant-family-substitute");
  assert.deepEqual(sameFamily.durations, { initialDuration: 10, remainingDuration: 10 });
  record("enchant: same Family substitutes, duration merged (DEC-20/DEC-18)");

  const twoNonElemental = resolveSw25Stacking({
    actor: new MockActor("e2", "T"),
    application: applyPayload({ family: "Heavy Edge", familyPolicy: "weaponEnchant" }),
    existing: [noElement]
  });
  assert.equal(twoNonElemental.outcome, "accumulate");
  record("enchant: non-elemental + non-elemental accumulate (DEC-20)");

  const nonElemOverElemental = resolveSw25Stacking({
    actor: new MockActor("e3", "T"),
    application: applyPayload({ family: "Heavy Edge", familyPolicy: "weaponEnchant" }),
    existing: [fire]
  });
  assert.equal(nonElemOverElemental.outcome, "accumulate");
  record("enchant: non-elemental + elemental accumulate (DEC-20)");

  const sameElement = resolveSw25Stacking({
    actor: new MockActor("e4", "T"),
    application: applyPayload({
      family: "Ember Brand", familyPolicy: "weaponEnchant",
      damageType: { nature: "Magical", attribute: "Fire" }
    }),
    existing: [fire]
  });
  assert.equal(sameElement.outcome, "accumulate");
  assert.equal(sameElement.code, "same-element-accumulate");
  record("enchant: different families, same element accumulate (DEC-20)");

  const differentElement = resolveSw25Stacking({
    actor: new MockActor("e5", "T"),
    application: applyPayload({
      family: "Lightning Weapon", familyPolicy: "weaponEnchant",
      damageType: { nature: "Magical", attribute: "Lightning" }
    }),
    existing: [fire]
  });
  assert.equal(differentElement.outcome, "choice-required");
  assert.equal(differentElement.code, "incompatible-element");
  assert.deepEqual(differentElement.replaceIds, [fire.id]);
  assert.equal(differentElement.choice.existing[0].damageType.attribute, "Fire");
  assert.equal(differentElement.choice.incoming.damageType.attribute, "Lightning");
  record("enchant: different elements → target chooses (DEC-20/21/22)");

  const permanentFire = makeEffect({
    family: "Flame Weapon", familyPolicy: "weaponEnchant", rank: 1,
    damageType: { nature: "Magical", attribute: "Fire" }
  }); // no round bookkeeping, no measurable duration → permanent
  const refusedPermanent = resolveSw25Stacking({
    actor: new MockActor("e6", "T"),
    application: applyPayload({
      family: "Lightning Weapon", familyPolicy: "weaponEnchant",
      damageType: { nature: "Magical", attribute: "Lightning" },
      initialDuration: 5, remainingDuration: 5
    }),
    existing: [permanentFire]
  });
  assert.equal(refusedPermanent.outcome, "refused");
  assert.equal(refusedPermanent.code, "permanent-enchant-incompatible");
  assert.equal(refusedPermanent.choice, undefined);
  record("enchant: permanent elemental property beats temporal, no choice (DEC-21)");

  const permanentIncoming = resolveSw25Stacking({
    actor: new MockActor("e7", "T"),
    application: applyPayload({
      family: "Lightning Weapon", familyPolicy: "weaponEnchant",
      damageType: { nature: "Magical", attribute: "Lightning" }
    }),
    existing: [fire]
  });
  assert.equal(permanentIncoming.outcome, "choice-required");
  record("enchant: permanent incoming vs temporal previous still a choice");
}

// ── 4. EffectService integration and write integrity ───────────────────────

async function freshActorWith(...effects) {
  const actor = new MockActor(`svc-${nextMockId++}`, "Serviced");
  actor.effects.push(...effects);
  return actor;
}

{
  // 4.0 Validation of the new flow fields.
  setGm();
  const actor = await freshActorWith();
  const badPolicy = await applySw25Effect(actor, applyPayload({ familyPolicy: 7 }));
  assert.equal(badPolicy.ok, false);
  assert.equal(badPolicy.code, "invalid-family-policy");
  const badDamage = await applySw25Effect(actor, applyPayload({ damageType: "Fire" }));
  assert.equal(badDamage.ok, false);
  assert.equal(badDamage.code, "invalid-damage-type");
  const badAccept = await applySw25Effect(actor, applyPayload({ acceptReplace: "yes" }));
  assert.equal(badAccept.ok, false);
  assert.equal(badAccept.code, "invalid-application");
  record("service validates familyPolicy/damageType/acceptReplace at the source");

  // 4.1 Accumulate: compatible application creates its own effect and
  // persists the new schema fields, and ONLY the approved fields.
  const actorAcc = await freshActorWith(makeEffect({ family: "Haste", rank: 1, familyPolicy: "spell" }));
  const resultAcc = await applySw25Effect(actorAcc, applyPayload({
    family: "Blessing", rank: 1, cast: { successValue: 5 },
    familyPolicy: "spell", damageType: { nature: "Magical", attribute: "Light" }
  }));
  assert.equal(resultAcc.ok, true);
  assert.equal(resultAcc.code, "applied");
  const created = actorAcc.effects.find(effect => effect.system.family === "Blessing");
  assert.equal(created.system.familyPolicy, "spell");
  assert.deepEqual(created.system.damageType, { nature: "Magical", attribute: "Light" });
  assert.equal(created.name, "Blessing I");
  for (const forbidden of ["stackKey", "familyKey", "canonicalName"]) {
    assert.equal(forbidden in created.system, false, `${forbidden} must not be persisted`);
  }
  record("accumulate applies with familyPolicy/damageType persisted; no identity duplicates");

  // 4.2 Pending choice: NO write, previous intact, choice data returned.
  const actorChoice = await freshActorWith(makeEffect({ family: "Protection", rank: 2, remainingDuration: 2 }));
  const writesBefore = actorChoice.effects.length;
  const resultPending = await applySw25Effect(actorChoice, applyPayload({
    rank: 3, cast: { successValue: 9 }, initialDuration: 3, remainingDuration: 3
  }));
  assert.equal(resultPending.ok, false);
  assert.equal(resultPending.code, "choice-required");
  assert.equal(resultPending.choice.existing[0].name, "Protection II");
  assert.equal(resultPending.choice.incoming.name, "Protection III");
  assert.equal(actorChoice.effects.length, writesBefore);
  assert.equal(actorChoice.createCalls.length, 0);
  record("pending choice: no premature write, previous state intact (DEC-3)");

  // 4.3 Accepted replacement (acceptReplace: true): create-then-delete plan,
  // merged DEC-4 duration, single resulting effect.
  const previousProtection = actorChoice.effects.find(effect => effect.system.family === "Protection");
  const resultReplace = await applySw25Effect(actorChoice, applyPayload({
    rank: 3, cast: { successValue: 9 }, initialDuration: 3, remainingDuration: 3, acceptReplace: true
  }));
  assert.equal(resultReplace.ok, true);
  assert.equal(resultReplace.code, "applied");
  assert.deepEqual(resultReplace.replacedIds, [previousProtection.id]);
  const protections = actorChoice.effects.filter(effect => effect.system.family === "Protection");
  assert.equal(protections.length, 1);
  assert.equal(protections[0].system.rank, 3);
  assert.equal(protections[0].system.remainingDuration, 3); // max(2, 3)
  assert.equal(actorChoice.deleteCalls.length, 1);
  record("accepted replacement: one resulting effect, DEC-4 duration merged");

  // 4.4 Rejected replacement (acceptReplace: false): discard whole, no write.
  const actorReject = await freshActorWith(makeEffect({ family: "Protection", rank: 1 }));
  const resultReject = await applySw25Effect(actorReject, applyPayload({
    rank: 2, cast: { successValue: 4 }, acceptReplace: false
  }));
  assert.equal(resultReject.ok, false);
  assert.equal(resultReject.code, "replace-discarded");
  assert.equal(actorReject.createCalls.length, 0);
  assert.equal(actorReject.effects.length, 1);
  assert.equal(actorReject.effects[0].system.rank, 1);
  record("rejected replacement: new application discarded whole, previous intact");

  // 4.5 Refused stacking (Spellsong SV): explicit refusal, no write. The
  // service derives successValue from the casting context before consulting.
  const actorRefused = await freshActorWith(makeEffect({
    family: "Song of Lullaby", familyPolicy: "spellsong", successValue: 9, rank: 1
  }));
  const resultRefused = await applySw25Effect(actorRefused, applyPayload({
    family: "Song of War", familyPolicy: "spellsong", cast: { successValue: 9 }
  }));
  assert.equal(resultRefused.ok, false);
  assert.equal(resultRefused.code, "overlapping-area-lower-sv-or-tie");
  assert.equal(actorRefused.createCalls.length, 0);
  record("refused conflict: nothing written, active song untouched (DEC-21)");

  // 4.6 Unresolved (unknown policy): no write either.
  const actorUnresolved = await freshActorWith();
  const resultUnresolved = await applySw25Effect(actorUnresolved, applyPayload({
    family: "Mystery", familyPolicy: "mystery", cast: { successValue: 3 }
  }));
  assert.equal(resultUnresolved.ok, false);
  assert.equal(resultUnresolved.code, "stacking-policy-unregistered");
  assert.equal(actorUnresolved.createCalls.length, 0);
  record("unresolved policy: explicit no-write outcome (DEC-44)");

  // 4.7 Decision provider (T4.3 contract): async decide drives the plan.
  const actorDecide = await freshActorWith(makeEffect({ family: "Protection", rank: 1 }));
  const decidedTrue = await applySw25Effect(actorDecide, applyPayload({
    rank: 2, cast: { successValue: 6 }
  }), { decide: async () => true });
  assert.equal(decidedTrue.ok, true);
  assert.equal(actorDecide.effects.filter(effect => effect.system.family === "Protection").length, 1);
  assert.equal(actorDecide.effects.find(effect => effect.system.family === "Protection").system.rank, 2);

  const actorDecide2 = await freshActorWith(makeEffect({ family: "Ward", rank: 1 }));
  const decidedFalse = await applySw25Effect(actorDecide2, applyPayload({
    family: "Ward", rank: 2, cast: { successValue: 6 }
  }), { decide: async () => false });
  assert.equal(decidedFalse.ok, false);
  assert.equal(decidedFalse.code, "replace-discarded");
  assert.equal(actorDecide2.effects.length, 1);

  const actorDecide3 = await freshActorWith(makeEffect({ family: "Ward", rank: 1 }));
  const decidedBad = await applySw25Effect(actorDecide3, applyPayload({
    family: "Ward", rank: 2, cast: { successValue: 6 }
  }), { decide: async () => "banana" });
  assert.equal(decidedBad.ok, false);
  assert.equal(decidedBad.code, "invalid-decision");
  assert.equal(actorDecide3.effects.length, 1);

  const actorDecide4 = await freshActorWith(makeEffect({ family: "Ward", rank: 1 }));
  const decidedThrow = await applySw25Effect(actorDecide4, applyPayload({
    family: "Ward", rank: 2, cast: { successValue: 6 }
  }), { decide: async () => { throw new Error("UI exploded"); } });
  assert.equal(decidedThrow.ok, false);
  assert.equal(decidedThrow.code, "decision-failed");
  assert.equal(actorDecide4.effects.length, 1);
  record("decision provider: true/false/invalid/throw all handled without partial state");

  // 4.8 Replacement rollback: delete failure rolls the NEW effect back.
  const actorRollback = await freshActorWith(makeEffect({ family: "Ward", rank: 1 }));
  actorRollback.failDeleteCalls = 1; // the replacement delete fails once;
  // the rollback delete (the second call) succeeds and conserves the previous.
  const resultRollback = await applySw25Effect(actorRollback, applyPayload({
    family: "Ward", rank: 2, cast: { successValue: 6 }, acceptReplace: true
  }));
  assert.equal(resultRollback.ok, false);
  assert.equal(resultRollback.code, "replace-write-failed");
  assert.equal(actorRollback.effects.length, 1); // previous intact
  assert.equal(actorRollback.effects[0].system.rank, 1);
  record("rollback: failed delete → new application removed, previous conserved");

  // 4.9 No GM: the service gate keeps players out of the write path.
  setPlayer();
  const actorNoGm = await freshActorWith();
  const resultNoGm = await applySw25Effect(actorNoGm, applyPayload({ family: "Blessing", cast: { successValue: 1 } }));
  assert.equal(resultNoGm.ok, false);
  assert.equal(resultNoGm.code, "not-gm");
  assert.equal(actorNoGm.createCalls.length, 0);
  record("no GM: apply refuses (DEC-36 authority intact)");
  setGm();
}

// ── 5. Relay transport of the Bloque 4 fields ───────────────────────────────

{
  // Register the relay's socket listener on this "client" (sw25.mjs wiring).
  relay.initializeEffectRelay();

  const actor = new MockActor("relay-actor", "Relayed");
  actorsCollection.push(actor);

  // 5.1 The whitelist carries familyPolicy: an unknown policy id reaches the
  // service (if the field were stripped it would resolve as "spell").
  setPlayer();
  const resultPolicy = await relay.requestSw25EffectOperation("apply", {
    actorUuid: actor.uuid,
    family: "Mystery", familyPolicy: "mystery", cast: { successValue: 3 }
  }, { notify: false });
  assert.equal(resultPolicy.ok, false);
  assert.equal(resultPolicy.code, "stacking-policy-unregistered");
  record("relay: familyPolicy travels to the service");

  // 5.2 A pending choice travels back to the requester with its choice data.
  actor.effects.push(makeEffect({ family: "Protection", rank: 1 }));
  const resultChoice = await relay.requestSw25EffectOperation("apply", {
    actorUuid: actor.uuid,
    family: "Protection", rank: 2, cast: { successValue: 8 }
  }, { notify: false });
  assert.equal(resultChoice.ok, false);
  assert.equal(resultChoice.code, "choice-required");
  assert.equal(resultChoice.choice.incoming.name, "Protection II");
  record("relay: choice-required ack carries the choice data to the player");

  // 5.3 The decision field (acceptReplace) travels too: accept via relay.
  const resultAccept = await relay.requestSw25EffectOperation("apply", {
    actorUuid: actor.uuid,
    family: "Protection", rank: 2, cast: { successValue: 8 }, acceptReplace: true
  }, { notify: false });
  assert.equal(resultAccept.ok, true);
  assert.equal(resultAccept.status, "applied");
  assert.ok(Array.isArray(resultAccept.replacedIds) && resultAccept.replacedIds.length === 1);
  assert.equal(actor.effects.filter(effect => effect.system.family === "Protection").length, 1);
  record("relay: acceptReplace applies through the GM; applied ack carries replacedIds");

  // 5.4 Duplicate protection: the same requestId executes the write once.
  const requestId = relay.generateEffectRequestId();
  const rawRequest = {
    scope: "sw25-taka", action: "effect-request", requestId,
    gid: "gm-user", requesterId: "player-1", operation: "apply",
    request: { actorUuid: actor.uuid, family: "Blessing", rank: 1, cast: { successValue: 3 } }
  };
  const createsBefore = actor.createCalls.length;
  await game.socket.emit("system.sw25-taka", rawRequest);
  await game.socket.emit("system.sw25-taka", rawRequest); // duplicate delivery
  const blessings = actor.effects.filter(effect => effect.system.family === "Blessing");
  assert.equal(blessings.length, 1);
  assert.equal(actor.createCalls.length - createsBefore, 1);
  record("relay: duplicate requestId memoized, no duplicated write");

  actorsCollection.pop();
}

// ── 6. No-regression (Bloque 2 behavior, Bloque 3 reads, foreign subtypes) ──

{
  // 6.1 Without a registered resolver the documented default is accumulate
  // (headless suites and the pre-init window keep the Bloque 2 contract).
  registerSw25StackingResolver(null);
  setGm();
  const actorDefault = await freshActorWith(makeEffect({ family: "Protection", rank: 1 }));
  const resultDefault = await applySw25Effect(actorDefault, applyPayload({
    rank: 2, cast: { successValue: 5 }
  }));
  assert.equal(resultDefault.ok, true);
  assert.equal(actorDefault.effects.filter(effect => effect.system.family === "Protection").length, 2);
  record("no resolver → documented accumulate default intact (Bloque 2)");
  registerSw25StackingResolver(resolveSw25Stacking);

  // 6.2 Different families accumulate exactly as in Bloque 2.
  const actorMulti = await freshActorWith(makeEffect({ family: "Haste", rank: 1 }));
  const resultMulti = await applySw25Effect(actorMulti, applyPayload({
    family: "Blessing", rank: 1, cast: { successValue: 2 }
  }));
  assert.equal(resultMulti.ok, true);
  assert.equal(actorMulti.effects.length, 2);
  record("no-conflict applications keep the Bloque 2 behavior");

  // 6.3 Foreign subtypes are untouched by the stacking policies.
  const actorForeign = await freshActorWith();
  const nativeEffect = new MockEffect({
    type: "condition", name: "Prone",
    system: { family: "Protection", rank: 1, successValue: 0, changes: [] }
  });
  actorForeign.effects.push(nativeEffect);
  const resultForeign = await applySw25Effect(actorForeign, applyPayload({
    cast: { successValue: 3 }
  }));
  assert.equal(resultForeign.ok, true);
  assert.equal(actorForeign.effects.filter(effect => effect.type === SW25_EFFECT_SUBTYPE).length, 1);
  assert.ok(actorForeign.effects.includes(nativeEffect));
  record("foreign subtypes stay outside the stacking scope");

  // 6.4 Reads keep working without GM (Bloque 2/3 contract) with the new
  // fields present.
  setPlayer();
  const actorRead = await freshActorWith(makeEffect({
    family: "Flame Weapon", familyPolicy: "weaponEnchant", rank: 1,
    damageType: { nature: "Magical", attribute: "Fire" }
  }));
  const prepared = effectsTab.prepareSw25EffectRows([...actorRead.effects]);
  assert.ok(Array.isArray(prepared.rows) && prepared.rows.length === 1);
  assert.equal(prepared.rows[0].name, "Flame Weapon I");
  record("reads without GM still work with the Bloque 4 fields");
  setGm();
}

// ── 7. T4.3 dialog contract (UI-independent) ────────────────────────────────

{
  const dialog = await import("../module/effects/stacking-choice-dialog.mjs");
  // Without a rendered client (no DialogV2) the decision provider fails
  // loudly; EffectService surfaces that as `decision-failed` with no writes.
  await assert.rejects(
    () => dialog.decideSw25StackingChoice({ field: "acceptReplace", existing: [], incoming: {} }),
    /DialogV2 is not available/
  );
  await assert.rejects(
    () => dialog.decideSw25StackingChoice(null),
    /No stacking choice data/
  );
  record("dialog: headless failure is explicit, never a silent decision");
}

console.log("\nAll effects-stacking assertions passed.");
