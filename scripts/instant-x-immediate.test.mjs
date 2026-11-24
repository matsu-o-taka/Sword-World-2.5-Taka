// Instant/X immediate-component dispatch tests. The persistent component is
// covered by effects-instant-x-application.test.mjs and spell-cast.test.mjs.
import assert from "node:assert/strict";

globalThis.game = { items: new Map() };

const {
  resolveCastImmediateComponents,
  registerSw25InstantXImmediateHandler
} = await import("../module/rules/spell-cast.mjs");

const target = { id: "target-1", uuid: "Actor.target-1", name: "Target" };
const spell = (name, extra = {}) => ({
  type: "spell",
  id: `spell-${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  uuid: `Item.${name}`,
  system: { duration: "Instant/3 rounds", ...extra }
});

// Damage Instant/X: the handler only enables a later, target-specific manual
// damage roll; it never rolls or applies damage during casting.
{
  const components = await resolveCastImmediateComponents({
    spell: spell("Chilling Breath"),
    targetResults: [{ target, resisted: false }]
  });
  assert.equal(components.length, 1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(components[0]).filter(([key]) => key !== "target")),
    { kind: "manual-damage", targetUuid: target.uuid, targetName: target.name }
  );
  assert.equal("changes" in components[0], false, "immediate data is not an ActiveEffect change");
}

// Non-damage Instant/X: water creation is resolved at cast time; drinking and
// healing remain a later major action.
{
  const components = await resolveCastImmediateComponents({
    spell: spell("Healing Water"),
    targetResults: [{ target, resisted: false }]
  });
  assert.equal(components.length, 1);
  assert.equal(components[0].kind, "created-water");
}

// A resisted target is excluded; duplicate target results do not dispatch a
// second time for the same target in this cast.
{
  let calls = 0;
  const unregister = registerSw25InstantXImmediateHandler("Test Immediate", async () => {
    calls += 1;
    return { kind: "test" };
  });
  try {
    const components = await resolveCastImmediateComponents({
      spell: spell("Test Immediate"),
      targetResults: [
        { target, resisted: true },
        { target, resisted: false },
        { target, resisted: false }
      ]
    });
    assert.equal(calls, 1);
    assert.equal(components.length, 1);
  } finally {
    unregister();
  }
}

// A resolver failure is logged and not retried for duplicate target entries;
// it does not prevent the caller from proceeding with persistent creation.
{
  let calls = 0;
  const originalError = console.error;
  console.error = () => {};
  const unregister = registerSw25InstantXImmediateHandler("Failing Immediate", async () => {
    calls += 1;
    throw new Error("simulated partial failure");
  });
  try {
    const components = await resolveCastImmediateComponents({
      spell: spell("Failing Immediate"),
      targetResults: [
        { target, resisted: false },
        { target, resisted: false }
      ]
    });
    assert.equal(calls, 1);
    assert.deepEqual(components, []);
  } finally {
    unregister();
    console.error = originalError;
  }
}

console.log("Instant/X immediate resolution tests passed.");
