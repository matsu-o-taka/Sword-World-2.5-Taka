// Sword World 2.5 - UI integration test
// Verifies the sheet templates and listener bindings for the character combat
// UI adjustments:
//   - the character attack button in the Roll column initiates the normal
//     attack flow (no independent damage button),
//   - the residual Accuracy attack button is removed; Accuracy is a
//     non-interactive display,
//   - Extra Damage is displayed beside Accuracy, non-interactive,
//   - Additional Damage remains editable,
//   - monster Accuracy/Damage controls have distinct icons, descriptive
//     tooltips, and a GM gate on the attack path,
//   - attack failures surface through describeTargetFailure,
//   - new monster actors get the activeCombatRolls default from template.json.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url).href;
const read = rel => readFile(new URL(rel, root), "utf8");

const characterSheet = await read("templates/actor/character-sheet.hbs");
const monsterSheet = await read("templates/actor/monster-sheet.hbs");
const actorSheet = await read("module/actor/actor-sheet.mjs");
const monsterModule = await read("module/actor/monster-sheet.mjs");
const template = await read("template.json");

function indexOfBetween(text, needle, label) {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `${label} contains "${needle}"`);
  return index;
}

function controlText(text, needle, label) {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `${label} contains "${needle}"`);
  const start = text.lastIndexOf("<button", index);
  const end = text.indexOf("</button>", index);
  assert.ok(start >= 0 && end > start, `${label} extracts the full button for ${needle}`);
  return text.slice(start, end + "</button>".length);
}

// The independent weapon damage button must NOT be in the Roll column.
assert.ok(
  !characterSheet.includes('data-action="roll-weapon-damage"'),
  "Independent weapon damage button removed from Roll column"
);

console.log("=== Accuracy is non-interactive; Extra Damage beside it ===");

// The residual Accuracy attack button must be removed.
assert.ok(
  !characterSheet.includes('data-action="roll-check" data-check="accuracy"'),
  "Residual Accuracy attack button removed from offense-selector"
);

// Accuracy must appear as non-interactive text.
assert.match(
  characterSheet,
  /Accuracy\s+<strong>\{\{calculated\.accuracy\}\}\<\/strong>/,
  "Accuracy displayed as non-interactive text"
);

// Extra Damage must appear beside Accuracy.
assert.match(
  characterSheet,
  /Extra Damage\s+<strong>\{\{calculated\.extraDamage\}\}\<\/strong>/,
  "Extra Damage displayed beside Accuracy"
);

// Additional Damage must remain editable.
assert.match(
  characterSheet,
  /name="system\.combat\.additionalDamage"/,
  "Additional Damage remains an editable input"
);

console.log("=== actor-sheet: no independent damage handler ===");

// The independent roll-weapon-damage listener binding must be removed.
assert.ok(
  !actorSheet.includes("_onRollWeaponDamage.bind"),
  "roll-weapon-damage handler bind removed from actor-sheet"
);
// The _onRollWeaponDamage method must be removed.
assert.ok(
  !actorSheet.includes("async _onRollWeaponDamage"),
  "_onRollWeaponDamage method removed from actor-sheet"
);

console.log("=== Monster sheet accuracy and damage controls ===");

{
  const accuracyTag = controlText(monsterSheet, 'data-action="roll-monster-accuracy"', "monster-sheet.hbs");
  assert.match(accuracyTag, /fa-crosshairs/, "Monster Accuracy uses the attack (crosshairs) glyph");
  assert.doesNotMatch(accuracyTag, /fa-dice-d6/, "Monster Accuracy button is not the damage glyph");
  assert.match(accuracyTag, /title=/, "Monster Accuracy button has a tooltip");
  assert.match(accuracyTag, /Evasion/i, "Accuracy tooltip explains the targeted Evasion exchange");
  assert.match(accuracyTag, /GM only/, "Accuracy tooltip advertises the GM gating");
  assert.match(accuracyTag, /targeted/i, "Accuracy tooltip explains the targeted flow");
}
{
  const damageTag = controlText(monsterSheet, 'data-action="roll-monster-damage"', "monster-sheet.hbs");
  assert.match(damageTag, /fa-dice-d6/, "Monster Damage keeps its dice glyph");
  assert.match(damageTag, /Roll damage \(independent of attack\)/, "Damage tooltip marks it as a plain damage roll");
}

{
  const accuracyHandler = monsterModule.slice(
    monsterModule.indexOf("[data-action='roll-monster-accuracy']"),
    monsterModule.indexOf("[data-action='roll-monster-initiative']")
  );
  const gmGate = accuracyHandler.indexOf("if (!game.user.isGM) return;");
  assert.ok(gmGate >= 0, "Accuracy handler is GM-gated");
  assert.ok(
    gmGate < accuracyHandler.indexOf("readMonsterActorCombatStyles(this.actor)"),
    "GM gate runs before any roll or flow code"
  );
  assert.match(accuracyHandler, /monsterWeaponAttackFlow\(/, "Accuracy handler runs the monster attack flow");
  assert.match(accuracyHandler, /describeTargetFailure\("not-character"\)/, "Character-only target failure is explained");
  assert.match(accuracyHandler, /describeTargetFailure\("no-defense"\)/, "Missing Evasion failure is explained");
  assert.match(accuracyHandler, /describeTargetFailure\("multiple"\)/, "Multiple targets failure is explained");
  assert.match(accuracyHandler, /status === "cancelled"/, "The old modal-cancel behaviours still return silently");
}

console.log("=== Sheet data plumbing ===");

assert.match(
  await readFile(new URL("../module/combat/attack-resolution.mjs", import.meta.url), "utf8"),
  /activeCombatRolls/,
  "attack resolution honours the per-monster activeCombatRolls field"
);
assert.match(monsterModule, /getMonsterActiveCombatRolls\(/, "monster-sheet respects the toggle for manual rolls");
assert.match(
  monsterSheet,
  /name="system\.activeCombatRolls"/,
  "Monster sheet keeps the toggle control bound to the data path"
);

console.log("=== template.json defaults ===");

{
  const monsterBlockStart = template.indexOf('"monster": {', template.indexOf('"Actor"'));
  assert.ok(monsterBlockStart > 0, "template.json has an Actor monster data model");
  const monsterBlock = template.slice(monsterBlockStart, template.indexOf('"Item"', monsterBlockStart));
  assert.match(
    monsterBlock,
    /"activeCombatRolls":\s*false/,
    "New monster actors default to fixed combat rolls"
  );
}

console.log("=== Extra Damage calculation formula ===");

// Extra Damage = Offensive Class Level + Strength Modifier + Additional Damage
assert.ok(
  actorSheet.includes("calculated.extraDamage") &&
  actorSheet.includes("offenseClassLevel") &&
  actorSheet.includes("bonuses.strength") &&
  actorSheet.includes("system.combat?.additionalDamage"),
  "Extra Damage formula: offenseClassLevel + strength bonus + additionalDamage"
);

// The offenseClassLevel itself comes from the offensive class level
assert.match(
  actorSheet,
  /isWarriorClass\(offenseClass\)\s*\?\s*this\._classLevel\(offenseClass\)/,
  "Offense class level is the warrior class level"
);

console.log("ui-integration: all checks passed");
