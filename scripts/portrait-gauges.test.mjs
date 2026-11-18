// Sword World 2.5 - portrait resource gauges test
// Verifies the portrait gauge feature (module/actor/portrait-gauges.mjs):
//   - the two locked per-variant presets (frame / medallion) match the
//     approved prototype configuration,
//   - HP and MP arc spans never overlap (4° breathing room),
//   - the contour math: rounded-rectangle ray exits and the degenerate
//     circular case used by the medallion,
//   - contour path sampling matches contourPoint,
//   - dash offsets implement fill-from-start / fill-from-end,
//   - the sheet template, entry point and stylesheet are wired.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PORTRAIT_GAUGE_PRESETS,
  contourPoint,
  contourPath,
  dashOffsetFor,
  readGaugeValues,
  resolveSpans
} from "../module/actor/portrait-gauges.mjs";

const root = new URL("..", import.meta.url).href;
const read = rel => readFile(new URL(rel, root), "utf8");

console.log("=== locked per-variant presets ===");

// frame: rectangular, HP starts at 230°, values inside the frame.
assert.equal(PORTRAIT_GAUGE_PRESETS.frame.hpStart, 230, "frame HP start is 230°");
assert.equal(PORTRAIT_GAUGE_PRESETS.frame.hpSpan, 170, "frame HP span is 170°");
assert.equal(PORTRAIT_GAUGE_PRESETS.frame.mpStart, 30, "frame MP start is 30° (1 o'clock)");
assert.equal(PORTRAIT_GAUGE_PRESETS.frame.mpSpan, 100, "frame MP span is 100°");
assert.equal(PORTRAIT_GAUGE_PRESETS.frame.labelsInside, true, "frame values sit inside the frame");

// medallion: circular, HP starts at 210°, values outside the frame.
assert.equal(PORTRAIT_GAUGE_PRESETS.medallion.hpStart, 210, "medallion HP start is 210°");
assert.equal(PORTRAIT_GAUGE_PRESETS.medallion.hpSpan, 170, "medallion HP span is 170°");
assert.equal(PORTRAIT_GAUGE_PRESETS.medallion.mpStart, 30, "medallion MP start is 30°");
assert.equal(PORTRAIT_GAUGE_PRESETS.medallion.mpSpan, 100, "medallion MP span is 100°");
assert.equal(PORTRAIT_GAUGE_PRESETS.medallion.labelsInside, false, "medallion values sit outside the frame");

// Exactly the two approved shapes, and no extra configuration knobs.
assert.deepEqual(
  Object.keys(PORTRAIT_GAUGE_PRESETS).sort(),
  ["frame", "medallion"],
  "only the two approved variants exist"
);

console.log("=== arc spans never overlap (4° breathing room) ===");

// frame preset: the requested 170° HP span must clamp against MP's start.
const frameSpans = resolveSpans(230, 170, 30, 100);
assert.equal(frameSpans.hpSpanEff, 156, "frame HP span clamps to 156°");
assert.equal(frameSpans.hpClamped, true, "frame HP span reports clamped");
assert.equal(frameSpans.mpSpanEff, 100, "frame MP span is untouched");
assert.equal(frameSpans.mpClamped, false, "frame MP span not clamped");

// medallion preset: 170° fits without clamping.
const medallionSpans = resolveSpans(210, 170, 30, 100);
assert.equal(medallionSpans.hpSpanEff, 170, "medallion HP span needs no clamp");
assert.equal(medallionSpans.hpClamped, false, "medallion HP span not clamped");

// The clockwise gap from the HP end to the MP start is exactly the 4°
// breathing room when clamped (frame), and larger when the arcs fit as
// requested (medallion). Either way the arcs never overlap.
{
  const frameGap = (((30 - (230 + frameSpans.hpSpanEff)) % 360) + 360) % 360;
  assert.equal(frameGap, 4, "frame: gap between HP end and MP start is the 4° breathing room");
  const medallionGap = (((30 - (210 + medallionSpans.hpSpanEff)) % 360) + 360) % 360;
  assert.ok(medallionGap >= 4, "medallion: HP and MP arcs keep at least 4° of gap");
}

// Overlapping request: whichever span runs into the other arc's start is
// clamped. HP starting at 0° can only extend to MP's start minus 4°.
const tight = resolveSpans(0, 180, 30, 180);
assert.equal(tight.hpSpanEff, 26, "HP clamps to the 4° before MP's start");
assert.equal(tight.hpClamped, true, "HP reports clamped");
assert.equal(tight.mpSpanEff, 180, "MP keeps its span");

console.log("=== contour math: rounded rectangle and degenerate circle ===");

const CX = 200, CY = 150;

// Axis exits: 90° → right edge, 0° → top edge, 180° → bottom, 270° → left.
const rect = { hw: 147, hh: 107.5, r: 14 };
let p = contourPoint(CX, CY, rect.hw, rect.hh, rect.r, 90);
assert.ok(Math.abs(p.x - (CX + rect.hw)) < 1e-6 && Math.abs(p.y - CY) < 1e-6, "90° exits through the right edge");
p = contourPoint(CX, CY, rect.hw, rect.hh, rect.r, 0);
assert.ok(Math.abs(p.x - CX) < 1e-6 && Math.abs(p.y - (CY - rect.hh)) < 1e-6, "0° exits through the top edge");
p = contourPoint(CX, CY, rect.hw, rect.hh, rect.r, 180);
assert.ok(Math.abs(p.x - CX) < 1e-6 && Math.abs(p.y - (CY + rect.hh)) < 1e-6, "180° exits through the bottom edge");
p = contourPoint(CX, CY, rect.hw, rect.hh, rect.r, 270);
assert.ok(Math.abs(p.x - (CX - rect.hw)) < 1e-6 && Math.abs(p.y - CY) < 1e-6, "270° exits through the left edge");

// Every ray exit stays on the contour of the rounded rectangle.
let allOnContour = true;
for (let a = 0; a < 360; a += 7.5) {
  const q = contourPoint(CX, CY, rect.hw, rect.hh, rect.r, a);
  const dx = Math.abs(q.x - CX), dy = Math.abs(q.y - CY);
  const cornerX = Math.max(0, dx - (rect.hw - rect.r)), cornerY = Math.max(0, dy - (rect.hh - rect.r));
  const onEdge = (dx <= rect.hw + 1e-6 && dy <= rect.hh + 1e-6)
    && (cornerX === 0 || cornerY === 0 || Math.abs(Math.hypot(cornerX, cornerY) - rect.r) < 1e-6);
  if (!onEdge) { allOnContour = false; break; }
}
assert.ok(allOnContour, "every ray exit lies on the rounded-rectangle contour");

// Degenerate case (medallion): hw = hh = r turns the contour into a circle.
const R = 110;
let circleOk = true;
for (let a = 0; a < 360; a += 11.25) {
  const q = contourPoint(CX, CY, R, R, R, a);
  if (Math.abs(Math.hypot(q.x - CX, q.y - CY) - R) > 1e-6) { circleOk = false; break; }
}
assert.ok(circleOk, "hw = hh = r degenerates into a perfect circle");

console.log("=== contour path sampling ===");

const d = contourPath(CX, CY, rect.hw, rect.hh, rect.r, 230, 400);
assert.ok(d.startsWith("M"), "path data starts with M");
const segments = d.split("L");
assert.equal(segments.length, 137, "170° span at 1.25° step yields M + 136 line segments");
const first = segments[0].slice(1).split(" ").map(Number);
const expectedFirst = contourPoint(CX, CY, rect.hw, rect.hh, rect.r, 230);
assert.ok(Math.abs(first[0] - expectedFirst.x) < 0.01 && Math.abs(first[1] - expectedFirst.y) < 0.01, "path starts at the start contour point");
const last = segments[segments.length - 1].split(" ").map(Number);
const expectedLast = contourPoint(CX, CY, rect.hw, rect.hh, rect.r, 400);
assert.ok(Math.abs(last[0] - expectedLast.x) < 0.01 && Math.abs(last[1] - expectedLast.y) < 0.01, "path ends at the end contour point");

console.log("=== dash offsets (fill from start / from end) ===");

assert.equal(dashOffsetFor(1, "start"), 0, "full arc has zero offset");
assert.equal(dashOffsetFor(0, "start"), 1000, "empty arc hides from the start");
assert.equal(dashOffsetFor(0.5, "start"), 500, "half arc fills from the start");
assert.equal(dashOffsetFor(1, "end"), 0, "full arc has zero offset (end fill)");
assert.equal(dashOffsetFor(0, "end"), -1000, "empty arc hides from the end");
assert.equal(dashOffsetFor(0.5, "end"), -500, "half arc fills from the end");
assert.equal(dashOffsetFor(-0.2), 1000, "fractions below 0 clamp to empty");
assert.equal(dashOffsetFor(1.4), 0, "fractions above 1 clamp to full");

console.log("=== finite values from legacy persisted resources ===");

const legacyGaugeActor = {
  system: {
    hp: { value: "12", max: 20 },
    mp: { value: [null, 30, null, null], max: 40 }
  },
  items: []
};
const legacyGaugeValues = readGaugeValues(legacyGaugeActor);
assert.deepEqual(legacyGaugeValues, { hp: 12, hpMax: 20, mp: 30, mpMax: 40 }, "the gauge reads the same normalized scalar as the sheets");
assert.ok(Object.values(legacyGaugeValues).every(Number.isFinite), "legacy arrays and numeric strings never produce NaN gauge values");
const legacyFraction = Math.max(0, Math.min(1, legacyGaugeValues.mp / legacyGaugeValues.mpMax));
assert.ok(Number.isFinite(dashOffsetFor(legacyFraction, "start")), "the legacy MP arc offset is finite");
assert.deepEqual(
  readGaugeValues({ system: { hp: { value: [NaN, "bad"] }, mp: { value: [null, "", "bad"] } }, items: [] }),
  { hp: 0, hpMax: 0, mp: 0, mpMax: 0 },
  "malformed resources fall back to finite zero values"
);

console.log("=== template / entry point / stylesheet wiring ===");

const characterSheet = await read("templates/actor/character-sheet.hbs");
assert.equal(
  (characterSheet.match(/name="system\.mp\.value"/g) ?? []).length,
  0,
  "same-named MP inputs cannot be serialized into an array by FormApplication"
);
assert.equal(
  (characterSheet.match(/data-resource-value="mp"/g) ?? []).length,
  2,
  "Combat Data and every Wizard class page keep their editable shared-MP controls"
);
assert.ok(
  characterSheet.includes('class="logo-box" data-action="cycle-portrait-gauge"'),
  "character sheet logo box carries the discrete gauge toggle action"
);
assert.match(
  characterSheet,
  /\{\{#if isLightStyle\}\} title="Toggle portrait gauge style"\{\{\/if\}\}/,
  "the toggle tooltip is only rendered for the Light theme"
);

const entryPoint = await read("sw25.mjs");
assert.ok(
  entryPoint.includes('import { initializePortraitGauges } from "./module/actor/portrait-gauges.mjs";'),
  "entry point imports the portrait gauges module"
);
assert.ok(
  entryPoint.includes('Hooks.once("ready", initializePortraitGauges);'),
  "entry point initializes the portrait gauges on ready"
);

const stylesheet = await read("styles/sw25.css");
assert.ok(
  stylesheet.includes(".sw25-theme-light.sw25-official-sheet .portrait-column.sw25-portrait-medallion .portrait-frame"),
  "stylesheet scopes the medallion frame to the Light character sheet"
);
assert.ok(
  stylesheet.includes(".sw25-gauge-svg .gauge-fill.hp.low") && stylesheet.includes("sw25-gauge-pulse"),
  "stylesheet defines the low-HP pulse"
);
assert.ok(
  stylesheet.includes(".sw25-theme-light.sw25-official-sheet .logo-box[data-action=\"cycle-portrait-gauge\"]"),
  "stylesheet gives the logo toggle pointer feedback"
);

const moduleSource = await read("module/actor/portrait-gauges.mjs");
assert.ok(
  moduleSource.includes('Hooks.on("renderSW25ActorSheet"'),
  "module paints through the SW25ActorSheet render hook"
);
assert.ok(
  moduleSource.includes('Hooks.on("renderActorSheet"'),
  "module repaints gauges after every sheet re-render (HP/MP edits in combat data)"
);
assert.ok(
  moduleSource.includes('Hooks.on("updateActor"'),
  "module refreshes open windows through updateActor"
);
assert.ok(
  moduleSource.includes('getFlag("sw25-taka", "portraitGaugeStyle")') || moduleSource.includes('FLAG_STYLE = "portraitGaugeStyle"'),
  "style persists under the sw25-taka portraitGaugeStyle flag"
);
assert.ok(
  moduleSource.includes('DEFAULT_STYLE = "medallion"'),
  "the default variant (no persisted selection) is the medallion"
);
assert.ok(
  !moduleSource.includes('?? "frame"'),
  "no code path falls back to the frame variant anymore"
);
assert.ok(
  moduleSource.includes("bindGaugeWheel"),
  "module binds mouse wheel interaction on the gauge SVG"
);
assert.ok(
  moduleSource.includes('addEventListener("wheel"'),
  "module listens for wheel events on the gauge overlay"
);

console.log("\nAll portrait gauge tests passed.");
