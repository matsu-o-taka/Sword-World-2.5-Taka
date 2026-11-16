export function characterAbilityScore(system = {}, baseName, letter) {
  const adjustment = system.abilityAdjustments?.[letter] || {};
  return Number(system.abilityBases?.[baseName] ?? 0)
    + Number(adjustment.growth ?? 0)
    + Number(adjustment.correction ?? 0)
    + Number(adjustment.temporary ?? 0);
}

export function characterAdventurerLevel(items = []) {
  return Array.from(items ?? [])
    .filter(item => item.type === "class")
    .reduce((highest, item) => Math.max(highest, Number(item.system?.level ?? 0)), 0);
}

export function characterHPMaximum(system = {}, items = []) {
  return characterAdventurerLevel(items) * 3 + characterAbilityScore(system, "body", "d");
}

/**
 * Sum of the wizard-type class levels × 3: the class contribution to the MP
 * maximum. Kept beside `characterAdventurerLevel` so both formulas live in
 * one module (the unified maximum persistence in
 * `module/actor/resource-maxima.mjs` and every consumer derive from here).
 *
 * @param {Array<object>|Collection} items Class (or any) items of the actor.
 * @returns {number}
 */
export function wizardClassLevels(items = []) {
  return Array.from(items ?? [])
    .filter(item => item.type === "class" && /wizard/i.test(String(item.system?.classType ?? "")))
    .reduce((sum, item) => sum + Number(item.system?.level ?? 0) * 3, 0);
}

/**
 * Base maximum MP for a character: total wizard-type class levels × 3 plus
 * the Spirit ability score (mind base + growth/correction/temporary
 * adjustments). Deliberately EXCLUDES effect modifiers: the persisted
 * `system.mp.max` is always the base maximum (DEC-28) and effect modifiers
 * apply on top as the effective maximum through the effect ledger.
 *
 * @param {object} system The actor's system data.
 * @param {Array<object>|Collection} items The actor's items.
 * @returns {number}
 */
export function characterMPMaximum(system = {}, items = []) {
  return wizardClassLevels(items) + characterAbilityScore(system, "mind", "f");
}

/**
 * Unified resource-maximum accessor for consumers (rest, recovery items,
 * token-adjacent displays, gauges): reads the persisted base maximum
 * (`system.hp.max` / `system.mp.max`) and falls back to the formula for
 * actors whose data has not been synced yet (missing or zero).
 *
 * @param {object} actor Actor document (or stub) with `system` and `items`.
 * @param {"hp"|"mp"} resource Resource to read.
 * @returns {number} The base maximum, 0 when neither source provides one.
 */
export function characterResourceMaximum(actor, resource) {
  if (actor == null || (resource !== "hp" && resource !== "mp")) return 0;
  const stored = Math.max(0, Number(actor.system?.[resource]?.max ?? 0));
  if (stored > 0) return stored;
  return resource === "mp"
    ? characterMPMaximum(actor.system, actor.items)
    : characterHPMaximum(actor.system, actor.items);
}
