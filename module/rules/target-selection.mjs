// Sword World 2.5 - Target selection infrastructure for multi-section monsters.
//
// Provides the shared building blocks used by any attack flow that needs
// the player to declare which section of a multi-section monster is being
// targeted:
//   - data helpers to validate and normalize combat style selections
//   - a reusable confirmation dialog (apps/target-selection-dialog.mjs)
//
// Target selection is transient: it is never written to Actor data and
// never creates persistent effects. It applies only to the current attack
// resolution flow.

let dialogConstructor = null;

/** Register the target selection dialog class. Called by the dialog module
 *  on load, mirroring the sheet-registration pattern of sw25.mjs. UI entry
 *  points import both modules; tests import only helpers. */
export function registerTargetSelectionDialog(constructor) {
  if (typeof constructor !== "function") return;
  dialogConstructor = constructor;
}

/** Current dialog constructor: the class previously passed (successfully) to
 *  registerTargetSelectionDialog, or null when no UI entry point has loaded
 *  the dialog module yet. */
export function getRegisteredTargetSelectionDialog() {
  return dialogConstructor;
}

/** Normalise a single target selection option. Missing labels get a default
 *  based on the id; ids are preserved as-is for combatStyleId matching. */
export function normalizeTargetOption(option = {}, index = 0) {
  return {
    id: String(option.id ?? `section-${index + 1}`),
    label: String(option.label ?? `Section ${index + 1}`),
    description: String(option.description ?? ""),
    selected: option.selected === true
  };
}

/** Assemble the chat card button attribute for the selected combat style id,
 *  used to transport the section choice through the apply-damage flow. */
export function combatStyleIdAttribute(combatStyleId) {
  return combatStyleId ? `data-combat-style-id="${String(combatStyleId)}"` : "";
}

/**
 * Show the shared target selection dialog.
 *
 * @param {object} config
 * @param {string} [config.title]      Dialog title.
 * @param {string} [config.submitLabel] Confirm button label.
 * @param {Array}  [config.options]    Available combat style rows. Each entry:
 *                                     { id, label, description }.
 * @param {boolean} [config.multiSelect] Always false for now; kept for future.
 * @param {number} [config.minSelections] Minimum required selections (default 1).
 * @returns {Promise<string|null>} The selected combatStyleId on confirm,
 *   or null when the user closes or cancels the dialog (the attack is then
 *   aborted and no actor data is touched).
 */
export async function openTargetSelectionDialog(config = {}) {
  if (!dialogConstructor) {
    throw new Error("The target selection dialog has not been registered.");
  }
  return dialogConstructor.open(config);
}
