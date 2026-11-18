import assert from "node:assert/strict";
import catalog from "../module/data/power-table-catalog.json" with { type: "json" };
import {
  initializePowerTableCatalog,
  powerTableFor,
  syncPowerTableOnCreate,
  syncPowerTableOnUpdate
} from "../module/rules/power-table-catalog.mjs";

const table = catalog.tables.find(entry => entry.id === "core-rulebook-iii.power-table");
assert.ok(table, "Core Rulebook III Power Table exists in the packaged catalog");
assert.equal(table.rows.length, 101);

for (let power = 0; power <= 100; power++) {
  const source = table.rows[power];
  assert.equal(source.power, power);
  assert.deepEqual(powerTableFor(power), source.results, `Power ${power} resolves to its exact 3–12 row`);
}
assert.equal(powerTableFor(null), null);
assert.equal(powerTableFor(undefined), null);
assert.equal(powerTableFor(""), null);
assert.equal(powerTableFor(101), null);
assert.equal(powerTableFor(-1), null);
assert.equal(powerTableFor(1.5), null);

function makeItem(type, system) {
  return {
    type,
    system,
    updateSource(source) {
      this.system = { ...this.system, ...source.system };
    }
  };
}

// Manually-created Items of each supported family receive a self-contained
// local row at creation.
for (const type of ["weapon", "equipment", "spell"]) {
  const item = makeItem(type, { power: 25, powerTable: { "3": -1 } });
  assert.equal(syncPowerTableOnCreate(item, { system: { power: 25 } }), true);
  assert.deepEqual(item.system.powerTable, table.rows[25].results);
}

// Existing imported Items carrying both Power and a local row stay functional:
// creation refreshes the row from the same canonical Power.
const imported = makeItem("weapon", { power: 20, powerTable: { ...table.rows[20].results } });
assert.equal(syncPowerTableOnCreate(imported, { system: { power: 20, powerTable: imported.system.powerTable } }), true);
assert.deepEqual(imported.system.powerTable, table.rows[20].results);

// Without a defined Power, a custom table is retained and never cleared.
const custom = makeItem("spell", { power: null, powerTable: { "3": 91, "12": 97 } });
assert.equal(syncPowerTableOnCreate(custom, { system: { power: null, powerTable: custom.system.powerTable } }), false);
assert.deepEqual(custom.system.powerTable, { "3": 91, "12": 97 });
const implicitDefaultPower = makeItem("equipment", { power: 0, powerTable: { "3": 88 } });
assert.equal(syncPowerTableOnCreate(implicitDefaultPower, { system: { powerTable: implicitDefaultPower.system.powerTable } }), false);
assert.deepEqual(implicitDefaultPower.system.powerTable, { "3": 88 });

// A flat Power edit replaces any simultaneous manual cell edits with the
// selected complete catalog row.
const flatChanges = { "system.power": 35, "system.powerTable.3": 999, "system.powerTable.12": 999 };
assert.equal(syncPowerTableOnUpdate(imported, flatChanges), true);
assert.deepEqual(flatChanges, { "system.power": 35, "system.powerTable": table.rows[35].results });

// Nested update data is supported as well.
const nestedChanges = { system: { power: 10, powerTable: { "3": -1 } } };
assert.equal(syncPowerTableOnUpdate(makeItem("spell", { power: 25 }), nestedChanges), true);
assert.deepEqual(nestedChanges.system.powerTable, table.rows[10].results);

// Table-only edits remain custom if Power is not part of the same update.
const tableOnlyChanges = { "system.powerTable.3": 88 };
assert.equal(syncPowerTableOnUpdate(makeItem("equipment", { power: 20 }), tableOnlyChanges), false);
assert.deepEqual(tableOnlyChanges, { "system.powerTable.3": 88 });

// Clearing Power or selecting an unsupported value never overwrites the
// existing local table.
const clearPowerChanges = { "system.power": null, "system.powerTable.3": 77 };
assert.equal(syncPowerTableOnUpdate(imported, clearPowerChanges), false);
assert.deepEqual(clearPowerChanges, { "system.power": null, "system.powerTable.3": 77 });
const unsupportedPowerChanges = { system: { power: 101, powerTable: { "3": 44 } } };
assert.equal(syncPowerTableOnUpdate(imported, unsupportedPowerChanges), false);
assert.deepEqual(unsupportedPowerChanges.system.powerTable, { "3": 44 });

// The production lifecycle hook registration uses the supported v14-specific
// preCreateItem/preUpdateItem hooks and delegates to the same tested logic.
const hooks = new Map();
globalThis.Hooks = {
  on(event, callback) {
    hooks.set(event, callback);
  }
};
initializePowerTableCatalog();
assert.equal(typeof hooks.get("preCreateItem"), "function");
assert.equal(typeof hooks.get("preUpdateItem"), "function");
const hookCreated = makeItem("spell", { power: 100, powerTable: {} });
hooks.get("preCreateItem")(hookCreated, { system: { power: 100 } });
assert.deepEqual(hookCreated.system.powerTable, table.rows[100].results);
const hookChanges = { "system.power": 0 };
hooks.get("preUpdateItem")(hookCreated, hookChanges);
assert.deepEqual(hookChanges["system.powerTable"], table.rows[0].results);

console.log("power-table-catalog.test.mjs: 101 catalog rows and lifecycle synchronization passed.");
