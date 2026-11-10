// Sword World 2.5 - Monster Knowledge OBSERVER permission proxy tests.
//
// Verifies the GM-proxy architecture for granting native OBSERVER ownership
// when Monster Knowledge discovers Statistics, using Terminal's verified
// socket communication pattern.
//
//   - GM rolls resolve without attempting any Observer grant (gm-no-grant).
//   - Non-GM players send a validated socket request to the GM client.
//   - Actor type is restricted to monster.
//   - Weak Point-only discoveries do not grant OBSERVER.
//   - Duplicate requests are ignored.
//   - No GM connected results in a warning, not a silent failure.
//   - system.json declares "socket": true.
//   - Only the intended GM processes the request.
//   - Explicit per-user ownership entries are preserved.
//   - GM default ownership level is not changed when granting to a player.

import assert from "node:assert/strict";
import fs from "node:fs";

// ── Foundry mocks ──────────────────────────────────────────────────────────

const chatMessages = [];
const socketEmissions = [];
const socketHandlers = new Map();
const notifications = [];
const actorUpdates = [];

globalThis.ChatMessage = {
  async create(data) { chatMessages.push(data); return { id: `msg-${chatMessages.length}` }; },
  getSpeaker({ actor } = {}) { return { actor }; }
};

globalThis.ui = {
  notifications: {
    warn(message) { notifications.push({ type: "warn", message }); },
    info(message) { notifications.push({ type: "info", message }); },
    error(message) { notifications.push({ type: "error", message }); }
  }
};

globalThis.foundry = {
  utils: {
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    },
    randomID() { return `req-${Math.random().toString(36).slice(2)}`; },
    mergeObject: (a, b) => ({ ...a, ...b })
  }
};

const worldSettings = new Map();

function makeUser(id, options = {}) {
  return {
    _id: id,
    id,
    isGM: options.isGM ?? false,
    active: options.active ?? true,
    name: options.name ?? `user-${id}`
  };
}

function makeGM(id, name = "GameMaster") {
  return makeUser(id, { isGM: true, name });
}

const gameUsers = [];

function resetUsers() {
  gameUsers.length = 0;
  const gm = makeGM("gm-user", "GameMaster");
  const player = makeUser("player-1", { name: "Player1" });
  gameUsers.push(gm, player);
}

globalThis.game = {
  user: { isGM: true, character: null, id: "gm-user" },
  // User collection semantics: get(id) + filter(fn), backed by gameUsers.
  users: {
    get(id) { return gameUsers.find(u => u.id === id || u._id === id) ?? null; },
    filter(fn) { return gameUsers.filter(fn); }
  },
  actors: [],
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, structuredClone(value)); return value; }
  },
  scenes: [],
  socket: {
    emit(action, payload) { socketEmissions.push({ action, payload }); return Promise.resolve(); },
    on(action, handler) { socketHandlers.set(action, handler); }
  }
};

globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2, OWNER: 3 } };

const syntheticActors = new Map();

globalThis.fromUuid = async uuid => {
  return game.actors.find(a => a.uuid === uuid) || syntheticActors.get(uuid) || null;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMonster(overrides = {}) {
  const system = {
    reputation: 10,
    weakness: 15,
    species: "Goblin",
    ...overrides.system
  };
  const ownership = { ...overrides.ownership };
  return {
    id: overrides.id ?? `monster-${Math.random().toString(36).slice(2)}`,
    uuid: `Actor.${overrides.id ?? Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Goblin",
    type: "monster",
    system,
    ownership,
    flags: {},
    async setFlag(scope, key, value) {
      this.flags[scope] ??= {};
      if (value === null) delete this.flags[scope][key];
      else this.flags[scope][key] = structuredClone(value);
    },
    async getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async testUserPermission(user, permission) {
      // GM users always have OWNER access
      if (user.isGM) return true;
      const perms = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
      const level = this.ownership[user.id] ?? this.ownership.default ?? perms.NONE;
      const target = permission === "OBSERVER" ? perms.OBSERVER : permission === "OWNER" ? perms.OWNER : perms.NONE;
      const result = level >= target;
      return result;
    },
    async update(data) {
      actorUpdates.push(data);
      for (const [path, value] of Object.entries(data ?? {})) {
        if (path === "ownership") {
          for (const [key, val] of Object.entries(value ?? {})) {
            ownership[key] = val;
          }
          continue;
        }
        const parts = path.split(".");
        let obj = system;
        for (let i = 0; i < parts.length - 1; i++) {
          obj[parts[i]] = obj[parts[i]] ?? {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
      }
    }
  };
}

// A token-scoped synthetic Actor view (as returned by fromUuid for
// Scene.x.Token.y.Actor.z on unlinked tokens). Reproduces the world state seen
// in manual testing: the token's actor delta carries ownership that the base
// Actor does not (an old default-grant wrote it into the delta).
function makeTokenSynthetic(baseActor, tokenUuid = "Scene.abc123.Token.tok9.Actor.monster-1") {
  const synthetic = {
    ...baseActor,
    uuid: tokenUuid,
    ownership: { ...baseActor.ownership, default: 2 },
    async update(data) {
      actorUpdates.push(data);
      for (const [key, val] of Object.entries(data.ownership ?? {})) {
        this.ownership[key] = val;
      }
    }
  };
  syntheticActors.set(synthetic.uuid, synthetic);
  return synthetic;
}

function makeCharacter(overrides = {}) {
  const system = { ...overrides.system };
  const ownership = { ...overrides.ownership };
  return {
    id: overrides.id ?? `char-${Math.random().toString(36).slice(2)}`,
    uuid: `Actor.${overrides.id ?? Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Hero",
    type: "character",
    system,
    ownership,
    flags: {},
    async update(data) {
      actorUpdates.push(data);
      for (const [path, value] of Object.entries(data ?? {})) {
        if (path === "ownership") {
          for (const [key, val] of Object.entries(value ?? {})) {
            ownership[key] = val;
          }
          continue;
        }
        const parts = path.split(".");
        let obj = system;
        for (let i = 0; i < parts.length - 1; i++) {
          obj[parts[i]] = obj[parts[i]] ?? {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
      }
    }
  };
}

function resetWorld() {
  worldSettings.clear();
  chatMessages.length = 0;
  socketEmissions.length = 0;
  socketHandlers.clear();
  notifications.length = 0;
  actorUpdates.length = 0;
  syntheticActors.clear();
  resetUsers();
  game.user = { isGM: true, character: null, id: "gm-user" };
  game.users = {
    get(id) { return gameUsers.find(u => u.id === id || u._id === id) ?? null; },
    filter(fn) { return gameUsers.filter(fn); }
  };
  game.socket.on(MK_OBSERVER_SOCKET, () => {});
  initializeMonsterKnowledgeObserver();
}

// Import after mocks are in place
import { requestMonsterObserver, initializeMonsterKnowledgeObserver, MK_OBSERVER_SOCKET, grantMonsterObserver, revealMonsterWeakness, isSpeciesWeaknessKnown } from "../module/combat/monster-knowledge.mjs";

// ── Tests ────────────────────────────────────────────────────────────────

console.log("=== Monster Knowledge OBSERVER permission proxy ===\n");

// Test 0: system.json declares "socket": true
console.log("Test 0: system.json declares socket:true");
resetWorld();
{
  const systemJson = JSON.parse(fs.readFileSync("system.json", "utf8"));
  assert.equal(systemJson.socket, true, "system.json declares socket:true");
  console.log("  ✓ PASS");
}

// Test 1: GM discovers Statistics - no Observer grant is attempted
console.log("Test 1: GM discovers Statistics - no grant, no socket request");
resetWorld();
{
  game.actors = [makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } })];
  const monster = game.actors[0];

  const result = await requestMonsterObserver(monster);
  assert.equal(result.granted, false, "no Observer grant attempted for GM users");
  assert.equal(result.reason, "gm-no-grant", "reason is gm-no-grant");
  assert.deepEqual(monster.ownership, { default: 0 }, "ownership unchanged");
  assert.equal(actorUpdates.length, 0, "no actor.update calls for GM");
  assert.equal(socketEmissions.length, 0, "no socket request for GM");
  console.log("  ✓ PASS");
}

// Test 2: Player discovers Statistics -> socket request sent to GM with gid
console.log("Test 2: Player sends socket request for Statistics discovery with gid");
resetWorld();
game.user = { isGM: false, character: null, id: "player-1" };
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [monster];

  const result = await requestMonsterObserver(monster);
  assert.equal(result.granted, false, "player grant not resolved immediately");
  assert.equal(result.reason, "not-granted", "reason is not-granted (awaiting GM)");
  assert.equal(socketEmissions.length, 1, "one socket emission");
  assert.equal(socketEmissions[0].action, "system.sw25-taka", "socket action is system.sw25-taka");
  assert.equal(socketEmissions[0].payload.action, "mk-grant-observer", "payload action is mk-grant-observer");
  assert.equal(socketEmissions[0].payload.actorUuid, monster.uuid, "payload has actorUuid");
  assert.ok(socketEmissions[0].payload.requestId, "payload has requestId");
  assert.equal(socketEmissions[0].payload.gid, "gm-user", "payload has gid of active GM");
  console.log("  ✓ PASS");
}

// Test 3: GM receives valid socket request and grants OBSERVER
console.log("Test 3: GM processes valid socket request and grants OBSERVER");
resetWorld();
game.user = { isGM: true, character: null, id: "gm-user" };
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [monster];

  const requestId = "test-request-1";
  const payload = {
    action: "mk-grant-observer",
    actorUuid: monster.uuid,
    actorName: monster.name,
    gid: "gm-user",
    requestId
  };

  const handler = socketHandlers.get("system.sw25-taka");
  assert.ok(handler, "socket handler registered");

  await handler(payload, "player-1");
  assert.equal(monster.ownership["player-1"], 2, "GM grant applied ownership[\"player-1\"] = OBSERVER");
  assert.equal(monster.ownership.default, 0, "ownership.default unchanged at 0");
  assert.equal(notifications.filter(n => n.type === "info").length, 1, "GM notified of grant");
  console.log("  ✓ PASS");
}

// Test 4: Player does not call actor.update for ownership
console.log("Test 4: Player does not call actor.update for ownership");
resetWorld();
game.user = { isGM: false, character: null, id: "player-1" };
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [monster];

  const actorUpdatesBefore = actorUpdates.length;
  await requestMonsterObserver(monster);
  assert.equal(actorUpdates.length, actorUpdatesBefore, "no actor.update calls from player");
  assert.equal(socketEmissions.length, 1, "socket request sent instead");
  console.log("  ✓ PASS");
}

// Test 5: Player already at OBSERVER, no update and no socket request
console.log("Test 5: Player already at OBSERVER, no update");
resetWorld();
game.user = { isGM: false, character: null, id: "player-1" };
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 2 } });
  game.actors = [monster];

  const result = await requestMonsterObserver(monster);
  assert.equal(result.granted, false, "already observable, not granted again");
  assert.equal(result.reason, "already-observable", "reason is already-observable");
  assert.equal(monster.ownership.default, 2, "ownership.default remains OBSERVER");
  assert.equal(socketEmissions.length, 0, "no socket emission");
  assert.equal(actorUpdates.length, 0, "no actor.update calls");
  console.log("  ✓ PASS");
}

// Test 6: Player with explicit OWNER permission is not downgraded
console.log("Test 6: Player with OWNER default is not downgraded");
resetWorld();
game.user = { isGM: false, character: null, id: "player-1" };
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 3 } });
  game.actors = [monster];

  const result = await requestMonsterObserver(monster);
  assert.equal(result.granted, false, "OWNER not downgraded");
  assert.equal(result.reason, "already-observable", "reason is already-observable");
  assert.deepEqual(monster.ownership, { default: 3 }, "ownership.default remains OWNER");
  assert.equal(socketEmissions.length, 0, "no socket emission");
  assert.equal(actorUpdates.length, 0, "no actor.update calls");
  console.log("  ✓ PASS");
}

// Test 8: Non-monster Actor -> rejected by requestMonsterObserver
console.log("Test 8: Non-monster actor rejected by requestMonsterObserver");
resetWorld();
game.user = { isGM: false, character: null, id: "player-1" };
{
  const character = makeCharacter({ system: { reputation: 8 }, ownership: { default: 0 } });
  game.actors = [character];

  const result = await requestMonsterObserver(character);
  assert.equal(result.granted, false, "non-monster not granted");
  assert.equal(result.reason, "invalid-actor", "reason is invalid-actor");
  assert.equal(character.ownership.default, 0, "ownership unchanged");
  assert.equal(socketEmissions.length, 0, "no socket request");
  console.log("  ✓ PASS");
}

// Test 9: Idempotent - calling twice doesn't double-grant
console.log("Test 9: Calling requestMonsterObserver twice is idempotent");
resetWorld();
game.user = { isGM: true, character: null, id: "gm-user" };
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [monster];

  // First call: GM grants OBSERVER to gm-user
  await grantMonsterObserver(monster, { id: "player-abc", isGM: false });
  assert.equal(monster.ownership["player-abc"], 2, "ownership[\"player-abc\"] upgraded to OBSERVER after first call");

  await grantMonsterObserver(monster, { id: "player-abc", isGM: false });
  assert.equal(monster.ownership["player-abc"], 2, "ownership[\"player-abc\"] still OBSERVER");
  console.log("  ✓ PASS");
}


// Test 10: Invalid actor UUID -> rejected
console.log("Test 10: Invalid actor UUID rejected by GM handler");
resetWorld();
game.user = { isGM: true, id: "gm-user" };
{
  const handler = socketHandlers.get("system.sw25-taka");
  assert.ok(handler, "socket handler registered");

  await handler({ action: "mk-grant-observer", actorUuid: "nonexistent", gid: "gm-user", requestId: "req-1" }, "player-1");
  assert.equal(notifications.filter(n => n.type === "warn").length, 1, "GM warned about missing actor");
  console.log("  ✓ PASS");
}

// Test 11: Non-monster Actor -> rejected
console.log("Test 11: Non-monster actor rejected by GM handler");
resetWorld();
game.user = { isGM: true, id: "gm-user" };
{
  const handler = socketHandlers.get("system.sw25-taka");
  const character = makeCharacter({ system: { reputation: 8 }, ownership: { default: 0 } });
  game.actors = [character];

  await handler({ action: "mk-grant-observer", actorUuid: character.uuid, gid: "gm-user", requestId: "req-2" }, "player-1");
  assert.equal(character.ownership.default, 0, "character ownership unchanged");
  assert.equal(character.ownership["player-abc"], undefined, "ownership[\"player-abc\"] not set");
  console.log("  ✓ PASS");
}

// Test 12: Duplicate request -> ignored
console.log("Test 12: Duplicate request ignored by GM handler");
resetWorld();
game.user = { isGM: true, id: "gm-user" };
{
  const handler = socketHandlers.get("system.sw25-taka");
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [monster];

  const requestId = "dup-req-1";
  await handler({ action: "mk-grant-observer", actorUuid: monster.uuid, gid: "gm-user", requestId }, "player-1");
  await handler({ action: "mk-grant-observer", actorUuid: monster.uuid, gid: "gm-user", requestId }, "player-1");
  assert.equal(monster.ownership["player-1"], 2, "ownership upgraded once");
  console.log("  ✓ PASS");
}

// Test 13: No GM connected -> warning
console.log("Test 13: No active GM results in warning");
resetWorld();
game.user = { isGM: false, character: null, id: "player-1" };
game.users = [];
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [monster];

  const result = await requestMonsterObserver(monster);
  assert.equal(result.granted, false, "no grant without GM");
  assert.equal(result.reason, "no-gm", "reason is no-gm");
  assert.equal(notifications.filter(n => n.type === "warn").length, 1, "player warned");
  assert.equal(socketEmissions.length, 0, "no socket emission");
  console.log("  ✓ PASS");
}

// Test 14: Update failure not reported as successful
console.log("Test 14: Update failure not reported as granted");
resetWorld();
game.user = { isGM: true, character: null, id: "gm-user" };
game.users.activeGM = { isGM: true, id: "gm-user" };
game.users.get = (id) => gameUsers.find(u => u.id === id);
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [monster];

  const originalUpdate = monster.update.bind(monster);
  monster.update = async () => { throw new Error("Database locked"); };

  await assert.rejects(
    grantMonsterObserver(monster, { id: "player-abc", isGM: false }),
    Error,
    "Database locked"
  );
  console.log("  ✓ PASS");
}

// Test 15: Second player receives their own per-user entry; existing entries preserved
console.log("Test 15: Second player gets their own per-user entry");
resetWorld();
game.user = { isGM: true, character: null, id: "gm-user" };
gameUsers.push(makeUser("player-2", { name: "Player2" }));
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0, "player-1": 2 } });
  game.actors = [monster];

  const handler = socketHandlers.get("system.sw25-taka");
  assert.ok(handler, "socket handler registered");

  await handler({
    action: "mk-grant-observer",
    actorUuid: monster.uuid,
    actorName: monster.name,
    gid: "gm-user",
    requestId: "second-player-req"
  }, "player-2");
  assert.equal(monster.ownership["player-2"], 2, "ownership[\"player-2\"] granted OBSERVER");
  assert.equal(monster.ownership["player-1"], 2, "ownership[\"player-1\"] preserved");
  assert.equal(monster.ownership.default, 0, "ownership.default unchanged at 0");
  console.log("  ✓ PASS");
}

// Test 16: Only intended GM processes the request
console.log("Test 16: Only intended GM processes the request");
resetWorld();
game.user = { isGM: true, id: "gm-user" };
gameUsers.push(makeGM("gm-user-2", "SecondGM"));
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [monster];

  const requestId = "intended-gm-req";
  const payload = {
    action: "mk-grant-observer",
    actorUuid: monster.uuid,
    actorName: monster.name,
    gid: "gm-user",
    requestId
  };

  const handler = socketHandlers.get("system.sw25-taka");
  assert.ok(handler, "socket handler registered");

  await handler(payload, "player-1");
  assert.equal(monster.ownership["player-1"], 2, "intended GM grants OBSERVER to requesting player");
  assert.equal(monster.ownership.default, 0, "ownership.default unchanged at 0");
  console.log("  ✓ PASS");
}

// Test 17: Other GM clients ignore the request
console.log("Test 17: Other GM clients ignore the request");
resetWorld();
game.user = { isGM: true, id: "gm-user-2" };
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [monster];

  const handler = socketHandlers.get("system.sw25-taka");
  assert.ok(handler, "socket handler registered");

  await handler({ action: "mk-grant-observer", actorUuid: monster.uuid, gid: "gm-user", requestId: "other-gm-req" }, "player-1");
  assert.equal(monster.ownership.default, 0, "ownership.default unchanged at 0");
  assert.equal(monster.ownership["player-1"], undefined, "ownership[\"player-1\"] unchanged (other GM ignored request)");
  console.log("  ✓ PASS");
}

// Test 18: GM Weak Point discovery registers in the persistent registry
console.log("Test 18: GM Weak Point discovery registers in persistent registry");
resetWorld();
game.user = { isGM: true, character: null, id: "gm-user" };
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20, species: "Goblin" } });
  game.actors = [monster];

  const result = await revealMonsterWeakness(monster, { notify: false });
  assert.equal(result.status, "revealed", "weakness revealed for GM user");
  assert.equal(isSpeciesWeaknessKnown("goblin"), true, "species registered in the Monster Knowledge Registry");
  console.log("  ✓ PASS");
}

// Test 19: GM Statistics + Weak Point both resolve with no grant and no socket
console.log("Test 19: GM stats + Weak Point both resolve, no grant, no socket");
resetWorld();
game.user = { isGM: true, character: null, id: "gm-user" };
{
  const monster = makeMonster({ system: { reputation: 8, weakness: 20, species: "Goblin" }, ownership: { default: 0 } });
  game.actors = [monster];

  const observer = await requestMonsterObserver(monster);
  const weakness = await revealMonsterWeakness(monster, { notify: false });
  assert.equal(observer.reason, "gm-no-grant", "no Observer grant attempted for GM");
  assert.equal(weakness.status, "revealed", "Weak Point registered for GM");
  assert.equal(isSpeciesWeaknessKnown("goblin"), true, "weakness registry updated by GM discovery");
  assert.deepEqual(monster.ownership, { default: 0 }, "ownership untouched by GM discovery");
  assert.equal(socketEmissions.length, 0, "no socket traffic from GM discovery");
  assert.equal(actorUpdates.length, 0, "no ownership updates from GM discovery");
  console.log("  ✓ PASS");
}

// Test 20: Player statistics discovery through a token-scoped synthetic actor.
// The token delta claims the player is observable, but the base Actor does
// not: the check must use the base Actor and the socket request must carry
// its uuid.
console.log("Test 20: token-fooled delta does not suppress the socket request");
resetWorld();
game.user = { isGM: false, character: null, id: "player-1" };
{
  const base = makeMonster({ id: "monster-1", system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [base];
  makeTokenSynthetic(base);

  const result = await requestMonsterObserver(syntheticActors.get("Scene.abc123.Token.tok9.Actor.monster-1"));
  assert.equal(result.granted, false, "player grant not resolved immediately");
  assert.equal(result.reason, "not-granted", "token delta must not trigger already-observable");
  assert.equal(socketEmissions.length, 1, "socket request emitted despite fooled token delta");
  assert.equal(socketEmissions[0].payload.actorUuid, "Actor.monster-1", "payload carries the BASE actor uuid");
  assert.deepEqual(base.ownership, { default: 0 }, "base ownership untouched by the player");
  assert.equal(actorUpdates.length, 0, "no ownership update from the player side");
  console.log("  ✓ PASS");
}

// Test 21: GM socket grant for a token-scoped actorUuid writes the grant to
// the base Actor document, not to the token delta.
console.log("Test 21: token uuid socket grant lands on the base Actor");
resetWorld();
game.user = { isGM: true, character: null, id: "gm-user" };
{
  const base = makeMonster({ id: "monster-1", system: { reputation: 8, weakness: 20 }, ownership: { default: 0 } });
  game.actors = [base];
  const synthetic = makeTokenSynthetic(base);

  const handler = socketHandlers.get("system.sw25-taka");
  assert.ok(handler, "socket handler registered");

  await handler({
    action: "mk-grant-observer",
    actorUuid: "Scene.abc123.Token.tok9.Actor.monster-1",
    actorName: "Goblin",
    gid: "gm-user",
    requestId: "token-grant-req"
  }, "player-1");
  assert.equal(base.ownership["player-1"], 2, "base Actor gained the per-user OBSERVER grant");
  assert.equal(base.ownership.default, 0, "base ownership.default unchanged");
  assert.equal(synthetic.ownership["player-1"], undefined, "token delta untouched by the grant");
  console.log("  ✓ PASS");
}

// Test 22: Player genuinely observable on the base Actor: no request even
// when the token delta also claims observability.
console.log("Test 22: real base observable returns already-observable");
resetWorld();
game.user = { isGM: false, character: null, id: "player-1" };
{
  const base = makeMonster({ id: "monster-1", system: { reputation: 8, weakness: 20 }, ownership: { default: 0, "player-1": 2 } });
  game.actors = [base];
  makeTokenSynthetic(base);

  const result = await requestMonsterObserver(syntheticActors.get("Scene.abc123.Token.tok9.Actor.monster-1"));
  assert.equal(result.granted, false, "no grant needed");
  assert.equal(result.reason, "already-observable", "reason is already-observable (base Actor check)");
  assert.equal(socketEmissions.length, 0, "no socket request");
  console.log("  ✓ PASS");
}

// ── Summary ──────────────────────────────────────────────────────────────

console.log("\n=== All Monster Knowledge OBSERVER permission proxy tests passed ===");