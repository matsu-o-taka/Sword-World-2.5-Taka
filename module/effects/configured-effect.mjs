// Sword World 2.5 - Configured effect entries (drag-and-drop foundation).
//
// Target model (task §3):
//   - Effect definition:   reusable rule element registered in
//                          module/effects/rule-elements.mjs.
//   - Configured effect:   a definition with concrete parameters, attached to
//                          a content entry (feat/item/spell) and presented as
//                          an individual draggable element inside that
//                          content's description.
//   - Active effect:       the `sw25Effect` document created on an Actor when
//                          the configured entry is dropped, retaining the
//                          configuration and the originating content.
//
// This module implements the data contract, the HTML entry, the drag
// transport and the drop handler. It deliberately does NOT implement a rule
// editor or a content-authoring workflow: content code builds a configured
// effect with `buildSw25ConfiguredEffect` and embeds
// `renderSw25ConfiguredEffectEntry` in its description.
//
// Provenance is retained by the existing lifecycle:
//   - the native ActiveEffect `origin` field stores the originating document
//     UUID (passed through EffectService);
//   - `flags["sw25-taka"].configuredEffectId` distinguishes several configured
//     effects that originate from the same content entry;
//   - the rules themselves are copied into `system.rules`, so the instance keeps
//     its configuration independently of later changes to the origin.

import { applySw25Effect } from "./effect-service.mjs";
import { requestSw25EffectOperation } from "./effect-relay.mjs";
import { normalizeSw25RuleElements, getSw25RuleElementDefinition } from "./rule-elements.mjs";
import {
  DAMAGE_VULNERABILITY_RULE_KEY, DAMAGE_VULNERABILITY_CATEGORIES
} from "./damage-vulnerability.mjs";
import { sw25DamageElementLabel } from "../rules/damage-elements.mjs";

/**
 * Discriminator of the configured-effect drag payload.
 * @type {string}
 */
export const SW25_CONFIGURED_EFFECT_TYPE = "sw25ConfiguredEffect";

/**
 * Version of the configured-effect transport contract.
 * @type {number}
 */
export const SW25_CONFIGURED_EFFECT_VERSION = 1;

/** Attribute carrying the serialized configured effect on its entry. */
export const SW25_CONFIGURED_EFFECT_ATTRIBUTE = "data-sw25-configured-effect";

/**
 * Duration scales a configured effect may declare through this transport.
 *
 * Manual scales are anchorless and GM-managed. The counted `rounds` scale is
 * also supported with the runtime's combatant-independent `roundEnd` anchor;
 * the descriptor supplies its positive initial counter and EffectService
 * initializes the remaining counter. `turns` remains excluded because its
 * casterTurn/targetTurn anchor is per-application combatant data.
 * `null` means "no duration recorded", which is the correct default for a
 * generic effect.
 * @type {ReadonlyArray<string>}
 */
export const SW25_CONFIGURED_EFFECT_DURATION_SCALES = Object.freeze([
  "rounds", "minutes", "hours", "days", "permanent", "other"
]);

/**
 * Custom drag MIME type. Identifies the payload at `dragover` time, where the
 * transferred data itself is not readable, so a sheet only accepts the drop
 * for configured effects (and never shadows other drag sources).
 * @type {string}
 */
export const SW25_CONFIGURED_EFFECT_MIME = "application/x-sw25-configured-effect";

const FLAG_SCOPE = "sw25-taka";

const escapeHtml = value => {
  const text = String(value ?? "");
  if (typeof globalThis.foundry?.utils?.escapeHTML === "function") return globalThis.foundry.utils.escapeHTML(text);
  return text.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
};

const escapeAttribute = value => escapeHtml(value).replace(/`/g, "&#96;");

const randomId = () => globalThis.foundry?.utils?.randomID?.()
  ?? globalThis.crypto?.randomUUID?.()
  ?? `ce-${Math.random().toString(36).slice(2)}`;

/**
 * Build a validated configured effect descriptor.
 *
 * A configured effect with an EMPTY rule list is a valid generic effect: it
 * carries only presentation data and its persisted classification. A
 * configured effect with rules is a mechanically configured effect (e.g.
 * Damage Vulnerability). "Generic" is therefore the absence of rules, not a
 * separate document type or lifecycle.
 *
 * @param {object} input
 * @param {string} input.name - Presentation name (also the default family).
 * @param {object[]} [input.rules] - Configured rule entries (empty = generic).
 * @param {string} [input.id] - Stable id within the originating content.
 * @param {string} [input.description] - Presentation summary.
 * @param {string|null} [input.origin] - Originating document UUID.
 * @param {string} [input.family] - Stacking family (defaults to `name`).
 * @param {string} [input.img] - Effect icon.
 * @param {string} [input.effectType] - Normative classification (DEC-9).
 * @param {boolean|null} [input.isMagical] - Cancellation eligibility (DEC-7); absent/null defaults to false for legacy descriptors.
 * @param {number} [input.successValue] - Authoritative non-negative integer SV (default 0).
 * @param {"none"|"fixed"} [input.successValueSource] - SV provenance (default "none" for backward compatibility).
 * @param {string|null} [input.durationScale] - Supported persistent duration scale.
 * @param {number|null} [input.initialDuration] - Positive round count; required only for `rounds`.
 * @param {boolean} [input.gmOnly] - Presentation visibility.
 * @returns {{ok: true, configured: object}|{ok: false, code: string, error: string}}
 */
export function buildSw25ConfiguredEffect(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "invalid-configured-effect", error: "A configured effect must be an object." };
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    return { ok: false, code: "invalid-configured-effect", error: "A configured effect needs a non-blank name." };
  }
  const rules = normalizeSw25RuleElements(input.rules);
  if (!rules.ok) {
    return { ok: false, code: rules.code, error: rules.error };
  }
  if (input.origin !== undefined && input.origin !== null
    && (typeof input.origin !== "string" || input.origin.trim() === "")) {
    return { ok: false, code: "invalid-configured-effect", error: "origin, when present, must be a non-blank document UUID." };
  }
  // `isMagical` is always boolean in the canonical descriptor: true means
  // confirmed magical; false means non-magical or unconfirmed. Absent/null is
  // accepted only for backward-compatible input and defaults to false. Other
  // values are rejected rather than silently coerced.
  if (input.isMagical !== undefined && input.isMagical !== null && typeof input.isMagical !== "boolean") {
    return { ok: false, code: "invalid-configured-effect", error: "isMagical, when supplied, must be a boolean; null/absent legacy values default to false." };
  }
  const successValue = input.successValue ?? 0;
  if (typeof successValue !== "number" || !Number.isInteger(successValue) || successValue < 0) {
    return { ok: false, code: "invalid-configured-effect", error: "successValue must be an integer >= 0." };
  }
  const successValueSource = input.successValueSource ?? "none";
  if (successValueSource !== "none" && successValueSource !== "fixed") {
    return { ok: false, code: "invalid-configured-effect", error: "successValueSource must be \"none\" or \"fixed\" for a configured effect." };
  }
  let durationScale = null;
  if (input.durationScale !== undefined && input.durationScale !== null && input.durationScale !== "") {
    if (typeof input.durationScale !== "string"
      || !SW25_CONFIGURED_EFFECT_DURATION_SCALES.includes(input.durationScale.trim())) {
      return {
        ok: false,
        code: "invalid-configured-effect",
        error: `durationScale, when present, must be one of ${SW25_CONFIGURED_EFFECT_DURATION_SCALES.join(", ")}.`
      };
    }
    durationScale = input.durationScale.trim();
  }
  const initialDuration = input.initialDuration ?? null;
  if (durationScale === "rounds") {
    if (typeof initialDuration !== "number" || !Number.isInteger(initialDuration) || initialDuration < 1) {
      return { ok: false, code: "invalid-configured-effect", error: "A rounds duration requires a positive integer initialDuration." };
    }
  } else if (initialDuration !== null) {
    return { ok: false, code: "invalid-configured-effect", error: "initialDuration is only used by the counted rounds duration scale." };
  }
  const family = typeof input.family === "string" && input.family.trim() !== ""
    ? input.family.trim()
    : name;
  return {
    ok: true,
    configured: {
      type: SW25_CONFIGURED_EFFECT_TYPE,
      version: SW25_CONFIGURED_EFFECT_VERSION,
      id: typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : randomId(),
      name,
      description: typeof input.description === "string" ? input.description.trim() : "",
      origin: typeof input.origin === "string" && input.origin.trim() !== "" ? input.origin.trim() : null,
      family,
      img: typeof input.img === "string" && input.img !== "" ? input.img : null,
      effectType: typeof input.effectType === "string" && input.effectType.trim() !== "" ? input.effectType.trim() : null,
      isMagical: typeof input.isMagical === "boolean" ? input.isMagical : false,
      successValue,
      successValueSource,
      durationScale,
      initialDuration,
      // A configured rounds effect deliberately uses the existing direct
      // roundEnd application flow; no combatant identity is invented.
      durationAnchor: durationScale === "rounds" ? { regime: "roundEnd" } : null,
      gmOnly: input.gmOnly === true,
      rules: rules.rules
    }
  };
}

/**
 * Validate a configured effect read back from a drag payload or stored HTML.
 * @param {*} raw - Parsed JSON value.
 * @returns {object|null} The canonical configured effect, or null when invalid.
 */
export function normalizeSw25ConfiguredEffect(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.type !== SW25_CONFIGURED_EFFECT_TYPE || raw.version !== SW25_CONFIGURED_EFFECT_VERSION) return null;
  const built = buildSw25ConfiguredEffect(raw);
  return built.ok ? built.configured : null;
}

/**
 * Build the EffectService application payload for a configured effect.
 * The descriptor is pure; the caller decides who performs the write.
 * @param {object} configured - Validated configured effect.
 * @returns {object} `applySw25Effect` payload.
 */
export function configuredEffectApplication(configured) {
  return {
    family: configured.family,
    // Configured effects do not fabricate a check. Legacy/manual descriptors
    // default to no-check SV 0; the Generic creator explicitly records its
    // entered value as a fixed, authoritative SV for cancellation.
    cast: { successValue: configured.successValue ?? 0 },
    successValueSource: configured.successValueSource ?? "none",
    rules: configured.rules,
    origin: configured.origin,
    img: configured.img,
    effectType: configured.effectType,
    isMagical: configured.isMagical,
    durationScale: configured.durationScale ?? null,
    initialDuration: configured.initialDuration ?? null,
    durationAnchor: configured.durationAnchor ?? null,
    gmOnly: configured.gmOnly,
    flags: {
      [FLAG_SCOPE]: {
        configuredEffectId: configured.id,
        ...(configured.description ? { configuredEffectDescription: configured.description } : {})
      }
    }
  };
}

/**
 * Human-readable summary of one configured rule (presentation only).
 * @param {object} rule - Canonical rule entry.
 * @returns {string}
 */
export function summarizeSw25Rule(rule) {
  if (rule?.key === DAMAGE_VULNERABILITY_RULE_KEY) {
    const category = rule.category === "any"
      ? "Any Category"
      : (DAMAGE_VULNERABILITY_CATEGORIES.includes(rule.category)
        ? rule.category[0].toUpperCase() + rule.category.slice(1)
        : String(rule.category ?? ""));
    const element = sw25DamageElementLabel(rule.element);
    const value = Number(rule.value);
    const signed = value >= 0 ? `+${value}` : String(value);
    const source = rule.source ? ` · ${rule.source}` : "";
    return `${category} · ${element} · ${signed}${source}`;
  }
  const definition = getSw25RuleElementDefinition(rule?.key);
  return definition?.label ?? String(rule?.key ?? "Rule");
}

const DURATION_SCALE_LABELS = Object.freeze({
  rounds: "Rounds",
  minutes: "Minutes",
  hours: "Hours",
  days: "Days",
  permanent: "Permanent",
  other: "Other"
});

/**
 * Presentation summary of a configured effect.
 *
 * A mechanically configured effect summarizes its rules. A generic effect (no
 * rules) summarizes its persisted classification instead, so the preview and
 * the copied HTML always describe what the entry will actually create.
 * @param {object} configured - Validated configured effect.
 * @returns {string}
 */
export function describeSw25ConfiguredEffectSummary(configured) {
  const rules = Array.isArray(configured?.rules) ? configured.rules : [];
  if (rules.length) return rules.map(summarizeSw25Rule).join(" · ");
  const parts = [configured?.isMagical === true ? "Magical" : "Non-magical"];
  if (Number.isInteger(configured?.successValue)) parts.push(`SV ${configured.successValue}`);
  if (configured?.effectType) parts.push(`Type: ${configured.effectType}`);
  if (configured?.durationScale === "rounds") {
    parts.push(`${configured.initialDuration} rounds (round end)`);
  } else if (configured?.durationScale) {
    const label = DURATION_SCALE_LABELS[configured.durationScale] ?? String(configured.durationScale);
    parts.push(["minutes", "hours", "days", "other"].includes(configured.durationScale) ? `${label} (manual)` : label);
  }
  return `Generic effect · ${parts.join(" · ")}`;
}

/**
 * Render one configured effect as an individual draggable entry. The HTML is
 * meant to be embedded in the originating content's description.
 * @param {object} configured - Validated configured effect.
 * @returns {string} HTML string.
 */
export function renderSw25ConfiguredEffectEntry(configured) {
  const payload = escapeAttribute(JSON.stringify(configured));
  const summary = describeSw25ConfiguredEffectSummary(configured);
  const description = configured.description
    ? `<span class="sw25-configured-effect-description">${escapeHtml(configured.description)}</span>`
    : "";
  return `<div class="sw25-configured-effect" draggable="true" ${SW25_CONFIGURED_EFFECT_ATTRIBUTE}="${payload}" title="Drag onto a character sheet to apply"><i class="fas fa-hand-sparkles"></i><span class="sw25-configured-effect-name">${escapeHtml(configured.name)}</span><span class="sw25-configured-effect-summary">${escapeHtml(summary)}</span>${description}</div>`;
}

/**
 * Read a configured effect from a drop event.
 * @param {DragEvent} event - Drop event.
 * @returns {object|null} Validated configured effect, or null.
 */
export function readSw25ConfiguredEffectDragData(event) {
  let parsed = null;
  try {
    const transfer = event?.dataTransfer;
    let raw = transfer?.getData?.(SW25_CONFIGURED_EFFECT_MIME);
    if (!raw) raw = transfer?.getData?.("text/plain");
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch (error) {
    return null;
  }
  return normalizeSw25ConfiguredEffect(parsed);
}

/**
 * Apply a configured effect to an Actor through the existing authority paths:
 * a GM writes through EffectService, a player request travels through the
 * effect relay. No independent write path is introduced.
 * @param {Actor} actor - Receiving Actor.
 * @param {object} configured - Validated configured effect.
 * @param {object} [options]
 * @param {boolean} [options.notify] - Notify this client of the outcome.
 * @returns {Promise<object>} EffectService/relay result.
 */
export async function applySw25ConfiguredEffect(actor, configured, { notify = true } = {}) {
  if (!actor?.uuid) {
    return { ok: false, code: "no-actor", error: "The configured effect needs a valid Actor." };
  }
  const payload = configuredEffectApplication(configured);
  const result = game?.user?.isGM === true
    ? await applySw25Effect(actor, payload, { notify: false })
    : await requestSw25EffectOperation("apply", { actorUuid: actor.uuid, ...payload }, { notify: false });
  if (notify && globalThis.ui?.notifications) {
    if (result.ok) ui.notifications.info(`${configured.name} applied to ${actor.name}.`);
    else ui.notifications.error(result.error ?? "The configured effect could not be applied.");
  }
  return result;
}

/**
 * Whether a drag event carries a configured-effect payload.
 * @param {DragEvent} event
 * @returns {boolean}
 */
function carriesSw25ConfiguredEffect(event) {
  return Array.from(event?.dataTransfer?.types ?? []).includes(SW25_CONFIGURED_EFFECT_MIME);
}

// Tracks whether a configured-effect drag is in progress. Chromium does not
// expose custom MIME types in dataTransfer.types during dragover — only at
// drop time. We set this flag on dragstart and clear it on dragend so the
// dragover handler can allow the drop without interfering with other drags.
let sw25ConfiguredEffectDragging = false;

/**
 * Apply a configured effect to one Actor, enforcing GM/owner authority.
 * @param {object} actor - Receiving Actor.
 * @param {object} configured - Validated configured effect.
 * @returns {Promise<object>} Application result.
 */
async function applyConfiguredEffectToActor(actor, configured) {
  if (!actor) return { ok: false, code: "no-actor", error: "No Actor was found." };
  if (actor.isOwner !== true && game?.user?.isGM !== true) {
    globalThis.ui?.notifications?.warn?.("You do not have permission to apply effects to that Actor.");
    return { ok: false, code: "no-permission", error: "You do not have permission to apply effects to that Actor." };
  }
  return applySw25ConfiguredEffect(actor, configured);
}

/**
 * Sheet drop handler shared by every Actor sheet. Returns false when the drop
 * is not a configured effect, so callers fall back to the default behaviour.
 * @param {object} sheet - Actor sheet instance.
 * @param {DragEvent} event - Drop event.
 * @returns {Promise<boolean>} Whether the drop was handled.
 */
export async function handleSw25ConfiguredEffectDrop(sheet, event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  const configured = readSw25ConfiguredEffectDragData(event);
  if (!configured) return false;
  await applyConfiguredEffectToActor(sheet?.actor, configured);
  return true;
}

let configuredEffectsInitialized = false;

/**
 * Register the document-level drag transport for configured effect entries.
 * Runs once; safe to call from `Hooks.once("ready")`.
 *
 * Installs:
 *   - `dragstart` on configured-effect entries so their payload travels with
 *     the drag.
 *   - `dragover`/`drop` on the document so a configured effect can be dropped
 *     onto a token in the canvas and applied to that token's Actor.
 * @returns {boolean} Whether the listeners are installed.
 */
export function initializeSw25ConfiguredEffects() {
  if (configuredEffectsInitialized) return true;
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return false;

  // Drag transport: read the serialized configured effect from the entry and
  // set a flag so dragover handlers know a configured-effect drag is active
  // (Chromium hides custom MIME types during dragover).
  document.addEventListener("dragstart", event => {
    const target = event.target;
    const element = target?.closest?.(`[${SW25_CONFIGURED_EFFECT_ATTRIBUTE}]`);
    if (!element) return;
    const raw = element.getAttribute(SW25_CONFIGURED_EFFECT_ATTRIBUTE);
    if (!raw) return;
    sw25ConfiguredEffectDragging = true;
    event.dataTransfer?.setData(SW25_CONFIGURED_EFFECT_MIME, raw);
    event.dataTransfer?.setData("text/plain", raw);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  });
  document.addEventListener("dragend", () => {
    sw25ConfiguredEffectDragging = false;
  });

  // Allow configured-effect drags over the entire document so the canvas
  // (which is a WebGL surface, not a DOM element) will accept the drop.
  // We check the drag-in-progress flag because Chromium does not expose
  // custom MIME types in dataTransfer.types during dragover.
  document.addEventListener("dragover", event => {
    if (!sw25ConfiguredEffectDragging && !carriesSw25ConfiguredEffect(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });

  // Drop on a canvas token. Tokens are PIXI sprites on a WebGL canvas, not
  // DOM elements, so we cannot use event.target.closest(".token"). Instead
  // we listen in CAPTURE phase (before Foundry's own canvas drop handler),
  // convert mouse coordinates to canvas coordinates, and hit-test tokens.
  document.addEventListener("drop", async event => {
    sw25ConfiguredEffectDragging = false;
    if (!carriesSw25ConfiguredEffect(event)) return;

    // Only handle drops that land on the canvas board.
    const board = document.getElementById("board");
    if (!board) return;
    const canvasEl = board.querySelector("canvas") ?? board;
    if (event.target !== canvasEl && !board.contains(event.target)) return;

    event.preventDefault();
    event.stopPropagation();

    const configured = readSw25ConfiguredEffectDragData(event);
    if (!configured) return;

    // Convert client coordinates to canvas world coordinates.
    if (typeof canvas === "undefined" || !canvas?.ready) return;
    let worldPos;
    try {
      const [wx, wy] = canvas.canvasCoordinatesFromClient([event.clientX, event.clientY]);
      worldPos = { x: wx, y: wy };
    } catch {
      // Fallback: manual conversion via the PIXI stage.
      try {
        const rect = canvasEl.getBoundingClientRect();
        const point = canvas.stage.toLocal(
          new PIXI.Point(event.clientX - rect.left, event.clientY - rect.top)
        );
        worldPos = { x: point.x, y: point.y };
      } catch { return; }
    }
    if (!worldPos) return;

    // Hit-test: find the topmost token whose bounds contain the drop point.
    const tokens = canvas.tokens?.placeables ?? [];
    const token = tokens
      .slice()
      .sort((a, b) => (b.document?.sort ?? 0) - (a.document?.sort ?? 0))
      .find(t => {
        if (!t.visible) return false;
        const b = t.bounds;
        return b && worldPos.x >= b.x && worldPos.x <= b.x + b.width &&
               worldPos.y >= b.y && worldPos.y <= b.y + b.height;
      });
    if (!token?.actor) {
      globalThis.ui?.notifications?.warn?.("Drop the effect onto a token to apply it.");
      return;
    }
    await applyConfiguredEffectToActor(token.actor, configured);
  }, true); // capture phase — intercept before Foundry's canvas drop handler

  configuredEffectsInitialized = true;
  return true;
}

/**
 * Bind the drop target of one Actor sheet.
 *
 * Deliberately does NOT register a DragDrop configuration: a sheet that
 * previously accepted no drops keeps accepting none for other drag sources.
 * Only drags carrying the configured-effect MIME type are accepted, and only
 * then is `dragover` cancelled (required by the HTML5 drop protocol).
 *
 * @param {object} sheet - Actor sheet instance.
 * @param {JQuery|HTMLElement} html - Rendered sheet root (jQuery or element).
 * @returns {boolean} Whether the binding was installed.
 */
export function bindSw25ConfiguredEffectDropTarget(sheet, html) {
  const root = html?.[0] ?? (html instanceof Element ? html : null);
  if (!root || typeof root.addEventListener !== "function" || !root.dataset) return false;
  if (root.dataset.sw25ConfiguredEffectDrop === "true") return true;
  root.dataset.sw25ConfiguredEffectDrop = "true";
  root.addEventListener("dragover", event => {
    if (!sw25ConfiguredEffectDragging && !carriesSw25ConfiguredEffect(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    event?.stopPropagation?.();
  });
  root.addEventListener("drop", event => {
    sw25ConfiguredEffectDragging = false;
    if (!carriesSw25ConfiguredEffect(event)) return;
    void handleSw25ConfiguredEffectDrop(sheet, event);
    event?.stopPropagation?.();
  });
  return true;
}
