/**
 * Portrait resource gauges (HP / MP arcs) for the Light-theme character sheet.
 *
 * Two thin arcs trace the real contour of the portrait frame — a perfect
 * medallion by default, or a rounded rectangle — warm red for HP, arcane blue
 * for MP, with discreet gold ornaments. The geometry is ported 1:1 from the
 * approved prototype (temp/sw25-taka-portrait-proto/index.html).
 *
 * Two locked variants exist and the ONLY toggle (a click on the sheet logo,
 * Light theme only) switches between them; each shape carries its own fixed
 * preset:
 *   - "medallion" (default): perfect circle, HP starts at 210°, values outside.
 *   - "frame": rectangular frame, HP starts at 230°, values inside.
 *
 * Persistence: actor flag `sw25-taka:portraitGaugeStyle` ("frame"|"medallion").
 * Live updates ride the `updateActor` hook so HP/MP changes animate the arcs
 * without re-rendering the sheet.
 */

import { characterResourceMaximum } from "../rules/resources.mjs";
import { sw25EffectiveResourceMaximum } from "../effects/effective-values.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Margin the SVG canvas extends beyond the portrait column (arcs, ornaments
 * and outside labels all live within a few px of the frame edge). */
const BLEED = 30;

/** Virtual path length used for dash-based arc fills. */
const PATH_LENGTH = 1000;

/** Low-HP threshold for the pulse effect. */
const LOW_HP_FRACTION = 0.25;

/** Variant used when the actor has no persisted selection. */
const DEFAULT_STYLE = "medallion";

/** Increment/decrement step when using the mouse wheel over a gauge. */
const WHEEL_STEP = 1;

/**
 * Locked per-variant presets. The selector only switches the shape; these
 * values are the configuration the user approved on the prototype.
 * Angles are degrees, clockwise from 12 o'clock.
 *
 * @type {{ frame: {hpStart: number, hpSpan: number, mpStart: number, mpSpan: number, corner: number, gap: number, labelsInside: boolean}, medallion: {hpStart: number, hpSpan: number, mpStart: number, mpSpan: number, corner: number, gap: number, labelsInside: boolean} }}
 */
export const PORTRAIT_GAUGE_PRESETS = Object.freeze({
  frame: Object.freeze({ hpStart: 230, hpSpan: 170, mpStart: 30, mpSpan: 100, corner: 14, gap: 6, labelsInside: true }),
  medallion: Object.freeze({ hpStart: 210, hpSpan: 170, mpStart: 30, mpSpan: 100, corner: 14, gap: 6, labelsInside: false })
});

/** Actor flag key storing the selected gauge style. */
const FLAG_STYLE = "portraitGaugeStyle";

/** CSS class toggled on the portrait column for the medallion variant. */
const MEDALLION_CLASS = "sw25-portrait-medallion";

/* ═══════════════════════════ geometry ═══════════════════════════ */

/**
 * Exit point of a ray from the center in direction thetaDeg (degrees clockwise
 * from 12 o'clock) through a rounded rectangle with half-sizes hw × hh and
 * corner radius r. When hw === hh === r the contour degenerates into a circle
 * of radius r.
 *
 * @param {number} cx Center X.
 * @param {number} cy Center Y.
 * @param {number} hw Half width.
 * @param {number} hh Half height.
 * @param {number} r Corner radius (equals hw/hh for the circular case).
 * @param {number} thetaDeg Direction angle, degrees clockwise from 12 o'clock.
 * @returns {{x: number, y: number}}
 */
export function contourPoint(cx, cy, hw, hh, r, thetaDeg) {
  const t = thetaDeg * Math.PI / 180;
  const dx = Math.sin(t), dy = -Math.cos(t); // 0° up, 90° right, 180° down, 270° left
  const ux = Math.abs(dx), uy = Math.abs(dy); // first-quadrant mirror
  const ax = Math.max(0, hw - r), ay = Math.max(0, hh - r);
  let ex, ey;
  if (ux < 1e-9) { ex = 0; ey = hh; }
  else if (uy < 1e-9) { ex = hw; ey = 0; }
  else {
    const tR = hw / ux;   // exit through the right edge
    const tT = hh / uy;   // exit through the top edge
    const okR = (tR * uy) <= ay + 1e-9;
    const okT = (tT * ux) <= ax + 1e-9;
    let tC = Infinity;    // exit through the quarter-circle bevel
    const cross = Math.abs(ax * uy - ay * ux);
    if (cross <= r) {
      const disc = r * r - cross * cross;
      if (disc >= 0) {
        const cand = (ax * ux + ay * uy) + Math.sqrt(disc);
        if (cand * ux >= ax - 1e-6 && cand * uy >= ay - 1e-6) tC = cand;
      }
    }
    let tExit = Math.min(okR ? tR : Infinity, okT ? tT : Infinity, tC);
    if (!isFinite(tExit)) tExit = Math.hypot(hw, hh);
    ex = tExit * ux; ey = tExit * uy;
  }
  return { x: cx + ex * (dx < 0 ? -1 : 1), y: cy + ey * (dy < 0 ? -1 : 1) };
}

/**
 * Samples the contour between two angles (clockwise) into an SVG path.
 *
 * @param {number} cx Center X.
 * @param {number} cy Center Y.
 * @param {number} hw Half width.
 * @param {number} hh Half height.
 * @param {number} r Corner radius.
 * @param {number} a0 Start angle, degrees.
 * @param {number} a1 End angle, degrees (greater than a0).
 * @param {number} [step] Sampling step in degrees.
 * @returns {string} SVG path data.
 */
export function contourPath(cx, cy, hw, hh, r, a0, a1, step = 1.25) {
  let d = "";
  const n = Math.max(2, Math.ceil((a1 - a0) / step));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n;
    const p = contourPoint(cx, cy, hw, hh, r, a);
    d += (i ? "L" : "M") + p.x.toFixed(2) + " " + p.y.toFixed(2);
  }
  return d;
}

/**
 * Effective arc spans after clamping so HP and MP never overlap; 4° of
 * breathing room are kept between the two arcs.
 *
 * @param {number} hpStart HP start angle, degrees.
 * @param {number} hpSpan Requested HP span, degrees.
 * @param {number} mpStart MP start angle, degrees.
 * @param {number} mpSpan Requested MP span, degrees.
 * @returns {{hpSpanEff: number, mpSpanEff: number, hpClamped: boolean, mpClamped: boolean}}
 */
export function resolveSpans(hpStart, hpSpan, mpStart, mpSpan) {
  const hpSpanEff = Math.min(hpSpan, (((mpStart - 4 - hpStart) % 360) + 360) % 360);
  const mpSpanEff = Math.min(mpSpan, (((hpStart - 4 - mpStart) % 360) + 360) % 360);
  return {
    hpSpanEff,
    mpSpanEff,
    hpClamped: hpSpanEff < hpSpan,
    mpClamped: mpSpanEff < mpSpan
  };
}

/**
 * stroke-dashoffset that shows the first `fraction` of an arc (fill from its
 * start, i.e. the arc empties back toward its origin) or from its end.
 *
 * @param {number} fraction Fill fraction, 0..1 (clamped internally).
 * @param {"start"|"end"} [from] Which end of the path stays filled at 0.
 * @returns {number} Offset in virtual path-length units.
 */
export function dashOffsetFor(fraction, from = "start") {
  const f = Math.max(0, Math.min(1, fraction));
  return from === "start" ? (1 - f) * PATH_LENGTH : (f - 1) * PATH_LENGTH;
}

/* ═══════════════════════════ drawing ═══════════════════════════ */

/**
 * Registers the hooks that paint and keep the gauges up to date:
 * - `renderSW25ActorSheet` (only the character sheet fires it) paints the
 *   gauges on every render of a Light-theme sheet and wires the logo toggle.
 * - `updateActor` repaints any open window of the actor when HP, MP or the
 *   gauge flag change, so the arcs animate without a sheet re-render.
 */
export function initializePortraitGauges() {
  Hooks.on("renderSW25ActorSheet", (app, html) => {
    try {
      repaintPortraitGauges(app, toElement(html) ?? toElement(app?.element));
    } catch (error) {
      console.warn("Sword World 2.5 | Portrait gauges could not be painted", error);
    }
  });

  /* Repaint after every sheet re-render (e.g. editing HP/MP in combat data
     recreates the portrait column). With the cache keyed by actor ID, the
     existing SVG is moved to the new column instead of recreating nodes, so
     neither bar flashes. */
  Hooks.on("renderActorSheet", (app, html) => {
    if (app?.actor?.type !== "character") return;
    try {
      repaintPortraitGauges(app, toElement(html));
    } catch (error) {
      console.warn("Sword World 2.5 | Portrait gauges could not be repainted after sheet render", error);
    }
  });

  Hooks.on("updateActor", (actor, changes) => {
    if (actor.type !== "character") return;
    const system = changes?.system ?? {};
    const flagChanged = changes?.flags?.["sw25-taka"]?.[FLAG_STYLE] !== undefined;
    if (!flagChanged && system.hp === undefined && system.mp === undefined) return;
    const changed = flagChanged ? undefined
      : system.hp !== undefined && system.mp !== undefined ? undefined
      : system.hp !== undefined ? "hp"
      : "mp";
    for (const app of Object.values(ui.windows)) {
      const sheetActor = app?.actor ?? app?.object;
      if (sheetActor?.id !== actor.id) continue;
      try {
        repaintPortraitGauges(app, toElement(app.element), changed);
      } catch (error) {
        console.warn("Sword World 2.5 | Portrait gauges could not be refreshed", error);
      }
    }
  });
}

/**
 * Normalizes the various element-ish values Foundry hands around (jQuery
 * objects, arrays, plain elements) into a single Element, or null.
 *
 * @param {unknown} node Value to normalize.
 * @returns {Element|null}
 */
function toElement(node) {
  if (!node) return null;
  if (typeof Element !== "undefined" && node instanceof Element) return node;
  if (Array.isArray(node) && node[0] instanceof Element) return node[0];
  if (/** @type {{jquery?: boolean}} */(node).jquery) return node[0];
  return null;
}

/**
 * Paints (or repaints) the gauges on one sheet. No-op unless the sheet root
 * carries the Light-theme classes. When `changed` is provided ("hp", "mp", or
 * undefined), only that value is updated without redrawing the other arc,
 * avoiding a brief flash of both bars when only one value changes.
 *
 * @param {object} app The sheet application.
 * @param {Element|null} root Sheet form or window element.
 * @param {"hp"|"mp"|undefined} changed Which resource value changed, if any.
 */
function repaintPortraitGauges(app, root, changed) {
  let form = findLightForm(root);
  if (!form) {
    /* Fallback: search the whole document for a Light sheet form. Handles
       cases where the sheet was re-rendered and root still points at the old
       DOM subtree. */
    form = document.querySelector(".sw25-theme-light");
  }
  if (!form) return;
  const column = form.querySelector(".portrait-column");
  const frame = form.querySelector(".portrait-column .portrait-frame");
  if (!column || !frame) return;
  const actor = app?.actor ?? app?.object;
  if (!actor || actor.type !== "character") return;
  /* The tab listener must bind even while the portrait panel is hidden. */
  bindTabRepaint(form, app);
  /* Skip while the portrait's tab panel is hidden (display:none reports zero
     rects): drawing there would collapse the SVG geometry and the circular
     frame. The tab-switch listener repaints once the panel is visible. */
  if (frame.getBoundingClientRect().height <= 0) return;

  const style = String(actor.getFlag("sw25-taka", FLAG_STYLE) ?? DEFAULT_STYLE) === "medallion" ? "medallion" : "frame";
  bindPortraitGaugeToggle(form, app);
  applyShape(column, frame, style);

  const values = readGaugeValues(actor);
  const state = ensureGaugeSvg(column, actor.id);
  if (state) {
    drawGauges({ column, frame, ...state, style, ...values }, changed);
    bindGaugeWheel(state.svg, actor.id);
  }
}

/**
 * Repaints the gauges after a sheet tab switch. The portrait lives inside a
 * sheet-tab panel that Foundry hides with `display:none`; while hidden the
 * gauges cannot be measured or drawn (zero rects), so repaints triggered
 * while another tab is active are skipped.
 *
 * The repaint runs synchronously inside the click listener: per-button
 * handlers (target phase) already toggled the `.active` classes, so the
 * newly active panel is visible and measurable at this point. Using
 * `requestAnimationFrame` here would leave the gauges unpainted whenever the
 * Foundry window is hidden (minimized or occluded), because Chromium suspends
 * rAF callbacks entirely for hidden pages.
 *
 * @param {Element} form Light-theme sheet form.
 * @param {object} app Sheet application.
 */
function bindTabRepaint(form, app) {
  if (form.dataset.sw25TabRepaint === "true") return;
  form.dataset.sw25TabRepaint = "true";
  form.addEventListener("click", event => {
    const button = event.target?.closest?.(".tab-button");
    if (!button) return;
    try {
      repaintPortraitGauges(app, form);
    } catch (error) {
      console.warn("Sword World 2.5 | Portrait gauges could not be repainted after tab switch", error);
    }
  });
}

/**
 * Finds the Light-theme character-sheet form inside (or equal to) root.
 * Accepts both plain Light (`.sw25-theme-light.sw25-official-sheet`) and Light
 * Red (`.sw25-theme-light.sw25-theme-light-red`) variants.
 *
 * @param {Element|null} root Search root.
 * @returns {Element|null}
 */
function findLightForm(root) {
  if (!root) return null;
  if (root.matches?.(".sw25-theme-light")) return root;
  return root.querySelector?.(".sw25-theme-light") ?? null;
}

/**
 * Applies the medallion class and the circular frame width (width = height,
 * making the rounded frame a perfect circle) for the medallion style, or
 * restores the natural rectangular frame. Retries while the frame has no
 * height yet (common right after a sheet re-render from combat data edits),
 * up to a bounded number of attempts, so the gauge is never left as a thin
 * line or missing its circular shape.
 *
 * @param {HTMLElement} column Portrait column element.
 * @param {HTMLElement} frame Portrait frame element.
 * @param {"frame"|"medallion"} style Gauge style.
 * @param {number} [attempt] Current retry attempt (internal).
 */
function applyShape(column, frame, style, attempt) {
  if (attempt === undefined) attempt = 0;
  const maxAttempts = 30;
  const height = frame.getBoundingClientRect().height;
  if (style === "medallion") {
    if (height <= 0) {
      if (attempt < maxAttempts) {
        setTimeout(() => applyShape(column, frame, style, attempt + 1), 80);
      }
      return;
    }
    column.classList.add(MEDALLION_CLASS);
    frame.style.width = `${Math.round(height)}px`;
  } else {
    column.classList.remove(MEDALLION_CLASS);
    frame.style.width = "";
  }
}

/**
 * Reads the HP/MP values and maxima for the gauges. The maxima come from the
 * unified persisted source (`characterResourceMaximum`: stored base maximum
 * first, formula fallback for legacy actors) — the same source the sheet
 * inputs, token bars, rest and recovery now share.
 *
 * @param {object} actor The actor document.
 * @returns {{hp: number, hpMax: number, mp: number, mpMax: number}}
 */
function readGaugeValues(actor) {
  const hpMax = Math.max(0, characterResourceMaximum(actor, "hp"));
  const mpMax = Math.max(0, characterResourceMaximum(actor, "mp"));
  const hp = Math.max(0, Number(actor.system?.hp?.value ?? 0));
  const mp = Math.max(0, Number(actor.system?.mp?.value ?? 0));
  return { hp, hpMax, mp, mpMax };
}

/**
 * Persistent nodes for one actor, reused across sheet re-renders so the CSS
 * transitions run on value changes and the gauges never disappear when the
 * portrait column is recreated (e.g. editing HP in combat data).
 *
 * @type {Map<string, {svg: SVGSVGElement, nodes: Record<string, SVGElement>, column: HTMLElement}>}
 */
const gaugeCache = new Map();

/**
 * Creates (once per actor) the gauge SVG overlay with its persistent nodes
 * and returns the cached state. If the column is new (sheet re-rendered), the
 * existing SVG is moved to the new column instead of creating fresh nodes,
 * so the stroke-dashoffset values persist and neither bar flashes.
 *
 * @param {HTMLElement} column Portrait column element (may be new on re-render).
 * @param {string} actorId Actor document ID (stable key across re-renders).
 * @returns {{svg: SVGSVGElement, nodes: Record<string, SVGElement>, column: HTMLElement}|null}
 */
function ensureGaugeSvg(column, actorId) {
  let state = gaugeCache.get(actorId);
  if (state) {
    /* The column was recreated (sheet re-rendered); move the existing SVG to
       the new column so the persistent nodes keep their values and no
       animation-from-zero flash occurs. */
    if (state.column !== column) {
      state.svg.remove();
      column.append(state.svg);
      state.column = column;
    } else if (!document.body.contains(state.svg)) {
      column.append(state.svg);
    }
    return state;
  }

  /* No cached state for this actor; create a fresh SVG overlay. */
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "sw25-gauge-svg");
  svg.setAttribute("xmlns", SVG_NS);
  column.append(svg);

  const make = (tag, attrs = {}, parent = svg) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.append(n);
    return n;
  };

  const nodes = {
    railHp: make("path", { class: "gauge-rail" }),
    railMp: make("path", { class: "gauge-rail" }),
    trackHp: make("path", { class: "gauge-track" }),
    trackMp: make("path", { class: "gauge-track" }),
    fillHp: make("path", { class: "gauge-fill hp", pathLength: PATH_LENGTH, "stroke-dasharray": `${PATH_LENGTH} ${PATH_LENGTH}` }),
    coreHp: make("path", { class: "gauge-core hp", pathLength: PATH_LENGTH, "stroke-dasharray": `${PATH_LENGTH} ${PATH_LENGTH}` }),
    fillMp: make("path", { class: "gauge-fill mp", pathLength: PATH_LENGTH, "stroke-dasharray": `${PATH_LENGTH} ${PATH_LENGTH}` }),
    coreMp: make("path", { class: "gauge-core mp", pathLength: PATH_LENGTH, "stroke-dasharray": `${PATH_LENGTH} ${PATH_LENGTH}` }),
    termHp: make("g", {}),
    termMp: make("g", {}),
    endHp: make("path", { class: "orn-diamond" }),
    endMp: make("path", { class: "orn-diamond" }),
    fleuron: make("g", {}),
    lblHp: make("g", {}),
    lblMp: make("g", {})
  };

  const mkLabel = (group, nameCls, valCls) => {
    const name = make("text", { class: "halo" }, group);
    const val = make("text", { class: "halo", "text-anchor": "middle" }, group);
    const max = make("text", { class: "halo gauge-max", "text-anchor": "middle" }, group);
    return {
      name,
      nameT: make("tspan", { class: nameCls }, name),
      val,
      valT: make("tspan", { class: valCls }, val),
      max
    };
  };
  const lblHp = mkLabel(nodes.lblHp, "gauge-name hp", "gauge-value hp");
  const lblMp = mkLabel(nodes.lblMp, "gauge-name mp", "gauge-value mp");

  state = { svg, nodes, lblHp, lblMp, column };
  gaugeCache.set(actorId, state);
  return state;
}

/**
 * Direction unit vector for an angle (degrees clockwise from 12 o'clock).
 *
 * @param {number} thetaDeg Angle in degrees.
 * @returns {{x: number, y: number}}
 */
function dirOf(thetaDeg) {
  const t = thetaDeg * Math.PI / 180;
  return { x: Math.sin(t), y: -Math.cos(t) };
}

/**
 * Diamond (rotated square) path centered on a point.
 *
 * @param {{x: number, y: number}} p Center point.
 * @param {number} s Half diagonal.
 * @returns {string} SVG path data.
 */
function diamondPath(p, s) {
  return `M${p.x.toFixed(2)} ${(p.y - s).toFixed(2)}`
    + `L${(p.x + s).toFixed(2)} ${p.y.toFixed(2)}`
    + `L${p.x.toFixed(2)} ${(p.y + s).toFixed(2)}`
    + `L${(p.x - s).toFixed(2)} ${p.y.toFixed(2)}Z`;
}

/**
 * Moves a contour point radially by d (negative = toward the center).
 *
 * @param {{x: number, y: number}} p Contour point.
 * @param {number} cx Center X.
 * @param {number} cy Center Y.
 * @param {number} d Radial offset in px.
 * @returns {{x: number, y: number}}
 */
function shift(p, cx, cy, d) {
  const dx = p.x - cx, dy = p.y - cy, len = Math.hypot(dx, dy) || 1;
  return { x: p.x + dx / len * d, y: p.y + dy / len * d };
}

/**
 * Places a value label hugging the contour, adapting to the kind of edge: on
 * vertical edges the text grows in parallel (start/end anchors); on horizontal
 * edges it is centered over the point with a radial offset.
 *
 * @param {{name: SVGTextElement, nameT: SVGTSpanElement, val: SVGTextElement, valT: SVGTSpanElement, max: SVGTextElement}} lbl Label nodes.
 * @param {{x: number, y: number}} p Contour point for the label.
 * @param {number} cx Center X.
 * @param {number} cy Center Y.
 * @param {string} name Gauge name ("HP"/"MP").
 * @param {number} value Current value.
 * @param {number} max Maximum value.
 * @param {boolean} inside Whether labels sit inside the contour.
 */
function placeLabel(lbl, p, cx, cy, name, value, max, inside) {
  const dx = p.x - cx, dy = p.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len, ny = dy / len; // radial normal, pointing outward
  let ax, ay, anchor;
  if (Math.abs(nx) > 0.72) { // vertical edge
    const left = nx < 0;
    ax = p.x + (inside ? (left ? 6 : -6) : (left ? -7 : 7));
    ay = p.y;
    anchor = left ? (inside ? "start" : "end") : (inside ? "end" : "start");
  } else { // horizontal edge
    ax = p.x;
    ay = p.y + (inside ? -ny * 18 : ny * 18);
    anchor = "middle";
  }
  lbl.name.setAttribute("x", ax); lbl.name.setAttribute("y", ay - 13);
  lbl.name.setAttribute("text-anchor", anchor);
  lbl.nameT.textContent = name;
  lbl.val.setAttribute("x", ax); lbl.val.setAttribute("y", ay + 3);
  lbl.val.setAttribute("text-anchor", anchor);
  lbl.valT.textContent = String(Math.round(value));
  lbl.max.setAttribute("x", ax); lbl.max.setAttribute("y", ay + 15);
  lbl.max.setAttribute("text-anchor", anchor);
  lbl.max.textContent = `MAX ${Math.round(max)}`;
}

/**
 * Draws every gauge element for the current values and style.
 *
 * @param {object} s Draw state.
 * @param {HTMLElement} s.column Portrait column.
 * @param {HTMLElement} s.frame Portrait frame.
 * @param {SVGSVGElement} s.svg Gauge SVG.
 * @param {Record<string, SVGElement>} s.nodes Persistent SVG nodes.
 * @param {{name: SVGTextElement, nameT: SVGTSpanElement, val: SVGTextElement, valT: SVGTSpanElement, max: SVGTextElement}} s.lblHp HP label nodes.
 * @param {{name: SVGTextElement, nameT: SVGTSpanElement, val: SVGTextElement, valT: SVGTSpanElement, max: SVGTextElement}} s.lblMp MP label nodes.
 * @param {"frame"|"medallion"} s.style Gauge style.
 * @param {number} s.hp Current HP.
 * @param {number} s.hpMax Maximum HP.
 * @param {number} s.mp Current MP.
 * @param {number} s.mpMax Maximum MP.
 * @param {"hp"|"mp"|undefined} changed Which resource value changed, if any.
 */
function drawGauges(s, changed) {
  const { column, frame, svg, nodes, lblHp, lblMp, style } = s;
  const preset = PORTRAIT_GAUGE_PRESETS[style];

  const colRect = column.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const fx = BLEED + (frameRect.left - colRect.left);
  const fy = BLEED + (frameRect.top - colRect.top);
  const fw = frameRect.width, fh = frameRect.height;
  const cx = fx + fw / 2, cy = fy + fh / 2;

  let hw, hh, r;
  if (style === "medallion") {
    const R = Math.min(fw, fh) / 2 + preset.gap;
    hw = hh = R; r = R;
  } else {
    hw = fw / 2 + preset.gap;
    hh = fh / 2 + preset.gap;
    r = Math.max(0, Math.min(preset.corner, Math.min(hw, hh) - 2, 44));
  }

  const spans = resolveSpans(preset.hpStart, preset.hpSpan, preset.mpStart, preset.mpSpan);
  const hp = { a0: preset.hpStart, a1: preset.hpStart + spans.hpSpanEff, span: spans.hpSpanEff };
  const mp = { a0: preset.mpStart, a1: preset.mpStart + spans.mpSpanEff, span: spans.mpSpanEff };

  /* canvas size */
  svg.setAttribute("width", String(column.getBoundingClientRect().width + BLEED * 2));
  svg.setAttribute("height", String(column.getBoundingClientRect().height + BLEED * 2));
  svg.style.left = `${-BLEED}px`;
  svg.style.top = `${-BLEED}px`;

  /* contour paths */
  const dHp = contourPath(cx, cy, hw, hh, r, hp.a0, hp.a1);
  const dMp = contourPath(cx, cy, hw, hh, r, mp.a0, mp.a1);
  for (const [node, d] of [[nodes.trackHp, dHp], [nodes.fillHp, dHp], [nodes.coreHp, dHp], [nodes.trackMp, dMp], [nodes.fillMp, dMp], [nodes.coreMp, dMp]]) {
    node.setAttribute("d", d);
  }

  /* thin outer guide, opening toward the free ends */
  const guide = 3.6;
  nodes.railHp.setAttribute("d", contourPath(cx, cy, hw + guide, hh + guide, Math.max(0, r + guide), hp.a0 - 8, hp.a1));
  nodes.railMp.setAttribute("d", contourPath(cx, cy, hw + guide, hh + guide, Math.max(0, r + guide), mp.a0, mp.a1 + 8));

  /* fills and labels — only touch the arc whose value actually changed */
  const fHp = s.hpMax > 0 ? Math.max(0, Math.min(1, s.hp / s.hpMax)) : 0;
  const fMp = s.mpMax > 0 ? Math.max(0, Math.min(1, s.mp / s.mpMax)) : 0;
  if (changed !== "mp") {
    const offHp = dashOffsetFor(fHp, "start");
    for (const node of [nodes.fillHp, nodes.coreHp]) node.style.strokeDashoffset = offHp.toFixed(1);
    const hpLow = fHp > 0 && fHp <= LOW_HP_FRACTION;
    nodes.fillHp.classList.toggle("low", hpLow);
    nodes.coreHp.classList.toggle("low", hpLow);
  }
  if (changed !== "hp") {
    const offMp = dashOffsetFor(fMp, "start");
    for (const node of [nodes.fillMp, nodes.coreMp]) node.style.strokeDashoffset = offMp.toFixed(1);
  }

  /* ornaments: start dot + open ring on each arc, diamond on each fill end,
     central fleuron in the top gap (pushed outward when the gap is narrow) */
  nodes.termHp.replaceChildren();
  nodes.termMp.replaceChildren();
  nodes.fleuron.replaceChildren();

  const startHp = contourPoint(cx, cy, hw, hh, r, hp.a0);
  appendCircle(nodes.termHp, startHp.x, startHp.y, 2, "orn");
  appendCircle(nodes.termHp, startHp.x, startHp.y, 3.7, "orn-ring");
  const startMp = contourPoint(cx, cy, hw, hh, r, mp.a0);
  appendCircle(nodes.termMp, startMp.x, startMp.y, 2, "orn");
  appendCircle(nodes.termMp, startMp.x, startMp.y, 3.7, "orn-ring");

  nodes.endHp.setAttribute("d", diamondPath(contourPoint(cx, cy, hw, hh, r, hp.a1), 3.4));
  nodes.endMp.setAttribute("d", diamondPath(contourPoint(cx, cy, hw, hh, r, mp.a1), 3.4));

  const topGap = (((mp.a0 - hp.a1) % 360) + 360) % 360;
  const fleuronA = hp.a1 + topGap / 2;
  const pF = contourPoint(cx, cy, hw, hh, r, fleuronA);
  const dir = dirOf(fleuronA);
  const tan = { x: -dir.y, y: dir.x };
  const out = topGap < 12 ? 12 : 2.2;
  appendDiamond(nodes.fleuron, { x: pF.x + dir.x * out, y: pF.y + dir.y * out }, 4.2, "orn");
  if (topGap >= 12) {
    appendCircle(nodes.fleuron, pF.x - tan.x * 8, pF.y - tan.y * 8, 1.1, "orn");
    appendCircle(nodes.fleuron, pF.x + tan.x * 8, pF.y + tan.y * 8, 1.1, "orn");
  }

  /* value labels — only update the label whose value changed */
  const pLh = contourPoint(cx, cy, hw, hh, r, hp.a0 + Math.min(40, hp.span * 0.22));
  const pLm = contourPoint(cx, cy, hw, hh, r, mp.a0 + Math.min(20, mp.span * 0.2));
  if (changed !== "mp") {
    const hpLow = fHp > 0 && fHp <= LOW_HP_FRACTION;
    placeLabel(lblHp, pLh, cx, cy, "HP", s.hp, s.hpMax, preset.labelsInside);
    lblHp.valT.classList.toggle("low", hpLow);
  }
  if (changed !== "hp") {
    placeLabel(lblMp, pLm, cx, cy, "MP", s.mp, s.mpMax, preset.labelsInside);
  }
}

/**
 * Appends a decorated circle node.
 *
 * @param {SVGElement} parent Parent group.
 * @param {number} cx Center X.
 * @param {number} cy Center Y.
 * @param {number} r Radius.
 * @param {string} cls Class name.
 */
function appendCircle(parent, cx, cy, r, cls) {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("cx", cx.toFixed(2));
  c.setAttribute("cy", cy.toFixed(2));
  c.setAttribute("r", r);
  c.setAttribute("class", cls);
  parent.append(c);
}

/**
 * Appends a diamond path node.
 *
 * @param {SVGElement} parent Parent group.
 * @param {{x: number, y: number}} p Center point.
 * @param {number} sHalf Half diagonal.
 * @param {string} cls Class name.
 */
function appendDiamond(parent, p, sHalf, cls) {
  const d = document.createElementNS(SVG_NS, "path");
  d.setAttribute("d", diamondPath(p, sHalf));
  d.setAttribute("class", cls);
  parent.append(d);
}

/**
 * Wires the discrete style toggle: a click on the sheet logo flips the actor
 * flag between "frame" and "medallion"; the `updateActor` hook repaints the
 * open windows. Owner-only, and only bound for Light-theme sheets (this
 * function is only called from the Light paint path).
 *
 * @param {Element} form Light-theme sheet form.
 * @param {object} app Sheet application.
 */
export function bindPortraitGaugeToggle(form, app) {
  const box = form.querySelector('.logo-box[data-action="cycle-portrait-gauge"]');
  const actor = app?.actor ?? app?.object;
  if (!box || !actor?.isOwner || box.dataset.sw25GaugeToggle === "true") return;
  box.dataset.sw25GaugeToggle = "true";
  box.addEventListener("click", async event => {
    event.preventDefault();
    const current = String(actor.getFlag("sw25-taka", FLAG_STYLE) ?? DEFAULT_STYLE);
    const next = current === "medallion" ? "frame" : "medallion";
    await actor.setFlag("sw25-taka", FLAG_STYLE, next);
  });
}

/**
 * Checks whether an element carries a given class. Works on both HTML and SVG
 * elements (SVG elements expose className as SVGAnimatedString, not classList).
 *
 * @param {Element} node Element to check.
 * @param {string} cls Class name to look for.
 * @returns {boolean}
 */
function hasClass(node, cls) {
  if (!node) return false;
  if (node.classList?.contains(cls)) return true;
  const className = node.getAttribute?.("class") ?? "";
  return className.split(/\s+/).includes(cls);
}

/**
 * Makes the gauge interactive with the mouse wheel: turning the wheel over the
 * SVG overlay increases or decrements HP (left half) or MP (right half).
 * The whole SVG surface is sensitive — not just the value text — so a small
 * pointer movement does not break interaction. Works for every sheet style
 * that carries the gauge (Light, Light Red, …).
 *
 * @param {SVGSVGElement} svg Gauge SVG overlay.
 * @param {string} actorId Actor document ID (read fresh from game.actors on each event,
 *   so a stale app reference never blocks updates — e.g. from a player account).
 */
function bindGaugeWheel(svg, actorId) {
  if (svg.dataset.sw25GaugeWheel === "true") return;
  svg.dataset.sw25GaugeWheel = "true";
  svg.addEventListener("wheel", async event => {
    /* Only react when the pointer is over the gauge overlay itself. */
    if (!svg.contains(event.target)) return;
    event.preventDefault();

    /* Read the actor fresh on every event so the closure never goes stale. */
    const actor = game.actors.get(actorId);
    if (!actor?.isOwner) return;

    /* Determine HP vs MP: first try class-based detection (robust on SVG
       elements thanks to hasClass), then fall back to horizontal position
       within a central band so the wheel does not fire from the portrait
       borders. */
    let gauge = null;
    let node = event.target;
    while (node && node !== svg) {
      if (hasClass(node, "hp")) { gauge = "hp"; break; }
      if (hasClass(node, "mp")) { gauge = "mp"; break; }
      node = node.parentElement;
    }
    if (!gauge) {
      const rect = svg.getBoundingClientRect();
      const oy = event.clientY - rect.top;
      const bandTop = rect.height * 0.25;
      const bandBottom = rect.height * 0.75;
      if (oy < bandTop || oy > bandBottom) return; /* Outside the gauge band */
      const cx = rect.left + rect.width / 2;
      gauge = event.clientX < cx ? "hp" : "mp";
    }

    const delta = event.deltaY > 0 ? -1 : 1;
    const current = gauge === "hp"
      ? Number(actor.system?.hp?.value ?? 0)
      : Number(actor.system?.mp?.value ?? 0);
    /* Clamp to the effective maximum (persisted base + effect modifiers)
       from the unified accessor — the same source used by rest and recovery.
       When the current value already exceeds the effective maximum (e.g.
       Natural Power MP above max), an upward wheel step keeps the value
       instead of pulling it back down. */
    const effectiveMax = Math.max(0, sw25EffectiveResourceMaximum(actor, gauge));
    const cap = Math.max(current, effectiveMax);
    const next = Math.max(0, Math.min(cap, current + delta * WHEEL_STEP));
    if (next === current) return;
    try {
      await actor.update({ [`system.${gauge}.value`]: next });
    } catch (error) {
      console.warn("Sword World 2.5 | Could not update gauge value", error);
    }
  });
}
