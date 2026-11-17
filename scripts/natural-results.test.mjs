// Sword World 2.5 - natural 2d6 result detection tests
//
// The three mechanics that read natural dice results must stay distinct and
// must never be derived from a modified total:
//   1. Attack rolls: natural double 1 = fumble (automatic miss); natural
//      double 6 = automatic critical that beats Evasion regardless of totals.
//   2. Spellcasting: natural double 1 = automatic spell failure; natural
//      double 6 = +5 to the Spellcasting Value.
//   3. Power Table damage (weapons AND spells): the item's own critical
//      threshold against the natural roll grants an additional damage roll;
//      this comparison belongs to damage resolution only.
//
// These tests exist so the attack double 6, the Spellcasting double 6 and the
// Power Table critical can never be confused again.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isCriticalFailure,
  isNaturalDouble,
  isPowerTableCritical,
  naturalDiceTotal,
  registerAutomaticFailure,
  rollDiceResults
} from "../module/rules/critical-failure.mjs";
import { attackCardHtml, resolveAttackHit } from "../module/combat/attack-resolution.mjs";
import { rollSpellPowerTableDamage, spellDamageMagicPower } from "../module/rules/spell-damage.mjs";

// ---------------------------------------------------------------------------
// Foundry mocks
// ---------------------------------------------------------------------------

let rollQueue = [];
const chatCreations = [];

class MockRoll {
  constructor(formula) {
    this.formula = formula;
    this.dice = [];
  }

  async evaluate() {
    const script = rollQueue.shift();
    assert.ok(script, `No scripted roll for "${this.formula}"`);
    this.dice = [{ results: script.map(value => ({ result: value, active: true })) }];
    this._total = script.reduce((sum, value) => sum + value, 0);
    return this;
  }

  get total() { return this._total; }

  async toMessage(message) { MockRoll.messages.push(message); }
}
MockRoll.messages = [];

globalThis.Roll = MockRoll;
globalThis.ChatMessage = {
  getSpeaker({ actor } = {}) { return { actor }; },
  async create(data) {
    chatCreations.push(data);
    return { id: `create-${chatCreations.length}` };
  }
};
globalThis.foundry = {
  utils: {
    escapeHTML(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    }
  }
};

// A plain roll object for the pure detection utilities. `total` may differ
// from the natural dice sum to prove detection ignores modified totals.
const mockRoll = (dice, total = dice.reduce((sum, value) => sum + value, 0)) => ({
  dice: [{ results: dice.map(value => ({ result: value, active: true })) }],
  total
});

const characterActor = (extraSystem = {}) => ({
  id: "hero",
  name: "Hero",
  type: "character",
  uuid: "Actor.hero",
  system: { abilityBases: { mind: 6 }, abilityAdjustments: {}, ...extraSystem },
  updates: [],
  async update(data) { this.updates.push(data); },
  sheet: { render() {} },
  getFlag() { return undefined; },
  isToken: false
});

const spellItem = {
  id: "spl-1",
  name: "Storm Lance",
  type: "spell",
  uuid: "Item.spl-1",
  system: { powerTable: { 7: 9, 12: 20 }, critical: 10 }
};
const castingClass = { id: "cls-1", name: "Sorcerer", system: { level: 3 } };

// ---------------------------------------------------------------------------
// 1. Natural extraction: dice only, never the modified total
// ---------------------------------------------------------------------------

console.log("=== Natural extraction ===");
assert.equal(naturalDiceTotal(mockRoll([3, 4])), 7);
assert.equal(naturalDiceTotal(mockRoll([3, 4], 12)), 7, "Modified total 12 does not change the natural sum");
assert.equal(rollDiceResults(mockRoll([6, 6])).length, 2);
// Inactive (dropped/discarded) dice never count toward natural detection.
assert.deepEqual(
  rollDiceResults({ dice: [{ results: [{ result: 6, active: true }, { result: 6, active: true }, { result: 1, active: false }] }] }),
  [6, 6],
  "Inactive dice are excluded from natural detection"
);

// ---------------------------------------------------------------------------
// 2. Fumble (double 1): detected from naturals even with a high total
// ---------------------------------------------------------------------------

console.log("=== Fumble detection ===");
assert.equal(isCriticalFailure(mockRoll([1, 1])), true);
assert.equal(isCriticalFailure(mockRoll([1, 1], 13)), true, "Double 1 is a fumble even with modified total 13");
assert.equal(isCriticalFailure(mockRoll([2, 2])), false, "A low modified total is not a fumble");
assert.equal(isCriticalFailure(mockRoll([1, 2])), false);
assert.equal(isNaturalDouble(mockRoll([1, 1]), 1), true, "isCriticalFailure and isNaturalDouble(roll, 1) agree");

// ---------------------------------------------------------------------------
// 3. Attack double 6: automatic critical, distinct from Power Table threshold
// ---------------------------------------------------------------------------

console.log("=== Attack automatic critical (double 6) ===");
// Card level: natural 12 beats Evasion regardless of the totals.
const autoCritCard = attackCardHtml({
  attackerTitle: "Longsword", attackerName: "Hero", attackStatLabel: "Accuracy",
  attackOrigin: "2d6", attackNatural: 12, attackParts: [],
  attackTotal: 12, attackCriticalFailure: false,
  defenderName: "Monster", defenseStatLabel: "Evasion", defenseOrigin: "fixed (22)",
  defenseNatural: null, defenseParts: [], defenseTotal: 22,
  defenseCriticalFailure: false, attackerCritFailNote: ""
});
assert.ok(autoCritCard.includes("sw25-attack-critical"), "Natural double 6 shows the CRITICAL badge despite total 12 vs 22");

// Natural 11 (not a double 6) is never an attack critical — the weapon's
// Power Table threshold (10) must not leak into the attack roll.
const natural11Card = attackCardHtml({
  attackerTitle: "Keen Sword", attackerName: "Hero", attackStatLabel: "Accuracy",
  attackOrigin: "2d6 + 20", attackNatural: 11, attackParts: [],
  attackTotal: 31, attackCriticalFailure: false,
  defenderName: "Monster", defenseStatLabel: "Evasion", defenseOrigin: "fixed (22)",
  defenseNatural: null, defenseParts: [], defenseTotal: 22,
  defenseCriticalFailure: false, attackerCritFailNote: ""
});
assert.ok(natural11Card.includes("sw25-attack-hit"), "Natural 11 that exceeds Evasion is a normal HIT");
assert.ok(!natural11Card.includes("sw25-attack-critical"), "Weapon critical threshold 10 does not create an attack critical");
assert.equal(isNaturalDouble(mockRoll([6, 5], 11), 6), false);
assert.equal(isNaturalDouble(mockRoll([6, 6]), 6), true);

// ---------------------------------------------------------------------------
// 4. Spellcasting double 6: +5 SV from naturals, never from the total
// ---------------------------------------------------------------------------

console.log("=== Spellcasting double 6 (+5 SV) ===");
// A +2 modifier reaching total 12 WITHOUT double 6 grants no +5.
assert.equal(isNaturalDouble(mockRoll([5, 5], 12), 6), false, "Modified total 12 is not a Spellcasting double 6");
assert.equal(isNaturalDouble(mockRoll([6, 6], 12), 6), true, "Natural double 6 grants the +5 SV");
// The Spellcasting double 6 and the attack double 6 are the same natural
// detection (isNaturalDouble) with DIFFERENT consequences: +5 SV on the
// Spellcasting Value versus an automatic critical on attack rolls.

// ---------------------------------------------------------------------------
// 5. Power Table critical: item threshold vs natural roll (damage only)
// ---------------------------------------------------------------------------

console.log("=== Power Table critical threshold ===");
assert.equal(isPowerTableCritical(mockRoll([5, 5], 10), 10), true, "Natural 10 meets threshold 10");
assert.equal(isPowerTableCritical(mockRoll([6, 6], 12), 12), true, "Natural 12 meets threshold 12");
assert.equal(isPowerTableCritical(mockRoll([4, 5], 11), 10), false, "Modified total 11 with natural 9 does NOT crit");
assert.equal(isPowerTableCritical(mockRoll([4, 5]), 10), false, "Natural 9 below threshold 10 does not crit");
assert.equal(isPowerTableCritical(mockRoll([6, 6]), 13), false, "Threshold 13 can never trigger");
assert.equal(isPowerTableCritical(mockRoll([5, 5]), 0), false, "Threshold 0 means no critical");
assert.equal(isPowerTableCritical(mockRoll([5, 5]), undefined), false, "Missing threshold means no critical");

// ---------------------------------------------------------------------------
// 6. Effective Magic Power: one shared source for cards and rolls
// ---------------------------------------------------------------------------

console.log("=== Effective Magic Power ===");
assert.equal(spellDamageMagicPower(characterActor(), castingClass), 4, "Class level 3 + Intelligence bonus 1 (mind 6) + ledger 0");
assert.equal(spellDamageMagicPower(null, null), 0, "Missing actor and class yield 0");

// ---------------------------------------------------------------------------
// 7. Spell Power Table roll: fumble, crit loop and SV preservation
// ---------------------------------------------------------------------------

console.log("=== Spell Power Table roll (shared weapon mechanism) ===");

// 7a. Power Table critical (damage rule) from naturals. Without a casting
//     Success Value supplied by the caller, NO SV is derived from the damage
//     roll: the provisional derivation is gone (DEC-6 — the SV is the result
//     of the casting roll, transported by the cast flow only).
rollQueue = [[6, 6]];
const critResult = await rollSpellPowerTableDamage({ actor: characterActor(), spell: spellItem, castingClass });
assert.equal(critResult.criticalFailure, false);
assert.equal(critResult.diceTotal, 12);
assert.equal(critResult.tableValue, 20);
assert.equal(critResult.magicPower, 4, "Magic Power = class 3 + Int 1 + ledger 0");
assert.equal(critResult.total, 24, "Total = table 20 + Magic Power 4");
assert.equal(critResult.spellSuccessValue, null, "No casting SV supplied → no SV is derived or fabricated");
assert.equal(critResult.critical, true, "Spell critical 10 triggered by natural 12");
const critCard = chatCreations[chatCreations.length - 1].content;
assert.ok(critCard.includes("CRITICAL"), "Card marks the Power Table critical");
assert.ok(critCard.includes("Roll Damage Again"), "Card offers the additional Power Table roll");
assert.ok(critCard.includes('data-accumulated-power="20"'), "Additional roll carries the accumulated table damage");
assert.ok(!critCard.includes("data-success-value"), "No SV attribute without an authentic casting SV");

// 7b. Additional roll: accumulated table damage grows, the AUTHENTIC SV is
//     preserved (it belongs to the casting roll, supplied by the cast flow
//     through data-success-value, never re-derived from the damage roll).
rollQueue = [[6, 6]];
const extraResult = await rollSpellPowerTableDamage({
  actor: characterActor(), spell: spellItem, castingClass,
  accumulatedPower: 20, successValue: 21
});
assert.equal(extraResult.tableValue, 20);
assert.equal(extraResult.total, 44, "Total = accumulated 20 + table 20 + Magic Power 4");
assert.equal(extraResult.spellSuccessValue, 21, "The caller-supplied casting SV is preserved across the additional roll");
assert.equal(extraResult.critical, true, "Natural 12 meets the critical threshold 10 again");
const extraCard = chatCreations[chatCreations.length - 1].content;
assert.ok(extraCard.includes("Accumulated power-table damage:</strong> 20"), "Card shows the accumulated table damage");
assert.ok(extraCard.includes('data-accumulated-power="40"'), "The further roll accumulates 20 + 20");
assert.ok(extraCard.includes('data-success-value="21"'), "The further roll button keeps the authentic casting SV");

// 7c. Fumble on the Power Table roll: no damage; the counter is NOT written
//     automatically — the card offers the registration button and the
//     player confirms via registerAutomaticFailure.
rollQueue = [[1, 1]];
const fumbleActor = characterActor();
const fumbleResult = await rollSpellPowerTableDamage({ actor: fumbleActor, spell: spellItem, castingClass });
assert.equal(fumbleResult.criticalFailure, true, "Natural double 1 on the Power Table roll is a fumble");
assert.equal(fumbleResult.total, 0, "A fumbled Power Table roll deals no damage");
assert.equal(fumbleActor.updates.length, 0, "Detection never writes the Automatic Failure counter by itself");
const fumbleFlavor = MockRoll.messages[MockRoll.messages.length - 1].flavor;
assert.ok(fumbleFlavor.includes("CRITICAL FAILURE"));
assert.ok(fumbleFlavor.includes("register-automatic-failure"), "Card offers the player the Automatic Failure registration button");
assert.ok(fumbleFlavor.includes(`data-actor-id="${fumbleActor.id}"`), "Registration button targets the rolling character");
const registered = await registerAutomaticFailure(fumbleActor);
assert.equal(registered, true, "registerAutomaticFailure persists the counter on a character");
assert.equal(fumbleActor.updates.length, 1, "Only the player-confirmed registration writes the counter");
assert.equal(fumbleActor.updates[0]["system.automaticFailureCount"], 1);

// 7d. Monster fumble: no Automatic Failure counter, no experience, and the
//     card offers NO registration button.
rollQueue = [[1, 1]];
const monsterFumbleActor = { id: "m1", name: "Cursed Artist", type: "monster", updates: [], async update() { this.updates.push(1); }, sheet: null, getFlag() { return undefined; }, isToken: false };
const monsterFumble = await rollSpellPowerTableDamage({ actor: monsterFumbleActor, spell: spellItem, castingClass });
assert.equal(monsterFumble.criticalFailure, true);
assert.equal(monsterFumbleActor.updates.length, 0, "Monster fumbles never write the Automatic Failure counter");
const monsterFumbleFlavor = MockRoll.messages[MockRoll.messages.length - 1].flavor;
assert.ok(monsterFumbleFlavor.includes("CRITICAL FAILURE"));
assert.ok(!monsterFumbleFlavor.includes("register-automatic-failure"), "Monster fumble cards never offer the registration button");
assert.equal(await registerAutomaticFailure(monsterFumbleActor), false, "registerAutomaticFailure ignores monsters");

// ---------------------------------------------------------------------------
// 8. Defense automatic success on the attack card
// ---------------------------------------------------------------------------

console.log("=== Attack card: defense automatic success precedence ===");
// Attacker natural 12 versus a defender natural double 6: the passive side
// wins, so the card shows MISS — never a CRITICAL badge.
const bothAutoCard = attackCardHtml({
  attackerTitle: "Longsword", attackerName: "Hero", attackStatLabel: "Accuracy",
  attackOrigin: "2d6", attackNatural: 12, attackParts: [],
  attackTotal: 30, attackCriticalFailure: false,
  defenderName: "Monster", defenseStatLabel: "Evasion", defenseOrigin: "active roll (2d6 + 7)",
  defenseNatural: 12, defenseParts: [], defenseTotal: 9,
  defenseCriticalFailure: false, defenseAutomaticSuccess: true, attackerCritFailNote: ""
});
assert.ok(bothAutoCard.includes("sw25-attack-miss"), "Both automatic success => card shows MISS (passive side wins)");
assert.ok(!bothAutoCard.includes("sw25-attack-critical"), "CRITICAL badge only when the attack really hits");
assert.ok(bothAutoCard.includes("AUTOMATIC SUCCESS"), "Card marks the defense's automatic success");

// A defender automatic success also beats a plainly higher attacker total.
const defAutoHighTotalCard = attackCardHtml({
  attackerTitle: "Longsword", attackerName: "Hero", attackStatLabel: "Accuracy",
  attackOrigin: "2d6 + 20", attackNatural: 9, attackParts: [],
  attackTotal: 29, attackCriticalFailure: false,
  defenderName: "Monster", defenseStatLabel: "Evasion", defenseOrigin: "active roll (2d6 + 7)",
  defenseNatural: 12, defenseParts: [], defenseTotal: 9,
  defenseCriticalFailure: false, defenseAutomaticSuccess: true, attackerCritFailNote: ""
});
assert.ok(defAutoHighTotalCard.includes("sw25-attack-miss"), "Defense automatic success wins over a higher attacker total");

// A resolvedAttackHit helper contract check: precedence order.
assert.equal(resolveAttackHit({ attackCriticalFailure: true, attackNatural: 12 }), false, "Attacker fumble always misses");
assert.equal(resolveAttackHit({ attackNatural: 12, defenseAutomaticSuccess: true }), false, "Defense auto success beats attack auto success");
assert.equal(resolveAttackHit({ attackNatural: 12 }), true, "Attack auto success hits a normal defense");
assert.equal(resolveAttackHit({ attackNatural: 3, attackTotal: 5, defenseTotal: 4, defenseCriticalFailure: true }), true, "Defense fumble lets the attack through");
assert.equal(resolveAttackHit({ attackNatural: 3, attackTotal: 4, defenseTotal: 4 }), false, "Tie goes to the defense (strict >)");

// ---------------------------------------------------------------------------
// 9. Initiative purity: no automatic success/failure machinery
// ---------------------------------------------------------------------------

console.log("=== Initiative stays purely numeric ===");
const sideInitiativeSource = readFileSync(new URL("../module/combat/side-initiative.mjs", import.meta.url), "utf8");
assert.ok(sideInitiativeSource.includes("recordPlayerInitiative"), "Source scan target is the initiative module");
assert.ok(sideInitiativeSource.includes("rollCharacterTrackerInitiative"), "Source scan covers the tracker initiative");
assert.ok(sideInitiativeSource.includes("beginMonsterInitiative"), "Source scan covers the monster initiative");
for (const marker of [
  "isCriticalFailure", "isNaturalDouble", "markCriticalFailure",
  "criticalFailureHTML", "automaticFailureButton", "automaticFailureCount",
  "Automatic Success", "Automatic Failure", "CRITICAL FAILURE"
]) {
  assert.ok(!sideInitiativeSource.includes(marker), `Initiative never references "${marker}"`);
}

console.log("All natural-results assertions passed.");
