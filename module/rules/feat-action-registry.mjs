// Sword World 2.5 - executable Combat Feat identification (T6.3).
//
// This module answers ONE question: which mechanical action, if any, is
// registered for a given feat Item? It contains IDENTIFIERS ONLY. It never
// stores, quotes or reproduces feat rules text, descriptions, prerequisites or
// any other protected content: Combat Feats remain external content.
//
// Identification is deliberately independent of the displayed name, the
// summary/description and the interface language. The stable Item identifier
// used here is `system.sourceUrl`, which the importer preserves from the
// source page (e.g. `.../feat:wordbreak`). A feat that is renamed or translated
// keeps its action; a feat whose name merely resembles a supported one does
// NOT gain an action.
//
// Execution lives elsewhere (rules/feat-actions.mjs); adding a new executable
// feat means adding one registry entry plus its executor, without touching the
// sheet or the template.

/**
 * Registered executable Combat Feats, keyed by the canonical source slug.
 *
 * Each entry is a stable identifier only. `actionId` is what the sheet and the
 * dispatcher use; `sourceSlug` is the suffix of `system.sourceUrl` after
 * `feat:`. Do not add descriptions or rules text here.
 *
 * @type {Readonly<Record<string, {actionId: string, sourceSlug: string}>>}
 */
export const SW25_FEAT_ACTION_REGISTRY = Object.freeze({
  wordbreak: Object.freeze({ actionId: "wordbreak", sourceSlug: "wordbreak" })
});

/**
 * Canonical slug of a feat source URL. Accepts the imported wiki forms
 * (`http://sw25.wikidot.com/feat:wordbreak`, `feat:wordbreak`, with optional
 * trailing slash, query string or fragment). Anything else yields "".
 *
 * @param {string} sourceUrl - `Item.system.sourceUrl`.
 * @returns {string} Lowercase slug, or "" when the URL has no feat slug.
 */
export function featSourceSlug(sourceUrl) {
  const text = String(sourceUrl ?? "").trim();
  if (!text) return "";
  const cleaned = text.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const match = cleaned.match(/(?:^|[:/])feat:([a-z0-9][a-z0-9-]*)$/i);
  return match ? match[1].toLowerCase() : "";
}

/**
 * The registered action id for a feat Item, or null when the feat has no
 * implemented mechanical action.
 *
 * Only `type === "feat"` Items are considered. The displayed name, summary,
 * description and `rawText` are never inspected, so renaming or translating a
 * feat does not change its behaviour.
 *
 * @param {object} item - Item document.
 * @returns {string|null}
 */
export function featActionId(item) {
  if (item?.type !== "feat") return null;
  const slug = featSourceSlug(item?.system?.sourceUrl);
  if (!slug) return null;
  const entry = SW25_FEAT_ACTION_REGISTRY[slug];
  return entry ? entry.actionId : null;
}

/**
 * Whether a feat Item has an implemented mechanical action.
 * @param {object} item - Item document.
 * @returns {boolean}
 */
export function hasFeatAction(item) {
  return featActionId(item) !== null;
}
