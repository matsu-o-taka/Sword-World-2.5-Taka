// Sword World 2.5 - GM Effects configurator tests (no DOM or Foundry server).
//
// Exercises the real form adapter, configured-effect renderer/application
// payload, controlled-Actor resolution and EffectService write path. The only
// Foundry UI surface stubbed is the ApplicationV2 base needed to import the
// application and probe its GM gates without rendering a window.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class ApplicationV2Stub {
  _canRender() { return true; }
}

const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
})[character]);

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => "configurator-generated-id",
    escapeHTML
  },
  applications: {
    api: {
      ApplicationV2: ApplicationV2Stub,
      HandlebarsApplicationMixin: Base => class HandlebarsApplication extends Base {}
    }
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
  buildSw25DamageVulnerabilityConfiguration,
  resolveSw25ControlledActor,
  SW25_DAMAGE_VULNERABILITY_DEFAULTS
} = await import("../module/effects/effect-configurator.mjs");
const {
  applySw25ConfiguredEffect,
  configuredEffectApplication,
  renderSw25ConfiguredEffectEntry,
  SW25_CONFIGURED_EFFECT_ATTRIBUTE
} = await import("../module/effects/configured-effect.mjs");
const { EffectsApp } = await import("../module/ui/effects.mjs");
const { Sw25EffectInspector } = await import("../module/apps/effect-inspector.mjs");

const values = (overrides = {}) => ({
  id: "editing-session-id",
  ...SW25_DAMAGE_VULNERABILITY_DEFAULTS,
  ...overrides
});

console.log("=== Effects configurator: form adaptation and validation ===");

{
  const built = buildSw25DamageVulnerabilityConfiguration(values({
    name: "  Fire Vulnerability  ",
    description: "  Additional fire damage.  ",
    additionalDamage: "+3",
    category: "magical",
    element: "Fire",
    source: " Actor.source.Item.firebolt "
  }));
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.configured.id, "editing-session-id");
  assert.equal(built.configured.name, "Fire Vulnerability");
  assert.equal(built.configured.description, "Additional fire damage.");
  assert.equal(built.configured.origin, null, "manual entries have no borrowed origin");
  assert.deepEqual(built.configured.rules, [{
    key: "damageVulnerability",
    label: "Damage Vulnerability",
    value: 3,
    category: "magical",
    element: "fire",
    source: "Actor.source.Item.firebolt"
  }]);

  const negative = buildSw25DamageVulnerabilityConfiguration(values({ additionalDamage: "-4" }));
  assert.equal(negative.ok, true);
  assert.equal(negative.configured.rules[0].value, -4);
  const padded = buildSw25DamageVulnerabilityConfiguration(values({ additionalDamage: " 5 " }));
  assert.equal(padded.ok, true);
  assert.equal(padded.configured.rules[0].value, 5);

  // Malformed values are passed to the existing validator, not guessed or
  // numerically coerced into a different valid configuration.
  for (const additionalDamage of ["", " ", "2.5", "1e2", "two", "2x"]) {
    const rejected = buildSw25DamageVulnerabilityConfiguration(values({ additionalDamage }));
    assert.equal(rejected.ok, false, `should reject ${JSON.stringify(additionalDamage)}`);
    assert.equal(rejected.code, "invalid-rule");
    assert.match(rejected.error, /must be an integer/);
  }

  const blankName = buildSw25DamageVulnerabilityConfiguration(values({ name: "   " }));
  assert.equal(blankName.ok, false);
  assert.match(blankName.error, /non-blank name/);
  const badCategory = buildSw25DamageVulnerabilityConfiguration(values({ category: "other" }));
  assert.equal(badCategory.ok, false);
  assert.match(badCategory.error, /category/);
  const badElement = buildSw25DamageVulnerabilityConfiguration(values({ element: "Varies" }));
  assert.equal(badElement.ok, false);
  assert.equal(badElement.code, "unknown-element");

  for (const source of ["", undefined, null]) {
    const anySource = buildSw25DamageVulnerabilityConfiguration(values({ source }));
    assert.equal(anySource.ok, true);
    assert.equal(anySource.configured.rules[0].source, null);
  }
  const whitespaceSource = buildSw25DamageVulnerabilityConfiguration(values({ source: "   " }));
  assert.equal(whitespaceSource.ok, false, "whitespace is not silently converted to Any Source");
  assert.match(whitespaceSource.error, /source/);

  // The caller-owned editing-session id survives parameter changes.
  const changed = buildSw25DamageVulnerabilityConfiguration(values({ additionalDamage: "-7", element: "water-ice" }));
  assert.equal(changed.ok, true);
  assert.equal(changed.configured.id, built.configured.id);
}

console.log("=== Effects configurator: preview HTML and application payload ===");

const configured = buildSw25DamageVulnerabilityConfiguration(values({
  name: "Fire Vulnerability",
  description: "Takes additional damage from fire.",
  additionalDamage: "+3",
  category: "magical",
  element: "fire",
  source: "Actor.source.Item.firebolt"
})).configured;

{
  const html = renderSw25ConfiguredEffectEntry(configured);
  assert.match(html, /draggable="true"/);
  assert.ok(html.includes(SW25_CONFIGURED_EFFECT_ATTRIBUTE));
  assert.ok(html.includes("Fire Vulnerability"));
  assert.ok(html.includes("Magical"));
  assert.ok(html.includes("Fire"));
  assert.ok(html.includes("+3"));
  assert.ok(html.includes("Takes additional damage from fire."));

  const payload = configuredEffectApplication(configured);
  assert.equal(payload.origin, null);
  assert.equal(payload.family, configured.name);
  assert.deepEqual(payload.rules, configured.rules);
  assert.equal(payload.flags["sw25-taka"].configuredEffectId, "editing-session-id");
  assert.equal(payload.flags["sw25-taka"].configuredEffectDescription, configured.description);
}

console.log("=== Effects configurator: exactly one controlled Actor ===");

{
  const actor = { uuid: "Actor.one", name: "One" };
  const other = { uuid: "Actor.two", name: "Two" };
  assert.equal(resolveSw25ControlledActor(null).code, "no-selection");
  assert.equal(resolveSw25ControlledActor([]).code, "no-selection");
  assert.equal(resolveSw25ControlledActor([{}, { actor: null }]).code, "no-selection");
  assert.deepEqual(resolveSw25ControlledActor([{ actor }]), { ok: true, actor });
  assert.deepEqual(
    resolveSw25ControlledActor([{ actor }, { actor }]),
    { ok: true, actor },
    "two tokens for the same Actor are one Actor selection"
  );
  assert.equal(resolveSw25ControlledActor([{ actor }, { actor: other }]).code, "ambiguous-selection");
}

console.log("=== Effects configurator: direct application through EffectService ===");

{
  const created = [];
  const actor = {
    id: "target",
    uuid: "Actor.target",
    name: "Target",
    effects: [],
    async createEmbeddedDocuments(type, documents) {
      assert.equal(type, "ActiveEffect");
      created.push(...documents);
      return documents.map((document, index) => ({
        ...document,
        id: `created-${index}`,
        uuid: `Actor.target.ActiveEffect.created-${index}`
      }));
    }
  };

  const result = await applySw25ConfiguredEffect(actor, configured, { notify: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(created.length, 1);
  assert.equal(Object.hasOwn(created[0], "origin"), false, "null origin stays absent in native creation data");
  assert.equal(created[0].system.rules[0].source, "Actor.source.Item.firebolt");
  assert.equal(created[0].system.rules[0].value, 3);
  assert.equal(created[0].flags["sw25-taka"].configuredEffectId, configured.id);
  assert.equal(created[0].name, "Fire Vulnerability");
  assert.equal(created[0].system.isMagical, false, "configured effects persist a boolean default");
}

console.log("=== Effects configurator: existing inspector removal workflow ===");

{
  let confirmations = 0;
  let confirmRemoval = false;
  foundry.applications.api.DialogV2 = {
    confirm: async () => {
      confirmations++;
      return confirmRemoval;
    }
  };

  const actor = { name: "Inspector Target", effects: [] };
  const effect = {
    id: "inspect-me",
    name: "Fire Vulnerability",
    type: "sw25Effect",
    parent: actor,
    deleteCalls: 0,
    async delete() {
      this.deleteCalls++;
      actor.effects = actor.effects.filter(candidate => candidate !== this);
    }
  };
  actor.effects.push(effect);
  const inspector = Object.create(Sw25EffectInspector.prototype);
  inspector._effect = effect;
  inspector.closeCalls = 0;
  inspector.close = async () => { inspector.closeCalls++; };

  const cancelled = await inspector._removeEffect();
  assert.equal(cancelled.code, "cancelled");
  assert.equal(effect.deleteCalls, 0);
  assert.equal(inspector.closeCalls, 0);

  confirmRemoval = true;
  const removed = await inspector._removeEffect();
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.code, "removed");
  assert.equal(effect.deleteCalls, 1, "EffectService performs the sole authorized deletion");
  assert.equal(actor.effects.length, 0);
  assert.equal(inspector.closeCalls, 1);
  assert.equal(confirmations, 2);
}

console.log("=== Effects configurator: registration and GM gates ===");

{
  game.user.isGM = false;
  assert.equal(EffectsApp.prototype._canRender.call({}, {}), false);
  assert.equal(notifications.at(-1).type, "warn");

  const statuses = [];
  const denied = await EffectsApp.prototype._applyToSelectedActor.call({
    _setActionStatus: (message, state) => statuses.push({ message, state })
  });
  assert.equal(denied.code, "not-gm");
  assert.equal(statuses.at(-1).state, "error");

  game.user.isGM = true;
  assert.equal(EffectsApp.prototype._canRender.call({}, {}), true, "GM render delegates to ApplicationV2");

  const [entryPoint, inspector, inspectorTemplate] = await Promise.all([
    readFile(new URL("../sw25.mjs", import.meta.url), "utf8"),
    readFile(new URL("../module/apps/effect-inspector.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/apps/effect-inspector.hbs", import.meta.url), "utf8")
  ]);
  const menu = entryPoint.match(/game\.settings\.registerMenu\("sw25-taka", "effects", \{([\s\S]*?)\n  \}\);/);
  assert.ok(menu, "independent Effects settings menu is registered");
  assert.match(menu[1], /type: EffectsApp/);
  assert.match(menu[1], /restricted: true/);
  assert.ok(entryPoint.includes('registerMenu("sw25-taka", "gameRules"'), "Rules menu remains independent");

  assert.match(inspector, /removeSw25Effect\(this\._effect\?\.parent, this\._effect\?\.id/);
  assert.doesNotMatch(inspector, /createEmbeddedDocuments|\.delete\s*\(/, "inspector never writes ActiveEffects directly");
  assert.match(inspectorTemplate, /\{\{#if canRemove\}\}/);
  assert.match(inspectorTemplate, /data-inspector-remove/);
}

console.log("=== Effects configurator: generic effect wiring ===");

{
  // The application must route the selected type to the matching adapter and
  // keep both type sections in the template; the generic path may not depend
  // on Damage Vulnerability fields.
  const [application, template] = await Promise.all([
    readFile(new URL("../module/ui/effects.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/apps/effects.hbs", import.meta.url), "utf8")
  ]);
  assert.match(application, /buildSw25GenericEffectConfiguration/);
  assert.match(application, /buildSw25DamageVulnerabilityConfiguration/);
  assert.match(application, /data-effect-section/);
  assert.ok(application.includes('{ id: "generic", label: "Generic Effect" }'));
  assert.ok(application.includes('{ id: "damageVulnerability", label: "Damage Vulnerability" }'));

  assert.match(template, /data-effect-configurator-form/);
  assert.match(template, /data-effect-section="generic"/);
  assert.match(template, /data-effect-section="damageVulnerability"/);
  assert.match(template, /name="genericName"/);
  assert.match(template, /name="genericDescription"/);
  assert.match(template, /name="genericMagical"/);
  assert.doesNotMatch(template, /Unspecified|unspecified/, "the configurator offers only Magical and Non-magical");
  assert.match(template, /name="genericSuccessValue"/);
  assert.match(template, /name="genericEffectType"/);
  assert.match(template, /name="genericDurationScale"/);
  assert.match(template, /name="genericDurationValue"/);
  assert.match(template, /data-generic-rounds/);
  assert.match(application, /genericRounds: this\._genericState\.durationScale === "rounds"/);
  assert.match(application, /field\.hidden = this\._genericState\.durationScale !== "rounds"/);
  assert.match(template, /name="effectType"/);
  assert.match(template, /data-effect-preview/);
  assert.match(template, /data-effect-html/);
  assert.match(template, /Instant and Instant\/X immediate resolution is action-specific and is not offered here/);

  const sections = [
    { dataset: { effectSection: "generic" }, hidden: true },
    { dataset: { effectSection: "damageVulnerability" }, hidden: false }
  ];
  const rounds = [{ hidden: true }];
  const root = {
    querySelectorAll(selector) {
      if (selector === "[data-effect-section]") return sections;
      if (selector === "[data-generic-rounds]") return rounds;
      return [];
    }
  };
  const state = { element: root, _effectType: "generic", _genericState: { durationScale: "rounds" } };
  EffectsApp.prototype._syncEffectTypeSections.call(state);
  assert.deepEqual(sections.map(section => section.hidden), [false, true]);
  assert.equal(rounds[0].hidden, false);
  state._genericState.durationScale = "minutes";
  EffectsApp.prototype._syncEffectTypeSections.call(state);
  assert.equal(rounds[0].hidden, true, "the numeric counter is visible only for counted rounds");
}

console.log("effects-configurator: all checks passed");
