// Sword World 2.5 - Generic effects and magical classification test suite.
//
// Exercises the REAL modules used by the Effects creator:
//   - module/effects/effect-configurator.mjs (generic form adapter)
//   - module/effects/configured-effect.mjs  (descriptor, preview, transport)
//   - module/effects/effect-service.mjs     (single persistence path)
//   - module/effects/effect-cancellation.mjs (Dispel Magic / Wordbreak gates)
//
// The Foundry globals reproduced here are only the pieces those modules touch:
// foundry.utils and ui.notifications. No DOM or server is required.

import assert from "node:assert/strict";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => "generic-test-id",
    escapeHTML: value => String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    })[character])
  }
};
const notifications = [];
globalThis.ui = {
  notifications: {
    info: message => notifications.push({ type: "info", message }),
    warn: message => notifications.push({ type: "warn", message }),
    error: message => notifications.push({ type: "error", message })
  }
};
globalThis.game = { user: { isGM: true } };

const {
  buildSw25GenericEffectConfiguration,
  buildSw25DamageVulnerabilityConfiguration,
  SW25_GENERIC_DURATION_OPTIONS,
  SW25_GENERIC_EFFECT_DEFAULTS,
  SW25_GENERIC_EFFECT_TYPE_OPTIONS,
  SW25_GENERIC_MAGICAL_OPTIONS
} = await import("../module/effects/effect-configurator.mjs");
const {
  buildSw25ConfiguredEffect,
  applySw25ConfiguredEffect,
  configuredEffectApplication,
  describeSw25ConfiguredEffectSummary,
  renderSw25ConfiguredEffectEntry,
  normalizeSw25ConfiguredEffect
} = await import("../module/effects/configured-effect.mjs");
const {
  collectCancellationCandidates,
  effectCancellationEligibility,
  resolveCancellationAttempt,
  wordbreakDurationEligibility
} = await import("../module/effects/effect-cancellation.mjs");

const genericValues = (overrides = {}) => ({
  id: "generic-session-id",
  ...SW25_GENERIC_EFFECT_DEFAULTS,
  ...overrides
});

// ── Generic form adapter and descriptor ────────────────────────────────────

console.log("=== Generic effects: form adaptation and classification ===");

{
  const defaults = buildSw25GenericEffectConfiguration(genericValues());
  assert.equal(defaults.ok, true, JSON.stringify(defaults));
  assert.equal(defaults.configured.rules.length, 0, "a generic effect has no mechanical rules");
  assert.equal(defaults.configured.isMagical, false, "new generic effects default to non-magical/unconfirmed");
  assert.deepEqual(SW25_GENERIC_MAGICAL_OPTIONS.map(option => option.id), ["nonmagical", "magical"]);
  assert.deepEqual(SW25_GENERIC_EFFECT_TYPE_OPTIONS.map(option => option.id), ["", "curse", "prone", "grapple", "grabbed", "immobile"]);
  assert.deepEqual(SW25_GENERIC_DURATION_OPTIONS.map(option => option.id), ["", "rounds", "minutes", "hours", "days", "permanent", "other"]);
  assert.equal(defaults.configured.successValue, 0);
  assert.equal(defaults.configured.successValueSource, "fixed", "the creator's explicit SV is authoritative, including zero");
  assert.equal(defaults.configured.effectType, null);
  assert.equal(defaults.configured.durationScale, null);
  assert.equal(defaults.configured.initialDuration, null);
  assert.equal(defaults.configured.durationAnchor, null);
  assert.equal(defaults.configured.origin, null, "manual effects never borrow an origin");
  assert.equal(defaults.configured.id, "generic-session-id");

  const magical = buildSw25GenericEffectConfiguration(genericValues({
    name: "  Blessing  ",
    description: "  A test blessing.  ",
    magical: "magical",
    successValue: " 12 ",
    durationScale: "minutes"
  }));
  assert.equal(magical.ok, true);
  assert.equal(magical.configured.name, "Blessing");
  assert.equal(magical.configured.description, "A test blessing.");
  assert.equal(magical.configured.isMagical, true);
  assert.equal(magical.configured.successValue, 12);
  assert.equal(magical.configured.successValueSource, "fixed");
  assert.equal(magical.configured.durationScale, "minutes");
  assert.equal(magical.configured.initialDuration, null, "manual scales have no numeric countdown");
  assert.equal(magical.configured.durationAnchor, null);
  assert.deepEqual(magical.configured.rules, []);

  const nonMagical = buildSw25GenericEffectConfiguration(genericValues({ magical: "nonmagical" }));
  assert.equal(nonMagical.ok, true);
  assert.equal(nonMagical.configured.isMagical, false);

  const legacyUnspecified = buildSw25GenericEffectConfiguration(genericValues({ magical: "unspecified" }));
  assert.equal(legacyUnspecified.ok, true);
  assert.equal(legacyUnspecified.configured.isMagical, false, "the retired unspecified choice normalizes to false");

  const legacyNull = buildSw25GenericEffectConfiguration(genericValues({ magical: null }));
  assert.equal(legacyNull.ok, true);
  assert.equal(legacyNull.configured.isMagical, false);

  const invalidMagic = buildSw25GenericEffectConfiguration(genericValues({ magical: "sometimes" }));
  assert.equal(invalidMagic.ok, false);
  assert.equal(invalidMagic.code, "invalid-magical");

  for (const successValue of ["", " ", "-1", "+1", "1.5", "1e2", "two", -1, 1.5, "0x10"]) {
    const rejected = buildSw25GenericEffectConfiguration(genericValues({ successValue }));
    assert.equal(rejected.ok, false, `should reject SV ${JSON.stringify(successValue)}`);
    assert.match(rejected.error, /successValue must be an integer >= 0/);
  }
  for (const durationScale of ["turns", "native", "instant"]) {
    const rejected = buildSw25GenericEffectConfiguration(genericValues({ durationScale }));
    assert.equal(rejected.ok, false, `${durationScale} is not a generic persistent descriptor scale`);
  }
  for (const effectType of ["unknown", "Curse", 1, true, {}, []]) {
    const rejected = buildSw25GenericEffectConfiguration(genericValues({ effectType }));
    assert.equal(rejected.ok, false, `should reject unsupported Effect Type ${JSON.stringify(effectType)}`);
    assert.equal(rejected.code, "invalid-effect-type");
  }
  for (const effectType of [undefined, null, "", " "]) {
    const unclassified = buildSw25GenericEffectConfiguration(genericValues({ effectType }));
    assert.equal(unclassified.ok, true);
    assert.equal(unclassified.configured.effectType, null);
  }
  for (const durationValue of [undefined, null, "", " ", "0", "-1", "+1", "1.5", "1e2", "two", 0, -1, 1.5]) {
    const rejected = buildSw25GenericEffectConfiguration(genericValues({ durationScale: "rounds", durationValue }));
    assert.equal(rejected.ok, false, `should reject round count ${JSON.stringify(durationValue)}`);
    assert.match(rejected.error, /positive integer initialDuration/);
  }

  const counted = buildSw25GenericEffectConfiguration(genericValues({
    name: "Counted Blessing",
    successValue: "9",
    effectType: " prone ",
    durationScale: "rounds",
    durationValue: " 3 "
  }));
  assert.equal(counted.ok, true, JSON.stringify(counted));
  assert.equal(counted.configured.effectType, "prone");
  assert.equal(counted.configured.initialDuration, 3);
  assert.deepEqual(counted.configured.durationAnchor, { regime: "roundEnd" });

  // Changing away from rounds makes a stale hidden counter irrelevant.
  const staleCounter = buildSw25GenericEffectConfiguration(genericValues({ durationScale: "hours", durationValue: "bad" }));
  assert.equal(staleCounter.ok, true);
  assert.equal(staleCounter.configured.initialDuration, null);

  const blankName = buildSw25GenericEffectConfiguration(genericValues({ name: "   " }));
  assert.equal(blankName.ok, false);
  assert.match(blankName.error, /non-blank name/);

  // Property survival through the serialized transport used by the HTML entry.
  assert.deepEqual(normalizeSw25ConfiguredEffect(JSON.parse(JSON.stringify(magical.configured))), magical.configured);
  assert.deepEqual(normalizeSw25ConfiguredEffect(JSON.parse(JSON.stringify(counted.configured))), counted.configured);
  const legacyDescriptor = { ...magical.configured, isMagical: null };
  assert.equal(normalizeSw25ConfiguredEffect(legacyDescriptor).isMagical, false, "legacy HTML descriptors normalize null to false");
  const missingDescriptor = { ...magical.configured };
  delete missingDescriptor.isMagical;
  assert.equal(normalizeSw25ConfiguredEffect(missingDescriptor).isMagical, false, "legacy HTML descriptors normalize a missing flag to false");
}

// ── Preview, HTML and application payload ──────────────────────────────────

console.log("=== Generic effects: preview HTML and application payload ===");

{
  const configured = buildSw25GenericEffectConfiguration(genericValues({
    name: "Blessing",
    description: "A test blessing.",
    magical: "magical",
    successValue: "12",
    durationScale: "minutes"
  })).configured;

  const summary = describeSw25ConfiguredEffectSummary(configured);
  assert.equal(summary, "Generic effect · Magical · SV 12 · Minutes (manual)");
  const countedSummary = describeSw25ConfiguredEffectSummary(buildSw25GenericEffectConfiguration(genericValues({
    name: "Prone for Two Rounds",
    effectType: "prone",
    durationScale: "rounds",
    durationValue: "2"
  })).configured);
  assert.equal(countedSummary, "Generic effect · Non-magical · SV 0 · Type: prone · 2 rounds (round end)");

  // The boolean classification and fixed SV are always visible in the preview.
  assert.equal(
    describeSw25ConfiguredEffectSummary(buildSw25GenericEffectConfiguration(genericValues({ magical: "nonmagical" })).configured),
    "Generic effect · Non-magical · SV 0"
  );
  assert.equal(
    describeSw25ConfiguredEffectSummary(buildSw25GenericEffectConfiguration(genericValues({ magical: "unspecified" })).configured),
    "Generic effect · Non-magical · SV 0",
    "legacy unspecified descriptors preview their normalized false value"
  );

  const html = renderSw25ConfiguredEffectEntry(configured);
  assert.match(html, /draggable="true"/);
  assert.ok(html.includes("Blessing"));
  assert.ok(html.includes("Magical"));
  assert.ok(html.includes("A test blessing."));

  const payload = configuredEffectApplication(configured);
  assert.equal(payload.family, "Blessing");
  assert.equal(payload.origin, null);
  assert.deepEqual(payload.rules, []);
  assert.equal(payload.isMagical, true);
  assert.equal(payload.durationScale, "minutes");
  assert.equal(payload.initialDuration, null);
  assert.equal(payload.durationAnchor, null);
  assert.equal(payload.cast.successValue, 12);
  assert.equal(payload.successValueSource, "fixed");
  assert.equal(payload.flags["sw25-taka"].configuredEffectId, configured.id);
  assert.equal(payload.flags["sw25-taka"].configuredEffectDescription, "A test blessing.");

  // Damage Vulnerability keeps its rule summary and remains unaffected.
  const damageVulnerability = buildSw25DamageVulnerabilityConfiguration({
    id: "dv",
    name: "Damage Vulnerability",
    description: "",
    additionalDamage: "2",
    category: "any",
    element: "any",
    source: ""
  }).configured;
  assert.equal(describeSw25ConfiguredEffectSummary(damageVulnerability), "Any Category · Any Element · +2");
  assert.equal(configuredEffectApplication(damageVulnerability).durationScale, null);
}

// ── Persistence through EffectService (the single write path) ──────────────

console.log("=== Generic effects: persistence through EffectService ===");

{
  const configurations = [
    buildSw25GenericEffectConfiguration(genericValues({
      id: "generic-default",
      name: "Default Effect",
      description: "Defaults to false."
    })).configured,
    buildSw25GenericEffectConfiguration(genericValues({
      id: "generic-magical",
      name: "Blessing",
      description: "A test blessing.",
      magical: "magical",
      successValue: "12",
      durationScale: "hours"
    })).configured,
    buildSw25GenericEffectConfiguration(genericValues({
      id: "generic-nonmagical",
      name: "Mundane Effect",
      description: "Explicitly non-magical.",
      magical: "nonmagical"
    })).configured,
    buildSw25GenericEffectConfiguration(genericValues({
      id: "generic-rounds",
      name: "Counted Effect",
      description: "Expires through roundEnd.",
      successValue: "7",
      effectType: "curse",
      durationScale: "rounds",
      durationValue: "2"
    })).configured
  ];

  const created = [];
  const actor = {
    id: "generic-target",
    uuid: "Actor.genericTarget",
    name: "Target",
    isOwner: true,
    effects: [],
    async createEmbeddedDocuments(type, documents) {
      assert.equal(type, "ActiveEffect");
      created.push(...documents);
      return documents.map((document, index) => ({
        ...document,
        id: `created-${created.length - documents.length + index}`,
        uuid: `Actor.genericTarget.ActiveEffect.created-${created.length - documents.length + index}`
      }));
    }
  };

  for (const configured of configurations) {
    const result = await applySw25ConfiguredEffect(actor, configured, { notify: false });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(created.length, 4);
  assert.equal(created[0].system.isMagical, false, "the generic default persists as false");
  assert.equal(created[1].system.isMagical, true, "explicit Magical persists as true");
  assert.equal(created[2].system.isMagical, false, "explicit Non-magical persists as false");
  for (const stored of created) {
    assert.equal(stored.type, "sw25Effect");
    assert.equal(typeof stored.system.isMagical, "boolean");
    assert.deepEqual(stored.system.rules, []);
    assert.equal(Object.hasOwn(stored, "origin"), false, "origin: null produces no native origin");
  }
  assert.equal(created[1].name, "Blessing");
  assert.equal(created[1].system.family, "Blessing");
  assert.equal(created[1].system.successValue, 12);
  assert.equal(created[1].system.successValueSource, "fixed");
  assert.equal(created[1].system.durationScale, "hours");
  assert.equal(created[1].system.initialDuration, null);
  assert.equal(created[1].system.remainingDuration, null);
  assert.equal(created[1].system.durationAnchor, null);
  assert.equal(created[1].flags["sw25-taka"].configuredEffectId, configurations[1].id);
  assert.equal(created[1].flags["sw25-taka"].configuredEffectDescription, "A test blessing.");
  assert.equal(created[0].system.successValue, 0);
  assert.equal(created[0].system.successValueSource, "fixed", "an explicit fixed zero is not confused with unrecorded provenance");
  assert.equal(created[3].system.successValue, 7);
  assert.equal(created[3].system.effectType, "curse");
  assert.equal(created[3].system.durationScale, "rounds");
  assert.equal(created[3].system.initialDuration, 2);
  assert.equal(created[3].system.remainingDuration, 2, "EffectService initializes remainingDuration for a fresh rounds effect");
  assert.deepEqual(created[3].system.durationAnchor, {
    regime: "roundEnd", edge: "begin", combatantId: null, tokenId: null, state: "resolved"
  });
  assert.equal(created[3].duration?.value ?? null, null, "the native duration engine is not used");
  assert.equal(created[3].duration?.expiry ?? null, null);
}

{
  // EffectService itself applies the same defaults for legacy callers and
  // rejects malformed values instead of coercing them into a classification.
  const { applySw25Effect } = await import("../module/effects/effect-service.mjs");
  const created = [];
  const actor = {
    id: "service-target",
    uuid: "Actor.serviceTarget",
    name: "Service Target",
    effects: [],
    async createEmbeddedDocuments(type, documents) {
      created.push(...documents);
      return documents.map((document, index) => ({ ...document, id: `service-${created.length - documents.length + index}` }));
    }
  };
  const missing = await applySw25Effect(actor, { family: "Missing Legacy Flag", cast: { successValue: 0 } });
  const legacyNull = await applySw25Effect(actor, { family: "Null Legacy Flag", cast: { successValue: 0 }, isMagical: null });
  assert.equal(missing.ok, true, JSON.stringify(missing));
  assert.equal(legacyNull.ok, true, JSON.stringify(legacyNull));
  assert.deepEqual(created.map(document => document.system.isMagical), [false, false]);

  for (const isMagical of ["true", 1, 0, {}, []]) {
    const before = created.length;
    const rejected = await applySw25Effect(actor, { family: "Malformed Flag", cast: { successValue: 0 }, isMagical });
    assert.equal(rejected.ok, false, JSON.stringify(isMagical));
    assert.equal(rejected.code, "invalid-application");
    assert.equal(created.length, before, "malformed values are never persisted");
  }
}

// ── Dispel Magic and Wordbreak eligibility ─────────────────────────────────

console.log("=== Generic effects: magical classification reaches cancellation ===");

{
  const systemFor = (configured, overrides = {}) => ({
    family: configured.family,
    isMagical: configured.isMagical,
    effectType: configured.effectType,
    durationScale: configured.durationScale,
    initialDuration: configured.initialDuration,
    successValue: configured.successValue,
    successValueSource: configured.successValueSource,
    rules: configured.rules,
    ...overrides
  });
  const generic = overrides => buildSw25GenericEffectConfiguration(genericValues(overrides)).configured;

  const magical = systemFor(generic({ magical: "magical", successValue: "12", durationScale: "minutes" }));
  const nonMagical = systemFor(generic({ magical: "nonmagical", successValue: "12", durationScale: "minutes" }));
  const legacyDefault = systemFor(generic({ magical: "unspecified", successValue: "12", durationScale: "minutes" }));

  // Dispel Magic accepts only the explicit boolean true. Normalized legacy
  // values are false; direct null/missing legacy inputs remain safe as well.
  assert.equal(effectCancellationEligibility(magical, "dispel").eligible, true);
  assert.equal(effectCancellationEligibility(nonMagical, "dispel").eligible, false);
  assert.equal(effectCancellationEligibility(legacyDefault, "dispel").eligible, false);
  assert.equal(effectCancellationEligibility({ ...magical, isMagical: null }, "dispel").eligible, false);
  assert.equal(effectCancellationEligibility({ ...magical, isMagical: undefined }, "dispel").eligible, false);

  // Wordbreak accepts both magical and non-magical effects; the magical flag is
  // never one of its restrictions. Duration is the deciding input.
  for (const system of [magical, nonMagical, legacyDefault]) {
    assert.equal(effectCancellationEligibility(system, "wordbreak").eligible, true);
  }

  // A generic effect with origin: null can still be recognized as magical.
  assert.equal(generic({ magical: "magical" }).origin, null);
  const actor = {
    effects: [{
      id: "generic-effect",
      name: "Blessing",
      type: "sw25Effect",
      origin: null,
      system: magical
    }]
  };
  const candidates = collectCancellationCandidates(actor, "dispel");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].eligibility.eligible, true);

  // Existing Wordbreak exclusions are preserved.
  assert.equal(effectCancellationEligibility(systemFor(generic({ magical: "magical", durationScale: "permanent" })), "wordbreak").eligible, false);
  assert.equal(effectCancellationEligibility(systemFor(generic({ magical: "magical" })), "wordbreak").eligible, false, "no duration is not proven > 10 seconds");
  assert.equal(effectCancellationEligibility({ ...magical, effectType: "curse" }, "wordbreak").eligible, false);
  assert.equal(effectCancellationEligibility({ ...magical, effectType: "prone" }, "wordbreak").eligible, false);
  assert.equal(effectCancellationEligibility({ ...magical, effectType: "curse" }, "dispel").eligible, false);

  // Instant/X is the printed exception for a bare/one-round instant.
  assert.equal(wordbreakDurationEligibility({ durationScale: null }, { instantX: true }).eligible, true);
  assert.equal(wordbreakDurationEligibility({ durationScale: "rounds", initialDuration: 1 }, { instantX: true }).eligible, true);

  // The configured fixed SV reaches cancellation as authoritative data.
  const attempt = resolveCancellationAttempt({
    mechanism: "wordbreak",
    attemptSuccessValue: 13,
    system: magical
  });
  assert.equal(attempt.eligible, true);
  assert.equal(attempt.effectSuccessValue, 12);
  assert.equal(attempt.needsSuccessValue, false);
  assert.equal(attempt.cancelled, true);
  const tie = resolveCancellationAttempt({
    mechanism: "wordbreak",
    attemptSuccessValue: 12,
    system: magical
  });
  assert.equal(tie.cancelled, false, "ties never cancel");
  const fixedZero = resolveCancellationAttempt({
    mechanism: "dispel",
    attemptSuccessValue: 0,
    system: systemFor(generic({ magical: "magical" }))
  });
  assert.equal(fixedZero.effectSuccessValue, 0, "fixed SV 0 is authoritative rather than unrecorded");
  assert.equal(fixedZero.needsSuccessValue, false);
  assert.equal(fixedZero.cancelled, false);

  const counted = systemFor(generic({ magical: "magical", successValue: "8", durationScale: "rounds", durationValue: "2" }));
  assert.equal(effectCancellationEligibility(counted, "wordbreak").eligible, true, "counted rounds retain their cancellation role");
  assert.equal(effectCancellationEligibility(systemFor(generic({ effectType: "curse", durationScale: "minutes" })), "wordbreak").eligible, false);
  assert.equal(effectCancellationEligibility(systemFor(generic({ effectType: "prone", durationScale: "minutes" })), "wordbreak").eligible, false);
}

console.log("effects-generic.test.mjs: all generic/classification assertions passed");
