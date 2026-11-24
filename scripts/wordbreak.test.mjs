// T6.2 production Wordbreak integration tests.

import assert from "node:assert/strict";

const uuidDocuments = new Map();

globalThis.foundry = {
  data: { ActiveEffectTypeDataModel: class {} },
  utils: {
    escapeHTML: value => String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char])),
    fromUuidSync: uuid => uuidDocuments.get(uuid) ?? null
  }
};
globalThis.game = {
  user: { isGM: true, targets: new Set() },
  actors: [],
  items: new Map()
};
globalThis.canvas = {
  scene: { grid: { distance: 5 } },
  grid: {},
  tokens: { placeables: [] }
};
globalThis.ChatMessage = { create: async data => { chat.push(data); return data; }, getSpeaker: ({ actor }) => ({ actor: actor?.uuid }) };

const { SW25_EFFECT_SUBTYPE } = await import("../module/effects/effect-model.mjs");
const { activateWordbreak, resolveWordbreakTarget } = await import("../module/rules/wordbreak.mjs");

const chat = [];
const actor = (id, name = id) => ({ uuid: `Actor.${id}`, id, name, system: { abilityBases: { mind: 12 }, abilityAdjustments: { e: {} }, combat: {} }, effects: [] });
const caster = actor("caster", "Caster");
const target = actor("target", "Target");
const casterToken = { actor: caster, center: { x: 0, y: 0 } };
const targetToken = { actor: target, center: { x: 100, y: 0 } };
canvas.tokens.placeables = [casterToken, targetToken];
game.actors = [caster, target];
game.user.targets = new Set([targetToken]);
const magicClass = { type: "class", name: "Sorcerer", system: { level: 5 } };

function effect(id, system = {}, extra = {}) {
  return {
    type: SW25_EFFECT_SUBTYPE,
    id,
    name: system.family || id,
    system: {
      family: system.family || id,
      successValue: 10,
      successValueSource: "check",
      isMagical: false,
      durationScale: "rounds",
      initialDuration: 2,
      ...system
    },
    ...extra
  };
}

function reset() {
  target.effects = [];
  chat.length = 0;
  game.items.clear();
  uuidDocuments.clear();
}

function dialogs({ selected = "effect-0", successValue = 12, automaticSuccess = false, automaticFailure = false, recover = undefined } = {}) {
  return {
    declareEffect: async ({ candidates }) => {
      assert.ok(candidates.every(candidate => !candidate.effect.system.gmOnly), "gmOnly never reaches declaration");
      return { selection: selected === null ? null : { actorUuid: candidates[Number(selected.slice(7))].target.uuid, effectId: candidates[Number(selected.slice(7))].effect.id } };
    },
    rollCheck: async () => ({ successValue, automaticSuccess, automaticFailure }),
    ...(recover === undefined ? {} : { recoverSuccessValue: async () => recover })
  };
}

const operation = async (_action, { actorUuid, effectId }) => {
  const owner = game.actors.find(candidate => candidate.uuid === actorUuid);
  const index = owner?.effects.findIndex(item => item.id === effectId) ?? -1;
  if (!owner || index < 0) return { ok: false, code: "not-found" };
  owner.effects.splice(index, 1);
  return { ok: true };
};
const noChat = async () => {};

assert.equal(resolveWordbreakTarget({ targets: [targetToken] }).ok, true);
assert.equal(resolveWordbreakTarget({ targets: [] }).code, "no-target");
assert.equal(resolveWordbreakTarget({ targets: [targetToken, targetToken] }).ok, true, "duplicate token references collapse");
const other = actor("other", "Other");
const otherToken = { actor: other, center: { x: 0, y: 0 } };
assert.equal(resolveWordbreakTarget({ targets: [targetToken, otherToken] }).code, "multiple-targets", "one declared target only");
// Range is NOT validated: tokens at any distance are accepted.
targetToken.center = { x: 100000, y: 100000 };
assert.equal(resolveWordbreakTarget({ targets: [targetToken] }).ok, true, "distance does not gate Wordbreak");
targetToken.center = { x: 100, y: 0 };

// Activation uses the feat entry point's complete declaration → check → revalidation flow.
reset();
target.effects.push(effect("eligible"));
let declarationBeforeRoll = false;
const flowDialogs = {
  declareEffect: async ({ candidates }) => {
    declarationBeforeRoll = true;
    return { selection: { actorUuid: candidates[0].target.uuid, effectId: candidates[0].effect.id } };
  },
  rollCheck: async () => {
    assert.equal(declarationBeforeRoll, true);
    return { successValue: 12 };
  }
};
let result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: flowDialogs, effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "cancelled");
assert.equal(target.effects.length, 0);

// Eligibility restrictions and boundary: one round is not >10 seconds.
for (const [label, system] of [
  ["curse", { effectType: "Curse", initialDuration: 3 }],
  ["permanent", { durationScale: "permanent" }],
  ["instant", { durationScale: "rounds", initialDuration: 1 }],
  ["physical", { effectType: "grabbed", initialDuration: 3 }],
  ["one-round", { durationScale: "rounds", initialDuration: 1 }]
]) {
  reset();
  target.effects.push(effect(label, system));
  result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs(), effectOperation: operation, sendChat: noChat });
  assert.equal(result.code, "no-eligible-effect", `${label} is excluded`);
  assert.equal(target.effects.length, 1);
}

// Instant/X is eligible and Resistance: Can't is irrelevant.
reset();
const instantItem = { name: "Instant Ward", system: { duration: "Instant/1 round" } };
uuidDocuments.set("Item.instant", instantItem);
target.effects.push(effect("instant-x", { durationScale: "rounds", initialDuration: 1, resistance: "cant" }, { origin: "Item.instant" }));
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 11 }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "cancelled", "Instant/X is eligible even at the one-round boundary");

// Production casts persist the owned spell's full embedded Item UUID as origin.
reset();
const embeddedOrigin = "Actor.caster.Item.instant-embedded";
uuidDocuments.set(embeddedOrigin, { name: "Embedded Instant Ward", system: { duration: "Instant/1 round" } });
target.effects.push(effect("embedded-instant-x", { durationScale: "rounds", initialDuration: 1 }, { origin: embeddedOrigin }));
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 11 }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "cancelled", "an embedded Item UUID resolves to its Instant/X origin");

// Strict comparison, active automatic success, passive automatic provenance.
reset();
target.effects.push(effect("strict", { successValue: 12 }));
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 12 }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "resisted", "equality retains");
assert.equal(target.effects.length, 1);
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 12, automaticSuccess: true }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "cancelled", "active automatic success cancels");

reset();
target.effects.push(effect("automatic-failure", { successValue: 1 }));
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 2, automaticFailure: true }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "automatic-failure");
assert.equal(target.effects.length, 1, "automatic failure removes nothing even against a lower SV");

reset();
target.effects.push(effect("passive-auto", { successValue: 17, successValueSource: "automatic" }));
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 17 }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "resisted", "passive automatic-success SV remains comparable");
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 18 }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "cancelled");

// gmOnly filtering, stale selections and missing-value recovery.
reset();
target.effects.push(effect("visible", { successValue: 2 }), effect("secret", { successValue: 1, gmOnly: true }));
game.user.isGM = false;
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 12, selected: "effect-0" }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "cancelled");
game.user.isGM = true;
reset();
target.effects.push(effect("stale", { successValue: 2 }));
const staleDialogs = {
  declareEffect: async ({ candidates }) => {
    target.effects = [];
    return { selection: { actorUuid: candidates[0].target.uuid, effectId: candidates[0].effect.id } };
  },
  rollCheck: async () => ({ successValue: 12 })
};
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: staleDialogs, effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "stale-selection");

reset();
target.effects.push(effect("unknown", { successValue: 0, successValueSource: null }));
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 12, recover: 13 }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "resisted", "recovered passive SV is compared");
assert.equal(target.effects.length, 1);

// Exercise the production recovery dialog callback, not an injected recovery
// result: an empty number input is missing data, never numeric zero.
reset();
target.effects.push(effect("blank-recovery", { successValue: 0, successValueSource: null }));
const previousApplications = foundry.applications;
foundry.applications = { api: { DialogV2: { wait: async ({ buttons }) => {
  const submit = buttons.find(button => button.action === "submit");
  return submit.callback(null, { form: { elements: { successValue: { value: "" } } } });
} } } };
try {
  result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 12 }), effectOperation: operation, sendChat: noChat });
  assert.equal(result.code, "missing-success-value", "blank recovery input is not coerced to SV 0");
  assert.equal(target.effects.length, 1, "blank recovery input cannot authorize removal");
} finally {
  if (previousApplications === undefined) delete foundry.applications;
  else foundry.applications = previousApplications;
}

// Area identity: /Space groups same cast; /All and /Z remain individual.
reset();
const second = actor("second", "Second");
const secondToken = { actor: second, center: { x: 100, y: 0 } };
game.actors.push(second);
second.effects = [effect("space-2", { castId: "cast-space", effectScope: "space", successValue: 2 })];
target.effects = [effect("space-1", { castId: "cast-space", effectScope: "space", successValue: 2 })];
game.user.targets = new Set([targetToken]);
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 12 }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "cancelled");
assert.equal(second.effects.length, 0);

// /All and /Z are per-character, even when their castId matches.
reset();
second.effects = [effect("all-other", { castId: "cast-individual", effectScope: "all", successValue: 2 })];
target.effects = [effect("all-declared", { castId: "cast-individual", effectScope: "all", successValue: 2 })];
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 12 }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "cancelled");
assert.equal(target.effects.length, 0);
assert.equal(second.effects.length, 1);
second.effects = [effect("limited-other", { castId: "cast-individual", effectScope: "limited", successValue: 2 })];
target.effects = [effect("limited-declared", { castId: "cast-individual", effectScope: "limited", successValue: 2 })];
result = await activateWordbreak({ actor: caster, targets: [targetToken], castingClass: magicClass, dialogs: dialogs({ successValue: 12 }), effectOperation: operation, sendChat: noChat });
assert.equal(result.code, "cancelled");
assert.equal(second.effects.length, 1);

// The production chat path receives explicit success/failure feedback.
reset();
target.effects.push(effect("chat-resisted", { successValue: 20 }));
const feedback = [];
result = await activateWordbreak({
  actor: caster,
  targets: [targetToken],
  castingClass: magicClass,
  dialogs: dialogs({ successValue: 12 }),
  effectOperation: operation,
  sendChat: async (_actor, results) => feedback.push(results[0].summary)
});
assert.equal(result.code, "resisted");
assert.ok(feedback[0].includes("does not exceed"), "resistance feedback is sent to chat");

console.log("wordbreak.test.mjs: all T6.2 production-flow assertions passed.");
