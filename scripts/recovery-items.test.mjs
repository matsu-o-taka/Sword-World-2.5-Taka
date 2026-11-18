import assert from "node:assert/strict";
import { recoveryPowerResult, recoveryPowerTableHTML } from "../module/rules/recovery-items.mjs";

globalThis.foundry = { utils: { escapeHTML: value => String(value ?? "") } };

const item = {
  id: "custom-recovery",
  type: "equipment",
  name: "Custom Recovery Herb",
  system: {
    hasPowerTable: true,
    additionalDamage: 2,
    powerTable: { "3":1, "4":2, "5":3, "6":4, "7":5, "8":6, "9":7, "10":8, "11":9, "12":10 }
  }
};

assert.equal(Object.hasOwn(item.system, "power"), false, "a custom recovery table does not require system.power");
assert.deepEqual(recoveryPowerResult(item, 7), { lookup:7, tableResult:5, additional:2, total:7 });
assert.deepEqual(recoveryPowerResult(item, 2), { lookup:3, tableResult:1, additional:2, total:3 }, "the legacy lower clamp and additional recovery remain");
assert.deepEqual(
  recoveryPowerResult({ system: { powerTable:{ "3":1 }, additionalDamage:2 } }, 8),
  { lookup:8, tableResult:0, additional:2, total:2 },
  "a missing table row retains the zero fallback and additional recovery"
);
assert.deepEqual(
  recoveryPowerResult({ system: { powerTable:{ "7":-5 }, additionalDamage:1 } }, 7),
  { lookup:7, tableResult:-5, additional:1, total:0 },
  "the recovery-specific nonnegative clamp remains outside the shared lookup"
);
const html = recoveryPowerTableHTML(item, { id:"actor-1" });
for (let total = 3; total <= 12; total++) {
  assert.ok(html.includes(`<strong>${total}</strong><br>${total - 2}`), `recovery table display resolves row ${total}`);
}

console.log("Recovery Power Table tests passed.");
