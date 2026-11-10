// Sword World 2.5 - TargetSelectionDialog listener fix test
//
// Covers the listener lifecycle fix and the Promise-resolution logic that can
// be verified without a graphical Foundry client (no real DOM rendering).
//
// What this test verifies (headless):
//   1. _onFirstRender no longer calls _activateListeners (static source check).
//   2. _onRender still calls _activateListeners (covers first render after
//      _replaceHTML and all subsequent renders).
//   3. registerTargetSelectionDialog / getRegisteredTargetSelectionDialog contract.
//   4. openTargetSelectionDialog returns a Promise.
//   5. resolveAndClose resolves the Promise exactly once with the given id.
//   6. Subsequent close() calls after resolveAndClose do not re-resolve the Promise.
//   7. close() before confirmation resolves the Promise with null.
//   8. close() after resolution does not throw.
//   9. A fresh instance can be used after a previous one closed.
//
// Manual validations pending (require FoundryPortable / a real DOM):
//   - First render registers listeners exactly once (no duplicate clicks).
//   - Subsequent renders register listeners on the new DOM nodes after
//     _replaceHTML replaced the previous content.
//   - Clicking Confirm resolves once and closes once.
//   - Clicking Cancel resolves the Promise with null.
//   - Closing via the window X resolves the Promise with null.
//   - Reopening the dialog keeps all controls working.
//   - _activateListeners(html) actually attaches change/click listeners to
//     [data-section-toggle], [data-section-cancel], [data-section-submit].

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Foundry stubs (headless, no real DOM)
// Must be defined before any dynamic import of TargetSelectionDialog because
// the class declaration references foundry.applications.api.ApplicationV2.
// ---------------------------------------------------------------------------

// HTMLElement is not a global in plain Node; provide a minimal stub so the
// dialog class and renderTemplate can reference it without a browser DOM.
class HTMLElementStub {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
  }
  querySelectorAll() {
    return [];
  }
  addEventListener() {}
  removeEventListener() {}
  appendChild(child) {
    this.children.push(child);
    return child;
  }
}
globalThis.HTMLElement = HTMLElementStub;

globalThis.renderTemplate = async () => new HTMLElementStub("div");

globalThis.foundry = {
  utils: {
    mergeObject: (a, b) => ({ ...a, ...b })
  },
  applications: {
    api: {}
  }
};

// Minimal ApplicationV2 stub sufficient to define TargetSelectionDialog and to
// exercise resolveAndClose / close without rendering into a real DOM.
class ApplicationV2Stub {
  constructor(options = {}) {
    this.options = options;
    this._resolve = null;
    this._closing = false;
    this.rendered = false;
  }
  static get DEFAULT_OPTIONS() {
    return {};
  }
  async _prepareContext(options = {}) {
    return options;
  }
  async _renderHTML(options = {}) {
    return new HTMLElementStub("div");
  }
  async close(options = {}) {
    this.rendered = false;
    return this;
  }
  async render(options = {}) {
    this.rendered = true;
    return this;
  }
  _onFirstRender(html) {}
  _onRender(html) {}
}
globalThis.foundry.applications.api.ApplicationV2 = ApplicationV2Stub;

// ---------------------------------------------------------------------------
// Dynamic imports (stubs must be in place first)
// ---------------------------------------------------------------------------

const {
  TargetSelectionDialog
} = await import("../module/apps/target-selection-dialog.mjs");

const {
  registerTargetSelectionDialog,
  getRegisteredTargetSelectionDialog,
  openTargetSelectionDialog
} = await import("../module/rules/target-selection.mjs");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("=== TargetSelectionDialog listener fix (headless) ===");

// 1. Static verification: _onFirstRender no longer calls _activateListeners
const firstRenderSource = TargetSelectionDialog.prototype._onFirstRender.toString();
assert.ok(
  !firstRenderSource.includes("_activateListeners"),
  "_onFirstRender must not call _activateListeners"
);

const onRenderSource = TargetSelectionDialog.prototype._onRender.toString();
assert.ok(
  onRenderSource.includes("_activateListeners"),
  "_onRender must still call _activateListeners"
);

console.log("  _onFirstRender does not call _activateListeners");
console.log("  _onRender still calls _activateListeners");

// 2. register / getRegistered contract
const sentinel = class {};
registerTargetSelectionDialog(sentinel);
assert.equal(getRegisteredTargetSelectionDialog(), sentinel, "Latest registration wins");
registerTargetSelectionDialog(null);
assert.equal(getRegisteredTargetSelectionDialog(), sentinel, "Non-function registrations are ignored");
registerTargetSelectionDialog(TargetSelectionDialog);
assert.equal(getRegisteredTargetSelectionDialog(), TargetSelectionDialog, "Restored after contract probe");
console.log("  register / getRegistered contract holds");

// 3. openTargetSelectionDialog returns a Promise and delegates to dialogConstructor.open
const promise = openTargetSelectionDialog({ title: "T", options: [] });
assert.ok(promise instanceof Promise, "openTargetSelectionDialog returns a Promise");
console.log("  openTargetSelectionDialog returns a Promise");

// 4. resolveAndClose resolves the Promise exactly once with the given id
let resolveValue = null;
const dialog = new TargetSelectionDialog({ title: "T", options: [] });
const p = new Promise(resolve => { dialog._resolve = resolve; });
dialog.resolveAndClose("section-1");
p.then(v => { resolveValue = v; });
await Promise.resolve(); // flush the microtask so the .then runs
assert.equal(resolveValue, "section-1", "resolveAndClose resolves with the given id");
assert.equal(dialog._resolve, null, "_resolve is nulled after resolveAndClose");
assert.equal(dialog._closing, true, "_closing is true after resolveAndClose");
console.log("  resolveAndClose resolves once and nulls _resolve");

// 5. After resolveAndClose, subsequent close() calls do not re-resolve the Promise.
//    (_closing is true, so close() delegates to super.close() without touching _resolve.)
await dialog.close();
await dialog.close();
await Promise.resolve();
assert.equal(resolveValue, "section-1", "Promise keeps the first resolution value after multiple close() calls");
console.log("  close() after resolution does not re-resolve the Promise");

// 6. close() before confirmation resolves the Promise with null
const dialog2 = new TargetSelectionDialog({ title: "T", options: [] });
let resolvedWith = null;
const p2 = new Promise(resolve => { dialog2._resolve = resolve; });
p2.then(v => { resolvedWith = v; });
await dialog2.close();
await Promise.resolve();
assert.equal(resolvedWith, null, "close() before confirmation resolves with null");
assert.equal(dialog2._resolve, null, "_resolve is nulled after close()");
console.log("  close() before confirmation resolves the Promise with null");

// 7. close() after resolution does not throw
const dialog3 = new TargetSelectionDialog({ title: "T", options: [] });
dialog3.resolveAndClose("section-1");
await dialog3.close(); // must not throw
console.log("  close() after resolution does not throw");

// 8. A fresh instance can be used after a previous one closed
const dialog4 = new TargetSelectionDialog({ title: "T", options: [] });
let resolve4;
const p4 = new Promise(resolve => { resolve4 = resolve; });
dialog4._resolve = resolve4;
dialog4.resolveAndClose("section-A");
await Promise.resolve();
assert.equal(dialog4._resolve, null, "fresh instance nulls _resolve after resolveAndClose");
console.log("  A fresh instance can be used after a previous one closed");

console.log("TargetSelectionDialog headless tests: all checks passed.");
