// ---------------------------------------------------------------------------
// Natural 2d6 results — shared detection utilities.
//
// Three DIFFERENT mechanics read the natural results of 2d6 rolls. The
// extraction of the natural dice is shared here; the interpretation belongs
// to each subsystem and is never derived from the modified total:
//   1. Attack rolls — natural double 1 is a fumble (automatic miss); natural
//      double 6 is an automatic critical that beats Evasion regardless of
//      the totals.
//   2. Spellcasting checks — natural double 1 is the automatic spell failure
//      (the MP cost is still paid); natural double 6 adds +5 to the
//      Spellcasting Value.
//   3. Power Table damage rolls (weapons AND spells) — the item's own
//      critical threshold is compared against the natural roll to grant an
//      additional damage roll. This comparison belongs to damage resolution
//      only and is never applied to attack or Spellcasting rolls.
//
// Terminology contract (strict; never conflate):
//   - AUTOMATIC SUCCESS (éxito automático): natural double 6 on a skill-type
//     roll (skill checks, attack, defense, resistance; Spellcasting also
//     adds +5 SV). Initiative NEVER uses it — its 2d6 stays purely numeric.
//   - AUTOMATIC FAILURE (fallo automático): natural double 1. Detection is
//     named isCriticalFailure for history, but every user-facing string
//     says CRITICAL FAILURE / Automatic Failure, never "critical".
//   - CRITICAL (crítico): ONLY the Power Table damage-roll threshold
//     (isPowerTableCritical). Never the attack double 6, never Spellcasting.
// ---------------------------------------------------------------------------

// Active natural results of every die in the roll (Foundry marks dropped or
// discarded dice as inactive; they never count toward natural detection).
export function rollDiceResults(roll) {
  return (roll?.dice || []).flatMap(die =>
    (die.results || []).filter(result => result.active !== false).map(result => Number(result.result))
  );
}

// Sum of the natural results of the active dice (2d6 rolls: 2..12).
// Modifier-aware totals must never be used for special-result detection.
export function naturalDiceTotal(roll) {
  return rollDiceResults(roll).reduce((sum, value) => sum + Number(value || 0), 0);
}

// True when BOTH active dice show the same natural face (e.g. 1 or 6).
// A modified total that happens to reach the face value does NOT count.
export function isNaturalDouble(roll, face) {
  const results = rollDiceResults(roll);
  return results.length === 2 && results.every(result => Number(result) === Number(face));
}

// Fumble: natural double 1 on a 2d6 roll (any subsystem; each one applies its
// own consequence — automatic miss, automatic spell failure, table fumble).
export function isCriticalFailure(roll) {
  return isNaturalDouble(roll, 1);
}

export const criticalFailureHTML = () => '<p class="sw25-critical-failure"><strong>CRITICAL FAILURE</strong></p>';

// Power Table critical threshold (damage rolls only): the natural roll meets
// the item's own critical value and grants an additional damage roll.
// Thresholds outside 1..12 can never trigger (the natural maximum is 12);
// a missing or zero threshold means the item has no critical.
export function isPowerTableCritical(roll, criticalValue) {
  const value = Number(criticalValue);
  if (!Number.isFinite(value) || value < 1 || value > 12) return false;
  return naturalDiceTotal(roll) >= value;
}

export function nextAutomaticFailureCount(system = {}) {
  const legacyList = Array.isArray(system.automaticFailures) ? system.automaticFailures : [];
  const legacy = legacyList.filter(Boolean).length;
  const stored = Number(system.automaticFailureCount ?? 0) || 0;
  return Math.max(stored, legacy) + 1;
}

function counterActor(actor) {
  if (!actor?.isToken || actor.token?.actorLink !== false) return actor;
  return game.actors.get(actor.token?.actorId || actor.id) || actor;
}

// Chat-card control so the PLAYER decides whether to register an Automatic
// Failure for a character. Detection (double 1) never writes the counter by
// itself. Monsters get nothing here: no counter, no experience — converting
// Automatic Failures into experience belongs to the Growth procedure.
export function automaticFailureButton(actor) {
  if (actor?.type !== "character") return "";
  return `<button type="button" class="sw25-automatic-failure-register" data-sw25-chat-action="register-automatic-failure" data-actor-id="${foundry.utils.escapeHTML(String(actor.id))}"><i class="fas fa-times"></i> Register Automatic Failure</button>`;
}

// Player-confirmed registration of an Automatic Failure: persists the
// counter on the character (token-linked actors resolve to their base
// actor). No experience is granted here.
export async function registerAutomaticFailure(actor) {
  if (actor?.type !== "character") return false;
  const target = counterActor(actor);
  await target.update({
    "system.automaticFailureCount":nextAutomaticFailureCount(target.system),
    "system.automaticFailures":[]
  });
  target.sheet?.render(false);
  return true;
}
