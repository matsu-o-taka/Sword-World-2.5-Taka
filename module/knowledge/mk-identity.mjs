// Sword World 2.5 - Monster Knowledge species identity (pure logic).
//
// Single authoritative implementation of the species identity used by the
// Monster Knowledge Registry (`monster-knowledge-registry.mjs`,
// `monster-knowledge-store.mjs`) and, through re-exports, by the Monster
// Knowledge roll module. The identity is stable per SPECIES (system.species),
// so every Actor of the same species shares its discoveries regardless of
// name, sourceUrl or token scope.
//
// History: this logic previously lived in module/combat/monster-knowledge.mjs
// and was ALSO duplicated in module/combat/concealed-main-section.mjs. This
// module is the F1 consolidation point for registry consumers; repointing
// concealed-main-section to it is deferred (documented in the F1 report,
// out of F1 scope).
//
// The functions are deliberately pure (no Foundry globals) so they can be
// exercised by headless tests.

/**
 * Normalize a species identifier to its stable canonical form
 * (NFC unicode normalization, whitespace collapsed, lowercase).
 * Empty/missing values normalize to null.
 * @param {string|null|undefined} value - Raw species text (e.g. system.species).
 * @returns {string|null} The normalized species id, or null when absent.
 */
export function normalizeSpeciesId(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.normalize("NFC").replace(/\s+/g, " ").toLowerCase();
}

/**
 * Resolve the species id of an Actor-like document from its `system.species`.
 * @param {object|null} actor - Any Actor-like document.
 * @returns {string|null} The normalized species id, or null when the actor has
 *   no species data.
 */
export function speciesId(actor) {
  if (!actor || !actor.system) return null;
  const species = actor.system?.species;
  if (!species) return null;
  return normalizeSpeciesId(species);
}
