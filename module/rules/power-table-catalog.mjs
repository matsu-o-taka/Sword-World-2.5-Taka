import POWER_TABLE_CATALOG from "../data/power-table-catalog.json" with { type: "json" };

const POWER_TABLES = POWER_TABLE_CATALOG.tables ?? [];
const POWER_TABLES_BY_ID = new Map(
  POWER_TABLES.map(table => [table.id, new Map((table.rows ?? []).map(row => [Number(row.power), row.results]))])
);

/**
 * Resolve one catalog row as an Item-local 3–12 result map.
 *
 * A missing, blank, non-integer, or out-of-range Power does not resolve and
 * therefore leaves any custom Item table untouched.
 *
 * @param {unknown} power - The Item's system.power value.
 * @param {string} [tableId] - Catalog table identifier.
 * @returns {Record<string, number> | null}
 */
export function powerTableFor(power, tableId = "core-rulebook-iii.power-table") {
  if (power === null || power === undefined || String(power).trim() === "") return null;
  const numericPower = Number(power);
  if (!Number.isInteger(numericPower)) return null;
  const sourceRow = POWER_TABLES_BY_ID.get(tableId)?.get(numericPower);
  if (!sourceRow) return null;
  return Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => {
      const result = String(index + 3);
      return [result, Number(sourceRow[result])];
    })
  );
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function changedPower(changes) {
  if (own(changes, "system.power")) return { present: true, value: changes["system.power"], nested: false };
  if (own(changes?.system, "power")) return { present: true, value: changes.system.power, nested: true };
  return { present: false, value: undefined, nested: false };
}

function writePowerTableChange(changes, table, nested) {
  if (nested) {
    changes.system ??= {};
    for (const key of Object.keys(changes.system)) {
      if (key === "powerTable" || key.startsWith("powerTable.")) delete changes.system[key];
    }
    changes.system.powerTable = table;
    return;
  }
  for (const key of Object.keys(changes)) {
    if (key === "system.powerTable" || key.startsWith("system.powerTable.")) delete changes[key];
  }
  changes["system.powerTable"] = table;
}

/**
 * Synchronize a pending Item's local table during Foundry's pre-create phase.
 * The Item retains its own copy; consumers do not consult the catalog.
 *
 * @param {object} item - Pending Foundry Item document.
 * @returns {boolean} Whether a catalog row was applied.
 */
export function syncPowerTableOnCreate(item, data = item) {
  const sourceSystem = data?.system ?? {};
  const powerWasProvided = own(sourceSystem, "power") || own(data, "system.power");
  if (!powerWasProvided) return false;
  const table = powerTableFor(item?.system?.power);
  if (!table || typeof item?.updateSource !== "function") return false;
  item.updateSource({ system: { powerTable: table } });
  return true;
}

/**
 * Synchronize only when a differential update explicitly changes system.power.
 * Direct table edits remain independent unless Power changes in that same
 * update, in which case the selected catalog row is authoritative.
 *
 * @param {object} item - Existing Foundry Item document.
 * @param {object} changes - Foundry differential update data; mutated in place.
 * @returns {boolean} Whether a catalog row was applied.
 */
export function syncPowerTableOnUpdate(item, changes) {
  const power = changedPower(changes);
  if (!power.present) return false;
  const table = powerTableFor(power.value);
  if (!table) return false;
  writePowerTableChange(changes, table, power.nested);
  return true;
}

/**
 * Register document lifecycle synchronization for all Item types that expose
 * system.power. Normal damage and recovery rolls continue using Item-local data.
 */
export function initializePowerTableCatalog() {
  Hooks.on("preCreateItem", (item, data) => {
    syncPowerTableOnCreate(item, data);
  });
  Hooks.on("preUpdateItem", (item, changes) => {
    syncPowerTableOnUpdate(item, changes);
  });
}
