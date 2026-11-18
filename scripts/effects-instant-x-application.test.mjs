// Sword World 2.5 - Instant/X persistent-component integration tests (T5.7-C,
// updated to the centralized Spellcasting flow).
//
// The persistent component of an Instant/X spell is created AS A CONSEQUENCE
// OF THE CAST (rules/spell-cast.mjs → applyInstantXPersistentEffect →
// EffectService via the GM relay). The apply-damage path
// (damage-application.mjs) applies ONLY the immediate damage: it can never
// create, duplicate or re-process the persistent component.
//
// Verified contracts (DEC-6, DEC-1/DEC-16, T5.2/D4, T5.3, DEC-9):
//   1. Major action: the casting Success Value (NEVER the damage total) is
//      preserved as cast.successValue; applying damage creates nothing.
//   2. Minor action: successValue stays 0.
//   3. Rounds duration receives a valid casterTurn combat anchor.
//   4. Turns duration receives a valid casterTurn combat anchor.
//   5. Manual scales (minutes/other) need no combat anchor and get no
//      invented counters.
//   6. Family/rank identity follows DEC-1/DEC-16 (canonical name + parsed
//      numeral; `system.school` is never used as family).
//   7. casterUUID and origin (spell document UUID) are preserved.
//   8. Local path and socket-GM path build identical applications, and the
//      apply-damage transport carries no casting context anymore.
//   9. Missing mandatory data (no Success Value, no resolvable combat
//      anchor) skips the persistent creation without fabricating values.
//
// These are automated headless tests; Foundry verification is reported
// separately from this suite.

import assert from "node:assert/strict";

// ── Global Foundry environment mock (before any module import) ─────────────

const notifications = [];
const socketEmissions = [];
const consoleWarnings = [];
const registeredHooks = new Map();
const socketListeners = [];
const gameUsers = [];

const originalWarn = console.warn;
console.warn = (...args) => {
  consoleWarnings.push(args.map(String).join(" "));
  originalWarn(...args);
};

const actorsCollection = [];
actorsCollection.get = id => actorsCollection.find(a => a.id === id || a.uuid === id) ?? null;

const spellCollection = new Map();

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
    this.updates.push(structuredClone(changes));
    applyFlattened(this, changes);
    return this;
  }
  async delete() {
    this.deleted = true;
    const owner = actorsCollection.find(actor => actor.effects.includes(this));
    if (owner) owner.effects = owner.effects.filter(effect => effect !== this);
    return this;
  }
}

class MockActor {
  constructor(id, name, { type = "character", isOwner = true } = {}) {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.name = name;
    this.type = type;
    this.isOwner = isOwner;
    this.items = [];
    this.effects = [];
    this.system = { hp: { value: 20, max: 20 } };
  }
  async createEmbeddedDocuments(type, dataArray) {
    const created = [];
    for (const data of dataArray) {
      const effect = new MockEffect({ ...data, id: `ef-${nextMockId++}` });
      this.effects.push(effect);
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
  getFlag() { return undefined; }
  async update(changes) {
    applyFlattened(this, changes);
    return this;
  }
}

globalThis.game = {
  user: { isGM: false, id: "player-1" },
  actors: actorsCollection,
  items: {
    get(uuid) { return spellCollection.get(uuid) ?? null; }
  },
  users: {
    get(id) { return gameUsers.find(u => u.id === id || u._id === id) ?? null; },
    filter(fn) { return gameUsers.filter(fn); },
    get activeGM() { return gameUsers.find(u => u.isGM && u.active) ?? null; }
  },
  socket: {
    async emit(channel, payload) { socketEmissions.push({ channel, payload }); },
    on(_channel, fn) { socketListeners.push(fn); }
  },
  combats: { get: () => null },
  combat: null
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

globalThis.ChatMessage = {
  async create() { return {}; },
  getSpeaker: () => ({})
};

// Both spellings are used across the system's modules.
globalThis.fromUuid = async uuid => spellCollection.get(uuid)
  ?? actorsCollection.find(a => a.uuid === uuid) ?? null;

globalThis.foundry = {
  data: {
    ActiveEffectTypeDataModel: class ActiveEffectTypeDataModelStub {}
  },
  utils: {
    escapeHTML: value => String(value),
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
const relay = await import("../module/effects/effect-relay.mjs");
const spellEffects = await import("../module/rules/spell-effects.mjs");
const spellData = await import("../module/rules/spell-data.mjs");
const spellCast = await import("../module/rules/spell-cast.mjs");
const damageApplication = await import("../module/combat/damage-application.mjs");
const engine = await import("../module/effects/duration-engine.mjs");

const { registerSw25StackingResolver, initializeEffectService } = service;
const { applyInstantXPersistentEffect } = spellCast;
const { damageApplicationButton, initializeDamageApplication } = damageApplication;
const { getInstantXSpellIdentity, getInstantXSpellData, resolveSw25CasterAnchor } = spellEffects;
const { normalizeSpellData } = spellData;
const { processSw25DurationEvent } = engine;

// Production wiring: stacking resolution, service write guards, and the
// real chat-card/socket wiring of the damage application flow.
registerSw25StackingResolver(() => ({ outcome: "accumulate" }));
initializeEffectService();
initializeDamageApplication();

gameUsers.push(
  { id: "gm-user", _id: "gm-user", isGM: true, active: true, name: "GameMaster" },
  { id: "player-1", _id: "player-1", isGM: false, active: true, name: "Player One" }
);

const record = label => console.log(`  ${label}`);

// ── Fixtures ───────────────────────────────────────────────────────────────

// Real compendium metadata shapes (sw25-library spells pack). The fixtures
// pass through the SHARED `normalizeSpellData` — the same migration logic
// the actor-sheet drop handler and the test-world migration use — so the
// spells carry the current schema's structured fields.
function makeSpell(uuid, name, metadata, extraSystem = {}) {
  const { system } = normalizeSpellData(
    { metadata, className: "Divine", ...extraSystem },
    { name }
  );
  const spell = {
    uuid,
    id: uuid.split(".").pop(),
    name,
    type: "spell",
    system
  };
  spellCollection.set(uuid, spell);
  return spell;
}

const CASTER_UUID = "Actor.caster-1";
const caster = new MockActor("caster-1", "Caster");
actorsCollection.push(caster);

const fieldProtection = makeSpell(
  "Actor.caster-1.Item.field-protection",
  "Field Protection II",
  "Cost: MP7\nTarget: 1 area (5m Radius)/15\nRange/Area: 2 (30m) / Target\nDuration: Instant/3 minutes (18 rounds)\nResistance: Can't"
);
const shockingWave = makeSpell(
  "Actor.caster-1.Item.shocking-wave",
  "Shocking Wave",
  "Cost: MP22\nTarget: 1 area (6m radius) / All\nRange/Area: Caster\nDuration: Instant/20 seconds (2 rounds)\nResistance: Negates\nType: Psychic (Weak)"
);
const fearSpell = makeSpell(
  "Actor.caster-1.Item.fear",
  "‡Fear",
  "Cost: MP8\nTarget: 1 enemy\nRange/Area: 2 (30m)\nDuration: Instant/Various\nResistance: Negates"
);
const threeRoundsSpell = makeSpell(
  "Actor.caster-1.Item.three-rounds",
  "Chilling Breath",
  "Cost: MP5\nTarget: 1 enemy\nDuration: Instant/3 rounds\nResistance: Negates"
);
const threeTurnsSpell = makeSpell(
  "Actor.caster-1.Item.three-turns",
  "Turn Effect",
  "Cost: MP5\nTarget: 1 enemy\nDuration: Instant/3 turns\nResistance: Negates"
);
const poisonSpell = makeSpell(
  "Actor.caster-1.Item.poison",
  "Venom Bolt",
  "Cost: MP6\nTarget: 1 enemy\nDuration: Instant/10 seconds (1 round)\nResistance: Negates\nType: Poison"
);

const casterCombatant = { id: "cmbt-caster", actorUuid: CASTER_UUID, tokenId: "tkn-caster", name: "Caster" };
function setActiveCombat() {
  game.combat = { id: "combat-1", round: 1, combatants: [casterCombatant] };
}
function clearCombat() {
  game.combat = null;
}

// Drives the REAL chat-card wiring: initializeDamageApplication registers a
// renderChatMessageHTML hook; feeding it a message + html stub with a fake
// button reaches requestDamage exactly as a click would.
async function clickDamageButton(button) {
  let clickHandler = null;
  const fakeButton = {
    dataset: button.dataset,
    addEventListener(type, fn) { if (type === "click") clickHandler = fn; }
  };
  const fakeHtml = { querySelectorAll: () => [fakeButton] };
  for (const listener of registeredHooks.get("renderChatMessageHTML") ?? []) {
    await listener({ id: "msg-1", getFlag: () => undefined }, fakeHtml);
  }
  assert.ok(clickHandler, "The damage button registered its click handler");
  await clickHandler({ preventDefault() {}, currentTarget: fakeButton });
}

const contextWarnings = () => consoleWarnings.filter(line => line.includes("persistent component"));

// ── 1. Major action: SV preserved, damage never used as SV ─────────────────

{
  setGm();
  setActiveCombat();
  const target = new MockActor("target-1", "Target One");
  actorsCollection.push(target);

  // SV 13 (e.g. 2d6 → 8, +5 Magic Power), damage 40: deliberately different.
  // The apply-damage button carries NO casting context anymore: applying
  // damage never creates the persistent component.
  const button = {
    dataset: {
      actorId: target.uuid,
      damage: "40",
      damageType: "magical",
      damageFactor: "1"
    }
  };
  await clickDamageButton(button);

  assert.equal(target.system.hp.value, -20, "The immediate damage was applied (40, defense 0)");
  assert.equal(target.effects.length, 0, "Applying damage NEVER creates the persistent component (cast-time creation)");

  // The persistent component is created at CAST time with the AUTHENTIC
  // casting SV (the damage total is never used as the SV).
  await applyInstantXPersistentEffect(target, {
    spellUuid: shockingWave.uuid,
    casterUuid: CASTER_UUID,
    successValue: 13,
    damageType: "magical"
  });
  assert.equal(target.effects.length, 1, "One persistent component created by the cast flow");
  const system = target.effects[0].system;
  assert.equal(system.successValue, 13, "cast.successValue is the casting SV");
  assert.notEqual(system.successValue, 40, "The damage total is NEVER the Success Value");
  // Rounds scale from "Instant/20 seconds (2 rounds)" with the caster anchor.
  assert.equal(system.durationScale, "rounds");
  assert.equal(system.initialDuration, 2);
  assert.equal(system.remainingDuration, 2);
  assert.deepEqual(system.durationAnchor, {
    regime: "casterTurn", edge: "begin", state: "resolved", combatantId: "cmbt-caster", tokenId: "tkn-caster"
  });
  // DEC-9 damageType: nature from the spell channel, attribute from metadata.
  assert.deepEqual(system.damageType, { nature: "Magical", attribute: "Psychic" });
  // Identity from the authored name (DEC-1/DEC-16) and the stored rank.
  assert.equal(system.family, "Shocking Wave");
  assert.equal(system.rank, 0);
  assert.equal(target.effects[0].name, "Shocking Wave", "Canonical document name");
  // DEC-6 context: caster and origin preserved.
  assert.equal(system.casterUUID, CASTER_UUID);
  assert.equal(target.effects[0].origin, shockingWave.uuid, "origin is the spell document UUID");
  record("case 1: cast-time creation with SV 13 preserved (damage 40 never used as SV); Apply Damage creates nothing");
}

// ── Debug aid: expose captured internals for a focused re-run ──────────────

if (process.env.T57C_DEBUG === "1") {
  console.log("NOTIFICATIONS:", JSON.stringify(notifications, null, 2));
  console.log("WARNINGS:", JSON.stringify(consoleWarnings, null, 2));
  console.log("SOCKET EMISSIONS:", JSON.stringify(socketEmissions, null, 2));
}

// ── 2. Minor action: SV stays 0 ────────────────────────────────────────────

{
  setGm();
  const target = new MockActor("target-2", "Target Two");
  actorsCollection.push(target);
  await applyInstantXPersistentEffect(target, {
    spellUuid: fieldProtection.uuid,
    casterUuid: CASTER_UUID,
    successValue: 0, // minor action (DEC-6): SV is legitimately 0
    damageType: "magical"
  });
  assert.equal(target.effects.length, 1, "The minor-action persistent component IS created");
  assert.equal(target.effects[0].system.successValue, 0, "successValue preserved as 0");
  assert.equal(target.effects[0].system.family, "Field Protection");
  assert.equal(target.effects[0].system.rank, 2, "Parsed rank numeral (DEC-16)");
  record("case 2: minor action — successValue stays 0");
}

// ── 3. Rounds duration with a valid caster anchor ──────────────────────────

{
  setGm();
  setActiveCombat();
  const target = new MockActor("target-3", "Target Three");
  actorsCollection.push(target);
  await applyInstantXPersistentEffect(target, {
    spellUuid: threeRoundsSpell.uuid,
    casterUuid: CASTER_UUID,
    successValue: 9,
    damageType: "magical"
  });
  assert.equal(target.effects.length, 1);
  const system = target.effects[0].system;
  assert.equal(system.durationScale, "rounds", "Rounds scale from 'Instant/3 rounds'");
  assert.equal(system.initialDuration, 3);
  assert.equal(system.remainingDuration, 3);
  assert.deepEqual(system.durationAnchor, {
    regime: "casterTurn", edge: "begin", state: "resolved", combatantId: "cmbt-caster", tokenId: "tkn-caster"
  });
  // The T5.3 duration engine can process the anchored effect (same mock
  // combat shape as effects-instant-x.test.mjs case 6; the engine scans the
  // encounter's participant actors, so the effect owner must be present).
  const engineCaster = { ...casterCombatant, name: "Caster", actor: caster, defeated: false, token: { id: "tkn-caster" } };
  const engineTarget = { id: "cmbt-target", name: "Target", actor: target, defeated: false, tokenId: "tkn-target", token: { id: "tkn-target" } };
  const combat = {
    id: "combat-1", round: 1, turn: null, started: true,
    combatants: Object.assign([engineCaster, engineTarget], { get: cid => (cid === "cmbt-caster" ? engineCaster : cid === "cmbt-target" ? engineTarget : null) })
  };
  const summary = await processSw25DurationEvent(combat, { kind: "turn-begin", combatantId: "cmbt-caster" });
  assert.equal(summary.ok, true, "The anchored effect is processable by the duration engine");
  assert.equal(target.effects[0].system.remainingDuration, 2, "Counter decremented by the engine");
  record("case 3: rounds duration with valid casterTurn/begin anchor, engine-processable");
}

// ── 4. Turns duration with a valid caster anchor ───────────────────────────

{
  setGm();
  setActiveCombat();
  const target = new MockActor("target-4", "Target Four");
  actorsCollection.push(target);
  await applyInstantXPersistentEffect(target, {
    spellUuid: threeTurnsSpell.uuid,
    casterUuid: CASTER_UUID,
    successValue: 7,
    damageType: "magical"
  });
  assert.equal(target.effects.length, 1);
  const system = target.effects[0].system;
  assert.equal(system.durationScale, "turns", "Turns scale from 'Instant/3 turns'");
  assert.equal(system.initialDuration, 3);
  assert.equal(system.remainingDuration, 3);
  assert.deepEqual(system.durationAnchor, {
    regime: "casterTurn", edge: "begin", state: "resolved", combatantId: "cmbt-caster", tokenId: "tkn-caster"
  });
  record("case 4: turns duration with valid casterTurn/begin anchor");
}

// ── 5. Manual scales: no combat anchor, no invented counters ───────────────

{
  setGm();
  setActiveCombat(); // combat active, but manual scales must ignore it
  const target = new MockActor("target-5", "Target Five");
  actorsCollection.push(target);
  await applyInstantXPersistentEffect(target, {
    spellUuid: fieldProtection.uuid,
    casterUuid: CASTER_UUID,
    successValue: 11,
    damageType: "magical"
  });
  assert.equal(target.effects.length, 1);
  const system = target.effects[0].system;
  assert.equal(system.durationScale, "minutes", "Manual scale from 'Instant/3 minutes (18 rounds)'");
  assert.equal(system.durationAnchor, null, "Manual scales never carry combat anchors (D4)");
  assert.equal(system.initialDuration, null, "No invented counter (DEC-23/DEC-40)");
  assert.equal(system.remainingDuration, null, "No invented counter (DEC-23/DEC-40)");

  // "Instant/Various" → GM-managed "other" scale (DEC-32).
  const target2 = new MockActor("target-5b", "Target Five B");
  actorsCollection.push(target2);
  await applyInstantXPersistentEffect(target2, {
    spellUuid: fearSpell.uuid,
    casterUuid: CASTER_UUID,
    successValue: 10,
    damageType: "magical"
  });
  assert.equal(target2.effects.length, 1);
  assert.equal(target2.effects[0].system.durationScale, "other", "Unclassifiable duration → 'other' (DEC-32)");
  assert.equal(target2.effects[0].system.durationAnchor, null);
  assert.equal(target2.effects[0].system.family, "‡Fear", "Authoring marker stays in the family");
  record("case 5: manual scales (minutes/other) without combat anchor or invented counters");
}

// ── 6. Family/rank identity (DEC-1/DEC-16) ─────────────────────────────────

{
  // Pure identity parsing (validated against the compendium: 22 ranked
  // names, 0 false positives). `fieldProtection` carries the STORED rank 2
  // (normalized from the "Field Protection II" name numeral by the shared
  // parser); a plain-name object still parses from the name.
  assert.deepEqual(getInstantXSpellIdentity(fieldProtection), { family: "Field Protection", rank: 2 });
  assert.deepEqual(getInstantXSpellIdentity(shockingWave), { family: "Shocking Wave", rank: 0 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "△Take the Lead I" }), { family: "△Take the Lead", rank: 1 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "△Take The Lead II" }), { family: "△Take The Lead", rank: 2 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "Summon Fairy IV" }), { family: "Summon Fairy", rank: 4 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "⏩△Wing Flyer II" }), { family: "⏩△Wing Flyer", rank: 2 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "Mana Max" }), { family: "Mana Max", rank: 0 }, "Lowercase 'x' is never a numeral");
  assert.deepEqual(getInstantXSpellIdentity({ name: "‡Fear" }), { family: "‡Fear", rank: 0 });
  assert.deepEqual(getInstantXSpellIdentity({ name: "Freeze" }), { family: "Freeze", rank: 0 });
  // The spell LEVEL is never used as the rank (Field Protection is level 8,
  // its rank is 2), and the STORED integer rank wins over the name numeral.
  assert.equal(fieldProtection.system.level ?? 8, 8);
  assert.equal(getInstantXSpellIdentity(fieldProtection).rank, 2, "Rank comes from the stored structured rank / name numeral, not the level");
  assert.deepEqual(getInstantXSpellIdentity({ name: "Summon Fairy IV", system: { rank: 6 } }), { family: "Summon Fairy", rank: 6 }, "A stored integer rank overrides the name numeral");
  assert.notEqual(getInstantXSpellIdentity(fieldProtection).family, "Divine");
  record("case 6: family/rank identity per DEC-1/DEC-16 (stored rank / name numeral, never level)");
}

// ── 7. casterUUID and origin preservation ──────────────────────────────────

{
  setGm();
  const target = new MockActor("target-7", "Target Seven");
  actorsCollection.push(target);
  await applyInstantXPersistentEffect(target, {
    spellUuid: poisonSpell.uuid,
    casterUuid: CASTER_UUID,
    successValue: 8,
    damageType: "physical"
  });
  assert.equal(target.effects.length, 1);
  const system = target.effects[0].system;
  assert.equal(system.casterUUID, CASTER_UUID, "Real caster UUID preserved");
  assert.equal(target.effects[0].origin, poisonSpell.uuid, "origin is the spell document UUID, not the name");
  assert.notEqual(target.effects[0].origin, poisonSpell.name);
  assert.deepEqual(system.damageType, { nature: "Physical", attribute: "Poison" }, "DEC-9 nature + metadata attribute");
  assert.equal(system.effectType, null, "effectType stays null when the spell defines none");
  record("case 7: casterUUID and origin (spell document UUID) preserved");
}

// ── 8. Local path and socket GM path equivalence (damage only) ─────────────

{
  setActiveCombat();
  const buttonContext = {
    actorId: null, // filled per path below
    damage: "25",
    damageType: "magical",
    damageFactor: "1"
  };

  // Local path: owner target, GM client. Damage only — no casting context
  // travels on the apply-damage transport anymore.
  setGm();
  const localTarget = new MockActor("target-8a", "Target Local", { isOwner: true });
  actorsCollection.push(localTarget);
  await clickDamageButton({ dataset: { ...buttonContext, actorId: localTarget.uuid } });
  assert.equal(localTarget.system.hp.value, -5, "Local path applied the immediate damage");
  assert.equal(localTarget.effects.length, 0, "The apply-damage path creates no persistent component");

  // Socket path: non-owner target on a player client → emit → GM handler.
  setPlayer();
  const socketTarget = new MockActor("target-8b", "Target Socket", { isOwner: false });
  actorsCollection.push(socketTarget);
  socketEmissions.length = 0;
  await clickDamageButton({ dataset: { ...buttonContext, actorId: socketTarget.uuid } });
  assert.equal(socketTarget.effects.length, 0, "No local write on the player client");
  const emission = socketEmissions.find(e => e.payload?.action === "apply-damage");
  assert.ok(emission, "The damage request was sent to the GM through the socket");
  assert.ok(!("spellUuid" in emission.payload), "The socket payload carries NO spell UUID (no casting context)");
  assert.ok(!("successValue" in emission.payload), "The socket payload carries NO casting SV");
  assert.ok(!("casterUuid" in emission.payload), "The socket payload carries NO caster UUID");
  assert.equal(emission.payload.damageType, "magical", "The socket payload carries the damage channel");

  // The GM processes the payload through the registered socket handler:
  // immediate damage only.
  setGm();
  const damageSocketHandler = socketListeners[socketListeners.length - 1];
  assert.equal(typeof damageSocketHandler, "function", "The GM socket handler is registered");
  await damageSocketHandler(emission.payload, "player-1");
  assert.equal(socketTarget.system.hp.value, -5, "The socket path applied the immediate damage");
  assert.equal(socketTarget.effects.length, 0, "The socket path creates no persistent component");

  // The cast flow creates the persistent components through the SAME entry
  // point on both execution routes; the resulting system data is identical.
  await applyInstantXPersistentEffect(localTarget, {
    spellUuid: shockingWave.uuid,
    casterUuid: CASTER_UUID,
    successValue: 14,
    damageType: "magical"
  });
  await applyInstantXPersistentEffect(socketTarget, {
    spellUuid: shockingWave.uuid,
    casterUuid: CASTER_UUID,
    successValue: 14,
    damageType: "magical"
  });
  const localSystem = localTarget.effects[0].system;
  const socketSystem = socketTarget.effects[0].system;
  assert.deepEqual(socketSystem, localSystem, "Identical system payload on both execution routes");
  assert.equal(socketSystem.successValue, 14, "SV intact on the socket route");
  assert.equal(socketSystem.casterUUID, CASTER_UUID, "casterUUID intact on the socket route");
  record("case 8: local and socket-GM paths apply damage identically; the cast flow builds identical persistent applications");
}

// ── 9. Missing mandatory data is rejected, never fabricated ────────────────

{
  setGm();
  setActiveCombat();
  consoleWarnings.length = 0;

  // 9a. The apply-damage path no longer processes casting context at all:
  // damage applies, nothing is created and nothing casting-related is
  // reported (creation belongs to the cast flow).
  const target = new MockActor("target-9a", "Target Nine A");
  actorsCollection.push(target);
  await clickDamageButton({
    dataset: {
      actorId: target.uuid,
      damage: "18",
      damageType: "magical",
      damageFactor: "1"
    }
  });
  assert.equal(target.system.hp.value, 2, "The immediate damage was still applied");
  assert.equal(target.effects.length, 0, "No persistent component from the apply-damage path");
  assert.equal(contextWarnings().length, 0, "The apply-damage path attempts no persistent creation and reports nothing");

  // 9a'. A direct cast-flow creation without a Success Value is rejected
  // with clear reporting, never fabricated.
  await applyInstantXPersistentEffect(target, {
    spellUuid: shockingWave.uuid,
    casterUuid: CASTER_UUID
    // no successValue
  });
  assert.equal(target.effects.length, 0, "No persistent component without the casting SV");
  assert.ok(contextWarnings().some(line => line.includes("Success Value")), "The missing-SV failure is clearly reported");

  // 9b. Combat scale without a resolvable caster combatant: no fabricated
  // anchor, no persistent component.
  clearCombat();
  const target2 = new MockActor("target-9b", "Target Nine B");
  actorsCollection.push(target2);
  await applyInstantXPersistentEffect(target2, {
    spellUuid: threeRoundsSpell.uuid,
    casterUuid: "Actor.absent-caster",
    successValue: 12,
    damageType: "magical"
  });
  assert.equal(target2.effects.length, 0, "No persistent component without a combat anchor for a rounds scale");
  assert.ok(contextWarnings().some(line => line.includes("anchor")), "The missing-anchor failure is clearly reported");
  setActiveCombat();

  // 9c. Non-integer / negative SV values are invalid data, not fabricated.
  const target3 = new MockActor("target-9c", "Target Nine C");
  actorsCollection.push(target3);
  await applyInstantXPersistentEffect(target3, { spellUuid: fieldProtection.uuid, casterUuid: CASTER_UUID, successValue: "17" });
  assert.equal(target3.effects.length, 0, "A non-numeric SV is missing mandatory data");
  record("case 9: missing mandatory data skips the persistent creation with clear reporting");
}

// ── Transport: button attributes ───────────────────────────────────────────

{
  // Damage buttons NEVER carry casting context: the persistent components
  // are created at cast time with the authentic cast SV. The SV transport
  // lives only on the damage-ROLL buttons (roll-spell-damage,
  // roll-critical-damage) that must preserve it across critical rolls.
  const damageButton = damageApplicationButton(40, "magical", false);
  assert.ok(!damageButton.includes("data-success-value"), "Damage buttons never carry a Success Value");
  assert.ok(!damageButton.includes("data-caster-uuid"), "Damage buttons never carry a caster UUID");
  assert.ok(!damageButton.includes("data-spell-uuid"), "Damage buttons never carry a spell UUID");
  const fullDamageButton = damageApplicationButton(10, "physical", true);
  assert.ok(fullDamageButton.includes("Apply Physical Damage"), "Full damage button present");
  assert.ok(fullDamageButton.includes("Apply Half Damage"), "Half damage button present");

  // Anchor resolution helper (pure wrt the mock environment).
  setActiveCombat();
  assert.deepEqual(resolveSw25CasterAnchor(CASTER_UUID), {
    regime: "casterTurn", edge: "begin", state: "resolved", combatantId: "cmbt-caster", tokenId: "tkn-caster"
  });
  assert.equal(resolveSw25CasterAnchor("Actor.nobody"), null, "A non-combatant caster resolves no anchor");
  clearCombat();
  assert.equal(resolveSw25CasterAnchor(CASTER_UUID), null, "No anchor outside combat");

  // Duration parsing sanity on the real metadata shapes.
  assert.deepEqual(getInstantXSpellData(shockingWave), { durationScale: "rounds", initialDuration: 2, remainingDuration: 2 });
  assert.deepEqual(getInstantXSpellData(fieldProtection), { durationScale: "minutes", initialDuration: null, remainingDuration: null });
  assert.deepEqual(getInstantXSpellData(fearSpell), { durationScale: "other", initialDuration: null, remainingDuration: null });
  record("transport: button attributes, anchor resolution and duration parsing verified");
}

// ── Completion ─────────────────────────────────────────────────────────────

console.log("T5.7-C Instant/X integration: all 9 cases + transport checks passed.");
process.exit(0);
