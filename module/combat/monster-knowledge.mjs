import { isCriticalFailure } from "../rules/critical-failure.mjs";

const SYSTEM_ID = "sword-world-25";
const STATE_KEY = "concealedMainSection";
const SECTION_NAMES = ["musician", "instrument"];
const CURSED_ARTIST_SOURCE = /(?:^|\/)monster:cursed-artist(?:$|[?#])/i;
const WEAKNESS_REGISTRY_KEY = "weaknessRegistry";
const pendingInitializations = new WeakMap();

const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
const normalized = value => String(value ?? "").trim().toLowerCase();

// ── Species identification ────────────────────────────────────────────────

export function normalizeSpeciesId(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.normalize("NFC").replace(/\s+/g, " ").toLowerCase();
}

export function speciesId(actor) {
  if (!actor || !actor.system) return null;
  const species = actor.system?.species;
  if (!species) return null;
  return normalizeSpeciesId(species);
}

// ── World weakness registry (game.settings) ───────────────────────────────

export function getWeaknessRegistry() {
  const value = game?.settings?.get(SYSTEM_ID, WEAKNESS_REGISTRY_KEY);
  return Array.isArray(value) ? [...value] : [];
}

export function clearWeaknessRegistry() {
  game?.settings?.set(SYSTEM_ID, WEAKNESS_REGISTRY_KEY, []);
}

export function registerSpeciesWeakness(speciesIdentifier) {
  const id = normalizeSpeciesId(speciesIdentifier);
  if (!id) return;
  const registry = getWeaknessRegistry();
  if (!registry.includes(id)) {
    registry.push(id);
    game?.settings?.set(SYSTEM_ID, WEAKNESS_REGISTRY_KEY, registry);
  }
}

export function withdrawSpeciesWeakness(speciesIdentifier) {
  const id = normalizeSpeciesId(speciesIdentifier);
  if (!id) return;
  const registry = getWeaknessRegistry();
  const index = registry.indexOf(id);
  if (index >= 0) {
    registry.splice(index, 1);
    game?.settings?.set(SYSTEM_ID, WEAKNESS_REGISTRY_KEY, registry);
  }
}

export function speciesWeaknessKnown(monster) {
  if (!monster || !monster.system) return false;
  const id = speciesId(monster);
  if (!id) return false;
  return getWeaknessRegistry().includes(id);
}

export function isSpeciesWeaknessKnown(speciesIdentifier) {
  const id = normalizeSpeciesId(speciesIdentifier);
  if (!id) return false;
  return getWeaknessRegistry().includes(id);
}

// ── Monster stat/weakness revelation ──────────────────────────────────────

function applyRevealToActor(actor, revealed) {
  actor.system.revealed = revealed;
  return actor.update({ "system.revealed": revealed });
}

export async function revealMonsterStats(actor, { notify = true } = {}) {
  if (!actor || actor.type !== "monster") return { status: "invalid-actor" };
  if (!game.user.isGM) return { status: "denied" };
  await applyRevealToActor(actor, true);
  if (notify) ui.notifications.info(`${actor.name} stats revealed.`);
  return { status: "revealed" };
}

export async function revealMonsterWeakness(actor, { notify = true } = {}) {
  if (!actor || actor.type !== "monster") return { status: "invalid-actor" };
  if (!game.user.isGM) return { status: "denied" };
  const id = speciesId(actor);
  if (!id) return { status: "no-species" };
  registerSpeciesWeakness(id);
  // Weakness knowledge is shared by species; statistics revelation is
  // individual to each actor and is not automatically granted here.
  if (notify) ui.notifications.info(`Weakness registered for species ${id}.`);
  return { status: "revealed" };
}

export async function toggleMonsterStats(actor, { notify = true } = {}) {
  if (!actor || actor.type !== "monster") return { status: "invalid-actor" };
  if (!game.user.isGM || !actor.isOwner) return { status: "denied" };
  const revealed = !Boolean(actor.system.revealed);
  await applyRevealToActor(actor, revealed);
  if (notify) ui.notifications.info(revealed ? `${actor.name} stats revealed.` : `${actor.name} stats hidden.`);
  return { status: revealed ? "revealed" : "hidden" };
}

export async function toggleMonsterWeakness(actor, { notify = true } = {}) {
  if (!actor || actor.type !== "monster") return { status: "invalid-actor" };
  if (!game.user.isGM || !actor.isOwner) return { status: "denied" };
  const id = speciesId(actor);
  if (!id) return { status: "no-species" };
  const known = isSpeciesWeaknessKnown(id);
  if (known) {
    withdrawSpeciesWeakness(id);
  } else {
    registerSpeciesWeakness(id);
    // Weakness knowledge is shared by species; statistics revelation is
    // individual to each actor and is not automatically granted here.
  }
  if (notify) ui.notifications.info(known ? `Weakness withdrawn for ${id}.` : `Weakness registered for ${id}.`);
  return { status: known ? "withdrawn" : "registered" };
}

export function getConcealedMainSectionSections(actor) {
  const system = actor?.system;
  const isCursedArtistSource = CURSED_ARTIST_SOURCE.test(String(system?.sourceUrl ?? ""));
  if (actor?.type !== "monster" || !system || !isCursedArtistSource
    || system.mainSection?.type !== "special"
    || !/^special(?:\s*,?\s*see below)?$/i.test(String(system.mainSection.sourceValue ?? ""))
    || !Array.isArray(system.uniqueSkills)
    || !system.uniqueSkills.some(skill => /^◯\s*Concealed Main Section$/i.test(String(skill.title ?? "").trim()))) return [];
  if (!Array.isArray(system.sections) || system.sections.length !== SECTION_NAMES.length) return [];
  const sections = system.sections.filter(section => SECTION_NAMES.includes(normalized(section.name)));
  if (sections.length !== SECTION_NAMES.length
    || new Set(sections.map(section => normalized(section.name))).size !== SECTION_NAMES.length) return [];
  return sections;
}

function cryptoRandomIndex(length) {
  if (!globalThis.crypto?.getRandomValues) throw new Error("A secure random source is unavailable for concealed Main Section selection.");
  const range = 0x100000000;
  const limit = Math.floor(range / length) * length;
  const values = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(values); while (values[0] >= limit);
  return values[0] % length;
}

export function selectConcealedMainSection(actor, randomIndex = cryptoRandomIndex) {
  const sections = getConcealedMainSectionSections(actor);
  if (sections.length !== SECTION_NAMES.length) {
    throw new Error(`${actor?.name || "Monster"} does not have a valid Concealed Main Section profile.`);
  }
  const index = randomIndex(sections.length);
  if (!Number.isInteger(index) || index < 0 || index >= sections.length) {
    throw new Error("Concealed Main Section selection returned an invalid index.");
  }
  return sections[index].name;
}

function tokenState(token) {
  return token.getFlag?.(SYSTEM_ID, STATE_KEY)
    ?? token.flags?.[SYSTEM_ID]?.[STATE_KEY]
    ?? null;
}

function privateJournalData(token, sectionName) {
  return {
    name: `SW25 Concealed Main Section - ${token.name}`,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    pages: [{
      name: "GM-only selection",
      type: "text",
      text: {
        content: `<h2>Concealed Main Section</h2><p><strong>Selected section:</strong> ${escape(sectionName)}</p><p><strong>Token:</strong> ${escape(token.name)}</p>`
      }
    }],
    flags: {
      [SYSTEM_ID]: {
        [STATE_KEY]: { tokenUuid: token.uuid, section: sectionName }
      }
    }
  };
}

export async function initializeConcealedMainSectionToken(token, { randomIndex = cryptoRandomIndex } = {}) {
  if (!game.user.isGM || !getConcealedMainSectionSections(token.actor).length) return null;
  const pending = pendingInitializations.get(token);
  if (pending) return pending;
  const current = tokenState(token);
  if (current?.secretJournalUuid) return current;
  if (current) throw new Error(`${token.name} has an incomplete concealed-section state; it was not rerolled.`);

  const initialization = (async () => {
    const sectionName = selectConcealedMainSection(token.actor, randomIndex);
    const journal = await JournalEntry.create(privateJournalData(token, sectionName));
    const next = { secretJournalUuid: journal.uuid, revealed: false };
    try {
      await token.setFlag(SYSTEM_ID, STATE_KEY, next);
    } catch (error) {
      await journal.delete();
      throw error;
    }
    return next;
  })();
  pendingInitializations.set(token, initialization);
  try {
    return await initialization;
  } finally {
    if (pendingInitializations.get(token) === initialization) pendingInitializations.delete(token);
  }
}

async function privateSelectionForToken(token) {
  const state = tokenState(token);
  if (!state?.secretJournalUuid) throw new Error(`${token.name} has no persisted concealed-section selection.`);
  const journal = await fromUuid(state.secretJournalUuid);
  if (!journal) throw new Error(`${token.name} concealed-section record is missing; the selection was not rerolled.`);
  const record = journal.getFlag(SYSTEM_ID, STATE_KEY);
  if (record?.tokenUuid !== token.uuid
    || !getConcealedMainSectionSections(token.actor).some(section => section.name === record.section)) {
    throw new Error(`${token.name} concealed-section record is malformed; the selection was not revealed.`);
  }
  return { state, section: record.section };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function resolveConcealedMainSectionKnowledgeCheck(token, successValue, criticalFailure = false) {
  if (!game.user.isGM) throw new Error("Only a GM can resolve a concealed Main Section.");
  if (!getConcealedMainSectionSections(token?.actor).length) return { status: "not-applicable" };
  if (criticalFailure) return { status: "not-revealed" };
  const success = finiteNumber(successValue);
  const weakness = finiteNumber(token.actor.system.weakness);
  if (success === null || weakness === null) {
    throw new Error(`${token.name} has an invalid Monster Knowledge success or Weakness value.`);
  }
  if (success < weakness) return { status: "not-revealed" };

  const { state, section } = await privateSelectionForToken(token);
  await token.setFlag(SYSTEM_ID, STATE_KEY, {
    secretJournalUuid: state.secretJournalUuid,
    revealed: true,
    weaknessRevealed: true,
    section
  });
  return {
    status: "revealed",
    section,
    weakPoint: String(token.actor.system.weakPoint ?? "")
  };
}

export async function resolveMonsterKnowledgeMessage(message) {
  if (!game.user.isGM) return;
  const result = message.getFlag(SYSTEM_ID, "monsterKnowledge");
  if (!result || !Array.isArray(result.targetTokenUuids)) return;
  const roll = message.rolls?.[0];
  const successValue = finiteNumber(roll?.total);
  if (successValue === null || successValue !== finiteNumber(result.successValue)) {
    throw new Error("The Monster Knowledge result does not match the roll recorded on its chat message.");
  }
  const criticalFailure = isCriticalFailure(roll);
  const lines = [];
  for (const uuid of [...new Set(result.targetTokenUuids)]) {
    const token = await fromUuid(uuid);
    if (!token?.actor) continue;

    // ── General weakness revelation for any monster ─────────────────────
    if (token.actor.type === "monster") {
      const actor = token.actor;
      const weakness = finiteNumber(actor.system.weakness);
      const canRevealWeakness = result.classResults?.some(
        cr => cr.canRevealWeakness && successValue >= weakness
      );
      if (weakness !== null && canRevealWeakness && successValue >= weakness) {
        await revealMonsterWeakness(actor, { notify: false });
        lines.push(`<li>${escape(actor.name)}: Weakness revealed for species ${speciesId(actor)}.</li>`);
      }
    }

    // ── Concealed Main Section (Cursed Artist) ──────────────────────────
    if (!getConcealedMainSectionSections(token.actor).length) continue;
    const resolution = await resolveConcealedMainSectionKnowledgeCheck(token, successValue, criticalFailure);
    if (resolution.status === "not-revealed") {
      lines.push(`<li>${escape(token.name)}: Weakness not met; the Main Section remains concealed.</li>`);
    } else if (resolution.status === "revealed") {
      const weakPoint = resolution.weakPoint ? ` Weak Point: ${escape(resolution.weakPoint)}` : "";
      lines.push(`<li>${escape(token.name)}: Main Section revealed — <strong>${escape(resolution.section)}</strong>.${weakPoint}</li>`);
    }
  }
  if (!lines.length) return ui.notifications.info("No eligible monster was selected for this Monster Knowledge Check.");
  await ChatMessage.create({
    content: `<div class="sw25-chat-card"><h3>Monster Knowledge — Combat Preparation</h3><ul>${lines.join("")}</ul></div>`
  });
}

function addResolutionButton(message, html) {
  if (!game.user.isGM || !message.getFlag(SYSTEM_ID, "monsterKnowledge")) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector("[data-sw25-chat-action='resolve-monster-knowledge']")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.sw25ChatAction = "resolve-monster-knowledge";
  button.textContent = "Resolve for targeted Cursed Artists";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await resolveMonsterKnowledgeMessage(message);
    } catch (error) {
      console.error("Sword World 2.5 | Monster Knowledge resolution failed", error);
      ui.notifications.error(error.message || "Monster Knowledge could not be resolved.");
      button.disabled = false;
    }
  });
  root.append(button);
}

export function initializeMonsterKnowledge() {
  Hooks.on("preCreateToken", token => {
    if (token.actor?.type !== "monster") return;
    token.updateSource({ [`flags.${SYSTEM_ID}.${STATE_KEY}`]: null });
  });
  Hooks.on("createToken", token => {
    if (!game.user.isGM) return;
    return initializeConcealedMainSectionToken(token).catch(error => {
      console.error("Sword World 2.5 | Could not initialize concealed-section encounter state", error);
      ui.notifications.error(error.message || "Concealed-section encounter state could not be initialized.");
    });
  });
  Hooks.on("deleteToken", token => {
    if (!game.user.isGM) return;
    const uuid = tokenState(token)?.secretJournalUuid;
    if (!uuid) return;
    return fromUuid(uuid).then(journal => journal?.delete()).catch(error => {
      console.error("Sword World 2.5 | Could not remove concealed-section encounter state", error);
      ui.notifications.error("The private concealed-section record could not be removed.");
    });
  });
  Hooks.on("renderChatMessageHTML", addResolutionButton);
  if (!game.user.isGM) return;
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (tokenState(token) === null) {
        initializeConcealedMainSectionToken(token).catch(error => {
          console.error("Sword World 2.5 | Could not initialize existing concealed-section token", error);
          ui.notifications.error(error.message || "Concealed-section encounter state could not be initialized.");
        });
      }
    }
  }
}

// ── Monster Knowledge: Roll flow ────────────────────────────────────────────

function mkClassResults(actor, roll, savedClassId) {
  const items = actor.items;
  const classes = items
    ? typeof items.filter === "function"
      ? items.filter(item => item.type === "class")
      : [...items.values()].filter(item => item.type === "class")
    : [];
  const total = Number(roll.total);

  return classes.map(cls => {
    const className = String(cls.name ?? "").toLowerCase();
    return {
      className,
      classId: String(cls.id),
      level: Number(cls.system?.level ?? 0),
      canRevealWeakness: className === "sage",
      successValue: total
    };
  });
}

export async function rollMonsterKnowledge({
  actor, targetMonster,
  diceFormula = "2d6"
} = {}) {
  if (!actor || actor.type !== "character") return { status: "invalid-actor" };

  // Resolve Monster Knowledge class: Sage (normal), Rider (normal), Dark Hunter (manual only)
  const items = actor.items;
  const classes = items
    ? typeof items.filter === "function"
      ? items.filter(item => item.type === "class")
      : [...items.values()].filter(item => item.type === "class")
    : [];
  const savedClassId = actor.system?.combat?.monsterKnowledgeClassId || "";
  let resolvedClass = null;
  let resolvedLevel = 0;

  if (savedClassId) {
    const saved = classes.find(c => String(c.id) === savedClassId);
    if (saved) resolvedClass = saved;
  }

  if (!resolvedClass) {
    const sage = classes.find(c => String(c.name ?? "").toLowerCase() === "sage");
    const rider = classes.find(c => String(c.name ?? "").toLowerCase() === "rider");
    const candidates = [sage, rider].filter(Boolean);
    if (candidates.length > 0) {
      candidates.sort((a, b) => Number(b.system?.level ?? 0) - Number(a.system?.level ?? 0));
      resolvedClass = candidates[0];
    }
  }

  if (resolvedClass) resolvedLevel = Number(resolvedClass.system?.level ?? 0);

  // Intelligence bonus: mind ability base / 6
  const mindBase = Number(actor.system?.abilityBases?.mind ?? 0);
  const mindAdj = actor.system?.abilityAdjustments?.e ?? {};
  const mindScore = mindBase + Number(mindAdj.growth ?? 0) + Number(mindAdj.correction ?? 0) + Number(mindAdj.temporary ?? 0);
  const intBonus = Math.floor(mindScore / 6);

  const fixedBonus = Number(actor.system?.combat?.monsterKnowledgeBonus ?? 0);

  const className = resolvedClass ? String(resolvedClass.name ?? "Class") : "Class";
  const seedParts = [
    { label: `${className} level`, value: resolvedLevel, enabled: true, temporary: false },
    { label: "Intelligence", value: intBonus, enabled: true, temporary: false },
    { label: "Ficha (bonus fijo)", value: fixedBonus, enabled: true, temporary: false }
  ];

  // Open modifier dialog via registered constructor, or fall back to seed parts
  let modifiers = seedParts;
  if (typeof globalThis._dialogConstructor === "function") {
    const result = await globalThis._dialogConstructor.open({
      title: "Monster Knowledge — Modifiers",
      diceFormula,
      submitLabel: "Roll Monster Knowledge",
      parts: seedParts
    });
    if (result === null) return { status: "cancelled", phases: { dialog: true, roll: false } };
    modifiers = result;
  }

  // Sum enabled modifier values (skip zero-value modifiers)
  let totalModifier = 0;
  for (const part of modifiers) {
    if (part.enabled !== false && part.value !== 0) {
      totalModifier += Number(part.value ?? 0);
    }
  }

  // Assemble roll formula
  let formula = diceFormula;
  const totalNum = Number(totalModifier);
  if (Number.isFinite(totalNum) && totalNum !== 0) {
    formula = `${diceFormula} ${totalNum > 0 ? "+" : "-"} ${Math.abs(totalNum)}`;
  }

  // Roll dice
  let roll;
  try {
    roll = await new Roll(formula).evaluate();
  } catch (error) {
    console.error("Sword World 2.5 | Monster Knowledge roll failed", error);
    return { status: "error", error: error.message };
  }

  const diceResults = roll?.dice?.flatMap(die => (die.results || []).map(r => r.result)) || [];
  const natural = diceResults.reduce((sum, value) => sum + Number(value || 0), 0);

  let criticalFailure = false;
  try {
    criticalFailure = await markCriticalFailure(actor, roll);
  } catch (error) {
    criticalFailure = false;
  }

  const targetTokenUuids = targetMonster ? [targetMonster.uuid] : [];
  const classResults = mkClassResults(actor, roll, savedClassId);

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `${actor.name} — Monster Knowledge Check${criticalFailure ? criticalFailureHTML() : ""}`,
    flags: {
      "sword-world-25": {
        monsterKnowledge: {
          successValue: Number(roll.total),
          criticalFailure,
          targetTokenUuids,
          classResults
        }
      }
    }
  });

  return {
    status: "resolved",
    rollTotal: Number(roll.total),
    rollNatural: natural,
    criticalFailure,
    targetMonster,
    classResults
  };
}
