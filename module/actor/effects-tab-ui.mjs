// Shared Effects-tab listener wiring for the system's ActorSheets.
//
// The character sheet (T1.5) and the monster sheet render the same Effects
// section (same markup, same data from module/effects/effects-tab.mjs), so
// they share ONE listener wiring instead of duplicating handlers:
//
//   - inspect-sw25-effect: opens the read-only inspector (ApplicationV2).
//     Available to every user who can see the sheet, with the presentation
//     visibility guard: `system.gmOnly` effects are listed only for the GM,
//     so a player can only reach the inspector for one by forging the id;
//     that path is refused too. The row buttons never render for players.
//   - repair-sw25-effect-data: GM-only repair, delegating every document
//     write to the repair contract (no render-path writes). The button only
//     renders for the GM; the handler enforces it as well.
//
// Pure wiring: no data preparation, no storage, no second effects system —
// exactly one implementation shared by every sheet that renders the section.

import { repairActorSw25Effects } from "../effects/effects-tab.mjs";
import { removeSw25Effect, toggleSw25Effect } from "../effects/effect-service.mjs";

/**
 * Wire the shared Effects-section listeners on a rendered sheet.
 * @param {foundry.appv1.sheets.ActorSheet} sheet - The sheet instance whose
 *   `actor` the handlers act on (the character sheet or the monster sheet).
 * @param {jQuery} html - The rendered sheet HTML.
 * @returns {void}
 */
export function wireSw25EffectsTabHandlers(sheet, html) {
  html.find('[data-action="inspect-sw25-effect"]').on("click", async event => {
    event.preventDefault();
    const effectId = event.currentTarget.dataset.effectId;
    const effect = effectId ? sheet.actor.effects.get(effectId) : null;
    if (!effect) return;
    // Presentation visibility guard: gmOnly effects are listed only for the
    // GM, so a player can only reach the inspector for one by forging the
    // id; refuse that path too. The row buttons never render for players.
    if (effect.system?.gmOnly === true && game.user.isGM !== true) {
      ui.notifications.warn("Sword World 2.5 | This effect is visible only to the GM.");
      return;
    }
    // Lazy inspector load: the inspector is an ApplicationV2 dialog needed
    // only at click time, so sheets that render the section (and headless
    // test environments) never pay its module load just for rendering.
    const { Sw25EffectInspector } = await import("../apps/effect-inspector.mjs");
    new Sw25EffectInspector(effect, null, { combat: game.combat ?? null }).render(true);
  });

  html.find('[data-action="repair-sw25-effect-data"]').on("click", async event => {
    event.preventDefault();
    if (game.user.isGM !== true) return; // The button only renders for the GM; enforced here too.
    const summary = await repairActorSw25Effects(sheet.actor);
    if (summary.refused > 0) {
      ui.notifications.warn(`Sword World 2.5 | ${summary.refused} effect(s) could not be repaired (see the warnings above).`);
    }
    sheet.render(false); // Refresh the list; the repair contract already notified per effect.
  });

  /** Toggle one sw25Effect between active and disabled (GM only). */
  html.find('[data-action="toggle-sw25-effect"]').on("click", async event => {
    event.preventDefault();
    if (game.user.isGM !== true) return; // The button only renders for the GM; enforced here too.
    const effectId = event.currentTarget.dataset.effectId;
    const disabled = event.currentTarget.dataset.disabled === "true";
    const actor = sheet.actor;
    const effect = effectId ? actor.effects.get(effectId) : null;
    if (!effect || effect.type !== "sw25Effect") return;
    const result = await toggleSw25Effect(actor, effectId, { active: disabled });
    if (result.ok) {
      sheet.render(false);
    } else if (result.error) {
      ui.notifications.warn(result.error);
    }
  });

  /** Remove one sw25Effect from the actor (GM only, confirmed). */
  html.find('[data-action="remove-sw25-effect"]').on("click", async event => {
    event.preventDefault();
    if (game.user.isGM !== true) return; // The button only renders for the GM; enforced here too.
    const effectId = event.currentTarget.dataset.effectId;
    const effect = effectId ? sheet.actor.effects.get(effectId) : null;
    if (!effect || effect.type !== "sw25Effect") return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Remove Effect" },
      content: `<p>Remove <strong>${foundry.utils.escapeHTML(effect.name || "this effect")}</strong>? This cannot be undone.</p>`,
      rejectClose: false,
      modal: true
    });
    if (confirmed !== true) return;
    const result = await removeSw25Effect(sheet.actor, effectId);
    if (result.ok) {
      sheet.render(false);
    } else if (result.error) {
      ui.notifications.warn(result.error);
    }
  });
}
