// Sword World 2.5 - production Wordbreak feat flow (CR I p.264).
//
// This is the feat entry point, not a second cancellation engine. Eligibility,
// comparison, identity grouping and persistence all come from
// effects/effect-cancellation.mjs and EffectService.
//
// Range is NOT enforced here: Wordbreak requires exactly one declared target,
// and the table resolves positioning. Grid distance must not reject a valid
// declaration (user directive; the printed Touch range is advisory).

import {
  collectCancellationCandidates,
  collectCancellationRemovalGroup,
  effectRecordedSuccessValue,
  isSharedSpaceEffect,
  resolveCancellationAttempt
} from "../effects/effect-cancellation.mjs";
import { requestSw25EffectOperation } from "../effects/effect-relay.mjs";
import { isInstantXSpell } from "./spell-effects.mjs";
import { spellDamageMagicPower } from "./spell-damage.mjs";
import { isCriticalFailure, isNaturalDouble } from "./critical-failure.mjs";

const escape = value => foundry.utils.escapeHTML(String(value ?? "")).replace(/\n/g, "<br>");

export function wordbreakTargetActors(targets = []) {
  const tokens = [...(targets ?? [])].filter(token => token?.actor);
  const unique = new Map(tokens.map(token => [token.actor.uuid ?? token.actor.id, { token, actor: token.actor }]));
  return [...unique.values()];
}

/**
 * Resolve the Wordbreak target actor from the selected tokens.
 *
 * Wordbreak requires exactly one declared target so the player names the
 * effect to cancel. Distance/range is deliberately NOT validated here: grid
 * measurement must not reject an otherwise valid declaration.
 *
 * @param {{targets?: Iterable<object>}} [input]
 * @returns {{ok: boolean, code: string|null, entries: Array}}
 */
export function resolveWordbreakTarget({ targets } = {}) {
  const targetEntries = wordbreakTargetActors(targets);
  if (targetEntries.length !== 1) {
    return { ok: false, code: targetEntries.length ? "multiple-targets" : "no-target", entries: targetEntries };
  }
  return { ok: true, code: null, entries: targetEntries };
}

/**
 * The class whose Magic Power Wordbreak uses: the Actor's configured magic
 * class when it exists, otherwise the first class identified as a caster.
 * Returns null when the Actor has no caster class; callers must not invent one.
 * @param {Actor} actor
 * @returns {Item|null}
 */
export function resolveWordbreakCastingClass(actor) {
  const explicitId = String(actor?.system?.combat?.magicClassId ?? "").trim();
  const explicit = explicitId && typeof actor?.items?.get === "function" ? actor.items.get(explicitId) : null;
  if (explicit) return explicit;
  const classes = [...(actor?.items ?? [])].filter(item => item?.type === "class");
  return classes.find(item => /wizard/i.test(String(item.system?.classType ?? "")))
    ?? classes.find(item => /sorcerer|conjurer|priest|fairy tamer|druid|daemonologist|abyss gazer|artificer|bibliomancer/i.test(String(item.name ?? "")))
    ?? null;
}

function instantXFor(effect) {
  const origin = effect?.origin ?? effect?.system?.origin;
  let item = origin && typeof game?.items?.get === "function" ? game.items.get(origin) : null;
  // Instant/X casts normally originate from an OWNED spell, whose UUID is
  // `Actor.<id>.Item.<id>`, not a world-Item id. Foundry v14 resolves those
  // already-loaded embedded documents synchronously; an unresolved origin
  // remains unclassified rather than being guessed from the effect name.
  if (!item && origin) {
    try { item = foundry?.utils?.fromUuidSync?.(origin) ?? null; } catch { item = null; }
  }
  return item ? isInstantXSpell(item) : false;
}

function candidatesFor(target, includeGmOnly = false) {
  return collectCancellationCandidates(
    target,
    "wordbreak",
    instantXFor,
    { includeGmOnly }
  ).filter(candidate => candidate.eligibility.eligible)
    .map(candidate => ({ ...candidate, target }));
}

async function defaultDeclare({ candidates }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.wait !== "function") return { selection: null };
  const buttons = candidates.map((candidate, index) => ({
    action: `effect-${index}`,
    label: `${escape(candidate.effect.name ?? candidate.effect.system?.family ?? "Effect")}`
  }));
  buttons.push({ action: "none", label: "Do not cancel any effect" });
  const answer = await DialogV2.wait({
    window: { title: "Wordbreak" },
    modal: true,
    content: "<p>Declare the effect to cancel before making the Wordbreak check. Passive Success Values are not shown.</p>",
    buttons
  });
  if (answer === "none") return { selection: null };
  const index = typeof answer === "string" && answer.startsWith("effect-")
    ? Number.parseInt(answer.slice(7), 10) : -1;
  const candidate = candidates[index];
  return candidate
    ? { selection: { actorUuid: candidate.target?.uuid ?? null, effectId: candidate.effect?.id ?? null } }
    : { cancelled: true };
}

async function defaultRoll({ magicPower }) {
  const roll = await new Roll(`2d6 + ${Number(magicPower)}`).evaluate();
  return { roll, automaticSuccess: isNaturalDouble(roll, 6), automaticFailure: isCriticalFailure(roll) };
}

async function defaultRecoverSuccessValue({ target, effect }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.wait !== "function") return null;
  return DialogV2.wait({
    window: { title: "Wordbreak — Success Value not recorded" },
    modal: true,
    content: `<p>Determine the original Success Value of <strong>${escape(effect?.name ?? "Effect")}</strong> on ${escape(target?.name ?? "target")} again. Nothing is assumed to be 0.</p><p><input type="number" name="successValue" min="0" step="1"></p>`,
    buttons: [{
      action: "submit",
      label: "Use Success Value",
      callback: (_event, button) => {
        const raw = button?.form?.elements?.successValue?.value;
        // Number("") is 0, but a blank input means the original SV was not
        // re-determined. Only an explicitly supplied non-negative integer may
        // authorize the comparison; missing data must never become SV 0.
        if (raw === null || raw === undefined || String(raw).trim() === "") return null;
        const value = Number(raw);
        return Number.isInteger(value) && value >= 0 ? value : null;
      }
    }, { action: "none", label: "Do not cancel", callback: () => null }]
  });
}

function cancellationRemovalOwners(target, shared) {
  if (!shared) return [target];
  // /Space is global to the casting, including representations on unlinked
  // token Actors (which are not members of game.actors). Deduplicate linked
  // tokens by UUID so one document never receives two removal requests.
  const owners = new Map();
  const candidates = [
    ...(game?.actors ?? []),
    ...(canvas?.tokens?.placeables ?? []).map(token => token?.actor),
    target
  ];
  for (const actor of candidates) {
    if (!actor) continue;
    const key = actor.uuid ?? actor.id ?? actor;
    if (!owners.has(key)) owners.set(key, actor);
  }
  return [...owners.values()];
}

async function removeMembers(members, effectOperation = requestSw25EffectOperation) {
  const removed = [];
  const failures = [];
  for (const member of members) {
    const result = await effectOperation("remove", {
      actorUuid: member.target.uuid,
      effectId: member.effect.id
    });
    if (result?.ok === true) removed.push(member);
    else failures.push({ member, result });
  }
  return { removed, failures };
}

function resultLine(target, effectName, text, fields = {}) {
  return {
    target,
    cancellation: true,
    cancellationMechanism: "wordbreak",
    cancellationEligible: fields.eligible === true,
    countsForOutcome: fields.countsForOutcome === true,
    selected: fields.selected === true,
    cancelled: fields.cancelled === true,
    resisted: fields.resisted === true,
    automaticFailure: fields.automaticFailure === true,
    automaticSuccess: fields.automaticSuccess === true,
    summary: `<strong>${escape(target?.name ?? "Wordbreak")}:</strong> ${escape(effectName)} — ${text}`
  };
}

function chatFeedback(actor, results, magicPower, successValue = null) {
  const content = `<div class="sw25-chat-card wordbreak-card"><h3>Wordbreak</h3><p><strong>Magic Power:</strong> ${escape(magicPower)}${successValue === null ? "" : ` · <strong>SV:</strong> ${escape(successValue)}`}</p>${results.map(result => `<p>${result.summary}</p>`).join("")}</div>`;
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  });
}

/**
 * Complete production Wordbreak activation. The caller supplies the actual
 * selected canvas tokens from the character feat workflow.
 */
export async function activateWordbreak({
  actor,
  targets = [],
  castingClass = null,
  dialogs = {},
  effectOperation = requestSw25EffectOperation,
  sendChat = chatFeedback
} = {}) {
  const resolution = resolveWordbreakTarget({ targets });
  if (!resolution.ok) {
    const reason = resolution.code === "no-target" ? "Target one token for Wordbreak."
      : "Wordbreak affects one target at a time.";
    const results = [resultLine(null, "No valid target", reason)];
    if (typeof ChatMessage?.create === "function") await sendChat(actor, results, null);
    return { ok: false, code: resolution.code, results };
  }

  const target = resolution.entries[0].actor;
  const includeGmOnly = game?.user?.isGM === true;
  let candidates = candidatesFor(target, includeGmOnly);
  if (!candidates.length) {
    const results = [resultLine(target, "No eligible effect", "no Wordbreak-eligible effect is available on the target.")];
    if (typeof ChatMessage?.create === "function") await sendChat(actor, results, null);
    return { ok: false, code: "no-eligible-effect", results };
  }

  const declare = dialogs.declareEffect || defaultDeclare;
  const declaration = await declare({ candidates, target });
  if (declaration?.cancelled === true) return { ok: false, code: "cancelled", results: [] };
  const selected = declaration?.selection;
  if (!selected) return { ok: false, code: "no-declaration", results: [] };

  const casting = castingClass ?? resolveWordbreakCastingClass(actor);
  const rollResult = dialogs.rollCheck
    ? await dialogs.rollCheck({ actor, target, magicPower: spellDamageMagicPower(actor, casting), candidates })
    : await defaultRoll({ magicPower: spellDamageMagicPower(actor, casting) });
  const magicPower = spellDamageMagicPower(actor, casting);
  const automaticFailure = rollResult?.automaticFailure === true;
  const automaticSuccess = rollResult?.automaticSuccess === true;
  const successValue = Number(rollResult?.successValue ?? (
    Number(rollResult?.roll?.total ?? 0) + (automaticSuccess ? 5 : 0)
  ));
  if (automaticFailure) {
    const results = [resultLine(target, "Declared effect", "the Wordbreak check was an automatic failure; nothing was removed.", { automaticFailure: true, selected: true })];
    await sendChat(actor, results, magicPower, successValue);
    return { ok: true, code: "automatic-failure", results, successValue };
  }

  // Revalidate target, visibility, eligibility and effect identity.
  const currentTargets = game?.user?.targets
    ? [...game.user.targets]
    : targets;
  const freshResolution = resolveWordbreakTarget({ targets: currentTargets });
  const freshTarget = freshResolution.ok ? freshResolution.entries[0].actor : null;
  candidates = freshTarget ? candidatesFor(freshTarget, includeGmOnly) : [];
  const chosen = freshTarget && freshTarget.uuid === selected.actorUuid
    ? candidates.find(candidate => candidate.effect.id === selected.effectId)
    : null;
  if (!chosen) {
    const results = [resultLine(freshTarget ?? target, "Declared effect", "the declared effect is no longer a valid target. Nothing was removed.", { selected: true })];
    await sendChat(actor, results, magicPower, successValue);
    return { ok: true, code: "stale-selection", results, successValue };
  }

  let recovered = undefined;
  if (!automaticSuccess && effectRecordedSuccessValue(chosen.effect.system) === null) {
    const recover = dialogs.recoverSuccessValue || defaultRecoverSuccessValue;
    recovered = await recover({ target: freshTarget, effect: chosen.effect });
    if (!Number.isInteger(recovered) || recovered < 0) {
      const results = [resultLine(freshTarget, chosen.effect.name, "the effect's original Success Value was not recovered; nothing was removed.", { eligible: true, selected: true })];
      await sendChat(actor, results, magicPower, successValue);
      return { ok: true, code: "missing-success-value", results, successValue };
    }
  }

  const attempt = resolveCancellationAttempt({
    mechanism: "wordbreak",
    attemptSuccessValue: successValue,
    system: chosen.effect.system,
    automaticSuccess,
    instantX: instantXFor(chosen.effect),
    effectSuccessValue: recovered
  });
  let cancelled = false;
  let removalText = "";
  let outcomeText = attempt.reason;
  if (attempt.cancelled) {
    const shared = isSharedSpaceEffect(chosen.effect.system);
    const actors = cancellationRemovalOwners(freshTarget, shared);
    const group = collectCancellationRemovalGroup(chosen, actors);
    const removal = await removeMembers(group.members, effectOperation);
    cancelled = removal.failures.length === 0 && removal.removed.length > 0;
    if (removal.failures.length) removalText = ` Removal failed for ${removal.failures.length} representation(s).`;
    if (!cancelled) {
      // The rules comparison succeeded, but persistence did not. Do not show
      // the comparison's unqualified "the effect is cancelled" phrase as the
      // final user-facing outcome when EffectService rejected the removal.
      outcomeText = "The cancellation check succeeded, but authoritative effect removal did not complete.";
    }
    if (group.incomplete) removalText += " The /Space effect has no castId; only the declared representation was identifiable.";
  }
  const results = [resultLine(
    freshTarget,
    chosen.effect.name,
    `${outcomeText}${removalText}`,
    { eligible: true, selected: true, cancelled, resisted: !cancelled, automaticSuccess }
  )];
  await sendChat(actor, results, magicPower, successValue);
  return { ok: true, code: cancelled ? "cancelled" : "resisted", results, successValue };
}
