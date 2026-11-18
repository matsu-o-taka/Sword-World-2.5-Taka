// Sword World 2.5 - Game Rules settings submenu.
//
// A GM-only ApplicationV1 window that groups game-rule toggles under a
// dedicated "Game Rules" entry in Configure Settings → Sword World 2.5.
//
// Foundry V14 does NOT provide a native settings "group": there is no
// `game.settings.registerGroup` API and the SettingConfig `group` property
// is ignored. The supported way to surface game-rule settings under their
// own heading is a dedicated submenu (registerMenu), which is what this
// class implements.
//
// Currently contains a single setting: enforceStrictCombatPreparationRules.
// Future game-rule toggles can be added here as additional form fields.

const APP_ID = "sw25-game-rules";
const TITLE = "Game Rules";

export class GameRulesApp extends foundry.appv1.api.FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: APP_ID,
      title: TITLE,
      template: "systems/sw25-taka/templates/apps/game-rules.hbs",
      width: 480,
      height: 240,
      resizable: true,
      closeOnSubmit: false
    });
  }

  getData() {
    return {
      strictCombatPreparation: Boolean(
        game.settings.get("sw25-taka", "enforceStrictCombatPreparationRules")
      )
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Toggle: Enforce Strict Combat Preparation Rules
    html.find("[data-action='toggle-strict-prep']").on("change", async event => {
      const checked = event.currentTarget.checked;
      await game.settings.set(
        "sw25-taka",
        "enforceStrictCombatPreparationRules",
        checked
      );
      ui.notifications.info(
        `Strict Combat Preparation ${checked ? "enabled" : "disabled"}.`
      );
    });

    // Close button
    html.find("[data-action='close']").on("click", () => this.close(true));
  }
}
