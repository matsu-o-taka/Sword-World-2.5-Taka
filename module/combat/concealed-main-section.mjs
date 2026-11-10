const SYSTEM_ID = "sw25-taka";
const STATE_KEY = "concealedMainSection";
const SECTION_NAMES = ["musician", "instrument"];
const CURSED_ARTIST_SOURCE = /(?:^|\/)monster:cursed-artist(?:$|[?#])/i;
const pendingInitializations = new WeakMap();

const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
const normalized = value => String(value ?? "").trim().toLowerCase();

// ── Species identification for Concealed Main Section ──────────────────────
//
// Since F2-T2 (consumer integration) the species identity used by this
// module is the single authoritative implementation in
// module/knowledge/mk-identity.mjs; the pre-F1 duplicated copy is gone.
// The re-export preserves this module's export surface for any consumer.

import { normalizeSpeciesId, speciesId } from "../knowledge/mk-identity.mjs";

export { normalizeSpeciesId, speciesId };

// ── Concealed Main Section detection ───────────────────────────────────────

export function getConcealedMainSectionSections(actor) {
  const system = actor?.system;
  const isCursedArtistSource = CURSED_ARTIST_SOURCE.test(String(system?.sourceUrl ?? ""));
  if (actor?.type !== "monster" || !system || !isCursedArtistSource
    || system.mainSection?.type !== "special"
    || !/^special(?:\s*,?\s*see below)?$/i.test(String(system.mainSection.sourceValue ?? ""))
    || !Array.isArray(system.uniqueSkills)
    || !system.uniqueSkills.some(skill => /^◯\s*Concealed Main Section$/i.test(String(skill.title ?? "").trim()))) return [];
  const combatStyles = Array.isArray(system.combatStyles) ? system.combatStyles : [];
  if (combatStyles.length !== SECTION_NAMES.length) return [];
  const sections = combatStyles.filter(cs => SECTION_NAMES.includes(normalized(cs.section)));
  if (sections.length !== SECTION_NAMES.length
    || new Set(sections.map(section => normalized(section.section))).size !== SECTION_NAMES.length) return [];
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
  return sections[index].section;
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
    || !getConcealedMainSectionSections(token.actor).some(section => section.section === record.section)) {
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

export async function initializeConcealedMainSection() {
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
