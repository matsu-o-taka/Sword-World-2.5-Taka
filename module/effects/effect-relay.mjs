// Sword World 2.5 - Effect GM relay (T2.2).
//
// Carrier between any client requesting a persistent effect operation and the
// connected GM: only the designated GM client executes the write, through the
// EffectService (module/effects/effect-service.mjs). Player clients never
// write system effects directly (DEC-36); this module only transports the
// REQUEST and the RESULT between clients over the shared system socket.
//
// Transport follows the system's established socket pattern (I1/I2: the MK
// relay in module/knowledge/mk-relay.mjs): one shared channel,
// `game.socket.emit/on` with a discriminated `action` field. Two actions:
//   effect-request   player -> GM   (operation + payload + requestId + gid)
//   effect-ack       GM -> player   (processing outcome for the requestId)
//
// Contract of the entry point `requestSw25EffectOperation(operation, request)`:
//   { ok: true,  status: "applied"|"removed"|"toggled"|"refreshed",
//     code, effectId?|effectUuid?|disabled?|updated?|... }
//   { ok: false, code: "no-gm"|"gm-offline"|"invalid-operation"|"invalid-request"
//     |"invalid-sender"|<service code>, error }
// The GM-side handler answers with the same vocabulary the EffectService
// produces ({ok, code, ...}), so failures are never silent.
//
// Guarantees implemented here (same skeleton as the MK relay, I2):
//   - GM authority: the GM handler is the only place that executes the
//     operation, and it executes it THROUGH the EffectService (which keeps
//     its own `not-gm` gate as defense in depth).
//   - No GM connected: no request is created, no local fallback write, and
//     the player receives an explicit `no-gm` immediately.
//   - Duplicate protection: the `requestId` is memoized by the GM (a repeated
//     delivery re-emits the stored ack instead of executing the write again).
//   - Targeting: the payload carries `gid` (the designated GM's user id);
//     only that GM client processes it, so a manipulated payload cannot
//     broadcast to every GM client.
//   - Real confirmation: the requester's promise settles when the ack of the
//     DESIGNATED GM arrives (sender id === the stored `gid`; other GM clients
//     cannot settle the request), or when the targeted GM disappears, through
//     the `updateUser`/`deleteUser` hooks. No timeout stands in for the ack.
//   - Sender validation: the claimed `requesterId` must match the socket
//     sender, and the sender must be an active, non-GM user.
//   - No queues, no automatic retries, no local fallback writes.
//
// GM clients: `requestSw25EffectOperation` called on a GM client executes the
// operation locally through the EffectService (same result contract). This is
// the documented difference from the MK relay's `gm-local` rejection: the
// service's GM-manual surface (T2.4) uses the same entry point, and the GM
// holds direct authority — there is nothing to transport.

import {
  SW25_EFFECT_OPERATIONS,
  applySw25Effect,
  removeSw25Effect,
  toggleSw25Effect,
  refreshSw25Effect
} from "./effect-service.mjs";

const SYSTEM_ID = "sw25-taka";

/** The shared system socket channel (I1: same channel as every system relay). */
export const EFFECT_RELAY_SOCKET = "system.sw25-taka";

/** Requester -> GM action name. */
export const EFFECT_RELAY_REQUEST_ACTION = "effect-request";

/** GM -> requester action name. */
export const EFFECT_RELAY_ACK_ACTION = "effect-ack";

// ── Request id generation (local; no MK dependency) ────────────────────────

/**
 * Generate a collision-resistant relay request id.
 * @param {string} [prefix] - Id prefix.
 * @returns {string} e.g. "efr-<random>".
 */
export function generateEffectRequestId(prefix = "efr") {
  const random = typeof foundry?.utils?.randomID === "function"
    ? foundry.utils.randomID(16)
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

// ── Client-side pending request state ──────────────────────────────────────

// requestId -> { gid, resolve } awaiting the GM ack (requester clients).
const pendingEffectRequests = new Map();

// GM client: requestId -> ack payload. Memoizes each processed request so a
// repeated delivery answers with the stored result instead of executing the
// write twice.
const processedEffectRequests = new Map();

/**
 * Snapshot of the requester-side pending relay requests (diagnosis).
 * @returns {Array<{requestId: string, gid: string|null, operation: string}>}
 */
export function listPendingEffectRequests() {
  return [...pendingEffectRequests.entries()].map(([requestId, entry]) => ({
    requestId,
    gid: entry.gid ?? null,
    operation: entry.operation ?? null
  }));
}

/**
 * Count of pending requester-side relay requests (diagnosis helper).
 * @returns {number}
 */
export function pendingEffectRequestCount() {
  return pendingEffectRequests.size;
}

// ── Access helpers ─────────────────────────────────────────────────────────

function currentUserId() {
  return game?.user?.id ?? game?.user?._id ?? null;
}

function isGmClient() {
  return game?.user?.isGM === true;
}

/**
 * Whether a GM is connected. On the GM client this is trivially true; on a
 * requester client it defers to `game.users.activeGM` (official accessor:
 * "Get one User who is an active Gamemaster… or null if no active GM").
 * @returns {{available: boolean, gid: string|null}}
 */
function connectedGm() {
  if (isGmClient()) return { available: true, gid: currentUserId() };
  const gm = game?.users?.activeGM ?? null;
  if (!gm || gm.active === false) return { available: false, gid: null };
  return { available: true, gid: gm.id ?? gm._id ?? null };
}

function notify(kind, message) {
  if (!ui?.notifications) return;
  if (typeof ui.notifications[kind] === "function") ui.notifications[kind](message);
}

// ── Payload validation / shaping ───────────────────────────────────────────

/**
 * Operation-specific field whitelist. The GM handler validates the resolved
 * actor and delegates semantic validation to the service itself; the
 * whitelist keeps unrelated or hostile fields out of the transport.
 * @type {Map<string, string[]>}
 */
const OPERATION_FIELDS = new Map([
  // No `name`: the document name is always the canonical name derived from
  // family + rank (DEC-16/49) and the payload cannot override it.
  // T5.3: `durationScale`/`durationAnchor` join the whitelist so a relayed
  // application keeps its duration fields; without them the transport would
  // silently downgrade an anchored application to a legacy one and bypass
  // the D4 anchor validation.
  ["apply", ["actorUuid", "family", "rank", "cast", "changes", "initialDuration",
    "remainingDuration", "img", "effectType", "origin", "casterUUID", "duration",
    "familyPolicy", "damageType", "durationScale", "durationAnchor", "acceptReplace"]],
  ["remove", ["actorUuid", "effectId"]],
  ["toggle", ["actorUuid", "effectId", "active"]],
  ["refresh", ["actorUuid", "effectId", "cast", "successValue", "remainingDuration"]]
]);

/**
 * Whitenlist and shallow-clone one operation request for transport.
 * @param {string} operation - Operation name.
 * @param {object} request - Caller request payload.
 * @returns {object|null} A sanitized request, or null when unusable.
 */
function sanitizeEffectRequest(operation, request) {
  const fields = OPERATION_FIELDS.get(operation);
  if (!fields || !request || typeof request !== "object" || Array.isArray(request)) return null;
  const sanitized = {};
  for (const field of fields) {
    if (request[field] !== undefined) sanitized[field] = request[field];
  }
  // The actor reference is mandatory for every operation; the GM resolves it
  // from the UUID (never trusting a bare actor id over the socket).
  if (typeof sanitized.actorUuid !== "string" || sanitized.actorUuid === "") return null;
  return sanitized;
}

function relayRequestPayload(requestId, gid, operation, request) {
  const requesterId = currentUserId();
  return {
    scope: SYSTEM_ID,
    action: EFFECT_RELAY_REQUEST_ACTION,
    requestId,
    gid,
    requesterId,
    operation,
    request
  };
}

// ── Requester side ─────────────────────────────────────────────────────────

/**
 * Request a persistent effect operation through the connected GM. The promise
 * settles ONLY on a real GM ack (or on the targeted GM's disappearance):
 * never by timeout, never through a local fallback write.
 *
 * Rejects fast with `no-gm` when no GM is connected — no pending request, no
 * local write, no deferred work.
 *
 * On a GM client the operation executes locally through the EffectService
 * (the GM holds direct authority; see the module header comment).
 *
 * @param {string} operation - "apply" | "remove" | "toggle" | "refresh".
 * @param {object} request - Operation payload (see the service contract).
 * @param {object} [options]
 * @param {boolean} [options.notify] - Notify the requester of the outcome.
 * @returns {Promise<{ok: boolean, status?: string, code?: string,
 *   effectId?: string, effectUuid?: string, disabled?: boolean,
 *   successValue?: number, updated?: object, error?: string}>}
 */
export async function requestSw25EffectOperation(operation, request, { notify: notifyEnabled = true } = {}) {
  if (!SW25_EFFECT_OPERATIONS.includes(operation)) {
    return { ok: false, code: "invalid-operation", error: `Unknown effect operation "${String(operation)}" (approved: ${SW25_EFFECT_OPERATIONS.join(", ")}).` };
  }
  const sanitized = sanitizeEffectRequest(operation, request);
  if (!sanitized) {
    return { ok: false, code: "invalid-request", error: `The ${operation} request carries unusable fields (a resolved actor UUID is mandatory).` };
  }

  // GM clients execute locally: direct authority, same result contract.
  if (isGmClient()) {
    return executeEffectOperationLocally(operation, sanitized, { notify: notifyEnabled });
  }

  // No active GM: explicit immediate rejection — no pending request, no
  // local write, no timing retry (DEC-36; MK relay design decision).
  const { available, gid } = connectedGm();
  if (!available) {
    if (notifyEnabled) {
      notify("warn", "Effect changes require a connected Game Master. The operation was not executed.");
    }
    return { ok: false, code: "no-gm", error: "Effect changes require a connected Game Master." };
  }

  const requestId = generateEffectRequestId();
  const payload = relayRequestPayload(requestId, gid, operation, sanitized);

  let resolvePending;
  const promise = new Promise(resolve => { resolvePending = resolve; });
  pendingEffectRequests.set(requestId, { gid, resolve: resolvePending, operation });

  try {
    await game.socket.emit(EFFECT_RELAY_SOCKET, payload);
  } catch (error) {
    pendingEffectRequests.delete(requestId);
    if (notifyEnabled) notify("error", `Effect request failed: ${String(error?.message ?? error)}`);
    return { ok: false, code: "relay-failed", error: String(error?.message ?? error) };
  }

  const conclusion = await promise;
  if (notifyEnabled) notifyEffectOutcome(conclusion);
  return conclusion;
}

/**
 * Execute an effect operation directly through the EffectService (the GM's
 * local path; shared by the local shortcut and the GM handler).
 * @param {string} operation - Operation name.
 * @param {object} request - Sanitized operation payload.
 * @param {object} [options] - { notify }
 * @returns {Promise<{ok: boolean, status?: string, code?: string, ...}>}
 */
async function executeEffectOperationLocally(operation, request, { notify: notifyEnabled = true } = {}) {
  const actor = await resolveEffectActor(request.actorUuid);
  if (!actor) {
    const result = { ok: false, code: "actor-not-found", error: "The actor referenced by the effect request could not be resolved." };
    if (notifyEnabled) notify("error", `Effect request failed (${result.code}).`);
    return result;
  }
  const { actorUuid, ...payload } = request;
  let result;
  if (operation === "apply") result = await applySw25Effect(actor, payload, { notify: notifyEnabled });
  else if (operation === "remove") result = await removeSw25Effect(actor, payload.effectId, { notify: notifyEnabled });
  else if (operation === "toggle") result = await toggleSw25Effect(actor, payload.effectId, { active: payload.active ?? null, notify: notifyEnabled });
  else result = await refreshSw25Effect(actor, payload.effectId, { cast: payload.cast, successValue: payload.successValue, remainingDuration: payload.remainingDuration }, { notify: notifyEnabled });
  if (result.ok) {
    return { ok: true, status: `${operation === "apply" ? "applied" : operation === "remove" ? "removed" : operation === "toggle" ? "toggled" : "refreshed"}`, ...result };
  }
  return result;
}

/**
 * Resolve the target actor from a UUID on the GM side. The GM never trusts a
 * bare actor id carried over the socket: the UUID is re-resolved here (same
 * integrity rule as the MK relay re-deriving the species).
 * @param {string} actorUuid - Actor document UUID ("Actor.<id>").
 * @returns {Promise<object|null>} The actor document, or null.
 */
async function resolveEffectActor(actorUuid) {
  let actor = null;
  if (typeof fromUuid === "function") {
    try { actor = await fromUuid(actorUuid); } catch { actor = null; }
  }
  if (!actor && game?.actors?.get) {
    actor = game.actors.get(String(actorUuid).replace(/^Actor\./, "")) ?? null;
  }
  return actor ?? null;
}

/**
 * Resolve a pending request because its targeted GM is gone. Event-driven
 * lifecycle (no timers): the GM's disappearance arrives through the
 * `updateUser`/`deleteUser` document hooks and settles the promise with an
 * explicit failure. Nothing is queued for later.
 * @param {string} code - Failure code for the requester ("gm-offline").
 * @param {string|null} [gid] - Restrict expiry to a specific GM id (or all).
 * @returns {number} How many pending requests were settled.
 */
export function expirePendingEffectRequests(code = "gm-offline", gid = null) {
  let settled = 0;
  for (const [requestId, entry] of [...pendingEffectRequests.entries()]) {
    if (gid !== null && entry.gid !== null && entry.gid !== gid) continue;
    pendingEffectRequests.delete(requestId);
    entry.resolve({ ok: false, code, error: "The Game Master left before the effect operation could be executed." });
    settled += 1;
  }
  return settled;
}

// ── GM side ────────────────────────────────────────────────────────────────

async function emitAck(ack) {
  try {
    await game.socket.emit(EFFECT_RELAY_SOCKET, ack);
  } catch (error) {
    console.error("[SW25 Effect Relay] could not emit ack", error);
  }
}

async function rejectEffectRequest(requestId, requesterId, ack) {
  processedEffectRequests.set(requestId, ack);
  notify("warn", `Effect request rejected (${ack.code}).`);
  await emitAck(ack);
}

/**
 * Validate and execute one requester operation with GM authority.
 *
 * Validations (in order): intended GM, requestId present, sender is an
 * active connected player (claimed requester === socket sender), operation
 * known, request shape. Only then does the handler execute the operation
 * through the EffectService.
 *
 * @param {object} payload - The relay request.
 * @param {string|null} senderId - Socket sender user id.
 * @returns {Promise<void>}
 */
async function processEffectRequest(payload, senderId) {
  if (typeof payload?.requestId !== "string" || !payload.requestId) {
    notify("warn", "Invalid effect relay request: missing requestId.");
    return;
  }
  const requestId = payload.requestId;

  // Only the designated GM processes the request (same targeting as the MK
  // relay): other GM clients ignore it.
  const requestedGid = typeof payload.gid === "string" && payload.gid ? payload.gid : null;
  if (!requestedGid || requestedGid !== currentUserId()) return;

  // Duplicate protection: reserve the slot immediately so an interleaved
  // duplicate cannot start a second processing cycle; the first cycle will
  // ack the requester.
  const cached = processedEffectRequests.get(requestId);
  if (cached) {
    await emitAck(cached);
    return;
  }
  if (processedEffectRequests.has(requestId)) return;
  processedEffectRequests.set(requestId, null);

  const makeAck = ack => ({ scope: SYSTEM_ID, ...ack, requestId, gid: requestedGid });
  const sender = senderId ? (game?.users?.get?.(senderId) ?? null) : null;
  const requesterId = (typeof payload.requesterId === "string" && payload.requesterId)
    ? payload.requesterId
    : senderId;
  if (!sender || sender.active === false || sender.isGM) {
    await rejectEffectRequest(requestId, requesterId, makeAck({
      action: EFFECT_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "invalid-sender",
      error: "The sender is unknown, inactive, or not a player client."
    }));
    return;
  }
  if (requesterId && senderId && requesterId !== senderId) {
    await rejectEffectRequest(requestId, requesterId, makeAck({
      action: EFFECT_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "invalid-sender",
      error: "The claimed requester does not match the socket sender."
    }));
    return;
  }

  const operation = payload.operation;
  if (!SW25_EFFECT_OPERATIONS.includes(operation)) {
    await rejectEffectRequest(requestId, requesterId, makeAck({
      action: EFFECT_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "invalid-operation",
      error: `Unknown effect operation "${String(operation)}".`
    }));
    return;
  }
  const request = sanitizeEffectRequest(operation, payload.request);
  if (!request) {
    await rejectEffectRequest(requestId, requesterId, makeAck({
      action: EFFECT_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "invalid-request",
      error: `The ${operation} request carries unusable fields.`
    }));
    return;
  }

  try {
    const result = await executeEffectOperationLocally(operation, request, { notify: false });
    const ack = result.ok
      ? makeAck({
        action: EFFECT_RELAY_ACK_ACTION,
        requestedBy: requesterId,
        status: result.status,
        code: result.code,
        effectId: result.effectId ?? null,
        effectUuid: result.effectUuid ?? null,
        disabled: typeof result.disabled === "boolean" ? result.disabled : null,
        successValue: typeof result.successValue === "number" ? result.successValue : null,
        updated: result.updated ?? null,
        // Bloque 4: the ids the replacement deleted (apply only).
        replacedIds: Array.isArray(result.replacedIds) ? result.replacedIds : null
      })
      : makeAck({
        action: EFFECT_RELAY_ACK_ACTION,
        requestedBy: requesterId,
        status: "error",
        code: result.code,
        error: result.error,
        // Bloque 4: a pending stacking decision travels back so the requester
        // can decide and re-apply (no embedded dialog in the transport).
        choice: result.code === "choice-required" ? (result.choice ?? null) : null
      });
    processedEffectRequests.set(requestId, ack);
    if (result.ok) {
      notify("info", `Effect ${result.status} for ${requesterId}.`);
    } else {
      notify("warn", `Effect request failed for ${requesterId}: ${result.code}.`);
    }
    await emitAck(ack);
  } catch (error) {
    const ack = makeAck({
      action: EFFECT_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "error",
      code: "relay-failed",
      error: String(error?.message ?? error)
    });
    processedEffectRequests.set(requestId, ack);
    notify("error", `Effect relay processing failed: ${ack.error}`);
    await emitAck(ack);
  }
}

/**
 * Ack arrived at the requester: settle the pending promise. Three validations
 * must hold — the socket sender is a GM, that GM is EXACTLY the designated
 * one for this request (sender id === the `gid` stored with the requestId),
 * and the request is still pending with that id. An ack from any other GM
 * client (valid GM user or not) cannot settle or falsify the request, and an
 * ack for an unknown/settled requestId changes no state.
 * @param {object} ack - The GM ack payload.
 * @param {string|null} senderId - Socket sender id.
 */
function handleEffectAck(ack, senderId) {
  const sender = senderId ? (game?.users?.get?.(senderId) ?? null) : null;
  if (ack?.action !== EFFECT_RELAY_ACK_ACTION || !sender || sender.isGM !== true) {
    console.warn("[SW25 Effect Relay] ignoring unauthenticated or malformed ack");
    return;
  }
  const pending = pendingEffectRequests.get(ack?.requestId);
  if (!pending) return; // unknown or already-settled requestId: no state change
  // Only the DESIGNATED GM for this request may settle it: the sender must
  // match the stored gid, and a carried gid field (if any) must agree.
  const ackGid = typeof ack?.gid === "string" && ack.gid ? ack.gid : senderId;
  if (ackGid !== senderId || pending.gid !== ackGid) {
    console.warn("[SW25 Effect Relay] ignoring ack from a GM other than the designated one");
    return;
  }
  pendingEffectRequests.delete(ack.requestId);
  pending.resolve(normalizeAck(ack));
}

/**
 * Normalize an ack payload into the requester's result contract.
 * @param {object} ack - Raw GM ack.
 * @returns {{ok: boolean, status?: string, code?: string, error?: string, ...}}
 */
function normalizeAck(ack) {
  if (ack?.status === "applied" || ack?.status === "removed" || ack?.status === "toggled" || ack?.status === "refreshed") {
    return {
      ok: true,
      status: ack.status,
      code: typeof ack.code === "string" ? ack.code : ack.status,
      effectId: typeof ack.effectId === "string" ? ack.effectId : null,
      effectUuid: typeof ack.effectUuid === "string" ? ack.effectUuid : null,
      disabled: typeof ack.disabled === "boolean" ? ack.disabled : null,
      successValue: typeof ack.successValue === "number" ? ack.successValue : null,
      updated: ack.updated ?? null,
      replacedIds: Array.isArray(ack.replacedIds) ? ack.replacedIds : null
    };
  }
  return {
    ok: false,
    code: typeof ack?.code === "string" ? ack.code : "relay-failed",
    error: typeof ack?.error === "string" ? ack.error : "The effect request could not be processed.",
    choice: ack?.choice ?? null
  };
}

function notifyEffectOutcome(conclusion) {
  if (conclusion.ok) {
    notify("info", `Effect operation confirmed (${conclusion.status}).`);
    return;
  }
  if (conclusion.code === "no-gm") {
    notify("warn", "Effect changes require a connected Game Master. The operation was not executed.");
    return;
  }
  notify("error", `Effect request failed (${conclusion.code}): ${conclusion.error}`);
}

/**
 * Single socket entry: dispatches both directions.
 * @param {object} payload - Socket payload.
 * @param {string|null} senderId - Socket sender id.
 */
async function relaySocketHandler(payload, senderId) {
  if (!payload || typeof payload !== "object" || payload.scope !== SYSTEM_ID) return;
  if (payload.action === EFFECT_RELAY_REQUEST_ACTION) {
    await processEffectRequest(payload, senderId);
    return;
  }
  if (payload.action === EFFECT_RELAY_ACK_ACTION) {
    handleEffectAck(payload, senderId);
  }
}

/**
 * Register the relay on this client. Runs on EVERY client: requesters need
 * the ack listener to settle their requests; only GM clients process
 * requests. Wired from sw25.mjs (`Hooks.once("ready", initializeEffectRelay)`)
 * and directly callable in tests.
 * @returns {void}
 */
export function initializeEffectRelay() {
  if (typeof game?.socket?.on === "function") {
    game.socket.on(EFFECT_RELAY_SOCKET, relaySocketHandler);
    console.log("[SW25 Effect Relay] socket listener registered");
  }
  // Event-driven lifecycle: a targeted GM disappearing settles its pending
  // requests with an explicit failure (no queues, no timed retries).
  if (typeof Hooks !== "undefined" && Hooks && typeof Hooks.on === "function") {
    Hooks.on("updateUser", user => {
      if (user?.isGM && user?.active === false) {
        expirePendingEffectRequests("gm-offline", user.id ?? user._id ?? null);
      }
    });
    Hooks.on("deleteUser", user => {
      if (user?.isGM) expirePendingEffectRequests("gm-offline", user.id ?? user._id ?? null);
    });
  }
}
