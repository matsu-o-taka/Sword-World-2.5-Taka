// Sword World 2.5 - Spellcasting UI connection tests.
//
// The sheet handlers must DELEGATE to the centralized Spellcasting flow
// (rules/spell-cast.mjs); they own no casting logic of their own. Verified
// connections:
//   - character-sheet.hbs exposes the three existing controls: Cast (Major),
//     ⏩ (Minor) and △ (Combat Preparation), gated by the spell's modality
//     markers annotated in getData.
//   - actor-sheet.mjs routes each control to its corresponding modality
//     entry point (castSpellAsMajor / castSpellAsMinor /
//     castSpellInCombatPreparation) and its legacy cast alias to the same
//     Major flow.
//   - item-sheet.mjs's Cast Spell button routes to the SAME Major Action
//     flow as the character sheet.
//   - NO handler keeps the duplicated legacy implementation: no direct MP
//     deduction, no inline spell card, no chat-action button building inside
//     the sheet cast handlers.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url).href;
const read = rel => readFile(new URL(rel, root), "utf8");

const characterSheet = await read("templates/actor/character-sheet.hbs");
const actorSheet = await read("module/actor/actor-sheet.mjs");
const itemSheet = await read("module/item/item-sheet.mjs");

// Extract a handler block: from its registration line to the matching closing
// of the .on("click", ...) call. The handlers are sequential blocks in
// activateListeners, each starting with html.find("[data-action='...']").
function handlerBlock(source, action, label) {
  const start = source.indexOf(`html.find("[data-action='${action}']")`);
  assert.ok(start >= 0, `${label} registers the "${action}" action`);
  const end = source.indexOf("html.find(\"[data-action='", start + 1);
  const block = source.slice(start, end === -1 ? source.length : end);
  // Blocks end where the next registration begins; strip trailing context.
  return block;
}

// ── 1. The template exposes the three existing controls ────────────────────

assert.ok(characterSheet.includes('data-action="cast-spell"'), "Cast (Major) button exists");
assert.ok(characterSheet.includes('data-action="cast-spell-minor"'), "⏩ Minor Action button exists");
assert.ok(characterSheet.includes('data-action="cast-spell-prep"'), "△ Combat Preparation button exists");
// The minor/prep buttons are gated by the modality markers annotated in
// getData (item.castMinor / item.castPrep), never offered unconditionally.
assert.ok(characterSheet.includes("{{#if item.castMinor}}"), "Minor button gated by item.castMinor");
assert.ok(characterSheet.includes("{{#if item.castPrep}}"), "Prep button gated by item.castPrep");
console.log("1. character sheet exposes Cast / ⏩ / △ controls gated by modality markers");

// ── 2. Each control routes to its modality entry point ─────────────────────

const majorBlock = handlerBlock(actorSheet, "cast-spell", "actor sheet");
const minorBlock = handlerBlock(actorSheet, "cast-spell-minor", "actor sheet");
const prepBlock = handlerBlock(actorSheet, "cast-spell-prep", "actor sheet");
const legacyBlock = handlerBlock(actorSheet, "cast-spell-legacy", "actor sheet");

assert.ok(majorBlock.includes("castSpellAsMajor"), "Cast routes to castSpellAsMajor");
assert.ok(majorBlock.includes("applyCost: this.isEditable"), "Cast delegates the editability gate");
assert.ok(minorBlock.includes("castSpellAsMinor"), "⏩ routes to castSpellAsMinor");
assert.ok(prepBlock.includes("castSpellInCombatPreparation"), "△ routes to castSpellInCombatPreparation");
assert.ok(legacyBlock.includes("castSpellAsMajor"), "Legacy cast alias routes to the SAME Major flow");
console.log("2. each control routes to its modality entry point (Cast/⏩/△/legacy)");

// ── 3. No duplicated casting logic inside the handlers ─────────────────────

for (const [block, label] of [[majorBlock, "Cast"], [minorBlock, "⏩"], [prepBlock, "△"], [legacyBlock, "legacy"]]) {
  assert.ok(!block.includes("system.mp.value"), `${label} handler does not deduct MP directly`);
  assert.ok(!block.includes("trackNaturalPowerSpending"), `${label} handler does not track MP spending directly`);
  assert.ok(!block.includes("ChatMessage.create"), `${label} handler does not build its own chat card`);
  assert.ok(!block.includes("roll-spell-damage"), `${label} handler does not build chat-action buttons`);
  assert.ok(!block.includes("rollSpellcastingCheck"), `${label} handler does not roll the check itself`);
  assert.ok(!block.includes("resolveCastTargets"), `${label} handler does not resolve resistances itself`);
}
console.log("3. no handler keeps duplicated casting logic (delegation only)");

// ── 4. The item sheet Cast button uses the same Major flow ─────────────────

assert.ok(itemSheet.includes('cast-spell-from-item'), "The item sheet registers its Cast Spell button");
const itemBlock = handlerBlock(itemSheet, "cast-spell-from-item", "item sheet");
assert.ok(itemBlock.includes("castSpellAsMajor"), "The item sheet Cast routes to castSpellAsMajor");
assert.ok(itemBlock.includes("applyCost: this.isEditable"), "The item sheet delegates the editability gate");
assert.ok(!itemSheet.includes("system.mp.value"), "The item sheet has no direct MP deduction");
assert.ok(!itemSheet.includes("ChatMessage.create"), "The item sheet builds no chat card of its own");
assert.ok(!itemSheet.includes("rollSpecialSpellDamage"), "The item sheet owns no spell consequence dispatch");
assert.ok(itemSheet.includes('import { castSpellAsMajor } from "../rules/spell-cast.mjs"'), "The item sheet imports the centralized flow");
console.log("4. the item sheet Cast button uses the same centralized Major flow");

// ── 5. The handlers import the centralized module ──────────────────────────

assert.ok(actorSheet.includes('import { castSpellAsMajor, castSpellAsMinor, castSpellInCombatPreparation'), "The actor sheet imports all three modality entry points");
console.log("5. the sheets import the centralized Spellcasting module");

// ── 6. Combat Preparation validation and settings ───────────────────────────

const spellCast = await read("module/rules/spell-cast.mjs");
const sw25 = await read("sw25.mjs");

assert.ok(spellCast.includes("export function isInCombatPreparationPhase"), "isInCombatPreparationPhase helper exists");
assert.ok(spellCast.includes("export function isStrictCombatPreparationEnabled"), "isStrictCombatPreparationEnabled helper exists");
assert.ok(spellCast.includes('isInCombatPreparationPhase() && isStrictCombatPreparationEnabled()'), "castSpellAsMajor blocks Major Action during Combat Preparation when strict");
assert.ok(spellCast.includes("if (!isInCombatPreparationPhase())"), "castSpellInCombatPreparation rejects when not in Combat Preparation phase");
assert.ok(sw25.includes('enforceStrictCombatPreparationRules'), "Setting enforceStrictCombatPreparationRules is registered");
assert.ok(sw25.includes('registerMenu("sw25-taka", "gameRules"'), "Game Rules settings submenu is registered");
assert.ok(sw25.includes("GameRulesApp"), "Game Rules submenu application is wired");
console.log("6. Combat Preparation phase detection, strict mode validation and Game Rules submenu are present");

// ── 7. Spellcasting reuses the SHARED temporary-modifier dialog ────────────

assert.ok(spellCast.includes('import { enabledModifiersTotal, normalizeModifier, signedValue } from "./roll-modifiers.mjs";'), "spell-cast.mjs consumes the shared modifier helpers");
assert.ok(spellCast.includes("export function spellcastingMagicPowerParts"), "spell-cast.mjs seeds the caster's permanent Magic Power parts");
assert.ok(spellCast.includes("promptModifiers = null"), "castSpellAsMajor accepts an injectable modifier prompt (tests)");
const actorSheetFull = await read("module/actor/actor-sheet.mjs");
assert.ok(actorSheetFull.includes("const promptModifiers = event.shiftKey ? openRollModifiersDialog : null;"), "the actor sheet opens the shared dialog on Shift+click");
const itemBlockFull = await read("module/item/item-sheet.mjs");
assert.ok(itemBlockFull.includes("openRollModifiersDialog"), "the item sheet opens the shared dialog on Shift+click too");
// No parallel implementation: the dialog app is the single registration.
assert.ok(spellCast.includes("submitLabel: \"Cast Spell\""), "the spellcasting prompt reuses the shared dialog contract (title/dice/submit)");
console.log("7. Spellcasting reuses the shared temporary-modifier dialog (no parallel system)");

console.log("Spellcasting UI connection: all checks passed.");
