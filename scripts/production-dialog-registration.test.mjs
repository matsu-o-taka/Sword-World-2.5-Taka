// Sword World 2.5 - production dialog registration test
// Verifies the real production entry point (sw25.mjs) loads the shared
// roll-modifier dialog module as an import-time side effect, so attack flows
// can open it without the "temporary modifier dialog has not been registered"
// failure. Imports the actual sources with only the Foundry globals needed to
// evaluate the module graph (sheet/Application base classes and hook
// registration); no mocks of the dialog or registration machinery.
//
// Before this test existed, `npm run check` never executed the production
// import graph, which is why the missing registration shipped unnoticed.

import assert from "node:assert/strict";

class ApplicationStub {}
class ActorSheetStub {}
class ItemSheetStub {}

globalThis.foundry = {
  appv1: {
    api: { Application: ApplicationStub },
    sheets: { ActorSheet: ActorSheetStub, ItemSheet: ItemSheetStub }
  }
};

// Chrome for the hook regression check below: a jQuery-like chainable whose
// every phase records that the hook wrapped its html argument instead of
// calling html.find on a raw HTMLElement (the Foundry v14 crash pattern).
const chainable = () => {
  const stub = {
    eq: () => chainable(),
    get: () => null,
    length: 0,
    0: null
  };
  const wrap = name => (...args) => {
    if (typeof args[0] === "function") args[0]({ preventDefault() {}, currentTarget: null });
    return stub;
  };
  for (const method of ["find", "on", "off", "one", "prop", "html", "attr", "text", "val", "addClass", "removeClass", "toggleClass", "propAll"]) {
    stub[method] = wrap(method);
  }
  return stub;
};
const jqueryLike = arg => {
  if (arg && typeof arg === "object" && arg.jquery) return arg;
  return chainable();
};
globalThis.$ = jqueryLike;
globalThis.jQuery = jqueryLike;

// Capture hook registrations so the chat render hooks can be executed.
const hookListeners = new Map();
const onceListeners = new Map();
const listeners = name => {
  if (!hookListeners.has(name)) hookListeners.set(name, []);
  return hookListeners.get(name);
};
globalThis.Hooks = {
  once(name, listener) {
    if (!onceListeners.has(name)) onceListeners.set(name, []);
    onceListeners.get(name).push(listener);
  },
  on(name, listener) {
    if (name === "renderChatMessageHTML" || name === "renderChatMessage") listeners(name).push(listener);
  },
  onceListeners
};

// Enough environment for the "ready" initializers that register chat hooks:
// a non-GM user short-circuits the GM-only setup paths (scene sweeps etc.).
globalThis.game = { user: { isGM: false }, scenes: [], socket: { on() {} } };
globalThis.Canvas = class {};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.ChatMessage = { getSpeaker: () => ({}) };
globalThis.Roll = class Roll { constructor() {} };
globalThis.canvas = null;

await import(new URL("../sw25.mjs", import.meta.url).href);

const { RollModifiersDialog } = await import(new URL(
  "../module/apps/roll-modifiers-dialog.mjs",
  import.meta.url
).href);
const { getRegisteredRollModifiersDialog, registerRollModifiersDialog } =
  await import(new URL("../module/rules/roll-modifiers.mjs", import.meta.url).href);

console.log("=== Production dialog registration (real sw25.mjs import) ===");

// 1. sw25.mjs loading registers the real dialog as a side effect.
const registered = getRegisteredRollModifiersDialog();
assert.equal(typeof registered, "function", "sw25.mjs import registered a dialog constructor");
assert.equal(registered, RollModifiersDialog, "The registered dialog is the real RollModifiersDialog");
assert.ok(registered.prototype instanceof ApplicationStub, "RollModifiersDialog extends foundry.appv1.api.Application");

// 2. The registration contract still accepts a valid constructor and ignores
//    garbage, matching the guard behaviour used at load time.
const sentinel = class {};
registerRollModifiersDialog(sentinel);
assert.equal(getRegisteredRollModifiersDialog(), sentinel, "Latest registration wins");
registerRollModifiersDialog(null);
assert.equal(getRegisteredRollModifiersDialog(), sentinel, "Non-function registrations are ignored");
registerRollModifiersDialog(RollModifiersDialog);
assert.equal(getRegisteredRollModifiersDialog(), RollModifiersDialog, "Restored after contract probe");

console.log("=== Production chat hooks tolerate raw HTMLElement html (Foundry v14) ===");

// 3. Every system chat hook must wrap the html argument with $(html) before
//    calling html.find. In Foundry v14 the hook receives a raw HTMLElement,
//    so calling html.find directly throws "html.find is not a function"
//    (observed live in the Foundry notification pipeline). The probe passes
//    an argument without .find, so only wrapped hooks survive.
const fakeMessage = () => ({ getFlag: () => null });
const noFindHtml = Object.create(null);
let checked = 0;

// Drive the recorded "ready" initializers so their chat hooks register, then
// verify every chat hook wraps its html argument.
for (const listener of onceListeners.get("ready") || []) listener();

for (const eventName of ["renderChatMessageHTML", "renderChatMessage"]) {
  const registrations = listeners(eventName);
  assert.ok(registrations.length > 0, `at least one production ${eventName} hook is registered`);
  for (const listener of registrations) {
    try {
      listener(fakeMessage(), noFindHtml, {});
    } catch (error) {
      if (String(error?.message).includes("html.find is not a function")) {
        assert.fail(`${eventName} hook called html.find on a raw HTMLElement`);
      }
      throw error;
    }
    checked++;
  }
}
assert.ok(checked >= 4, `checked ${checked} chat hooks; expected at least 4 (sw25, evasion-challenge, recovery-items, spell-effects, damage-application)`);

console.log(`production-dialog-registration: all checks passed (${checked} chat hooks verified)`);
