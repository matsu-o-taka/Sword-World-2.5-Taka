import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseMonsterPage, validateMonsterProfile } from "../module/importer/monster-parser.mjs";
import {
  getConcealedMainSectionSections,
  initializeConcealedMainSectionToken,
  initializeConcealedMainSection,
  resolveConcealedMainSectionKnowledgeCheck,
  selectConcealedMainSection
} from "../module/combat/concealed-main-section.mjs";
import { resolveMonsterKnowledgeMessage } from "../module/combat/monster-knowledge.mjs";

const source = await readFile(new URL("./fixtures/monster-cursed-artist.md", import.meta.url), "utf8");
const parsed = parseMonsterPage(source, "https://sw25.wikidot.com/monster:cursed-artist");
assert.equal(validateMonsterProfile(parsed), true);

const makeCursedArtist = () => ({
  ...structuredClone(parsed),
  type: "monster",
  system: structuredClone(parsed.system),
  updateCount: 0
});

function makeToken(actor, id, flags = {}) {
  return {
    id,
    uuid: `Scene.scene.Token.${id}`,
    name: `${actor.name} ${id}`,
    actor,
    flags: structuredClone(flags),
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) {
      this.flags[scope] ??= {};
      this.flags[scope][key] = structuredClone(value);
    },
    updateSource(data) {
      for (const [path, value] of Object.entries(data)) {
        const [flagsKey, scope, key] = path.split(".");
        if (flagsKey !== "flags") continue;
        this.flags[scope] ??= {};
        if (value === null) delete this.flags[scope][key];
        else this.flags[scope][key] = value;
      }
    }
  };
}

function installFoundryMocks() {
  const hooks = new Map();
  const documents = new Map();
  const chatContents = [];
  let journalId = 0;
  globalThis.Hooks = {
    on(name, callback) {
      const callbacks = hooks.get(name) || [];
      callbacks.push(callback);
      hooks.set(name, callbacks);
    },
    once(name, callback) {
      const callbacks = hooks.get(name) || [];
      callbacks.push(callback);
      hooks.set(name, callbacks);
    }
  };
  globalThis.game = { user: { isGM: true }, scenes: [] };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 } };
  globalThis.JournalEntry = {
    async create(data) {
      journalId += 1;
      const id = `journal-${journalId}`;
      const journal = {
        id,
        uuid: `JournalEntry.${id}`,
        ownership: data.ownership,
        pages: structuredClone(data.pages),
        flags: structuredClone(data.flags),
        getFlag(scope, key) { return this.flags[scope]?.[key]; },
        testUserPermission(user) { return Boolean(user.isGM); },
        async delete() { documents.delete(this.uuid); }
      };
      documents.set(journal.uuid, journal);
      return journal;
    }
  };
  globalThis.fromUuid = async uuid => {
    const document = documents.get(uuid);
    if (document?.testUserPermission && !document.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)) return null;
    return document || null;
  };
  globalThis.ChatMessage = {
    async create(data) { chatContents.push(data.content); },
    getSpeaker({ actor } = {}) { return { actor }; }
  };
  const notificationMessages = [];
  globalThis.ui = { notifications: { info(msg) { notificationMessages.push(msg); }, error() {} } };
  globalThis.foundry = { utils: { escapeHTML: value => String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]) } };
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.document = {
    createElement() {
      return { dataset: {}, addEventListener() {}, set textContent(value) { this._text = value; } };
    }
  };
  return { hooks, documents, chatContents, notificationMessages };
}

const knowledgeMessage = (successValue, targetTokenUuids, dice = [6, 5]) => ({
  rolls: [{
    total: successValue,
    dice: [{ results: dice.map(result => ({ active: true, result })) }]
  }],
  getFlag: () => ({ successValue, targetTokenUuids })
});

const sectionNames = ["Musician", "Instrument"];
const actor = makeCursedArtist();
assert.deepEqual(getConcealedMainSectionSections(actor).map(section => section.section), sectionNames);
assert.equal(selectConcealedMainSection(actor, () => 0), "Musician");
assert.equal(selectConcealedMainSection(actor, () => 1), "Instrument");
assert.throws(() => selectConcealedMainSection(actor, () => 2), /invalid index/);
assert.equal(getConcealedMainSectionSections({
  type: "monster",
  name: "Doubleburg",
  system: {
    sourceUrl: "https://sw25.wikidot.com/monster:doubleburg",
    mainSection: { type: "special", sourceValue: "Special" },
    combatStyles: [
      { style: "Bow for Playing", section: "Musician", accuracy: "15 (22)", damage: "2d+15", evasion: "14 (21)", defense: 9, hp: { value: 115, max: 115 }, mp: { value: 88, max: 88 } },
      { style: "None", section: "Instrument", accuracy: "-", damage: "-", evasion: "15 (22)", defense: 10, hp: { value: 106, max: 106 }, mp: { value: 48, max: 48 } }
    ],
    uniqueSkills: [{ title: "◯Concealed Main Section" }]
  }
}).length, 0);

for (const type of ["all", "none", "named", "special", "unspecified"]) {
  const other = makeCursedArtist();
  other.name = "Other Monster";
  other.system.sourceUrl = "https://sw25.wikidot.com/monster:other";
  other.system.mainSection.type = type;
  assert.equal(getConcealedMainSectionSections(other).length, 0);
}
const multipleSectionsWithoutSkill = makeCursedArtist();
multipleSectionsWithoutSkill.system.uniqueSkills = [];
assert.equal(getConcealedMainSectionSections(multipleSectionsWithoutSkill).length, 0);

const { hooks, documents, chatContents, notificationMessages } = installFoundryMocks();
const firstToken = makeToken(actor, "first");
const secondToken = makeToken(actor, "second");
let selectionCalls = 0;
const randomIndex = length => {
  selectionCalls += 1;
  return selectionCalls % length;
};
const firstState = await initializeConcealedMainSectionToken(firstToken, { randomIndex });
const firstJournal = documents.get(firstState.secretJournalUuid);
const firstSection = firstJournal.getFlag("sw25-taka", "concealedMainSection").section;
assert.ok(sectionNames.includes(firstSection));
assert.equal(actor.system.concealedMainSection, undefined);
assert.equal(actor.updateCount, 0);
assert.equal(firstJournal.ownership.default, 0);
assert.equal(firstToken.getFlag("sw25-taka", "concealedMainSection").section, undefined);
assert.deepEqual(firstToken.getFlag("sw25-taka", "concealedMainSection"), {
  secretJournalUuid: firstJournal.uuid,
  revealed: false
});
const serializedBeforeReveal = JSON.parse(JSON.stringify(firstToken.flags));
assert.equal(serializedBeforeReveal["sw25-taka"].concealedMainSection.section, undefined);

const again = await initializeConcealedMainSectionToken(firstToken, { randomIndex });
assert.deepEqual(again, firstState);
firstToken.updateSource({ "system.unrelated": "updated" });
assert.equal((await initializeConcealedMainSectionToken(firstToken, { randomIndex })).secretJournalUuid, firstJournal.uuid);
assert.equal(selectionCalls, 1);

const secondState = await initializeConcealedMainSectionToken(secondToken, { randomIndex });
const secondJournal = documents.get(secondState.secretJournalUuid);
assert.notEqual(firstJournal.uuid, secondJournal.uuid);
assert.equal(selectionCalls, 2);

const concurrentToken = makeToken(actor, "concurrent");
const concurrentStates = await Promise.all([
  initializeConcealedMainSectionToken(concurrentToken, { randomIndex }),
  initializeConcealedMainSectionToken(concurrentToken, { randomIndex })
]);
assert.deepEqual(concurrentStates[0], concurrentStates[1]);
assert.equal(selectionCalls, 3);

const copiedToken = makeToken(actor, "copy", firstToken.flags);
initializeConcealedMainSection();
const preCreateToken = hooks.get("preCreateToken")[0];
preCreateToken(copiedToken);
assert.equal(copiedToken.getFlag("sw25-taka", "concealedMainSection"), undefined);
const createToken = hooks.get("createToken")[0];
await createToken(copiedToken);
const copiedState = copiedToken.getFlag("sw25-taka", "concealedMainSection");
assert.notEqual(copiedState.secretJournalUuid, firstState.secretJournalUuid);
assert.equal(selectionCalls, 3);
await hooks.get("deleteToken")[0](copiedToken);
assert.equal(documents.has(copiedState.secretJournalUuid), false);

const player = { isGM: false };
game.user = player;
assert.equal(await fromUuid(firstJournal.uuid), null);
assert.equal(firstJournal.testUserPermission(player, 3), false);
assert.equal(firstJournal.testUserPermission({ isGM: true }, 3), true);
await assert.rejects(resolveConcealedMainSectionKnowledgeCheck(firstToken, 22), /Only a GM/);
game.user = { isGM: true };

const missToken = makeToken(actor, "miss");
const missState = await initializeConcealedMainSectionToken(missToken, { randomIndex });
const missSection = documents.get(missState.secretJournalUuid)
  .getFlag("sw25-taka", "concealedMainSection").section;
documents.set(missToken.uuid, missToken);
await resolveMonsterKnowledgeMessage({
  ...knowledgeMessage(21, [missToken.uuid])
});
assert.doesNotMatch(chatContents.at(-1), new RegExp(missSection));
assert.doesNotMatch(chatContents.at(-1), /Accuracy \+1/);
assert.equal(missToken.getFlag("sw25-taka", "concealedMainSection").revealed, false);

const hitToken = makeToken(actor, "hit");
const hitState = await initializeConcealedMainSectionToken(hitToken, { randomIndex });
documents.set(hitToken.uuid, hitToken);
const unrelatedToken = makeToken(actor, "unrelated");
const unrelatedState = await initializeConcealedMainSectionToken(unrelatedToken, { randomIndex });
documents.set(unrelatedToken.uuid, unrelatedToken);
const beforeRevealSelectionCount = selectionCalls;

// Monster Knowledge general (no Cursed Artist): no target monsters registered,
// so no weakness/stats discovery lines are produced.
notificationMessages.length = 0;
await resolveMonsterKnowledgeMessage({
  ...knowledgeMessage(22, [])
});
assert.ok(notificationMessages.some(m => m.includes("No eligible monster was selected")), "notification about no eligible monster");

await assert.rejects(resolveMonsterKnowledgeMessage({
  ...knowledgeMessage(22, []),
  rolls: [{ total: 99, dice: [{ results: [{ result: 6 }, { result: 5 }] }] }]
}), /does not match the roll/);

const highToken = makeToken(actor, "high");
const highState = await initializeConcealedMainSectionToken(highToken, { randomIndex });
const highSection = documents.get(highState.secretJournalUuid)
  .getFlag("sw25-taka", "concealedMainSection").section;
assert.equal((await resolveConcealedMainSectionKnowledgeCheck(highToken, 23)).section, highSection);

const serializedToken = JSON.parse(JSON.stringify({
  uuid: hitToken.uuid,
  flags: hitToken.flags
}));
const serializedJournal = JSON.parse(JSON.stringify({
  uuid: documents.get(hitState.secretJournalUuid).uuid,
  ownership: documents.get(hitState.secretJournalUuid).ownership,
  flags: documents.get(hitState.secretJournalUuid).flags
}));
const restoredJournal = {
  ...serializedJournal,
  getFlag(scope, key) { return this.flags[scope]?.[key]; }
};
documents.set(restoredJournal.uuid, restoredJournal);
const restoredToken = makeToken(actor, "hit", serializedToken.flags);
restoredToken.uuid = serializedToken.uuid;
const journalFlag = documents.get(hitState.secretJournalUuid)?.getFlag("sw25-taka", "concealedMainSection");
assert.ok(journalFlag?.section, "journal has concealed main section section");
const restoredSection = await resolveConcealedMainSectionKnowledgeCheck(restoredToken, 22);
assert.ok(restoredSection.section, "restored token can resolve concealed section");

console.log("Monster Knowledge concealment tests passed (Foundry permissions mocked; no live-client privacy verification).");
