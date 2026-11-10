// Sword World 2.5 - F2-T2 Monster Knowledge consumer integration tests.
//
// Verifies the production consumers that READ knowledge from the Monster
// Knowledge Registry (module/knowledge/):
//   A. species identity unification (concealed-main-section re-exports)
//   B. the monster-sheet Weak Point indicator reads the registry,
//      shared by species (new identity model)
//   C. absence of discoveries reads as unknown
//   D. a discovery delivered through the F2-T1 player relay becomes
//      visible through the consumer bridge, and open monster sheets
//      repaint their indicator when the registry setting changes
//      (documented v14 hook "clientSettingChanged"; simulated here by
//      dispatching our own handler, as the mock settings.set cannot
//      reproduce Foundry's own hook emission)
//   E. unrelated setting keys never repaint consumers
//   F. session replacement switches the visible knowledge
//   G. campaign pointer isolation (activate among campaigns)
//   H. sync registration tolerates headless environments without Hooks
// The socket round-trip impersonates clients exactly like the relay suite;
// no timers are used anywhere.

import assert from "node:assert/strict";

// ── Global Foundry environment mock ────────────────────────────────────────

const worldSettings = new Map();
const notes = [];
const hookListeners = new Map();
const onceListeners = new Map();
const socketListeners = [];
// Consumer repaints triggered through the registered "clientSettingChanged"
// handler since the last counter reset.
let consumerRepaints = 0;

class ActorSheetStub {
  async close() {}
  render() { return "base-render"; }
}

globalThis.foundry = {
  appv1: { sheets: { ActorSheet: ActorSheetStub } },
  utils: {
    escapeHTML(value) { return String(value ?? ""); },
    mergeObject(base, patch) { return { ...(base ?? {}), ...(patch ?? {}) }; },
    randomID() { return `mk-${Math.random().toString(36).slice(2, 10)}`; }
  }
};

globalThis.Hooks = {
  on(name, fn) { (hookListeners.get(name) ?? hookListeners.set(name, []).get(name)).push(fn); },
  once(name, fn) { (onceListeners.get(name) ?? onceListeners.set(name, []).get(name)).push(fn); },
  call(name, ...args) {
    for (const fn of [...(hookListeners.get(name) ?? [])]) fn(...args);
  }
};

const gameUsers = [];
const actorsCollection = [];
actorsCollection.get = id => actorsCollection.find(a => a.id === id || a.uuid === id) ?? null;

globalThis.game = {
  user: { isGM: false, id: "player-1", character: null },
  actors: actorsCollection,
  users: {
    get(id) { return gameUsers.find(u => u.id === id || u._id === id) ?? null; },
    filter(fn) { return gameUsers.filter(fn); },
    get activeGM() { return gameUsers.find(u => u.isGM && u.active) ?? null; }
  },
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) {
      worldSettings.set(`${scope}.${key}`, structuredClone(value));
      return value;
    }
  },
  socket: {
    // Single-process socket: request payloads are delivered to the designated
    // GM client and ack payloads to the requesting player, impersonating the
    // receiver (relay-suite delivery pattern).
    async emit(channel, payload) {
      const senderId = game.user.id ?? null;
      if (payload?.action === "mk-discovery-request") {
        const receiver = payload.gid ? game.users.get(payload.gid) : null;
        if (!receiver?.isGM) return;
        await deliverAs(receiver.id ?? payload.gid, payload, senderId);
      } else if (payload?.action === "mk-discovery-ack") {
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

globalThis.ui = {
  notifications: {
    warn(message) { notes.push({ kind: "warn", message }); },
    info(message) { notes.push({ kind: "info", message }); },
    error(message) { notes.push({ kind: "error", message }); }
  }
};

globalThis.fromUuid = async uuid => actorsCollection.find(a => a.uuid === uuid) ?? null;

// ── Imports after mocks ────────────────────────────────────────────────────

const { SW25MonsterSheet, initializeMonsterSheetKnowledgeSync } = await import("../module/actor/monster-sheet.mjs");
const {
  speciesWeaknessKnown,
  isSpeciesWeaknessKnown
} = await import("../module/combat/monster-knowledge.mjs");
const {
  registerMkDiscovery,
  startMkSession,
  createMkCampaign,
  activateMkCampaign,
  isMkSpeciesKnown,
  readMkActiveRecord
} = await import("../module/knowledge/monster-knowledge-registry.mjs");
const {
  requestMkRelayDiscovery,
  initializeMonsterKnowledgeRelay
} = await import("../module/knowledge/mk-relay.mjs");
const { normalizeSpeciesId: c10Normalize, speciesId: c10Species } =
  await import("../module/combat/concealed-main-section.mjs");
const { normalizeSpeciesId: identityNormalize, speciesId: identitySpecies } =
  await import("../module/knowledge/mk-identity.mjs");

// ── Helpers ────────────────────────────────────────────────────────────────

function resetWorld() {
  worldSettings.clear();
  notes.length = 0;
  socketListeners.length = 0;
  gameUsers.length = 0;
  gameUsers.push(
    { _id: "gm-user", id: "gm-user", isGM: true, active: true, name: "GameMaster" },
    { _id: "player-1", id: "player-1", isGM: false, active: true, name: "Player One" },
    { _id: "player-2", id: "player-2", isGM: false, active: true, name: "Player Two" }
  );
  actorsCollection.length = 0;
  consumerRepaints = 0;
  setPlayer("player-1");
}

function setPlayer(id) {
  game.user.isGM = false;
  game.user.id = id;
  game.user.character = null;
}

function setGM() {
  game.user.isGM = true;
  game.user.id = "gm-user";
}

function makeMonster(id, species) {
  return {
    id,
    uuid: `Actor.${id}`,
    name: `${species} (${id})`,
    type: "monster",
    system: { species, reputation: 10, weakness: 12 }
  };
}

function makeEvidence(monster, speciesIdText) {
  return {
    speciesId: speciesIdText,
    speciesLabel: monster.system.species,
    monsterUuid: monster.uuid,
    monsterName: monster.name,
    className: "sage",
    classResult: 20,
    source: "roll",
    discoveredBy: "player-1",
    level: "weakness"
  };
}

const legacyValue = () => {
  const value = worldSettings.get("sword-world-25.weaknessRegistry");
  return value === undefined ? undefined : structuredClone(value);
};

// Construct a monster sheet and render it once so it joins the live sync set,
// then install an instance spy purely to COUNT the repaints triggered by the
// registry-change hook (the set membership itself is managed by the class).
function openMkSheet(actor) {
  const sheet = new SW25MonsterSheet(actor);
  sheet.render(false); // prototype render registers the sheet
  const prototypeRender = SW25MonsterSheet.prototype.render.bind(sheet);
  sheet.render = (...args) => {
    consumerRepaints += 1;
    return prototypeRender(...args);
  };
  return sheet;
}

async function closeMkSheet(sheet) {
  await sheet.close(); // the close override deregisters the sheet from the sync set
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log("=== Monster Knowledge consumer integration (F2-T2) ===\n");

// A. The duplicated pre-F1 species identity is gone: the concealed-main-section
//    exports ARE the mk-identity functions (F2-T2 unification decision).
console.log("Test A: species identity unified into mk-identity (C10)");
{
  assert.equal(c10Normalize, identityNormalize, "normalizeSpeciesId is the single authoritative function");
  assert.equal(c10Species, identitySpecies, "speciesId is the single authoritative function");
  assert.equal(c10Species({ system: { species: "  Goblin  " } }), "goblin", "behavior of the unified identity is unchanged");
  console.log("  \u2713 PASS");
}

// B. The consumer bridge reads the new registry; knowledge is keyed by the
//    SPECIES, so different actors of one species share the discovery.
console.log("Test B: consumers read the registry; species-level identity");
{
  resetWorld();
  setGM();
  const monster = makeMonster("mon-b1", "Lamia");
  const sameSpecies = makeMonster("mon-b2", "  LAMIA  "); // raw label differs; identity matches
  const otherSpecies = makeMonster("mon-b3", "Goblin");
  actorsCollection.push(monster, sameSpecies, otherSpecies);
  const result = await registerMkDiscovery(makeEvidence(monster, "lamia"));
  assert.equal(result.ok, true, "discovery registered in the active session (auto-created)");
  assert.equal(result.data.status, "registered");
  const active = readMkActiveRecord();
  assert.equal(active.ok, true, "active record read works");
  assert.equal(active.data.kind, "session", "active record is a session");
  assert.equal(speciesWeaknessKnown(monster), true, "the monster-sheet bridge reads the registry");
  assert.equal(speciesWeaknessKnown(sameSpecies), true, "knowledge is shared by species with label normalization");
  assert.equal(speciesWeaknessKnown(otherSpecies), false, "another species is not affected");
  assert.equal(isMkSpeciesKnown(" lamia "), true, "the service lookup normalizes the identifier");
  console.log("  \u2713 PASS");
}

// C. Without discoveries (fresh world, no records) consumers read unknown.
console.log("Test C: absence of discoveries reads as unknown");
{
  resetWorld();
  const monster = makeMonster("mon-c", "Wraith");
  actorsCollection.push(monster);
  assert.equal(speciesWeaknessKnown(monster), false, "no active record, no knowledge");
  assert.equal(isSpeciesWeaknessKnown(null), false, "missing identifier reads as unknown");
  assert.equal(isSpeciesWeaknessKnown("   "), false, "blank identifier reads as unknown");
  console.log("  \u2713 PASS");
}

// D. A discovery that reaches the GM through the F2-T1 relay is visible to the
//    consumer bridge on the requesting player client, and the registered
//    open sheets repaint their indicator once the setting change is announced
//    on the client (Foundry emits "clientSettingChanged"; the mock does not
//    reproduce the emission, so the dispatch below simulates it).
console.log("Test D: relay discovery reflected + open sheet repaint");
{
  resetWorld();
  setPlayer("player-1");
  initializeMonsterKnowledgeRelay();
  initializeMonsterSheetKnowledgeSync();
  assert.equal((hookListeners.get("clientSettingChanged") ?? []).length, 1, "sync subscribes exactly once");  

  const monster = makeMonster("mon-d", "Manticore");
  actorsCollection.push(monster);
  assert.equal(speciesWeaknessKnown(monster), false, "before the relay round-trip the species is unknown");

  const openSheet = openMkSheet(monster);
  const legacyBefore = legacyValue();

  const result = await requestMkRelayDiscovery(makeEvidence(monster, "manticore"), { notify: false });
  assert.equal(result.ok, true, "relay round-trip completed");
  assert.equal(result.data.status, "registered", "the GM persisted the discovery");
  assert.equal(legacyValue(), undefined, "the relay never touches the legacy weaknessRegistry");

  // The consumer bridge now reflects the persisted knowledge on the player
  // client (the bridge is a plain read; the player received the GM ack).
  assert.equal(speciesWeaknessKnown(monster), true, "bridge reflects the relay-backed discovery");

  // Foundry announces the world-setting change on every client; the open
  // sheet repaints and getData recomputes the indicator.
  consumerRepaints = 0;
  Hooks.call("clientSettingChanged", "sword-world-25.mkRegistry", worldSettings.get("sword-world-25.mkRegistry"), {});
  assert.equal(consumerRepaints, 1, "open sheet repainted exactly once on the registry change");

  // The bare-key announcement form is also accepted; both open sheets repaint.
  const another = openMkSheet(makeMonster("mon-d2", "Basilisk"));
  consumerRepaints = 0;
  Hooks.call("clientSettingChanged", "mkRegistry", null, {});
  assert.equal(consumerRepaints, 2, "bare key form announced repaints every open sheet");

  await closeMkSheet(openSheet);
  await closeMkSheet(another);
  assert.equal(legacyValue(), undefined, "legacy registry still untouched after the whole flow");
  console.log("  \u2713 PASS");
}

// E. Unrelated setting changes must not touch consumer windows.
console.log("Test E: unrelated setting keys do not repaint consumers");
{
  resetWorld();
  setGM();
  const sheet = openMkSheet(makeMonster("mon-e", "Harpy"));
  consumerRepaints = 0;
  Hooks.call("clientSettingChanged", "sword-world-25.weaknessRegistry", ["goblin"], {});
  Hooks.call("clientSettingChanged", "unrelated-game", {}, {});
  Hooks.call("clientSettingChanged", null, null);
  Hooks.call("clientSettingChanged", undefined, undefined);
  assert.equal(consumerRepaints, 0, "no repaints for keys that are not the registry");
  await closeMkSheet(sheet);
  console.log("  \u2713 PASS");
}

// F. Starting a new session replaces the record: species discovered in the
//    previous session are no longer visible, and the open sheets repaint so
//    the indicator follows the active record immediately.
console.log("Test F: session switch updates visible knowledge");
{
  resetWorld();
  setGM();
  const monster = makeMonster("mon-f", "Ogre");
  actorsCollection.push(monster);
  await registerMkDiscovery(makeEvidence(monster, "ogre"));
  assert.equal(speciesWeaknessKnown(monster), true, "known in session 1");

  const sheet = openMkSheet(monster);
  consumerRepaints = 0;
  const started = await startMkSession({ name: "Session 2" });
  assert.equal(started.ok, true, "session replacement performed");
  assert.equal(speciesWeaknessKnown(monster), false, "a species discovered in another session is not visible");
  Hooks.call("clientSettingChanged", "sword-world-25.mkRegistry", worldSettings.get("sword-world-25.mkRegistry"), {});
  assert.equal(consumerRepaints, 1, "open sheets repaint on the session switch announcement");

  // The new session accepts its own discoveries independently.
  const again = await registerMkDiscovery(makeEvidence(monster, "ogre"));
  assert.equal(again.ok, true, "discovery in session 2 registers");
  assert.equal(again.data.status, "registered", "session 2 registers its own evidence");
  assert.equal(speciesWeaknessKnown(monster), true, "session 2 knows the species again");
  consumerRepaints = 0;
  Hooks.call("clientSettingChanged", "sword-world-25.mkRegistry", null, {});
  assert.equal(consumerRepaints, 1, "repaints keep following registry changes");
  await closeMkSheet(sheet);
  console.log("  \u2713 PASS");
}

// G. Campaign pointer isolation: activating another campaign changes the
//    visible knowledge; records are independent and the consumer follows the
//    pointer in both directions.
console.log("Test G: campaign activation isolates visible knowledge");
{
  resetWorld();
  setGM();
  const monster = makeMonster("mon-g", "Basilisk");
  actorsCollection.push(monster);
  const blue = await createMkCampaign({ name: "Blue Order" });
  const rival = await createMkCampaign({ name: "Rival" });
  assert.equal(blue.ok && rival.ok, true, "campaigns created");
  const blueId = blue.data.campaignId;
  const rivalId = rival.data.campaignId;

  await activateMkCampaign(blueId);
  assert.equal((await readMkActiveRecord()).data.kind, "campaign", "active pointer is the campaign");
  await registerMkDiscovery(makeEvidence(monster, "basilisk"));
  assert.equal(speciesWeaknessKnown(monster), true, "known in the Blue Order campaign");

  await activateMkCampaign(rivalId);
  assert.equal(speciesWeaknessKnown(monster), false, "the Rival campaign does not see the Blue Order discovery");

  await activateMkCampaign(blueId);
  assert.equal(speciesWeaknessKnown(monster), true, "switching back restores the knowledge");

  // The rival campaign gains its own independent discovery through an explicit
  // record targeting; the Blue Order record remains untouched.
  const intoRival = await registerMkDiscovery(makeEvidence(monster, "basilisk"), { recordId: rivalId });
  assert.equal(intoRival.ok && intoRival.data.status, "registered", "rival campaign registers its own discovery");
  assert.equal(speciesWeaknessKnown(monster), true, "Blue Order (active) still knows the species");
  await activateMkCampaign(rivalId);
  assert.equal(speciesWeaknessKnown(monster), true, "Rival now knows it on its own record");
  console.log("  \u2713 PASS");
}

// I. The sync registration is tolerant to the headless environments that do
//    not define Hooks (same guard contract as the F1/T1 initializers).
console.log("Test I: sync registration tolerates missing Hooks");
{
  const savedHooks = globalThis.Hooks;
  try {
    globalThis.Hooks = undefined;
    initializeMonsterSheetKnowledgeSync(); // must not throw
  } finally {
    globalThis.Hooks = savedHooks;
  }
  console.log("  \u2713 PASS");
}

console.log("\n=== Monster Knowledge consumer integration finished: all scenarios verified ===");
