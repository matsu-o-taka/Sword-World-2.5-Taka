// Sword World 2.5 - ActiveEffect system data repair and normalization.
//
// Pure normalization of the `system.*` payload of the system's effect subtype
// (`sw25Effect`, model in module/effects/effect-model.mjs), plus a GM-only
// repair layer that applies the normalization to real effect documents.
//
// The design adapts the Monster Knowledge store pattern
// (module/knowledge/monster-knowledge-store.mjs) without coupling to it:
//   - a pure hydrate/normalize step returning a diagnostics issue list with
//     severities "auto-fixed" (lossless, deterministic) and "review"
//     (ambiguous or irrecoverable: data is KEPT and reported, never dropped
//     or modified silently — DEC-41),
//   - version handling: missing/invalid version is backfilled to the current
//     version; a FUTURE version refuses writes (reads stay possible),
//   - the repair layer is GM-authoritative and performs no write when
//     nothing changed (idempotency at the document level).
//
// Deliberate differences from the MK store:
//   - There is no persistent store of its own: the data lives in the effect
//     documents themselves; the native DataModel schema already applies
//     defaults and validation on every load and write. This module exists
//     for data that arrives OUTSIDE the schema (imports, external writes,
//     legacy blobs) and for exposing `validationFailures`-style diagnostics
//     to the GM.
//   - The native `changes` field is NOT modified here: its structure and
//     conflict resolution belong to the native schema and the stacking
//     policies (DEC-44/DEC-37), not to repair.
//
// Migration mechanism (DEC-41): migrations are sequential (one version per
// step), deterministic and idempotent. FUTURE STEPS PLUG INTO
// `EFFECT_MIGRATION_STEPS` — with only schema v1 shipped the list is empty
// and there is no inherited population to migrate; no placeholder
// migrations are defined.
//
// Write routing (Bloque 2 review): the document write of the repair layer is
// DELEGATED to EffectService (`performSw25EffectRepairWrite`) so the service
// remains the single persistent writer of `sw25Effect` documents (DEC-36).
// The import is deliberately circular (effect-service imports this module's
// normalizer); both bindings are function declarations used at call time,
// which ESM resolves safely.

import { SW25_EFFECT_SCHEMA_VERSION, SW25_DURATION_SCALES, SW25_ANCHOR_REGIMES, SW25_ANCHOR_EDGES, SW25_ANCHOR_STATES, SW25_SUCCESS_VALUE_SOURCES, SW25_EFFECT_SCOPES } from "./effect-model.mjs";
import { performSw25EffectRepairWrite } from "./effect-service.mjs";
import { repairSw25RuleElements } from "./rule-elements.mjs";

/** Current schema version of the effect `system.*` payload (DEC-41). */
export const EFFECT_SCHEMA_VERSION = SW25_EFFECT_SCHEMA_VERSION;

/** Severity of a lossless, deterministic normalization applied to the data. */
export const SEVERITY_AUTO_FIXED = "auto-fixed";

/** Severity of ambiguous/irrecoverable data: KEPT in place and reported. */
export const SEVERITY_REVIEW = "review";

/** Schema v1 field set: anything else in `system.*` is foreign to the schema. */
const SCHEMA_V1_KEYS = new Set([
  "changes",
  "schemaVersion",
  "family",
  "rank",
  "successValue",
  "successValueSource",
  "castId",
  "effectScope",
  "initialDuration",
  "remainingDuration",
  "casterUUID",
  "effectType",
  "isMagical",
  "resistance",
  "familyPolicy",
  "damageType",
  "durationScale",
  "durationAnchor",
  "sourceDuration",
  "gmOnly",
  "rules"
]);

/**
 * Sequential migration steps between schema versions (DEC-41). Each entry
 * must be `{ from: <int>, to: <int>, migrate(raw, issues) => void }` where
 * `migrate` mutates a private clone deterministically and pushes issues with
 * the severities above. The list is EMPTY for schema v1: the mechanism is
 * wired, but no migration exists yet and none may be invented.
 * @type {Array<{from: number, to: number, migrate: Function}>}
 */
export const EFFECT_MIGRATION_STEPS = [];

/**
 * Push one diagnostics issue.
 * @param {Array<{code: string, severity: string, detail: string}>} issues
 * @param {string} code
 * @param {string} severity
 * @param {string} detail
 */
function pushIssue(issues, code, severity, detail) {
  issues.push({ code, severity, detail });
}

/**
 * Coerce a stored numeric-string to an exact integer (recoverable, lossless).
 * Non-integer or out-of-range values are kept and reported for review,
 * UNLESS `allowFraction` is set (duration counters after the combat-end
 * minutes conversion): then any finite number ≥ min is legitimate.
 * @param {object} data - Private normalized clone (mutated in place).
 * @param {string} key - Field key.
 * @param {Array} issues - Diagnostics list.
 * @param {object} [options]
 * @param {number|null} [options.min] - Inclusive minimum, or null for no minimum.
 * @param {number|null} [options.nullDefault] - For non-nullable fields with a
 *   schema initial (rank, successValue): a stored null receives the approved
 *   default. Nullable fields (durations) leave it unset so null stays null.
 * @param {boolean} [options.allowFraction] - Accept finite non-integer
 *   numbers ≥ min without an issue (duration counters only).
 */
function coerceStoredInteger(data, key, issues, { min = null, nullDefault, allowFraction = false } = {}) {
  const raw = data[key];
  if (raw === undefined) return;
  if (raw === null) {
    if (nullDefault === undefined) return; // nullable field: null is legitimate
    data[key] = nullDefault;
    pushIssue(issues, `${key}-null-defaulted`, SEVERITY_AUTO_FIXED,
      `system.${key} was null but the field is not nullable; the approved schema default (${nullDefault}) was applied.`);
    return;
  }
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) && !allowFraction) {
      pushIssue(issues, `${key}-not-integer`, SEVERITY_REVIEW,
        `system.${key} is ${String(raw)}; the schema requires an integer. The value was NOT modified and needs GM review.`);
    } else if (min !== null && raw < min) {
      pushIssue(issues, `${key}-out-of-range`, SEVERITY_REVIEW,
        `system.${key} is ${String(raw)}; the schema requires at least ${min}. The value was NOT modified and needs GM review.`);
    }
    return;
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (min !== null && parsed < min) {
      pushIssue(issues, `${key}-out-of-range`, SEVERITY_REVIEW,
        `system.${key} is "${raw.trim()}"; the schema requires at least ${min}. The value was NOT modified and needs GM review.`);
      return;
    }
    data[key] = parsed;
    pushIssue(issues, `${key}-type-corrected`, SEVERITY_AUTO_FIXED,
      `system.${key} was stored as the numeric string "${raw.trim()}"; corrected to the integer ${parsed}.`);
    return;
  }
  pushIssue(issues, `${key}-unsupported-type`, SEVERITY_REVIEW,
    `system.${key} has an unsupported type (${Array.isArray(raw) ? "array" : typeof raw}). The value was NOT modified and needs GM review.`);
}

/**
 * Trim a stored string in place. Non-string values are kept and reported.
 * @param {object} data - Private normalized clone (mutated in place).
 * @param {string} key - Field key.
 * @param {Array} issues - Diagnostics list.
 * @param {object} [options]
 * @param {boolean} [options.blankToNull] - Convert "" to null after trimming
 *   (only for nullable fields where blank ≡ absent: effectType, casterUUID).
 * @param {string|null} [options.uuidShape] - When set, strings that do not
 *   look like a Foundry DocumentUUID ("prefix.id") are reported for review
 *   without being modified.
 */
function cleanStoredString(data, key, issues, { blankToNull = false, uuidShape = null } = {}) {
  const raw = data[key];
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "string") {
    pushIssue(issues, `${key}-unsupported-type`, SEVERITY_REVIEW,
      `system.${key} has an unsupported type (${Array.isArray(raw) ? "array" : typeof raw}). The value was NOT modified and needs GM review.`);
    return;
  }
  const trimmed = raw.trim();
  if (trimmed !== raw) {
    data[key] = trimmed;
    pushIssue(issues, `${key}-trimmed`, SEVERITY_AUTO_FIXED,
      `system.${key} carried surrounding whitespace; it was trimmed.`);
  }
  if (trimmed === "" && blankToNull) {
    data[key] = null;
    pushIssue(issues, `${key}-blank-to-null`, SEVERITY_AUTO_FIXED,
      `system.${key} was an empty string; normalized to null (the field is nullable and blank ≡ absent).`);
    return;
  }
  if (uuidShape && trimmed !== "" && !/^[^.]+\.[^.]+$/.test(trimmed)) {
    pushIssue(issues, `${key}-uuid-shape`, SEVERITY_REVIEW,
      `system.${key} ("${trimmed}") does not look like a Foundry document UUID ("prefix.id"). The value was NOT modified and needs GM review.`);
  }
}

/**
 * Normalize the raw `system.*` payload of a `sw25Effect` document.
 *
 * Pure and idempotent: the input is never mutated; normalizing
 * already-normalized data changes nothing and reports no issues. Recoverable
 * problems are fixed losslessly ("auto-fixed"); ambiguous or irrecoverable
 * data is KEPT untouched and reported for GM review ("review") — the schema
 * validation will flag it on the next document load and the GM decides, per
 * DEC-41 (no silent discard or modification).
 *
 * @param {*} raw - The stored `system.*` value (plain object expected).
 * @returns {{data: object, issues: Array<{code: string, severity: string, detail: string}>,
 *   futureVersion: boolean, changed: boolean}}
 */
export function normalizeSw25EffectSystem(raw) {
  const issues = [];
  let futureVersion = false;

  if (raw === undefined || raw === null) {
    // Absent system data: the schema initial applies on load; nothing to
    // normalize, and no value may be invented for required fields (family).
    return { data: {}, issues, futureVersion, changed: false };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    pushIssue(issues, "system-invalid-type", SEVERITY_REVIEW,
      `The stored system data has an unsupported type (${Array.isArray(raw) ? "array" : typeof raw}). It was NOT modified; the schema validation will reject it and the GM decides how to recover it.`);
    return { data: structuredClone(raw), issues, futureVersion, changed: false };
  }

  const original = structuredClone(raw);
  const data = structuredClone(raw);

  // ── Schema version (DEC-41) ─────────────────────────────────────────────
  const storedVersion = Number(data.schemaVersion);
  const versionCoercible = Number.isFinite(storedVersion) && Number.isInteger(storedVersion);
  if (data.schemaVersion === undefined || data.schemaVersion === null || !versionCoercible) {
    data.schemaVersion = EFFECT_SCHEMA_VERSION;
    pushIssue(issues, "version-missing", SEVERITY_AUTO_FIXED,
      `The effect data had no valid schema version (${String(data.schemaVersion ?? "absent")}); it was backfilled to version ${EFFECT_SCHEMA_VERSION}.`);
  } else if (typeof data.schemaVersion !== "number") {
    // Coercible but not stored as a number (e.g. the string "1"): corrected.
    data.schemaVersion = storedVersion;
    pushIssue(issues, "version-type-corrected", SEVERITY_AUTO_FIXED,
      `The effect data declared schema version as ${typeof data.schemaVersion === "string" ? `the string "${data.schemaVersion}"` : "a non-number"}; corrected to the integer ${storedVersion}.`);
  } else if (storedVersion > EFFECT_SCHEMA_VERSION) {
    futureVersion = true;
    pushIssue(issues, "version-future", SEVERITY_REVIEW,
      `The effect data was written by a newer schema version (${storedVersion}); the running system supports version ${EFFECT_SCHEMA_VERSION}. The data was NOT modified and repair is refused to protect it from downgrades.`);
    // Future version: hands off entirely.
    return { data: structuredClone(raw), issues, futureVersion, changed: false };
  } else if (storedVersion < EFFECT_SCHEMA_VERSION) {
    // Sequential migration steps plug in here (DEC-41). With only v1 shipped
    // there is no inherited population below v1; older integers are treated
    // as missing versions and backfilled.
    data.schemaVersion = EFFECT_SCHEMA_VERSION;
    pushIssue(issues, "version-outdated", SEVERITY_AUTO_FIXED,
      `The effect data declared schema version ${storedVersion}; it was upgraded to version ${EFFECT_SCHEMA_VERSION}.`);
  }

  // ── Stacking identity ───────────────────────────────────────────────────
  if (typeof data.family === "string") {
    cleanStoredString(data, "family", issues);
    if (typeof data.family === "string" && data.family === "") {
      pushIssue(issues, "family-blank", SEVERITY_REVIEW,
        "system.family is blank; the family is the ONLY stacking identity (DEC-1) and no value can be invented for it. The value was NOT modified; the schema validation will reject it and the GM decides the correct family.");
    }
  } else if (data.family === undefined || data.family === null) {
    pushIssue(issues, "family-missing", SEVERITY_REVIEW,
      "system.family is absent; the family is the ONLY stacking identity (DEC-1) and no default exists for it. The schema validation will reject this effect until the GM assigns a family.");
  } else {
    pushIssue(issues, "family-unsupported-type", SEVERITY_REVIEW,
      `system.family has an unsupported type (${Array.isArray(data.family) ? "array" : typeof data.family}). The value was NOT modified and needs GM review.`);
  }
  coerceStoredInteger(data, "rank", issues, { min: 0, nullDefault: 0 });

  // ── Success Value (DEC-6) ───────────────────────────────────────────────
  coerceStoredInteger(data, "successValue", issues, { nullDefault: 0 });
  // T6.1/DEC-7: the Success Value provenance is the ONLY thing that decides
  // whether the stored number is an authoritative SV. Absent/null stays null
  // ("not recorded": forced removal re-determines the value at cancellation
  // time, CR I p. 167 — it is NEVER read as a 0 SV). An unknown id is KEPT
  // and reported, never silently reinterpreted (DEC-41).
  cleanStoredString(data, "successValueSource", issues, { blankToNull: true });
  if (typeof data.successValueSource === "string" && data.successValueSource !== ""
    && !SW25_SUCCESS_VALUE_SOURCES.includes(data.successValueSource)) {
    pushIssue(issues, "successValueSource-unknown", SEVERITY_REVIEW,
      `system.successValueSource ("${data.successValueSource}") is not an approved provenance id (${SW25_SUCCESS_VALUE_SOURCES.join(", ")}). The value was NOT modified and needs GM review.`);
  }

  // ── Casting instance identity and target scope (Bloque 6, T6.1) ────────
  // `castId` groups the representations of one casting; `effectScope` records
  // its target selection mode. Absent/null stays absent (legacy effects are
  // individual, ungrouped effects). Unknown scope ids are KEPT and reported.
  cleanStoredString(data, "castId", issues, { blankToNull: true });
  cleanStoredString(data, "effectScope", issues, { blankToNull: true });
  if (typeof data.effectScope === "string" && data.effectScope !== ""
    && !SW25_EFFECT_SCOPES.includes(data.effectScope)) {
    pushIssue(issues, "effectScope-unknown", SEVERITY_REVIEW,
      `system.effectScope ("${data.effectScope}") is not an approved scope id (${SW25_EFFECT_SCOPES.join(", ")}). The value was NOT modified and needs GM review.`);
  }

  // ── Duration bookkeeping (DEC-23) ──────────────────────────────────────
  // The duration counters accept FRACTIONAL finite values ≥ min since the
  // combat-end minutes conversion (rounds ÷ 6) writes them (e.g. 17 rounds →
  // 2.8333… minutes). Counted-scale integrality remains a service-level rule.
  coerceStoredInteger(data, "initialDuration", issues, { min: 0, allowFraction: true });
  coerceStoredInteger(data, "remainingDuration", issues, { min: 0, allowFraction: true });
  const initial = data.initialDuration;
  const remaining = data.remainingDuration;
  if (typeof initial === "number" && typeof remaining === "number" && remaining > initial) {
    pushIssue(issues, "duration-inconsistent", SEVERITY_REVIEW,
      `system.remainingDuration (${remaining}) is greater than system.initialDuration (${initial}). This is inconsistent for a single effect; the values were NOT modified and need GM review.`);
  }

  // ── Provenance ─────────────────────────────────────────────────────────
  cleanStoredString(data, "casterUUID", issues, { blankToNull: true, uuidShape: "document" });

  // ── Normative classification (DEC-9/DEC-10) ────────────────────────────
  cleanStoredString(data, "effectType", issues, { blankToNull: true });

  // ── Cancellation eligibility (DEC-7 / §55) ─────────────────────────────
  // `isMagical` is strictly boolean: true means confirmed magical; false means
  // non-magical or unconfirmed. Legacy absent/null values normalize to false.
  // Explicit booleans survive untouched. Other malformed types are KEPT and
  // reported for GM review, never silently coerced into either classification.
  if (data.isMagical === undefined) {
    data.isMagical = false;
    pushIssue(issues, "isMagical-missing-defaulted", SEVERITY_AUTO_FIXED,
      "system.isMagical was absent; normalized to false (non-magical or unconfirmed).");
  } else if (data.isMagical === null) {
    data.isMagical = false;
    pushIssue(issues, "isMagical-null-defaulted", SEVERITY_AUTO_FIXED,
      "system.isMagical was null; normalized to false (non-magical or unconfirmed).");
  } else if (typeof data.isMagical !== "boolean") {
    pushIssue(issues, "isMagical-unsupported-type", SEVERITY_REVIEW,
      `system.isMagical has an unsupported type (${Array.isArray(data.isMagical) ? "array" : typeof data.isMagical}); expected a boolean. The value was NOT modified and needs GM review.`);
  }
  // `resistance` keeps the emitting effect's notation as source provenance
  // (e.g. "cant"). It is NOT a cancellation-eligibility condition (T6.1:
  // `Resistance: Can't` does not prevent cancellation). Blank ≡ absent
  // (lossless); non-string values are kept and reported.
  cleanStoredString(data, "resistance", issues, { blankToNull: true });

  // ── Stacking policy family (Bloque 4, T4.4) ────────────────────────────
  // Not an identity field (DEC-1/16/44): it selects the central stacking
  // policy. Absent/null stays absent (the resolver treats it as "spell",
  // DEC-3); a blank string normalizes to null; an unknown policy id is KEPT
  // and reported: the resolver refuses to decide silently on unknown data.
  cleanStoredString(data, "familyPolicy", issues, { blankToNull: true });

  // ── Damage Type (DEC-9/DEC-20) ─────────────────────────────────────────
  if (data.damageType !== undefined && data.damageType !== null) {
    if (typeof data.damageType !== "object" || Array.isArray(data.damageType)) {
      pushIssue(issues, "damageType-unsupported-type", SEVERITY_REVIEW,
        `system.damageType has an unsupported type (${Array.isArray(data.damageType) ? "array" : typeof data.damageType}). The value was NOT modified and needs GM review.`);
    } else {
      const clone = structuredClone(data.damageType);
      cleanStoredString(clone, "nature", issues, { blankToNull: true });
      cleanStoredString(clone, "attribute", issues, { blankToNull: true });
      // Normalize unknown extra keys away only when nothing else reports them:
      // keep the approved two-key shape deterministically.
      const allowed = new Set(["nature", "attribute"]);
      const foreign = Object.keys(clone).filter(key => !allowed.has(key));
      if (foreign.length) {
        pushIssue(issues, "damageType-foreign-keys", SEVERITY_REVIEW,
          `system.damageType carries keys outside the approved shape (${foreign.join(", ")}). They were KEPT in place; the schema will drop them on the next document write.`);
      }
      const nature = Object.prototype.hasOwnProperty.call(clone, "nature") ? clone.nature : null;
      const attribute = Object.prototype.hasOwnProperty.call(clone, "attribute") ? clone.attribute : null;
      if (foreign.length) {
        // Foreign keys stay in place untouched (DEC-41: nothing silently
        // dropped); only trimming inside the approved keys may have applied.
        data.damageType = clone;
      } else if ((nature === null || nature === undefined) && (attribute === null || attribute === undefined)) {
        // An all-null damageType carries no data: normalize to null (lossless).
        data.damageType = null;
        pushIssue(issues, "damageType-empty-null", SEVERITY_AUTO_FIXED,
          "system.damageType had neither nature nor attribute; normalized to null (empty classification ≡ absent, DEC-9).");
      } else {
        data.damageType = { nature: nature ?? null, attribute: attribute ?? null };
      }
    }
  }

  // ── Duration scale (Bloque 5, T5.2) ─────────────────────────────────────
  // An approved scale id (effect-model.mjs SW25_DURATION_SCALES) or null.
  // Absent/null stays absent (legacy effects normalize losslessly; the scale
  // is NEVER auto-stamped from initialDuration — existing callers keep
  // working). An unknown id is KEPT and reported: no silent reinterpretation.
  cleanStoredString(data, "durationScale", issues, { blankToNull: true });
  if (typeof data.durationScale === "string" && data.durationScale !== ""
    && !SW25_DURATION_SCALES.includes(data.durationScale)) {
    pushIssue(issues, "durationScale-unknown", SEVERITY_REVIEW,
      `system.durationScale ("${data.durationScale}") is not an approved scale id (${SW25_DURATION_SCALES.join(", ")}). The value was NOT modified and needs GM review.`);
  }

  // ── Combat anchor (Bloque 5, T5.2; T5.0-R §3.3/§3.5) ────────────────────
  // Approved five-key shape { regime, edge, combatantId, tokenId, state }.
  // The anchor is a per-combatant identity: two tokens of the same Actor are
  // independent combatants. Consistency problems are KEPT and reported — the
  // anchor semantics are never guessed (DEC-41). A combat scale WITHOUT an
  // anchor is NOT flagged here: every legacy round-managed effect predates
  // the field (D4 validation happens at application time, in EffectService).
  if (data.durationAnchor !== undefined && data.durationAnchor !== null) {
    if (typeof data.durationAnchor !== "object" || Array.isArray(data.durationAnchor)) {
      pushIssue(issues, "durationAnchor-unsupported-type", SEVERITY_REVIEW,
        `system.durationAnchor has an unsupported type (${Array.isArray(data.durationAnchor) ? "array" : typeof data.durationAnchor}). The value was NOT modified and needs GM review.`);
    } else {
      const clone = structuredClone(data.durationAnchor);
      for (const key of ["regime", "edge", "state", "combatantId", "tokenId"]) {
        cleanStoredString(clone, key, issues, { blankToNull: true });
      }
      // Normalize unknown extra keys away only when nothing else reports them:
      // keep the approved five-key shape deterministically.
      const allowed = new Set(["regime", "edge", "state", "combatantId", "tokenId"]);
      const foreign = Object.keys(clone).filter(key => !allowed.has(key));
      if (foreign.length) {
        pushIssue(issues, "durationAnchor-foreign-keys", SEVERITY_REVIEW,
          `system.durationAnchor carries keys outside the approved shape (${foreign.join(", ")}). They were KEPT in place; the schema will drop them on the next document write.`);
      }
      const regime = Object.prototype.hasOwnProperty.call(clone, "regime") ? clone.regime : null;
      const edge = Object.prototype.hasOwnProperty.call(clone, "edge") ? clone.edge : null;
      const state = Object.prototype.hasOwnProperty.call(clone, "state") ? clone.state : null;
      const combatantId = Object.prototype.hasOwnProperty.call(clone, "combatantId") ? clone.combatantId : null;
      const tokenId = Object.prototype.hasOwnProperty.call(clone, "tokenId") ? clone.tokenId : null;
      if (foreign.length) {
        // Foreign keys stay in place untouched (DEC-41: nothing silently
        // dropped); only trimming inside the approved keys may have applied.
        data.durationAnchor = clone;
      } else if (regime === null && edge === null && state === null && combatantId === null && tokenId === null) {
        // An all-null anchor carries no data: normalize to null (lossless).
        data.durationAnchor = null;
        pushIssue(issues, "durationAnchor-empty-null", SEVERITY_AUTO_FIXED,
          "system.durationAnchor had no regime, edge, state or identity data; normalized to null (empty anchor ≡ absent).");
      } else {
        // Approved default edge (T5.0-R §3.1): an anchor with a known regime
        // but no edge reads as "begin". Backfilled deterministically.
        let resolvedEdge = edge;
        if (regime !== null && resolvedEdge === null && SW25_ANCHOR_REGIMES.includes(regime)) {
          resolvedEdge = "begin";
          pushIssue(issues, "durationAnchor-edge-defaulted", SEVERITY_AUTO_FIXED,
            `system.durationAnchor had no edge; the approved default ("begin") was applied.`);
        }
        // Consistency reviews (data kept, never guessed — DEC-41).
        if (regime === null) {
          pushIssue(issues, "durationAnchor-missing-regime", SEVERITY_REVIEW,
            "system.durationAnchor carries anchor data without a regime; the expiry semantics cannot be derived. The value was NOT modified and needs GM review.");
        } else if (!SW25_ANCHOR_REGIMES.includes(regime)) {
          pushIssue(issues, "durationAnchor-unknown-regime", SEVERITY_REVIEW,
            `system.durationAnchor.regime ("${regime}") is not an approved regime (${SW25_ANCHOR_REGIMES.join(", ")}). The value was NOT modified and needs GM review.`);
        }
        if (resolvedEdge !== null && !SW25_ANCHOR_EDGES.includes(resolvedEdge)) {
          pushIssue(issues, "durationAnchor-unknown-edge", SEVERITY_REVIEW,
            `system.durationAnchor.edge ("${resolvedEdge}") is not an approved edge (${SW25_ANCHOR_EDGES.join(", ")}). The value was NOT modified and needs GM review.`);
        }
        if (state !== null && !SW25_ANCHOR_STATES.includes(state)) {
          pushIssue(issues, "durationAnchor-unknown-state", SEVERITY_REVIEW,
            `system.durationAnchor.state ("${state}") is not an approved state (${SW25_ANCHOR_STATES.join(", ")}). The value was NOT modified and needs GM review.`);
        }
        if (state === "deferred" && combatantId !== null) {
          pushIssue(issues, "durationAnchor-deferred-with-combatant", SEVERITY_REVIEW,
            `system.durationAnchor is marked "deferred" but already carries a combatantId ("${combatantId}"); deferred anchors have no combatant yet (T5.0-R §3.5). The value was NOT modified and needs GM review.`);
        }
        if (state === "resolved" && combatantId === null && regime !== "roundEnd") {
          pushIssue(issues, "durationAnchor-resolved-without-combatant", SEVERITY_REVIEW,
            "system.durationAnchor is marked \"resolved\" but carries no combatantId; a resolved casterTurn/targetTurn anchor must identify its combatant (roundEnd needs no identity). The value was NOT modified and needs GM review.");
        }
        data.durationAnchor = {
          regime: regime ?? null,
          edge: resolvedEdge ?? null,
          combatantId: combatantId ?? null,
          tokenId: tokenId ?? null,
          state: state ?? null
        };
      }
    }
  }

  // ── Authored source duration identity (Phase 3 corrections) ────────────
  // Approved two-key shape { unit, amount }: the unit the duration was
  // AUTHORED in (e.g. "seconds") and its positive amount. Written only by
  // the Instant/X out-of-combat fallback; never inferred from display text.
  // Malformed shapes are KEPT and reported (DEC-41); the field carries no
  // countdown semantics of its own.
  if (data.sourceDuration !== undefined && data.sourceDuration !== null) {
    if (typeof data.sourceDuration !== "object" || Array.isArray(data.sourceDuration)) {
      pushIssue(issues, "sourceDuration-unsupported-type", SEVERITY_REVIEW,
        `system.sourceDuration has an unsupported type (${Array.isArray(data.sourceDuration) ? "array" : typeof data.sourceDuration}). The value was NOT modified and needs GM review.`);
    } else {
      const clone = structuredClone(data.sourceDuration);
      cleanStoredString(clone, "unit", issues, { blankToNull: true });
      coerceStoredInteger(clone, "amount", issues, { min: 0, allowFraction: true });
      const allowed = new Set(["unit", "amount"]);
      const foreign = Object.keys(clone).filter(key => !allowed.has(key));
      if (foreign.length) {
        pushIssue(issues, "sourceDuration-foreign-keys", SEVERITY_REVIEW,
          `system.sourceDuration carries keys outside the approved shape (${foreign.join(", ")}). They were KEPT in place; the schema will drop them on the next document write.`);
      }
      const unit = Object.prototype.hasOwnProperty.call(clone, "unit") ? clone.unit : null;
      const amount = Object.prototype.hasOwnProperty.call(clone, "amount") ? clone.amount : null;
      if (foreign.length) {
        // Foreign keys stay in place untouched (DEC-41: nothing silently
        // dropped); only trimming inside the approved keys may have applied.
        data.sourceDuration = clone;
      } else if (unit === null && amount === null) {
        // An all-null sourceDuration carries no data: normalize to null.
        data.sourceDuration = null;
        pushIssue(issues, "sourceDuration-empty-null", SEVERITY_AUTO_FIXED,
          "system.sourceDuration had neither unit nor amount; normalized to null (empty identity ≡ absent).");
      } else {
        if (unit === null) {
          pushIssue(issues, "sourceDuration-missing-unit", SEVERITY_REVIEW,
            "system.sourceDuration carries an amount without a unit; the authored identity cannot be derived. The value was NOT modified and needs GM review.");
        }
        if (amount === null || amount <= 0) {
          pushIssue(issues, "sourceDuration-invalid-amount", SEVERITY_REVIEW,
            `system.sourceDuration.amount (${amount ?? "absent"}) is not a positive number. The value was NOT modified and needs GM review.`);
        }
        data.sourceDuration = { unit: unit ?? null, amount: amount ?? null };
      }
    }
  }

  // ── Presentation visibility (gmOnly) ────────────────────────────────────
  // Boolean presentation flag. Absent reads as `false` through the schema
  // initial (backward compatible: effects written before the field existed
  // keep their ordinary visibility). An explicit null is dropped (null ≡
  // absent for a non-nullable boolean with a default — lossless); anything
  // that is not a boolean is KEPT and reported, never coerced (DEC-41).
  if (data.gmOnly === undefined) {
    // Absent: the schema initial applies; nothing to normalize.
  } else if (data.gmOnly === null) {
    delete data.gmOnly;
    pushIssue(issues, "gmOnly-null-dropped", SEVERITY_AUTO_FIXED,
      "system.gmOnly was null; normalized to absent (null ≡ absent for the boolean visibility flag; the schema initial `false` applies).");
  } else if (typeof data.gmOnly !== "boolean") {
    pushIssue(issues, "gmOnly-unsupported-type", SEVERITY_REVIEW,
      `system.gmOnly has an unsupported type (${Array.isArray(data.gmOnly) ? "array" : typeof data.gmOnly}); expected a boolean. The value was NOT modified and needs GM review.`);
  }

  // ── Configured rule elements (`system.rules`) ───────────────────────────
  // Additive optional array (schema stays v1, DEC-41). Absent stays absent (the
  // schema initial `[]` applies); an explicit null is dropped as lossless
  // (null ≡ absent for a non-nullable array with a default); a non-array is
  // KEPT and reported. Entries are canonicalized by the rule-element registry;
  // entries the registry cannot interpret are KEPT untouched and reported —
  // never silently discarded or reinterpreted (DEC-41).
  if (data.rules === undefined) {
    // Absent: the schema initial applies; nothing to normalize.
  } else if (data.rules === null) {
    delete data.rules;
    pushIssue(issues, "rules-null-dropped", SEVERITY_AUTO_FIXED,
      "system.rules was null; normalized to absent (null ≡ absent for the array field; the schema initial `[]` applies).");
  } else if (!Array.isArray(data.rules)) {
    pushIssue(issues, "rules-not-array", SEVERITY_REVIEW,
      `system.rules has an unsupported type (${typeof data.rules}); expected an array of rule element objects. The value was NOT modified and needs GM review.`);
  } else {
    const repaired = repairSw25RuleElements(data.rules);
    data.rules = repaired.rules;
    for (const issue of repaired.issues) {
      pushIssue(issues, issue.code, SEVERITY_REVIEW, issue.detail);
    }
  }

  // ── Native changes field: only restored/reported, never restructured ────
  if (data.changes === undefined || data.changes === null) {
    // The native schema materializes an empty array on load/create; a stored
    // payload without it is invalid, so the approved default is applied.
    data.changes = [];
    pushIssue(issues, "changes-defaulted", SEVERITY_AUTO_FIXED,
      "system.changes was absent (or null); the native schema default (an empty array) was applied. No change data existed to preserve.");
  } else if (!Array.isArray(data.changes)) {
    pushIssue(issues, "changes-not-array", SEVERITY_REVIEW,
      `system.changes has an unsupported type (${typeof data.changes}). The native changes structure is NOT repaired by this module; the schema validation will reject it and the GM decides.`);
  }

  // ── Fields outside the approved v1 schema ──────────────────────────────
  const unknownKeys = Object.keys(data).filter(key => !SCHEMA_V1_KEYS.has(key));
  if (unknownKeys.length) {
    pushIssue(issues, "unknown-fields", SEVERITY_REVIEW,
      `system carries fields outside schema v1 (${unknownKeys.join(", ")}). They were KEPT in place; the schema will drop them on the next document write, so recover any intended data first.`);
  }

  const changed = JSON.stringify(original) !== JSON.stringify(data);
  return { data, issues, futureVersion, changed };
}

/**
 * Run the sequential migration chain over an effect `system.*` payload
 * (DEC-41): normalize (which backfills the version), then apply one
 * registered step per version until reaching the current version.
 * Deterministic and idempotent; with no registered steps (schema v1) this
 * is exactly `normalizeSw25EffectSystem`.
 *
 * @param {*} raw - The stored `system.*` value.
 * @returns {{data: object, issues: Array, futureVersion: boolean, migrated: boolean}}
 */
export function migrateSw25EffectSystem(raw) {
  const result = normalizeSw25EffectSystem(raw);
  const { data, issues, futureVersion } = result;
  if (futureVersion) return { ...result, migrated: false };

  let migrated = false;
  let guard = 0;
  while (data.schemaVersion < EFFECT_SCHEMA_VERSION && guard++ <= EFFECT_MIGRATION_STEPS.length + 1) {
    const step = EFFECT_MIGRATION_STEPS.find(candidate => candidate.from === data.schemaVersion);
    if (!step) {
      pushIssue(issues, "migration-gap", SEVERITY_REVIEW,
        `No migration step is registered from schema version ${data.schemaVersion}; the data was left at that version and needs GM review.`);
      break;
    }
    step.migrate(data, issues);
    data.schemaVersion = step.to;
    migrated = true;
  }
  return { ...result, migrated };
}

// ── GM-authoritative repair layer ───────────────────────────────────────────

/**
 * Report issues to the GM through Foundry notifications. Review issues are
 * warnings (irrecoverable/ambiguous data: the GM must decide); auto-fixed
 * issues are collapsed into one info message. Silent in headless harnesses
 * (no `ui` global): the returned report still carries every issue.
 * @param {string} effectName
 * @param {Array<{code: string, severity: string, detail: string}>} issues
 */
function notifyIssues(effectName, issues) {
  const notifications = globalThis.ui?.notifications;
  if (!notifications) return;
  const reviews = issues.filter(issue => issue.severity === SEVERITY_REVIEW);
  const autoFixed = issues.filter(issue => issue.severity === SEVERITY_AUTO_FIXED);
  for (const issue of reviews) {
    notifications.warn(`Sword World 2.5 | Effect "${effectName}" needs review: ${issue.detail}`);
  }
  if (autoFixed.length) {
    notifications.info(`Sword World 2.5 | Effect "${effectName}" was normalized (${autoFixed.length} lossless fix${autoFixed.length === 1 ? "" : "es"}).`);
  }
}

/**
 * Normalize and repair one ActiveEffect document (GM-only).
 *
 * Reads the document's underlying source data, normalizes the `system.*`
 * payload and, when the normalization changed something, writes it back
 * through the delegated EffectService repair write (DEC-36 single-writer).
 * Irrecoverable data is never written: it stays in
 * the document untouched and is reported to the GM. Idempotent: repairing an
 * already-normalized effect performs NO write.
 *
 * @param {ActiveEffect} effect - The effect document to repair.
 * @returns {Promise<{ok: boolean, code: string, changed?: boolean,
 *   issues?: Array, futureVersion?: boolean, error?: string}>}
 */
export async function repairSw25Effect(effect) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can repair effect data." };
  }
  if (!effect) {
    return { ok: false, code: "no-effect", error: "No effect was given to repair." };
  }

  const source = typeof effect.toObject === "function" ? effect.toObject() : effect.system ?? {};
  const raw = source?.system ?? source;
  const { data, issues, futureVersion, changed } = normalizeSw25EffectSystem(raw);

  notifyIssues(effect.name ?? effect.id ?? "?", issues);

  if (futureVersion) {
    return { ok: false, code: "version-too-new", futureVersion, issues, error: "The effect was written by a newer schema version; repair is refused until the system is updated." };
  }
  if (!changed) {
    return { ok: true, code: "no-changes", changed: false, issues };
  }
  // Write only the individual fields that changed, as flattened `system.*`
  // paths: a whole-system update payload would trigger full-schema validation
  // (partial: false) and fail when optional fields are absent. Foreign fields
  // are never written back: they are reported for review and left to the
  // schema's own pruning on the next legitimate write.
  const updateData = {};
  for (const key of Object.keys(data)) {
    if (!SCHEMA_V1_KEYS.has(key)) continue;
    if (JSON.stringify(raw[key]) !== JSON.stringify(data[key])) {
      updateData[`system.${key}`] = data[key];
    }
  }
  try {
    // The write is executed by EffectService inside its authorization window
    // (DEC-36): the repair layer plans the update, the service writes it.
    const write = await performSw25EffectRepairWrite(effect, updateData);
    if (!write.ok) {
      return { ok: false, code: write.code, changed: false, issues, error: write.error };
    }
  } catch (error) {
    return { ok: false, code: "update-failed", changed: false, issues, error: String(error?.message ?? error) };
  }
  return { ok: true, code: "repaired", changed: true, updateData, issues };
}

/**
 * Repair every effect of one actor (GM-only). Embedded effects are repaired
 * individually; the per-effect results are aggregated.
 * @param {Actor} actor - The actor whose effects are repaired.
 * @returns {Promise<{ok: boolean, results: Array, repaired: number, refused: number}>}
 */
export async function repairActorEffects(actor) {
  if (game?.user?.isGM !== true) {
    return { ok: false, results: [], repaired: 0, refused: 0 };
  }
  if (!actor?.effects) {
    return { ok: false, results: [], repaired: 0, refused: 0 };
  }
  const results = [];
  for (const effect of actor.effects) {
    results.push({ effectId: effect.id, effectName: effect.name ?? null, ...(await repairSw25Effect(effect)) });
  }
  return {
    ok: results.every(result => result.ok),
    results,
    repaired: results.filter(result => result.code === "repaired").length,
    refused: results.filter(result => !result.ok).length
  };
}
