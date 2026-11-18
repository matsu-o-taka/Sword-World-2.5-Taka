/**
 * Resolve a natural 2d6 total against the supplied item's local Power Table.
 *
 * Power tables are persisted on each Item as `system.powerTable`, keyed by
 * natural totals 3–12. Missing entries retain the existing runtime fallback
 * of zero. This deliberately does not consult `system.power` or the catalog:
 * custom tables are valid even when an Item has no Power value.
 *
 * @param {object} item - Item-like object with `system.powerTable`.
 * @param {number} diceTotal - Natural 2d6 total.
 * @returns {{lookup: number, result: number}}
 */
export function resolvePowerTableResult(item, diceTotal) {
  const lookup = Math.min(12, Math.max(3, Number(diceTotal) || 0));
  const result = Number(item?.system?.powerTable?.[String(lookup)] ?? 0);
  return { lookup, result };
}
