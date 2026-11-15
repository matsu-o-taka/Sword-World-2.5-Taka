import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseMonsterPage, validateMonsterProfile } from "../module/importer/monster-parser.mjs";
import {
  getConcealedMainSectionSections,
  getConcealedMainSectionConfig,
  concealedSelectionCandidates,
  getActiveCandidates,
  resolveConcealedMainSectionKnowledgeCheck,
  selectConcealedMainSection,
  getConcealedMainSectionSelection,
  setConcealedMainSectionSelection,
  setConcealedMainSectionConfig
} from "../module/combat/concealed-main-section.mjs";
import { resolveMonsterKnowledgeMessage } from "../module/combat/monster-knowledge.mjs";

const source = await readFile(new URL("./fixtures/monster-cursed-artist.md", import.meta.url), "utf8");
const parsed = parseMonsterPage(source, "https://sw25.wikidot.com/monster:cursed-artist");
assert.equal(validateMonsterProfile(parsed), true);

const makeCursedArtist = () => ({
  ...structuredClone(parsed),
  type: "monster",
  system: structuredClone(parsed.system),
  effects: [],
  async createEmbeddedDocuments(type, docs) {
    if (type !== "ActiveEffect") throw new Error("Only ActiveEffect is supported in this mock");
    const created = structuredClone(docs[0]);
    created.id = `sw25-${nextEffectId++}`;
    created.uuid = `ActiveEffect.${created.id}`;
    created.type = "sw25Effect";
    created.system = {
      family: docs[0].system?.family,
      rank: docs[0].system?.rank ?? 0,
      gmOnly: docs[0].system?.gmOnly === true
    };
    created.flags = structuredClone(docs[0].flags ?? {});
    created.disabled = false;
    created.deleted = false;
    created.delete = async () => {
      const idx = this.effects.findIndex(e => e.id === created.id);
      if (idx >= 0) this.effects.splice(idx, 1);
      created.deleted = true;
    };
    created.update = async (data) => { Object.assign(created, data); };
    this.effects.push(created);
    return [created];
  },
  async update(changes) {
    // Core-like flattened update: dotted paths are applied to the document.
    applyDottedChange(this, changes);
    this.updateCount += 1;
    return this;
  },
  updateCount: 0
});

function applyDottedChange(target, change) {
  for (const [path, value] of Object.entries(change)) {
    const keys = String(path).split(".");
    let cursor = target;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (typeof cursor[keys[i]] !== "object" || cursor[keys[i]] === null) cursor[keys[i]] = {};
      cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = structuredClone(value);
  }
}

// The concealed effect flags carry the PLAINTEXT selection record
// (`{ sectionId }`), hidden from players by the effect's `system.gmOnly:
// true` presentation flag (no encryption anywhere).
function assertConcealedRecord(effect, expectedSectionId) {
  const record = effect?.flags?.["sw25-taka"]?.concealedSection;
  assert.ok(record && typeof record === "object", "the effect carries the concealed selection record");
  assert.equal(record.sectionId, expectedSectionId, "the record stores the chosen section id as plaintext");
  assert.equal(effect.system?.gmOnly, true, "the concealed effect is marked GM-only");
}

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

// ── EffectService mock (ActiveEffect-based storage) ─────────────────────────
const effectsByActor = new WeakMap();
let nextEffectId = 1;

function actorEffects(actor) {
  let effects = effectsByActor.get(actor);
  if (!effects) {
    effects = [];
    effectsByActor.set(actor, effects);
  }
  return effects;
}

function findSw25EffectById(actor, effectId) {
  return actorEffects(actor).find(effect => effect.type === "sw25Effect" && effect.id === effectId) ?? null;
}

globalThis.applySw25Effect = async (actor, payload) => {
  if (game?.user?.isGM !== true) return { ok: false, code: "not-gm" };
  if (!actor?.effects) return { ok: false, code: "no-actor" };
  const id = `sw25-${nextEffectId++}`;
  const effect = {
    id,
    uuid: `ActiveEffect.${id}`,
    type: "sw25Effect",
    name: payload.family ?? "Concealed Main Section",
    system: {
      family: payload.family,
      rank: payload.rank ?? 0
    },
    flags: structuredClone(payload.flags ?? {}),
    disabled: false,
    deleted: false,
    async delete() {
      const effects = actorEffects(actor);
      const idx = effects.findIndex(e => e.id === id);
      if (idx >= 0) effects.splice(idx, 1);
      const actorIdx = actor.effects.findIndex(e => e.id === id);
      if (actorIdx >= 0) actor.effects.splice(actorIdx, 1);
      this.deleted = true;
    },
    async update(data) {
      Object.assign(this, data);
    }
  };
  actorEffects(actor).push(effect);
  actor.effects.push(effect); // Mirror to actor.effects so findConcealedEffect can locate it
  return { ok: true, code: "applied", effectId: id, effectUuid: effect.uuid };
};

globalThis.removeSw25Effect = async (actor, effectId) => {
  if (game?.user?.isGM !== true) return { ok: false, code: "not-gm" };
  if (!actor?.effects) return { ok: false, code: "no-actor" };
  const effect = findSw25EffectById(actor, effectId);
  if (!effect) return { ok: false, code: "no-effect" };
  await effect.delete(); // delete() now removes from both WeakMap and actor.effects
  return { ok: true, code: "removed", effectId };
};

function installFoundryMocks() {
  const hooks = new Map();
  const chatContents = [];
  const notificationMessages = [];
  const documents = new Map();
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
  // Real `game.settings` mock (the ONLY settings API in Foundry v14), with
  // faithful scope semantics: client-scope values live ONLY in this simulated
  // browser store and never reach any other client; reading an unregistered
  // setting throws exactly like the real ClientSettings.
  const registeredSettings = new Map();
  const clientStore = new Map();
  const worldStore = new Map();
  const settingsApi = {
    register(moduleId, key, options = {}) {
      registeredSettings.set(`${moduleId}.${key}`, { ...options, moduleId, key });
    },
    get(moduleId, key) {
      const id = `${moduleId}.${key}`;
      if (!registeredSettings.has(id)) throw new Error(`"${id}" is not a registered game setting`);
      const options = registeredSettings.get(id);
      const store = options.scope === "client" ? clientStore : worldStore;
      return store.has(id) ? structuredClone(store.get(id)) : structuredClone(options.default);
    },
    async set(moduleId, key, value) {
      const id = `${moduleId}.${key}`;
      if (!registeredSettings.has(id)) throw new Error(`"${id}" is not a registered game setting`);
      const options = registeredSettings.get(id);
      (options.scope === "client" ? clientStore : worldStore).set(id, structuredClone(value));
      return structuredClone(value);
    }
  };
  globalThis.game = {
    user: { isGM: true },
    scenes: [],
    world: { id: "test-world" },
    actors: [],
    settings: settingsApi
  };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 } };
  globalThis.fromUuid = async uuid => {
    const document = documents.get(uuid);
    return document || null;
  };
  globalThis.ChatMessage = {
    async create(data) { chatContents.push(data.content); },
    getSpeaker({ actor } = {}) { return { actor }; }
  };
  globalThis.ui = { notifications: { info(msg) { notificationMessages.push(msg); }, error(msg) { notificationMessages.push(`ERROR: ${msg}`); } } };
  globalThis.foundry = { utils: { escapeHTML: value => String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]) } };
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.document = {
    createElement() {
      return { dataset: {}, addEventListener() {}, set textContent(value) { this._text = value; } };
    }
  };
  return { hooks, documents, chatContents, notificationMessages, clientStore, registeredSettings };
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
actor.id = "test-actor-main";
assert.deepEqual(getConcealedMainSectionSections(actor).map(section => section.section), sectionNames);

const { hooks, documents, chatContents, notificationMessages, clientStore } = installFoundryMocks();

let selectionCalls = 0;
const randomIndex = length => {
  const index = selectionCalls % length;
  selectionCalls += 1;
  return index;
};

assert.equal((await selectConcealedMainSection(actor, randomIndex)).section, "Musician");
// Stable: re-selecting the same actor returns the existing selection, not a new roll.
assert.equal((await selectConcealedMainSection(actor, randomIndex)).section, "Musician",
  "re-select returns the same stable selection");
// Invalid index is rejected on a fresh actor (no existing selection short-circuits).
const freshActor = makeCursedArtist();
freshActor.name = "Fresh Actor";
await assert.rejects(selectConcealedMainSection(freshActor, () => 2), /invalid index/);
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
}).length, 2);

// Any monster with HP-bearing sections has candidates — no gating on creature
// type, unique skill, or hardcoded exceptions (ActiveEffect-based design).
for (const type of ["all", "none", "named", "special", "unspecified"]) {
  const other = makeCursedArtist();
  other.name = "Other Monster";
  other.system.sourceUrl = "https://sw25.wikidot.com/monster:other";
  other.system.mainSection.type = type;
  assert.equal(getConcealedMainSectionSections(other).length, 2, `${type} monsters have candidates`);
}

// A monster without sections has no candidates.
const sectionless = makeCursedArtist();
sectionless.system.combatStyles = [];
assert.equal(getConcealedMainSectionSections(sectionless).length, 0, "sectionless monster has no candidates");

const firstToken = makeToken(actor, "first");
const secondToken = makeToken(actor, "second");

// Token-level initialization is gone: selection is actor-level via ActiveEffect.
// The actor is configured once (auto-random selection once per instance).
const firstState = await selectConcealedMainSection(actor, randomIndex);
assert.ok(sectionNames.includes(firstState.section));
assert.equal(actor.system.concealedMainSection, undefined);
assert.equal(actor.updateCount, 0);
const concealedEffects = actor.effects.filter(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section");
assert.equal(concealedEffects.length, 1, "exactly one concealed effect on the actor");
const actorCandidates = concealedSelectionCandidates(actor);
const expectedId = actorCandidates.find(c => c.section === firstState.section)?.id;
assert.ok(expectedId, "candidate id found for selected section");
assertConcealedRecord(concealedEffects[0], expectedId);
assert.equal(firstToken.getFlag("sw25-taka", "concealedMainSection"), undefined);
assert.deepEqual(firstToken.getFlag("sw25-taka", "concealedMainSection"), undefined);

const serializedBeforeReveal = JSON.parse(JSON.stringify(firstToken.flags));
assert.equal(serializedBeforeReveal["sw25-taka"], undefined);

const again = await selectConcealedMainSection(actor, randomIndex);
assert.deepEqual(again, firstState, "auto-random selection is stable: no re-roll");
firstToken.updateSource({ "system.unrelated": "updated" });
assert.equal((await selectConcealedMainSection(actor, randomIndex)).sectionId, firstState.sectionId,
  "selection persists across unrelated actor updates");
assert.equal(selectionCalls, 1);

// A second monster gets its own independent selection.
const secondActor = makeCursedArtist();
secondActor.id = "test-actor-second";
secondActor.name = "Other Monster";
secondActor.system.sourceUrl = "https://sw25.wikidot.com/monster:other";
const secondState = await selectConcealedMainSection(secondActor, randomIndex);
assert.ok(sectionNames.includes(secondState.section));
assert.equal(selectionCalls, 2);

const concurrentToken = makeToken(actor, "concurrent");
const concurrentStates = await Promise.all([
  selectConcealedMainSection(actor, randomIndex),
  selectConcealedMainSection(actor, randomIndex)
]);
assert.deepEqual(concurrentStates[0], concurrentStates[1], "concurrent reads return the same stable selection");
assert.equal(selectionCalls, 2, "no additional random calls for already-selected actor");

// Token copy does not carry a concealed selection (it's actor-level, not token-level).
const copiedToken = makeToken(actor, "copy", firstToken.flags);
assert.equal(copiedToken.getFlag("sw25-taka", "concealedMainSection"), undefined,
  "token copy carries no concealed selection (actor-level only)");
assert.equal(selectionCalls, 2, "token copy does not trigger re-selection");

const player = { isGM: false };
game.user = player;
await assert.rejects(resolveConcealedMainSectionKnowledgeCheck(firstToken, 22), /Only a GM/);
game.user = { isGM: true };

// A low knowledge check does not reveal the section.
const missToken = makeToken(actor, "miss");
documents.set(missToken.uuid, missToken);
await resolveMonsterKnowledgeMessage({
  ...knowledgeMessage(21, [missToken.uuid])
});
assert.doesNotMatch(chatContents.at(-1), new RegExp(firstState.section));
assert.doesNotMatch(chatContents.at(-1), /Accuracy \+1/);

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
documents.set(highToken.uuid, highToken);
assert.equal((await resolveConcealedMainSectionKnowledgeCheck(highToken, 23)).section, firstState.section,
  "a successful knowledge check reveals the concealed section");

// Serialized token does not leak the concealed section (it is not on the token).
const hitTokenObj = makeToken(actor, "hit");
const serializedToken = JSON.parse(JSON.stringify({
  uuid: hitTokenObj.uuid,
  flags: hitTokenObj.flags
}));
assert.equal(serializedToken.flags["sw25-taka"], undefined, "the serialized token flags carry no concealed selection");

// ── Concealed selection: candidates, actor-level get/set, privacy ─────────

{
  // Candidates for a valid Cursed Artist profile are exactly Musician/Instrument.
  const cands = concealedSelectionCandidates(actor);
  assert.deepEqual(cands.map(c => c.section), ["Musician", "Instrument"]);
  assert.equal(cands.length, 2);
  assert.ok(cands.every(c => c.id), "candidates carry stable row ids");

  // A non-concealed monster falls back to its own HP-bearing sections.
  const plain = makeCursedArtist();
  plain.system.sourceUrl = "https://sw25.wikidot.com/monster:goblin";
  plain.system.mainSection = { type: "all", sourceValue: "Body" };
  plain.system.combatStyles = [
    { id: "s1", section: "Body", hp: { value: 30, max: 30 } },
    { id: "s2", section: "Tail", hp: { value: 10, max: 10 } }
  ];
  assert.deepEqual(concealedSelectionCandidates(plain).map(c => c.section), ["Body", "Tail"]);

  // Actor-level get/set through the ActiveEffect (GM-only).
  let nextEffectId = 1;
  const concealedActor = {
    id: "concealed-test-actor",
    uuid: `Actor.concealed-test`,
    name: actor.name,
    type: actor.type,
    system: structuredClone(actor.system),
    effects: [],
    flags: {},
    async createEmbeddedDocuments(type, docs) {
      if (type !== "ActiveEffect") throw new Error("Only ActiveEffect is supported in this mock");
      const created = structuredClone(docs[0]);
      created.id = `sw25-${nextEffectId++}`;
      created.uuid = `ActiveEffect.${created.id}`;
      created.type = "sw25Effect";
      created.system = {
      family: docs[0].system?.family,
      rank: docs[0].system?.rank ?? 0,
      gmOnly: docs[0].system?.gmOnly === true
    };
      created.flags = structuredClone(docs[0].flags ?? {});
      created.disabled = false;
      created.deleted = false;
      created.delete = async () => {
        const idx = this.effects.findIndex(e => e.id === created.id);
        if (idx >= 0) this.effects.splice(idx, 1);
        created.deleted = true;
      };
      created.update = async (data) => { Object.assign(created, data); };
      this.effects.push(created);
      return [created];
    },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) { this.flags[scope] ??= {}; this.flags[scope][key] = structuredClone(value); },
    getActiveTokens() { return []; },
    updateCount: 0
  };

  // Non-GM: nothing readable, assignment refused.
  const savedGM = game.user;
  game.user = { isGM: false };
  assert.equal(await getConcealedMainSectionSelection(concealedActor), null, "non-GM selection read is null");
  await assert.rejects(setConcealedMainSectionSelection(concealedActor, "Musician"), /Only a GM/,
    "non-GM actor-level assignment refused");
  game.user = savedGM;

  // GM assignment: the effect flags carry the plaintext record and the
  // effect is GM-only; the actor system/flags carry nothing.
  const concealedActorCands = concealedSelectionCandidates(concealedActor);
  const instrumentId = concealedActorCands.find(c => c.section === "Instrument")?.id;
  const musicianId = concealedActorCands.find(c => c.section === "Musician")?.id;
  assert.ok(instrumentId, "Instrument candidate id found");
  assert.ok(musicianId, "Musician candidate id found");
  const result = await setConcealedMainSectionSelection(concealedActor, "Instrument");
  assert.equal(result.section, "Instrument", "assignment returns the section");
  const effect = concealedActor.effects.find(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section");
  assert.ok(effect, "concealed effect was created on the actor");
  assertConcealedRecord(effect, instrumentId);
  assert.equal(concealedActor.system.concealedMainSection, undefined, "no system field carries the selection");
  assert.equal(concealedActor.system.mainSection.type, "special", "the import identification is untouched");
  assert.equal(JSON.stringify(concealedActor.flags).includes("Instrument"), false, "the actor flag carries no section name");
  // The record itself is plaintext by design (agreed presentation trade-
  // off); the hiding happens through the effect's system.gmOnly flag.

  // Re-read returns the same selection (stateless plaintext read);
  // changing replaces the effect (no duplicate).
  const again = await getConcealedMainSectionSelection(concealedActor);
  assert.equal(again.section, "Instrument", "re-read returns the assignment");
  const firstEffectId = effect.id;
  const result2 = await setConcealedMainSectionSelection(concealedActor, "Musician");
  assert.equal(result2.section, "Musician", "re-selection changes the section");
  const effect2 = concealedActor.effects.find(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section");
  assert.notEqual(effect2.id, firstEffectId, "re-selection creates a new effect (old one removed)");
  assertConcealedRecord(effect2, musicianId);
  const concealedCount = concealedActor.effects.filter(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section").length;
  assert.equal(concealedCount, 1, "no duplicate effect was created on re-selection");

  // A placed token adopts the actor-level assignment instead of rolling fresh.
  await setConcealedMainSectionSelection(concealedActor, "Instrument"); // assignment = Instrument; random(0) would pick Musician
  const adoptToken = makeToken(concealedActor, "adopt");
  // Token adoption: the actor-level assignment is what the DEFEATED sync
  // reads (via actor.effects), not a per-token record. The token carries no
  // concealed selection of its own.
  assert.equal(adoptToken.getFlag("sw25-taka", "concealedMainSection"), undefined,
    "the token carries no concealed selection (actor-level only)");
  assertConcealedRecord(
    concealedActor.effects.find(effect => effect.type === "sw25Effect" && effect.system?.family === "Concealed Main Section"),
    instrumentId
  );

  // The assignment wrote nothing to the actor's system data (mock actor has no
  // DEFEATED sync hook installed): no throw, no actor system writes.
  assert.equal(concealedActor.updateCount, 0, "the assignment wrote nothing to the actor");
}

// ── Candidate configuration (actor-level, public) ─────────────────────────

{
  const configActor = makeCursedArtist();
  configActor.id = "test-actor-config";
  // Give it 3 sections so we can test exclusion while keeping >= 2.
  configActor.system.combatStyles = [
    { id: "s1", section: "Alpha", hp: { value: 30, max: 30 } },
    { id: "s2", section: "Beta", hp: { value: 30, max: 30 } },
    { id: "s3", section: "Gamma", hp: { value: 30, max: 30 } }
  ];
  // Default config: all sections included, no exclusions.
  let config = getConcealedMainSectionConfig(configActor);
  assert.equal(config, null, "new actor has no config yet");

  // Get actual candidate ids.
  const configCands = concealedSelectionCandidates(configActor);
  assert.deepEqual(configCands.map(c => c.section), ["Alpha", "Beta", "Gamma"], "all 3 sections are candidates");

  const gammaId = configCands.find(c => c.section === "Gamma")?.id;
  const betaId = configCands.find(c => c.section === "Beta")?.id;
  const alphaId = configCands.find(c => c.section === "Alpha")?.id;
  assert.ok(gammaId, "Gamma candidate id found");
  assert.ok(betaId, "Beta candidate id found");
  assert.ok(alphaId, "Alpha candidate id found");

  // Set config with one exclusion (leaving 2 candidates — the minimum).
  // This is a REAL persisted write now (audit §4 fix): it goes through
  // actor.update and lands in the actor's system data.
  assert.equal(configActor.updateCount, 0, "no actor writes yet");
  await setConcealedMainSectionConfig(configActor, { excluded: [gammaId] });
  assert.equal(configActor.updateCount, 1, "the config was persisted with exactly one actor.update");
  assert.deepEqual(configActor.system.concealedMainSectionConfig, { version: 1, excluded: [gammaId] },
    "the config reached the actor system data (what replicates and reloads)");
  config = getConcealedMainSectionConfig(configActor);
  assert.equal(config.version, 1, "config version is 1");
  assert.deepEqual(config.excluded, [gammaId], "excluded section persisted");

  // Active candidates reflect exclusions.
  const active = getActiveCandidates(configActor);
  assert.deepEqual(active.map(c => c.section), ["Alpha", "Beta"], "only Alpha and Beta remain active");

  // Excluding both remaining sections (below minimum) rejects the write.
  await assert.rejects(setConcealedMainSectionConfig(configActor, { excluded: [alphaId, betaId] }),
    /At least 2 candidate sections/, "below-minimum exclusions rejected");
  assert.equal(configActor.updateCount, 1, "the rejected attempt wrote nothing");

  // Config survives: still excludes Gamma after the failed attempt.
  config = getConcealedMainSectionConfig(configActor);
  assert.deepEqual(config.excluded, [gammaId], "failed attempt did not mutate config");

  // Selecting from excluded section is rejected.
  await assert.rejects(setConcealedMainSectionSelection(configActor, "Gamma"),
    /does not have an active candidate section/, "excluded section cannot be selected");

  // Selecting from active section works.
  const selected = await setConcealedMainSectionSelection(configActor, "Alpha");
  assert.equal(selected.section, "Alpha", "active section can be selected");
}

console.log("Monster Knowledge concealment tests passed (real game.settings semantics; confidentiality asserted against the encrypted record, not mocked permissions).");
