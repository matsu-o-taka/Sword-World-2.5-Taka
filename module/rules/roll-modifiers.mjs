// Sword World 2.5 - Common temporary roll modifier infrastructure
//
// Provides the shared building blocks used by any roll flow that needs
// temporary (per-roll) modifiers:
//   - data helpers to normalise and total modifier lists
//   - roll formula assembly with signed constants
//   - a reusable confirmation dialog (apps/roll-modifiers-dialog.mjs)
//
// Temporary modifiers are transient: they are never written to Actor data
// and never create persistent effects. They appear individually in the
// breakdown of the result and can coexist with the system's own permanent
// modifiers and with Weak Point modifiers.

const FORMULA_MODIFIER_PATTERN = /\s*([+-]\s*\d+(?:\.\d+)?)\s*$/;

// The dialog dialog class is kept out of this module so pure helpers stay
// importable in headless environments (tests, macros). The dialog module
// registers itself on load, mirroring the sheet-registration pattern of
// sw25.mjs. UI entry points import both modules; tests import only helpers.
let dialogConstructor = null;

export function registerRollModifiersDialog(constructor) {
  if (typeof constructor !== "function") return;
  dialogConstructor = constructor;
}

// Current dialog constructor: the class previously passed (successfully) to
// registerRollModifiersDialog, or null when no UI entry point has loaded the
// dialog module yet. Lets the system entry point fail fast at initialization
// and lets integration tests verify the production registration itself.
export function getRegisteredRollModifiersDialog() {
  return dialogConstructor;
}

// Normalise a single modifier object. Missing labels get a numbered default;
// values are coerced to finite numbers; enabled defaults to true.
export function normalizeModifier(modifier = {}, index = 0) {
  const value = Number(modifier.value ?? 0);
  return {
    label: String(modifier.label ?? `Modifier ${index + 1}`),
    value: Number.isFinite(value) ? value : 0,
    enabled: modifier.enabled !== false,
    temporary: modifier.temporary === true
  };
}

// Extract the numeric constant appended to a foundry-style formula such as
// "2d6 + 5" or "2d6 - 3"; returns 0 when there is none.
export function formulaConstant(formula) {
  const match = String(formula ?? "").match(FORMULA_MODIFIER_PATTERN);
  return match ? Number(match[1].replace(/\s+/g, "")) : 0;
}

// Sum of every enabled modifier in the list, excluding zero-value modifiers
// (permanent modifiers like the fixed sheet bonus are always applied, even at 0).
export function enabledModifiersTotal(modifiers = []) {
  return modifiers.reduce((sum, modifier) =>
    modifier?.enabled === false ? sum : modifier?.value !== 0
      ? sum + Number(modifier?.value ?? 0)
      : sum, 0);
}

// Sign-aware integer constant for chat display: "+3", "-2", "0".
export function signedValue(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "0";
  if (number === 0) return "0";
  return `${number > 0 ? "+" : "-"}${Math.abs(number)}`;
}

// Assemble the roll formula for a dice term plus a signed total modifier.
// "2d6" ->
//   total 7   -> "2d6 + 7"
//   total -3  -> "2d6 - 3"
//   total 0   -> "2d6"
export function assembleRollFormula(diceFormula, total) {
  const number = Number(total ?? 0);
  if (!Number.isFinite(number) || number === 0) return String(diceFormula);
  return `${diceFormula} ${number > 0 ? "+" : "-"} ${Math.abs(number)}`;
}

/**
 * Show the shared temporary-modifier confirmation dialog.
 *
 * @param {object} config
 * @param {string} [config.title]      Dialog title.
 * @param {string} [config.diceFormula] Dice term shown in the dialog ("2d6").
 * @param {string} [config.submitLabel] Confirm button label.
 * @param {Array}  [config.parts]      Pre-seeded modifiers (permanent and/or
 *                                     temporary rows). Each entry:
 *                                     { label, value, enabled, temporary }.
 *                                     Rows flagged `temporary` are editable
 *                                     and removable; other rows can only be
 *                                     toggled.
 * @returns {Promise<Array|null>} The enabled modifiers
 *   [{ label, value, enabled: true, temporary }] on confirm, or null when the
 *   user closes or cancels the dialog (the roll is then aborted and no
 *   actor data is touched).
 */
export async function openRollModifiersDialog(config = {}) {
  if (!dialogConstructor) {
    throw new Error("The temporary modifier dialog has not been registered.");
  }
  return dialogConstructor.open(config);
}
