import assert from "node:assert/strict";
import { resolvePowerTableResult } from "../module/rules/power-table.mjs";
import { resolveSpecialSpellDamage, specialDamageBands } from "../module/rules/spell-damage.mjs";

const table = Object.fromEntries(
  Array.from({ length:10 }, (_, index) => [String(index + 3), (index + 3) * 2])
);
const customItem = { type: "spell", system: { powerTable: table } };
assert.equal(Object.hasOwn(customItem.system, "power"), false, "custom tables work without `system.power`");

for (let naturalTotal = 3; naturalTotal <= 12; naturalTotal++) {
  assert.deepEqual(
    resolvePowerTableResult(customItem, naturalTotal),
    { lookup:naturalTotal, result:naturalTotal * 2 },
    `natural total ${naturalTotal} resolves from the item's local table`
  );
}
assert.deepEqual(resolvePowerTableResult(customItem, 2), { lookup:3, result:6 }, "the legacy lower clamp remains");
assert.deepEqual(resolvePowerTableResult(customItem, 13), { lookup:12, result:24 }, "the legacy upper clamp remains");
assert.deepEqual(resolvePowerTableResult({ system: { powerTable: {} } }, 8), { lookup:8, result:0 }, "a missing row defaults to zero");
assert.ok(Number.isNaN(resolvePowerTableResult({ system: { powerTable: { "8":"-" } } }, 8).result), "unsupported nonnumeric entries retain Number() behavior");

const bands = [{ min:2, max:6, bonus:4, damageType:"physical", text:"Special damage band." }];
const specialSpell = { system: { specialDamageBands:bands, powerTable:{ "4":999 } } };
assert.equal(specialDamageBands(specialSpell), bands, "specialDamageBands remains an independent representation");
assert.deepEqual(resolveSpecialSpellDamage(bands, 4, 7), { band:bands[0], bonus:4, total:11 });

console.log("Shared Power Table lookup tests passed.");
