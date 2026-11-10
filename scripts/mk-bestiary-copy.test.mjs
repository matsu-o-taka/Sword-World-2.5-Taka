// Sword World 2.5 - Monster Knowledge Bestiary Copy tests (F4.3).
//
// Tests the creation, synchronization, and lifecycle of independent Actor
// copies in the Monster Knowledge Bestiary.

import assert from "node:assert/strict";

// ── Foundry mocks with Folder and Actor API ────────────────────────────────

const worldSettings = new Map();
let idCounter = 0;

// Mock actors array (simulates game.actors collection)
const mockActors = [];

// Mock folders array (simulates game.folders collection)
const mockFolders = [];

// Mock Folder class
class MockFolder {
  constructor(data) {
    this.id = data.id || `folder-${++idCounter}`;
    this.name = data.name;
    // Foundry v14 FolderData: the parent folder is carried by the `folder`
    // field (ForeignDocumentField). A `parent` key is not part of the schema.
    this.folder = data.folder ?? null;
    this.type = data.type || null;
    this.flags = data.flags || {};
    this._deleted = false;
  }
  static async create(data) {
    const folder = new MockFolder(data);
    mockFolders.push(folder);
    return folder;
  }
  async delete() {
    this._deleted = true;
    const idx = mockFolders.findIndex(f => f.id === this.id);
    if (idx >= 0) mockFolders.splice(idx, 1);
  }
  async update(data) {
    for (const [key, value] of Object.entries(data ?? {})) {
      this[key] = value;
    }
    return this;
  }
  async setFlag(scope, key, value) {
    if (!this.flags) this.flags = {};
    if (!this.flags[scope]) this.flags[scope] = {};
    this.flags[scope][key] = value;
  }
  static get find() {
    return (predicate) => mockFolders.find(predicate);
  }
}

// Mock Actor class
class MockActor {
  constructor(data) {
    this.id = data.id || `actor-${++idCounter}`;
    this.uuid = data.uuid || `Actor.actor-${this.id}`;
    this.name = data.name;
    this.type = data.type || "monster";
    this.folder = data.folder || null;
    this.ownership = data.ownership || { default: 0 };
    this.flags = data.flags || {};
    this.system = data.system || {};
    this.img = data.img || null;
    this.token = data.token || null;
    this.prototypeToken = data.prototypeToken || null;
    this._deleted = false;
  }
  toObject() {
    return {
      name: this.name,
      type: this.type,
      folder: this.folder,
      ownership: this.ownership,
      flags: this.flags,
      system: this.system,
      img: this.img,
      token: this.token,
      prototypeToken: this.prototypeToken
    };
  }
  static async create(data) {
    // Generate a UUID if not provided
    if (!data.uuid) data.uuid = `Actor.actor-${++idCounter}`;
    const actor = new MockActor(data);
    mockActors.push(actor);
    return actor;
  }
  async delete() {
    this._deleted = true;
    const idx = mockActors.findIndex(a => a.id === this.id);
    if (idx >= 0) mockActors.splice(idx, 1);
  }
  async setFlag(scope, key, value) {
    if (!this.flags) this.flags = {};
    if (!this.flags[scope]) this.flags[scope] = {};
    this.flags[scope][key] = value;
  }
  async update(data) {
    Object.assign(this, data);
    return this;
  }
}

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

globalThis.ui = { notifications: { warn(msg) { }, info() { }, error() { } } };

globalThis.game = {
  user: { isGM: true, character: null, id: "gm-user" },
  actors: {
    get(uuid) {
      return mockActors.find(a => a.uuid === uuid) ?? null;
    },
    values() {
      return mockActors.values();
    },
    create: MockActor.create
  },
  folders: mockFolders,
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, structuredClone(value)); return value; }
  }
};

globalThis.Folder = MockFolder;
globalThis.Actor = MockActor;
globalThis.CONST = {
  DOCUMENT_OWNERSHIP_LEVELS: {
    NONE: 0,
    LIMITED: 1,
    OBSERVER: 2,
    OWNER: 3
  }
};

// ── Imports after mocks ────────────────────────────────────────────────────

const {
  getOrCreateMkRegistryFolder,
  getOrCreateSessionFolder,
  getOrCreateCampaignFolder,
  createBestiaryActorCopy,
  deleteBestiaryActorCopy,
  deleteBestiaryCopiesForRecord,
  reconcileMkBestiary,
  startMkSession,
  createMkCampaign,
  activateMkCampaign,
  deactivateMkCampaign,
  deleteMkCampaign,
  registerMkDiscovery,
  withdrawMkDiscovery,
  resetMkKnowledge,
  readMkDiscoveries,
  monsterKnowledgeRegistry
} = await import("../module/knowledge/monster-knowledge-registry.mjs");

function resetWorld() {
  worldSettings.clear();
  mockActors.length = 0;
  mockFolders.length = 0;
  idCounter = 0;
  game.user = { isGM: true, character: null, id: "gm-user" };
}

function nonGmWorld() {
  worldSettings.clear();
  mockActors.length = 0;
  mockFolders.length = 0;
  idCounter = 0;
  game.user = { isGM: false, character: null, id: "player-user" };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  return async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ PASS: ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ FAIL: ${name} - ${error.message}`);
    }
  };
}

async function runAll() {
  console.log("=== Monster Knowledge Bestiary Copy tests (F4.3) ===\n");

  // ── 1. Creación de una copia Reputation ─────────────────────────────────
  await test("1. createBestiaryActorCopy creates an independent Actor copy", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    // Create an original monster actor
    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin", reputation: 10, weakness: 15 }
    });

    const discovery = {
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin"
    };

    const result = await createBestiaryActorCopy(discovery, "session-1", "session");
    assert.equal(result.ok, true, "should return ok");
    assert.equal(result.data.bestiaryActorUuid, mockActors[1].uuid, "copy UUID set");
    assert.equal(mockActors.length, 2, "original + copy = 2 actors");
    const copy = mockActors[1];
    assert.notEqual(copy.id, original.id, "copy has different id");
    assert.notEqual(copy.uuid, original.uuid, "copy has different uuid");
    assert.equal(copy.name, "Goblin", "copy preserves name");
    assert.equal(copy.flags["sword-world-25"].mkbestiary, true, "copy has bestiary flag");
    assert.equal(copy.flags["sword-world-25"].speciesId, "goblin", "copy has speciesId");
    assert.equal(copy.flags["sword-world-25"].sourceActorUuid, original.uuid, "copy references original");
    assert.equal(copy.ownership.default, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER, "players have OBSERVER ownership");
    assert.notEqual(copy.ownership.default, CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED, "not LIMITED ownership");
  })();

  // ── 2. Aislamiento entre original y copia ───────────────────────────────
  await test("2. Original actor is not modified by copy creation", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Orc",
      type: "monster",
      uuid: "Actor.orc-1",
      system: { species: "Orc", reputation: 12, weakness: 18 }
    });
    const originalId = original.id;
    const originalUuid = original.uuid;

    const discovery = {
      speciesId: "orc",
      monsterUuid: original.uuid,
      monsterName: "Orc"
    };
    await createBestiaryActorCopy(discovery, "session-1", "session");

    // Original should still exist with same id and uuid
    const stillOriginal = mockActors.find(a => a.id === originalId);
    assert.ok(stillOriginal, "original actor still exists");
    assert.equal(stillOriginal.uuid, originalUuid, "original uuid unchanged");
    assert.equal(stillOriginal.flags?.["sword-world-25"]?.mkbestiary, undefined, "original has no bestiary flag");
    assert.equal(stillOriginal.ownership.default, CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, "original ownership unchanged");
  })();

  // ── 3. Identificación inequívoca de las copias administradas ────────────
  await test("3. Bestiary copies are identifiable by flags", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Troll",
      type: "monster",
      uuid: "Actor.troll-1",
      system: { species: "Troll" }
    });

    const discovery = {
      speciesId: "troll",
      monsterUuid: original.uuid,
      monsterName: "Troll"
    };
    await createBestiaryActorCopy(discovery, "session-1", "session");

    const copy = mockActors[1];
    assert.equal(copy.flags["sword-world-25"].mkbestiary, true, "mkbestiary flag is true");
    assert.equal(copy.flags["sword-world-25"].speciesId, "troll", "speciesId flag");
    assert.equal(copy.flags["sword-world-25"].sourceActorUuid, original.uuid, "sourceActorUuid flag");
    assert.equal(copy.flags["sword-world-25"].recordKind, "session", "recordKind flag");
    assert.equal(copy.flags["sword-world-25"].recordId, "session-1", "recordId flag");
  })();

  // ── 4. Promoción Reputation → Weakness sin duplicación ──────────────────
  await test("4. Promotion reputation->weakness reuses existing copy", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    // Register reputation first
    const reg1 = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    assert.equal(reg1.ok, true, "reputation registered");
    assert.equal(reg1.data.status, "registered", "status is registered");

    // The bestiary copy should have been created
    assert.equal(mockActors.length, 2, "original + 1 copy after reputation");

    // Register weakness (promotion)
    const reg2 = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "weakness"
    });
    assert.equal(reg2.ok, true, "weakness registered");
    assert.equal(reg2.data.status, "promoted", "status is promoted");

    // No new copy should be created
    assert.equal(mockActors.length, 2, "still only original + 1 copy after promotion");
  })();

  // ── 5. Retirada y eliminación de copias ─────────────────────────────────
  await test("5. Withdrawing reputation deletes the Bestiary copy", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    const reg = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    assert.equal(reg.ok, true, "reputation registered");
    assert.equal(mockActors.length, 2, "copy exists after registration");

    const copyUuid = mockActors[1].uuid;

    const wd = await withdrawMkDiscovery({ speciesIdentifier: "goblin" });
    assert.equal(wd.ok, true, "withdrawal ok");
    assert.equal(mockActors.length, 1, "copy deleted after withdrawal");
    assert.ok(!mockActors.find(a => a.uuid === copyUuid), "copy actor removed from collection");
  })();

  // ── 6. Separación entre Bestiario de campaña y Current Session ─────────
  await test("6. Campaign and session copies are independent", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    // Create campaign
    const camp = await createMkCampaign({ name: "Test Campaign" });
    assert.equal(camp.ok, true, "campaign created");

    // Register discovery in campaign context
    await activateMkCampaign(camp.data.campaignId);
    const reg = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    assert.equal(reg.ok, true, "campaign discovery registered");
    assert.equal(mockActors.length, 2, "campaign copy exists");

    const campaignCopyUuid = mockActors[1].uuid;

    // Now start a new session and register the same species
    await startMkSession({ name: "New Session" });
    const reg2 = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    assert.equal(reg2.ok, true, "session discovery registered");
    assert.equal(mockActors.length, 3, "session copy is separate from campaign copy");

    const sessionCopy = mockActors[2];
    assert.equal(sessionCopy.flags["sword-world-25"].recordKind, "session", "session copy recordKind");
    assert.equal(sessionCopy.flags["sword-world-25"].recordId, reg2.data.recordId, "session copy recordId");
  })();

  // ── 7. Reinicio de sesión y limpieza de su contenido ────────────────────
  await test("7. Starting a new session cleans up old session copies", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    // First session
    const s1 = await startMkSession({ name: "Session 1" });
    assert.equal(s1.ok, true, "session 1 started");
    const reg1 = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    assert.equal(reg1.ok, true, "session 1 discovery registered");
    assert.equal(mockActors.length, 2, "session 1 copy exists");

    const oldCopyUuid = mockActors[1].uuid;

    // Start new session (replaces old)
    const s2 = await startMkSession({ name: "Session 2" });
    assert.equal(s2.ok, true, "session 2 started");

    // Old session copy should be cleaned up
    assert.ok(!mockActors.find(a => a.uuid === oldCopyUuid), "old session copy removed");
    assert.equal(mockActors.length, 1, "only original actor remains");
  })();

  // ── 8. Permisos gestionados exclusivamente por GM ───────────────────────
  await test("8. Bestiary copy functions reject non-GM", async () => {
    nonGmWorld();
    const result = await createBestiaryActorCopy(
      { speciesId: "goblin", monsterUuid: "Actor.goblin-1" },
      "session-1",
      "session"
    );
    assert.equal(result.ok, false, "non-GM rejected");
    assert.equal(result.code, "not-gm", "not-gm code");

    const del = await deleteBestiaryActorCopy("Actor.goblin-1");
    assert.equal(del.ok, false, "non-GM delete rejected");
    assert.equal(del.code, "not-gm", "not-gm code for delete");

    const rec = await reconcileMkBestiary();
    assert.equal(rec.ok, false, "non-GM reconcile rejected");
    assert.equal(rec.code, "not-gm", "not-gm code for reconcile");
  })();

  // ── 9. Reconciliación: copias ausentes ──────────────────────────────────
  await test("9. Reconciliation creates missing bestiary copies", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    // Register discovery - copy should be auto-created by registerMkDiscovery
    const reg = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    assert.equal(reg.ok, true, "discovery registered");
    assert.equal(mockActors.length, 2, "copy exists after registration");

    // Delete the copy manually to simulate it being missing
    await mockActors[1].delete();
    assert.equal(mockActors.length, 1, "copy manually deleted");

    // Reconcile should recreate it
    const rec = await reconcileMkBestiary();
    assert.equal(rec.ok, true, "reconciliation ok: " + JSON.stringify(rec.data));
    const autoFixed = rec.data.autoFixed;
    assert.ok(autoFixed > 0, "auto-fixed > 0 for missing copy; issues=" + JSON.stringify(rec.data.issues));
    assert.equal(mockActors.length, 2, "copy recreated by reconciliation");
  })();

  // ── 10. Reconciliación: copias duplicadas ───────────────────────────────
  await test("10. Reconciliation reports duplicate bestiary copies", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    // Create two copies manually for same species+record
    await MockActor.create({
      name: "Goblin Copy 1",
      type: "monster",
      uuid: "Actor.goblin-copy-1",
      folder: mockFolders[0]?.id ?? null,
      flags: {
        "sword-world-25": {
          mkbestiary: true,
          speciesId: "goblin",
          recordId: "session-1",
          recordKind: "session",
          sourceActorUuid: original.uuid
        }
      }
    });
    await MockActor.create({
      name: "Goblin Copy 2",
      type: "monster",
      uuid: "Actor.goblin-copy-2",
      folder: mockFolders[0]?.id ?? null,
      flags: {
        "sword-world-25": {
          mkbestiary: true,
          speciesId: "goblin",
          recordId: "session-1",
          recordKind: "session",
          sourceActorUuid: original.uuid
        }
      }
    });

    const rec = await reconcileMkBestiary();
    assert.equal(rec.ok, true, "reconciliation ok");
    const reviewIssues = rec.data.issues.filter(i => i.severity === "review");
    assert.ok(reviewIssues.some(i => i.code === "bestiary-copy-duplicate"), "duplicate reported");
  })();

  // ── 11. Reconciliación: documentos ambiguos (no bestiary) ───────────────
  await test("11. Reconciliation does not touch non-bestiary actors", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();

    // Create a regular (non-bestiary) actor
    const regular = await MockActor.create({
      name: "Regular NPC",
      type: "npc",
      uuid: "Actor.regular-1",
      system: { species: "Human" }
    });

    const rec = await reconcileMkBestiary();
    assert.equal(rec.ok, true, "reconciliation ok");
    assert.ok(mockActors.find(a => a.uuid === regular.uuid), "regular actor preserved");
    const reviewIssues = rec.data.issues.filter(i => i.severity === "review");
    assert.ok(!reviewIssues.some(i => i.code === "bestiary-copy-orphaned" && i.detail.includes("regular")), "regular actor not flagged as orphaned");
  })();

  // ── 12. Copia cuyo registro ya no existe ────────────────────────────────
  await test("12. Reconciliation reports orphaned copies (record deleted)", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    // Create a campaign and register a discovery
    const camp = await createMkCampaign({ name: "Test Campaign" });
    await activateMkCampaign(camp.data.campaignId);
    await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    assert.equal(mockActors.length, 2, "campaign copy exists");

    // Delete the campaign (removes folder + copies)
    await deleteMkCampaign(camp.data.campaignId);
    assert.equal(mockActors.length, 1, "campaign copy deleted with campaign");

    // Create a manual orphaned copy (simulating leftover)
    await MockActor.create({
      name: "Orphaned Goblin",
      type: "monster",
      uuid: "Actor.orphaned-goblin",
      flags: {
        "sword-world-25": {
          mkbestiary: true,
          speciesId: "goblin",
          recordId: "deleted-campaign-id",
          recordKind: "campaign",
          sourceActorUuid: original.uuid
        }
      }
    });
    assert.equal(mockActors.length, 2, "orphaned copy exists");

    const rec = await reconcileMkBestiary();
    assert.equal(rec.ok, true, "reconciliation ok");
    const reviewIssues = rec.data.issues.filter(i => i.severity === "review");
    assert.ok(reviewIssues.some(i => i.code === "bestiary-copy-orphaned"), "orphaned copy reported");
    // Should NOT delete it automatically
    assert.equal(mockActors.length, 2, "orphaned copy not auto-deleted");
  })();

  // ── 13. Actor original eliminado ────────────────────────────────────────
  await test("13. Reconciliation reports copies whose original is gone", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    const reg = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    assert.equal(reg.ok, true, "discovery registered");
    assert.equal(mockActors.length, 2, "copy exists");

    // Delete the original monster
    await original.delete();
    assert.equal(mockActors.length, 1, "original deleted");

    const rec = await reconcileMkBestiary();
    assert.equal(rec.ok, true, "reconciliation ok: " + JSON.stringify(rec.data));
    const reviewIssues = rec.data.issues.filter(i => i.severity === "review");
    assert.ok(reviewIssues.some(i => i.code === "bestiary-copy-unrecoverable"), "unrecoverable reported; issues=" + JSON.stringify(rec.data.issues));
  })();

  // ── 14. BestiaryActorUuid stamped on discovery ──────────────────────────
  await test("14. bestiaryActorUuid is stamped on the discovery after copy creation", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    const reg = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    assert.equal(reg.ok, true, "discovery registered");

    // Read back the discovery and check bestiaryActorUuid
    const discResult = readMkDiscoveries(reg.data.recordId);
    assert.equal(discResult.ok, true, "read discoveries ok");
    const disc = discResult.data.find(d => d.id === reg.data.discoveryId);
    assert.ok(disc, "discovery found");
    assert.equal(disc.bestiaryActorUuid, mockActors[1].uuid, "bestiaryActorUuid stamped");
    assert.equal(disc.bestiaryActorUuid, mockActors[1].uuid, "matches copy UUID");
  })();

  // ── 15. Exportación vía monsterKnowledgeRegistry ────────────────────────
  await test("15. Bestiary functions exported via monsterKnowledgeRegistry", async () => {
    resetWorld();
    assert.equal(typeof monsterKnowledgeRegistry.createBestiaryActorCopy, "function", "createBestiaryActorCopy exported");
    assert.equal(typeof monsterKnowledgeRegistry.deleteBestiaryActorCopy, "function", "deleteBestiaryActorCopy exported");
    assert.equal(typeof monsterKnowledgeRegistry.deleteBestiaryCopiesForRecord, "function", "deleteBestiaryCopiesForRecord exported");
    assert.equal(typeof monsterKnowledgeRegistry.reconcileMkBestiary, "function", "reconcileMkBestiary exported");
  })();

  // ── 16. Promoción reconstruye una copia ausente ─────────────────────────
  await test("16. Promotion reputation->weakness creates a missing copy", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    // Register a reputation discovery while copy creation is unavailable
    // (both the v14 Document static and the legacy collection method fail).
    const realActorCreate = Actor.create;
    const realCollectionCreate = game.actors.create;
    Actor.create = async () => { throw new Error("copy creation unavailable (Actor.create)"); };
    game.actors.create = async () => { throw new Error("copy creation unavailable (game.actors.create)"); };
    const reg1 = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    Actor.create = realActorCreate;
    game.actors.create = realCollectionCreate;
    assert.equal(reg1.ok, true, "knowledge registered despite copy failure");
    assert.ok(reg1.data.bestiaryCopyFailed, "copy failure is reported to the caller");
    assert.equal(mockActors.length, 1, "no copy exists after failed creation");

    // The discovery has no Bestiary copy stamped.
    const disc1 = readMkDiscoveries(reg1.data.recordId).data.find(d => d.id === reg1.data.discoveryId);
    assert.ok(disc1, "discovery found");
    assert.ok(!disc1.bestiaryActorUuid, "no bestiaryActorUuid stamped");

    // Promotion (weakness) must create the missing copy and stamp it.
    const reg2 = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "weakness"
    });
    assert.equal(reg2.ok, true, "weakness registered");
    assert.equal(reg2.data.status, "promoted", "status is promoted");
    assert.equal(mockActors.length, 2, "promotion created the missing copy");
    const copy = mockActors.find(a => a.flags?.["sword-world-25"]?.mkbestiary === true);
    assert.ok(copy, "copy exists with the bestiary flag");
    const disc2 = readMkDiscoveries(reg2.data.recordId).data.find(d => d.speciesId === "goblin");
    assert.ok(disc2, "discovery still present after promotion");
    assert.equal(disc2.bestiaryActorUuid, copy.uuid, "promotion stamped bestiaryActorUuid on the discovery");
    assert.equal(copy.folder, mockFolders.find(f => f.flags["sword-world-25"]?.mkSessionFolder === true).id, "copy lives in the session folder (not undefined)");
  })();

  // ── 17. Ruta v14 de producción: la copia usa Actor.create ───────────────
  await test("17. Copy creation works without game.actors.create (v14 runtime)", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    // Production v14 collections expose no create(): the canonical route is
    // the Actor.create Document static. Emulate that runtime exactly.
    const previousCollectionCreate = game.actors.create;
    delete game.actors.create;
    try {
      const reg = await registerMkDiscovery({
        speciesId: "goblin",
        monsterUuid: original.uuid,
        monsterName: "Goblin",
        level: "reputation"
      });
      assert.equal(reg.ok, true, "knowledge registered without the collection method");
      assert.ok(!reg.data.bestiaryCopyFailed, "no copy failure reported: " + (reg.data.bestiaryCopyFailed ?? ""));
      assert.equal(mockActors.length, 2, "copy created via Actor.create");
      const copy = mockActors.find(a => a.flags?.["sword-world-25"]?.mkbestiary === true);
      assert.ok(copy, "copy carries the bestiary flag");
      assert.equal(reg.data.bestiaryActorUuid, copy.uuid, "copy uuid surfaced in the registration result");
      const disc = readMkDiscoveries(reg.data.recordId).data.find(d => d.speciesId === "goblin");
      assert.equal(disc.bestiaryActorUuid, copy.uuid, "copy uuid stamped on the discovery");
      assert.equal(copy.type, "monster", "copy type preserved");
      assert.equal(copy.ownership?.default, 2, "players get OBSERVER (2) on the copy");
      assert.ok(copy.flags["sword-world-25"].speciesId === "goblin", "copy carries the species flag");
      assert.ok(copy.flags["sword-world-25"].sourceActorUuid === original.uuid, "copy references the source actor");
    } finally {
      game.actors.create = previousCollectionCreate;
    }
  })();

  // ── 18. Limpieza del placeholder "mock-copy" en hidratación ────────────
  await test("18. hydrateRegistry clears the mock-copy placeholder when folders are available", async () => {
    resetWorld();

    const raw = {
      version: 2,
      active: { kind: "session", id: "session-1" },
      sessions: [{
        id: "session-1",
        kind: "session",
        name: "Session",
        createdAt: 1,
        updatedAt: 1,
        status: "active",
        policy: {
          name: "session-generic",
          capabilities: {
            individualWithdraw: true,
            restart: true,
            deleteRecord: false,
            replaceOnStart: true,
            autoCreate: true
          }
        },
        discoveries: [{
          id: "mkd1",
          speciesId: "goblin",
          speciesLabel: "Goblin",
          monsterUuid: "Actor.goblin-1",
          monsterName: "Goblin",
          actorUuid: null,
          actorName: null,
          className: "rider",
          classResult: 14,
          discoveredBy: "u1",
          discoveredAt: 1,
          source: "roll",
          level: "weakness",
          bestiaryActorUuid: "mock-copy"
        }]
      }],
      campaigns: []
    };

    // Runtime with a Bestiary-aware Folder API (real worlds): the placeholder
    // is invalid and must be reset so the copy gets rebuilt.
    const { hydrateRegistry } = await import("../module/knowledge/monster-knowledge-store.mjs");
    const hydrated = hydrateRegistry(structuredClone(raw));
    const cleared = hydrated.issues.filter(i => i.code === "discovery-bestiary-placeholder-cleared");
    assert.equal(cleared.length, 1, "placeholder cleanup issue reported");
    assert.equal(cleared[0].severity, "auto-fixed", "placeholder cleanup is auto-fixed");
    assert.equal(hydrated.registry.sessions[0].discoveries[0].bestiaryActorUuid, null, "placeholder reset to null");

    // Headless harness without the Folder global (e.g. manager suite): the
    // sentinel stays untouched so legacy mock expectations keep working.
    const FolderReference = globalThis.Folder;
    delete globalThis.Folder;
    try {
      const hydratedHeadless = hydrateRegistry(structuredClone(raw));
      const clearedHeadless = hydratedHeadless.issues.filter(i => i.code === "discovery-bestiary-placeholder-cleared");
      assert.equal(clearedHeadless.length, 0, "no cleanup issue without the Folder API");
      assert.equal(hydratedHeadless.registry.sessions[0].discoveries[0].bestiaryActorUuid, "mock-copy", "sentinel kept without the Folder API");
    } finally {
      globalThis.Folder = FolderReference;
    }
  })();

  // ── 19. Reconciliación re-estampa el puntero en la discovery ───────────
  await test("19. reconcileMkBestiary re-stamps bestiaryActorUuid on the discovery", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("session-1");

    const original = await MockActor.create({
      name: "Goblin",
      type: "monster",
      uuid: "Actor.goblin-1",
      system: { species: "Goblin" }
    });

    // Register while copy creation is unavailable (pointer stays null).
    const realActorCreate = Actor.create;
    const realCollectionCreate = game.actors.create;
    Actor.create = async () => { throw new Error("copy creation unavailable (Actor.create)"); };
    game.actors.create = async () => { throw new Error("copy creation unavailable (game.actors.create)"); };
    const reg = await registerMkDiscovery({
      speciesId: "goblin",
      monsterUuid: original.uuid,
      monsterName: "Goblin",
      level: "reputation"
    });
    Actor.create = realActorCreate;
    game.actors.create = realCollectionCreate;
    assert.equal(reg.ok, true, "knowledge registered despite copy failure");
    assert.ok(!reg.data.bestiaryActorUuid, "no pointer stamped yet");

    // Reconciliation recreates the copy AND re-stamps the pointer.
    const rec = await reconcileMkBestiary();
    assert.equal(rec.ok, true, "reconciliation ok: " + JSON.stringify(rec.data));
    assert.ok(rec.data.issues.some(i => i.code === "bestiary-copy-created"), "copy creation issue reported");
    const copy = mockActors.find(a => a.flags?.["sword-world-25"]?.mkbestiary === true);
    assert.ok(copy, "reconcile created the missing copy");
    const disc = readMkDiscoveries(reg.data.recordId).data.find(d => d.speciesId === "goblin");
    assert.equal(disc.bestiaryActorUuid, copy.uuid, "reconcile re-stamped bestiaryActorUuid");
  })();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runAll();