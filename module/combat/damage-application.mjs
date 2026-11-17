import { isInstantXSpell, getInstantXSpellData, getInstantXSpellIdentity, parseSw25SpellDamageAttribute, resolveSw25CasterAnchor, getSpellDuration } from "../rules/spell-effects.mjs";
import { requestSw25EffectOperation } from "../effects/effect-relay.mjs";

const SOCKET = "system.sw25-taka";

const escape = value => foundry.utils.escapeHTML(String(value ?? ""));

// ── Weak point data parsing ───────────────────────────────────────────────

/**
 * Parse the Weak Point free text of a monster (e.g. "Accuracy +1") into the
 * damage-category bonus it grants.
 *
 * Consumer status (F2-T3): this is NOT a Monster Knowledge Registry
 * consumer. It reads the monster Actor's own `system.weakPoint` text; the
 * registry persists discovery EVIDENCE only and never copies that text.
 * It has no production call sites (attack-resolution.mjs imports it without
 * calling it), so the mechanical application of a discovered Weak Point to
 * attack/damage flows remains documented pending work, not a regression.
 * It does not depend on the retired `weaknessRegistry` setting and is kept
 * as a pure parsing helper. No production functionality was removed by F2-T3.
 * @param {*} value - Raw `system.weakPoint` text.
 * @returns {{category: string, bonus: number}|null} Parsed bonus, or null
 *   when the text is empty or unparseable.
 */
export function parseWeaknessData(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^([A-Za-zÀ-ÿ\s]+?)\s*[+-]?\s*(\d+)\s*(?:points?|puntos?)?$/i);
  if (!match) return null;
  const category = match[1].trim();
  const bonus = Number(match[2]);
  if (!category || !Number.isFinite(bonus)) return null;
  return { category, bonus };
}

export function damageApplicationButton(total, damageType = "physical", includeHalf = true, combatStyleId = null, actorUuid = null, spellUuid = null, castingContext = null) {
  const type = damageType === "magical" ? "magical" : "physical";
  const label = type === "magical" ? "Magical" : "Physical";
  const combatStyleAttr = combatStyleId ? ` data-combat-style-id="${String(combatStyleId)}"` : "";
  const actorUuidAttr = actorUuid ? ` data-actor-id="${String(actorUuid)}"` : "";
  const spellUuidAttr = spellUuid ? ` data-spell-uuid="${String(spellUuid)}"` : "";
  // T5.7-C: the casting context of an Instant/X spell (DEC-6 Success Value
  // and caster identity) travels on the button. `data-success-value` is only
  // written when a real number is provided: an ABSENT attribute is missing
  // mandatory data, while "0" is the legitimate minor-action SV — they are
  // never conflated.
  let castingContextAttrs = "";
  if (castingContext && typeof castingContext === "object") {
    if (typeof castingContext.successValue === "number" && Number.isFinite(castingContext.successValue)) {
      castingContextAttrs += ` data-success-value="${castingContext.successValue}"`;
    }
    if (typeof castingContext.casterUuid === "string" && castingContext.casterUuid !== "") {
      castingContextAttrs += ` data-caster-uuid="${escape(castingContext.casterUuid)}"`;
    }
  }
  return `<div class="sw25-damage-actions"><button type="button" class="sw25-apply-damage" data-sw25-chat-action="apply-damage" data-damage="${Number(total) || 0}" data-damage-type="${type}" data-damage-factor="1"${combatStyleAttr}${actorUuidAttr}${spellUuidAttr}${castingContextAttrs}><i class="fas fa-heart-broken"></i> Apply ${label} Damage</button>${includeHalf ? `<button type="button" class="sw25-apply-damage" data-sw25-chat-action="apply-damage" data-damage="${Number(total) || 0}" data-damage-type="${type}" data-damage-factor="0.5"${combatStyleAttr}${actorUuidAttr}${spellUuidAttr}${castingContextAttrs}><i class="fas fa-divide"></i> Apply Half Damage</button>` : ""}</div>`;
}

function defenseFor(actor, damageType) {
  if (actor.type === "character") {
    const key = damageType === "magical" ? "magicalDefence" : "defence";
    return actor.items
      .filter(item => item.type === "armour" && item.system.equipped)
      .reduce((sum, item) => sum + Number(item.system[key] ?? 0), 0);
  }
  if (damageType === "magical") return 0;
  if (actor.type !== "monster") return 0;
  return actor.system.combatStyles?.[0]?.defense;
}

export function numericCombatValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function monsterSectionLabel(style, index = 0) {
  return style?.sectionLabel || style?.style || `Section ${index + 1}`;
}

export async function applyDamage({ actor, total, damageType, factor = 1, combatStyleId = null }) {
  if (actor.type === "fellow") throw new Error("Fellows cannot take damage.");
  const damageTotal = numericCombatValue(total);
  if (damageTotal === null) throw new Error(`${actor.name} has an invalid damage total; damage was not applied.`);
  const raw = Math.max(0, Math.ceil(damageTotal * (Number(factor) === 0.5 ? 0.5 : 1)));
  let monsterStyle;
  let currentMonsterHP;
  let defense;
  if (actor.type === "monster") {
    const styles = Array.isArray(actor.system.combatStyles) ? actor.system.combatStyles : [];
    if (combatStyleId) {
      monsterStyle = styles.find(s => s.id === combatStyleId);
      if (!monsterStyle) throw new Error(`${actor.name} has no combat-style row with id "${combatStyleId}"; damage was not applied.`);
    } else {
      monsterStyle = styles[0];
    }
    if (!monsterStyle) throw new Error(`${actor.name} has no combat-statistics row to receive damage.`);
    const sectionLabel = monsterSectionLabel(monsterStyle);
    currentMonsterHP = numericCombatValue(monsterStyle.hp?.value);
    if (currentMonsterHP === null) {
      throw new Error(`${actor.name} — ${sectionLabel} has non-numeric HP "${monsterStyle.hp?.value ?? ""}"; damage was not applied.`);
    }
    if (damageType !== "magical") {
      const sourceDefense = numericCombatValue(monsterStyle.defense);
      defense = sourceDefense;
      if (defense === null) {
        throw new Error(`${actor.name} — ${sectionLabel} has non-numeric Defense "${monsterStyle.defense ?? ""}"; damage was not applied.`);
      }
    } else {
      defense = 0;
    }
  } else {
    defense = numericCombatValue(defenseFor(actor, damageType));
    if (defense === null) throw new Error(`${actor.name} has invalid Defense; damage was not applied.`);
  }
  defense = Math.max(0, defense);
  const applied = Math.max(0, raw - defense);
  if (actor.type === "monster") {
    const styles = foundry.utils.deepClone(Array.isArray(actor.system.combatStyles) ? actor.system.combatStyles : []);
    const styleIndex = styles.findIndex(s => s.id === (combatStyleId || styles[0]?.id));
    if (styleIndex === -1) throw new Error(`${actor.name} has no combat-statistics row to receive damage.`);
    // Section HP may go below 0 (Core Rulebook I p. 386/387: a section is
    // destroyed at 0 or fewer HP); the value is preserved without a lower
    // bound, exactly like character HP, so overflow damage is never lost.
    styles[styleIndex].hp.value = numericCombatValue(styles[styleIndex].hp?.value) - applied;
    await actor.update({ "system.combatStyles": styles });
  } else {
    const current = Number(actor.system.hp?.value ?? 0);
    await actor.update({ "system.hp.value": current - applied });
  }
  await ChatMessage.create({
    content: `<div class="sw25-chat-card"><h3>Damage Applied to ${escape(actor.name)}</h3><p><strong>Damage Applied:</strong> ${applied}</p></div>`
  });
}

async function requestDamage(button) {
  let actor = null;
  const targetUuid = button.dataset.actorId ?? null;
  if (targetUuid) {
    actor = game.actors.get(targetUuid) ?? (await fromUuid(targetUuid)) ?? null;
  }
  if (!actor) {
    // Fallback: targeted tokens first, then selected tokens
    const targeted = [...(game?.user?.targets ?? [])];
    if (targeted.length) {
      actor = targeted[0].actor;
    }
  }
  if (!actor) {
    const selected = [...(canvas?.tokens?.controlled || [])];
    if (selected.length) {
      actor = selected[0].actor;
    }
  }
  if (!actor) return ui.notifications.warn("No se pudo determinar el objetivo del daño. Seleccione o targetee un token.");
  if (actor.type === "fellow") return ui.notifications.info("Fellows are immune to damage.");
  const spellUuid = button.dataset.spellUuid ?? null;
  // T5.7-C: the Instant/X casting context travels on the button. An absent
  // `data-success-value` is MISSING data (no persistent component is built);
  // "0" is the legitimate minor-action SV (DEC-6) and is preserved as 0.
  const successValue = typeof button.dataset.successValue === "string" && button.dataset.successValue !== ""
    ? Number(button.dataset.successValue)
    : undefined;
  const casterUuid = button.dataset.casterUuid || null;
  const payload = {
    action:"apply-damage",
    actorUuid:actor.uuid,
    total:Number(button.dataset.damage ?? 0),
    damageType:button.dataset.damageType === "magical" ? "magical" : "physical",
    factor:Number(button.dataset.damageFactor) === 0.5 ? 0.5 : 1,
    combatStyleId: button.dataset.combatStyleId ?? null,
    ...(spellUuid ? { spellUuid, ...(successValue !== undefined ? { successValue } : {}), ...(casterUuid ? { casterUuid } : {}) } : {})
  };
  if (actor.isOwner) {
    try {
      await applyDamage({ actor, total:payload.total, damageType:payload.damageType, factor:payload.factor, combatStyleId: payload.combatStyleId });
      await applyInstantXPersistentEffect(actor, { spellUuid, casterUuid, successValue, damageType: payload.damageType });
    }
    catch (error) { return ui.notifications.error(error.message || "Could not apply damage."); }
    return;
  }
  if (!game.users.activeGM) return ui.notifications.error("An active GM is required to apply damage to that target.");
  game.socket.emit(SOCKET, payload);
  ui.notifications.info(`Damage sent to the GM for ${actor.name}.`);
}

export { applyInstantXPersistentEffect };

export function initializeDamageApplication() {
  Hooks.on("renderChatMessageHTML", (_message, html) => {
    html.querySelectorAll("[data-sw25-chat-action='apply-damage']").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        return requestDamage(event.currentTarget);
      });
    });
  });
  game.socket.on(SOCKET, async payload => {
    if (payload?.action !== "apply-damage" || !game.user.isGM) return;
    const actor = await fromUuid(payload.actorUuid);
    if (!actor) return ui.notifications.warn("The damage target could not be found.");
    try {
      await applyDamage({ actor, total:payload.total, damageType:payload.damageType, factor:payload.factor, combatStyleId: payload.combatStyleId });
      // T5.7-C: the GM path receives EXACTLY the same casting context as the
      // local path (spell UUID, caster UUID, Success Value, damage type);
      // both routes build the identical persistent application.
      await applyInstantXPersistentEffect(actor, {
        spellUuid: payload.spellUuid ?? null,
        casterUuid: payload.casterUuid ?? null,
        successValue: payload.successValue,
        damageType: payload.damageType ?? null
      });
    }
    catch (error) { ui.notifications.error(error.message || "Could not apply damage."); }
  });
}

/**
 * Create the persistent component of an Instant/X spell after its immediate
 * damage has been successfully applied. The immediate component (damage) is
 * already resolved by the caller; this function only creates the persistent
 * queue through EffectService (or the GM relay when the caller is not GM).
 *
 * T5.7-C contracts honored here:
 *   - `cast.successValue` is the Success Value of the CASTING roll,
 *     transmitted by the caller (DEC-6). It is NEVER derived from the
 *     damage total. SV 0 is the legitimate minor-action value; a missing
 *     SV is missing mandatory data and skips the creation.
 *   - `family`/`rank` follow DEC-1/DEC-16: the canonical authored spell
 *     name and its parsed version numeral.
 *   - `durationScale`/`durationAnchor` follow T5.2/D4: combat scales
 *     (rounds/turns) carry a resolved casterTurn anchor; manual scales
 *     (minutes/hours/days/other) carry no anchor and no invented counter.
 *   - `origin` is the spell document UUID (DocumentUUIDField),
 *     `casterUUID` the real caster Actor UUID, `damageType` the DEC-9
 *     { nature, attribute } when known.
 *
 * If no spell UUID is given, or the spell is not Instant/X, nothing happens.
 * When the persistent component cannot be created (missing Success Value,
 * unresolvable combat anchor, or a service rejection), the failure is
 * reported clearly and nothing is written.
 *
 * @param {Actor} actor - Target actor receiving the effect.
 * @param {object} [context] - Casting context.
 * @param {string|null} [context.spellUuid] - UUID of the spell Item.
 * @param {string|null} [context.casterUuid] - UUID of the caster Actor.
 * @param {number|undefined} [context.successValue] - Casting Success Value
 *   (DEC-6); absent means missing mandatory data, 0 is minor-action.
 * @param {string|null} [context.damageType] - Button damage channel
 *   ("magical"|"physical"); mapped to the DEC-9 nature.
 * @returns {Promise<void>}
 */
async function applyInstantXPersistentEffect(actor, context = {}) {
  const spellUuid = context?.spellUuid ?? null;
  if (!spellUuid) return;
  let spell = null;
  if (typeof game?.items?.get === "function") {
    spell = game.items.get(spellUuid) ?? null;
  }
  if (!spell && typeof fromUuid === "function") {
    try { spell = await fromUuid(spellUuid); } catch { spell = null; }
  }
  if (!spell || !isInstantXSpell(spell)) return;
  const spellData = getInstantXSpellData(spell);
  if (!spellData) {
    console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created: its Duration ("${getSpellDuration(spell)}") has no parseable persistent part.`);
    return;
  }
  // DEC-6: the Success Value is the casting roll result transmitted by the
  // caller, never inferred from the damage. A missing SV is missing
  // mandatory data: the persistent component is not created and no value is
  // fabricated.
  const successValue = context.successValue;
  if (typeof successValue !== "number" || !Number.isInteger(successValue) || successValue < 0) {
    console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created: no casting Success Value arrived on the chat card (missing mandatory data, DEC-6).`);
    return;
  }
  const casterUuid = typeof context.casterUuid === "string" && context.casterUuid.trim() !== "" ? context.casterUuid.trim() : null;
  const identity = getInstantXSpellIdentity(spell);
  if (!identity.family) {
    console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created: the spell has no usable identity name (DEC-1).`);
    return;
  }
  // T5.2/D4: combat scales (rounds/turns) REQUIRE a resolved anchor. The
  // approved default regime is casterTurn/begin (T5.0-R D5); when the caster
  // is not a combatant of the active encounter, no anchor is fabricated and
  // the persistent component is not created.
  let durationAnchor = null;
  if (spellData.durationScale === "rounds" || spellData.durationScale === "turns") {
    durationAnchor = resolveSw25CasterAnchor(casterUuid);
    if (!durationAnchor) {
      console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created: its ${spellData.durationScale}-scale duration requires a combat anchor (D4) and the caster is not a combatant of the active encounter.`);
      return;
    }
  }
  const attribute = parseSw25SpellDamageAttribute(spell);
  const nature = context.damageType === "magical" ? "Magical" : context.damageType === "physical" ? "Physical" : null;
  const application = {
    family: identity.family,
    rank: identity.rank,
    cast: { successValue },
    changes: [],
    durationScale: spellData.durationScale,
    initialDuration: spellData.initialDuration,
    remainingDuration: spellData.remainingDuration,
    durationAnchor,
    effectType: typeof spell.system?.effectType === "string" && spell.system.effectType.trim() !== "" ? spell.system.effectType.trim() : null,
    origin: spell.uuid ?? spellUuid,
    casterUUID: casterUuid,
    damageType: nature || attribute ? { nature, ...(attribute ? { attribute } : {}) } : null
  };
  const result = await requestSw25EffectOperation("apply", { actorUuid: actor.uuid, ...application });
  if (result && result.ok === false) {
    console.warn(`sw25-taka: the persistent component of "${spell.name}" was NOT created (${result.code}): ${result.error}`);
  }
}

