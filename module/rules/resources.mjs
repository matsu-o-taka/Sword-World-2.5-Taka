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
 * Normalize a persisted current-resource value to one finite number. Older
 * character sheets could submit several same-named MP inputs as an array;
 * accept that legacy shape on read, using its first populated finite entry,
 * without ever exposing the array to calculations or numeric indicators.
 *
 * @param {unknown} raw Persisted scalar or legacy array value.
 * @returns {number} A finite number, defaulting to 0 for missing/invalid data.
 */
function finiteResourceValue(raw) {
  const candidates = Array.isArray(raw) ? raw : [raw];
  for (const candidate of candidates) {
    if (candidate == null || (typeof candidate === "string" && candidate.trim() === "")) continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Unified current-value accessor for character HP/MP. Every display and rule
 * consumer reads the same persisted `system.<resource>.value` property through
 * this normalization boundary; no secondary current-value state is created.
 *
 * @param {object} actor Actor document (or stub) with `system` data.
 * @param {"hp"|"mp"} resource Resource to read.
 * @returns {number} The normalized current value.
 */
export function characterResourceValue(actor, resource) {
  if (actor == null || (resource !== "hp" && resource !== "mp")) return 0;
  return finiteResourceValue(actor.system?.[resource]?.value);
}

/**
 * Write one character HP/MP current value back to its canonical persisted
 * property. Numeric normalization happens before the document update so a
 * form submission can never persist an array, numeric string or NaN.
 *
 * @param {object} actor Actor document to update.
 * @param {"hp"|"mp"} resource Resource to write.
 * @param {unknown} value Proposed scalar (or legacy array) value.
 * @param {object} [options] Document update options.
 * @returns {Promise<object>} The Actor update result.
 */
export async function updateCharacterResourceValue(actor, resource, value, options = {}) {
  if (!actor || typeof actor.update !== "function" || (resource !== "hp" && resource !== "mp")) {
    throw new Error("A character resource update requires an Actor and either hp or mp.");
  }
  return actor.update({ [`system.${resource}.value`]: finiteResourceValue(value) }, options);
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
