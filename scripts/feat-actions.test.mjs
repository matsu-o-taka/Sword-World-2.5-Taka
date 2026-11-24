// Sword World 2.5 - executable Combat Feat actions (T6.3).
//
// Covers the registry/dispatcher used by the character-sheet Combat Feats
// panel, plus static assertions on the sheet template and listener wiring.
// Wordbreak's own rules are covered by scripts/wordbreak.test.mjs; this suite
// only proves the contextual action reaches that implementation.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Minimal Foundry globals required by the modules imported transitively by
// rules/feat-actions.mjs (same contract as scripts/wordbreak.test.mjs).
globalThis.foundry = {
  data: { ActiveEffectTypeDataModel: class {} },
  utils: {
    escapeHTML: value => String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char]))
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
globalThis.ChatMessage = {
  create: async () => {},
  getSpeaker: () => ({})
};

const { featActionId, featSourceSlug, hasFeatAction, SW25_FEAT_ACTION_REGISTRY } =
  await import("../module/rules/feat-action-registry.mjs");
const { executeFeatAction, SW25_FEAT_ACTION_EXECUTORS } =
  await import("../module/rules/feat-actions.mjs");

const read = rel => readFile(new URL(rel, new URL("..", import.meta.url)), "utf8");

const feat = (system = {}, extra = {}) => ({ type: "feat", name: "Imported Combat Feat", system, ...extra });

console.log("=== Source slug extraction ===");
assert.equal(featSourceSlug("http://sw25.wikidot.com/feat:wordbreak"), "wordbreak");
assert.equal(featSourceSlug("https://sw25.wikidot.com/feat:wordbreak/"), "wordbreak");
assert.equal(featSourceSlug("https://sw25.wikidot.com/feat:wordbreak?rev=1#top"), "wordbreak");
assert.equal(featSourceSlug("feat:wordbreak"), "wordbreak");
assert.equal(featSourceSlug("HTTP://SW25.WIKIDOT.COM/FEAT:WORDBREAK"), "wordbreak");
assert.equal(featSourceSlug(""), "");
assert.equal(featSourceSlug(null), "");
assert.equal(featSourceSlug("https://sw25.wikidot.com/feat:unknown-feat"), "unknown-feat");

console.log("=== Identification ignores names and descriptions ===");
// The supported feat is identified by its stable source identifier.
assert.equal(featActionId(feat({ sourceUrl: "http://sw25.wikidot.com/feat:wordbreak" })), "wordbreak");
assert.equal(hasFeatAction(feat({ sourceUrl: "https://sw25.wikidot.com/feat:wordbreak" })), true);
// A translated display name does not change identification.
assert.equal(
  featActionId(feat({ sourceUrl: "http://sw25.wikidot.com/feat:wordbreak" }, { name: "Rompepalabras" })),
  "wordbreak"
);
// A feat merely named like the supported one does NOT gain an action.
assert.equal(featActionId(feat({}, { name: "Wordbreak" })), null);
// Unknown sources and non-feat Items never resolve.
assert.equal(featActionId(feat({ sourceUrl: "http://sw25.wikidot.com/feat:power-strike" })), null);
assert.equal(featActionId({ type: "ability", system: { sourceUrl: "http://sw25.wikidot.com/feat:wordbreak" } }), null);
assert.equal(featActionId(null), null);
assert.equal(hasFeatAction(feat({})), false);

console.log("=== Registry contains identifiers only (no protected content) ===");
for (const entry of Object.values(SW25_FEAT_ACTION_REGISTRY)) {
  assert.deepEqual(Object.keys(entry).sort(), ["actionId", "sourceSlug"]);
}
assert.equal(SW25_FEAT_ACTION_REGISTRY.wordbreak.actionId, "wordbreak");

console.log("=== Dispatcher forwards context; unsupported ids are refused ===");
const actor = { uuid: "Actor.caster", id: "caster", name: "Caster", system: {}, items: [], effects: [] };
const targets = [{ actor: { uuid: "Actor.target" } }];
let received = null;
const injected = await executeFeatAction(
  { item: feat({ sourceUrl: "http://sw25.wikidot.com/feat:wordbreak" }), actor, targets, extra: 7 },
  { executors: { wordbreak: async context => { received = context; return { ok: true, code: "injected" }; } } }
);
assert.equal(injected.code, "injected");
assert.equal(received.actor, actor);
assert.equal(received.targets, targets);
assert.equal(received.extra, 7);
assert.equal(Object.hasOwn(received, "item"), false, "the Item handle is not forwarded to the executor");

const refused = await executeFeatAction({ item: feat({ sourceUrl: "http://sw25.wikidot.com/feat:unknown" }) });
assert.equal(refused.ok, false);
assert.equal(refused.code, "unsupported-feat-action");
assert.equal(refused.actionId, null);

console.log("=== Wordbreak action reaches activateWordbreak ===");
assert.equal(typeof SW25_FEAT_ACTION_EXECUTORS.wordbreak, "function");
globalThis.game.user.targets = new Set();
globalThis.canvas.tokens.placeables = [];
const wordbreakResult = await executeFeatAction({
  item: feat({ sourceUrl: "http://sw25.wikidot.com/feat:wordbreak" }),
  actor,
  targets: []
});
assert.equal(wordbreakResult.ok, false);
assert.equal(wordbreakResult.code, "no-target", "activateWordbreak performs its own target validation");
assert.equal(wordbreakResult.results?.[0]?.cancellationMechanism, "wordbreak");

console.log("=== Sheet template: contextual button lives on the feat entry ===");
const template = await read("templates/actor/character-sheet.hbs");
const featsPanelStart = template.indexOf('class="paper-panel feats-box"');
assert.ok(featsPanelStart > 0, "Combat Feats panel exists");
const featsPanel = template.slice(featsPanelStart, template.indexOf("</section>", featsPanelStart));
assert.match(
  featsPanel,
  /\{\{#if item\.executableActionId\}\}[\s\S]*?data-action="execute-feat"/,
  "execution button is gated by the registered action id"
);
assert.ok(featsPanel.includes('class="feat-actions"'), "button belongs to the feat actions group");
assert.ok(featsPanel.includes('data-action="post-item"'), "normal chat publication is preserved");
assert.equal(
  (template.match(/data-action="execute-feat"/g) ?? []).length,
  1,
  "no execution button exists outside the Combat Feats panel"
);

console.log("=== Spells panel is untouched ===");
const spellsPanelStart = template.indexOf('class="magic-spells"');
assert.ok(spellsPanelStart > 0, "Spells panel exists");
const spellsPanel = template.slice(spellsPanelStart, template.indexOf("</section>", spellsPanelStart));
assert.ok(spellsPanel.includes('data-action="cast-spell"'), "spell casting controls remain");
assert.ok(!spellsPanel.includes('data-action="execute-feat"'), "no feat action leaks into the Spells panel");

console.log("=== Sheet wiring: context annotation + delegated listener ===");
const actorSheet = await read("module/actor/actor-sheet.mjs");
assert.ok(actorSheet.includes('import { featActionId } from "../rules/feat-action-registry.mjs";'));
assert.ok(actorSheet.includes('import { executeFeatAction } from "../rules/feat-actions.mjs";'));
assert.ok(actorSheet.includes("feat.executableActionId = featActionId(feat)"));
assert.ok(actorSheet.includes('html.find("[data-action=\'execute-feat\']")'));
assert.ok(actorSheet.includes("executeFeatAction({ item: feat, actor: this.actor, targets:"));
assert.equal(actorSheet.includes("activateWordbreak("), false, "the sheet never reimplements Wordbreak");

console.log("feat-actions.test.mjs: all T6.3 assertions passed.");
