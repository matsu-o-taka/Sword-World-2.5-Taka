// Sword World 2.5 - EFFECT_TARGETS catalog (T3.1, v1).
//
// Single central source of truth for the destinations an `sw25Effect` may
// modify (DEC-44/DEC-28). Every mechanical modification an effect carries is
// expressed as a native change entry in the effect's `system.changes` whose
// `key` MUST reference an entry declared here; the key is a stable catalog
// identity, never a visual name and never a free-form data path (anti
// sw25-ru §3.7.1: every target field is declared and classified, unknown
// targets are never silently applied).
//
// Nature of targets:
//   - `arithmetic`: numeric modifiers applied with the standard add/subtract
//     semantics onto the prepared effective-values ledger (DEC-28: the base
//     value stays stored intact; the ledger is computed during the Actor's
//     preparation and consumers read it — module/effects/effective-values.mjs).
//   - `special`: destinations whose treatment is NOT numeric aggregation
//     (damage matrices, Power Table operations per DEC-27). They are
//     REGISTERED here with their nature declared, but their mechanical
//     treatment is RESERVED for the dedicated blocks (Bloques 6/7): change
//     entries targeting them are diagnosed and never applied arithmetically
//     (module/effects/effective-values.mjs never treats them as numbers).
//
// Conflict resolution is OUT OF SCOPE for this catalog (T3.4): there is no
// `maxOfGroup` change type and no provisional maximum/priority/substitution
// rule. Conflicts belong to the central policy layer (DEC-37/DEC-44), which
// lands with the stacking resolver (Bloque 4). Within this block all
// arithmetic modifiers simply accumulate over the shared ledger.
//
// The catalog is importable headless: it only depends on pure rule data
// (skill-definitions for the parameterized skill-check family).

import { SKILL_DEFINITION_MAP } from "../rules/skill-definitions.mjs";

/**
 * Schema version of this catalog (same versioning discipline as the effect
 * `system.*` payload, DEC-41): a new version is required whenever the set of
 * declared destinations or their treatment changes meaningfully.
 * @type {number}
 */
export const EFFECT_TARGETS_VERSION = 1;

/**
 * Classification groups of the declared destinations.
 * @type {Record<string, string>}
 */
export const EFFECT_TARGET_GROUPS = {
  abilities: "Ability scores (Strength, Dexterity, ...)",
  resistances: "Resistance checks (Fortitude, Willpower)",
  combat: "Combat values (Accuracy, Evasion, Defense, ...)",
  resources: "Hit and Magic Points",
  skills: "Skill checks (parameterized by skill definition)",
  special: "Special destinations (reserved treatment)"
};

/**
 * Reserved key prefixes for special destinations. Changes referencing these
 * prefixes are diagnosed with code `reserved-target` and are NEVER applied
 * arithmetically; their treatments land with Bloques 6/7.
 * @type {string[]}
 */
export const SPECIAL_TARGET_PREFIXES = ["special."];

/**
 * The catalog entries, keyed by the exact `changes[].key` that references
 * them (DEC-28 destinations; no invented targets, none missing).
 *
 * Entry shape:
 *   key        - exact change key referencing this entry.
 *   group      - one of EFFECT_TARGET_GROUPS keys.
 *   nature     - "arithmetic" | "special".
 *   label      - human-readable name (presentation only, never for matching).
 *   phase      - DEC-27 modifier phase: "roll" (applied to roll modifiers and
 *                values consulted before a roll/calculation) or "final"
 *                (applied to the final mechanical result of a calculation).
 *   ledger     - path of the prepared effective-values ledger where the
 *                accumulated modifier is written (arithmetic entries only).
 *   treatment  - arithmetic: "accumulate" (add/subtract over the ledger).
 *                special: "reserved" (diagnosed, never applied here).
 *
 * Notes on the approved destination set (DEC-28):
 *   - Ability modifiers flow into the ability SCORE; derived Ability Score
 *     Bonuses recompute from the effective score (base formula + modifier).
 *   - Magic Power is a roll-phase combat value (used by the Magic Power
 *     check and damage rolls).
 *   - Extra Damage is the character's situational damage contribution
 *     (final-result phase of damage calculations).
 *   - HP/MP targets modify the maximum values displayed and consulted;
 *     current values are never auto-modified.
 *   - Skill checks are parameterized: key = `skill.<definitionKey>` where
 *     `<definitionKey>` is an existing key of the shared skill definitions
 *     (module/rules/skill-definitions.mjs). Unknown parameters are rejected.
 *   - Damage matrices and the three Power Table operations (potency of the
 *     consulted table, index/roll used for the lookup, final result after
 *     resolution — DEC-27) are special reserved destinations.
 *
 * @type {Record<string, object>}
 */
export const EFFECT_TARGETS = {
  // ── Abilities (DEC-28: characteristics and attributes) ──────────────────
  "ability.strength": { key: "ability.strength", group: "abilities", nature: "arithmetic", label: "Strength", phase: "roll", ledger: "abilities.strength", treatment: "accumulate" },
  "ability.agility": { key: "ability.agility", group: "abilities", nature: "arithmetic", label: "Agility", phase: "roll", ledger: "abilities.agility", treatment: "accumulate" },
  "ability.dexterity": { key: "ability.dexterity", group: "abilities", nature: "arithmetic", label: "Dexterity", phase: "roll", ledger: "abilities.dexterity", treatment: "accumulate" },
  "ability.vitality": { key: "ability.vitality", group: "abilities", nature: "arithmetic", label: "Vitality", phase: "roll", ledger: "abilities.vitality", treatment: "accumulate" },
  "ability.intelligence": { key: "ability.intelligence", group: "abilities", nature: "arithmetic", label: "Intelligence", phase: "roll", ledger: "abilities.intelligence", treatment: "accumulate" },
  "ability.spirit": { key: "ability.spirit", group: "abilities", nature: "arithmetic", label: "Spirit", phase: "roll", ledger: "abilities.spirit", treatment: "accumulate" },

  // ── Resistances (DEC-28: Fortitude, Willpower) ──────────────────────────
  "resistance.fortitude": { key: "resistance.fortitude", group: "resistances", nature: "arithmetic", label: "Fortitude", phase: "roll", ledger: "resistances.fortitude", treatment: "accumulate" },
  "resistance.willpower": { key: "resistance.willpower", group: "resistances", nature: "arithmetic", label: "Willpower", phase: "roll", ledger: "resistances.willpower", treatment: "accumulate" },

  // ── Combat values (DEC-28: Accuracy, Evasion, Defense and derived) ──────
  "combat.accuracy": { key: "combat.accuracy", group: "combat", nature: "arithmetic", label: "Accuracy", phase: "roll", ledger: "combat.accuracy", treatment: "accumulate" },
  "combat.evasion": { key: "combat.evasion", group: "combat", nature: "arithmetic", label: "Evasion", phase: "roll", ledger: "combat.evasion", treatment: "accumulate" },
  "combat.defense": { key: "combat.defense", group: "combat", nature: "arithmetic", label: "Defense", phase: "final", ledger: "combat.defense", treatment: "accumulate" },
  "combat.magicalDefense": { key: "combat.magicalDefense", group: "combat", nature: "arithmetic", label: "Magical Defense", phase: "final", ledger: "combat.magicalDefense", treatment: "accumulate" },
  "combat.initiative": { key: "combat.initiative", group: "combat", nature: "arithmetic", label: "Initiative", phase: "roll", ledger: "combat.initiative", treatment: "accumulate" },
  "combat.magicPower": { key: "combat.magicPower", group: "combat", nature: "arithmetic", label: "Magic Power", phase: "roll", ledger: "combat.magicPower", treatment: "accumulate" },
  "combat.additionalDamage": { key: "combat.additionalDamage", group: "combat", nature: "arithmetic", label: "Extra Damage", phase: "final", ledger: "combat.additionalDamage", treatment: "accumulate" },

  // ── Resources (DEC-28: HP and MP) ───────────────────────────────────────
  "resource.hpMax": { key: "resource.hpMax", group: "resources", nature: "arithmetic", label: "Maximum HP", phase: "final", ledger: "resources.hpMax", treatment: "accumulate" },
  "resource.mpMax": { key: "resource.mpMax", group: "resources", nature: "arithmetic", label: "Maximum MP", phase: "final", ledger: "resources.mpMax", treatment: "accumulate" },

  // ── Special destinations (registered, treatment RESERVED) ───────────────
  // Damage matrices (per monster class / damage element) and the three Power
  // Table operations of DEC-27 (potency of the consulted table, index/roll
  // used for the lookup, final result after resolution) are NOT numeric
  // aggregation targets: their mechanical treatments are reserved for the
  // dedicated blocks (Bloques 6/7). They are declared here so effects can
  // reference them and the pipeline can diagnose them instead of silently
  // misapplying them as numbers. Change entries targeting them are diagnosed
  // (`reserved-target`) and never applied by the effective-values pipeline.
  "special.damageMatrix": { key: "special.damageMatrix", group: "special", nature: "special", label: "Damage Matrix", phase: "final", ledger: null, treatment: "reserved" },
  "special.powerTable.potency": { key: "special.powerTable.potency", group: "special", nature: "special", label: "Power Table Potency", phase: "roll", ledger: null, treatment: "reserved" },
  "special.powerTable.index": { key: "special.powerTable.index", group: "special", nature: "special", label: "Power Table Lookup Index", phase: "roll", ledger: null, treatment: "reserved" },
  "special.powerTable.result": { key: "special.powerTable.result", group: "special", nature: "special", label: "Power Table Final Result", phase: "final", ledger: null, treatment: "reserved" }
};

/** Prefix of the parameterized skill-check family. */
export const SKILL_TARGET_PREFIX = "skill.";

/**
 * Whether a change key references a declared, known target.
 * @param {string} key - Change key under evaluation.
 * @returns {boolean}
 */
export function isKnownSw25EffectTargetKey(key) {
  return resolveSw25EffectTargetKey(key).ok === true;
}

/**
 * Resolve one change key against the catalog (pure).
 *
 * Resolution order (special/reserved first, so a reserved destination can
 * never be mistaken for an applicable arithmetic one):
 *   1. `special.*` prefix — reserved destination: resolvable identity
 *      (registered entries resolve to their catalog entry; other special
 *      keys resolve without an entry), code `reserved-target`, never applied
 *      arithmetically.
 *   2. Exact entry of EFFECT_TARGETS — `known-target`.
 *   3. `skill.<definitionKey>` with an existing skill definition —
 *      `known-target` with a family entry.
 *   4. Anything else — `unknown-target` (never silently applied).
 *
 * @param {string|null} key - Change key under evaluation.
 * @returns {{ok: true, code: "known-target"|"reserved-target", target: object|null}
 *   |{ok: false, code: "unknown-target", target: null}} Resolution result.
 */
export function resolveSw25EffectTargetKey(key) {
  const normalized = String(key ?? "").trim();
  if (!normalized) return { ok: false, code: "unknown-target", target: null };

  if (SPECIAL_TARGET_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return { ok: true, code: "reserved-target", target: EFFECT_TARGETS[normalized] ?? null };
  }

  const exact = EFFECT_TARGETS[normalized];
  if (exact) return { ok: true, code: "known-target", target: exact };

  if (normalized.startsWith(SKILL_TARGET_PREFIX)) {
    const parameter = normalized.slice(SKILL_TARGET_PREFIX.length);
    const definition = SKILL_DEFINITION_MAP.get(parameter);
    if (definition) {
      return {
        ok: true,
        code: "known-target",
        target: {
          key: normalized,
          group: "skills",
          nature: "arithmetic",
          label: definition.name,
          phase: "roll",
          ledger: `skills.${parameter}`,
          treatment: "accumulate"
        }
      };
    }
    return { ok: false, code: "unknown-target", target: null };
  }

  return { ok: false, code: "unknown-target", target: null };
}
