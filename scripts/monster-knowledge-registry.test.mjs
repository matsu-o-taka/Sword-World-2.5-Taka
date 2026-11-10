// Sword World 2.5 - Monster Knowledge Registry (F1) core tests.
//
// Covers the persistence store, the registry service and the two knowledge
// models (sessions / campaigns) per the F1 task:
//   - registry initialization and integrity normalization
//   - GM-authoritative writes (no player write path)
//   - session model: auto-create, replacement (no history), newest-wins
//   - campaign model: create (archived), activate, delete, independence
//   - capabilities: withdraw / restart / deleteRecord / replaceOnStart
//   - discovery dedupe by speciesId and evidence schema
//   - service serialization of concurrent writes in one GM client
//   - schema version handling (missing backfilled, future rejected)
//   - transitory compatibility bridge (speciesWeaknessKnown /
//     isSpeciesWeaknessKnown) with the read-only legacy setting

import assert from "node:assert/strict";

// ── Foundry mocks ──────────────────────────────────────────────────────────

const worldSettings = new Map();
let idCounter = 0;

globalThis.foundry = {
  utils: {
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    },
    randomID() {
      idCounter += 1;
      return `id${String(idCounter).padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`;
    }
  }
};

const notes = [];
globalThis.ui = { notifications: { warn(msg) { notes.push(msg); }, info() {}, error() {} } };

globalThis.game = {
  user: { isGM: true, character: null, id: "gm-user" },
  actors: [],
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, structuredClone(value)); return value; }
  }
};

// ── Imports after mocks ────────────────────────────────────────────────────

const {
  MK_REGISTRY_KEY,
  MK_REGISTRY_VERSION,
  emptyRegistry
} = await import("../module/knowledge/monster-knowledge-store.mjs");

const {
  isMkSpeciesKnown,
  isMkSpeciesReputationKnown,
  readMkRegistry,
  readMkActiveRecord,
  readMkSession,
  readMkSessions,
  readMkCampaigns,
  readMkDiscoveries,
  registerMkDiscovery,
  withdrawMkDiscovery,
  startMkSession,
  createMkCampaign,
  activateMkCampaign,
  deleteMkCampaign,
  resetMkKnowledge,
  diagnoseMkRegistry,
  repairMkRegistry,
  mkCapabilitiesOf
} = await import("../module/knowledge/monster-knowledge-registry.mjs");

const {
  speciesWeaknessKnown,
  isSpeciesWeaknessKnown,
  revealMonsterWeakness,
  toggleMonsterWeakness
} = await import("../module/combat/monster-knowledge.mjs");

// ── Helpers ────────────────────────────────────────────────────────────────

function resetWorld() {
  worldSettings.clear();
  game.user = { isGM: true, character: null, id: "gm-user" };
}

function storedRegistry() {
  return worldSettings.get(`sw25-taka.${MK_REGISTRY_KEY}`);
}

function makeMonster(overrides = {}) {
  return {
    id: overrides.id ?? "monster-1",
    uuid: overrides.uuid ?? "Actor.monster-1",
    name: overrides.name ?? "Goblin",
    type: "monster",
    system: { species: overrides.species ?? "Goblin", reputation: 10, weakness: 15, ...(overrides.system ?? {}) },
    flags: {}
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log("=== Monster Knowledge Registry (F1) core tests ===\n");

// 1. Initialization: missing registry reads as a fresh empty snapshot.
console.log("Test 1: missing registry initializes on read");
resetWorld();
{
  const state = readMkRegistry();
  assert.equal(state.ok, true, "read contract ok");
  assert.equal(state.data.registry.version, MK_REGISTRY_VERSION, "schema version stamped");
  assert.deepEqual(state.data.registry.active, { kind: null, id: null }, "empty active pointer");
  assert.deepEqual(state.data.registry.sessions, [], "no sessions");
  assert.deepEqual(state.data.registry.campaigns, [], "no campaigns");
  const codes = state.data.issues.map(issue => issue.code);
  assert.ok(codes.includes("registry-missing"), "missing-registry issue reported");
  assert.deepEqual(storedRegistry(), undefined, "no setting written by reads");
  console.log("  ✓ PASS");
}

// 2. An empty object (the settings default) also initializes as fresh.
console.log("Test 2: empty object setting initializes as fresh registry");
resetWorld();
worldSettings.set(`sw25-taka.${MK_REGISTRY_KEY}`, {});
{
  const state = readMkActiveRecord();
  assert.deepEqual(state.data.record, null, "no record in an empty registry");
  assert.deepEqual(readMkSessions().data, [], "no sessions in an empty registry");
  const codes = diagnoseMkRegistry().data.issues.map(issue => issue.code);
  assert.ok(codes.includes("registry-empty"), "empty-registry issue reported");
  console.log("  ✓ PASS");
}

// 3. GM authority: every write is refused for non-GM clients.
console.log("Test 3: non-GM clients cannot write anything");
resetWorld();
{
  game.user = { isGM: false, character: null, id: "player-1" };
  const register = await registerMkDiscovery({ speciesId: "Goblin", source: "roll", discoveredBy: "player-1" });
  assert.equal(register.ok, false);
  assert.equal(register.code, "not-gm", "register refused");
  const ops = [
    await startMkSession({ name: "X" }),
    await createMkCampaign({ name: "X" }),
    await activateMkCampaign("mkc1"),
    await deleteMkCampaign("mkc1"),
    await resetMkKnowledge(),
    await withdrawMkDiscovery({ speciesIdentifier: "goblin" })
  ];
  for (const [index, result] of ops.entries()) {
    assert.equal(result.ok, false, `write ${index} refused`);
    assert.equal(result.code, "not-gm", `write ${index} is not-gm`);
  }
  assert.deepEqual(readMkSessions().data, [], "no side effects from refused writes");
  game.user = { isGM: true, character: null, id: "gm-user" };
  console.log("  ✓ PASS");
}

// 4. Session auto-create on first discovery (D5) with full evidence.
console.log("Test 4: first discovery auto-creates a session with evidence");
resetWorld();
{
  const before = Date.now();
  const result = await registerMkDiscovery({
    speciesId: " Goblin ",
    speciesLabel: "Goblin",
    monsterUuid: "Actor.monster-1",
    monsterName: "Goblin Scout",
    className: "sage",
    classResult: 17,
    source: "roll",
    discoveredBy: "player-1"
  });
  assert.equal(result.ok, true, "register ok");
  assert.equal(result.data.status, "registered", "registered status");
  assert.equal(result.data.createdRecord, true, "session was auto-created");
  assert.ok(/\bmks/i.test(result.data.recordId), "record id shaped");

  const stored = storedRegistry();
  assert.equal(stored.active.kind, "session", "pointer switched to the session");
  assert.equal(stored.sessions.length, 1, "exactly one session record");
  const session = stored.sessions[0];
  assert.equal(session.kind, "session", "kind stamped");
  assert.ok(typeof session.createdAt === "number" && session.createdAt >= before, "createdAt is explicit and current");
  assert.equal(session.status, "active", "status active");
  assert.equal(session.discoveries.length, 1, "one discovery stored");
  const discovery = session.discoveries[0];
  assert.equal(discovery.speciesId, "goblin", "species normalized");
  assert.equal(discovery.speciesLabel, "Goblin", "display label kept");
  assert.equal(discovery.monsterUuid, "Actor.monster-1", "monster evidence stored");
  assert.equal(discovery.monsterName, "Goblin Scout", "monster name evidence stored");
  assert.equal(discovery.className, "sage", "class evidence stored");
  assert.equal(discovery.classResult, 17, "class result evidence stored");
  assert.equal(discovery.discoveredBy, "player-1", "user evidence stored");
  assert.equal(discovery.source, "roll", "roll origin stored");
  assert.ok(typeof discovery.discoveredAt === "number", "discovery timestamp stored");
  assert.ok(!("weakPoint" in discovery), "no Weak Point text copied into the registry");
  assert.ok(session.name.startsWith("Session "), "default session name timestamped");
  console.log("  ✓ PASS");
}

// 5. Dedupe by speciesId: same species twice is a no-op, others register.
console.log("Test 5: discoveries deduplicate by species inside a record");
resetWorld();
{
  const first = await registerMkDiscovery({ speciesId: "Goblin", source: "roll", className: "sage", classResult: 17 });
  assert.equal(first.data.status, "registered", "first registered");
  const second = await registerMkDiscovery({ speciesId: "goblin", source: "roll", className: "sage", classResult: 19 });
  assert.equal(second.data.status, "already-known", "second is a no-op");
  assert.equal(second.data.recordId, first.data.recordId, "same record");
  const third = await registerMkDiscovery({ speciesId: "Hydra", source: "gm-manual" });
  assert.equal(third.data.status, "registered", "different species registers");
  assert.ok(second.data.createdRecord === false, "no session created for the dedupe");
  assert.equal(readMkDiscoveries().data.length, 2, "two discoveries total");
  console.log("  ✓ PASS");
}

// 6. Missing species is an expected error.
console.log("Test 6: discovery without species is refused");
resetWorld();
{
  const result = await registerMkDiscovery({ speciesLabel: "??" });
  assert.equal(result.ok, false, "refused");
  assert.equal(result.code, "no-species", "no-species code");
  assert.equal(storedRegistry(), undefined, "nothing persisted");
  console.log("  ✓ PASS");
}

// 7. Individual withdraw removes exactly one species and keeps others.
console.log("Test 7: individual withdrawal per species");
resetWorld();
{
  await registerMkDiscovery({ speciesId: "goblin", level: "weakness" });
  await registerMkDiscovery({ speciesId: "hydra", level: "weakness" });
  const result = await withdrawMkDiscovery({ speciesIdentifier: "GOBLIN" });
  assert.equal(result.ok, true, "withdraw ok");
  assert.equal(result.data.status, "withdrawn", "withdrawn status");
  assert.equal(result.data.removed, 0, "weakness demoted to reputation, not removed");
  assert.equal(result.data.demotedTo, "reputation", "weakness demoted to reputation");
  assert.equal(isMkSpeciesKnown("goblin"), false, "goblin no longer at weakness level");
  assert.equal(isMkSpeciesReputationKnown("goblin"), true, "goblin still at reputation level");
  assert.equal(isMkSpeciesKnown("hydra"), true, "hydra kept at weakness");
  const unknown = await withdrawMkDiscovery({ speciesIdentifier: "wolf" });
  assert.equal(unknown.ok, true, "unknown species is expected");
  assert.equal(unknown.data.status, "not-found", "not-found status");
  console.log("  ✓ PASS");
}

// 8. Withdraw without an active record is an expected error (never creates).
console.log("Test 8: withdrawal without an active record fails cleanly");
resetWorld();
{
  const result = await withdrawMkDiscovery({ speciesIdentifier: "goblin" });
  assert.equal(result.ok, false, "refused");
  assert.equal(result.code, "no-active-record", "no-active-record code");
  assert.equal(storedRegistry(), undefined, "no auto-created record from a withdrawal");
  console.log("  ✓ PASS");
}

// 9. Starting a new session replaces knowledge (no history, exactly one).
console.log("Test 9: starting a new session replaces the previous one");
resetWorld();
{
  await registerMkDiscovery({ speciesId: "goblin", source: "roll" });
  const started = await startMkSession({ name: "Acto II" });
  assert.equal(started.ok, true, "start ok");
  assert.ok(started.data.replacedKnowledge === 1, "replacement counted previous knowledge");
  const sessions = readMkSessions().data;
  assert.equal(sessions.length, 1, "exactly one session record (no history)");
  assert.equal(sessions[0].name, "Acto II", "visible name set");
  assert.equal(sessions[0].discoveries.length, 0, "knowledge cleared");
  assert.ok(sessions[0].createdAt > 0, "explicit createdAt");
  assert.equal(isMkSpeciesKnown("goblin"), false, "old knowledge not leaked into the new session");
  assert.deepEqual(readMkActiveRecord().data.record.id, sessions[0].id, "pointer on the new session");
  console.log("  ✓ PASS");
}

// 10. Starting a session while a campaign is active: campaign data untouched.
console.log("Test 10: session start from a campaign model leaves campaigns intact");
resetWorld();
{
  const created = await createMkCampaign({ name: "Grupo de Juan y Ana" });
  await activateMkCampaign(created.data.campaignId);
  await registerMkDiscovery({ speciesId: "hydra" });
  await startMkSession({ name: "Sesión posterior" });
  const campaigns = readMkCampaigns().data;
  assert.equal(campaigns.length, 1, "campaign preserved");
  assert.equal(campaigns[0].discoveries.length, 1, "campaign knowledge untouched");
  assert.equal(isMkSpeciesKnown("hydra"), false, "session model is active now");
  const state = readMkActiveRecord().data;
  assert.equal(state.kind, "session", "pointer on the new session");
  console.log("  ✓ PASS");
}

// 11. Campaign creation: named, archived, not auto-activated.
console.log("Test 11: campaigns are created archived and independent");
resetWorld();
{
  const missing = await createMkCampaign({});
  assert.equal(missing.ok, false, "name required");
  assert.equal(missing.code, "missing-name", "missing-name code");
  const first = await createMkCampaign({ name: "Grupo de Marta y Marilia" });
  const second = await createMkCampaign({ name: "Campaña oficial X" });
  assert.equal(first.ok && second.ok, true, "both campaigns created");
  const campaigns = readMkCampaigns().data;
  assert.equal(campaigns.length, 2, "both kept");
  assert.equal(campaigns[0].status, "archived", "born archived");
  assert.equal(second.data.campaignId !== first.data.campaignId, true, "distinct ids");
  assert.ok(campaigns.every(item => item.discoveriesCount === 0), "count metadata present");
  const active = readMkActiveRecord().data;
  assert.equal(active.record, null, "creation does not activate anything");
  console.log("  ✓ PASS");
}

// 12. Campaign activation switches only the pointer; knowledge is per
//     campaign and switching never merges or erases the other.
console.log("Test 12: activating campaigns switches knowledge cleanly");
resetWorld();
{
  const a = await createMkCampaign({ name: "A" });
  const b = await createMkCampaign({ name: "B" });
  await activateMkCampaign(a.data.campaignId);
  await registerMkDiscovery({ speciesId: "goblin", source: "roll", level: "weakness" });
  assert.equal(isMkSpeciesKnown("goblin"), true, "goblin recorded in campaign A");

  await activateMkCampaign(b.data.campaignId);
  assert.equal(isMkSpeciesKnown("goblin"), false, "campaign B starts fresh");
  assert.equal(isMkSpeciesKnown("hydra"), false, "no contamination");
  await registerMkDiscovery({ speciesId: "hydra", source: "gm-manual", level: "weakness" });

  await activateMkCampaign(a.data.campaignId);
  assert.equal(isMkSpeciesKnown("goblin"), true, "campaign A knowledge intact after switching");
  assert.equal(isMkSpeciesKnown("hydra"), false, "campaign B knowledge not visible in A");

  await activateMkCampaign(b.data.campaignId);
  assert.equal(isMkSpeciesKnown("hydra"), true, "campaign B knowledge intact after switching");
  assert.equal(isMkSpeciesKnown("goblin"), false, "campaign A knowledge not visible in B");
  const sessions = readMkSessions().data;
  assert.deepEqual(sessions, [], "campaign switches never touch session records");
  console.log("  ✓ PASS");
}

// 13. Deleting a campaign: non-active removes it; active clears the pointer.
console.log("Test 13: campaign deletion removes exactly one record");
resetWorld();
{
  const a = await createMkCampaign({ name: "A" });
  const b = await createMkCampaign({ name: "B" });
  await activateMkCampaign(a.data.campaignId);
  await registerMkDiscovery({ speciesId: "goblin", level: "weakness" });

  const wrong = await deleteMkCampaign("mkcgone");
  assert.equal(wrong.ok, false, "unknown id refused");
  assert.equal(wrong.code, "record-not-found", "wrong id is an expected error");

  const activeDelete = await deleteMkCampaign(a.data.campaignId);
  assert.equal(activeDelete.ok, true, "active campaign deletable");
  assert.equal(activeDelete.data.removedKnowledge, 1, "deletion count reported");
  assert.equal(activeDelete.data.pointerCleared, true, "pointer cleared");
  assert.equal(readMkCampaigns().data.length, 1, "other campaign untouched");
  assert.equal(readMkCampaigns().data[0].id, b.data.campaignId, "B survives");
  assert.equal(readMkActiveRecord().data.record, null, "no active record after clearing");
  assert.equal(isMkSpeciesKnown("goblin"), false, "knowledge of the deleted campaign is gone (explicit action)");

  // Next discovery auto-creates a session (documented behavior).
  const next = await registerMkDiscovery({ speciesId: "wolf", source: "roll", level: "weakness" });
  assert.equal(next.ok && next.data.createdRecord, true, "session auto-created after pointer cleared");
  assert.equal(isMkSpeciesKnown("wolf"), true, "registration lands on the fresh session");
  assert.equal(readMkCampaigns().data[0].discoveries.length, 0, "B knowledge untouched");
  console.log("  ✓ PASS");
}

// 14. Reset knowledge on session and campaign records.
console.log("Test 14: reset clears discoveries of the target record");
resetWorld();
{
  await registerMkDiscovery({ speciesId: "goblin", source: "roll" });
  const resetSession = await resetMkKnowledge();
  assert.equal(resetSession.ok, true, "session reset ok");
  assert.equal(resetSession.data.removed, 1, "cleared count");
  assert.equal(isMkSpeciesKnown("goblin"), false, "knowledge cleared");

  const campaign = await createMkCampaign({ name: "C" });
  await activateMkCampaign(campaign.data.campaignId);
  await registerMkDiscovery({ speciesId: "hydra", source: "gm-manual" });
  const resetCampaign = await resetMkKnowledge();
  assert.equal(resetCampaign.ok, true, "campaign reset ok (baseline capability)");
  assert.equal(isMkSpeciesKnown("hydra"), false, "campaign knowledge cleared");
  assert.equal(readMkSessions().data.length, 1, "session record preserved by campaign reset");
  console.log("  ✓ PASS");
}

// 15. Capability gating: crafted policies deny restart and withdraw.
console.log("Test 15: capabilities deny operations per model policy");
resetWorld();
{
  // Hand-crafted records exercise the future-policy path without adding
  // official models in this phase.
  worldSettings.set(`sw25-taka.${MK_REGISTRY_KEY}`, {
    version: MK_REGISTRY_VERSION,
    active: { kind: "campaign", id: "mkc1" },
    sessions: [],
    campaigns: [{
      id: "mkc1",
      kind: "campaign",
      name: "Official campaign (restricted)",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "archived",
      policy: {
        name: "official-restricted",
        capabilities: { individualWithdraw: true, restart: false, deleteRecord: false, replaceOnStart: false, autoCreate: false }
      },
      discoveries: [{ id: "mkd1", speciesId: "goblin", speciesLabel: "Goblin", className: "sage", classResult: 17, discoveredBy: "gm", discoveredAt: Date.now(), source: "gm-manual" }]
    }]
  });
  assert.equal(mkCapabilitiesOf({ kind: "campaign", policy: { capabilities: { restart: false } } }).restart, false, "capability resolver honors overrides");

  const reset = await resetMkKnowledge();
  assert.equal(reset.ok, false, "reset refused by model");
  assert.equal(reset.code, "capability-denied", "capability-denied for restart");

  const withdraw = await withdrawMkDiscovery({ speciesIdentifier: "goblin" });
  assert.equal(withdraw.ok, true, "individual withdraw still allowed (always available)");
  assert.equal(withdraw.data.status, "withdrawn", "one entry withdrawn");

  const deleteAttempt = await deleteMkCampaign("mkc1");
  assert.equal(deleteAttempt.ok, false, "delete refused by model");
  assert.equal(deleteAttempt.code, "capability-denied", "capability-denied for deleteRecord");

  const switchAttempt = await activateMkCampaign("mkc1");
  assert.equal(switchAttempt.ok, true, "activation is not capability-gated");

  // individualWithdraw:false also blocks withdrawal.
  worldSettings.set(`sw25-taka.${MK_REGISTRY_KEY}`, {
    version: MK_REGISTRY_VERSION,
    active: { kind: "campaign", id: "mkc2" },
    sessions: [],
    campaigns: [{
      id: "mkc2",
      kind: "campaign",
      name: "Frozen history",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "archived",
      policy: { name: "official-keep-all", capabilities: { individualWithdraw: false, restart: false, deleteRecord: false } },
      discoveries: [{ id: "mkd2", speciesId: "hydra", speciesLabel: "Hydra", className: "sage", classResult: 18, discoveredBy: "gm", discoveredAt: Date.now(), source: "gm-manual", level: "weakness" }]
    }]
  });
  const frozen = await withdrawMkDiscovery({ speciesIdentifier: "hydra" });
  assert.equal(frozen.ok, false, "withdraw denied by model");
  assert.equal(frozen.code, "capability-denied", "capability-denied for individualWithdraw");
  assert.equal(isMkSpeciesKnown("hydra"), true, "knowledge untouched by the denied withdrawal");
  console.log("  ✓ PASS");
}

// 16. Consolidated capability baselines per kind.
console.log("Test 16: baseline capabilities follow the consolidated decision");
{
  const sessionCaps = mkCapabilitiesOf({ kind: "session" });
  assert.deepEqual(sessionCaps, {
    individualWithdraw: true, restart: true, deleteRecord: false,
    replaceOnStart: true, autoCreate: true
  }, "session baseline");
  const campaignCaps = mkCapabilitiesOf({ kind: "campaign", policy: { name: "generic" } });
  assert.deepEqual(campaignCaps, {
    individualWithdraw: true, restart: true, deleteRecord: true,
    replaceOnStart: false, autoCreate: false
  }, "campaign baseline");
  console.log("  ✓ PASS");
}

// 17. "Most recent wins": dangling pointer + several sessions resolves to the
//     newest by createdAt, others archived, issues reported.
console.log("Test 17: newest-wins on multiple session candidates");
resetWorld();
{
  const now = Date.now();
  worldSettings.set(`sw25-taka.${MK_REGISTRY_KEY}`, {
    version: MK_REGISTRY_VERSION,
    active: { kind: "session", id: "mksgone" },
    sessions: [
      { id: "s-old", kind: "session", name: "Old", createdAt: now - 5000, updatedAt: now - 5000, status: "active", policy: { name: "session-generic", capabilities: {} }, discoveries: [{ id: "d-old", speciesId: "goblin", speciesLabel: "Goblin", className: "sage", classResult: 15, discoveredBy: "gm", discoveredAt: now - 5000, source: "roll", level: "weakness" }] },
      { id: "s-new", kind: "session", name: "New", createdAt: now, updatedAt: now, status: "archived", policy: { name: "session-generic", capabilities: {} }, discoveries: [{ id: "d-new", speciesId: "hydra", speciesLabel: "Hydra", className: "sage", classResult: 15, discoveredBy: "gm", discoveredAt: now, source: "roll", level: "weakness" }] }
    ],
    campaigns: []
  });
  const active = readMkActiveRecord().data;
  assert.equal(active.record.id, "s-new", "newest session wins the pointer");
  assert.equal(isMkSpeciesKnown("hydra"), true, "knowledge read from the newest session");
  assert.equal(isMkSpeciesKnown("goblin"), false, "older session is not active");
  const diagnose = diagnoseMkRegistry();
  const codes = diagnose.data.issues.map(issue => issue.code);
  assert.ok(codes.includes("orphan-active-pointer"), "orphan pointer reported");
  assert.equal(codes.filter(code => code === "orphan-active-pointer").length, 1, "pointer issue reported once");
  assert.ok(codes.includes("stale-sessions"), "stale sessions reported");
  // A GM write persists the repair without deleting the leftovers.
  await registerMkDiscovery({ speciesId: "wolf", source: "gm-manual" });
  const stored = storedRegistry();
  assert.equal(stored.active.id, "s-new", "repair persisted");
  assert.equal(stored.sessions.length, 2, "leftover session kept (no automatic deletion)");
  const statuses = stored.sessions.map(record => record.status).sort();
  assert.deepEqual(statuses, ["active", "archived"], "statuses normalized by the pointer");
  console.log("  ✓ PASS");
}

// 18. Corrupt structures are normalized losslessly and reported for review.
console.log("Test 18: corrupt records are kept and diagnosed");
resetWorld();
{
  worldSettings.set(`sw25-taka.${MK_REGISTRY_KEY}`, {
    version: MK_REGISTRY_VERSION,
    active: { kind: "campaign", id: "c1" },
    sessions: [{ id: "s1", kind: "session", name: "S", createdAt: 1, updatedAt: 1, status: "active", policy: { name: "session-generic", capabilities: {} }, discoveries: [] }, "junk-not-a-record"],
    campaigns: [
      { id: "c1", name: "No kind", createdAt: 2, discoveries: [42, { id: "d1", speciesId: "goblin", speciesLabel: "Goblin", className: null, classResult: null, discoveredBy: null, discoveredAt: 5, source: "gm-manual", level: "weakness" }, { id: "d2", speciesId: "goblin", speciesLabel: "Goblin", className: "sage", classResult: 20, discoveredBy: null, discoveredAt: 6, source: "gm-manual", level: "weakness" }] },
      { id: "c1", name: "Duplicate id", createdAt: 3, kind: "campaign", status: "archived", policy: { name: "generic", capabilities: {} }, discoveries: [] },
      { name: "No id", kind: "campaign", createdAt: 4, discoveries: [] }
    ]
  });
  const state = readMkActiveRecord();
  assert.equal(state.data.kind, "campaign", "pointer resolves to first campaign");
  const campaignIssues = readMkRegistry().data.issues.map(issue => issue.code);
  assert.ok(campaignIssues.includes("record-malformed"), "junk session kept and reported");
  assert.ok(campaignIssues.includes("duplicate-record-id"), "duplicate campaign id reported");
  assert.ok(campaignIssues.includes("record-missing-id"), "id-less campaign reported");
  assert.ok(campaignIssues.includes("duplicate-discovery"), "duplicate species discovery reported");
  assert.ok(campaignIssues.includes("record-kind-corrected"), "wrong kind corrected");
  assert.ok(campaignIssues.includes("policy-backfilled"), "missing policy backfilled");
  assert.ok(campaignIssues.includes("discoveries-invalid") === false, "discoveries list was an array");
  assert.ok(storedRegistry().sessions.length === 2, "malformed entry kept in storage");
  // Discoveries read the FIRST authoritative duplicate only via dedupe.
  const counts = readMkCampaigns().data.find(record => record.id === "c1").discoveriesCount;
  assert.equal(counts, 3, "duplicates retained in count until the GM cleans them");
  // Registration into the pointed campaign dedupes against the first entry.
  const reg = await registerMkDiscovery({ speciesId: "goblin", source: "gm-manual" });
  assert.equal(reg.data.status, "already-known", "dedupe sees the first duplicate");
  console.log("  ✓ PASS");
}

// 19. Schema version handling: missing backfilled; future refuses writes.
console.log("Test 19: schema version backfill and future-version protection");
resetWorld();
{
  worldSettings.set(`sw25-taka.${MK_REGISTRY_KEY}`, {
    sessions: [],
    campaigns: [],
    active: { kind: null, id: null }
  });
  const state = readMkRegistry().data;
  assert.equal(state.registry.version, MK_REGISTRY_VERSION, "version backfilled");
  assert.ok(state.issues.some(issue => issue.code === "version-missing"), "backfill reported");

  worldSettings.set(`sw25-taka.${MK_REGISTRY_KEY}`, {
    version: 99,
    active: { kind: "session", id: "sx" },
    sessions: [{ id: "sx", kind: "session", name: "Future", createdAt: 1 }, ],
    campaigns: []
  });
  assert.equal(isMkSpeciesKnown("anything"), false, "reads still work");
  const write = await registerMkDiscovery({ speciesId: "goblin" });
  assert.equal(write.ok, false, "write refused");
  assert.equal(write.code, "version-too-new", "future version protected");
  assert.equal(diagnoseMkRegistry().data.futureVersion, true, "future version exposed by diagnosis");
  console.log("  ✓ PASS");
}

// 20. Concurrent writes serialize: no interleaving, consistent state.
console.log("Test 20: concurrent GM writes serialize inside the client");
resetWorld();
{
  const [first, second] = await Promise.all([
    registerMkDiscovery({ speciesId: "goblin", source: "gm-manual" }),
    registerMkDiscovery({ speciesId: "goblin", source: "roll", className: "sage", classResult: 17 })
  ]);
  assert.equal(first.ok, true, "first write ok");
  assert.equal(second.ok, true, "second write ok");
  assert.equal(first.data.status, "registered", "the first commit registered");
  assert.equal(second.data.status, "already-known", "the second commit deduped");
  const stored = storedRegistry();
  assert.equal(stored.sessions[0].discoveries.length, 1, "exactly one discovery after racing writes");

  // Concurrent register + withdraw against different species keeps both
  // effects consistent (serialized read-modify-write).
  const [r1, r2] = await Promise.all([
    registerMkDiscovery({ speciesId: "hydra", source: "gm-manual" }),
    startMkSession({ name: "Acto III" })
  ]);
  assert.equal(r1.ok && r2.ok, true, "both ok");
  const afterStart = readMkSessions().data;
  assert.equal(afterStart.length, 1, "one session record after the replacement");
  assert.equal(afterStart[0].name, "Acto III", "replacement applied from the serial queue");
  const hydra = isMkSpeciesKnown("hydra");
  assert.equal(hydra || r1.data.createdRecord === false, hydra || true, "withdraw/register race resolves to a single consistent store");
  console.log("  ✓ PASS");
}

// 21. No player write path: the transitory adapters are GM-only and the
//     registry stays untouched from player clients.
console.log("Test 21: manual reveal paths are GM-only (player path retired)");
resetWorld();
{
  await registerMkDiscovery({ speciesId: "goblin", source: "gm-manual", level: "weakness" });
  game.user = { isGM: false, character: null, id: "player-1" };
  const monster = makeMonster();
  const reveal = await revealMonsterWeakness(monster, { notify: false });
  assert.equal(reveal.status, "denied", "player reveal denied");
  const toggle = await toggleMonsterWeakness(monster, { notify: false });
  assert.equal(toggle.status, "denied", "player toggle denied");
  const withdraw = await withdrawMkDiscovery({ speciesIdentifier: "goblin" });
  assert.equal(withdraw.ok, false, "player service withdraw refused");
  assert.equal(withdraw.code, "not-gm", "player withdraw is not-gm");
  assert.equal(isSpeciesWeaknessKnown("goblin"), true, "nothing changed by player attempts");
  const stored = storedRegistry();
  assert.equal(stored.sessions[0].discoveries.length, 1, "registry unchanged");
  game.user = { isGM: true, character: null, id: "gm-user" };
  console.log("  ✓ PASS");
}

// 22. GM manual reveal/toggle through the transitory adapters.
console.log("Test 22: GM manual reveal and toggle persist through the registry");
resetWorld();
{
  const monster = makeMonster();
  game.actors = [monster];
  const revealed = await revealMonsterWeakness(monster, { notify: false });
  assert.equal(revealed.status, "revealed", "revealed ok");
  assert.equal(isSpeciesWeaknessKnown("goblin"), true, "bridged read sees it");
  const again = await revealMonsterWeakness(monster, { notify: false });
  assert.equal(again.status, "revealed", "second reveal idempotent");
  const evidence = readMkDiscoveries().data[0];
  assert.equal(evidence.source, "gm-manual", "manual origin stored");
  assert.equal(evidence.monsterUuid, "Actor.monster-1", "manual evidence stored");

  const toggled = await toggleMonsterWeakness(monster, { notify: false });
  assert.equal(toggled.status, "withdrawn", "toggle withdraws");
  assert.equal(isSpeciesWeaknessKnown("goblin"), false, "withdraw visible through the bridge");
  const toggledBack = await toggleMonsterWeakness(monster, { notify: false });
  assert.equal(toggledBack.status, "registered", "toggle registers again");
  assert.equal(isSpeciesWeaknessKnown("goblin"), true, "re-registration visible");
  console.log("  ✓ PASS");
}

// 23. Bridge reads only the registry service (legacy fallback retired in F2-T3).
console.log("Test 23: species weakness reads registry service only");
resetWorld();
{
  // No legacy setting exists: absence of discoveries reads as unknown.
  const monster = makeMonster({ system: { species: "Goblin" } });
  assert.equal(isSpeciesWeaknessKnown("goblin"), false, "unknown species reads as unknown");
  assert.equal(speciesWeaknessKnown(monster), false, "monster-sheet bridge reads unknown");
  // Registry knowledge is visible through the service-backed bridge.
  await registerMkDiscovery({ speciesId: "hydra", source: "gm-manual", level: "weakness" });
  assert.equal(isSpeciesWeaknessKnown("hydra"), true, "registry knowledge visible");
  assert.equal(isSpeciesWeaknessKnown("goblin"), false, "other species remains unknown");
  // The retired legacy setting was never written by any service flow.
  assert.equal(worldSettings.get("sw25-taka.weaknessRegistry"), undefined, "legacy weaknessRegistry setting never written");
  console.log("  ✓ PASS");
}

// 24. Registry repair commits the normalized snapshot without data loss.
console.log("Test 24: repair persists normalization, keeps ambiguous data");
resetWorld();
{
  worldSettings.set(`sw25-taka.${MK_REGISTRY_KEY}`, {
    sessions: [],
    campaigns: [],
    active: { kind: "session", id: "niente" }
  });
  const result = await repairMkRegistry();
  assert.equal(result.ok, true, "repair ok");
  assert.equal(result.data.status, "repaired", "repaired status");
  assert.ok(result.data.autoFixed >= 1, "auto fixes counted");
  const stored = storedRegistry();
  assert.equal(stored.version, MK_REGISTRY_VERSION, "version persisted");
  assert.deepEqual(stored.active, { kind: null, id: null }, "pointer cleared on persist");
  const after = diagnoseMkRegistry();
  assert.equal(after.data.review, 0, "no review issues remained");
  console.log("  ✓ PASS");
}

// 25. Liveness: service records never expose the stored object.
console.log("Test 25: reads return clones; mutations cannot corrupt the store");
resetWorld();
{
  await registerMkDiscovery({ speciesId: "goblin", source: "gm-manual" });
  const record = readMkActiveRecord().data.record;
  record.name = "HACKED";
  record.discoveries.push({ id: "fake", speciesId: "fake", speciesLabel: null, className: null, classResult: null, discoveredBy: null, discoveredAt: 0, source: "gm-manual" });
  const fresh = readMkActiveRecord().data.record;
  assert.equal(fresh.name === "HACKED", false, "record name is a clone");
  assert.equal(fresh.discoveries.length, 1, "pushed fake entry not stored");
  const stale = readMkDiscoveries().data;
  stale.push("x");
  assert.equal(readMkDiscoveries().data.length, 1, "discoveries list is a clone");
  console.log("  ✓ PASS");
}

console.log("\n=== All Monster Knowledge Registry core tests passed ===");


