const SOCKET = "system.sword-world-25";

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

export function damageApplicationButton(total, damageType = "physical", includeHalf = true, combatStyleId = null, actorUuid = null) {
  const type = damageType === "magical" ? "magical" : "physical";
  const label = type === "magical" ? "Magical" : "Physical";
  const combatStyleAttr = combatStyleId ? ` data-combat-style-id="${String(combatStyleId)}"` : "";
  const actorUuidAttr = actorUuid ? ` data-actor-id="${String(actorUuid)}"` : "";
  return `<div class="sw25-damage-actions"><button type="button" class="sw25-apply-damage" data-sw25-chat-action="apply-damage" data-damage="${Number(total) || 0}" data-damage-type="${type}" data-damage-factor="1"${combatStyleAttr}${actorUuidAttr}><i class="fas fa-heart-broken"></i> Apply ${label} Damage</button>${includeHalf ? `<button type="button" class="sw25-apply-damage" data-sw25-chat-action="apply-damage" data-damage="${Number(total) || 0}" data-damage-type="${type}" data-damage-factor="0.5"${combatStyleAttr}${actorUuidAttr}><i class="fas fa-divide"></i> Apply Half Damage</button>` : ""}</div>`;
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
    styles[styleIndex].hp.value = Math.max(0, numericCombatValue(styles[styleIndex].hp?.value) - applied);
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
  const payload = {
    action:"apply-damage",
    actorUuid:actor.uuid,
    total:Number(button.dataset.damage ?? 0),
    damageType:button.dataset.damageType === "magical" ? "magical" : "physical",
    factor:Number(button.dataset.damageFactor) === 0.5 ? 0.5 : 1,
    combatStyleId: button.dataset.combatStyleId ?? null
  };
  if (actor.isOwner) {
    try { return await applyDamage({ actor, total:payload.total, damageType:payload.damageType, factor:payload.factor, combatStyleId: payload.combatStyleId }); }
    catch (error) { return ui.notifications.error(error.message || "Could not apply damage."); }
  }
  if (!game.users.activeGM) return ui.notifications.error("An active GM is required to apply damage to that target.");
  game.socket.emit(SOCKET, payload);
  ui.notifications.info(`Damage sent to the GM for ${actor.name}.`);
}

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
    try { await applyDamage({ actor, total:payload.total, damageType:payload.damageType, factor:payload.factor, combatStyleId: payload.combatStyleId }); }
    catch (error) { ui.notifications.error(error.message || "Could not apply damage."); }
  });
}
