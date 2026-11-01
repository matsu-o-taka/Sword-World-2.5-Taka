import assert from "node:assert/strict";
import { applyDamage } from "../module/combat/damage-application.mjs";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    escapeHTML: value => String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character])
  }
};
const messages = [];
globalThis.ChatMessage = { create: async message => messages.push(message) };

function monster({ defense = 2, hp = 10, sectionLabel = "Body" } = {}) {
  const actor = {
    name: "Test Hydra",
    type: "monster",
    system: {
      combatStyles: [{
        style: "Bite",
        sectionLabel,
        defense,
        hp: { value: hp, max: 10 }
      }]
    },
    updates: [],
    async update(update) {
      this.updates.push(update);
      this.system.combatStyles = update["system.combatStyles"];
    }
  };
  return actor;
}

const physical = monster();
await applyDamage({ actor: physical, total: 8, damageType: "physical" });
assert.equal(physical.system.combatStyles[0].hp.value, 4);

const half = monster();
await applyDamage({ actor: half, total: 8, damageType: "physical", factor: 0.5 });
assert.equal(half.system.combatStyles[0].hp.value, 8);

const magical = monster({ defense: "※+20" });
await applyDamage({ actor: magical, total: 8, damageType: "magical" });
assert.equal(magical.system.combatStyles[0].hp.value, 2);

for (const defense of ["-", "※", "※+20"]) {
  const target = monster({ defense });
  const before = structuredClone(target.system);
  const messageCount = messages.length;
  await assert.rejects(
    applyDamage({ actor: target, total: 8, damageType: "physical" }),
    new RegExp(`Test Hydra — Body has non-numeric Defense`)
  );
  assert.deepEqual(target.system, before);
  assert.equal(target.updates.length, 0);
  assert.equal(messages.length, messageCount);
}

for (const hp of ["-", "※", "※+20"]) {
  const target = monster({ hp });
  const before = structuredClone(target.system);
  const messageCount = messages.length;
  await assert.rejects(
    applyDamage({ actor: target, total: 8, damageType: "physical" }),
    /Test Hydra — Body has non-numeric HP/
  );
  assert.deepEqual(target.system, before);
  assert.equal(target.updates.length, 0);
  assert.equal(messages.length, messageCount);
}

const zeroValues = monster({ defense: 0, hp: 0 });
await applyDamage({ actor: zeroValues, total: 0, damageType: "physical" });
assert.equal(zeroValues.system.combatStyles[0].hp.value, 0);

const invalidTotal = monster();
const invalidTotalBefore = structuredClone(invalidTotal.system);
await assert.rejects(applyDamage({ actor: invalidTotal, total: "not a number", damageType: "physical" }), /invalid damage total/);
assert.deepEqual(invalidTotal.system, invalidTotalBefore);
assert.equal(invalidTotal.updates.length, 0);

console.log("Monster damage special-value safety tests passed.");
