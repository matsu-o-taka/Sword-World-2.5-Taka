// Sword World 2.5 - F3 Monster Knowledge Registry UI tests (headless).
//
// Exercises MKRegistryManagerApp against a mocked Foundry environment and the
// real F1 service. All operations go through the service; no game.settings
// writes from the UI.

import assert from "node:assert/strict";

// ── Global Foundry environment mock ───────────────────────────────────────

const worldSettings = new Map();
const notifications = [];
const hookListeners = new Map();

class ApplicationStub {
  constructor(options = {}) {
    this.options = options;
    this.id = options.id;
    this.title = options.title;
    this._rendered = false;
  }
  async render(force, options) {
    this._rendered = true;
    return this;
  }
  async close() {
    return this;
  }
}
class FormApplicationStub {
  constructor(data = {}, options = {}) {
    this.options = options;
    this.object = data;
    this.id = options.id;
    this.title = options.title;
    this._rendered = false;
  }
  async render(force, options) {
    this._rendered = true;
    return this;
  }
  async close() {
    return this;
  }
}

globalThis.foundry = {
  appv1: {
    sheets: { Application: ApplicationStub },
    api: { Application: ApplicationStub, FormApplication: FormApplicationStub }
  },
  utils: {
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    },
    randomID() {
      return `mk-${Math.random().toString(36).slice(2, 10)}`;
    },
    mergeObject(base, patch) {
      return { ...(base ?? {}), ...(patch ?? {}) };
    }
  }
};

globalThis.Hooks = {
  on(name, fn) {
    (hookListeners.get(name) ?? hookListeners.set(name, []).get(name)).push(fn);
  },
  once(name, fn) {
    (hookListeners.get(name) ?? hookListeners.set(name, []).get(name)).push(fn);
  },
  call(name, ...args) {
    for (const fn of [...(hookListeners.get(name) ?? [])]) fn(...args);
  }
};

const gameUsers = [];
globalThis.game = {
  user: { isGM: false, id: "player-1", character: null },
  users: {
    get(id) { return gameUsers.find(u => u.id === id || u._id === id) ?? null; },
    filter(fn) { return gameUsers.filter(fn); },
    get activeGM() { return gameUsers.find(u => u.isGM && u.active) ?? null; }
  },
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, structuredClone(value)); return value; }
  },
  socket: { on() {}, emit() {} }
};

globalThis.ui = {
  notifications: {
    warn(m) { notifications.push({ kind: "warn", message: m }); },
    info(m) { notifications.push({ kind: "info", message: m }); },
    error(m) { notifications.push({ kind: "error", message: m }); }
  }
};

globalThis.Dialog = class {
  constructor(data = {}) {
    this.data = data;
  }
  async render() {
    // Simulate user clicking "confirm" on confirmation/name dialogs.
    if (this.data.buttons && this.data.buttons.confirm && this.data.buttons.confirm.callback) {
      if (this.data.content && this.data.content.includes("record-name")) {
        // Name dialog: resolve with a default name.
        this.data.buttons.confirm.callback({ find: () => ({ get: () => null }) });
      } else {
        this.data.buttons.confirm.callback();
      }
    }
    return this;
  }
  close() { return this; }
};

globalThis.fromUuid = async () => null;

// ── Import the application ────────────────────────────────────────────────

const { MKRegistryManagerApp } = await import("../module/ui/mk-registry-manager.mjs");
const {
  readMkRegistry,
  readMkActiveRecord,
  readMkSessions,
  readMkCampaigns,
  readMkDiscoveries,
  startMkSession,
  createMkCampaign,
  withdrawMkDiscovery,
  deleteMkDiscovery,
  resetMkKnowledge,
  activateMkCampaign,
  activateMkSession,
  deleteMkRecord,
  deleteMkCampaign,
  mkCapabilitiesOf,
  registerMkDiscovery
} = await import("../module/knowledge/monster-knowledge-registry.mjs");

const { MK_REGISTRY_KEY, MK_REGISTRY_VERSION } = await import("../module/knowledge/monster-knowledge-store.mjs");

// ── Helpers ───────────────────────────────────────────────────────────────

function resetWorld() {
  worldSettings.clear();
  notifications.length = 0;
  gameUsers.length = 0;
  gameUsers.push(
    { _id: "gm-user", id: "gm-user", isGM: true, active: true, name: "GameMaster" },
    { _id: "player-1", id: "player-1", isGM: false, active: true, name: "Player One" }
  );
  MKRegistryManagerApp.instance = null;
}

function setGM() {
  game.user.isGM = true;
  game.user.id = "gm-user";
}

function setPlayer() {
  game.user.isGM = false;
  game.user.id = "player-1";
}

function lastNotification(kind) {
  const msgs = notifications.filter(n => n.kind === kind).map(n => n.message);
  return msgs[msgs.length - 1] ?? null;
}

function clearNotifications() {
  notifications.length = 0;
}

// ── Tests ─────────────────────────────────────────────────────────────────

console.log("=== F3 Monster Knowledge Registry UI (headless) ===\n");

// 1. Opening without GM is rejected.
console.log("Test 1: GM-only access at open");
resetWorld();
setPlayer();
const rejected = await MKRegistryManagerApp.open();
assert.equal(rejected, null, "non-GM open returns null");
assert.equal(MKRegistryManagerApp.instance, null, "no instance created for non-GM");
assert.equal(lastNotification("warn"), "Only the Game Master can open the Monster Knowledge Manager.", "warning shown");
console.log("  ✓ PASS");

// 2. Opening as GM creates a singleton instance.
console.log("Test 2: Singleton window opening as GM");
resetWorld();
setGM();
const app = await MKRegistryManagerApp.open();
assert.ok(app instanceof MKRegistryManagerApp, "instance is MKRegistryManagerApp");
assert.equal(MKRegistryManagerApp.instance, app, "instance stored as singleton");
assert.equal(app._view, "records", "initial view is records");
console.log("  ✓ PASS");

// 3. Second opening re-renders the same instance (singleton).
console.log("Test 3: Second opening re-renders live instance");
resetWorld();
setGM();
const app1 = await MKRegistryManagerApp.open();
const app2 = await MKRegistryManagerApp.open();
assert.equal(app1, app2, "same instance returned");
assert.equal(app1._rendered, true, "instance rendered");
console.log("  ✓ PASS");

// 4. Initial screen shows records list (empty at start).
console.log("Test 4: Initial screen - empty records");
resetWorld();
setGM();
await MKRegistryManagerApp.open();
const data = await app.getData();
assert.equal(data.view, "records", "view is records");
assert.deepEqual(data.records, [], "no records initially");
console.log("  ✓ PASS");

// 5. Create a campaign.
console.log("Test 5: Create campaign with name");
resetWorld();
setGM();
await MKRegistryManagerApp.open();
clearNotifications();
const campaignResult = await createMkCampaign({ name: "Campaña de Prueba" });
assert.equal(campaignResult.ok, true, "campaign created via service");
const campaigns = readMkCampaigns();
assert.equal(campaigns.data.length, 1, "one campaign in registry");
assert.equal(campaigns.data[0].name, "Campaña de Prueba", "campaign name set");
assert.equal(campaigns.data[0].status, "archived", "campaign born archived");
clearNotifications();
console.log("  ✓ PASS");

// 6. Create a new session (replaces previous).
console.log("Test 6: Create new session replaces active");
resetWorld();
setGM();
await createMkCampaign({ name: "Campaña X" });
const camps = readMkCampaigns();
await activateMkCampaign(camps.data[0].id);
const activeBefore = readMkActiveRecord();
assert.equal(activeBefore.data.kind, "campaign", "campaign was active");
const sessionResult = await startMkSession({ name: null });
assert.equal(sessionResult.ok, true, "session created");
const activeAfter = readMkActiveRecord();
assert.equal(activeAfter.data.kind, "session", "session is now active");
assert.equal(activeAfter.data.record.discoveries.length, 0, "new session has no discoveries");
console.log("  ✓ PASS");

// 7. Create discoveries and view detail.
console.log("Test 7: Detail view shows discoveries");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll" });
await registerMkDiscovery({ speciesId: "Lamia", speciesLabel: "Lamia", source: "gm-manual" });
const discoveries = readMkDiscoveries();
assert.equal(discoveries.ok, true, "discoveries readable");
assert.equal(discoveries.data.length, 2, "two discoveries");
const goblin = discoveries.data.find(d => d.speciesId === "goblin");
assert.ok(goblin, "goblin discovery present");
assert.equal(goblin.speciesLabel, "Goblin", "species label stored");
console.log("  ✓ PASS");

// 8. Withdraw individual species from a record.
console.log("Test 8: Withdraw species from active record");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll" });
await registerMkDiscovery({ speciesId: "Lamia", speciesLabel: "Lamia", source: "gm-manual" });
const before = readMkDiscoveries();
assert.equal(before.data.length, 2, "two discoveries before withdraw");
const withdrawResult = await withdrawMkDiscovery({ speciesIdentifier: "goblin" });
assert.equal(withdrawResult.ok, true, "withdraw succeeded");
assert.equal(withdrawResult.data.status, "withdrawn", "status withdrawn");
const after = readMkDiscoveries();
assert.equal(after.data.length, 1, "one discovery after withdraw");
assert.equal(after.data[0].speciesId, "lamia", "lamia remains");
console.log("  ✓ PASS");

// 9. Reset record clears all discoveries.
console.log("Test 9: Reset record clears discoveries");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll" });
await registerMkDiscovery({ speciesId: "Lamia", speciesLabel: "Lamia", source: "gm-manual" });
const resetResult = await resetMkKnowledge();
assert.equal(resetResult.ok, true, "reset succeeded");
assert.equal(resetResult.data.removed, 2, "two discoveries removed");
const afterReset = readMkDiscoveries();
assert.equal(afterReset.data.length, 0, "record is empty after reset");
console.log("  ✓ PASS");

// 10. Campaign independence: reset campaign doesn't affect session.
console.log("Test 10: Campaign independence");
resetWorld();
setGM();
await startMkSession({ name: "Sesión A" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll" });
await createMkCampaign({ name: "Campaña B" });
const campList = readMkCampaigns();
const campaignId = campList.data[0].id;
await registerMkDiscovery({ speciesId: "Lamia", speciesLabel: "Lamia", source: "gm-manual" }, { recordId: campaignId });
const session = (await readMkSessions()).data[0];
const sessionDisc = readMkDiscoveries(session.id);
assert.equal(sessionDisc.data.length, 1, "session has 1 discovery");
assert.equal(sessionDisc.data[0].speciesId, "goblin", "session has Goblin");
const campaignDisc = readMkDiscoveries(campaignId);
assert.equal(campaignDisc.data.length, 1, "campaign has 1 discovery");
assert.equal(campaignDisc.data[0].speciesId, "lamia", "campaign has Lamia");
await resetMkKnowledge({ recordId: campaignId });
const campaignAfter = readMkDiscoveries(campaignId);
assert.equal(campaignAfter.data.length, 0, "campaign reset to empty");
const sessionAfter = readMkDiscoveries(session.id);
assert.equal(sessionAfter.data.length, 1, "session still has its discovery");
console.log("  ✓ PASS");

// 11. Capabilities gate controls.
console.log("Test 11: Capabilities via mkCapabilitiesOf");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
const sessionRecord = (await readMkSessions()).data[0];
const caps = mkCapabilitiesOf(sessionRecord);
assert.equal(caps.individualWithdraw, true, "session allows individual withdraw");
assert.equal(caps.restart, true, "session allows restart");
assert.equal(caps.deleteRecord, false, "session does not allow delete record");
assert.equal(caps.replaceOnStart, true, "session allows replace on start");
const campaign = (await createMkCampaign({ name: "Campaña C" })).data;
const campaignRecord = (await readMkCampaigns()).data[0];
const campaignCaps = mkCapabilitiesOf(campaignRecord);
assert.equal(campaignCaps.deleteRecord, true, "campaign allows delete record");
assert.equal(campaignCaps.replaceOnStart, false, "campaign does not allow replace on start");
console.log("  ✓ PASS");

// 12. Non-GM cannot write.
console.log("Test 12: Non-GM writes rejected");
resetWorld();
setPlayer();
const writeResult = await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll" });
assert.equal(writeResult.ok, false, "non-GM write rejected");
assert.equal(writeResult.code, "not-gm", "error code not-gm");
console.log("  ✓ PASS");

// 13. Detail attribution shows the CHARACTER that rolled (actorName/actorUuid),
// never the monster name behind monsterUuid (regression for the manager
// showing the monster name or a raw user id as discoverer).
console.log("Test 13: Discoverer attribution in detail view");
resetWorld();
setGM();
// Mock Actor collection: a character (the discoverer) and a monster (the
// evidence monster). getData must NOT resolve the discoverer name from the
// monster document.
const mockActorCollection = {
  discoverer: { id: "hero-1", uuid: "Actor.hero-1", name: "Hero the Sage" },
  monster: { id: "monster-1", uuid: "Actor.monster-1", name: "Goblin Overseer" },
  get(identifier) {
    return [this.discoverer, this.monster].find(a => a.uuid === identifier || a.id === identifier) ?? null;
  }
};
const realActors = globalThis.game.actors;
globalThis.game.actors = mockActorCollection;
try {
  await startMkSession({ name: "Sesión 1" });
  await registerMkDiscovery({
    speciesId: "Goblin",
    speciesLabel: "Goblin",
    source: "roll",
    monsterUuid: "Actor.monster-1",
    monsterName: "Goblin Overseer",
    actorUuid: "Actor.hero-1",
    actorName: "Hero the Sage"
  });
  const app13 = new MKRegistryManagerApp({}, {});
  const sessionRecord13 = (await readMkSessions()).data[0];
  app13._view = "detail";
  app13._targetRecord = { kind: "session", id: sessionRecord13.id, name: sessionRecord13.name, active: true };
  const data = await app13.getData();
  assert.equal(data.discoveries.length, 1, "one discovery shown");
  assert.equal(data.discoveries[0].discoveredByActorName, "Hero the Sage", "discoverer name is the rolling character, not the monster name");
  // Legacy entries without actorName resolve through the character Actor.
  await registerMkDiscovery({
    speciesId: "Lamia",
    speciesLabel: "Lamia",
    source: "gm-manual",
    monsterUuid: "Actor.monster-1",
    actorUuid: "Actor.hero-1"
  });
  const data2 = await app13.getData();
  const lamia = data2.discoveries.find(d => d.speciesId === "lamia");
  assert.equal(lamia.discoveredByActorName, "Hero the Sage", "discoverer resolved from actorUuid when actorName is absent");
  // GM-manual entries without any character actor never display the raw
  // registering user id: they read as "GM".
  await registerMkDiscovery({
    speciesId: "Harpy",
    speciesLabel: "Harpy",
    source: "gm-manual",
    discoveredBy: "user-id-code"
  });
  const data3 = await app13.getData();
  const harpy = data3.discoveries.find(d => d.speciesId === "harpy");
  assert.equal(harpy.discoveredByActorName, "GM", "GM-manual entries display 'GM' instead of the user id");
} finally {
  globalThis.game.actors = realActors;
}
console.log("  ✓ PASS");

// 14. Withdrawal/reset flows do NOT touch the ownership of the original
// monster Actors (Fase 4 model: originals are never modified).
console.log("Test 14: Withdraw and reset leave original Actor ownership untouched");
resetWorld();
setGM();
let ownershipUpdates = 0;
const realActors14 = globalThis.game.actors;
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll" });
globalThis.game.actors = {
  get() {
    return {
      system: { species: "Goblin" },
      async update() { ownershipUpdates += 1; },
      async setFlag() { }
    };
  }
};
try {
  await withdrawMkDiscovery({ speciesIdentifier: "goblin" });
  await resetMkKnowledge();
  assert.equal(ownershipUpdates, 0, "no ownership update on original actor during withdraw/reset");
} finally {
  globalThis.game.actors = realActors14;
}
console.log("  ✓ PASS");


// 15. Detail header single-line identity data: the session line carries the
// Session chip plus the record's start date/time; campaigns carry the
// Campaign chip, the name (once) and the right-aligned Active state. The
// duplicated `sw25-mk-detail-title` name line and the row-level colouring
// are gone from the template (structural template assertions, validation 10
// and the row interface checks).
console.log("Test 15: Detail header identity data (session + campaign)");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll" });
const sessionRecord15 = (await readMkSessions()).data[0];
assert.ok(Number(sessionRecord15.createdAt) > 0, "session record carries createdAt");
const app15 = new MKRegistryManagerApp({}, {});
app15._view = "detail";
app15._targetRecord = {
  kind: "session", id: sessionRecord15.id, name: sessionRecord15.name, active: true,
  createdAt: sessionRecord15.createdAt
};
const data15 = await app15.getData();
assert.equal(data15.record.typeLabel, "Session", "session identity chip label");
assert.equal(data15.record.isSession, true, "record identified as session");
assert.ok(typeof data15.record.startedAtLabel === "string" && data15.record.startedAtLabel.length > 0, "session start date/time formatted for the header line");
await createMkCampaign({ name: "Campaña Línea" });
const campaigns15 = await readMkCampaigns();
const campaignRecord15 = campaigns15.data[0];
assert.equal(campaignRecord15.name, "Campaña Línea", "campaign record keeps its own name, rendered once in the header");
const app15b = new MKRegistryManagerApp({}, {});
app15b._view = "detail";
app15b._targetRecord = {
  kind: "campaign", id: campaignRecord15.id, name: campaignRecord15.name, active: false,
  createdAt: campaignRecord15.createdAt
};
const data15b = await app15b.getData();
assert.equal(data15b.record.isCampaign, true, "record identified as campaign");
assert.equal(data15b.record.active, false, "inactive campaign exposes its state for the right-aligned chip");

// Structural template assertions: one line, no duplicated name, new rows.
const fs15 = await import("node:fs");
const template15 = fs15.readFileSync(new URL("../templates/ui/mk-registry-manager.hbs", import.meta.url), "utf-8");
assert.ok(!template15.includes("sw25-mk-detail-title"), "no duplicated name line under the header");
assert.ok(template15.includes("sw25-mk-detail-date"), "session date chip present in the header line");
assert.ok(template15.includes("{{record.statusLabel}}"), "Active/Inactive label rendered on the main list rows");
assert.ok(template15.includes("sw25-mk-list-toggle"), "Active toggle present on the main list rows");
assert.ok(template15.includes("sw25-mk-list-x"), "record delete X present on the main list rows");
assert.ok(template15.includes("mk-remove-species"), "species red X performs the direct entry removal");
assert.ok(template15.includes("mk-add-monster"), "manual Add Monster action present in the detail");
assert.ok(template15.includes('class="sw25-mk-withdraw-x"'), "withdraw X present");
assert.ok(template15.includes("{{#if ../canWithdraw}}"), "withdraw X gate resolves canWithdraw from the PARENT context: inside {{#each discoveries as |discovery|}} an unqualified {{#if canWithdraw}} never finds the state-level flag and the X would never render");
assert.ok(template15.includes("fa-times"), "withdraw X uses the recognizable X icon");
assert.ok(!template15.includes("discovery.levelColor"), "no row-level knowledge colour left");
assert.ok(template15.includes('<li class="sw25-mk-discovery-row">'), "row keeps a clean neutral background class");
assert.ok(template15.includes("sw25-mk-discoverer-pill"), "discoverer rendered in a neutral pill");
assert.ok(template15.includes("sw25-mk-pill {{discovery.levelPillClass}}"), "species name rendered as a level pill");
console.log("  ✓ PASS");

// 16. Discovery row data: the knowledge level travels ONLY as the species
// pill class (weakness green / reputation yellow); the row no longer
// carries a level colour anywhere.
console.log("Test 16: Row level pills (weakness/reputation) without row background");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll", level: "weakness" });
await registerMkDiscovery({ speciesId: "Lamia", speciesLabel: "Lamia", source: "gm-manual" });
const sessionRecord16 = (await readMkSessions()).data[0];
const app16 = new MKRegistryManagerApp({}, {});
app16._view = "detail";
app16._targetRecord = { kind: "session", id: sessionRecord16.id, name: sessionRecord16.name, active: true };
const data16 = await app16.getData();
const goblin16 = data16.discoveries.find(d => d.speciesId === "goblin");
const lamia16 = data16.discoveries.find(d => d.speciesId === "lamia");
assert.equal(goblin16.levelPillClass, "sw25-mk-level-weakness", "weakness species pill is green");
assert.equal(goblin16.levelLabel, "Weakness discovered", "weakness pill has its tooltip label");
assert.equal(lamia16.levelPillClass, "sw25-mk-level-reputation", "reputation species pill is yellow");
assert.equal(lamia16.levelLabel, "Reputation identified", "reputation pill has its tooltip label");
assert.ok(!("levelColor" in goblin16), "row data exposes no level row-colour class");
assert.ok(typeof goblin16.discoveredByActorName === "string", "discoverer name available for the neutral pill");
console.log("  ✓ PASS");

// 17. Withdraw semantics behind the red X (the operation withdraws the
// REGISTERED KNOWLEDGE of the species, not the character credit):
// withdrawing weakness degrades to reputation and keeps the Bestiary copy
// pointer; withdrawing reputation removes the discovery (validation 7/8).
console.log("Test 17: Withdraw X semantics (degrade weakness, remove reputation)");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll", level: "weakness", monsterUuid: "Actor.monster-goblin" });
const demote17 = await withdrawMkDiscovery({ speciesIdentifier: "goblin" });
assert.equal(demote17.ok, true, "weakness withdraw ok");
assert.equal(demote17.data.removed, 0, "weakness withdraw removes nothing");
assert.equal(demote17.data.demotedTo, "reputation", "weakness degrades to reputation");
const afterDemote17 = await readMkDiscoveries();
assert.equal(afterDemote17.data.length, 1, "species still registered after demotion");
assert.equal(afterDemote17.data[0].level, "reputation", "level is reputation after withdrawal");
assert.equal(afterDemote17.data[0].bestiaryActorUuid, "mock-copy", "Bestiary copy kept through the demotion");
const remove17 = await withdrawMkDiscovery({ speciesIdentifier: "goblin" });
assert.equal(remove17.ok, true, "reputation withdraw ok");
assert.equal(remove17.data.removed, 1, "reputation withdraw removes the discovery");
const afterRemove17 = await readMkDiscoveries();
assert.equal(afterRemove17.data.length, 0, "no discovery remains after reputation withdrawal");
console.log("  ✓ PASS");

// 18. Without GM authority the withdrawal is refused with a clear error and
// NO store write happens (validation 9).
console.log("Test 18: Withdraw without GM is refused without local writes");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll", level: "weakness" });
const registryBefore18 = JSON.stringify(worldSettings.get("sw25-taka.mkRegistry"));
globalThis.game.user.isGM = false;
try {
  const refused18 = await withdrawMkDiscovery({ speciesIdentifier: "goblin" });
  assert.equal(refused18.ok, false, "withdrawal refused without GM");
  assert.equal(refused18.code, "not-gm", "refusal code is not-gm");
  assert.equal(JSON.stringify(worldSettings.get("sw25-taka.mkRegistry")), registryBefore18, "registry unchanged (no local write)");
} finally {
  globalThis.game.user.isGM = true;
}
console.log("  ✓ PASS");

// 19. Promotion (weakness over reputation) keeps a single row and shows the
// attribution of the character that completed the weakness roll
// (validation 6 at UI level; no-duplicate semantics covered in Test 15 of
// the relay suite and tests 4/16 of the Bestiary copy suite).
console.log("Test 19: Promotion keeps one row with the weakness attribution");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({
  speciesId: "Goblin", speciesLabel: "Goblin", source: "roll", level: "reputation",
  actorName: "Hero the Rider", discoveredBy: "player-1"
});
const sessionRecord19 = (await readMkSessions()).data[0];
await registerMkDiscovery({
  speciesId: "Goblin", speciesLabel: "Goblin", source: "roll", level: "weakness",
  actorUuid: "Actor.hero-2", actorName: "Hero the Sage", discoveredBy: "player-2"
});
const app19 = new MKRegistryManagerApp({}, {});
app19._view = "detail";
app19._targetRecord = { kind: "session", id: sessionRecord19.id, name: sessionRecord19.name, active: true };
const data19 = await app19.getData();
assert.equal(data19.discoveries.length, 1, "single row after promotion (no duplicates)");
assert.equal(data19.discoveries[0].level, "weakness", "row level is weakness");
assert.equal(data19.discoveries[0].discoveredByActorName, "Hero the Sage", "row shows the character that completed the weakness roll");
assert.equal(data19.discoveries[0].levelPillClass, "sw25-mk-level-weakness", "row pill reflects the promoted level");
console.log("  ✓ PASS");

// 20. The active-register toggle NEVER clears the pointer: it only moves it
// between records. Exactly one register is active at all times, and turning
// an active row's toggle is impossible (disabled in the list).
console.log("Test 20: Toggle always keeps exactly one active register");
resetWorld();
setGM();
await startMkSession({ name: "Sesión A" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll" });
const sessions20 = (await readMkSessions()).data;
assert.equal(sessions20.length, 1, "session A in the registry");
const app20 = new MKRegistryManagerApp({}, {});
app20._view = "records";
const data20 = await app20.getData();
const row20 = data20.records.find(r => r.kind === "session");
assert.equal(row20.active, true, "row marks the active session");
assert.equal(row20.statusLabel, "Active", "row carries the Active label");
assert.match(row20.statusClass, /\bsw25-mk-record-status active\b/, "row status class marks active");
const pointer20 = readMkActiveRecord();
assert.equal(pointer20.data.kind, "session", "the active pointer survives (never cleared by the toggle)");
assert.equal(pointer20.data.record.name, "Sesión A", "the session with its discovery stays active");
await activateMkCampaign((await createMkCampaign({ name: "Campaña B" })).data.campaignId);
const pointer20b = readMkActiveRecord();
assert.equal(pointer20b.data.kind, "campaign", "activating a campaign takes the pointer (still exactly one active)");
await activateMkSession(sessions20[0].id);
const pointer20c = readMkActiveRecord();
assert.equal(pointer20c.data.kind, "session", "activating the session moves the pointer back (default: session)");
// Structural check: the template disables the toggle on active rows and
// offers no deactivate action anywhere.
const fs20 = await import("node:fs");
const template20 = fs20.readFileSync(new URL("../templates/ui/mk-registry-manager.hbs", import.meta.url), "utf-8");
assert.ok(template20.includes("{{#if record.active}}disabled{{/if}}"), "the active row's toggle button is disabled");
assert.ok(template20.includes("Set as the active register"), "the toggle tooltip is the concise activation hint");
assert.ok(!template20.includes("mk-deactivate-record"), "no deactivate action exists in the UI");
console.log("  ✓ PASS");

// 21. Activate a campaign after a session (single pointer switches, nothing
// is destroyed); activating a session back removes the campaign pointer.
console.log("Test 21: Session/campaign pointer exclusivity");
resetWorld();
setGM();
await startMkSession({ name: "Sesión AC" });
const campaign21 = await createMkCampaign({ name: "Campaña AC" });
const campaignRecord21 = (await readMkCampaigns()).data.find(c => c.name === "Campaña AC");
await activateMkCampaign(campaignRecord21.id);
const pointer21 = readMkActiveRecord();
assert.equal(pointer21.data.kind, "campaign", "campaign holds the pointer after activation");
const sessionsAfter21 = (await readMkSessions()).data;
assert.equal(sessionsAfter21.length, 1, "the session record survives campaign activation");
await activateMkSession(sessionsAfter21[0].id);
const pointer21b = readMkActiveRecord();
assert.equal(pointer21b.data.kind, "session", "activating the session takes the pointer from the campaign");
const app21 = new MKRegistryManagerApp({}, {});
app21._view = "records";
const data21 = await app21.getData();
assert.equal(data21.records.find(r => r.kind === "campaign").statusLabel, "Inactive", "campaign row reads Inactive");
assert.equal(data21.records.find(r => r.kind === "session").statusLabel, "Active", "session row reads Active");
console.log("  ✓ PASS");

// 22. deleteMkRecord: the red X correction deletes a session record with its
// discoveries; the pointer ALWAYS re-points while sessions remain (default:
// newest session), and is only cleared when no session exists. Two sessions
// are seeded directly (the runtime model is singular; leftovers occur when
// records are created out-of-band).
console.log("Test 22: Delete record red X (sessions)");
resetWorld();
setGM();
const now22 = Date.now();
const registry22 = {
  version: MK_REGISTRY_VERSION,
  active: { kind: "session", id: "s-del" },
  sessions: [
    { id: "s-del", kind: "session", name: "Sesión Errónea", createdAt: now22 - 1000, updatedAt: now22 - 1000, status: "active", policy: { name: "session-generic", capabilities: {} }, discoveries: [{ id: "d-1", speciesId: "goblin", speciesLabel: "Goblin", className: "sage", classResult: 15, discoveredBy: "gm-user", discoveredAt: now22 - 1000, source: "roll", level: "weakness" }] },
    { id: "s-keep", kind: "session", name: "Sesión Real", createdAt: now22, updatedAt: now22, status: "archived", policy: { name: "session-generic", capabilities: {} }, discoveries: [] }
  ],
  campaigns: []
};
worldSettings.set(`sw25-taka.${MK_REGISTRY_KEY}`, registry22);
const deleteSession22 = await deleteMkRecord("s-del");
assert.equal(deleteSession22.ok, true, "older session deletion accepted");
assert.equal(deleteSession22.data.recordKind, "session", "deleted record kind reported");
assert.equal(deleteSession22.data.removedKnowledge, 1, "session's discovery removed with it");
const afterPointer22 = readMkActiveRecord();
assert.equal(afterPointer22.data.kind, "session", "the active register survives the delete");
assert.equal(afterPointer22.data.record.name, "Sesión Real", "the pointer re-points to the remaining session (default: session)");
await createMkCampaign({ name: "Campaña Final" });
const deleteAll22 = await deleteMkRecord("s-keep");
assert.equal(deleteAll22.ok, true, "remaining session deletion accepted");
const afterPointer22b = readMkActiveRecord();
assert.equal(afterPointer22b.data.kind, null, "the pointer is only cleared when NO session remains (next discovery auto-creates one)");
assert.equal((await readMkCampaigns()).data.length, 1, "campaign survives the session deletes");
const missing22 = await deleteMkRecord("s-keep");
assert.equal(missing22.ok, false, "deleting again is refused (not found)");
assert.equal(missing22.code, "record-not-found", "refusal code is record-not-found");
console.log("  ✓ PASS");

// 23. deleteMkDiscovery: the species red X removes the entry at ANY level
// (weakness included) without demoting, and reports not-found afterwards.
console.log("Test 23: Delete species entry removes weakness directly");
resetWorld();
setGM();
await startMkSession({ name: "Sesión 1" });
await registerMkDiscovery({ speciesId: "Goblin", speciesLabel: "Goblin", source: "roll", level: "weakness" });
await registerMkDiscovery({ speciesId: "Lamia", speciesLabel: "Lamia", source: "gm-manual", level: "reputation" });
const remove23 = await deleteMkDiscovery({ speciesIdentifier: "goblin" });
assert.equal(remove23.ok, true, "weakness entry removal accepted");
assert.equal(remove23.data.status, "removed", "status removed (not the demote path)");
assert.equal(remove23.data.removed, 1, "the whole entry was removed");
assert.equal(remove23.data.level, "weakness", "the removed entry's level was weakness");
const after23 = readMkDiscoveries();
assert.equal(after23.data.length, 1, "one species remains");
assert.equal(after23.data[0].speciesId, "lamia", "lamia remains untouched");
const notFound23 = await deleteMkDiscovery({ speciesIdentifier: "goblin" });
assert.equal(notFound23.ok, true, "removing a missing species is a no-op");
assert.equal(notFound23.data.status, "not-found", "status not-found for missing entry");
const missingRecord23 = await deleteMkDiscovery({ speciesIdentifier: "goblin", recordId: "nope" });
assert.equal(missingRecord23.ok, false, "removing against a missing record refused");
assert.equal(missingRecord23.code, "record-not-found", "record-not-found for unknown record");
console.log("  ✓ PASS");

console.log("\n=== F3 Monster Knowledge Registry UI tests completed ===");
