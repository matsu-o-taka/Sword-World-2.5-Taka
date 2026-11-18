import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

globalThis.foundry = { utils:{ escapeHTML:value => String(value ?? "") } };
const { damageApplicationButton } = await import("../module/combat/damage-application.mjs");
const targetless = damageApplicationButton(23, "physical", true);
assert.equal((targetless.match(/data-sw25-chat-action="apply-damage"/g) ?? []).length, 2);
assert.ok(!targetless.includes("data-actor-id="), "targetless result does not capture ambient target state");
assert.ok(targetless.includes('data-damage="23"'), "each application control carries this card's calculated result");

const targeted = damageApplicationButton(41, "magical", false, "section-a", "Scene.s.Token.t.Actor.a");
assert.ok(targeted.includes('data-damage="41"'));
assert.ok(targeted.includes('data-actor-id="Scene.s.Token.t.Actor.a"'), "original target is explicit on its own result card");
assert.ok(targeted.includes('data-combat-style-id="section-a"'), "monster section context remains explicit");

const source = await readFile(new URL("../module/combat/damage-application.mjs", import.meta.url), "utf8");
assert.ok(source.includes("Select one or more targets"), "target selection happens on the application controls, not the damage roll");
assert.ok(source.includes("for (const uuid of selectedUuids)"), "targetless cards can apply their result to multiple explicit targets");
assert.ok(!source.includes("game?.user?.targets"), "application never substitutes globally selected targets");

console.log("Damage application context tests passed.");
