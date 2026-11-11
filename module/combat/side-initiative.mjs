import { expireNaturalPower, naturalPowerRemainder } from "../rules/spell-damage.mjs";
import { processRegenerationTurn } from "../rules/spell-effects.mjs";
import { resolveClassAssignment } from "../rules/skill-resolution.mjs";
import { abilityBonus } from "../rules/weapon-damage.mjs";
import { criticalFailureHTML, markCriticalFailure } from "../rules/critical-failure.mjs";

const FLAG_SCOPE = "sw25-taka";
const FLAG_KEY = "sideInitiative";
const SOCKET = "system.sw25-taka";
let sideTurnWindow = null;

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
  await combat.setFlag(FLAG_SCOPE, FLAG_KEY, state);
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
      canEndMonsters:state?.phase === "monsters" && game.user.isGM,
      gmMonsterControls:state?.phase === "monsters" && game.user.isGM,
      monsters:monsters.map(combatant => ({ id:combatant.id, name:combatant.name, done:monstersDone.has(combatant.id) })),
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

async function handleAction(payload, userId) {
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
    for (const combatant of validCombatants) {
      await processRegenerationTurn(combatant.actor);
      await expireNaturalPower(combatant.actor);
    }
    const playersDone = [...new Set([...alreadyDone, ...valid])];
    const allIds = characterCombatants(combat).map(combatant => combatant.id);
    const complete = allIds.length > 0 && allIds.every(id => playersDone.includes(id));
    if (!complete) await saveState(combat, { ...state, playersDone, phase:"players" });
    else if (state.firstPhase === "players") {
      await saveState(combat, { ...state, playersDone, monstersDone:[], phase:"monsters" });
      await announce("<h3>Monster Turn</h3><p>All players have ended their turns.</p>");
    } else {
      const nextRound = Math.max(1, Number(combat.round || state.round || 1) + 1);
      await combat.update({ round:nextRound, turn:null });
      await saveState(combat, { ...state, playersDone:[], monstersDone:[], phase:"monsters", round:nextRound });
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
    const monstersDone = [...new Set([...alreadyDone, ...valid])];
    const allIds = monsterCombatants(combat).map(combatant => combatant.id);
    const complete = allIds.length > 0 && allIds.every(id => monstersDone.includes(id));
    if (!complete) await saveState(combat, { ...state, monstersDone, phase:"monsters" });
    else await completeMonsterPhase(combat, state, monstersDone);
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

/** Shared transition when the monster phase finishes (all marked or early end). */
async function completeMonsterPhase(combat, state, monstersDone) {
  const transition = sideTransition(state.firstPhase, "monsters");
  if (!transition.newRound) {
    await saveState(combat, { ...state, phase:transition.phase, playersDone:[], monstersDone });
    await announce("<h3>Player Turn</h3><p>The monsters have ended their turn.</p>");
  } else {
    const nextRound = Math.max(1, Number(combat.round || state.round || 1) + 1);
    await combat.update({ round:nextRound, turn:null });
    await saveState(combat, { ...state, phase:transition.phase, playersDone:[], monstersDone:[], round:nextRound });
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
    if (request?.action === "end-player") handleAction(request, request.userId);
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
