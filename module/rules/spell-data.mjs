// ---------------------------------------------------------------------------
// Shared Spell Item data model logic (single source of truth).
//
// Every derivation the Spell schema needs — the centralized class→school
// mapping, the spell family/rank identity, the duration representation, and
// the structured target/range/area/resistance/damageType parsing — lives HERE
// and only here. The importer (module/importer/sw25-importer.mjs), the rules
// modules (spell-cast.mjs, spell-effects.mjs, spell-damage.mjs), the actor
// sheet and the migration paths all consume this module; none of them keeps a
// private copy of the logic.
//
// The module is deliberately dependency-free and Foundry-free: it works on
// plain data so it can be unit-tested and reused inside the importer and the
// migration tooling.
//
// Structured field semantics (spell-data-model-proposal.md):
//   - `rank`        — integer, 0 = base spell, N = Nth rank of the family.
//   - `resistance`  — "cant"|"none"|"neg"|"half"|"optional"|"temporary"|null.
//   - `usesFortitude` — false = Willpower (default); true only when the
//     source explicitly carries a "Fortitude/" prefix. There is no
//     "Willpower/" prefix in the source: its absence means Willpower.
//   - `target`      — a discrete rules label ("caster", "character",
//     "entire-character", "character-x", "object", "point", "touch") OR an
//     area object { type:"area", areaCount, radius, selection, maxTargets }.
//     The labels are never grouped: "character", "entire-character" and
//     "character-x" keep their distinct mechanical identities.
//   - `range`       — { areas, distance } (metres) or null.
//   - `area`        — magical propagation: "target"|"shot"|"line"|
//     "breakthrough"|null. Never inferred from `target`.
//   - `duration`    — the exact Effects-engine duration text ("Instant",
//     "Instant/3 rounds", "3 minutes (18 rounds)", ...). The parsing of that
//     text into scales/counters remains in spell-effects.mjs.
//   - `damageType`  — { nature: "physical"|"magical"|null, attribute: string|null }.
//
// Unknown or malformed source values are REPORTED (warnings) and stored as
// null — never silently assigned an invented meaning.
// ---------------------------------------------------------------------------

// ── Magical school (centralized class→school mapping) ──────────────────────

/**
 * Centralized class → magical school mapping, keyed by the class NAME
 * (lowercase) — `className` is the canonical mapping key; `classId` is the
 * world-local document UUID and is never used for school resolution.
 */
export const CLASS_SCHOOLS = new Map([
  ["sorcerer", "Truespeech Magic"],
  ["conjurer", "Spiritualism Magic"],
  ["priest", "Divine Magic"],
  ["artificer", "Magitech"],
  ["fairy tamer", "Fairy Magic"],
  ["druid", "Nature Magic"],
  ["daemonologist", "Daemonology"],
  ["bard", "Spellsongs"],
  ["alchemist", "Alchemy"],
  ["geomancer", "Geomancy"]
]);

/** Canonical display order of the magical schools. */
export const SPELL_SCHOOL_ORDER = [...new Set(CLASS_SCHOOLS.values())];

/**
 * Resolve the magical school of a casting class by its display name.
 * @param {string} className - Casting class display name.
 * @returns {string|null} The school name, or null when the class has no
 *   school in the mapping (the caller decides the "General" presentation).
 */
export function schoolForClassName(className) {
  return CLASS_SCHOOLS.get(String(className ?? "").trim().toLowerCase()) ?? null;
}

// ── Spell family and rank (DEC-1/DEC-16, shared with the Effects engine) ───

/** Approved rank → Roman numeral table (DEC-16, ranks 1..10). */
const SPELL_RANK_ROMAN = new Map([
  ["I", 1], ["II", 2], ["III", 3], ["IV", 4], ["V", 5],
  ["VI", 6], ["VII", 7], ["VIII", 8], ["IX", 9], ["X", 10]
]);

/** Full-width Roman numerals (attached form, e.g. "保護Ⅳ"). */
const SPELL_RANK_FULLWIDTH_ROMAN = new Map([
  ["Ⅰ", 1], ["Ⅱ", 2], ["Ⅲ", 3], ["Ⅳ", 4], ["Ⅴ", 5],
  ["Ⅵ", 6], ["Ⅶ", 7], ["Ⅷ", 8], ["Ⅸ", 9], ["Ⅹ", 10]
]);

/**
 * THE shared spell-name identity parser (DEC-1/DEC-16). The Effects engine
 * (`getInstantXSpellIdentity`) and the importer (`rank` field) both use it;
 * no second parser exists anywhere.
 *
 * Parsing rules (validated against all 656 compendium spells: 22 ranked
 * names parse correctly, 0 false positives):
 *   - A trailing attached full-width numeral (Ⅰ..Ⅹ) is a rank.
 *   - A trailing SPACE-SEPARATED ASCII Roman numeral in UPPERCASE
 *     (case-sensitive: "Mana Max" never matches) is a rank.
 *   - Everything else: the full authored name is the family, rank 0.
 *
 * Authoring markers (⏩/‡/†/△) stay in the family (DEC-1): comparison
 * normalizes case at comparison time, never at storage.
 *
 * @param {string} name - Authored spell name.
 * @returns {{family: string, rank: number}} `rank` is an integer, 0 = base.
 */
export function parseSpellNameIdentity(name) {
  const text = String(name ?? "").trim();
  if (!text) return { family: "", rank: 0 };
  const fullwidth = text.match(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]$/u);
  if (fullwidth) {
    return { family: text.slice(0, -1).trim(), rank: SPELL_RANK_FULLWIDTH_ROMAN.get(fullwidth[0]) };
  }
  // Case-SENSITIVE uppercase (no `i` flag): the numeral must be authored as
  // an uppercase Roman numeral separated by whitespace.
  const ascii = text.match(/\s(X|IX|VIII|VII|VI|IV|V|III|II|I)$/);
  if (ascii) {
    return { family: text.slice(0, ascii.index).trim(), rank: SPELL_RANK_ROMAN.get(ascii[1]) };
  }
  return { family: text, rank: 0 };
}

// ── Duration (Effects-engine representation) ───────────────────────────────

/**
 * Read the raw Duration text from imported metadata ("Duration: Instant").
 * This is the ONE extractor; the importer stores its result in
 * `system.duration` and the Effects engine reads the stored field.
 * @param {string} metadata - Raw imported metadata text.
 * @returns {string|null} The duration text, or null when absent.
 */
export function readSpellDurationText(metadata) {
  const match = String(metadata ?? "").match(/^duration:\s*(.+)$/im);
  return match ? match[1].trim() : null;
}

/**
 * Read the stored duration of a spell. The Effects engine representation is
 * the exact normalized text; its structured parsing (Instant/X scales and
 * counters) lives in spell-effects.mjs and is not duplicated here.
 * @param {object} spell - Spell Item document.
 * @returns {string|null} The duration text, or null when absent.
 */
export function getSpellDuration(spell) {
  const stored = spell?.system?.duration;
  if (stored == null) return null;
  const text = String(stored).trim();
  return text === "" ? null : text;
}

// ── Resistance (CR1 pp. 167-169) ───────────────────────────────────────────

/** Approved Resistance ids (same vocabulary as the cast resolution). */
export const SPELL_RESISTANCE_IDS = new Set([
  "cant", "none", "neg", "half", "optional", "temporary"
]);

/**
 * Normalize a raw source Resistance VALUE (the part after any "Fortitude/"
 * prefix) to an approved id. "Negates"/"Neg" → "neg", "Can't" → "cant", ...
 * Unrecognized values return null — nothing is invented.
 * @param {string} raw - Raw resistance value text.
 * @returns {string|null} An approved id, or null.
 */
export function normalizeResistanceValue(raw) {
  const value = String(raw ?? "").trim().toLowerCase().replace(/[’‘]/g, "'");
  if (/^(can'?t|cannot)$/.test(value)) return "cant";
  if (/^optional$/.test(value)) return "optional";
  if (/^none$/.test(value)) return "none";
  if (/^neg(ated|ates)?$/.test(value)) return "neg";
  if (/^half$/.test(value)) return "half";
  if (/^temporar(y|ily)$/.test(value)) return "temporary";
  return null;
}

/**
 * Parse a source Resistance entry into the structured pair.
 *
 *   "Half"            → { usesFortitude: false, resistance: "half" }
 *   "Fortitude/Half"  → { usesFortitude: true,  resistance: "half" }
 *   "Negates"         → { usesFortitude: false, resistance: "neg" }
 *   ""                → { usesFortitude: false, resistance: null }
 *
 * `usesFortitude` is true ONLY for an explicit "Fortitude/" prefix; there is
 * no "Willpower/" prefix, so its absence means Willpower. The resistance
 * type after the slash is independent (Fortitude does NOT imply Negate).
 * An unrecognized prefix or value is reported as a warning, never guessed.
 *
 * @param {string} raw - Raw "Resistance:" entry text.
 * @returns {{usesFortitude: boolean, resistance: string|null, warning: string|null}}
 */
export function parseSpellResistanceEntry(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { usesFortitude: false, resistance: null, warning: null };
  const parts = text.split("/").map(part => part.trim()).filter(Boolean);
  if (/^fortitude$/i.test(parts[0])) {
    const valueText = parts.slice(1).join("/").trim();
    const resistance = valueText ? normalizeResistanceValue(valueText) : null;
    return {
      usesFortitude: true,
      resistance,
      warning: valueText && !resistance ? `Unrecognized Resistance: "${text}"` : null
    };
  }
  if (parts.length > 1) {
    return { usesFortitude: false, resistance: null, warning: `Unrecognized Resistance: "${text}"` };
  }
  const resistance = normalizeResistanceValue(text);
  return {
    usesFortitude: false,
    resistance,
    warning: resistance ? null : `Unrecognized Resistance: "${text}"`
  };
}

/**
 * Read the STORED resistance id of a spell. Rule logic uses the structured
 * field; raw metadata is never re-parsed for rules.
 * @param {object} spell - Spell Item document.
 * @returns {string|null} An approved resistance id, or null.
 */
export function getSpellResistance(spell) {
  const value = spell?.system?.resistance;
  return typeof value === "string" && SPELL_RESISTANCE_IDS.has(value) ? value : null;
}

// ── Target (discrete labels + composite area notation) ─────────────────────

/** The discrete individual-target rules labels (never grouped). */
export const SPELL_TARGET_LABELS = new Set([
  "caster", "character", "entire-character", "character-x", "object", "point", "touch"
]);

/**
 * Parse an AREA target ("1 area (3m radius)/5") into its composite parts.
 *
 *   "1 area (3m radius)/5"    → { type:"area", areaCount:1, radius:3,
 *                                 selection:"limited", maxTargets:5 }
 *   "1 area (6m radius)/All"  → selection "all" (all creatures present at
 *                               the instant of casting)
 *   "1 area (5m radius)/Space"→ selection "space" (the volume itself is the
 *                               target; creatures entering during the
 *                               duration are affected)
 *   "1 area (3m radius)"      → selection null (no selection mode authored)
 *
 * The selection modes are NOT interchangeable and are never converted.
 *
 * @param {string} raw - Raw target text.
 * @returns {object|null} The area target object, or null when the text is
 *   not area-target notation.
 */
export function parseSpellAreaTarget(raw) {
  const match = String(raw ?? "").trim()
    .match(/^(\d+)\s*areas?\s*\(\s*(\d+)\s*m?\s*radius\s*\)\s*(?:\/\s*(.*))?$/i);
  if (!match) return null;
  const suffix = String(match[3] ?? "").trim();
  let selection = null;
  let maxTargets = null;
  if (/^space$/i.test(suffix)) selection = "space";
  else if (/^all$/i.test(suffix)) selection = "all";
  else if (/^\d+$/.test(suffix)) {
    selection = "limited";
    maxTargets = Number(suffix);
  } else if (suffix) return null; // unrecognized suffix: reported upstream
  return {
    type: "area",
    areaCount: Number(match[1]),
    radius: Number(match[2]),
    selection,
    maxTargets
  };
}

/**
 * Parse a source Target entry into the structured target.
 *
 * Individual targets map to their exact discrete rules labels (synonyms of
 * the same rules label normalize to it; the mechanical distinctions between
 * "character", "entire-character" and "character-x" are never merged).
 * Area targets parse into the composite object of `parseSpellAreaTarget`.
 * Unrecognized values return null and are reported upstream.
 *
 * @param {string} raw - Raw "Target:" entry text.
 * @returns {string|object|null} A label, an area object, or null.
 */
export function parseSpellTarget(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const area = parseSpellAreaTarget(text);
  if (area) return area;
  const normalizers = [
    [/^(?:caster|self)$/i, "caster"],
    [/^(?:1\s+|a\s+|one\s+)?(?:enemy|character|creature)s?$/i, "character"],
    [/^(?:1\s+|a\s+|one\s+)?characters?\s+X$/i, "character-x"],
    [/^(?:1\s+|a\s+|one\s+)?entire\s+characters?$/i, "entire-character"],
    [/^(?:1\s+|a\s+|one\s+)?objects?$/i, "object"],
    [/^(?:any\s+)?\d+\s+points?$/i, "point"],
    [/^any\s+points?$/i, "point"],
    [/^touch(?:ed)?(?:\s+characters?)?$/i, "touch"]
  ];
  for (const [pattern, label] of normalizers) {
    if (pattern.test(text)) return label;
  }
  return null;
}

// ── Range and magical propagation ──────────────────────────────────────────

/**
 * Parse a source Range notation ("2 (30m)", "1 (10 m)") into its structured
 * form. The notation is uniform: N areas of D metres distance.
 *
 *   "2 (30m)" → { areas: 2, distance: 30 }
 *
 * Non-conforming values ("Caster", prose) return null and are reported
 * upstream — nothing is invented for them.
 *
 * @param {string} raw - Raw range text.
 * @returns {{areas: number, distance: number}|null}
 */
export function parseSpellRange(raw) {
  const match = String(raw ?? "").trim().match(/^(\d+)\s*\(\s*(\d+)\s*m\s*\)$/i);
  if (!match) return null;
  return { areas: Number(match[1]), distance: Number(match[2]) };
}

/**
 * Parse the magical-propagation component of the combined "Range / Area"
 * source line. This describes HOW the spell reaches its area, never WHAT it
 * targets — it is never inferred from `target`.
 *
 *   "-"      → null (explicitly no projected area)
 *   "Target" → "target"        (direct manifestation on the target)
 *   "Shot"   → "shot"          (projectile travelling in a straight line)
 *   "Line"   → "line"          (beam or strip)
 *   "Breakthrough" → "breakthrough" (line effect plus caster movement)
 *
 * Unrecognized values return null and are reported upstream.
 *
 * @param {string} raw - Raw propagation text.
 * @returns {string|null} A propagation id, or null.
 */
export function parseSpellPropagation(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "-") return null;
  if (/^target$/.test(value)) return "target";
  if (/^shot$/.test(value)) return "shot";
  if (/^line$/.test(value)) return "line";
  if (/^breakthrough$/.test(value)) return "breakthrough";
  return null;
}

// ── Damage type (DEC-9 bidimensional model) ────────────────────────────────

/**
 * Nature of a spell's damage channel. Derived from the spell's own data
 * only: special-damage bands (uniform type) or the shared Power Table
 * (magical). Unknown → null.
 * @param {Array} bands - Special damage bands (may be empty).
 * @param {boolean} hasPowerTable - Whether the spell uses a Power Table.
 * @returns {string|null} "physical"|"magical"|null.
 */
export function spellDamageNature(specialDamageBands = [], hasPowerTable = false) {
  const bands = Array.isArray(specialDamageBands) ? specialDamageBands : [];
  if (bands.length) {
    const types = new Set(bands.map(band => String(band.damageType || "").toLowerCase()));
    return types.size === 1 ? (types.has("magical") ? "magical" : "physical") : null;
  }
  return hasPowerTable ? "magical" : null;
}

/**
 * Read the typed damage attribute from raw metadata ("Type: Poison" →
 * "Poison", "Type: Psychic (Weak)" → "Psychic"). Only the first token is
 * kept: parenthetical qualifiers are weakness annotations, not the damage
 * attribute (DEC-9 `damageType`).
 * @param {string} metadata - Raw imported metadata text.
 * @returns {string|null} The attribute name, or null when absent.
 */
export function readSpellDamageAttributeFromMetadata(metadata) {
  const match = String(metadata ?? "").match(/^type:\s*(.+)$/im);
  if (!match) return null;
  const token = match[1].trim().split(/[\s(]/)[0].trim();
  return token || null;
}

/**
 * Read the STORED damage attribute of a spell.
 * @param {object} spell - Spell Item document.
 * @returns {string|null} The attribute name, or null when absent.
 */
export function parseSw25SpellDamageAttribute(spell) {
  return spell?.system?.damageType?.attribute ?? null;
}

// ── Shared field derivation (importer + migration use the SAME logic) ──────

/**
 * Derive the full structured Spell field set from the raw source data.
 * Used by the importer when creating Spell Items and by
 * `normalizeSpellData` when migrating existing documents — one derivation,
 * never two.
 *
 * @param {object} input
 * @param {string} [input.name] - Authored spell name (rank + markers).
 * @param {string} [input.metadata] - Raw imported metadata text.
 * @param {Array} [input.specialDamageBands] - Parsed special damage bands.
 * @param {boolean} [input.hasPowerTable] - Power Table presence.
 * @returns {object} { rank, resistance, usesFortitude, target, range, area,
 *   duration, damageType, minorAction, combatPreparation, warnings }
 */
export function deriveSpellFields({ name = "", metadata = "", specialDamageBands = [], hasPowerTable = false } = {}) {
  const text = String(metadata ?? "");
  const metaLine = label => {
    const match = text.match(new RegExp(`^${label}:\\s*(.*)$`, "im"));
    return match ? match[1].trim() : "";
  };
  const warnings = [];

  const duration = readSpellDurationText(text);

  const resistanceEntry = parseSpellResistanceEntry(metaLine("resistance"));
  if (resistanceEntry.warning) warnings.push(resistanceEntry.warning);

  const targetRaw = metaLine("target");
  const target = targetRaw ? parseSpellTarget(targetRaw) : null;
  if (targetRaw && !target) warnings.push(`Unrecognized Target: "${targetRaw}"`);

  let range = null;
  let area = null;
  const rangeAreaRaw = metaLine("range\\/area") || metaLine("range");
  if (rangeAreaRaw) {
    const parts = rangeAreaRaw.split(/\s*\/\s*/);
    const rangeRaw = parts[0].trim();
    const propagationRaw = (parts[1] || "").trim();
    range = parseSpellRange(rangeRaw);
    if (rangeRaw && !range) warnings.push(`Unrecognized Range: "${rangeRaw}"`);
    if (propagationRaw && propagationRaw !== "-") {
      area = parseSpellPropagation(propagationRaw);
      if (!area) warnings.push(`Unrecognized Area: "${propagationRaw}"`);
    }
  }

  const identity = parseSpellNameIdentity(String(name ?? "").trim());
  const attribute = readSpellDamageAttributeFromMetadata(text);
  const nature = spellDamageNature(specialDamageBands, hasPowerTable);
  const damageType = nature || attribute ? { nature: nature ?? null, attribute: attribute ?? null } : null;

  return {
    rank: identity.rank,
    resistance: resistanceEntry.resistance,
    usesFortitude: resistanceEntry.usesFortitude,
    target,
    range,
    area,
    duration,
    damageType,
    minorAction: /⏩/.test(String(name ?? "")),
    combatPreparation: /△/.test(String(name ?? "")),
    warnings
  };
}

// ── Migration (test world + compendium drops; NOT a general framework) ─────

/**
 * Normalize a Spell Item's system data to the current schema.
 *
 * Populates every structured field that is absent (deriving it with the
 * SAME `deriveSpellFields` logic the importer uses) and REMOVES the obsolete
 * fields (`school`, `cost`, `featureType`, `resourceData`). Power is retained
 * as the potency selector for the centralized Power Table catalog.
 * function is idempotent: running it again changes nothing.
 *
 * Consumers:
 *   - `_onDropItem` (actor-sheet.mjs): every Spell entering an actor —
 *     including unmigrated compendium documents — is normalized on copy.
 *   - The test-world migration script.
 *
 * Existing values are never overwritten: a populated structured field wins
 * over a derived one.
 *
 * @param {object} system - Spell system data (old or current schema).
 * @param {object} [options]
 * @param {string} [options.name] - Authored spell name.
 * @returns {{system: object, warnings: string[]}} The normalized system data
 *   and the warnings for unrecognized source values (reported, not invented).
 */
export function normalizeSpellData(system = {}, { name = "" } = {}) {
  const next = { ...system };
  const warnings = [];

  const derived = deriveSpellFields({
    name,
    metadata: String(next.metadata ?? ""),
    specialDamageBands: Array.isArray(next.specialDamageBands) ? next.specialDamageBands : [],
    hasPowerTable: Boolean(next.hasPowerTable)
  });
  warnings.push(...derived.warnings);

  const storedRank = Number(next.rank);
  next.rank = Number.isInteger(storedRank) && storedRank >= 0 ? storedRank : derived.rank;

  // Casting modality: the authored name marker is authoritative when present
  // (a stored legacy `false` next to a ⏩/△ marker is a pre-schema artifact
  // that the migration must repair); a stored `true` without a marker is a
  // user edit and is kept.
  next.minorAction = derived.minorAction || next.minorAction === true;
  next.combatPreparation = derived.combatPreparation || next.combatPreparation === true;

  const storedDuration = next.duration == null ? "" : String(next.duration).trim();
  next.duration = storedDuration !== "" ? storedDuration : derived.duration;

  const storedResistance = typeof next.resistance === "string" ? next.resistance.trim() : "";
  if (storedResistance !== "" && SPELL_RESISTANCE_IDS.has(storedResistance)) {
    next.resistance = storedResistance;
    if (typeof next.usesFortitude !== "boolean") next.usesFortitude = derived.usesFortitude;
  } else {
    next.resistance = derived.resistance;
    next.usesFortitude = derived.usesFortitude;
  }

  if (next.target == null) next.target = derived.target;
  if (next.range == null) next.range = derived.range;
  if (next.area == null) next.area = derived.area;
  if (next.damageType == null) next.damageType = derived.damageType;

  delete next.school;
  delete next.cost;
  delete next.featureType;
  delete next.resourceData;

  return { system: next, warnings };
}
