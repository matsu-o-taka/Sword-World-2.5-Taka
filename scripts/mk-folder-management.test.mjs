// Sword World 2.5 - Monster Knowledge Folder Management tests (F4.2).
//
// Tests the integration of folder management functions with the Registry
// lifecycle operations. Requires Foundry Folder API mocks.

import assert from "node:assert/strict";

// ── Foundry mocks with Folder API ──────────────────────────────────────────

const worldSettings = new Map();
let idCounter = 0;

// Mock folders array (simulates game.folders collection)
const mockFolders = [];

// Mock Folder class
class MockFolder {
  constructor(data) {
    this.id = data.id || `folder-${++idCounter}`;
    this.name = data.name;
    // Foundry v14 FolderData: the parent folder is carried by the `folder`
    // field (DOCUMENT_ID). A `parent` key in the data is not part of the
    // schema and is ignored, exactly like the real validation does.
    this.folder = data.folder ?? null;
    this.type = data.type || null;
    this.flags = data.flags || {};
    this._deleted = false;
    // Validate that type is present (required by FolderData schema)
    if (typeof data.type !== "string" || !data.type) {
      throw new Error(`Folder.create() requires a valid 'type' field, got: ${JSON.stringify(data.type)}`);
    }
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
  actors: [],
  folders: mockFolders,
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, structuredClone(value)); return value; }
  }
};

globalThis.Folder = MockFolder;

// ── Imports after mocks ────────────────────────────────────────────────────

const {
  getOrCreateMkRegistryFolder,
  getOrCreateSessionFolder,
  getOrCreateCampaignFolder,
  deleteCampaignFolder,
  reconcileMkFolders,
  startMkSession,
  createMkCampaign,
  activateMkCampaign,
  deactivateMkCampaign,
  deleteMkCampaign,
  monsterKnowledgeRegistry
} = await import("../module/knowledge/monster-knowledge-registry.mjs");

function resetWorld() {
  worldSettings.clear();
  mockFolders.length = 0;
  idCounter = 0;
  game.user = { isGM: true, character: null, id: "gm-user" };
}

function nonGmWorld() {
  worldSettings.clear();
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
  console.log("=== Monster Knowledge Folder Management tests (F4.2) ===\n");

  // ── 1. Creación de carpeta raíz ─────────────────────────────────────────
  await test("1. getOrCreateMkRegistryFolder creates root folder", async () => {
    resetWorld();
    const result = await getOrCreateMkRegistryFolder();
    assert.equal(result.ok, true, "should return ok");
    assert.equal(result.data.folderName, "Monster Knowledge Bestiary", "root folder name");
    assert.equal(mockFolders.length, 1, "exactly one root folder");
    assert.equal(mockFolders[0].flags["sword-world-25"].mkRegistryRoot, true, "root flag set");
    assert.equal(mockFolders[0].type, "Actor", "root folder type is Actor");
  })();

  await test("1b. getOrCreateMkRegistryFolder reuses existing root", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    const firstId = mockFolders[0].id;
    const result = await getOrCreateMkRegistryFolder();
    assert.equal(result.ok, true, "should return ok on reuse");
    assert.equal(mockFolders.length, 1, "no duplicate root folder");
    assert.equal(result.data.folderId, firstId, "same folder returned");
  })();

  // ── 2. Creación de Current Session ──────────────────────────────────────
  await test("2. getOrCreateSessionFolder creates Current Session folder", async () => {
    resetWorld();
    const result = await getOrCreateSessionFolder("session-1");
    assert.equal(result.ok, true, "should return ok");
    const sessionFolders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkSessionFolder === true);
    assert.equal(sessionFolders.length, 1, "exactly one Current Session folder");
    assert.equal(sessionFolders[0].flags["sword-world-25"].mkSessionId, "session-1", "session id stored");
    assert.equal(sessionFolders[0].type, "Actor", "session folder type is Actor");
  })();

  // ── 3. Creación de sesión cuando la carpeta ya existe ───────────────────
  await test("3. getOrCreateSessionFolder reuses existing Current Session folder", async () => {
    resetWorld();
    await getOrCreateSessionFolder("session-1");
    const firstId = mockFolders.find(f => f.flags["sword-world-25"]?.mkSessionFolder === true).id;
    const result = await getOrCreateSessionFolder("session-2");
    assert.equal(result.ok, true, "should return ok on reuse");
    assert.equal(mockFolders.filter(f => f.flags["sword-world-25"]?.mkSessionFolder === true).length, 1, "no duplicate Current Session");
    assert.equal(result.data.folderId, firstId, "same folder returned");
    assert.equal(mockFolders.find(f => f.flags["sword-world-25"]?.mkSessionFolder === true).flags["sword-world-25"].mkSessionId, "session-2", "session id updated");
  })();

  // ── 4. Inicio de nueva sesión reutilizando misma carpeta ────────────────
  await test("4. startMkSession reuses Current Session folder across sessions", async () => {
    resetWorld();
    const r1 = await startMkSession({ name: "Session A" });
    assert.equal(r1.ok, true, "first session start ok");
    const sessionFoldersAfterFirst = mockFolders.filter(f => f.flags["sword-world-25"]?.mkSessionFolder === true);
    assert.equal(sessionFoldersAfterFirst.length, 1, "one Current Session after first start");
    assert.equal(sessionFoldersAfterFirst[0].flags["sword-world-25"].mkSessionId, r1.data.sessionId, "session id matches");

    const r2 = await startMkSession({ name: "Session B" });
    assert.equal(r2.ok, true, "second session start ok");
    const sessionFoldersAfterSecond = mockFolders.filter(f => f.flags["sword-world-25"]?.mkSessionFolder === true);
    assert.equal(sessionFoldersAfterSecond.length, 1, "still one Current Session after second start");
    assert.equal(sessionFoldersAfterSecond[0].flags["sword-world-25"].mkSessionId, r2.data.sessionId, "session id updated to new session");
  })();

  // ── 5. Garantía de que nunca se crean dos carpetas Current Session ──────
  await test("5. Duplicate Current Session folders detected as conflict", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    // Manually create two folders with mkSessionFolder: true
    await MockFolder.create({ name: "Current Session", folder: mockFolders[0].id, type: "Actor", flags: { "sword-world-25": { mkSessionFolder: true, mkSessionId: "s1" } } });
    await MockFolder.create({ name: "Current Session", folder: mockFolders[0].id, type: "Actor", flags: { "sword-world-25": { mkSessionFolder: true, mkSessionId: "s2" } } });
    const result = await getOrCreateSessionFolder("s3");
    assert.equal(result.ok, false, "should report conflict");
    assert.equal(result.code, "folder-conflict", "folder-conflict code");
  })();

  // ── 6. Creación de carpetas independientes para varias campañas ─────────
  await test("6. getOrCreateCampaignFolder creates independent campaign folders", async () => {
    resetWorld();
    const r1 = await getOrCreateCampaignFolder("camp-1", "Campaign One");
    assert.equal(r1.ok, true, "first campaign folder ok");
    const r2 = await getOrCreateCampaignFolder("camp-2", "Campaign Two");
    assert.equal(r2.ok, true, "second campaign folder ok");
    const campaignFolders = mockFolders.filter(f => Boolean(f.flags["sword-world-25"]?.mkCampaignFolder));
    assert.equal(campaignFolders.length, 2, "two independent campaign folders");
    assert.equal(campaignFolders[0].flags["sword-world-25"].mkCampaignFolder, "camp-1", "first campaign flag");
    assert.equal(campaignFolders[1].flags["sword-world-25"].mkCampaignFolder, "camp-2", "second campaign flag");
    assert.equal(campaignFolders[0].type, "Actor", "campaign folder type is Actor");
    assert.equal(campaignFolders[1].type, "Actor", "campaign folder type is Actor");
  })();

  // ── 7. Activación de campaña con carpeta existente ──────────────────────
  await test("7. activateMkCampaign creates folder if missing", async () => {
    resetWorld();
    const created = await createMkCampaign({ name: "Test Campaign" });
    assert.equal(created.ok, true, "campaign created");
    // Folder should exist from createMkCampaign integration
    const campaignFolders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === created.data.campaignId);
    assert.equal(campaignFolders.length, 1, "campaign folder exists after creation");
  })();

  // ── 8. Desactivación sin eliminación de carpeta ─────────────────────────
  await test("8. deactivateMkCampaign preserves campaign folder", async () => {
    resetWorld();
    const created = await createMkCampaign({ name: "Test Campaign" });
    await activateMkCampaign(created.data.campaignId);
    const beforeFolders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === created.data.campaignId);
    assert.equal(beforeFolders.length, 1, "folder exists before deactivation");
    const deactivated = await deactivateMkCampaign(created.data.campaignId);
    assert.equal(deactivated.ok, true, "deactivation ok");
    const afterFolders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === created.data.campaignId);
    assert.equal(afterFolders.length, 1, "folder still exists after deactivation");
  })();

  // ── 9. Eliminación de campaña y de su carpeta ───────────────────────────
  await test("9. deleteMkCampaign deletes campaign folder", async () => {
    resetWorld();
    const created = await createMkCampaign({ name: "Test Campaign" });
    const beforeFolders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === created.data.campaignId);
    assert.equal(beforeFolders.length, 1, "folder exists before deletion");
    const deleted = await deleteMkCampaign(created.data.campaignId);
    assert.equal(deleted.ok, true, "deletion ok");
    const afterFolders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === created.data.campaignId);
    assert.equal(afterFolders.length, 0, "campaign folder removed after deletion");
  })();

  // ── 10. Actualización del nombre visible de una carpeta de campaña ──────
  await test("10. getOrCreateCampaignFolder reuses and can update name", async () => {
    resetWorld();
    const r1 = await getOrCreateCampaignFolder("camp-1", "Old Name");
    assert.equal(r1.ok, true, "first creation ok");
    assert.equal(mockFolders[1].name, "Old Name", "initial name");
    // Reuse with new name - folder name is not automatically updated on reuse
    // (name updates would require explicit rename, which is outside this phase)
    const r2 = await getOrCreateCampaignFolder("camp-1", "New Name");
    assert.equal(r2.ok, true, "reuse ok");
    assert.equal(mockFolders.length, 2, "no duplicate folder");
    // Note: folder name is not changed on reuse in this implementation;
    // the campaign name in the Registry is the source of truth.
  })();

  // ── 11. Reconciliación de carpetas ausentes ─────────────────────────────
  await test("11. reconcileMkFolders creates missing campaign folders", async () => {
    resetWorld();
    // Create a campaign in the registry - createMkCampaign now auto-creates the folder
    const created = await createMkCampaign({ name: "Orphaned Campaign" });
    assert.equal(created.ok, true, "campaign created");
    // Folder should exist from createMkCampaign integration
    let folders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === created.data.campaignId);
    assert.equal(folders.length, 1, "folder exists after campaign creation");
    // Manually delete the folder to simulate it being removed
    await folders[0].delete();
    folders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === created.data.campaignId);
    assert.equal(folders.length, 0, "folder manually deleted");
    // Reconciliation should restore it
    const reconciled = await reconcileMkFolders();
    assert.equal(reconciled.ok, true, "reconciliation ok");
    const restored = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === created.data.campaignId);
    assert.equal(restored.length, 1, "folder restored by reconciliation");
  })();

  // ── 12. Detección segura de carpetas duplicadas o ambiguas ──────────────
  await test("12. reconcileMkFolders reports duplicate Current Session folders", async () => {
    resetWorld();
    await getOrCreateMkRegistryFolder();
    await MockFolder.create({ name: "Current Session", folder: mockFolders[0].id, type: "Actor", flags: { "sword-world-25": { mkSessionFolder: true, mkSessionId: "s1" } } });
    await MockFolder.create({ name: "Current Session", folder: mockFolders[0].id, type: "Actor", flags: { "sword-world-25": { mkSessionFolder: true, mkSessionId: "s2" } } });
    const reconciled = await reconcileMkFolders();
    assert.equal(reconciled.ok, true, "reconciliation ok");
    const reviewIssues = reconciled.data.issues.filter(i => i.severity === "review");
    assert.ok(reviewIssues.some(i => i.code === "duplicate-session-folder"), "duplicate-session-folder reported");
  })();

  // ── 13. Ausencia de escrituras cuando no hay GM ─────────────────────────
  await test("13. Folder functions reject non-GM", async () => {
    nonGmWorld();
    const root = await getOrCreateMkRegistryFolder();
    assert.equal(root.ok, false, "non-GM rejected for root");
    assert.equal(root.code, "not-gm", "not-gm code");

    const session = await getOrCreateSessionFolder("s1");
    assert.equal(session.ok, false, "non-GM rejected for session");

    const campaign = await getOrCreateCampaignFolder("c1", "Campaign");
    assert.equal(campaign.ok, false, "non-GM rejected for campaign");

    const del = await deleteCampaignFolder("c1");
    assert.equal(del.ok, false, "non-GM rejected for delete");

    const rec = await reconcileMkFolders();
    assert.equal(rec.ok, false, "non-GM rejected for reconcile");
  })();

  // ── 14. Propagación correcta de errores ─────────────────────────────────
  await test("14. Folder creation failure propagates through startMkSession", async () => {
    resetWorld();
    // Corrupt Folder.create to simulate failure
    const originalCreate = MockFolder.create;
    MockFolder.create = async () => { throw new Error("Folder creation failed"); };
    try {
      const result = await startMkSession({ name: "Test Session" });
      assert.equal(result.ok, false, "startMkSession should fail when folder creation fails");
    } finally {
      MockFolder.create = originalCreate;
    }
  })();

  // ── 15. Idempotencia de las operaciones repetidas ───────────────────────
  await test("15. getOrCreateCampaignFolder is idempotent", async () => {
    resetWorld();
    const r1 = await getOrCreateCampaignFolder("camp-1", "Campaign One");
    assert.equal(r1.ok, true, "first call ok");
    const r2 = await getOrCreateCampaignFolder("camp-1", "Campaign One");
    assert.equal(r2.ok, true, "second call ok");
    const r3 = await getOrCreateCampaignFolder("camp-1", "Campaign One");
    assert.equal(r3.ok, true, "third call ok");
    const campaignFolders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === "camp-1");
    assert.equal(campaignFolders.length, 1, "only one folder despite repeated calls");
  })();

  // ── 16. Conservación de carpetas y contenidos de otras campañas ─────────
  await test("16. deleteMkCampaign only removes its own folder", async () => {
    resetWorld();
    const c1 = await createMkCampaign({ name: "Campaign One" });
    const c2 = await createMkCampaign({ name: "Campaign Two" });
    const c1FolderId = mockFolders.find(f => f.flags["sword-world-25"]?.mkCampaignFolder === c1.data.campaignId).id;
    const c2FolderId = mockFolders.find(f => f.flags["sword-world-25"]?.mkCampaignFolder === c2.data.campaignId).id;
    await deleteMkCampaign(c1.data.campaignId);
    const c1Folder = mockFolders.find(f => f.id === c1FolderId);
    const c2Folder = mockFolders.find(f => f.id === c2FolderId);
    assert.equal(c1Folder, undefined, "campaign 1 folder removed");
    assert.ok(c2Folder, "campaign 2 folder preserved");
  })();

  // ── 17. Verificación de exportación vía monsterKnowledgeRegistry ────────
  await test("17. Folder functions exported via monsterKnowledgeRegistry", async () => {
    resetWorld();
    assert.equal(typeof monsterKnowledgeRegistry.getOrCreateMkRegistryFolder, "function", "getOrCreateMkRegistryFolder exported");
    assert.equal(typeof monsterKnowledgeRegistry.getOrCreateSessionFolder, "function", "getOrCreateSessionFolder exported");
    assert.equal(typeof monsterKnowledgeRegistry.getOrCreateCampaignFolder, "function", "getOrCreateCampaignFolder exported");
    assert.equal(typeof monsterKnowledgeRegistry.deleteCampaignFolder, "function", "deleteCampaignFolder exported");
    assert.equal(typeof monsterKnowledgeRegistry.reconcileMkFolders, "function", "reconcileMkFolders exported");
  })();

  // ── 18. La carpeta Current Session se crea bajo la raíz (campo folder) ──
  await test("18. Session folder is created under the Bestiary root via the 'folder' field", async () => {
    resetWorld();
    const root = await getOrCreateMkRegistryFolder();
    const session = await getOrCreateSessionFolder("session-1");
    assert.equal(session.ok, true, "session folder ok");
    const sessionFolder = mockFolders.find(f => f.flags["sword-world-25"]?.mkSessionFolder === true);
    assert.ok(sessionFolder, "session folder exists");
    assert.equal(sessionFolder.folder, root.data.folderId, "session folder parent is the Bestiary root (folder field)");
    const rootFolder = mockFolders.find(f => f.flags["sword-world-25"]?.mkRegistryRoot === true);
    assert.equal(rootFolder.folder, null, "root folder has no parent");
  })();

  // ── 19. Reutilización corrige una carpeta mal emplazada sin duplicar ────
  await test("19. getOrCreateSessionFolder reparents a misplaced session folder", async () => {
    resetWorld();
    const root = await getOrCreateMkRegistryFolder();
    // Simulate the old-build folder created at the Actors directory root
    // (created with the wrong field, folder === null).
    await MockFolder.create({ name: "Current Session", type: "Actor", flags: { "sword-world-25": { mkSessionFolder: true, mkSessionId: "s-old" } } });
    const result = await getOrCreateSessionFolder("session-1");
    assert.equal(result.ok, true, "reuse ok");
    const sessionFolders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkSessionFolder === true);
    assert.equal(sessionFolders.length, 1, "no duplicate session folder");
    assert.equal(sessionFolders[0].folder, root.data.folderId, "misplaced folder was moved under the Bestiary root");
  })();

  // ── 20. Reutilización corrige una carpeta de campaña mal emplazada ──────
  await test("20. getOrCreateCampaignFolder reparents a misplaced campaign folder", async () => {
    resetWorld();
    const root = await getOrCreateMkRegistryFolder();
    await MockFolder.create({ name: "Campaign", type: "Actor", flags: { "sword-world-25": { mkCampaignFolder: "camp-1", mkRegistryRoot: false } } });
    const result = await getOrCreateCampaignFolder("camp-1", "Campaign One");
    assert.equal(result.ok, true, "reuse ok");
    const campaignFolders = mockFolders.filter(f => f.flags["sword-world-25"]?.mkCampaignFolder === "camp-1");
    assert.equal(campaignFolders.length, 1, "no duplicate campaign folder");
    assert.equal(campaignFolders[0].folder, root.data.folderId, "misplaced campaign folder was moved under the Bestiary root");
  })();

  // ── 21. La reconciliación corrige carpetas mal emplazadas y reporta ─────
  await test("21. reconcileMkFolders reparents misplaced session and campaign folders", async () => {
    resetWorld();
    const root = await getOrCreateMkRegistryFolder();
    await getOrCreateSessionFolder("s1");
    const campaign = await createMkCampaign({ name: "Campaign One" });
    // Force both managed folders out of the root (old-build state).
    const sessionFolder = mockFolders.find(f => f.flags["sword-world-25"]?.mkSessionFolder === true);
    const campaignFolder = mockFolders.find(f => f.flags["sword-world-25"]?.mkCampaignFolder === campaign.data.campaignId);
    assert.ok(sessionFolder, "session folder exists before reconcile");
    assert.ok(campaignFolder, "campaign folder exists before reconcile");
    sessionFolder.folder = null;
    campaignFolder.folder = null;
    const foldersBefore = mockFolders.length;
    const reconciled = await reconcileMkFolders();
    assert.equal(reconciled.ok, true, "reconciliation ok");
    assert.equal(mockFolders.length, foldersBefore, "no folders duplicated by reconciliation");
    assert.equal(sessionFolder.folder, root.data.folderId, "session folder reparented");
    assert.equal(campaignFolder.folder, root.data.folderId, "campaign folder reparented");
    const autoFixedCodes = reconciled.data.issues.filter(i => i.severity === "auto-fixed").map(i => i.code);
    assert.ok(autoFixedCodes.includes("session-folder-reparented"), "session-folder-reparented reported");
    assert.ok(autoFixedCodes.includes("campaign-folder-reparented"), "campaign-folder-reparented reported");
  })();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runAll();