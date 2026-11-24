// Sword World 2.5 - Reusable rule-element registry.
//
// The PF2e-inspired foundation of the system's configurable effects: an
// ActiveEffect's `system.rules` array holds one entry per configured rule,
// and `key` selects the rule element definition that owns validation,
// canonicalization and evaluation.
//
// This module is the ONLY place that maps a rule key to its implementation.
// Adding a rule family means adding a definition here (and, when it needs
// damage context, an evaluator that consumes `buildSw25DamageContext`); no
// effect consumer hard-codes individual rule types.
//
// Rule entries are persisted as plain objects (schema: `ArrayField(ObjectField)`)
// because each definition owns a different parameter set. Validation is
// therefore performed here, at the single write path, and by the repair layer
// on read.

import {
  DAMAGE_VULNERABILITY_RULE_KEY,
  normalizeDamageVulnerabilityRule
} from "./damage-vulnerability.mjs";

/**
 * Registry of reusable rule element definitions.
 *
 * Definition shape:
 *   key         - persisted `system.rules[].key`.
 *   label       - presentation name.
 *   description - presentation summary.
 *   normalize   - `(raw) => {ok, rule} | {ok:false, code, error}`.
 * @type {Record<string, {key: string, label: string, description: string, normalize: Function}>}
 */
export const SW25_RULE_ELEMENTS = Object.freeze({
  [DAMAGE_VULNERABILITY_RULE_KEY]: Object.freeze({
    key: DAMAGE_VULNERABILITY_RULE_KEY,
    label: "Damage Vulnerability",
    description: "Increases (or reduces) incoming damage that matches the configured category, element and source.",
    normalize: normalizeDamageVulnerabilityRule
  })
});

/**
 * Resolve a rule element definition by key.
 * @param {*} key - Persisted rule key.
 * @returns {object|null} The definition, or null when the key is not declared.
 */
export function getSw25RuleElementDefinition(key) {
  return SW25_RULE_ELEMENTS[String(key ?? "").trim()] ?? null;
}

/**
 * Validate and canonicalize a `system.rules` array (strict write path).
 * @param {*} rules - Candidate rules array.
 * @returns {{ok: true, rules: object[]}|{ok: false, code: string, error: string}}
 */
export function normalizeSw25RuleElements(rules) {
  if (rules === undefined || rules === null) return { ok: true, rules: [] };
  if (!Array.isArray(rules)) {
    return { ok: false, code: "invalid-rules", error: "system.rules must be an array of rule element objects." };
  }
  const normalized = [];
  for (let index = 0; index < rules.length; index += 1) {
    const entry = rules[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, code: "invalid-rules", error: `system.rules[${index}] must be an object.` };
    }
    const definition = getSw25RuleElementDefinition(entry.key);
    if (!definition) {
      return {
        ok: false,
        code: "unknown-rule",
        error: `system.rules[${index}].key "${String(entry.key ?? "")}" is not a declared rule element.`
      };
    }
    const result = definition.normalize(entry);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        error: `system.rules[${index}]: ${result.error}`
      };
    }
    normalized.push(result.rule);
  }
  return { ok: true, rules: normalized };
}

/**
 * Lenient normalization used by the GM repair layer (DEC-41): recoverable
 * entries are canonicalized; anything ambiguous is KEPT untouched and
 * reported for review, never silently discarded or reinterpreted.
 * @param {*} rules - Stored `system.rules` value.
 * @returns {{rules: *, issues: Array<{code: string, detail: string}>}}
 */
export function repairSw25RuleElements(rules) {
  if (rules === undefined || rules === null) return { rules, issues: [] };
  if (!Array.isArray(rules)) {
    return {
      rules,
      issues: [{
        code: "rules-not-array",
        detail: "system.rules is not an array; the value was NOT modified and needs GM review."
      }]
    };
  }
  const result = [];
  const issues = [];
  rules.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      result.push(entry);
      issues.push({
        code: "rule-invalid",
        detail: `system.rules[${index}] is not an object; the value was NOT modified and needs GM review.`
      });
      return;
    }
    const definition = getSw25RuleElementDefinition(entry.key);
    if (!definition) {
      result.push(entry);
      issues.push({
        code: "rule-unknown-key",
        detail: `system.rules[${index}].key "${String(entry.key ?? "")}" is not a declared rule element; the entry was KEPT and needs GM review.`
      });
      return;
    }
    const normalized = definition.normalize(entry);
    if (!normalized.ok) {
      result.push(entry);
      issues.push({
        code: "rule-invalid",
        detail: `system.rules[${index}] (${definition.key}) could not be normalized: ${normalized.error} The entry was KEPT and needs GM review.`
      });
      return;
    }
    result.push(normalized.rule);
  });
  return { rules: result, issues };
}
