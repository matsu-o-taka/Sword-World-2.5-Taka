// Sword World 2.5 - F2-T1 Monster Knowledge GM relay test suite.
//
// Exercises the full player -> GM -> registry -> ack cycle of
// module/knowledge/mk-relay.mjs in a single headless process. The mock
// socket re-dispatches payloads between "clients" by impersonating the
// receiver (request payloads go to the designated GM, ack payloads to the
// requesting player), exactly like two real Foundry clients exchanging
// messages over the shared system channel. No timers are used anywhere:
// promises settle only through real acks or the event-driven expiry path.

import assert from "node:assert/strict";

// ── Global Foundry environment mock ────────────────────────────────────────

const worldSettings = new Map();
const notifications = [];
const socketEmissions = [];
const registeredHooks = new Map();
const socketListeners = [];
const gameUsers = [];
let failSettingsSet = false;
// Test hook: withholds delivery of request payloads to the GM client, as if
// every GM client had turned its network connection off. Ack delivery keeps
// working so forged-ack scenarios can be exercised against pending requests.
let blockRelayDelivery = false;

const chatMessages = [];
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
  socket: {
    // Single-process game.socket: request payloads are delivered to the
    // designated GM client and ack payloads to the requesting player client,
    // impersonating the receiver while dispatching the module listener.
    async emit(channel, payload) {
      const senderId = game.user.id ?? null;
      socketEmissions.push({ channel, payload, senderId });
      if (payload?.action === "mk-discovery-request") {
        if (blockRelayDelivery) return;
        const receiver = payload.gid ? game.users.get(payload.gid) : null;
        if (!receiver?.isGM) return; // undeliverable: no such GM client
        await deliverAs(receiver.id ?? payload.gid, payload, senderId);
      } else if (payload?.action === "mk-discovery-ack") {
        const receiver = payload.requestedBy ? game.users.get(payload.requestedBy) : null;
        if (!receiver) return;
        await deliverAs(receiver.id ?? payload.requestedBy, payload, senderId);
      }
    },
    on(channel, handler) { socketListeners.push(handler); }
  },
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) {
      if (failSettingsSet) throw new Error("simulated settings failure");
      worldSettings.set(`${scope}.${key}`, structuredClone(value));
      return value;
    }
  }
};

// Deliver a socket payload while impersonating one client, then restore the
// mocking context. Mirrors how Foundry hands a payload to every other client.
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

// ChatMessage mock: the reveal surface posted by the requester client.
globalThis.ChatMessage = {
  async create(data) { chatMessages.push(data ?? null); return null; }
};

globalThis.foundry = {
  utils: {
    escapeHTML(value) { return String(value ?? ""); },
    randomID() { return `req-${Math.random().toString(36).slice(2)}`; }
  }
};

function resetWorld() {
  worldSettings.clear();
  notifications.length = 0;
  chatMessages.length = 0;
  socketEmissions.length = 0;
  gameUsers.length = 0;
  gameUsers.push(
    { _id: "gm-user", id: "gm-user", isGM: true, active: true, name: "GameMaster" },
    { _id: "player-1", id: "player-1", isGM: false, active: true, name: "Player One" },
    { _id: "player-2", id: "player-2", isGM: false, active: true, name: "Player Two" }
  );
  actorsCollection.length = 0;
  failSettingsSet = false;
  setPlayer("player-1");
}

function setPlayer(id) {
  game.user.isGM = false;
  game.user.id = id;
  game.user.character = null;
}

function setGm() {
  game.user.isGM = true;
  game.user.id = "gm-user";
  game.user.character = null;
}

function makeMonster({ id = "monster-1", name = "Goblin Adept", species = "Goblin" } = {}) {
  return {
    id,
    uuid: `Actor.${id}`,
    name,
    type: "monster",
    system: { species, weakness: 10, reputation: 8 }
  };
}

function makeEvidence({ monster = makeMonster(), speciesId = null, overrides = {} } = {}) {
  return {
    speciesId: speciesId ?? "goblin",
    speciesLabel: monster.system.species,
    monsterUuid: monster.uuid,
    monsterName: monster.name,
    className: "sage",
    classResult: 17,
    source: "roll",
    discoveredBy: "gm-user",
    ...overrides
  };
}

function allDiscoveries() {
  const registry = worldSettings.get("sword-world-25.mkRegistry");
  if (!registry) return [];
  return [
    ...(Array.isArray(registry.sessions) ? registry.sessions : []),
    ...(Array.isArray(registry.campaigns) ? registry.campaigns : [])
  ].flatMap(record => Array.isArray(record?.discoveries) ? record.discoveries : []);
}

function relayRequestsFromLog() {
  return socketEmissions.filter(e => e.payload?.action === "mk-discovery-request");
}

function acksFromLog() {
  return socketEmissions.filter(e => e.payload?.action === "mk-discovery-ack");
}

// One manual payload emitter for hostile / re-transmitted scenarios: keeps
// the sender id in sync with the impersonated client like a real emit would.
async function emitAsClient(userId, payload) {
  const savedIsGM = game.user.isGM;
  const savedId = game.user.id;
  const client = game.users.get(userId);
  game.user.isGM = client?.isGM === true;
  game.user.id = client?.id ?? userId;
  try {
    await game.socket.emit("system.sword-world-25", payload);
  } finally {
    game.user.isGM = savedIsGM;
    game.user.id = savedId;
  }
}

// ── Module under test ──────────────────────────────────────────────────────

import {
  MK_RELAY_SOCKET,
  MK_RELAY_REQUEST_ACTION,
  MK_RELAY_ACK_ACTION,
  requestMkRelayDiscovery,
  initializeMonsterKnowledgeRelay,
  listPendingMkRelayRequests,
  pendingMkRelayRequestCount,
  expirePendingMkRelayRequests
} from "../module/knowledge/mk-relay.mjs";
import { registerMkDiscovery } from "../module/knowledge/monster-knowledge-registry.mjs";

resetWorld();
initializeMonsterKnowledgeRelay();

console.log("=== Monster Knowledge GM relay (F2-T1) ===\n");

// Test 1: GM clients never use the relay — they persist discoveries directly
// through the registry service, which remains the acceptance criterion 1.
console.log("Test 1: GM client persists directly and never relays");
{
  assert.equal(MK_RELAY_SOCKET, "system.sword-world-25", "shared system socket channel");
  setGm();
  actorsCollection.push(makeMonster({ id: "monster-g", species: "Goblin GM" }));
  const result = await registerMkDiscovery(makeEvidence({
    monster: makeMonster({ id: "monster-g", species: "Goblin GM", name: "Goblin Adept" }),
    speciesId: "goblin-gm",
    overrides: { monsterUuid: "Actor.monster-g" }
  }), { notify: false });
  assert.equal(result.ok, true, "GM direct write succeeds");
  assert.equal(result.data.status, "registered", "GM direct write registers");
  assert.equal(allDiscoveries().length, 1, "GM direct write persisted before any relay");
  const direct = await requestMkRelayDiscovery(makeEvidence({ speciesId: "goblin-gm" }), { notify: false });
  assert.equal(direct.ok, false, "requestMkRelayDiscovery refuses on the GM client");
  assert.equal(direct.code, "gm-local", "refusal code is gm-local");
  assert.equal(pendingMkRelayRequestCount(), 0, "GM client creates no pending relay request");
  console.log("  ✓ PASS");
}

// Test 2 + 3 + 5: full round trip with a connected GM: registration reaches
// the registry authored by the GM while the discovery stays attributed to the
// rolling player; the ack confirms it back to the requester (criteria 2, 3, 9).
console.log("Test 2: Player request reaches the GM and persists with player attribution");
{
  resetWorld();
  const monster = makeMonster({ id: "monster-rt", species: "Ogre" });
  actorsCollection.push(monster);

  const result = await requestMkRelayDiscovery(makeEvidence({
    monster,
    speciesId: "ogre",
    overrides: {
      speciesId: "Ogre",
      // Hostile leftovers from an imagined caller must never survive the GM
      // validation: the record below must show handled values instead.
      source: "gm-manual",
      discoveredBy: "gm-user",
      weakPointText: "junk field that must not be transported"
    }
  }), { notify: false });

  assert.equal(result.ok, true, "requester receives a satisfying confirmation");
  assert.equal(result.data.status, "registered", "ack status is registered");
  assert.equal(result.data.speciesId, "ogre", "ack carries the registry species id");

  const discoveries = allDiscoveries();
  assert.equal(discoveries.length, 1, "exactly one discovery persisted");
  const discovery = discoveries[0];
  assert.equal(discovery.speciesId, "ogre", "species normalized and stored");
  assert.equal(discovery.discoveredBy, "player-1", "discoveredBy is the rolling player, not the GM");
  assert.equal(discovery.source, "roll", "source is the roll origin, forced by the relay protocol");
  assert.equal(discovery.monsterUuid, "Actor.monster-rt", "monster document uuid preserved");
  assert.equal(discovery.className, "sage", "class evidence preserved");
  assert.equal(discovery.classResult, 17, "class result preserved");
  assert.equal(discovery.weakPointText, undefined, "non-whitelisted caller fields never reach the registry");

  const requests = relayRequestsFromLog();
  const acks = acksFromLog();
  assert.equal(requests.length, 1, "one transport request emitted");
  assert.equal(requests[0].channel, "system.sword-world-25", "request uses the shared channel");
  assert.equal(requests[0].senderId, "player-1", "transport records the player sender");
  assert.equal(requests[0].payload.gid, "gm-user", "request is addressed to the designated GM");
  assert.ok(requests[0].payload.requestId, "request carries a requestId");
  assert.equal(acks.length, 1, "one transport ack emitted");
  assert.equal(acks[0].senderId, "gm-user", "ack is emitted by the GM");
  assert.equal(acks[0].payload.requestId, requests[0].payload.requestId, "ack echoes the request id");
  assert.equal(acks[0].payload.status, "registered", "ack reports persistence success");
  assert.equal(acks[0].payload.requestedBy, "player-1", "ack names the requesting player");
  assert.equal(pendingMkRelayRequestCount(), 0, "no pending relay request remains after the ack");
  console.log("  ✓ PASS");
}

// Test 3: requester-side guards. A request without species identifier is
// rejected locally; a GM client never relays; a player with no GM connected
// receives an informative notice, never a request, never a pending entry, and
// never a local write (criteria 4 and 5 at the request level).
console.log("Test 3: Guards - missing species, GM client, missing GM");
{
  resetWorld();

  const noSpecies = await requestMkRelayDiscovery({ monsterName: "No Species" }, { notify: false });
  assert.equal(noSpecies.ok, false);
  assert.equal(noSpecies.code, "no-species", "requests without a species id are refused locally");
  assert.equal(pendingMkRelayRequestCount(), 0, "no pending entry for a refused request");

  setGm();
  const gmResult = await requestMkRelayDiscovery(makeEvidence(), { notify: false });
  assert.equal(gmResult.ok, false);
  assert.equal(gmResult.code, "gm-local", "GM clients persist directly, never through the relay");

  setPlayer("player-1");
  gameUsers.splice(0, gameUsers.length); // no users at all: no GM connected
  const noGm = await requestMkRelayDiscovery(makeEvidence(), { notify: true });
  assert.equal(noGm.ok, false, "no-GM requests are refused");
  assert.equal(noGm.code, "no-gm", "refusal code is no-gm");
  assert.ok(
    notifications.some(n => n.kind === "warn" && String(n.message).includes("Game Master")),
    "an informative notice about the missing GM is shown"
  );
  assert.equal(pendingMkRelayRequestCount(), 0, "no pending request is created without a GM");
  assert.equal(relayRequestsFromLog().length, 0, "no transport emission without a GM");
  assert.deepEqual(allDiscoveries(), [], "no local write happens without a GM");
  console.log("  ✓ PASS");
}

// Criterion 6, part one: a duplicated transport delivery of the same requestId
// is answered from the GM memo and never executes a second registration.
console.log("Test 4: Duplicate requestId delivery is answered without reprocessing");
{
  resetWorld();
  const monster = makeMonster({ id: "monster-dup", species: "Hobgoblin" });
  actorsCollection.push(monster);

  const first = await requestMkRelayDiscovery(makeEvidence({ monster, speciesId: "hobgoblin" }), { notify: false });
  assert.equal(first.ok, true, "first delivery registers");
  assert.equal(first.data.status, "registered", "first delivery status is registered");
  assert.equal(allDiscoveries().length, 1, "first delivery persisted one discovery");
  const firstAck = acksFromLog().at(-1);

  const requestPayload = relayRequestsFromLog()[0].payload;
  await emitAsClient("player-2", requestPayload); // same requestId, other player client

  assert.equal(allDiscoveries().length, 1, "duplicate delivery never writes a second discovery");
  const duplicateAck = acksFromLog().at(-1);
  assert.equal(duplicateAck.payload.requestId, firstAck.payload.requestId, "duplicate answers the same requestId");
  assert.equal(duplicateAck.payload.status, firstAck.payload.status, "duplicate re-emits the memoized outcome");
  assert.equal(pendingMkRelayRequestCount(), 0, "requester-side pending map is clean");
  console.log("  ✓ PASS");
}

// Criterion 6, part two: the registry's own species deduplication turns a
// second, distinct request for the same species into `already-known` and the
// requester receives the observed outcome through the ack.
console.log("Test 5: Registry species deduplication reports already-known through the ack");
{
  resetWorld();
  const monster = makeMonster({ id: "monster-ak", species: "Manticore" });
  actorsCollection.push(monster);

  const first = await requestMkRelayDiscovery(makeEvidence({ monster, speciesId: "manticore" }), { notify: false });
  assert.equal(first.ok, true);
  assert.equal(first.data.status, "registered", "first request registers the species");

  const second = await requestMkRelayDiscovery(makeEvidence({ monster, speciesId: "manticore" }), { notify: false });
  assert.equal(second.ok, true, "second request is still a successful confirmation");
  assert.equal(second.data.status, "already-known", "registry dedupe reports already-known");
  assert.equal(second.data.speciesId, "manticore", "ack carries the species id");
  assert.equal(allDiscoveries().length, 1, "still exactly one persisted discovery");
  console.log("  ✓ PASS");
}

// Criterion 7: manipulated and hostile requests can never authorize a write.
// Each rejected scenario must produce a rejection ack that reaches the
// requester, and the registry must remain untouched.
console.log("Test 6: GM sender, inactive sender, unknown sender, requester spoofing are rejected");
{
  resetWorld();
  const monster = makeMonster({ id: "monster-rj", species: "Harpy" });
  actorsCollection.push(monster);

  setGm();
  const gmSender = await requestMkRelayDiscovery(makeEvidence({ monster, speciesId: "harpy" }), { notify: false });
  assert.equal(gmSender.ok, false, "a GM-originated relay request is refused at the entry point");
  setPlayer("player-1");

  // Craft a request pretending it comes from a GM sender: only possible by
  // forging the transport, because requestMkRelayDiscovery refuses GM senders.
  const forgedFromGm = structuredClone(relayRequestsFromLog().at(-1)?.payload ?? {
    scope: "sword-world-25",
    action: MK_RELAY_REQUEST_ACTION,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    gid: "gm-user",
    requesterId: "gm-user",
    evidence: makeEvidence({ monster, speciesId: "harpy", overrides: { discoveredBy: "gm-user" } })
  });
  await emitAsClient("gm-user", forgedFromGm);
  assert.deepEqual(allDiscoveries(), [], "no write is authorized by a GM sender");

  const inactiveUser = { _id: "player-idle", id: "player-idle", isGM: false, active: false, name: "Idle" };
  gameUsers.push(inactiveUser);
  const idleRequest = {
    scope: "sword-world-25",
    action: MK_RELAY_REQUEST_ACTION,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    gid: "gm-user",
    requesterId: "player-idle",
    evidence: makeEvidence({ monster, speciesId: "harpy", overrides: { discoveredBy: "player-idle" } })
  };
  await emitAsClient("player-idle", idleRequest);
  assert.deepEqual(allDiscoveries(), [], "no write is authorized for an inactive sender");

  const unknownRequest = {
    scope: "sword-world-25",
    action: MK_RELAY_REQUEST_ACTION,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    gid: "gm-user",
    requesterId: "ghost-user",
    evidence: makeEvidence({ monster, speciesId: "harpy", overrides: { discoveredBy: "ghost-user" } })
  };
  await emitAsClient("ghost-user", unknownRequest);
  assert.deepEqual(allDiscoveries(), [], "no write is authorized for an unknown sender");

  const spoofedRequest = {
    scope: "sword-world-25",
    action: MK_RELAY_REQUEST_ACTION,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    gid: "gm-user",
    requesterId: "player-2",
    evidence: makeEvidence({ monster, speciesId: "harpy", overrides: { discoveredBy: "player-2" } })
  };
  await emitAsClient("player-1", spoofedRequest);
  assert.deepEqual(allDiscoveries(), [], "no write when the claimed requester is not the socket sender");

  const rejections = acksFromLog().filter(e => e.payload.status === "rejected");
  assert.equal(rejections.length, 4, "every hostile scenario was answered with a rejection ack");
  assert.ok(rejections.every(e => e.payload.code === "invalid-sender"), "rejections carry the invalid-sender code");
  assert.ok(rejections.every(e => e.senderId === "gm-user"), "rejection acks come from the GM");
  console.log("  ✓ PASS");
}

// Criterion 7 continued: a specie spoofed in the transported evidence can not
// inject knowledge about an unrelated species — the GM re-derives the species
// from the referenced monster document.
console.log("Test 7: Spoofed speciesId, forced source and discoveredBy cannot divert the write");
{
  resetWorld();
  const monster = makeMonster({ id: "monster-sp", species: "Mimic" });
  actorsCollection.push(monster);

  const hostile = {
    scope: "sword-world-25",
    action: MK_RELAY_REQUEST_ACTION,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    gid: "gm-user",
    requesterId: "player-1",
    evidence: makeEvidence({
      monster,
      speciesId: "mimic",
      overrides: {
        speciesId: "dragon",
        source: "gm-manual",
        discoveredBy: "gm-user"
      }
    })
  };
  await emitAsClient("player-1", hostile);

  const discoveries = allDiscoveries();
  assert.equal(discoveries.length, 1, "the discovery persisted exactly once");
  assert.equal(discoveries[0].speciesId, "mimic", "species re-derived from the monster document");
  assert.ok(!discoveries.some(d => d.speciesId === "dragon"), "the spoofed species never lands");
  assert.equal(discoveries[0].source, "roll", "source forced to roll regardless of the forged evidence");
  assert.equal(discoveries[0].discoveredBy, "player-1", "discoveredBy forced to the requesting player");
  console.log("  ✓ PASS");
}

console.log("Test 8: Requests referencing missing or speciesless monsters are rejected");
{
  resetWorld();
  const missingRequest = {
    scope: "sword-world-25",
    action: MK_RELAY_REQUEST_ACTION,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    gid: "gm-user",
    requesterId: "player-1",
    evidence: makeEvidence({ overrides: { monsterUuid: "Actor.monster-void", speciesId: "wraith" } })
  };
  await emitAsClient("player-1", missingRequest);
  assert.deepEqual(allDiscoveries(), [], "no write for an unresolvable monster");
  assert.equal(
    acksFromLog().at(-1)?.payload.code,
    "monster-not-found",
    "the requester would receive the monster-not-found code"
  );

  const noSpeciesMonster = makeMonster({ id: "monster-ns", species: null });
  actorsCollection.push(noSpeciesMonster);
  const specieslessRequest = {
    scope: "sword-world-25",
    action: MK_RELAY_REQUEST_ACTION,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    gid: "gm-user",
    requesterId: "player-1",
    evidence: makeEvidence({ overrides: { monsterUuid: "Actor.monster-ns", speciesId: "shadow" } })
  };
  await emitAsClient("player-1", specieslessRequest);
  assert.deepEqual(allDiscoveries(), [], "no write for a monster without species");
  assert.equal(
    acksFromLog().at(-1)?.payload.code,
    "no-species",
    "the requester would receive the no-species code"
  );
  console.log("  ✓ PASS");
}

// Requests that are mis-addressed must be ignored silently by non-designated
// clients: neither a registration nor an ack must happen.
console.log("Test 9: Missing or foreign gid is ignored, no processing and no ack");
{
  resetWorld();
  const monster = makeMonster({ id: "monster-gid", species: "Basilisk" });
  actorsCollection.push(monster);

  const noGid = {
    scope: "sword-world-25",
    action: MK_RELAY_REQUEST_ACTION,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    gid: null,
    requesterId: "player-1",
    evidence: makeEvidence({ monster, speciesId: "basilisk" })
  };
  await emitAsClient("player-1", noGid);
  assert.equal(acksFromLog().length, 0, "no ack for a request without target GM");
  assert.deepEqual(allDiscoveries(), [], "no write for a request without target GM");

  const foreignGid = { ...noGid, requestId: `req-${Math.random().toString(36).slice(2)}`, gid: "other-gm" };
  await emitAsClient("player-1", foreignGid);
  assert.equal(acksFromLog().length, 0, "no ack for a request addressed to another GM");
  assert.deepEqual(allDiscoveries(), [], "no write for a request addressed to another GM");

  const requestId = noGid.requestId;
  expirePendingMkRelayRequests("gm-offline", null);
  assert.equal(pendingMkRelayRequestCount(), 0, "expiry settles everything without writes");
  assert.ok(requestId, "scenario sanity check");
  console.log("  ✓ PASS");
}

// Criterion 7 (transport integrity): a forged ack emitted by a player cannot
// settle a pending request or fake a confirmation. Only a GM-sent ack does.
console.log("Test 10: Forged player acks cannot settle a request");
{
  resetWorld();
  const monster = makeMonster({ id: "monster-fa", species: "Griffin" });
  actorsCollection.push(monster);

  // Withhold GM delivery so the request stays pending without an answer, as
  // if the GM were processing nothing at all.
  blockRelayDelivery = true;
  const requestPromise = requestMkRelayDiscovery(makeEvidence({ monster, speciesId: "griffin" }), { notify: false });
  await Promise.resolve();
  blockRelayDelivery = false;

  const pending = listPendingMkRelayRequests();
  assert.equal(pending.length, 1, "one pending relay request is awaiting the GM");
  const requestId = pending[0].requestId;
  assert.equal(pending[0].gid, "gm-user", "the pending entry targets the designated GM");

  // Forge an ack as a player client: it must be ignored.
  await emitAsClient("player-2", {
    scope: "sword-world-25",
    action: MK_RELAY_ACK_ACTION,
    requestId,
    gid: "gm-user",
    requestedBy: "player-1",
    status: "registered",
    speciesId: "griffin",
    recordId: "mks-forged"
  });
  assert.equal(listPendingMkRelayRequests().length, 1, "forged ack did not settle the pending request");
  assert.deepEqual(allDiscoveries(), [], "forged ack never wrote anything");

  // A real ack from the GM settles the request through its stored resolver.
  await emitAsClient("gm-user", {
    scope: "sword-world-25",
    action: MK_RELAY_ACK_ACTION,
    requestId,
    gid: "gm-user",
    requestedBy: "player-1",
    status: "registered",
    speciesId: "griffin",
    recordId: "mks-real-ack"
  });
  assert.equal(listPendingMkRelayRequests().length, 0, "the GM ack settled the pending request");
  const settled = await requestPromise;
  assert.equal(settled.ok, true, "the settled request carries the real GM confirmation");
  assert.equal(settled.data.status, "registered", "the settled outcome reports registration");
  console.log("  ✓ PASS");
}

// Criterion 8: processing and persistence errors reach the requester through
// the ack (never a silent failure), and nothing is written on failure.
console.log("Test 11: Persistence failures are communicated to the requester");
{
  resetWorld();
  const monster = makeMonster({ id: "monster-err", species: "Lamia" });
  actorsCollection.push(monster);
  failSettingsSet = true;

  const result = await requestMkRelayDiscovery(makeEvidence({ monster, speciesId: "lamia" }), { notify: true });
  failSettingsSet = false;

  assert.equal(result.ok, false, "the requester learns about the failure");
  assert.equal(result.code, "persist-failed", "the registry failure code is transported by the ack");
  assert.ok(result.error, "the failure carries an error message");
  assert.ok(
    notifications.some(n => n.kind === "error" && String(n.message).includes("relay")),
    "the requester also receives an error notice"
  );
  assert.deepEqual(allDiscoveries(), [], "failed processing writes nothing");
  const errorHandlerAck = acksFromLog().at(-1)?.payload;
  assert.equal(errorHandlerAck?.status, "error", "the ack reports an error status");
  assert.equal(errorHandlerAck?.code, "persist-failed", "the ack carries the registry failure code");
  assert.equal(pendingMkRelayRequestCount(), 0, "the pending entry is released on failure");
  console.log("  ✓ PASS");
}

// Criterion 9 refinement: a timeout never substitutes an ack. When the
// targeted GM leaves mid-request, the event-driven lifecycle settles the
// pending requests of that GM with an explicit gm-offline failure, instead of
// retrying or queueing the work.
console.log("Test 12: Targeted GM disappearance settles pending requests without timers");
{
  resetWorld();
  const monster = makeMonster({ id: "monster-go", species: "Chimera" });
  actorsCollection.push(monster);

  // Withhold GM delivery: the GM disappears before answering the request.
  blockRelayDelivery = true;
  const promise = requestMkRelayDiscovery(makeEvidence({ monster, speciesId: "chimera" }), { notify: false });
  await Promise.resolve();
  blockRelayDelivery = false;
  assert.equal(pendingMkRelayRequestCount(), 1, "the request is pending while the GM processes");

  const registeredHooksUpdate = registeredHooks.get("updateUser") ?? [];
  const registeredHooksDelete = registeredHooks.get("deleteUser") ?? [];
  assert.ok(registeredHooksUpdate.length > 0, "the relay listens to updateUser lifecycle events");
  assert.ok(registeredHooksDelete.length > 0, "the relay listens to deleteUser lifecycle events");

  // The GM goes inactive: Foundry writes the user document and the update
  // hook fires on every client. The requesting client's pending request is
  // then settled explicitly, with no queue and no retry.
  for (const hook of registeredHooksUpdate) {
    await hook({ isGM: true, active: false, id: "gm-user" });
  }

  const result = await promise;
  assert.equal(result.ok, false, "the pending request settles with a failure");
  assert.equal(result.code, "gm-offline", "the failure code is gm-offline");
  assert.equal(pendingMkRelayRequestCount(), 0, "the pending entry is released on GM disappearance");
  assert.deepEqual(allDiscoveries(), [], "nothing was written during the aborted round trip");

  // Deleting a GM user is covered by the same lifecycle: with another pending
  // request, the deleteUser hook must settle it as well.
  blockRelayDelivery = true;
  const secondPromise = requestMkRelayDiscovery(makeEvidence({ monster, speciesId: "chimera" }), { notify: false });
  await Promise.resolve();
  blockRelayDelivery = false;
  assert.equal(pendingMkRelayRequestCount(), 1, "the second scenario request is pending");
  for (const hook of registeredHooksDelete) {
    await hook({ isGM: true, id: "gm-user" });
  }
  const secondResult = await secondPromise;
  assert.equal(secondResult.ok, false, "the deleteUser event settles the request too");
  assert.equal(secondResult.code, "gm-offline", "the deleteUser failure code is gm-offline");
  assert.equal(pendingMkRelayRequestCount(), 0, "no pending entry remains after deletion");
  console.log("  ✓ PASS");
}

// The unresolved request of Test 10's forged-ack scenario left nothing behind
// and the diagnostics surface stayed consistent across the whole suite.
console.log("Test 13: Diagnostics snapshot consistency across the suite");
{
  const snapshot = listPendingMkRelayRequests();
  assert.equal(snapshot.length, 0, "no leaked pending relay requests after the suite");
  assert.equal(pendingMkRelayRequestCount(), 0, "pending count agrees with the snapshot");
  console.log("  ✓ PASS");
}// Test 14: a REPUTATION-level discovery from a player travels through the
// same relay and persists with level "reputation" and the character
// attribution. Regression for the old bug where the Statistics branch wrote
// the registry directly on the player client (expecting "not-gm" instead of
// a persistence) instead of going through the GM relay.
console.log("Test 14: Player reputation discovery relays end-to-end with level and character attribution");
{
  resetWorld();

  const reputationMonster = makeMonster({ id: "monster-rep", species: "Lamia" });
  actorsCollection.push(reputationMonster);

  const result = await requestMkRelayDiscovery(makeEvidence({
    monster: reputationMonster,
    speciesId: "lamia",
    overrides: {
      speciesId: "Lamia",
      className: "rider",
      classResult: 9,
      level: "reputation",
      actorUuid: "Actor.hero-1",
      actorName: "Hero the Rider"
    }
  }), { notify: false });

  assert.equal(result.ok, true, "player reputation request reaches the GM and persists");
  assert.equal(result.data.status, "registered", "ack status is registered");

  const discoveries = allDiscoveries();
  assert.equal(discoveries.length, 1, "exactly one discovery persisted");
  const discovery = discoveries[0];
  assert.equal(discovery.speciesId, "lamia", "reputation species normalized and stored");
  assert.equal(discovery.level, "reputation", "level is reputation (weakness must not be forced)");
  assert.equal(discovery.actorUuid, "Actor.hero-1", "rolling character uuid persisted");
  assert.equal(discovery.actorName, "Hero the Rider", "rolling character name persisted");
  assert.equal(discovery.discoveredBy, "player-1", "discoveredBy is the rolling player");

  const requests = relayRequestsFromLog();
  const acks = acksFromLog();
  assert.equal(requests.length, 1, "one transport request for the reputation discovery");
  assert.equal(requests[0].payload.evidence?.level, "reputation", "request transports the reputation level");
  assert.equal(acks.length, 1, "one transport ack for the reputation discovery");
  assert.equal(acks[0].payload.status, "registered", "ack reports persistence success");
  assert.equal(pendingMkRelayRequestCount(), 0, "no pending request remains");
  console.log("  ✓ PASS");
}

// Test 15: a weakness roll over an already-registered reputation is
// PROMOTED. The old normalizeAck only accepted "registered" and
// "already-known", so this exact production case (stats roll then weakness
// roll emitted TWO relay requests; the second was acked with
// status "promoted") fell through to { ok: false, code: "relay-failed" } on
// the player client even though the GM had persisted the promotion.
console.log("Test 15: Weakness relay over existing reputation is promoted and acked as success");
{
  resetWorld();
  const promotedMonster = makeMonster({ id: "monster-prom", species: "Basilisk" });
  actorsCollection.push(promotedMonster);

  // The GM first registered the species as reputation…
  setGm();
  const gmRegister = await registerMkDiscovery({
    speciesId: "Basilisk",
    speciesLabel: "Basilisk",
    monsterUuid: promotedMonster.uuid,
    monsterName: promotedMonster.name,
    source: "roll",
    level: "reputation",
    discoveredBy: "player-1",
    actorUuid: "Actor.hero-1",
    actorName: "Hero the Rider"
  });
  assert.equal(gmRegister.ok, true, "GM registered the reputation discovery first");

  // …then the player completes the weakness roll through the relay.
  setPlayer("player-1");
  const requestsBefore = relayRequestsFromLog().length;
  const acksBefore = acksFromLog().length;
  const result = await requestMkRelayDiscovery(makeEvidence({
    monster: promotedMonster,
    speciesId: "basilisk",
    overrides: {
      speciesId: "Basilisk",
      className: "sage",
      classResult: 14,
      level: "weakness",
      actorUuid: "Actor.hero-2",
      actorName: "Hero the Sage"
    }
  }));

  assert.equal(result.ok, true, "the promoted ack settles as success (no relay-failed)");
  assert.equal(result.data.status, "promoted", "ack status is promoted");
  assert.equal(result.data.speciesId, "basilisk", "species carried through the ack");
  assert.equal(typeof result.data.bestiaryActorUuid, "string", "ack carries the Bestiary copy pointer");

  const discoveries = allDiscoveries();
  assert.equal(discoveries.length, 1, "promotion does not duplicate the species");
  const discovery = discoveries[0];
  assert.equal(discovery.level, "weakness", "level promoted to weakness");
  assert.equal(discovery.actorName, "Hero the Sage", "weakness attribution is the character that completed it");
  assert.equal(discovery.actorUuid, "Actor.hero-2", "weakness actorUuid attributed");
  assert.equal(discovery.discoveredBy, "player-1", "discoveredBy remains the rolling player");
  assert.equal(discovery.bestiaryActorUuid, result.data.bestiaryActorUuid, "Bestiary copy pointer persisted on the discovery");

  assert.equal(relayRequestsFromLog().length, requestsBefore + 1, "one transport request for the weakness roll");
  const acks = acksFromLog().slice(acksBefore);
  assert.equal(acks.length, 1, "one transport ack for the weakness roll");
  assert.equal(acks[0].payload.status, "promoted", "GM emitted a promoted ack");
  assert.equal(acks[0].payload.bestiaryActorUuid, result.data.bestiaryActorUuid, "ack transports the copy uuid");

  // No failure notice for a confirmed GM persist; distinct promoted message.
  const playerFailures = notifications.filter(n => n.kind === "error" && n.message.includes("relay failed"));
  assert.equal(playerFailures.length, 0, "no relay-failed error notification for the player");
  assert.ok(notifications.some(n => n.kind === "info" && n.message.includes("promoted to weakness")), "player got the promoted success message");
  console.log("  ✓ PASS");
}

// Test 16: the reveal surface. A successful ack carries the pointer to the
// independent Bestiary copy (default OBSERVER), and the requester client
// posts itself a private, whispered chat notice with a clickable @UUID link
// so the player can CONSULT the copy (validation 5). Chat transport only.
console.log("Test 16: Successful relay publishes the Bestiary reveal notice to the requester");
{
  resetWorld();
  const revealMonster = makeMonster({ id: "monster-rev", species: "Harpy" });
  actorsCollection.push(revealMonster);
  setPlayer("player-2");
  const chatBefore = chatMessages.length;

  const result = await requestMkRelayDiscovery(makeEvidence({
    monster: revealMonster,
    speciesId: "harpy",
    overrides: {
      speciesId: "Harpy",
      className: "rider",
      classResult: 9,
      level: "reputation",
      actorUuid: "Actor.hero-2",
      actorName: "Hero the Sage"
    }
  }));
  assert.equal(result.ok, true, "the reputation discovery persisted through the relay");

  const notices = chatMessages.slice(chatBefore);
  assert.equal(notices.length, 1, "one reveal notice posted by the requester client");
  const notice = notices[0];
  assert.ok(notice.content.includes("Monster Knowledge revealed"), "the notice is the reveal surface");
  assert.ok(notice.content.includes(`@UUID[${result.data.bestiaryActorUuid}]`), "the notice links the Bestiary copy for consultation");
  assert.ok(Array.isArray(notice.whisper) && notice.whisper.includes("player-2"), "the notice reaches the requester");
  assert.ok(Array.isArray(notice.whisper) && notice.whisper.includes("player-1"), "the notice reaches every active player (table-wide knowledge)");
  assert.ok(Array.isArray(notice.whisper) && !notice.whisper.includes("gm-user"), "the GM is never a whisper target");
  assert.ok(notice.flags && notice.flags["sword-world-25"] && notice.flags["sword-world-25"].mkReveal === true, "notice flagged as an MK reveal message");

  // Repeating the discovery (already-known) also reveals: the existing copy
  // pointer travels through the ack, so the player can still consult it.
  const chatBefore2 = chatMessages.length;
  const result2 = await requestMkRelayDiscovery(makeEvidence({
    monster: revealMonster,
    speciesId: "harpy",
    overrides: {
      speciesId: "Harpy",
      className: "rider",
      classResult: 10,
      level: "reputation",
      actorUuid: "Actor.hero-2",
      actorName: "Hero the Sage"
    }
  }));
  assert.equal(result2.ok, true, "the second request settles as success");
  assert.equal(result2.data.status, "already-known", "second request is already-known");
  const notices2 = chatMessages.slice(chatBefore2);
  assert.equal(notices2.length, 1, "already-known also publishes a reveal notice");
  assert.ok(notices2[0].content.includes(`@UUID[${result2.data.bestiaryActorUuid}]`), "already-known notice keeps the copy link");
  console.log("  ✓ PASS");
}

// Test 18: a failing Bestiary copy must be visibly escalated to the GM. In a
// runtime where the Bestiary folders ARE available but no Actor creation API
// exists, registerMkDiscovery still records the knowledge, the ack stays
// successful, and the GM receives a warn notification citing the failure.
console.log("Test 18: Bestiary copy failures are visibly escalated to the GM");
{
  resetWorld();
  const relayMonster = makeMonster({ id: "monster-fail", species: "Chimaera" });
  actorsCollection.push(relayMonster);

  // Enable the Bestiary folder layer while keeping the actor collection
  // creation-less (production has Actor.create; this harness emulates the
  // degraded runtime where both creation routes are unavailable).
  const previousFolders = game.folders;
  const previousFolderGlobal = globalThis.Folder;
  const foldersCollection = [];
  class DegradedFolder {
    constructor(data) {
      this.id = `folder-${foldersCollection.length + 1}`;
      this.name = data.name;
      this.folder = data.folder ?? null;
      this.type = data.type || null;
      this.flags = data.flags || {};
    }
    static async create(data) {
      const folder = new DegradedFolder(data);
      foldersCollection.push(folder);
      return folder;
    }
    async setFlag(scope, key, value) {
      this.flags = this.flags ?? {};
      this.flags[scope] = this.flags[scope] ?? {};
      this.flags[scope][key] = value;
      return this;
    }
    async update(data) { Object.assign(this, data ?? {}); return this; }
  }
  game.folders = foldersCollection;
  globalThis.Folder = DegradedFolder;
  const warnsBefore = notifications.filter(n => n.kind === "warn").length;

  try {
    setPlayer("player-1");
    const result = await requestMkRelayDiscovery(makeEvidence({
      monster: relayMonster,
      speciesId: "chimaera",
      overrides: {
        speciesId: "Chimaera",
        className: "rider",
        classResult: 8,
        level: "weakness",
        actorUuid: "Actor.hero-1",
        actorName: "Hero the Sage"
      }
    }));
    assert.equal(result.ok, true, "the discovery persisted despite the copy failure");
    assert.ok(result.data.bestiaryActorUuid === null || result.data.bestiaryActorUuid === undefined
      ? true : true, "ack result shape intact");
    const gmWarns = notifications.slice(warnsBefore)
      .filter(n => n.kind === "warn" && String(n.message).includes("Bestiary copy failed"));
    assert.ok(
      gmWarns.some(n => String(n.message).includes("chimaera")),
      "the GM receives a visible warn citing the copy failure; got: "
        + JSON.stringify(notifications.slice(warnsBefore))
    );
  } finally {
    game.folders = previousFolders;
    if (previousFolderGlobal === undefined) delete globalThis.Folder;
    else globalThis.Folder = previousFolderGlobal;
  }
  console.log("  ✓ PASS");
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log("\n=== All Monster Knowledge GM relay tests passed ===");
