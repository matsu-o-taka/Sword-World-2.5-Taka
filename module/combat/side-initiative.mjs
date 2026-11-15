import { expireNaturalPower, naturalPowerRemainder } from "../rules/spell-damage.mjs";
import { processRegenerationTurn } from "../rules/spell-effects.mjs";
import { resolveClassAssignment } from "../rules/skill-resolution.mjs";
import { abilityBonus } from "../rules/weapon-damage.mjs";
import { criticalFailureHTML, markCriticalFailure } from "../rules/critical-failure.mjs";
import { processSw25DurationEvent } from "../effects/duration-engine.mjs";

const FLAG_SCOPE = "sw25-taka";
const FLAG_KEY = "sideInitiative";
const SOCKET = "system.sw25-taka";
let sideTurnWindow = null;

// ── T5.3 (open question 5.3, adopted): internal per-combat FIFO ─────────────
// `handleAction` is async and can be entered from several paths (system
// socket, GM-relay chat flag, GM window buttons). Without serialization two
// dispatches can interleave at their awaits (setFlag, combat.update, engine
// writes) and race the flag's read-modify-write and the duration engine's
// read-compute-write of `remainingDuration`. A per-combat promise chain runs
// each dispatch to completion before the next starts: arrival order is
// preserved (coherent for turn edges), latency is negligible, and a failed
// dispatch never blocks the chain. This is NOT a player request queue (the
// relay queues stay banned): it serializes the GM-side execution of already
// authorized actions.
const dispatchQueues = new Map();

function runSerializedDispatch(combatId, job) {
  const key = String(combatId ?? "?");
  const tail = dispatchQueues.get(key) ?? Promise.resolve();
  const result = tail.then(job, job); // run regardless of the previous outcome
  const nextTail = result.then(() => {}, () => {});
  dispatchQueues.set(key, nextTail);
  nextTail.then(() => {
    if (dispatchQueues.get(key) === nextTail) dispatchQueues.delete(key);
  });
  return result;
}

export const firstSide = (playerValues = [], monsterValue = 0) =>
  playerValues.length && Math.max(...playerValues.map(Number)) >= Number(monsterValue) ? "players" : "monsters";

export const playerInitiativeModifier = (scoutLevel = 0, tacticianLevel = 0, agilityModifier = 0, bonus = 0) => {
  const classLevel = Math.max(Number(scoutLevel) || 0, Number(tacticianLevel) || 0);
  return (classLevel > 0 ? classLevel + (Number(agilityModifier) || 0) : 0) + (Number(bonus) || 0);
};

/**
 * Initiative modifier of a character Actor, computed exactly like the sheet:
 * the resolved Scout/Tactician class level (saved selection while valid,
 * otherwise the highest-level one) + Agility bonus + saved bonus. Without a
 * Scout/Tactician class the ability modifier is never added (RAW).
 * Lets the native tracker dice produce `2d6 + modifier` without persisting
 * derived data into the Actor document.
 */
export function characterInitiativeModifier(actor) {
  const system = actor?.system ?? {};
  const classes = [...(actor?.items ?? [])].filter(item =>
    item?.type === "class" && /^(scout|tactician)$/i.test(String(item.name ?? "").trim())
  );
  const resolved = resolveClassAssignment({
    classes,
    savedValue: system.combat?.initiativeClassId
  });
  return playerInitiativeModifier(
    resolved.level,
    0,
    abilityBonus(system, "agility"),
    Number(system.combat?.initiativeBonus ?? 0)
  );
}

export const sideTransition = (startingSide, completedSide) => ({
  phase: startingSide === completedSide ? (completedSide === "players" ? "monsters" : "players") : startingSide,
  newRound: startingSide !== completedSide
});

const activeCombat = () => game.combat;
const stateFor = combat => combat?.getFlag(FLAG_SCOPE, FLAG_KEY) || null;
// T5.1 (DEC-51): per-combatant INDIVIDUAL turn state, persisted inside the
// SAME side-state flag — `turnStates` (combatant id -> "started"|"ended")
// and `turnOrder` (combatant ids in the order their individual turns began,
// the real chosen actuation order). The reader tolerates states persisted
// before T5.1 (fields absent); it never mutates them.
const turnStatesOf = state => (state?.turnStates && typeof state.turnStates === "object" ? state.turnStates : {});
const characterCombatants = combat => [...(combat?.combatants || [])].filter(combatant => combatant.actor?.type === "character" && !combatant.defeated);
const monsterCombatants = combat => [...(combat?.combatants || [])].filter(combatant => combatant.actor?.type === "monster" && !combatant.defeated);
const hasInitiative = combatant => combatant.initiative !== null && combatant.initiative !== undefined && Number.isFinite(Number(combatant.initiative));
// Automatic monster initiative assignments still in flight (combatant id ->
// Promise). activateSideTurnsFromTracker awaits these before snapshotting so
// the side state can never be built from incomplete values.
const pendingMonsterAssignments = new Map();

function clearIndividualTurnMarkers() {
  const tokens = canvas?.tokens;
  if (!tokens) return;
  const marked = new Set([...(tokens.turnMarkers || []), ...(tokens.placeables || []).filter(token => token.turnMarker)]);
  for (const token of marked) {
    if (!token.turnMarker) continue;
    token.turnMarker.visible = false;
    token.turnMarker.renderable = false;
  }
}

function clearTrackerHighlights(root = document) {
  root.querySelectorAll?.(".combatant.active, [data-combatant-id].active, [data-entry-id].active").forEach(element => element.classList.remove("active"));
}

async function announce(content) {
  await ChatMessage.create({ content: `<div class="sw25-chat-card sw25-side-phase-card">${content}</div>` });
}

async function saveState(combat, state) {
  const deep = JSON.parse(JSON.stringify(state));
  await combat.setFlag(FLAG_SCOPE, FLAG_KEY, deep);
  queueSideControls(combat);
  if (game.user.isGM) game.socket.emit(SOCKET, { action:"sync-side-state", combatId:combat.id });
}

function trackerRoot(app, html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return app?.element instanceof HTMLElement ? app.element : null;
}

function queueSideControls(combat = activeCombat()) {
  setTimeout(() => {
    const trackers = [ui.combat, ui.combat?.popout].filter(app => app?.rendered && (!combat || app.viewed?.id === combat.id));
    for (const tracker of trackers) renderSideControls(tracker, tracker.element);
    if (sideTurnWindow?.rendered && (!combat || sideTurnWindow.combatId === combat.id)) sideTurnWindow.render(false);
  }, 0);
}

const SideTurnApplication = globalThis.Application ?? class {};

class SW25SideTurnWindow extends SideTurnApplication {
  constructor(combatId, options = {}) {
    super(options);
    this.combatId = combatId;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:"sw25-side-turn-window",
      title:"Sword World Side Turns",
      template:"systems/sw25-taka/templates/apps/side-turn-window.hbs",
      width:330,
      height:"auto",
      resizable:false,
      classes:["sw25", "sw25-side-turn-window"]
    });
  }

  getData() {
    const combat = game.combats.get(this.combatId);
    const state = stateFor(combat);
    const done = new Set(state?.playersDone || []);
    const monstersDone = new Set(state?.monstersDone || []);
    const turnStates = turnStatesOf(state);
    const players = characterCombatants(combat);
    const remaining = players.filter(combatant => !done.has(combatant.id));
    const monsters = monsterCombatants(combat);
    const naturalPower = players.map(combatant => {
      const resource = combatant.actor?.getFlag("sw25-taka", "naturalPower");
      if (!resource || (!game.user.isGM && !combatant.actor?.isOwner)) return null;
      return {
        name:combatant.name,
        added:Number(resource.added) || 0,
        spent:Number(resource.spent) || 0,
        remaining:naturalPowerRemainder(resource)
      };
    }).filter(Boolean);
    // T5.1 (DEC-51): per-combatant individual turn control. The button for
    // each combatant ALTERNATES between "Begin Turn" and "Finish Turn"
    // according to its current actuation state; a finished individual turn
    // shows its state without a control until the phase resets it.
    const turnView = (combatant, current, controllable) => {
      const turnState = turnStates[combatant.id] ?? null;
      const started = turnState === "started";
      const ended = turnState === "ended";
      return {
        id:combatant.id,
        name:combatant.name,
        turnState,
        stateClass:turnState ?? "idle",
        stateLabel:started ? "Turn started" : ended ? "Turn ended" : "Not started",
        action:started ? "finish-turn" : "begin-turn",
        actionLabel:started ? "Finish Turn" : "Begin Turn",
        actionIcon:started ? "fa-stop" : "fa-play",
        canControl:Boolean(controllable) && !ended
      };
    };
    return {
      active:Boolean(state?.active),
      phase:state?.phase || "players",
      playerPhase:state?.phase === "players",
      monsterPhase:state?.phase === "monsters",
      done:done.size,
      total:players.length,
      round:Number(state?.round || combat?.round || 1),
      canEndPlayer:state?.phase === "players" && !game.user.isGM && remaining.some(combatant => combatant.actor?.isOwner),
      gmPlayerControls:state?.phase === "players" && game.user.isGM,
      remainingPlayers:remaining.map(combatant => ({ id:combatant.id, name:combatant.name })),
      playerTurns:remaining.map(combatant => turnView(
        combatant,
        turnStates[combatant.id] ?? null,
        state?.phase === "players" && (game.user.isGM || combatant.actor?.isOwner)
      )),
      canEndMonsters:state?.phase === "monsters" && game.user.isGM,
      gmMonsterControls:state?.phase === "monsters" && game.user.isGM,
      monsters:monsters.map(combatant => ({
        ...turnView(
          combatant,
          turnStates[combatant.id] ?? null,
          state?.phase === "monsters" && game.user.isGM && !monstersDone.has(combatant.id)
        ),
        done:monstersDone.has(combatant.id)
      })),
      doneMonsters:monsters.filter(combatant => monstersDone.has(combatant.id)).length,
      totalMonsters:monsters.length,
      naturalPower
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-action='end-player-turn']").on("click", event => {
      event.preventDefault();
      return requestPlayerEnd(game.combats.get(this.combatId));
    });
    html.find("[data-action='end-monster-turn']").on("click", event => {
      event.preventDefault();
      return endMonsterPhase(game.combats.get(this.combatId));
    });
    html.find("[data-action='gm-end-player-turn']").on("click", event => {
      event.preventDefault();
      return requestGMPlayerEnd(game.combats.get(this.combatId), [event.currentTarget.dataset.combatantId]);
    });
    html.find("[data-action='gm-end-all-player-turns']").on("click", event => {
      event.preventDefault();
      return requestGMPlayerEnd(game.combats.get(this.combatId));
    });
    html.find("[data-action='gm-end-monster-turn']").on("click", event => {
      event.preventDefault();
      return markMonstersDone(game.combats.get(this.combatId), [event.currentTarget.dataset.combatantId]);
    });
    // T5.1 (DEC-51): individual turn controls. One combatant per click; the
    // button action itself alternates (begin-turn / finish-turn) with the
    // combatant's current state.
    html.find("[data-action='begin-turn'], [data-action='finish-turn']").on("click", event => {
      event.preventDefault();
      const button = event.currentTarget;
      return requestIndividualTurn(game.combats.get(this.combatId), button.dataset.action, [button.dataset.combatantId]);
    });
  }

  async close(options = {}) {
    if (sideTurnWindow === this) sideTurnWindow = null;
    return super.close(options);
  }
}

function openSideTurnWindow(combat = activeCombat()) {
  if (!combat || !stateFor(combat)?.active) return ui.notifications.warn("Side initiative has not started for this encounter.");
  if (sideTurnWindow && sideTurnWindow.combatId !== combat.id) sideTurnWindow.close();
  sideTurnWindow ??= new SW25SideTurnWindow(combat.id);
  sideTurnWindow.render(true);
}

export async function activateSideTurnsFromTracker(combat = activeCombat()) {
  if (!combat) return ui.notifications.warn("There is no active combat encounter.");
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can activate side turns.");
  if (stateFor(combat)?.active) return openSideTurnWindow(combat);

  // Wait for in-flight automatic monster initiative assignments so the
  // snapshot below is never taken from incomplete values. Failed assignments
  // surface through the missing-initiative warning underneath.
  if (pendingMonsterAssignments.size) await Promise.allSettled([...pendingMonsterAssignments.values()]);

  const players = characterCombatants(combat);
  const monsters = monsterCombatants(combat);
  if (!players.length || !monsters.length) return ui.notifications.warn("Side turns require at least one player and one monster.");
  const missingPlayers = players.filter(combatant => !hasInitiative(combatant));
  const missingMonsters = monsters.filter(combatant => !hasInitiative(combatant));
  if (missingPlayers.length || missingMonsters.length) {
    const missing = [...missingPlayers, ...missingMonsters].map(combatant => combatant.name).join(", ");
    return ui.notifications.warn(`Roll or enter initiative for: ${missing}.`);
  }

  const playerInitiatives = Object.fromEntries(players.map(combatant => [combatant.id, Number(combatant.initiative)]));
  const monsterInitiative = Math.max(...monsters.map(combatant => Number(combatant.initiative)));
  const startingSide = firstSide(Object.values(playerInitiatives), monsterInitiative);
  const state = {
    active:true,
    phase:startingSide,
    firstPhase:startingSide,
    playersDone:[],
    monstersDone:[],
    turnStates:{},
    turnOrder:[],
    playerInitiatives,
    monsterInitiative,
    round:Math.max(1, Number(combat.round || 1))
  };
  await saveState(combat, state);
  if (!combat.started) await combat.startCombat();
  if (combat.turn !== null) await combat.update({ turn:null });
  await announce(`<h3>Side Initiative</h3><p><strong>Players:</strong> ${Math.max(...Object.values(playerInitiatives))} &nbsp; <strong>Monsters:</strong> ${monsterInitiative}</p><p><strong>${startingSide === "players" ? "Players" : "Monsters"} act first.</strong></p>`);
  openSideTurnWindow(combat);
}

export async function recordPlayerInitiative(actor, total) {
  const combat = activeCombat();
  if (!combat) return ui.notifications.warn("There is no active combat encounter.");
  const matches = characterCombatants(combat).filter(combatant => combatant.actor?.id === actor.id);
  if (!matches.length) return ui.notifications.warn(`${actor.name} is not in the active combat encounter.`);
  for (const combatant of matches) await combat.setInitiative(combatant.id, Number(total));
  ui.notifications.info(`${actor.name}'s side initiative is ${total}.`);
}

/**
 * Native tracker dice for a character combatant: same flow as the character
 * sheet button (2d6 + modifier, critical failure tracking, chat message) and
 * then recordPlayerInitiative. Replaces the inert "0" native formula roll.
 */
export async function rollCharacterTrackerInitiative(combatant) {
  const actor = combatant?.actor;
  if (actor?.type !== "character") return false;
  const modifier = characterInitiativeModifier(actor);
  const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
  const criticalFailure = await markCriticalFailure(actor, roll);
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `Initiative Check${criticalFailure ? criticalFailureHTML() : ""}`
  });
  await recordPlayerInitiative(actor, roll.total);
  return true;
}

/**
 * Execute a native tracker initiative action under Side Initiative rules.
 * Characters roll 2d6 + their modifier; monsters receive their fixed
 * `system.initiative` value (no dice); other types are left untouched so the
 * inert "0" system formula can never produce random values for them.
 *
 * @param {Combat} combat The viewed combat encounter.
 * @param {string} action Native tracker action: "rollInitiative",
 *   "rollAll" or "rollNPC" (camelCase names used by the v14 CombatTracker).
 * @param {string|null} [combatantId] Combatant id for "rollInitiative".
 * @returns {Promise<"character"|"monster"|"all"|"npc"|false>} What was
 *   handled; false leaves the action to native Foundry behavior.
 */
export async function resolveTrackerRollAction(combat, action, combatantId = null) {
  if (!combat) return false;
  if (action === "rollInitiative") {
    const combatant = combat.combatants.get(combatantId);
    if (!combatant) return false;
    const type = combatant.actor?.type;
    if (type === "character") { await rollCharacterTrackerInitiative(combatant); return "character"; }
    if (type === "monster") { await beginMonsterInitiative(combatant.actor, combat); return "monster"; }
    return false;
  }
  if (action !== "rollAll" && action !== "rollNPC") return false;
  const rows = action === "rollNPC" ? monsterCombatants(combat) : [...(combat.combatants || [])];
  for (const combatant of rows) {
    const type = combatant.actor?.type;
    if (type === "character") await rollCharacterTrackerInitiative(combatant);
    else if (type === "monster") await beginMonsterInitiative(combatant.actor, combat);
  }
  return action === "rollNPC" ? "npc" : "all";
}

/**
 * Capture-phase document listener routing the native tracker initiative
 * controls through Side Initiative rules. Capture on `document` fires before
 * any listener inside the tracker application regardless of the phase Foundry
 * binds with, so the native roll never starts. Scoped to the combat sidebar
 * (v14 adds a `<tabName>-sidebar` class to the tracker root, hence
 * `.combat-sidebar`) and left transparent for actions other than the three
 * initiative controls (v14 uses camelCase action names: "rollInitiative",
 * "rollAll", "rollNPC" — verified against the v14 tracker template).
 */
function handleTrackerRollClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest?.(".combat-sidebar")) return;
  const action = target.closest("[data-action]")?.dataset?.action ?? "";
  if (action !== "rollInitiative" && !/^roll(All|NPC)$/.test(action)) return;
  const combat = ui.combat?.viewed ?? activeCombat();
  if (!combat) return;
  if (action === "rollInitiative") {
    const row = target.closest("[data-combatant-id]");
    if (!row) return;
    const combatant = combat.combatants.get(row.dataset.combatantId);
    if (!combatant || (combatant.actor?.type !== "character" && combatant.actor?.type !== "monster")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    resolveTrackerRollAction(combat, action, row.dataset.combatantId);
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  resolveTrackerRollAction(combat, action);
}

/**
 * Assign a monster Actor's fixed initiative value (`system.initiative`) to
 * every combatant of that Actor within a combat encounter. Assignment only:
 * activating Side Initiative (state, startCombat, announcement) is exclusively
 * `activateSideTurnsFromTracker`'s responsibility.
 *
 * Historically (v0.15.1) this function also started Side Initiative from a
 * monster-sheet button that read the same fixed value; the button was removed
 * in v0.17.2. The assignment half is now reused automatically when monster
 * combatants are created, and activation stays with the tracker panel.
 *
 * @param {Actor} actor Monster Actor whose fixed initiative is assigned.
 * @param {Combat} [combat] Combat containing the actor's combatants
 *   (defaults to the active combat).
 * @returns {Promise<boolean>} true when an assignment was attempted.
 */
export async function beginMonsterInitiative(actor, combat = activeCombat()) {
  if (!game.user.isGM) return false;
  if (!combat || actor?.type !== "monster") return false;
  // Zero is a valid RAW fixed initiative value, not an absence of data.
  const value = Number(actor.system?.initiative ?? 0);
  const matching = monsterCombatants(combat).filter(combatant => combatant.actor?.id === actor.id);
  if (!matching.length) return false;
  for (const combatant of matching) {
    if (hasInitiative(combatant)) continue; // Respect values already assigned (manual edits).
    try {
      await combat.setInitiative(combatant.id, value);
    } catch (error) {
      // Explicit failure handling: the combatant stays without initiative and
      // activation will list it in the "Roll or enter initiative" warning.
      console.warn("Sword World 2.5 | Could not assign the fixed initiative of", actor.name, error);
    }
  }
  return true;
}

/**
 * Individual turn state of one combatant (T5.1, DEC-51): "started" once its
 * individual actuation has begun, "ended" once it has finished, and null while
 * the combatant has not begun its turn in the current phase. Read-only view
 * used by the tracker UI today and by the later duration-anchor work (T5.0
 * investigates the exact integration; nothing is invented here).
 * @param {Combat} combat Combat encounter.
 * @param {string} combatantId Combatant id.
 * @returns {"started"|"ended"|null}
 */
export function individualTurnState(combat, combatantId) {
  const state = stateFor(combat);
  if (!state?.active) return null;
  return turnStatesOf(state)[combatantId] ?? null;
}

/**
 * GM-side dispatcher of the Side Initiative actions: socket payloads
 * (`handleAction(payload, senderId)` through the shared system socket) and
 * GM-relay chat flags both land here on the GM client. Exported so the
 * headless test suites can exercise the exact production path; production
 * callers never import it directly.
 *
 * T5.3 (open question 5.3, adopted): executions are serialized per combat
 * through the internal FIFO above; the body runs in `handleActionInner`.
 * @param {object} payload Action payload ({ action, combatId, ... }).
 * @param {string} userId Requesting user id.
 * @returns {Promise<void>}
 */
export function handleAction(payload, userId) {
  return runSerializedDispatch(payload?.combatId, () => handleActionInner(payload, userId));
}

/**
 * T5.3 (D9/D7): the duration engine runs AFTER the transition has been
 * registered and persisted. A processing failure never reverts or repeats the
 * transition and never interrupts the dispatch itself: the engine isolates
 * per effect and reports failures visibly to the GM; this dispatch-level
 * guard is only the last barrier against an unexpected engine crash.
 * @param {Combat} combat Combat encounter.
 * @param {object} event Duration event for the engine.
 * @returns {Promise<void>}
 */
async function processDurationSafely(combat, event) {
  try {
    return await processSw25DurationEvent(combat, event);
  } catch (error) {
    console.warn("Sword World 2.5 | Duration engine dispatch failed.", event, error);
  }
}

/**
 * T5.3 (D9): fire the turn-end edge for each combatant whose actuation
 * actually ended with this transition, sequentially (serialized semantics).
 * @param {Combat} combat Combat encounter.
 * @param {string[]} combatantIds Combatant ids that transitioned into ended.
 * @returns {Promise<void>}
 */
async function processTurnEndEvents(combat, combatantIds) {
  for (const combatantId of combatantIds) {
    await processDurationSafely(combat, { kind: "turn-end", combatantId });
  }
}

async function handleActionInner(payload, userId) {
  if (!game.user.isGM) return;
  const combat = game.combats.get(payload.combatId);
  const state = stateFor(combat);
  if (!combat || !state?.active) return;
  if (payload.action === "end-player") {
    const user = game.users.get(userId);
    const gmOverride = Boolean(payload.gmOverride && game.user.isGM);
    if (!gmOverride && !user) {
      console.warn("Sword World 2.5 | Rejected End Turn request without a valid user.", payload);
      return;
    }
    const requested = new Set(payload.combatantIds || []);
    const alreadyDone = new Set(state.playersDone || []);
    // The requesting client only offers combatants for which actor.isOwner is
    // true. Re-resolving synthetic-token ownership on the GM client can differ
    // in V14, so validate the requested IDs against the encounter rather than
    // rejecting a legitimate request because the GM sees a different Actor.
    const validCombatants = characterCombatants(combat).filter(combatant => requested.has(combatant.id) && !alreadyDone.has(combatant.id));
    const valid = validCombatants.map(combatant => combatant.id);
    if (!valid.length) {
      console.warn("Sword World 2.5 | End Turn request did not match an owned player combatant.", { userId, requested:[...requested] });
      return;
    }
    const turnStates = { ...(state.turnStates || {}) };
    // T5.3 (D9): turn-end events are derived from the ACTUAL transition. A
    // combatant whose individual turn was already ended (finish-turn earlier
    // in the phase) must not produce a second event (no double discount).
    const turnEndIds = validCombatants
      .filter(combatant => turnStates[combatant.id] !== "ended")
      .map(combatant => combatant.id);
    for (const combatant of validCombatants) {
      await processRegenerationTurn(combatant.actor);
      await expireNaturalPower(combatant.actor);
      // T5.1 (coherence, additive): ending the side turn also ENDS the
      // combatant's individual turn. The side-switch behavior below is
      // untouched.
      turnStates[combatant.id] = "ended";
    }
    const playersDone = [...new Set([...alreadyDone, ...valid])];
    const allIds = characterCombatants(combat).map(combatant => combatant.id);
    const complete = allIds.length > 0 && allIds.every(id => playersDone.includes(id));
    if (!complete) {
      const nextState = { ...state };
      nextState.playersDone = playersDone;
      nextState.phase = "players";
      nextState.turnStates = turnStates;
      await saveState(combat, nextState);
      // T5.3 (D9): transition saved first; the engine processes the ended
      // turn edges afterwards.
      await processTurnEndEvents(combat, turnEndIds);
    } else if (state.firstPhase === "players") {
      // Side switch: the finished side's individual turn states are cleared
      // for the next phase (fresh actuation round), like playersDone above.
      // Use delete instead of {} because Foundry's setFlag drops empty objects.
      const nextState = { ...state };
      nextState.playersDone = playersDone;
      nextState.monstersDone = [];
      nextState.phase = "monsters";
      nextState.turnStates = null;
      nextState.turnOrder = null;
      await saveState(combat, nextState);
      // T5.3 (D9): ending the side ends these combatants' actuation too.
      await processTurnEndEvents(combat, turnEndIds);
      await announce("<h3>Monster Turn</h3><p>All players have ended their turns.</p>");
    } else {
      const nextRound = Math.max(1, Number(combat.round || state.round || 1) + 1);
      await combat.update({ round:nextRound, turn:null });
      const nextState = { ...state };
      nextState.playersDone = [];
      nextState.monstersDone = [];
      nextState.phase = "monsters";
      nextState.round = nextRound;
      nextState.turnStates = null;
      nextState.turnOrder = null;
      await saveState(combat, nextState);
      // T5.3 (D9): the round change is confirmed by combat.update above and
      // the side state is persisted; the engine processes the ended turn
      // edges first and then the round end ONCE (roundEnd regime).
      await processTurnEndEvents(combat, turnEndIds);
      await processDurationSafely(combat, { kind:"round-end", round: nextRound });
      await announce(`<h3>Round ${nextRound}</h3><p><strong>Monsters act first.</strong></p>`);
    }
    return;
  }
  if (payload.action === "end-monster") {
    const requested = new Set(payload.combatantIds || []);
    const alreadyDone = new Set(state.monstersDone || []);
    const validCombatants = monsterCombatants(combat).filter(combatant => requested.has(combatant.id) && !alreadyDone.has(combatant.id));
    const valid = validCombatants.map(combatant => combatant.id);
    if (!valid.length) {
      console.warn("Sword World 2.5 | End Monster Turn request did not match an unfinished monster combatant.", { userId, requested:[...requested] });
      return;
    }
    // T5.1 (coherence, additive): marking a monster acted also ENDS its
    // individual turn; the side-switch behavior below is untouched.
    const turnStates = { ...(state.turnStates || {}) };
    // T5.3 (D9): turn-end events derive from the actual transition (see
    // end-player); already-ended monsters produce no second event.
    const turnEndIds = validCombatants
      .filter(combatant => turnStates[combatant.id] !== "ended")
      .map(combatant => combatant.id);
    for (const combatant of validCombatants) turnStates[combatant.id] = "ended";
    const monstersDone = [...new Set([...alreadyDone, ...valid])];
    const allIds = monsterCombatants(combat).map(combatant => combatant.id);
    const complete = allIds.length > 0 && allIds.every(id => monstersDone.includes(id));
    if (!complete) {
      const nextState = { ...state };
      nextState.monstersDone = monstersDone;
      nextState.phase = "monsters";
      nextState.turnStates = turnStates;
      await saveState(combat, nextState);
      // T5.3 (D9): transition saved first; engine edges afterwards.
      await processTurnEndEvents(combat, turnEndIds);
    } else await completeMonsterPhase(combat, state, monstersDone, turnEndIds);
  }

  // ── T5.1: individual turn control (DEC-51) ─────────────────────────────
  // "begin-turn" registers that a combatant STARTED its individual actuation
  // and "finish-turn" that it ENDED. Strict per-combatant alternation:
  // begin is only coherent from "not started" and finish only from
  // "started"; anything else is rejected with no state change (no invented
  // transitions). A combatant only acts while ITS side's phase is active,
  // and without gmOverride (player whisper path) only player combatants
  // qualify. Fully independent of the side switch (end-player/end-monster):
  // no phase transition, no round change, no playersDone/monstersDone write.
  if (payload.action === "begin-turn" || payload.action === "finish-turn") {
    const begin = payload.action === "begin-turn";
    const gmRequest = Boolean(payload.gmOverride && game.user.isGM);
    if (!gmRequest && !game.users.get(userId)) {
      console.warn("Sword World 2.5 | Rejected individual turn request without a valid user.", payload);
      return;
    }
    const phase = state.phase;
    const pool = phase === "players"
      ? characterCombatants(combat)
      : (phase === "monsters" && gmRequest) ? monsterCombatants(combat) : [];
    const requested = new Set(payload.combatantIds || []);
    const turnStates = { ...(state.turnStates || {}) };
    const turnOrder = [...(state.turnOrder || [])];
    const targets = pool.filter(combatant => {
      if (!requested.has(combatant.id)) return false;
      const current = turnStates[combatant.id] ?? null;
      return begin ? current === null : current === "started";
    });
    if (!targets.length) {
      console.warn("Sword World 2.5 | Individual turn request matched no combatant in a coherent state.", { userId, action:payload.action, phase, requested:[...requested] });
      return;
    }
    for (const combatant of targets) {
      turnStates[combatant.id] = begin ? "started" : "ended";
      // The real actuation order chosen inside the side (DEC-51): recorded
      // at BEGIN, never imposed.
      if (begin && !turnOrder.includes(combatant.id)) turnOrder.push(combatant.id);
    }
    await saveState(combat, { ...state, turnStates, turnOrder });
    // T5.3 (D9): the transition is registered and persisted; the engine
    // processes the corresponding anchor edge for each combatant that
    // ACTUALLY transitioned (targets were filtered by coherent prior state).
    const edgeKind = begin ? "turn-begin" : "turn-end";
    for (const combatant of targets) {
      await processDurationSafely(combat, { kind: edgeKind, combatantId: combatant.id });
    }
  }
}

async function requestPlayerEnd(combat) {
  const state = stateFor(combat);
  if (state?.phase !== "players") return;
  const done = new Set(state.playersDone || []);
  const ids = characterCombatants(combat).filter(combatant => !done.has(combatant.id) && combatant.actor?.isOwner).map(combatant => combatant.id);
  if (!ids.length) return ui.notifications.warn("You have no unfinished player combatants in this encounter.");
  const activeGM = game.users.activeGM;
  if (!activeGM) return ui.notifications.error("An active GM is required to advance side initiative.");
  if (game.user.isGM) await handleAction({ action:"end-player", combatId:combat.id, combatantIds:ids }, game.user.id);
  else {
    const gmIds = ChatMessage.getWhisperRecipients("GM").map(user => user.id);
    await ChatMessage.create({
      whisper:gmIds,
      content:`<div class="sw25-chat-card"><h3>End Turn</h3><p><strong>${foundry.utils.escapeHTML(game.user.name)}</strong> ended their player turn.</p></div>`,
      flags:{ [FLAG_SCOPE]:{ sideTurnRequest:{ action:"end-player", combatId:combat.id, combatantIds:ids, userId:game.user.id } } }
    });
    ui.notifications.info("End Turn sent to the GM.");
  }
}

export async function requestGMPlayerEnd(combat, combatantIds = null) {
  if (!game.user.isGM) return;
  const state = stateFor(combat);
  if (state?.phase !== "players") return;
  const done = new Set(state.playersDone || []);
  const remaining = characterCombatants(combat).filter(combatant => !done.has(combatant.id));
  const ids = combatantIds?.filter(Boolean) || remaining.map(combatant => combatant.id);
  if (!ids.length) return ui.notifications.warn("There are no unfinished player turns.");
  await handleAction({ action:"end-player", combatId:combat.id, combatantIds:ids, gmOverride:true }, game.user.id);
}

/**
 * Client entry point for the individual turn controls (T5.1, DEC-51):
 * "begin-turn" registers that a combatant began its individual actuation and
 * "finish-turn" that it ended. The button shown for each combatant alternates
 * between the two according to its current state, and the actuation order
 * inside the side stays free (only recorded, never imposed).
 *
 * Authority mirrors the End Turn flow: the GM executes any combatant of the
 * active side directly; a player client may only request its OWN unfinished
 * player combatants during the players phase, through the same GM-relay
 * whisper used by End Turn. Completely independent of the side switch
 * (end-player/end-monster).
 *
 * @param {Combat} combat Combat encounter.
 * @param {"begin-turn"|"finish-turn"} action Individual turn action.
 * @param {string[]} [combatantIds] Combatant ids (one per control).
 * @returns {Promise<void>}
 */
export async function requestIndividualTurn(combat, action, combatantIds = []) {
  if (action !== "begin-turn" && action !== "finish-turn") return ui.notifications.warn("Unknown individual turn control.");
  const state = stateFor(combat);
  if (!state?.active) return ui.notifications.warn("Side initiative has not started for this encounter.");
  const ids = [...new Set((combatantIds || []).filter(Boolean))];
  if (game.user.isGM) {
    if (!ids.length) return ui.notifications.warn("Select a combatant for the individual turn control.");
    await handleAction({ action, combatId:combat.id, combatantIds:ids, gmOverride:true }, game.user.id);
    return;
  }
  if (state.phase !== "players") return ui.notifications.warn("Individual turns are controlled during your side's phase.");
  const done = new Set(state.playersDone || []);
  const requested = new Set(ids);
  const own = characterCombatants(combat)
    .filter(combatant => requested.has(combatant.id) && !done.has(combatant.id) && combatant.actor?.isOwner)
    .map(combatant => combatant.id);
  if (!own.length) return ui.notifications.warn("You have no unfinished player combatants in this encounter.");
  const activeGM = game.users.activeGM;
  if (!activeGM) return ui.notifications.error("An active GM is required to advance side initiative.");
  const gmIds = ChatMessage.getWhisperRecipients("GM").map(user => user.id);
  await ChatMessage.create({
    whisper:gmIds,
    content:`<div class="sw25-chat-card"><h3>${action === "begin-turn" ? "Begin Turn" : "Finish Turn"}</h3><p><strong>${foundry.utils.escapeHTML(game.user.name)}</strong> requested an individual turn control.</p></div>`,
    flags:{ [FLAG_SCOPE]:{ sideTurnRequest:{ action, combatId:combat.id, combatantIds:own, userId:game.user.id } } }
  });
  ui.notifications.info("Individual turn request sent to the GM.");
}

/** Shared transition when the monster phase finishes (all marked or early end).
 * `turnEndIds` (T5.3, D9) carries the combatants whose actuation ended with
 * this transition (computed by the caller from the actual state transition);
 * the GM early-end button passes none (already-marked monsters produced
 * their events when they were marked). */
async function completeMonsterPhase(combat, state, monstersDone, turnEndIds = []) {
  const transition = sideTransition(state.firstPhase, "monsters");
  if (!transition.newRound) {
    // Side switch: individual turn states clear for the next phase, like
    // playersDone/monstersDone above (T5.1: fresh actuation per phase).
    // Use null instead of {} / [] because Foundry's flag deep-merge keeps
    // empty object keys alive while null replaces the whole value.
    const nextState = { ...state };
    nextState.phase = transition.phase;
    nextState.playersDone = [];
    nextState.monstersDone = monstersDone;
    nextState.turnStates = null;
    nextState.turnOrder = null;
    await saveState(combat, nextState);
    // T5.3 (D9): engine edges after the saved transition.
    await processTurnEndEvents(combat, turnEndIds);
    await announce("<h3>Player Turn</h3><p>The monsters have ended their turn.</p>");
  } else {
    const nextRound = Math.max(1, Number(combat.round || state.round || 1) + 1);
    await combat.update({ round:nextRound, turn:null });
    const nextState = { ...state };
    nextState.phase = transition.phase;
    nextState.playersDone = [];
    nextState.monstersDone = [];
    nextState.round = nextRound;
    nextState.turnStates = null;
    nextState.turnOrder = null;
    await saveState(combat, nextState);
    // T5.3 (D9): round confirmed by combat.update + saved state; turn edges
    // first, then the round end ONCE.
    await processTurnEndEvents(combat, turnEndIds);
    await processDurationSafely(combat, { kind:"round-end", round: nextRound });
    await announce(`<h3>Round ${nextRound}</h3><p><strong>Players act first.</strong></p>`);
  }
}

/** GM-only early end of the monster phase (kept as the tracker window button). */
export async function endMonsterPhase(combat) {
  if (!game.user.isGM) return;
  const state = stateFor(combat);
  if (state?.phase !== "monsters") return;
  await completeMonsterPhase(combat, state, [...new Set(state.monstersDone || [])]);
}

/** GM-only: mark specific monster combatants as having acted this round. */
export async function markMonstersDone(combat, combatantIds = null) {
  if (!game.user.isGM) return;
  const state = stateFor(combat);
  if (state?.phase !== "monsters") return;
  const done = new Set(state.monstersDone || []);
  const ids = combatantIds?.filter(Boolean)
    || monsterCombatants(combat).filter(combatant => !done.has(combatant.id)).map(combatant => combatant.id);
  if (!ids.length) return ui.notifications.warn("There are no unfinished monster turns.");
  await handleAction({ action:"end-monster", combatId:combat.id, combatantIds:ids, gmOverride:true }, game.user.id);
}

function renderSideControls(app, html) {
  const combat = app.viewed || activeCombat();
  const state = stateFor(combat);
  const root = trackerRoot(app, html);
  if (!root) return;
  root.classList.remove("sw25-side-active");
  document.body.classList.remove("sw25-side-combat-active");
  root.querySelector(".sw25-side-initiative")?.remove();
  if (!combat) return;
  const panel = document.createElement("section");
  panel.className = "sw25-side-initiative sw25-side-launcher";
  if (!state?.active) {
    if (game.user.isGM) {
      panel.innerHTML = `<button type="button" data-sw25-side-action="activate"><i class="fas fa-people-arrows"></i> Activate Side Turns</button>`;
    } else {
      panel.innerHTML = `<button type="button" data-sw25-side-action="open-window"><i class="fas fa-user-clock"></i> Open Player Turns</button>`;
    }
    (root.querySelector(".combat-tracker") || root).append(panel);
    panel.querySelector("[data-sw25-side-action='activate']")?.addEventListener("click", () => activateSideTurnsFromTracker(combat));
    panel.querySelector("[data-sw25-side-action='open-window']")?.addEventListener("click", () => openSideTurnWindow(combat));
    return;
  }
  root.classList.add("sw25-side-active");
  document.body.classList.add("sw25-side-combat-active");
  clearTrackerHighlights(root);
  clearIndividualTurnMarkers();
  const done = new Set(state.playersDone || []);
  panel.innerHTML = `<button type="button" data-sw25-side-action="open-window"><i class="fas ${game.user.isGM ? "fa-people-arrows" : "fa-user-clock"}"></i> ${game.user.isGM ? "Open Side Turns" : "Open Player Turns"}</button>`;
  (root.querySelector(".combat-tracker") || root).append(panel);
  panel.querySelector("[data-sw25-side-action='open-window']")?.addEventListener("click", () => openSideTurnWindow(combat));
}

export async function initializeSideInitiative() {
  if (game.user.isGM) {
    try {
      const trackerConfig = foundry.utils.deepClone(game.settings.get("core", "combatTrackerConfig") || {});
      trackerConfig.turnMarker ??= {};
      if (trackerConfig.turnMarker.enabled !== false) {
        trackerConfig.turnMarker.enabled = false;
        await game.settings.set("core", "combatTrackerConfig", trackerConfig);
      }
    } catch (error) {
      console.warn("Sword World 2.5 | Could not disable the default token turn marker.", error);
    }
  }
  game.socket.on(SOCKET, (payload, senderId) => {
    if (payload?.action === "sync-side-state") {
      const combat = game.combats.get(payload.combatId);
      if (combat) {
        queueSideControls(combat);
        openSideTurnWindow(combat);
      }
      return;
    }
    handleAction(payload, payload.userId || senderId);
  });
  // Automatic fixed-initiative assignment for monster combatants (GM only).
  // Fires for the initial encounter build and for later additions; it only
  // writes Combatant.initiative and never touches Side Initiative state, so
  // snapshots of an active phase (phase, playersDone, monstersDone) are
  // never modified by a mid-combat addition.
  Hooks.on("createCombatant", combatant => {
    if (!game.user.isGM) return;
    if (combatant.actor?.type !== "monster") return;
    const combat = combatant.combat ?? activeCombat();
    const promise = beginMonsterInitiative(combatant.actor, combat).catch(error => {
      console.warn("Sword World 2.5 | Automatic monster initiative assignment failed.", error);
    });
    pendingMonsterAssignments.set(combatant.id, promise);
    promise.finally(() => pendingMonsterAssignments.delete(combatant.id));
  });
  Hooks.on("createChatMessage", message => {
    if (!game.user.isGM) return;
    const request = message.getFlag(FLAG_SCOPE, "sideTurnRequest");
    // T5.1: the individual turn controls share the same GM-relay whisper as
    // End Turn; ownership and phase validation happen inside handleAction.
    if (request?.action === "end-player" || request?.action === "begin-turn" || request?.action === "finish-turn") handleAction(request, request.userId);
  });
  Hooks.on("renderCombatTracker", renderSideControls);
  // Foundry V14 renders the Combat Tracker through ApplicationV2 and may only
  // replace one of its template parts. The generic hook keeps the side panel
  // mounted when the class-specific render hook is skipped for a partial render.
  Hooks.on("renderApplicationV2", (app, html) => {
    const CombatTracker = foundry.applications.sidebar.tabs.CombatTracker;
    if (app instanceof CombatTracker) renderSideControls(app, html);
  });
  Hooks.on("updateCombat", combat => {
    if (!stateFor(combat)?.active) return;
    if (combat.turn !== null && game.user.isGM) combat.update({ turn:null });
    setTimeout(clearIndividualTurnMarkers, 0);
    setTimeout(clearIndividualTurnMarkers, 100);
    setTimeout(() => clearTrackerHighlights(), 0);
    queueSideControls(combat);
  });
  Hooks.on("updateActor", actor => {
    if ((actor.type === "character" || actor.type === "monster") && sideTurnWindow?.rendered) sideTurnWindow.render(false);
  });
  Hooks.on("canvasReady", () => {
    if (stateFor(activeCombat())?.active) clearIndividualTurnMarkers();
  });
  // Route the native tracker initiative controls (per-combatant dice,
  // Roll All, Roll NPC) through Side Initiative rules. Capture phase on the
  // document guarantees the native roll never starts before the interception.
  document.addEventListener("click", handleTrackerRollClick, true);
  Hooks.on("refreshToken", token => {
    if (!stateFor(activeCombat())?.active || !token?.turnMarker) return;
    token.turnMarker.visible = false;
    token.turnMarker.renderable = false;
  });
  if (stateFor(activeCombat())?.active) {
    queueSideControls(activeCombat());
    openSideTurnWindow(activeCombat());
  }
}
