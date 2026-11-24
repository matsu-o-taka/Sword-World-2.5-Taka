// Sword World 2.5 - Central damage-element registry.
//
// Single authoritative source of the damage elements ("attributes") that the
// system can classify. Consumers (rule elements, effect configuration, chat
// damage transport) read the identifiers and presentation labels from here;
// no consumer keeps its own element list.
//
// Design rules (damage-vulnerability task):
//   - Stable identifiers are persisted; display labels are presentation only
//     and may change without invalidating stored data.
//   - Identifiers are language-independent slugs. Aliases cover the spellings
//     that already exist in the project's stored data (`system.damageType.
//     attribute` of spells, the Weak Point reference document) and the printed
//     names, so source data is canonicalized at the boundary instead of being
//     compared as free text.
//   - The list is extensible: adding an entry here makes it available to every
//     consumer without editing the effect definitions.
//
// The observed stored spell attributes are: Psychic, Curse, Energy, Fire,
// Wind, Water/Ice, Earth, Poison, Bludgeoning, Lightning, Slashing, Disease,
// Varies, Special, Edged and the abbreviation "Bludg.". `Varies` and
// `Special` are NOT matchable elements: they are recorded so they can be
// canonicalized, but they are never offered as a vulnerability choice.
//
// Deliberately absent: "Silver" (a weapon material property, not a damage
// element) and "None". Weapon weaknesses such as "Silver Weapon Damage +3"
// need a source/property model that does not exist yet and are out of scope.

/**
 * Sentinel identifier meaning "any element" in rule configuration.
 * @type {string}
 */
export const SW25_DAMAGE_ELEMENT_ANY = "any";

/**
 * The element catalog. Order is the presentation order of option lists.
 * @type {ReadonlyArray<{id: string, label: string, selectable: boolean, aliases: string[]}>}
 */
export const SW25_DAMAGE_ELEMENTS = Object.freeze([
  { id: "fire", label: "Fire", selectable: true, aliases: ["fire", "flame", "fuego", "llama"] },
  { id: "water-ice", label: "Water/Ice", selectable: true, aliases: ["water/ice", "water-ice", "water", "ice", "agua", "hielo"] },
  { id: "wind", label: "Wind", selectable: true, aliases: ["wind", "air", "viento", "aire"] },
  { id: "earth", label: "Earth", selectable: true, aliases: ["earth", "tierra"] },
  { id: "lightning", label: "Lightning", selectable: true, aliases: ["lightning", "thunder", "electricity", "rayo", "trueno", "electricidad"] },
  { id: "energy", label: "Energy", selectable: true, aliases: ["energy", "energia", "energía"] },
  { id: "poison", label: "Poison", selectable: true, aliases: ["poison", "veneno"] },
  { id: "psychic", label: "Psychic", selectable: true, aliases: ["psychic", "mental", "mind", "psiquico", "psíquico"] },
  { id: "curse", label: "Curse", selectable: true, aliases: ["curse", "maldicion", "maldición"] },
  { id: "disease", label: "Disease", selectable: true, aliases: ["disease", "enfermedad"] },
  { id: "bludgeoning", label: "Bludgeoning", selectable: true, aliases: ["bludgeoning", "bludg", "bludg.", "crushing", "contundente"] },
  { id: "slashing", label: "Slashing", selectable: true, aliases: ["slashing", "edged", "cutting", "cortante", "filoso"] },
  { id: "piercing", label: "Piercing", selectable: true, aliases: ["piercing", "pierce", "perforante"] },
  // Non-matchable stored attributes: canonicalized for diagnostics only.
  { id: "varies", label: "Varies", selectable: false, aliases: ["varies", "variable", "varia"] },
  { id: "special", label: "Special", selectable: false, aliases: ["special", "especial"] }
]);

const ELEMENT_BY_ID = new Map(SW25_DAMAGE_ELEMENTS.map(entry => [entry.id, entry]));

/**
 * Normalize one raw attribute string into a lookup key.
 * @param {*} value - Raw value ("Water/Ice", "Bludg.", ...).
 * @returns {string} Lookup key ("" when the value carries no text).
 */
function elementLookupKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, "-")
    .replace(/\.+$/, "");
}

const ELEMENT_BY_KEY = new Map();
for (const entry of SW25_DAMAGE_ELEMENTS) {
  for (const alias of [entry.id, entry.label, ...entry.aliases]) {
    const key = elementLookupKey(alias);
    if (key) ELEMENT_BY_KEY.set(key, entry.id);
  }
}
ELEMENT_BY_KEY.set(SW25_DAMAGE_ELEMENT_ANY, SW25_DAMAGE_ELEMENT_ANY);

/**
 * Resolve a raw attribute/label into the stable element identifier.
 * @param {*} value - Raw value. `"any"` resolves to the "any" sentinel.
 * @returns {string|null} Stable identifier, "any", or null when the value is
 *   empty or is not a declared element.
 */
export function normalizeSw25DamageElement(value) {
  const key = elementLookupKey(value);
  if (!key) return null;
  return ELEMENT_BY_KEY.get(key) ?? null;
}

/**
 * Presentation label of an element identifier.
 * @param {string} id - Stable identifier (or "any").
 * @returns {string} Label; the raw identifier when it is not declared.
 */
export function sw25DamageElementLabel(id) {
  if (id === SW25_DAMAGE_ELEMENT_ANY) return "Any Element";
  return ELEMENT_BY_ID.get(id)?.label ?? String(id ?? "");
}

/**
 * Whether an identifier is a declared, matchable element.
 * @param {string} id - Stable identifier.
 * @returns {boolean}
 */
export function isSw25DamageElementId(id) {
  return ELEMENT_BY_ID.get(id)?.selectable === true;
}

/**
 * Build the option list consumed by effect configuration interfaces.
 * The list always starts with "Any Element" and contains only matchable
 * elements, in catalog order.
 * @param {object} [options]
 * @param {boolean} [options.includeAny] - Include the "any" sentinel (default true).
 * @returns {Array<{id: string, label: string}>} Options with stable ids.
 */
export function listSw25DamageElementOptions({ includeAny = true } = {}) {
  const options = SW25_DAMAGE_ELEMENTS
    .filter(entry => entry.selectable)
    .map(entry => ({ id: entry.id, label: entry.label }));
  return includeAny
    ? [{ id: SW25_DAMAGE_ELEMENT_ANY, label: "Any Element" }, ...options]
    : options;
}
