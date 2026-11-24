// Sword World 2.5 - effect family identity and canonical name (T1.4).
//
// Pure, Foundry-free helpers for the effect stacking identity (DEC-1) and
// the canonical display name (DEC-16/DEC-49). No Foundry API is used: the
// module runs identically headless (test suites) and inside the client. Its
// single import is rules/spell-data.mjs (shared `canonicalSpellName`), which
// is itself dependency-free and Foundry-free, so no cycle exists.
//
// Separation of responsibilities (DEC-1/DEC-16/DEC-49):
//   - `family` (persisted `system.family`) is the ONLY stacking identity: the
//     family's canonical base name as authored, e.g. "Protection", without any
//     rank numeral. Leading ⏩/△ action markers are authoring metadata and are
//     stripped for the comparison key (they are never part of the identity);
//     the persisted spelling keeps whatever the creation path stored.
//     Comparison never uses the stored spelling directly: the
//     stable rule key is DERIVED at comparison time by
//     `normalizeSw25FamilyKey` and is never persisted (DEC-49 forbids a
//     duplicated `canonicalName`, `familyKey` or `stackKey` field).
//   - `rank` (persisted `system.rank`) is the version hierarchy label; it is
//     NEVER part of the family identity (DEC-16: two applications of the same
//     family belong to the same stacking family even with different ranks).
//   - `buildSw25CanonicalName` reconstructs the canonical name
//     ("Protection II") purely for presentation, from the persisted
//     family + rank. It is never stored.
//
// The identity normalization approved in DEC-1 is: lowercase / NFKD / no
// diacritics. Surrounding whitespace is also ignored for the comparison key
// (repair already trims persisted strings; trimming the key makes identity
// insensitive to leftover padding). Nothing beyond that: case of the stored
// family and its diacritics are presentation data and are preserved in
// persistence; only the derived comparison key loses them.

import { canonicalSpellName } from "../rules/spell-data.mjs";

/** Approved rank → Roman numeral table (DEC-16): ranks 1..10 only. */
const RANK_TO_ROMAN = new Map([
  [1, "I"], [2, "II"], [3, "III"], [4, "IV"], [5, "V"],
  [6, "VI"], [7, "VII"], [8, "VIII"], [9, "IX"], [10, "X"]
]);

/**
 * Derive the stable stacking-identity key of a family (DEC-1).
 *
 * Pure and deterministic: the input value is never modified (strings are
 * immutable), the result is a fresh string, and normalizing an
 * already-normalized key returns it unchanged. The approved normalization is:
 * leading ⏩/△ action-marker metadata stripped (Phase 2, via the shared
 * `canonicalSpellName` — the markers are never part of a spell's identity,
 * so a markered and a clean family name share ONE key) / lowercase / NFKD /
 * no diacritics; surrounding whitespace is ignored.
 *
 * `†`/`‡` are NOT action markers and stay in the key.
 *
 * Non-string inputs return null (identity can never be invented from invalid
 * data); a blank string normalizes to "" (an empty key that the schema's
 * `blank: false` validation already rejects at the data layer).
 *
 * @param {*} family - The stored `system.family` value.
 * @returns {string|null} The comparison key, or null for non-string input.
 */
export function normalizeSw25FamilyKey(family) {
  if (typeof family !== "string") return null;
  return canonicalSpellName(family).name
    .trim()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/**
 * Roman numeral of an approved rank value (DEC-16 table, ranks 1..10).
 *
 * Centralized and reusable: every subsystem must render visible names through
 * this function instead of duplicating conversions. Ranks outside the
 * approved table return null (0 means "no rank"; values above 10 are NOT
 * covered by the approved decision and no numeral is invented for them).
 *
 * @param {*} rank - The stored `system.rank` value.
 * @returns {string|null} "I".."X", or null when the rank has no approved numeral.
 */
export function sw25RankToRoman(rank) {
  if (typeof rank !== "number" || !Number.isInteger(rank)) return null;
  return RANK_TO_ROMAN.get(rank) ?? null;
}

/**
 * Reconstruct the canonical name of an effect from its persisted
 * `family` + `rank` (DEC-16/DEC-49). Presentation only: the result is never
 * stored and the inputs are never modified.
 *
 * Rules (DEC-16): rank 0 (no rank) shows the family alone; ranks 1..10 append
 * the approved Roman numeral. Anything that cannot be reconstructed from the
 * persisted data returns null — invalid or absent data never produces an
 * invented name, and no silent correction is applied (DEC-41).
 *
 * Presentation details: surrounding whitespace of the family is trimmed for
 * display only (the persisted value is untouched — data-layer trimming is
 * repair's job); the authored case and diacritics are preserved, since only
 * the comparison key (DEC-1) loses them.
 *
 * @param {*} family - The stored `system.family` value.
 * @param {*} rank - The stored `system.rank` value.
 * @returns {string|null} e.g. "Protection II", "Power Strike", or null.
 */
export function buildSw25CanonicalName(family, rank) {
  if (typeof family !== "string" || family.trim() === "") return null;
  if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 0 || rank > 10) return null;
  if (rank === 0) return family.trim();
  return `${family.trim()} ${RANK_TO_ROMAN.get(rank)}`;
}
