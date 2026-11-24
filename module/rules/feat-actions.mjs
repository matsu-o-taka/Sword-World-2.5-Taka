// Sword World 2.5 - executable Combat Feat dispatch (T6.3).
//
// Identification is separate (rules/feat-action-registry.mjs). This module maps
// a registered action id to its executor. Executors delegate to the existing
// production implementations; they never reimplement feat rules here.
//
// The sheet calls `executeFeatAction({ item, actor, targets })` from the feat
// row's contextual button. Unknown feats never reach this module (they render
// no button), and an unregistered id returns a typed refusal instead of
// guessing.

import { featActionId } from "./feat-action-registry.mjs";
import { activateWordbreak } from "./wordbreak.mjs";

/**
 * Production executors, keyed by action id.
 *
 * Each executor receives the contextual payload (actor, selected targets, …)
 * and returns the implementation's own result. Wordbreak delegates entirely to
 * `activateWordbreak` (T6.2): no cancellation logic is duplicated here.
 *
 * @type {Readonly<Record<string, (context: object) => Promise<object>>>}
 */
export const SW25_FEAT_ACTION_EXECUTORS = Object.freeze({
  wordbreak: context => activateWordbreak(context)
});

/**
 * Execute a feat's registered mechanical action.
 *
 * @param {object} input
 * @param {object} [input.item] - The feat Item (used to resolve the action id).
 * @param {string} [input.actionId] - Explicit action id (overrides the Item).
 * @param {object} [input.actor] - Owning Actor.
 * @param {Iterable<object>} [input.targets] - Selected canvas targets.
 * @param {object} [options]
 * @param {Record<string, Function>} [options.executors] - Executor map (tests).
 * @returns {Promise<object>} The executor result, or a typed refusal.
 */
export async function executeFeatAction({ item, actionId, ...context } = {}, { executors = SW25_FEAT_ACTION_EXECUTORS } = {}) {
  const resolved = actionId ?? featActionId(item);
  const executor = resolved ? executors[resolved] : null;
  if (typeof executor !== "function") {
    return { ok: false, code: "unsupported-feat-action", actionId: resolved ?? null };
  }
  return executor(context);
}
