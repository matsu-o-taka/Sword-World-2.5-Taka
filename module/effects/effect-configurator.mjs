// Sword World 2.5 - UI-independent helpers for the Effects configurator.
//
// The application owns presentation and DOM state. This module only adapts
// Generic Effect and Damage Vulnerability form values to the existing
// configured-effect builder and resolves the Actor selection used by direct
// application. No documents are created here and no separate validation or
// effect lifecycle is introduced.

import {
  buildSw25ConfiguredEffect,
  SW25_CONFIGURED_EFFECT_DURATION_SCALES
} from "./configured-effect.mjs";
import {
  DAMAGE_VULNERABILITY_RULE_KEY
} from "./damage-vulnerability.mjs";
import {
  SW25_CURSE_EFFECT_TYPE,
  SW25_WORDBREAK_PHYSICAL_STATE_TYPES
} from "./effect-cancellation.mjs";

/** Initial Damage Vulnerability form values (session-only, not a setting). */
export const SW25_DAMAGE_VULNERABILITY_DEFAULTS = Object.freeze({
  name: "Damage Vulnerability",
  description: "",
  additionalDamage: "2",
  category: "any",
  element: "any",
  source: ""
});

/**
 * Initial Generic Effect form values (session-only, not a setting).
 *
 * `magical` is the strict boolean classification: "magical" (true) or
 * "nonmagical" (false). New effects default to non-magical/unconfirmed.
 * The creator prepares persistent (X) effects only. Manual scales are
 * GM-managed; `rounds` uses a positive counter and the existing direct
 * roundEnd expiry flow. Instant and Instant/X immediate components belong to
 * action-specific casting flows and are not generic persistent descriptors.
 */
export const SW25_GENERIC_EFFECT_DEFAULTS = Object.freeze({
  name: "New Effect",
  description: "",
  magical: "nonmagical",
  successValue: "0",
  effectType: "",
  durationScale: "",
  durationValue: "1"
});

/** Magical-classification choices (maps to the boolean `isMagical` field). */
export const SW25_GENERIC_MAGICAL_OPTIONS = Object.freeze([
  { id: "nonmagical", label: "Non-magical" },
  { id: "magical", label: "Magical" }
]);

/** Effect Type classifications with an implemented cancellation role. */
export const SW25_GENERIC_EFFECT_TYPE_OPTIONS = Object.freeze([
  { id: "", label: "Unclassified" },
  { id: SW25_CURSE_EFFECT_TYPE, label: "Curse" },
  ...[...SW25_WORDBREAK_PHYSICAL_STATE_TYPES].map(id => ({
    id,
    label: id[0].toUpperCase() + id.slice(1)
  }))
]);

/** Persistent duration choices exposed by the generic creator. */
export const SW25_GENERIC_DURATION_OPTIONS = Object.freeze([
  { id: "", label: "None (no duration recorded)" },
  ...SW25_CONFIGURED_EFFECT_DURATION_SCALES.map(id => ({
    id,
    label: id === "rounds" ? "Rounds (round-end expiry)" : id[0].toUpperCase() + id.slice(1)
  }))
]);

/**
 * Map a magical form value to the strict boolean `isMagical` field.
 * Missing values and the retired "unspecified" choice normalize to false for
 * backward compatibility; arbitrary malformed values are never treated as
 * magical.
 * @param {*} value - Form value.
 * @returns {{ok: true, isMagical: boolean}|{ok: false, code: string, error: string}}
 */
function magicalClassification(value) {
  if (value === true || value === "magical" || value === "true") return { ok: true, isMagical: true };
  if (value === false || value === "nonmagical" || value === "non-magical" || value === "false"
    || value === undefined || value === null || value === "" || value === "unspecified") {
    return { ok: true, isMagical: false };
  }
  return {
    ok: false,
    code: "invalid-magical",
    error: "Magical classification must be Magical or Non-magical."
  };
}

/**
 * Adapt raw Generic Effect configurator values to a validated configured
 * effect with NO mechanical rules.
 *
 * A generic effect is a normal `sw25Effect` with no mechanical rules. Its
 * presentation, fixed Success Value, cancellation classification and
 * supported persistent duration are ordinary configured-effect data. It has
 * no native origin: the Effects window is not a content document.
 *
 * @param {object} input - Raw Generic Effect configurator values.
 * @returns {{ok: true, configured: object}|{ok: false, code: string, error: string}}
 */
export function buildSw25GenericEffectConfiguration(input) {
  const values = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const classification = magicalClassification(values.magical ?? values.isMagical);
  if (!classification.ok) return classification;
  const rawEffectType = values.effectType === undefined || values.effectType === null ? "" : values.effectType;
  const effectType = typeof rawEffectType === "string" ? rawEffectType.trim() : rawEffectType;
  if (typeof effectType !== "string"
    || !SW25_GENERIC_EFFECT_TYPE_OPTIONS.some(option => option.id === effectType)) {
    return {
      ok: false,
      code: "invalid-effect-type",
      error: "Effect Type must be Unclassified or an implemented cancellation classification."
    };
  }

  const rawSuccessValue = values.successValue;
  const successText = typeof rawSuccessValue === "string" ? rawSuccessValue.trim() : null;
  const successValue = successText !== null && /^\d+$/.test(successText)
    ? Number(successText)
    : rawSuccessValue;
  const durationScale = values.durationScale === undefined || values.durationScale === null
    || values.durationScale === "" ? null : values.durationScale;
  const rawDurationValue = values.durationValue;
  const durationText = typeof rawDurationValue === "string" ? rawDurationValue.trim() : null;
  const durationValue = durationText !== null && /^\d+$/.test(durationText)
    ? Number(durationText)
    : rawDurationValue;

  return buildSw25ConfiguredEffect({
    id: values.id,
    name: values.name,
    description: values.description,
    origin: null,
    isMagical: classification.isMagical,
    effectType,
    successValue,
    // The GM explicitly supplies a fixed value; provenance is never inferred
    // from its number. This makes it authoritative for cancellation tests.
    successValueSource: "fixed",
    durationScale,
    // A hidden round input from an earlier form state is irrelevant when the
    // selected scale is manual or absent.
    initialDuration: durationScale === "rounds" ? durationValue : null,
    rules: []
  });
}

/**
 * Adapt raw form values to a validated configured effect.
 *
 * FormData supplies strings. Only a string consisting entirely of an integer
 * is converted to a number before the existing rule normalizer sees it; every
 * other value is passed through unchanged so validation can reject it without
 * guessing or silently correcting the input. An exactly blank source is the
 * explicit Any Source choice; other blank-like strings remain invalid.
 *
 * Manual entries deliberately have no native origin UUID. The Effects window
 * is not a content document, and the damage-source filter is not effect
 * provenance. The caller supplies `id` to keep one identity across previews.
 *
 * @param {object} input - Raw Damage Vulnerability configurator values.
 * @returns {{ok: true, configured: object}|{ok: false, code: string, error: string}}
 */
export function buildSw25DamageVulnerabilityConfiguration(input) {
  const values = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const rawDamage = values.additionalDamage;
  const integerText = typeof rawDamage === "string" ? rawDamage.trim() : null;
  const additionalDamage = integerText !== null && /^[+-]?\d+$/.test(integerText)
    ? Number(integerText)
    : rawDamage;
  const source = values.source === undefined || values.source === null || values.source === ""
    ? null
    : values.source;

  return buildSw25ConfiguredEffect({
    id: values.id,
    name: values.name,
    description: values.description,
    origin: null,
    rules: [{
      key: DAMAGE_VULNERABILITY_RULE_KEY,
      value: additionalDamage,
      category: values.category,
      element: values.element,
      source
    }]
  });
}

/**
 * Resolve exactly one Actor from the currently controlled tokens.
 * Multiple controlled tokens for the same Actor are unambiguous because the
 * configured effect is applied to the Actor, not to an individual token.
 *
 * @param {Iterable<object>|null|undefined} controlled - Controlled Token docs.
 * @returns {{ok: true, actor: object}|{ok: false, code: string, error: string}}
 */
export function resolveSw25ControlledActor(controlled) {
  const actors = new Map();
  for (const token of controlled ?? []) {
    const actor = token?.actor;
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }
  if (actors.size === 1) return { ok: true, actor: [...actors.values()][0] };
  if (actors.size > 1) {
    return {
      ok: false,
      code: "ambiguous-selection",
      error: "Multiple Actors are selected. Select exactly one Actor token before applying the effect."
    };
  }
  return {
    ok: false,
    code: "no-selection",
    error: "Select exactly one Actor token before applying the effect."
  };
}
