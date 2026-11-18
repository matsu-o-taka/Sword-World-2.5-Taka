import { damageApplicationButton } from "../combat/damage-application.mjs";
import { getSpellDuration, parseSpellNameIdentity, parseSw25SpellDamageAttribute } from "./spell-data.mjs";

const FLAG_SCOPE = "sw25-taka";
const FLAG_KEY = "timedRegeneration";
const SOCKET = "system.sw25-taka";
const REGENERATION_SPECS = {
  "reproducer-bloody-petal":{ sourceKey:"reproducer-bloody-petal", healing:5, turns:6 },
  "reproducer-living-tree":{ sourceKey:"reproducer-living-tree", healing:10, turns:6 }
};

const escape = value => foundry.utils.escapeHTML(String(value ?? ""));

export function regenerationSpellData(spell) {
  const source = String(spell?.system?.sourceUrl || "").toLowerCase();
  const name = String(spell?.name || "").toLowerCase();
  if (source.includes("spell:reproducer-bloody-petal") || name.includes("reproducer/bloody petal") || name.includes("bloody petal")) {
    return REGENERATION_SPECS["reproducer-bloody-petal"];
  }
  if (source.includes("spell:reproducer-living-tree") || name.includes("reproducer/living tree") || name.includes("living tree")) {
    return REGENERATION_SPECS["reproducer-living-tree"];
  }
  return null;
}

export function isExhaustiveSucking(spell) {
  const source = String(spell?.system?.sourceUrl || "").toLowerCase();
  const name = String(spell?.name || "").trim().toLowerCase();
  return source.includes("spell:exhaustive-sucking") || name === "exhaustive sucking";
}

export const exhaustiveSuckingTotal = magicPowerRoll => 18 + (Number(magicPowerRoll) || 0);

// Unique collapsible-detail anchor per card (chat messages accumulate, so a
// fixed id would always resolve to the FIRST message carrying it).
let exhaustiveCardCounter = 0;

export async function resolveExhaustiveSucking({ actor, spell, castingClass }) {
  const previous = actor.getFlag(FLAG_SCOPE, "lastMagicPowerRoll");
  if (!previous || previous.criticalFailure || !Number.isFinite(Number(previous.total)) || (previous.classId && String(previous.classId) !== String(castingClass.id))) {
    ui.notifications.warn(`Roll ${castingClass.name} Magic Power before casting ${spell.name}.`);
    return false;
  }
  const total = exhaustiveSuckingTotal(previous.total);
  exhaustiveCardCounter += 1;
  const detailId = `exhaustive-sucking-${exhaustiveCardCounter}`;
  await ChatMessage.create({
    speaker:ChatMessage.getSpeaker({ actor }),
    content:`<div class="sw25-chat-card sw25-damage-card sw25-spell-damage"><h3>${escape(spell.name)}</h3><div class="sw25-damage-stat" data-target="${detailId}"><div class="sw25-damage-stat-summary" role="button" tabindex="0"><span class="sw25-damage-roll">${Number(previous.total)}</span><span class="sw25-damage-plus">+</span><span class="sw25-damage-bonus">18</span><span class="sw25-damage-equals">=</span><span class="sw25-damage-total">${total}</span></div><div class="sw25-damage-stat-detail" id="${detailId}" style="display:none;"><ul class="sw25-roll-breakdown"><li><strong>Previous Magic Power roll:</strong> ${Number(previous.total)}</li><li><strong>Damage:</strong> 18 + ${Number(previous.total)}</li></ul></div></div><p class="sw25-weapon-total"><strong>Total: ${total} physical damage</strong></p>${damageApplicationButton(total, "physical", false)}<button type="button" data-sw25-chat-action="heal-exhaustive-sucking" data-actor-uuid="${escape(actor.uuid)}" data-healing="${total}"><i class="fas fa-heart"></i> Heal Caster ${total} HP</button><p><em>Do not apply the healing if the target has Poison Immunity.</em></p></div>`
  });
  return true;
}

export function regenerationStep(currentHP, maximumHP, turnsRemaining, healing = 5) {
  const current = Math.max(0, Number(currentHP) || 0);
  const maximum = Math.max(current, Number(maximumHP) || current);
  if (current <= 0 || Number(turnsRemaining) <= 0) return { ended:true, healed:0, hp:current, turnsRemaining:0 };
  const hp = Math.min(maximum, current + Math.max(0, Number(healing) || 0));
  const remaining = Math.max(0, Number(turnsRemaining) - 1);
  return { ended:remaining === 0, healed:hp - current, hp, turnsRemaining:remaining };
}

function effectButton(actor, effect) {
  return `<button type="button" data-sw25-chat-action="end-regeneration" data-actor-uuid="${escape(actor.uuid)}" data-effect-id="${escape(effect.id)}"><i class="fas fa-times"></i> End Effect Early</button>`;
}

async function storeEffects(actor, effects) {
  if (effects.length) await actor.setFlag(FLAG_SCOPE, FLAG_KEY, effects);
  else await actor.unsetFlag(FLAG_SCOPE, FLAG_KEY);
}

async function beginRegeneration({ target, casterName, casterUuid = "", spellName, sourceKey, healing, turns }) {
  const current = target.getFlag(FLAG_SCOPE, FLAG_KEY);
  const effects = Array.isArray(current) ? [...current] : [];
  const effect = {
    id:foundry.utils.randomID(), sourceKey, spellName, casterName, casterUuid,
    healing:Number(healing), turnsRemaining:Number(turns), totalTurns:Number(turns),
    combatId:game.combat?.id || ""
  };
  const next = effects.filter(entry => entry.sourceKey !== sourceKey);
  next.push(effect);
  await storeEffects(target, next);
  await ChatMessage.create({
    content:`<div class="sw25-chat-card"><h3>${escape(spellName)}</h3><p><strong>${escape(target.name)}</strong> will recover ${Number(healing)} HP at the end of each of their next ${Number(turns)} turns.</p><p>The effect ends immediately if their HP reaches 0.</p>${effectButton(target, effect)}</div>`
  });
  return effect;
}

export async function requestRegenerationSpell({ target, caster, spell }) {
  const data = regenerationSpellData(spell);
  if (!data) return;
  const payload = { action:"begin-regeneration", targetUuid:target.uuid, casterUuid:caster.uuid, casterName:caster.name, spellName:spell.name, ...data };
  if (target.isOwner) return beginRegeneration({ target, casterName:caster.name, casterUuid:caster.uuid, spellName:spell.name, ...data });
  if (!game.users.activeGM) return ui.notifications.error(`An active GM is required to apply ${spell.name} to that target.`);
  game.socket.emit(SOCKET, payload);
  ui.notifications.info(`${spell.name} sent to the GM for ${target.name}.`);
}

export async function processRegenerationTurn(actor) {
  const stored = actor?.getFlag(FLAG_SCOPE, FLAG_KEY);
  if (!Array.isArray(stored) || !stored.length) return;
  const currentHP = Number(actor.system.hp?.value ?? 0);
  if (currentHP <= 0) return endRegenerationAtZero(actor);

  let hp = currentHP;
  const maximumHP = Number(actor.system.hp?.max ?? hp);
  const remaining = [];
  for (const effect of stored) {
    const step = regenerationStep(hp, maximumHP, effect.turnsRemaining, effect.healing);
    hp = step.hp;
    const updated = { ...effect, turnsRemaining:step.turnsRemaining };
    const turnNumber = Math.max(1, Number(effect.totalTurns || 6) - Number(effect.turnsRemaining || 6) + 1);
    await ChatMessage.create({
      content:`<div class="sw25-chat-card"><h3>${escape(effect.spellName)} — Regeneration</h3><p><strong>${escape(actor.name)}</strong> recovers <strong>${step.healed} HP</strong>. (${hp}/${maximumHP})</p><p>Turn ${turnNumber} of ${Number(effect.totalTurns || 6)}.</p>${step.ended ? "<p><em>The effect has ended.</em></p>" : effectButton(actor, updated)}</div>`
    });
    if (!step.ended) remaining.push(updated);
  }
  if (hp !== currentHP) await actor.update({ "system.hp.value":hp });
  await storeEffects(actor, remaining);
}

export async function endRegenerationAtZero(actor) {
  const effects = actor?.getFlag(FLAG_SCOPE, FLAG_KEY);
  if (!Array.isArray(effects) || !effects.length) return;
  await actor.unsetFlag(FLAG_SCOPE, FLAG_KEY);
  await ChatMessage.create({ content:`<div class="sw25-chat-card"><h3>Regeneration Ended</h3><p>${escape(actor.name)} reached 0 HP. All regeneration effects end.</p></div>` });
}

async function cancelRegeneration(actor, effectId) {
  const stored = actor?.getFlag(FLAG_SCOPE, FLAG_KEY);
  if (!Array.isArray(stored)) return;
  const effect = stored.find(entry => entry.id === effectId);
  if (!effect) return ui.notifications.info("That regeneration effect has already ended.");
  await storeEffects(actor, stored.filter(entry => entry.id !== effectId));
  await ChatMessage.create({ content:`<div class="sw25-chat-card"><h3>${escape(effect.spellName)} Ended Early</h3><p>The regeneration effect on ${escape(actor.name)} was ended early.</p></div>` });
}

async function requestCancel(button) {
  const actor = await fromUuid(button.dataset.actorUuid);
  if (!actor) return ui.notifications.warn("The regeneration target could not be found.");
  const payload = { action:"end-regeneration", actorUuid:actor.uuid, effectId:button.dataset.effectId };
  if (actor.isOwner) return cancelRegeneration(actor, payload.effectId);
  if (!game.users.activeGM) return ui.notifications.error("An active GM is required to end that effect.");
  game.socket.emit(SOCKET, payload);
}

async function applyExhaustiveHealing(actor, amount, message) {
  if (message?.getFlag(FLAG_SCOPE, "exhaustiveHealingApplied")) return ui.notifications.info("This healing has already been applied.");
  const current = Number(actor.system.hp?.value ?? 0);
  const maximum = Math.max(current, Number(actor.system.hp?.max ?? current));
  const next = Math.min(maximum, current + Math.max(0, Number(amount) || 0));
  await actor.update({ "system.hp.value":next });
  if (message) await message.setFlag(FLAG_SCOPE, "exhaustiveHealingApplied", true);
  await ChatMessage.create({ content:`<div class="sw25-chat-card"><h3>Exhaustive Sucking Healing</h3><p><strong>${escape(actor.name)}</strong> recovers <strong>${next - current} HP</strong>. (${next}/${maximum})</p></div>` });
}

async function requestExhaustiveHealing(message, button) {
  const actor = await fromUuid(button.dataset.actorUuid);
  if (!actor) return ui.notifications.warn("The caster could not be found.");
  const amount = Number(button.dataset.healing || 0);
  if (actor.isOwner) return applyExhaustiveHealing(actor, amount, message);
  if (!game.users.activeGM) return ui.notifications.error("An active GM is required to heal that caster.");
  game.socket.emit(SOCKET, { action:"heal-exhaustive-sucking", actorUuid:actor.uuid, amount, messageId:message.id });
}

// ── Instant/X spell detection (T5.7) ───────────────────────────────────────

/**
 * Read the STORED duration of a spell (the Effects-engine representation:
 * the exact normalized text, e.g. "Instant" or "Instant/3 rounds").
 * Implemented in rules/spell-data.mjs — the single shared reader — and
 * re-exported here for the Effects engine's existing consumers.
 * @param {object} spell - Spell Item document.
 * @returns {string|null} The duration string, or null when absent.
 */
export { getSpellDuration } from "./spell-data.mjs";

/**
 * Whether a spell is an Instant/X effect: its duration declares an immediate
 * part plus a persistent part after the slash (e.g. "Instant/3 rounds").
 * A bare "Instant" duration (immediate only, no persistent queue) is NOT
 * Instant/X.
 * @param {object} spell - Spell Item document.
 * @returns {boolean}
 */
export function isInstantXSpell(spell) {
  const duration = getSpellDuration(spell);
  if (!duration) return false;
  return /^instant\/\s*\S/i.test(duration);
}

/**
 * Extract the persistent-effect data for an Instant/X spell from its
 * metadata duration. Returns null when the spell is not Instant/X or when
 * no parseable persistent duration exists.
 *
 * Duration parsing (verified against all 38 Instant/X spells of the
 * sw25-library compendium, T5.7-C):
 *   - "Instant/3 rounds" / "Instant/2 turns" → counted combat scale.
 *   - "Instant/10 seconds (1 round)" → the parenthetical is the authoritative
 *     rounds conversion; the scale is combat ("rounds").
 *   - "Instant/3 minutes (18 rounds)", "Instant/1 Day" → manual scale
 *     (minutes/hours/days, DEC-23): no counter is declared, because a combat
 *     counter on a manual scale would make the duration engine purge the
 *     effect at combat end, violating DEC-40 (the persistent part outlives
 *     the combat).
 *   - Bare seconds without a parenthetical conversion and unclassifiable
 *     values ("Instant/Various") → scale "other" (DEC-32): GM-managed.
 *
 * The returned `durationScale` is always an approved SW25_DURATION_SCALES id;
 * `initialDuration`/`remainingDuration` are positive integers only for the
 * counted combat scales and null otherwise (never invented, DEC-23).
 *
 * @param {object} spell - Spell Item document.
 * @returns {{durationScale: string, initialDuration: number|null,
 *   remainingDuration: number|null}|null}
 */
export function getInstantXSpellData(spell) {
  const duration = getSpellDuration(spell);
  if (!duration) return null;
  const match = duration.match(/^instant\/\s*(.+)$/i);
  if (!match) return null;
  const part = match[1].trim();
  // Direct combat-scale counter: "Instant/3 rounds", "Instant/2 turns".
  let m = part.match(/^(\d+)\s*(rounds?|turns?)$/i);
  if (m) {
    const count = Number(m[1]);
    if (!Number.isInteger(count) || count < 1) return null;
    const durationScale = m[2].toLowerCase().startsWith("turn") ? "turns" : "rounds";
    return { durationScale, initialDuration: count, remainingDuration: count };
  }
  // Seconds with an explicit parenthetical rounds conversion.
  m = part.match(/^(\d+)\s*seconds?\s*\(\s*(\d+)\s*rounds?\s*\)$/i);
  if (m) {
    const count = Number(m[2]);
    if (!Number.isInteger(count) || count < 1) return null;
    return { durationScale: "rounds", initialDuration: count, remainingDuration: count };
  }
  // Manual scales (DEC-23): no counters, no combat anchor.
  m = part.match(/^(\d+)\s*(minutes?|hours?|days?)\b/i);
  if (m) {
    const unit = m[2].toLowerCase();
    const durationScale = unit.startsWith("hour") ? "hours" : unit.startsWith("day") ? "days" : "minutes";
    return { durationScale, initialDuration: null, remainingDuration: null };
  }
  // Bare seconds and unclassifiable values ("Various"): GM-managed "other".
  return { durationScale: "other", initialDuration: null, remainingDuration: null };
}

// ── Instant/X identity (T5.7-C: DEC-1/DEC-16) ──────────────────────────────
//
// The family/rank parser lives in rules/spell-data.mjs
// (`parseSpellNameIdentity`) and is shared with the importer, which uses it
// to populate `system.rank`. No duplicate maps or parsing exist here.

/**
 * Resolve the stacking identity (DEC-1) of an Instant/X spell.
 *
 * `family` is the canonical base name as authored (authoring markers like
 * ⏩/‡/†/△ stay in the family; DEC-1 comparison normalizes case at
 * comparison time, never at storage). `rank` is the stored integer
 * `system.rank` (0 = base) when present, falling back to the version numeral
 * parsed from the authored name via the SHARED parser
 * `parseSpellNameIdentity` (rules/spell-data.mjs) — the same implementation
 * the importer uses to populate `system.rank`. The rank is never taken from
 * the spell level.
 *
 * Parsing rules of the shared name parser (validated against all 656
 * compendium spells: 22 ranked names parse correctly, 0 false positives):
 *   - A trailing attached full-width numeral (Ⅰ..Ⅹ) is a rank.
 *   - A trailing SPACE-SEPARATED ASCII Roman numeral in UPPERCASE
 *     (case-sensitive: "Mana Max" never matches) is a rank.
 *   - Everything else: the full authored name is the family, rank 0.
 *
 * @param {object} spell - Spell Item document.
 * @returns {{family: string, rank: number}}
 */
export function getInstantXSpellIdentity(spell) {
  const parsed = parseSpellNameIdentity(String(spell?.name || "").trim());
  const storedRank = Number(spell?.system?.rank);
  const rank = Number.isInteger(storedRank) && storedRank >= 0 ? storedRank : parsed.rank;
  return { family: parsed.family, rank };
}

/**
 * Read the typed damage attribute of a spell. Implemented in
 * rules/spell-data.mjs (reading the structured `system.damageType.attribute`
 * field) and re-exported here for the existing consumers.
 * @param {object} spell - Spell Item document.
 * @returns {string|null} The attribute name, or null when absent.
 */
export { parseSw25SpellDamageAttribute } from "./spell-data.mjs";

/**
 * Resolve the combat anchor (D4/T5.2) of the caster of an Instant/X spell:
 * the combatant of the ACTIVE encounter whose actor matches the caster
 * UUID. The approved default regime for round-scale spells is
 * `casterTurn` with edge `begin` (T5.0-R D5); `targetTurn` exceptions need
 * per-spell rule data that the current spell schema does not carry, so no
 * targetTurn anchor is ever invented here (documented limitation).
 *
 * The caster must be a combatant of the active encounter: an out-of-combat
 * casting has no turn order, so no anchor is fabricated (missing mandatory
 * data → no persistent component, D4 philosophy).
 *
 * @param {string|null} casterUuid - UUID of the caster Actor ("Actor.<id>").
 * @returns {object|null} `{ regime, edge, combatantId, tokenId? }`, or null
 *   when there is no active combat or the caster is not a combatant.
 */
export function resolveSw25CasterAnchor(casterUuid) {
  const combat = game?.combat ?? null;
  const collection = combat?.combatants ?? null;
  if (!casterUuid || !collection) return null;
  const list = typeof collection.values === "function" ? [...collection.values()] : [...collection];
  const combatant = list.find(entry => entry?.actorUuid === casterUuid
    || entry?.actor?.uuid === casterUuid
    || (entry?.actor?.id && casterUuid === `Actor.${entry.actor.id}`));
  if (!combatant?.id) return null;
  return {
    regime: "casterTurn",
    edge: "begin",
    state: "resolved",
    combatantId: combatant.id,
    ...(combatant.tokenId ? { tokenId: combatant.tokenId } : {})
  };
}

export function initializeSpellEffects() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    html.querySelectorAll("[data-sw25-chat-action='end-regeneration']").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        return requestCancel(event.currentTarget);
      });
    });
    const healingButton = html.querySelector("[data-sw25-chat-action='heal-exhaustive-sucking']");
    if (healingButton) {
      if (message.getFlag(FLAG_SCOPE, "exhaustiveHealingApplied")) {
        healingButton.disabled = true;
        healingButton.innerHTML = '<i class="fas fa-check"></i> Healing Applied';
      }
      healingButton.addEventListener("click", event => {
        event.preventDefault();
        return requestExhaustiveHealing(message, event.currentTarget);
      });
    }
  });
  Hooks.on("updateActor", actor => {
    if (!game.user.isGM || actor.type !== "character" || Number(actor.system.hp?.value ?? 1) > 0) return;
    endRegenerationAtZero(actor);
  });
  game.socket.on(SOCKET, async (payload, senderId) => {
    if (!game.user.isGM) return;
    const requestingUser = game.users.get(senderId);
    if (payload?.action === "begin-regeneration") {
      const target = await fromUuid(payload.targetUuid);
      const caster = await fromUuid(payload.casterUuid);
      const regeneration = REGENERATION_SPECS[payload.sourceKey];
      if (regeneration && requestingUser && target?.type === "character" && caster?.testUserPermission(requestingUser, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
        await beginRegeneration({ target, casterName:payload.casterName, casterUuid:payload.casterUuid, spellName:payload.spellName, ...regeneration });
      }
    }
    if (payload?.action === "end-regeneration") {
      const actor = await fromUuid(payload.actorUuid);
      const effects = actor?.getFlag(FLAG_SCOPE, FLAG_KEY);
      const effect = Array.isArray(effects) ? effects.find(entry => entry.id === payload.effectId) : null;
      const caster = effect?.casterUuid ? await fromUuid(effect.casterUuid) : null;
      const allowed = requestingUser && (actor?.testUserPermission(requestingUser, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) || caster?.testUserPermission(requestingUser, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
      if (allowed) await cancelRegeneration(actor, payload.effectId);
    }
    if (payload?.action === "heal-exhaustive-sucking") {
      const actor = await fromUuid(payload.actorUuid);
      const message = game.messages.get(payload.messageId);
      if (requestingUser && actor?.testUserPermission(requestingUser, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
        await applyExhaustiveHealing(actor, payload.amount, message);
      }
    }
  });
}
