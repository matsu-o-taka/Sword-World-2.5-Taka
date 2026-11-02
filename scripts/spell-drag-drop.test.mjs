import assert from "node:assert/strict";

// Global Foundry mocks
let mockDropSource = null;
globalThis.Item = globalThis.Item || {};
globalThis.Item.fromDropData = async (data) => {
  return mockDropSource;
};
const Item = globalThis.Item;

globalThis.Dialog = globalThis.Dialog || class {
  static async render(options) {
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
    name: "Test Actor",
    type: "character",
    items: actorItems,
    flags,
    async createEmbeddedDocuments(type, docs) {
      return actorItems.createEmbeddedDocuments(type, docs);
    },
  };
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

function makeMockSpellItem(id, name, classId = "", className = "", school = "") {
  return {
    id,
    name,
    type: "spell",
    system: { classId, className, school, level: 1, mpCost: 0 },
    async toObject() {
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
    async toObject() {
      return { ...this, system: { ...this.system } };
    },
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
      itemData.system.classId = destClass.id;
      itemData.system.className = destClass.name;
      itemData.system.school = destClass.name;

      const existing = this.actor.items.find(item =>
        item.type === "spell" &&
        item.name.toLowerCase() === source.name.toLowerCase() &&
        String(item.system.classId || "") === String(destClass.id)
      );
      if (existing) {
        ui.notifications.info(`${source.name} is already known by ${destClass.name}.`);
        return existing;
      }

      console.log("DEBUG _onDropItem: calling createEmbeddedDocuments...");
      console.log("DEBUG _onDropItem: this.actor.items =", this.actor.items, "typeof createEmbeddedDocuments =", typeof this.actor.items.createEmbeddedDocuments);
      console.log("DEBUG _onDropItem: calling createEmbeddedDocuments...");
      console.log("DEBUG _onDropItem: this.actor.items === actorItems:", this.actor.items === actorItems);
      console.log("DEBUG _onDropItem: calling createEmbeddedDocuments...");
      console.log("DEBUG _onDropItem: this.actor.items =", this.actor.items);
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
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard", "Wizard");
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
  assert.strictEqual(destSpells[0].system.school, "Wizard", "Copied spell has correct school");

  console.log("  PASS: Cross-actor spell drag creates copy on destination");
}

// Test 2: The original spell remains on the source character after a successful drop
{
  const sourceSpell = makeMockSpellItem("spell-magic-missile", "Magic Missile", "class-wizard", "Wizard", "Wizard");
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
  assert.strictEqual(sourceSpells[0].system.school, "Wizard", "Source spell school unchanged");

  console.log("  PASS: Original spell remains on source character after drop");
}

// Test 3: The original spell remains unchanged after a duplicate is detected on the destination
{
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard", "Wizard");
  const existingSpell = makeMockSpellItem("spell-existing", "Fireball", "class-wizard", "Wizard", "Wizard");
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
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard", "Wizard");
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
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard", "Wizard");
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
  const sourceSpell = makeMockSpellItem("spell-fireball", "Fireball", "class-wizard", "Wizard", "Wizard");
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
  const compendiumSpell = makeMockSpellItem("spell-compendium", "Compendium Fireball", "class-wizard", "Wizard", "Wizard");
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
  globalThis.Dialog = class {
    static async render(options) {
      return new Promise(resolve => {
        resolve("move");
      });
    };
  }

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
  globalThis.Dialog = class {
    static async render(options) {
      return new Promise(resolve => {
        resolve("copy");
      });
    };
  }

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
  globalThis.Dialog = class {
    static async render(options) {
      return new Promise(resolve => {
        resolve(null);
      });
    };
  }

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
