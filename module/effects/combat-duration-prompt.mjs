// Sword World 2.5 - combat-entry duration prompt (Phase 3, U5).
//
// When combat starts, the unified NON-COMBAT time counter (minutes / hours /
// days) has to become combat tracking. Outside combat there is no wall clock,
// so the elapsed time of a pre-existing effect cannot be established: the
// system NEVER silently assumes the original duration is still fully
// available (2026-11-23 unification directive). This module asks, once, for
// every candidate effect whether it is still active; the answers drive
// `enterSw25CombatDurationEffects`.
//
// It is UI-only glue, mirroring stacking-choice-dialog.mjs:
//   - all rule logic, conversion, anchor resolution and every document write
//     live in EffectService (`enterSw25CombatDurationEffects`, DEC-36);
//   - DialogV2.wait is used for a single minimal modal with per-effect
//     checkboxes (default: still active), because it holds no state and its
//     resolved value maps directly onto the decision contract;
//   - a dismissed window leaves EVERY effect undecided (untouched), never
//     removed and never converted.
//
// Verified against foundry-api-docs/official-v14 (DialogV2 class,
// DialogV2Configuration, DialogV2Button and DialogV2ButtonCallback: the
// button callback receives (event, button, dialog)) per AGENTS.md.
//
// Headless safety: without DialogV2 the prompt reports that it cannot ask and
// every candidate stays undecided; no exception reaches the combat lifecycle.

import { collectSw25CombatEntryCandidates, enterSw25CombatDurationEffects } from "./effect-service.mjs";
import { formatSw25DurationValue, formatSw25NaturalDuration } from "./effects-tab.mjs";

const escape = value => (typeof foundry?.utils?.escapeHtml === "function"
  ? foundry.utils.escapeHtml(String(value))
  : String(value));

/** Stable identity of one candidate across the prompt and the decision map. */
function candidateKey(actor, effect) {
  return `${actor?.id ?? actor?.uuid ?? "?"}::${effect?.id ?? "?"}`;
}

/**
 * Build the prompt rows for the combat-entry candidates of one encounter
 * (read-only): one row per participant effect on the unified time counter
 * with a finite remaining amount. The rows carry the actor/effect identity,
 * the display label and the effect's stored remaining amount.
 *
 * @param {Combat} combat - The starting encounter.
 * @returns {Array<{key: string, actorId: string, effectId: string,
 *   actorName: string, name: string, remaining: number,
 *   remainingLabel: string}>}
 */
export function buildSw25CombatEntryPromptRows(combat) {
  const { candidates } = collectSw25CombatEntryCandidates(combat);
  return candidates.map(({ actor, effect }) => {
    // Seconds-based candidates (Phase 3 corrections): the row shows the
    // authored seconds — the value whose /10 equivalent rounds the user is
    // confirming. No compound reformulation: seconds are their own unit.
    const source = effect.system?.sourceDuration;
    if (effect.system?.durationScale !== "minutes" && source?.unit === "seconds") {
      const amount = source.amount;
      return {
        key: candidateKey(actor, effect),
        actorId: actor.id ?? null,
        effectId: effect.id ?? null,
        actorName: actor.name ?? "—",
        name: effect.name ?? "—",
        remaining: amount,
        remainingLabel: `${formatSw25DurationValue(amount)} second${amount === 1 ? "" : "s"}`
      };
    }
    const scale = effect.system?.durationScale ?? "minutes";
    const remaining = effect.system.remainingDuration;
    return {
      key: candidateKey(actor, effect),
      actorId: actor.id ?? null,
      effectId: effect.id ?? null,
      actorName: actor.name ?? "—",
      name: effect.name ?? "—",
      remaining,
      // Compound natural display ("1 hour and 30 minutes"); legacy inexact
      // counters keep the raw unit form.
      remainingLabel: formatSw25NaturalDuration(scale, remaining)
    };
  });
}

/**
 * Map the checked prompt rows onto the decision contract used by
 * `enterSw25CombatDurationEffects`: `true` (still active → threshold on its
 * remaining) for checked effects, `false` (expired → removed) for unchecked
 * ones. A row that is not present in the checked set is unchecked.
 *
 * @param {Array<{key: string}>} rows - Rows from
 *   `buildSw25CombatEntryPromptRows`.
 * @param {Iterable<string>} checkedKeys - Keys the user kept checked.
 * @returns {(actor: object, effect: object) => boolean}
 */
export function buildSw25CombatEntryDecisionMap(rows, checkedKeys) {
  const checked = new Set(checkedKeys ?? []);
  const byKey = new Map(rows.map(row => [row.key, checked.has(row.key)]));
  return (actor, effect) => byKey.get(candidateKey(actor, effect)) === true;
}

/**
 * Present the combat-entry window and collect one decision per candidate.
 *
 * The window lists every candidate effect with a checkbox that is checked by
 * default ("still active"). Confirming applies the checkboxes; dismissing or
 * cancelling the window leaves every effect UNDECIDED (untouched), which the
 * service records as `undecided` — never a silent conversion or removal.
 *
 * @param {Combat} combat - The starting encounter.
 * @param {object} [options]
 * @param {object|null} [options.dialog] - DialogV2-compatible API (defaults
 *   to foundry.applications.api.DialogV2); injectable for tests.
 * @returns {Promise<{rows: Array, decide: Function}|null>} `null` when there is
 *   nothing to ask (no candidate effect).
 */
export async function promptSw25CombatEntryDecisions(combat, { dialog = null } = {}) {
  const rows = buildSw25CombatEntryPromptRows(combat);
  if (!rows.length) return null;

  const api = dialog ?? foundry?.applications?.api?.DialogV2;
  if (typeof api?.wait !== "function") {
    // No window available (headless context): ask nothing and decide nothing.
    console.warn("[SW25 Combat Duration] DialogV2 is unavailable; pre-existing duration effects stay undecided.");
    return { rows, decide: () => null };
  }

  const body = rows.map(row => `<tr>
    <td><input type="checkbox" data-effect-key="${escape(row.key)}" checked></td>
    <td>${escape(row.actorName)}</td>
    <td>${escape(row.name)}</td>
    <td>${escape(row.remainingLabel)}</td>
  </tr>`).join("");
  const content = `
<p class="sw25-combat-duration-intro">Combat is starting. Outside combat the elapsed time of these effects cannot be established, so please confirm which are still active. Unchecked effects are removed; checked effects under 10 minutes enter round-based tracking.</p>
<table class="sw25-combat-duration-table">
  <thead><tr><th>Still active</th><th>Actor</th><th>Effect</th><th>Remaining</th></tr></thead>
  <tbody>${body}</tbody>
</table>`;

  const answer = await api.wait({
    window: { title: "Sword World 2.5 | Effects entering combat" },
    content,
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "leave-undecided",
        label: "Leave undecided",
        callback: () => null
      },
      {
        action: "confirm",
        label: "Confirm",
        default: true,
        callback: (event, button, application) => {
          const checked = [];
          for (const input of application?.element?.querySelectorAll?.("input[data-effect-key]") ?? []) {
            if (input.checked) checked.push(input.dataset.effectKey);
          }
          return checked;
        }
      }
    ]
  });

  // Dismissal (rejectClose: false) or the explicit "Leave undecided" button
  // resolves to null/undefined: every candidate stays untouched.
  if (!Array.isArray(answer)) return { rows, decide: () => null };
  return { rows, decide: buildSw25CombatEntryDecisionMap(rows, answer) };
}

/**
 * `combatStart` handler: ask about the participants' pre-existing time
 * counters and hand the answers to EffectService.
 *
 * GM-gated: only the GM client writes (the startCombat hook fires on the
 * initiating client; players keep the read-only view). Returns the service
 * result, or null when this client must not act or there is nothing to ask.
 *
 * @param {Combat} combat - The starting encounter.
 * @param {object} [options] - Forwarded to `promptSw25CombatEntryDecisions`
 *   (dialog injection for tests).
 * @returns {Promise<object|null>} The `enterSw25CombatDurationEffects` result.
 */
export async function handleSw25CombatStart(combat, options = {}) {
  if (game?.user?.isGM !== true) return null;
  const prompt = await promptSw25CombatEntryDecisions(combat, options);
  if (!prompt) return null;
  return enterSw25CombatDurationEffects(combat, { decide: prompt.decide });
}
