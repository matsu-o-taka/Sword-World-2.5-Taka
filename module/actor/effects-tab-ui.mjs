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
    new Sw25EffectInspector(effect).render(true);
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
}
