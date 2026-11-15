// Sword World 2.5 - stacking choice dialog (Bloque 4, T4.3).
//
// Minimal reusable DEC-22 window: when the stacking rules give the target a
// decision (DEC-3), this dialog shows BOTH applications complete — name,
// Success Value, damage type, round duration, policy family and the native
// change bonuses — and lets the user choose which to keep. It is UI-only glue:
// all rule logic lives in the central stacking resolver and EffectService;
// the persistent writes still go exclusively through EffectService with GM
// authority (DEC-22 last paragraph / DEC-36).
//
// DialogV2 (foundry.applications.api.DialogV2.wait) was chosen over a full
// ApplicationV2 subclass because this is a minimal modal choice with two
// buttons and no state of its own: the official v14 `wait` static resolves to
// the chosen button's callback value (or null when dismissed with
// rejectClose: false), which maps directly onto the decision contract.
// Verified against foundry-api-docs/official-v14 (DialogV2 class +
// DialogV2Configuration + DialogV2Button interfaces) per AGENTS.md.
//
// Headless safety: `decideSw25StackingChoice` throws when DialogV2 is not
// available; EffectService turns that into an explicit `decision-failed`
// outcome with no writes. Nothing here touches Foundry documents.

/**
 * Build the HTML of one comparison row for the DEC-22 window.
 * @param {object} entry - A described effect/application (see the resolver's
 *   choice data: name, family, rank, successValue, remainingDuration,
 *   familyPolicy, damageType).
 * @returns {string} An HTML table row.
 */
function buildChoiceRow(entry) {
  const escape = value => foundry?.utils?.escapeHtml
    ? foundry.utils.escapeHtml(String(value))
    : String(value);
  const name = escape(entry?.name ?? "?");
  const sv = String(entry?.successValue ?? 0);
  const rank = entry?.rank > 0 ? escape(String(entry.rank)) : "—";
  const duration = entry?.remainingDuration !== null && entry?.remainingDuration !== undefined
    ? `${escape(String(entry.remainingDuration))} rounds`
    : "GM-managed";
  const policy = escape(entry?.familyPolicy ?? "spell");
  const damage = entry?.damageType
    ? escape([entry.damageType.nature, entry.damageType.attribute].filter(Boolean).join(" / "))
    : "—";
  return `<tr><td>${name}</td><td>${sv}</td><td>${rank}</td><td>${duration}</td><td>${policy}</td><td>${damage}</td>`;
}

/**
 * Present the DEC-22 stacking choice window and collect the decision.
 *
 * Resolves to `true` when the user accepts the NEW application (the previous
 * one is replaced) and to `false` when the user keeps the previous one (the
 * new application is discarded whole). Dismissing the dialog conserves the
 * previous effect: applying nothing new is the safe default (DEC-22).
 *
 * @param {object|null} choice - The resolver's choice data
 *   ({ field: "acceptReplace", existing: [...], incoming: {...} }); null
 *   throws (the caller surfaces `decision-failed` with no writes).
 * @returns {Promise<boolean>} The decision.
 * @throws {Error} When no choice data was given or DialogV2 is unavailable.
 */
export async function decideSw25StackingChoice(choice) {
  if (!choice || typeof choice !== "object" || !Array.isArray(choice.existing)) {
    throw new Error("No stacking choice data was provided to the decision window.");
  }
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.wait !== "function") {
    throw new Error("DialogV2 is not available in this context; the stacking choice window cannot be presented.");
  }
  const rows = choice.existing.map(buildChoiceRow).join("");
  const incoming = buildChoiceRow(choice.incoming ?? {});
  const content = `
<p class="sw25-stacking-choice-intro">The stacking rules require a decision: only one of these applications can remain. Compare them and choose which to keep.</p>
<table class="sw25-stacking-choice-table">
  <thead><tr><th>Effect</th><th>SV</th><th>Rank</th><th>Duration</th><th>Policy</th><th>Damage</th></tr></thead>
  <tbody>
    ${rows}
    ${incoming}
  </tbody>
</table>`;

  const answer = await DialogV2.wait({
    window: { title: "Sword World 2.5 | Stacking decision" },
    content,
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "keep-previous",
        label: "Keep the previous",
        callback: () => false
      },
      {
        action: "accept-new",
        label: "Accept the new",
        callback: () => true
      }
    ]
  });
  // DialogV2.wait resolves to the callback's return value; a dismissal
  // (rejectClose: false) resolves to null → conserving the previous effect.
  return answer === true;
}

import { applySw25Effect } from "./effect-service.mjs";

/**
 * Convenience GM-side apply that presents the DEC-22 choice window whenever
 * the stacking rules require a decision (DEC-3). Everything else — authority,
 * writes, integrity — is exactly `applySw25Effect`.
 *
 * Player clients receive the `choice-required` outcome instead (the relay
 * carries no dialog): they decide out-of-band and re-apply with
 * `acceptReplace`, or a GM executes the application with this prompt.
 *
 * @param {Actor} actor - The actor receiving the effect.
 * @param {object} application - The application payload (see the service).
 * @param {object} [options] - { notify }.
 * @returns {Promise<{ok: boolean, code: string, ...}>} The service result.
 */
export async function applySw25EffectWithPrompt(actor, application, options = {}) {
  return applySw25Effect(actor, application, { ...options, decide: decideSw25StackingChoice });
}
