import assert from "node:assert/strict";
import { findSw25CanonicalSpellMatches, normalizeSpellData } from "../module/rules/spell-data.mjs";

// Global Foundry mocks
let mockDropSource = null;
globalThis.Item = globalThis.Item || {};
globalThis.Item.fromDropData = async (data) => {
  return mockDropSource;
};
const Item = globalThis.Item;

globalThis.Dialog = globalThis.Dialog || class {
  async render(options) {
    return new Promise(resolve => resolve(null));
  };
};

globalThis.ui = globalThis.ui || {};
globalThis.ui.notifications = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeMockActor(items = [], flags = {}) {
  const itemsMap = new Map();
  for (const item of items) itemsMap.set(item.id, item);
  const itemsArray = [...items];

  const actorItems = {
    get(id) { return itemsMap.get(id) || null; },
    filter(fn) { return itemsArray.filter(fn); },
    find(fn) { return itemsArray.find(fn); },
    findIndex(fn) { return itemsArray.findIndex(fn); },
    async createEmbeddedDocuments(type, docs) {
      const created = [];
      for (const doc of docs) {
        const id = doc._id || `item-${Math.random().toString(36).slice(2)}`;
        const item = { ...doc, id, parent: this };
        itemsMap.set(id, item);
        itemsArray.push(item);
        created.push(item);
      }
      return created;
    },
    async updateEmbeddedDocuments(type, updates) {
      for (const { _id, ...fields } of updates) {
        const item = itemsMap.get(_id);
        if (item) {
          for (const [k, v] of Object.entries(fields)) {
            item[k] = v;
          }
        }
      }
    },
    async update(fields) {
      for (const [k, v] of Object.entries(fields)) {
        this[k] = v;
      }
    },
    async remove(id) {
      const idx = itemsArray.findIndex(i => i.id === id);
      if (idx >= 0) {
        itemsArray.splice(idx, 1);
        itemsMap.delete(id);
      }
    },
  };

  const actor = {
    id: `actor-${Math.random().toString(36).slice(2)}`,
    uuid: null,
    documentName: "Actor",
    name: "Test Actor",
    type: "character",
    items: actorItems,
    flags,
    async createEmbeddedDocuments(type, docs) {
      return actorItems.createEmbeddedDocuments(type, docs);
    },
  };
  actor.uuid = `Actor.${actor.id}`;
  // Pre-placed items mirror real embedded Items: parent = the owning actor
  // (uuid + documentName), owner rights, and a working delete().
  for (const item of itemsArray) {
    item.parent = actor;
    item.isOwner = true;
    item.delete = async () => actorItems.remove(item.id);
  }
  actor.setFlag = async function(scope, key, value) {
    if (!this.flags[scope]) this.flags[scope] = {};
    this.flags[scope][key] = value;
  };
  return actor;
}


function makeMockClassItem(id, name, level = 1) {
  return {
    id,
    name,
    type: "class",
    system: { level, classType: "Wizard" },
  };
}

function makeMockSpellItem(id, name, classId = "", className = "", system = {}) {
  return {
    id,
    name,
    type: "spell",
    system: { classId, className, level: 1, mpCost: 0, ...system },
    // Foundry's Item#toObject is synchronous; an async mock would return a
    // Promise and `{ ...doc }` inside createEmbeddedDocuments would copy
    // nothing, breaking the drag & drop copy assertions.
    toObject() {
      return { ...this, system: { ...this.system } };
    },
  };
}

function makeMockWeaponItem(id, name, system = {}) {
  return {
    id,
    name,
    type: "weapon",
    system,
    toObject() {
      return { ...this, system: { ...this.system } };
    },
  };
}

/**
 * Dialog mock matching how the sheet drives the real Dialog: the promise is
 * resolved by the BUTTON callbacks (or `close`) inside the constructor data,
 * never by render's own return value. `choice` is the button label the mock
 * user presses; null presses nothing and only closes (resolves null).
 */
function makeDialogMock(choice) {
  return class {
    constructor(data) { this.data = data; }
    async render() {
      if (choice) this.data?.buttons?.[choice]?.callback?.();
      else this.data?.close?.();
      return this;
    }
  };
}

// ---------------------------------------------------------------------------
// Test sheet class with the actual _onDropItem method
// ---------------------------------------------------------------------------

class MockSheet {
  constructor(actor) {
    this.actor = actor;
    this._activeTab = null;
  }

  async _onDropItem(event, data) {
    const fromDropData = Item.implementation?.fromDropData ?? Item.fromDropData;
    const source = await fromDropData.call(Item.implementation ?? Item, data);
    if (!source) return null;
    if (source.type === "race") return null;
    if (source.parent?.uuid === this.actor.uuid) return source;

    if (source.type === "spell") {
      const destClass = await this._getSpellDestinationClass(source.name);
      if (!destClass) return null;

      const itemData = source.toObject();
      delete itemData._id;
      itemData.system = itemData.system || {};
      const normalized = normalizeSpellData(itemData.system, { name: source.name });
      itemData.system = normalized.system;
      // Phase 2 mirror of the production drop handler: canonical name + canonical duplicate check.
      if (normalized.nameChanged) itemData.name = normalized.name;
      itemData.system.classId = destClass.id;
      itemData.system.className = destClass.name;

      const canonicalName = normalized.name;
      // Phase 3 corrections mirror: the shared canonical lookup returns ALL
      // matches — multiple documents collapsing to one canonical identity are
      // a CONFLICT: reported and preserved (never merged/deleted, nothing new
      // created), exactly like the production drop handler.
      const matches = findSw25CanonicalSpellMatches(this.actor.items, canonicalName, {
        type: "spell", classId: destClass.id
      });
      if (matches.length > 1) {
        const listing = matches.map(item => `"${item.name}"`).join(", ");
        ui.notifications.warn(`Canonical identity conflict: ${listing} all resolve to the same spell in ${destClass.name}. Nothing was copied; resolve the duplicate documents manually.`);
        return null;
      }
      const existing = matches[0] ?? null;
      if (existing) {
        ui.notifications.info(`${source.name} is already known by ${destClass.name}.`);
        return existing;
      }

      const [created] = await this.actor.items.createEmbeddedDocuments("Item", [itemData]);
      ui.notifications.info(`${source.name} was copied to ${this.actor.name}.`);
      return created;
    }

    let move = false;
    if (source.parent?.documentName === "Actor") {
      const choice = await new Promise(resolve => new Dialog({
        title: `Trade ${source.name}`,
        content: `<p>Transfer <strong>${source.name}</strong> to ${this.actor.name}</p>`,
        buttons: {
          move: { label: "Move", callback: () => resolve("move") },
          copy: { label: "Copy", callback: () => resolve("copy") },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        },
        default: "move",
        close: () => resolve(null)
      }).render(true));
      if (!choice) return null;
      move = choice === "move";
      if (move && !source.isOwner) {
        ui.notifications.warn(`You cannot remove ${source.name} from ${source.parent.name}; it will be copied instead.`);
        move = false;
      }
    }

    const itemData = source.toObject();
    delete itemData._id;
    const [created] = await this.actor.items.createEmbeddedDocuments("Item", [itemData]);
    if (move) await source.delete();
    ui.notifications.info(`${source.name} was ${move ? "moved" : "copied"} to ${this.actor.name}.`);
    return created;
  }

  async _getSpellDestinationClass(spellName) {
    const classes = this.actor.items.filter(item => item.type === "class");

    if (classes.length === 0) {
      ui.notifications.warn("This character has no class pages. Spells cannot be added without a class.");
      return null;
    }

    if (classes.length === 1) {
      return classes[0];
    }

    const activeTab = this._activeTab;
    if (activeTab && activeTab.startsWith("class-")) {
      const activeClassId = activeTab.slice("class-".length);
      const activeClass = classes.find(item => item.id === activeClassId);
      if (activeClass) return activeClass;
    }

    return await this._selectSpellDestinationClassDialog(classes, spellName);
  }

  async _selectSpellDestinationClassDialog(classes, spellName) {
    return new Promise(resolve => {
      resolve(null);
    });
  }
}

// ---------------------------------------------------------------------------
// Test: Cross-actor spell drag & drop
// ---------------------------------------------------------------------------

console.log("=== Test: Cross-actor spell drag & drop ===");

// Test 1: Dragging a spell from one character to another creates a copy on the destination
{
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard");
  const sourceActor = makeMockActor([sourceSpell]);
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);
  const destActor = makeMockActor([wizard]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceSpell;
  const result = await sheet._onDropItem({}, {});

  const sourceSpells = sourceActor.items.filter(i => i.type === "spell" && i.name === "Fireball");
  assert.strictEqual(sourceSpells.length, 1, "Source actor still has Fireball");

  const destSpells = destActor.items.filter(i => i.type === "spell" && i.name === "Fireball");
  assert.strictEqual(destSpells.length, 1, "Destination actor has Fireball copy");
  assert.strictEqual(destSpells[0].system.classId, "class-wizard", "Copied spell has correct classId");
  assert.strictEqual(destSpells[0].system.className, "Wizard", "Copied spell has correct className");

  console.log("  PASS: Cross-actor spell drag creates copy on destination");
}

// Test 2: The original spell remains on the source character after a successful drop
{
  const sourceSpell = makeMockSpellItem("spell-magic-missile", "Magic Missile", "class-wizard", "Wizard");
  const sourceActor = makeMockActor([sourceSpell]);
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);
  const destActor = makeMockActor([wizard]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceSpell;
  await sheet._onDropItem({}, {});

  const sourceSpells = sourceActor.items.filter(i => i.type === "spell" && i.name === "Magic Missile");
  assert.strictEqual(sourceSpells.length, 1, "Source actor still has Magic Missile");
  assert.strictEqual(sourceSpells[0].id, sourceSpell.id, "Source spell ID unchanged");
  assert.strictEqual(sourceSpells[0].system.classId, "class-wizard", "Source spell classId unchanged");
  assert.strictEqual(sourceSpells[0].system.className, "Wizard", "Source spell className unchanged");

  console.log("  PASS: Original spell remains on source character after drop");
}

// Test 3: A dropped OLD-SCHEMA spell (compendium not migrated) is normalized on copy
{
  const sourceSpell = makeMockSpellItem("spell-frost-bolt", "Frost Bolt", "", "Sorcerer", {
    school: "Sorcerer", cost: "MP 6", power: 8, featureType: "spell", resourceData: { hpCost: "" },
    metadata: "Target: 1 enemy\nRange/Area: 2 (30m) / Shot\nDuration: Instant/2 rounds\nResistance: Half"
  });
  const sourceActor = makeMockActor([sourceSpell]);
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);
  const destActor = makeMockActor([wizard]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceSpell;
  await sheet._onDropItem({}, {});

  const destSpells = destActor.items.filter(i => i.type === "spell" && i.name === "Frost Bolt");
  assert.strictEqual(destSpells.length, 1, "Destination actor has Frost Bolt copy");
  const system = destSpells[0].system;
  assert.strictEqual(system.school, undefined, "Obsolete school field removed");
  assert.strictEqual(system.cost, undefined, "Obsolete cost field removed");
  assert.strictEqual(system.power, 8, "Power is retained as the catalog row selector");
  assert.strictEqual(system.featureType, undefined, "Obsolete featureType field removed");
  assert.strictEqual(system.resourceData, undefined, "Obsolete resourceData field removed");
  assert.strictEqual(system.resistance, "half", "Resistance derived from metadata");
  assert.strictEqual(system.usesFortitude, false, "Willpower by default");
  assert.deepEqual(system.range, { areas: 2, distance: 30 }, "Range derived from metadata");
  assert.strictEqual(system.area, "shot", "Propagation derived from metadata");
  assert.strictEqual(system.duration, "Instant/2 rounds", "Duration derived from metadata");
  assert.strictEqual(system.target, "character", "Target derived from metadata");
  assert.strictEqual(system.rank, 0, "Rank parsed from the name (no numeral)");
  assert.strictEqual(system.minorAction, false, "Minor Action marker absent");
  assert.strictEqual(system.combatPreparation, false, "Combat Preparation marker absent");
  assert.strictEqual(system.classId, "class-wizard", "Destination class association applied");

  console.log("  PASS: Old-schema spell normalized to the new schema on drop");
}

// Test 3b: A dropped MARKERED spell stores the CANONICAL name (metadata stays)
{
  const sourceSpell = makeMockSpellItem("spell-quick-shield", "⏩Quick Shield", "", "Wizard", {
    metadata: "Target: Caster\nRange/Area: Caster\nDuration: 3 rounds\nResistance: None"
  });
  const sourceActor = makeMockActor([sourceSpell]);
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);
  const destActor = makeMockActor([wizard]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceSpell;
  await sheet._onDropItem({}, {});

  const created = destActor.items.filter(i => i.type === "spell");
  assert.strictEqual(created.length, 1, "The dropped spell is copied");
  assert.strictEqual(created[0].name, "Quick Shield", "The stored name is canonical: the leading ⏩ is authoring metadata");
  assert.strictEqual(created[0].system.minorAction, true, "The ⏩ metadata persists in system.minorAction");
  assert.strictEqual(created[0].system.combatPreparation, false, "No △ marker was present");
  console.log("  PASS: Markered spell drop stores the canonical name with marker metadata");
}

// Test 3c: Duplicate detection compares CANONICAL names (both directions)
{
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);

  // Existing clean name, dropped markered spelling.
  const existingClean = makeMockSpellItem("spell-qs-existing", "Quick Shield", "class-wizard", "Wizard");
  const destActor = makeMockActor([wizard, existingClean]);
  const sheet = new MockSheet(destActor);
  mockDropSource = makeMockSpellItem("spell-qs-drop", "⏩Quick Shield", "class-wizard", "Wizard");
  const result = await sheet._onDropItem({}, {});
  assert.strictEqual(result?.id, existingClean.id, "A markered drop matches the clean-named existing spell");
  assert.strictEqual(destActor.items.filter(i => i.type === "spell").length, 1, "No duplicate created");

  // Existing markered name, dropped clean spelling.
  const existingMarkered = makeMockSpellItem("spell-qs-markered", "⏩Quick Shield", "class-wizard-2", "Wizard");
  const destActor2 = makeMockActor([makeMockClassItem("class-wizard-2", "Wizard", 5), existingMarkered]);
  const sheet2 = new MockSheet(destActor2);
  mockDropSource = makeMockSpellItem("spell-qs-drop2", "Quick Shield", "class-wizard", "Wizard");
  const result2 = await sheet2._onDropItem({}, {});
  assert.strictEqual(result2?.id, existingMarkered.id, "A clean drop matches the markered existing spell");
  assert.strictEqual(destActor2.items.filter(i => i.type === "spell").length, 1, "No duplicate created");

  console.log("  PASS: Duplicate detection compares canonical names in both directions");
}

// Test 3d: Multiple documents collapsing to ONE canonical identity are a
// conflict — reported and preserved; nothing is copied or deleted.
{
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);
  const first = makeMockSpellItem("spell-qs-legacy", "⏩Quick Shield", "class-wizard", "Wizard");
  const second = makeMockSpellItem("spell-qs-clean", "Quick Shield", "class-wizard", "Wizard");
  const destActor = makeMockActor([wizard, first, second]);
  const sheet = new MockSheet(destActor);

  const warnings = [];
  const originalWarn = ui.notifications.warn;
  ui.notifications.warn = message => { warnings.push(String(message)); };
  try {
    mockDropSource = makeMockSpellItem("spell-qs-drop", "Quick Shield", "class-wizard", "Wizard");
    const result = await sheet._onDropItem({}, {});
    assert.strictEqual(result, null, "the conflict copies nothing");
  } finally {
    ui.notifications.warn = originalWarn;
  }
  assert.strictEqual(warnings.length, 1, "the conflict is reported once");
  assert.ok(warnings[0].includes("conflict") && warnings[0].includes("Quick Shield"), "the report names the conflict");
  const spellsAfter = destActor.items.filter(i => i.type === "spell");
  assert.strictEqual(spellsAfter.length, 2, "both documents are preserved: never merged, never deleted");

  console.log("  PASS: Canonical identity conflict on drop is reported and preserved");
}

// Test 3: The original spell remains unchanged after a duplicate is detected on the destination
{
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard");
  const existingSpell = makeMockSpellItem("spell-existing", "Fireball", "class-wizard", "Wizard");
  const sourceActor = makeMockActor([sourceSpell]);
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);
  const destActor = makeMockActor([wizard, existingSpell]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceSpell;
  const result = await sheet._onDropItem({}, {});

  const sourceSpells = sourceActor.items.filter(i => i.type === "spell" && i.name === "Fireball");
  assert.strictEqual(sourceSpells.length, 1, "Source actor still has exactly one Fireball");

  const destSpells = destActor.items.filter(i => i.type === "spell" && i.name === "Fireball");
  assert.strictEqual(destSpells.length, 1, "Destination actor still has exactly one Fireball");

  console.log("  PASS: Original spell unchanged when duplicate detected on destination");
}

// Test 4: The original spell remains unchanged when destination has no classes
{
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard");
  const sourceActor = makeMockActor([sourceSpell]);
  const destActor = makeMockActor([]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceSpell;
  const result = await sheet._onDropItem({}, {});

  assert.strictEqual(result, null, "No classes returns null");

  const sourceSpells = sourceActor.items.filter(i => i.type === "spell" && i.name === "Fireball");
  assert.strictEqual(sourceSpells.length, 1, "Source actor still has Fireball");

  console.log("  PASS: Original spell unchanged when destination has no classes");
}

// Test 5: The original spell remains unchanged if creation on the destination fails
{
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard");
  const sourceActor = makeMockActor([sourceSpell]);
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);
  const destActor = makeMockActor([wizard]);
  const sheet = new MockSheet(destActor);

  const originalCreate = destActor.items.createEmbeddedDocuments.bind(destActor.items);
  destActor.items.createEmbeddedDocuments = async () => {
    throw new Error("Creation failed");
  };

  let creationFailed = false;
  try {
    mockDropSource = sourceSpell;
    await sheet._onDropItem({}, {});
  } catch (e) {
    creationFailed = true;
  }

  assert.ok(creationFailed, "Creation failure was thrown");

  const sourceSpells = sourceActor.items.filter(i => i.type === "spell" && i.name === "Fireball");
  assert.strictEqual(sourceSpells.length, 1, "Source actor still has Fireball after failed creation");

  const destSpells = destActor.items.filter(i => i.type === "spell" && i.name === "Fireball");
  assert.strictEqual(destSpells.length, 0, "Destination actor has no new spell after failed creation");

  console.log("  PASS: Original spell unchanged if creation on destination fails");
}

// Test 6: Dialog cancellation - source spell unchanged
{
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard");
  const sourceActor = makeMockActor([sourceSpell]);
  const fighter = makeMockClassItem("class-fighter", "Fighter", 3);
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);
  const destActor = makeMockActor([fighter, wizard]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceSpell;
  const result = await sheet._onDropItem({}, {});

  assert.strictEqual(result, null, "Dialog cancel returns null");

  const sourceSpells = sourceActor.items.filter(i => i.type === "spell" && i.name === "Fireball");
  assert.strictEqual(sourceSpells.length, 1, "Source actor still has Fireball after dialog cancel");

  console.log("  PASS: Original spell unchanged when dialog cancelled");
}

// Test 7: Compendium spell drag retains existing behavior
{
  const compendiumSpell = makeMockSpellItem("spell-compendium", "Compendium Fireball", "class-wizard", "Wizard");
  const sourceActor = makeMockActor([compendiumSpell]);
  const wizard = makeMockClassItem("class-wizard", "Wizard", 5);
  const destActor = makeMockActor([wizard]);
  const sheet = new MockSheet(destActor);

  mockDropSource = compendiumSpell;
  const result = await sheet._onDropItem({}, {});

  const sourceSpells = sourceActor.items.filter(i => i.type === "spell" && i.name === "Compendium Fireball");
  assert.strictEqual(sourceSpells.length, 1, "Source actor still has Compendium Fireball");

  const destSpells = destActor.items.filter(i => i.type === "spell" && i.name === "Compendium Fireball");
  assert.strictEqual(destSpells.length, 1, "Destination actor has Compendium Fireball copy");

  console.log("  PASS: Compendium spell drag retains existing behavior");
}

// Test 8: Non-spell Item transfer behavior unchanged (move allowed)
{
  const sourceWeapon = makeMockWeaponItem("item-sword", "Longsword", { usage: "1H", accuracy: 10, power: 15, critical: 10 });
  const sourceActor = makeMockActor([sourceWeapon]);
  const destActor = makeMockActor([]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceWeapon;

  const originalDialog = globalThis.Dialog;
  globalThis.Dialog = makeDialogMock("move");

  const result = await sheet._onDropItem({}, {});

  globalThis.Dialog = originalDialog;

  const sourceWeapons = sourceActor.items.filter(i => i.type === "weapon" && i.name === "Longsword");
  assert.strictEqual(sourceWeapons.length, 0, "Source actor no longer has Longsword (moved)");

  const destWeapons = destActor.items.filter(i => i.type === "weapon" && i.name === "Longsword");
  assert.strictEqual(destWeapons.length, 1, "Destination actor has Longsword");

  console.log("  PASS: Non-spell Item transfer behavior unchanged (move allowed)");
}

// Test 9: Non-spell Item copy behavior (copy selected)
{
  const sourceWeapon = makeMockWeaponItem("item-bow", "Longbow", { usage: "2H", accuracy: 12, power: 14, critical: 10 });
  const sourceActor = makeMockActor([sourceWeapon]);
  const destActor = makeMockActor([]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceWeapon;

  const originalDialog = globalThis.Dialog;
  globalThis.Dialog = makeDialogMock("copy");

  const result = await sheet._onDropItem({}, {});

  globalThis.Dialog = originalDialog;

  const sourceWeapons = sourceActor.items.filter(i => i.type === "weapon" && i.name === "Longbow");
  assert.strictEqual(sourceWeapons.length, 1, "Source actor still has Longbow (copied)");

  const destWeapons = destActor.items.filter(i => i.type === "weapon" && i.name === "Longbow");
  assert.strictEqual(destWeapons.length, 1, "Destination actor has Longbow");

  console.log("  PASS: Non-spell Item copy behavior preserved");
}

// Test 10: Non-spell Item cancel - source preserved
{
  const sourceWeapon = makeMockWeaponItem("item-dagger", "Dagger", { usage: "1H", accuracy: 8, power: 10, critical: 10 });
  const sourceActor = makeMockActor([sourceWeapon]);
  const destActor = makeMockActor([]);
  const sheet = new MockSheet(destActor);

  mockDropSource = sourceWeapon;

  const originalDialog = globalThis.Dialog;
  globalThis.Dialog = makeDialogMock(null);

  const result = await sheet._onDropItem({}, {});

  globalThis.Dialog = originalDialog;

  assert.strictEqual(result, null, "Cancel returns null");

  const sourceWeapons = sourceActor.items.filter(i => i.type === "weapon" && i.name === "Dagger");
  assert.strictEqual(sourceWeapons.length, 1, "Source actor still has Dagger after cancel");

  const destWeapons = destActor.items.filter(i => i.type === "weapon" && i.name === "Dagger");
  assert.strictEqual(destWeapons.length, 0, "Destination actor has no Dagger after cancel");

  console.log("  PASS: Non-spell Item cancel preserves source");
}

// ---------------------------------------------------------------------------
console.log("\n=== All spell drag & drop tests passed ===");
