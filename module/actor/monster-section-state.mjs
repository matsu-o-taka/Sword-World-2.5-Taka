// Sword World 2.5 - Multi-section monster state (pure, framework-free).
//
// Pure derivation of a monster's per-section destruction and global
// incapacitation from its persisted data. Nothing here writes; the HP →
// DEFEATED sync (module/actor/defeated-status.mjs) consumes the computed
// condition and the monster sheet consumes the same state for its read-only
// indicator. Sections are never converted into effects and no state is
// duplicated: destruction is ALWAYS derived from the section HP.
//
// Rules (Core Rulebook I, p. 387 "Main Section", verified):
//   - A section is destroyed when its HP reach 0 or below (p. 386: a section
//     at 0 HP becomes inactive). Negative HP are preserved by every writer;
//     this module never clamps.
//   - `any` (default): if any ONE of the main sections falls to 0 or below,
//     the monster is incapacitated. Covers one main section and several
//     noted without (All).
//   - `all` — (All) notation: only when ALL the specified main sections fall
//     to 0 or below.
//   - `none` — (None) notation: the monster stays active until ALL its
//     sections are destroyed.
//   - `special` — a policy CATEGORY, not a rule: defeat resolution is
//     delegated to a special rule persisted INDEPENDENTLY in
//     `system.mainSectionSpecialRule` (see `MONSTER_SPECIAL_RULES`):
//       * `concealedMainSection` — Concealed Main Section (Cursed Artist
//         data, CR III p. 368): the monster's Main Section is secretly ONE
//         of its sections, so it incapacitates exactly like a single main
//         section (`any`) once the secret selection is known. The selection
//         is NEVER stored in the actor data — the GM-side sync resolves it
//         through the concealed-section module (GM-only ActiveEffect
//         records) and injects it into the pure state as an option. Without
//         a valid selection the profile degrades to the
//         all-sections-destroyed condition (never instant defeat, never
//         immortal), matching the pre-integration behavior. Ordinary
//         main-section row markers are IGNORED for this rule.
//       * `manual` — Manual Resolution: a special rule the system does not
//         implement. The system NEVER derives incapacitation from section
//         destruction (incapacitated is always false) — the GM resolves the
//         rule by hand. No concealed selection is generated or consumed.
//     A `special` policy with NO selected rule is the controlled
//     "unconfigured" state: the pure state keeps the legacy degradation,
//     while the GM-side DEFEATED sync refuses to evaluate it and informs
//     the GM (it must never silently resolve as Any). Legacy imports
//     identified as special (`mainSection.type = "special"`) without a
//     persisted rule keep the pre-rule degraded behavior unchanged.
//
// The mode resolution reads the system's `mainSectionPolicy` property when
// present (set from the monster sheet dialog). Otherwise the meaning is
// RECOVERED from the persisted import data `mainSection.type` — "all",
// "none" and "special" map directly to the same-named rules — and anything
// else resolves to the documented default `any`, so existing monsters need
// no migration.

import { readMonsterCombatStyles } from "./monster-sheet-data.mjs";

/** Approved Main Section policy ids (monster sheet dialog vocabulary). */
export const MAIN_SECTION_POLICIES = ["any", "all", "none", "special"];

/**
 * Approved special-rule ids for the `special` policy. Special is a policy
 * CATEGORY: each id is one resolvable special rule with its own resolution
 * behavior. New implemented rules are added here (with their configuration
 * and resolution behavior), never as an alias of the category itself.
 */
export const MONSTER_SPECIAL_RULES = ["concealedMainSection", "manual"];

/** GM-facing labels for the special-rule ids (dialog vocabulary). */
export const SPECIAL_RULE_LABELS = {
  concealedMainSection: "Concealed",
  manual: "Manual Resolution"
};

const normalizedPolicy = value => {
  const policy = String(value ?? "").trim().toLowerCase();
  return MAIN_SECTION_POLICIES.includes(policy) ? policy : null;
};

const normalizedSpecialRule = value => {
  const rule = String(value ?? "").trim();
  return MONSTER_SPECIAL_RULES.includes(rule) ? rule : null;
};

/**
 * Resolve the special rule persisted for a `special` policy. The rule is
 * stored independently from the policy value and is PRESERVED when the GM
 * switches to another policy, so switching back to Special restores it
 * without regenerating any selection.
 * @param {object} system - The monster's `system` data.
 * @returns {{rule: string|null}} One of `MONSTER_SPECIAL_RULES`, or null
 *   when no valid rule is persisted (the controlled unconfigured state).
 */
export function resolveMonsterSpecialRule(system = {}) {
  return { rule: normalizedSpecialRule(system?.mainSectionSpecialRule) };
}

const numericSectionHP = row => {
  const value = Number(row?.hp?.value);
  return Number.isFinite(value) ? value : null;
};

/**
 * Resolve the monster's Main Section policy.
 *
 * Resolution order (documented, read-only — never written back):
 *   1. explicit `system.mainSectionPolicy` (any | all | none | special);
 *   2. recovered from the imported `system.mainSection.type`:
 *      "all" → all, "none" → none, "special" → special (the (All)/(None)/
 *      (Special) meanings, CR I p. 387 and CR III p. 368);
 *   3. default `any`.
 * @param {object} system - The monster's `system` data.
 * @returns {{policy: string, source: "explicit"|"derived"|"default"}}
 */
export function resolveMonsterSectionPolicy(system = {}) {
  const explicit = normalizedPolicy(system?.mainSectionPolicy);
  if (explicit) return { policy: explicit, source: "explicit" };
  const type = String(system?.mainSection?.type ?? "").trim().toLowerCase();
  if (type === "all") return { policy: "all", source: "derived" };
  if (type === "none") return { policy: "none", source: "derived" };
  if (type === "special") return { policy: "special", source: "derived" };
  return { policy: "any", source: "default" };
}

/**
 * Whether this system data identifies a Concealed Main Section profile
 * (`mainSection.type = "special"`, the import identification, or an explicit
 * `special` policy). The original `type` meaning is never replaced: this is
 * only a read.
 * @param {object} system - The monster's `system` data.
 * @returns {boolean}
 */
export function isSpecialMainSectionProfile(system = {}) {
  if (normalizedPolicy(system?.mainSectionPolicy) === "special") return true;
  return String(system?.mainSection?.type ?? "").trim().toLowerCase() === "special";
}

/**
 * Index set of the monster's main sections.
 *
 * The existing marking mechanism is respected, never replaced:
 *   0. for a `special` (Concealed Main Section) profile, ONLY the secretly
 *      selected section participates — the selection is injected via
 *      `options.concealedSectionId` / `options.concealedSectionName` by the
 *      GM-side sync (the selection lives in GM-only records, never in the
 *      actor data). A profile without a valid selection yields an empty set
 *      and degrades to the all-sections-destroyed condition;
 *   1. rows explicitly flagged `isMainSection === true` (the sheet marking);
 *   2. for (All) monsters, the sections NAMED in the persisted
 *      `mainSection.sourceValue` — the row flags of older imports flagged
 *      every row for (All), which is not the rulebook meaning ("all SPECIFIED
 *      main sections", CR I p. 387); the named match is rule-correct for both
 *      eras and takes precedence for this type;
 *   3. rows referenced by `mainSection.combatStyleIds` (importer record);
 *   4. the single row of a single-section monster (existing convention);
 *   5. an empty set for an incomplete multi-section profile — callers treat
 *      that as the all-sections-destroyed condition (see `condition`), so an
 *      incomplete profile can never produce a vacuous instant incapacitation.
 * @param {Array<object>} rows - Section rows from `readMonsterCombatStyles`.
 * @param {object} system - The monster's `system` data.
 * @param {{concealedSectionId?: string|null, concealedSectionName?: string|null}} [options]
 *   GM-side injected Concealed Main Section selection (special policy only).
 * @returns {number[]}
 */
export function resolveMonsterMainSectionIndices(rows, system = {}, options = {}) {
  const mainSection = system?.mainSection ?? null;

  // Concealed Main Section: the secret selection is THE main section. It
  // short-circuits the identified-mains chain — identified flags, import
  // records and single-row conventions do not apply to a secret selection
  // (stale ordinary main-section markers never leak into the special rule).
  if (isSpecialMainSectionProfile(system)) {
    return concealedSelectionIndices(rows, options);
  }

  // Explicit All policy (the sheet's All choice): ALL sections of the
  // monster are the main sections. The sheet auto-marks every row and the
  // dialog persists the flags; this resolution agrees with both regardless
  // of the stored flags, so an explicit-All profile can never silently fall
  // back to a smaller legacy subset. Derived (All) imports below keep the
  // rulebook reading ("all SPECIFIED main sections", CR I p. 387).
  const { policy, source } = resolveMonsterSectionPolicy(system);
  if (policy === "all" && source === "explicit") {
    return rows.map((_, index) => index);
  }

  const flagged = rows.flatMap((row, index) => row?.isMainSection === true ? [index] : []);
  if (String(mainSection?.type ?? "").toLowerCase() === "all") {
    const named = monsterSectionIndicesByName(rows, mainSection?.sourceValue ?? "");
    if (named.length) return named;
  }
  if (flagged.length) return flagged;

  const ids = Array.isArray(mainSection?.combatStyleIds) ? mainSection.combatStyleIds : [];
  if (ids.length) {
    const referenced = rows.flatMap((row, index) => row?.id && ids.includes(row.id) ? [index] : []);
    if (referenced.length) return referenced;
  }
  if (rows.length === 1) return [0];
  return [];
}

/**
 * Indices of the secretly selected Concealed Main Section.
 * Matches by stable row id first, then by section-name equivalence (with
 * count annotations stripped, e.g. "Musician" against "Musician"). Unknown
 * or missing selections yield an empty set — never a guess.
 * @param {Array<object>} rows - Section rows.
 * @param {{concealedSectionId?: string|null, concealedSectionName?: string|null}} options
 * @returns {number[]}
 */
function concealedSelectionIndices(rows, options = {}) {
  const id = String(options.concealedSectionId ?? "").trim();
  if (id) {
    const byId = rows.flatMap((row, index) => row?.id === id ? [index] : []);
    if (byId.length) return byId;
  }
  const name = String(options.concealedSectionName ?? "").trim();
  if (name) return monsterSectionIndicesByName(rows, name);
  return [];
}

function monsterSectionIndicesByName(rows, sourceValue) {
  const raw = String(sourceValue ?? "").trim();
  if (!raw) return [];
  // Strip an "(All)"/"(None)" annotation and any trailing section-count
  // annotation, then split a possible comma list ("Head, Body (All)").
  const withoutAnnotation = raw.replace(/\((?:\s*all\s*|\s*none\s*)\)\s*$/i, "").trim();
  const names = withoutAnnotation.split(",").map(name => name.trim()).filter(Boolean);
  const normalizedForMatch = value => String(value ?? "")
    .replace(/\s+x\s*.+$/i, "") // "Neck x 7-9" → "Neck" (count annotation)
    .replace(/\([^()]*\)/g, " ") // drop any parenthetical remainder
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const targets = names.map(normalizedForMatch).filter(Boolean);
  if (!targets.length) return [];
  const matched = [];
  for (const [index, row] of rows.entries()) {
    const section = normalizedForMatch(row?.section ?? row?.sectionLabel ?? "");
    if (section && targets.includes(section) && !matched.includes(index)) matched.push(index);
  }
  return matched;
}

/**
 * Derive the full multi-section state of one monster.
 *
 * Sections without a usable numeric HP value are NOT countable sections:
 * they can never be destroyed and never block the `all`/`none` conditions
 * (an HP placeholder like "-" is not a section HP, it is the absence of one).
 * A monster with no countable sections is never incapacitated by this module.
 * @param {object} system - The monster's `system` data.
 * @param {{concealedSectionId?: string|null, concealedSectionName?: string|null}} [options]
 *   GM-side injected Concealed Main Section selection (special policy only);
 *   without it a special profile degrades to the all-sections condition.
 * @returns {{policy: string, source: string, sections: Array,
 *   mainSectionIndices: number[], destroyedCount: number, sectionCount: number,
 *   incapacitated: boolean}}
 *   `sections` rows: `{index, id, section, hp, destroyed}` — `hp` is the
 *   numeric value (null when unusable) and `destroyed` is `hp <= 0`; the raw
 *   HP are never modified.
 */
export function readMonsterSectionState(system = {}, options = {}) {
  const rows = readMonsterCombatStyles(system?.combatStyles);
  const sections = rows.map((row, index) => {
    const hp = numericSectionHP(row);
    return {
      index,
      id: row?.id ?? null,
      section: String(row?.section ?? row?.sectionLabel ?? "").trim(),
      hp,
      destroyed: hp !== null && hp <= 0
    };
  });
  const countable = sections.filter(section => section.hp !== null);
  const mainIndices = resolveMonsterMainSectionIndices(rows, system, options)
    .filter(index => sections[index]?.hp !== null);
  const { policy, source } = resolveMonsterSectionPolicy(system);
  const { rule: specialRule } = policy === "special" ? resolveMonsterSpecialRule(system) : { rule: null };

  const allCountableDestroyed = countable.length > 0 && countable.every(section => section.destroyed);
  const mainSections = mainIndices.map(index => sections[index]);

  // Empty main set (incomplete profile): degrade to the all-sections
  // condition instead of a vacuous reading (never instantly defeated, never
  // immortal by accident).
  let incapacitated;
  if (policy === "special") {
    if (specialRule === "manual") {
      // Manual Resolution: the system does not implement this rule and never
      // derives incapacitation from section destruction — the GM resolves it
      // by hand.
      incapacitated = false;
    } else if (specialRule === null && source === "explicit") {
      // Explicit Special with NO selected rule: controlled unconfigured
      // state. Never silently resolved as Any (that fallback is reserved for
      // the legacy derived case). The GM must choose a rule first.
      incapacitated = false;
    } else {
      // concealedMainSection (valid, with an injected selection behaves like
      // Any) OR a derived special profile without an explicit rule (legacy
      // fallback degrades to the all-sections-destroyed condition).
      incapacitated = mainSections.length > 0
        ? mainSections.some(section => section.destroyed)
        : allCountableDestroyed;
    }
  } else if (policy === "none") {
    incapacitated = allCountableDestroyed;
  } else if (policy === "all") {
    incapacitated = mainSections.length > 0
      ? mainSections.every(section => section.destroyed)
      : allCountableDestroyed;
  } else { // any
    incapacitated = mainSections.length > 0
      ? mainSections.some(section => section.destroyed)
      : allCountableDestroyed;
  }

  return {
    policy,
    source,
    specialRule: policy === "special" ? specialRule : null,
    specialUnconfigured: policy === "special" && source === "explicit" && !specialRule,
    sections,
    mainSectionIndices: mainIndices,
    destroyedCount: sections.filter(section => section.destroyed).length,
    sectionCount: sections.length,
    incapacitated
  };
}
