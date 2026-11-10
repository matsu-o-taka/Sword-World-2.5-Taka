// Sword World 2.5 - Monster Knowledge GM relay (F2-T1).
//
// Carrier between a player's Monster Knowledge roll and the connected GM:
// only the GM client persists a discovery into the Monster Knowledge Registry
// (`mkRegistry`). Player clients never write the registry; this module only
// transports the REQUEST and the RESULT between clients over a game socket.
//
// Transport follows the system's established socket pattern (the OBSERVER
// relay in module/combat/monster-knowledge.mjs): one shared channel,
// `game.socket.emit/on` with a discriminated `action` field. Two actions:
//   mk-discovery-request  player -> GM   (evidence + requestId + requester id)
//   mk-discovery-ack      GM -> player   (processing outcome for the requestId)
//
// Contract of the module entry point `requestMkRelayDiscovery(evidence)`:
//   { ok: true,  data: { status: "registered"|"promoted"|"already-known",
//                        speciesId, recordId, bestiaryActorUuid|null } }
//   { ok: false, code: "no-gm"|"relay-failed"|"gm-offline"|service code, error }
// The GM-side handler answers with the same `code` vocabulary the registry
// service produces ({ok, code, error}), so failures are never silent.
//
// Guarantees implemented here:
//   - GM authority: the GM handler is the only place that calls the write
//     operation (`registerMkDiscovery`); refusal paths never touch it and the
//     service itself keeps its own `not-gm` gate as defense in depth.
//   - No GM connected: no request is created, no local fallback write, and
//     the player receives an explicit informative message (design decision).
//   - Duplicate protection: a `requestId` is memoized by the GM (a repeated
//     delivery re-emits the stored result instead of executing again); the
//     registry additionally dedupes by speciesId (`already-known`).
//   - Real confirmation: the requester's promise settles when the GM ack
//     arrives (or when the targeted GM disappears, resolved through the
//     `updateUser`/`deleteUser` hooks). No timed waits stand in for the ack.
//   - Evidence integrity: the GM re-derives the species from the referenced
//     monster document and ignores any caller-supplied speciesId or
//     discoveredBy; `discoveredBy` is always the requesting player's id.

import { normalizeSpeciesId } from "./mk-identity.mjs";
import { registerMkDiscovery } from "./monster-knowledge-registry.mjs";
import { generateMkId } from "./monster-knowledge-store.mjs";

const SYSTEM_ID = "sw25-taka";

/**
 * Shared system socket channel (same channel already used by the damage
 * application, spell effects, side initiative and OBSERVER relays).
 */
export const MK_RELAY_SOCKET = "system.sw25-taka";

/** Player -> GM action name. */
export const MK_RELAY_REQUEST_ACTION = "mk-discovery-request";

/** GM -> player action name. */
export const MK_RELAY_ACK_ACTION = "mk-discovery-ack";

// ── Client-side pending request state ──────────────────────────────────────

// requestId -> { gid, resolve } awaiting the GM ack (player clients).
const pendingMkRelayRequests = new Map();

// GM client: requestId -> ack payload. Memoizes each processed request so a
// repeated delivery answers with the stored result instead of executing the
// write twice.
const processedMkRelayRequests = new Map();

/**
 * Snapshot of the requester-side pending relay requests (diagnosis; the F3
 * management UI may expose this through its own surface).
 * @returns {Array<{requestId: string, gid: string|null}>}
 */
export function listPendingMkRelayRequests() {
  return [...pendingMkRelayRequests.entries()].map(([requestId, entry]) => ({
    requestId,
    gid: entry.gid ?? null
  }));
}

/**
 * Count of pending requester-side relay requests (diagnosis helper).
 * @returns {number}
 */
export function pendingMkRelayRequestCount() {
  return pendingMkRelayRequests.size;
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
 * player client it defers to `game.users.activeGM` (official accessor: "Get
 * one User who is an active Gamemaster… or null if no active GM").
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

// ── Payload shaping ────────────────────────────────────────────────────────

/**
 * Whitelist the evidence transported to the GM. Nothing here is trusted for
 * the write decision (the GM handler re-derives the species from the monster
 * document); the whitelist keeps unrelated or hostile fields (Weak Point
 * text, extra keys) out of the transport.
 * @param {object} evidence - Discovery evidence from the roll flow.
 * @returns {object|null} A sanitized evidence object, or null when unusable.
 */
function sanitizeEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  const speciesId = typeof evidence.speciesId === "string" ? evidence.speciesId : null;
  if (!speciesId) return null;
  const classResult = Number(evidence.classResult);
  return {
    speciesId,
    speciesLabel: typeof evidence.speciesLabel === "string" ? evidence.speciesLabel.slice(0, 200) : null,
    monsterUuid: typeof evidence.monsterUuid === "string" ? evidence.monsterUuid : null,
    monsterName: typeof evidence.monsterName === "string" ? evidence.monsterName.slice(0, 200) : null,
    className: typeof evidence.className === "string" ? evidence.className.slice(0, 100) : null,
    classResult: Number.isFinite(classResult) ? classResult : null,
    level: evidence.level === "weakness" ? "weakness" : "reputation",
    actorUuid: typeof evidence.actorUuid === "string" ? evidence.actorUuid : null,
    actorName: typeof evidence.actorName === "string" ? evidence.actorName : null
    // `source` is forced to "roll" by the relay protocol; `discoveredBy` is
    // never taken from the caller (the GM stamps the requester's id).
  };
}

function relayRequestPayload(requestId, gid, evidence) {
  const requesterId = currentUserId();
  return {
    scope: SYSTEM_ID,
    action: MK_RELAY_REQUEST_ACTION,
    requestId,
    gid,
    requesterId,
    evidence: {
      ...evidence,
      source: "roll",
      discoveredBy: requesterId
    }
  };
}

// ── Requester side ─────────────────────────────────────────────────────────

/**
 * Send a Monster Knowledge discovery to the connected GM for authoritative
 * persistence. The promise settles ONLY on a real GM response (or on the
 * targeted GM's disappearance): never by timeout.
 *
 * Rejects fast with `no-gm` when no GM is connected — no pending request, no
 * local write, no deferred work — after showing the informative message.
 *
 * @param {object} evidence - Discovery evidence (same shape as the service's
 *   `registerMkDiscovery`), produced by the roll flow on the requester.
 * @param {object} [options]
 * @param {boolean} [options.notify] - Notify the requester of the outcome.
 * @param {boolean} [options.publishRevealNotice] - Whether the requester
 *   publishes the Bestiary reveal whisper after a successful ack (defaults
 *   to true). The roll flow passes false and publishes ONE reveal per
 *   monster at the end of its resolution (see
 *   `publishMkBestiaryReveal`), so a roll reaching both the reputation and
 *   the weakness threshold sends only one notice for the highest level.
 * @returns {Promise<{ok: boolean, data?: object, code?: string, error?: string}>}
 */
export async function requestMkRelayDiscovery(evidence, { notify: notifyEnabled = true, publishRevealNotice: publishReveal = true } = {}) {
  const sanitized = sanitizeEvidence(evidence);
  if (!sanitized) {
    return { ok: false, code: "no-species", error: "A Monster Knowledge relay needs a monster species identifier." };
  }
  // The GM client never relays its own discoveries: it persists in place.
  if (isGmClient()) {
    return { ok: false, code: "gm-local", error: "GM clients persist Monster Knowledge discoveries directly." };
  }
  // No active GM and no GM connected: no pending request, no local write,
  // no timing retry (design decision of F2-T1).
  const { available, gid } = connectedGm();
  if (!available) {
    if (notifyEnabled) {
      notify("warn", "Monster Knowledge requires a connected Game Master. The discovery was not recorded.");
    }
    return { ok: false, code: "no-gm", error: "Monster Knowledge requires a connected Game Master." };
  }
  const requestId = generateMkId("mkr");
  const payload = relayRequestPayload(requestId, gid, sanitized);

  let resolvePending;
  const promise = new Promise(resolve => { resolvePending = resolve; });
  pendingMkRelayRequests.set(requestId, { gid, resolve: resolvePending });

  try {
    await game.socket.emit(MK_RELAY_SOCKET, payload);
  } catch (error) {
    pendingMkRelayRequests.delete(requestId);
    if (notifyEnabled) notify("error", `Monster Knowledge relay failed: ${String(error?.message ?? error)}`);
    return { ok: false, code: "relay-failed", error: String(error?.message ?? error) };
  }

  const conclusion = await promise;
  if (notifyEnabled) notifyRelayOutcome(conclusion);
  if (publishReveal && conclusion.ok) await publishMkRevealNotice(conclusion);
  return conclusion;
}

/**
 * Reveal surface for the requester (Fase 4 model): a successful ack carries
 * the UUID of the independent Bestiary copy for the species, so players can
 * CONSULT what was revealed by opening that copy (the copy was created with
 * default OBSERVER ownership). The notice is a private, whispered chat
 * message with a clickable `@UUID` content link. It is chat transport only:
 * no registry write, no Actor write, no permission change from the player
 * client.
 *
 * The whisper reaches EVERY connected player, not just the roller: Monster
 * Knowledge is shared table knowledge — the Bestiary visibility must apply
 * to all players (the copy grants default OBSERVER regardless of who rolled).
 * @param {{ok: boolean, data?: object}} conclusion - Settled relay conclusion.
 * @returns {Promise<void>}
 */
async function publishMkRevealNotice(conclusion) {
  await publishMkBestiaryReveal({
    speciesId: conclusion?.data?.speciesId ?? null,
    bestiaryActorUuid: conclusion?.data?.bestiaryActorUuid ?? null
  });
}

/**
 * Publish one Bestiary reveal whisper for a species copy.
 * @param {object} params - Reveal parameters.
 * @param {string|null} params.speciesId - Species identifier for the text.
 * @param {string|null} params.bestiaryActorUuid - The Bestiary copy uuid.
 * @param {string[]|null} [params.whisperIds] - Explicit recipient user ids;
 *   null defaults to every active connected player (non-GM users).
 * @returns {Promise<{posted: boolean, recipients: number, skipped: string|null}>}
 */
export async function publishMkBestiaryReveal({ speciesId, bestiaryActorUuid, whisperIds = null } = {}) {
  const uuid = typeof bestiaryActorUuid === "string" ? bestiaryActorUuid : null;
  if (!uuid) return { posted: false, recipients: 0, skipped: "no-copy" };
  if (typeof ChatMessage === "undefined" || typeof ChatMessage.create !== "function") {
    return { posted: false, recipients: 0, skipped: "no-chat" };
  }
  const escapeValue = value => (typeof foundry?.utils?.escapeHTML === "function"
    ? foundry.utils.escapeHTML(value)
    : String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]));
  const species = escapeValue(String(speciesId ?? "the species"));
  const content = `<div class="sw25-chat-card sw25-mk-reveal-message">` +
    `<h4>Monster Knowledge revealed</h4>` +
    `<p>Bestiary entry available for <strong>${species}</strong>: @UUID[${uuid}]{Consult Bestiary entry}</p>` +
    `</div>`;
  try {
    // Recipients: every active connected player (non-GM users). The GM is
    // never a whisper target; explicit whisperIds override the default.
    let recipients;
    if (Array.isArray(whisperIds)) {
      recipients = whisperIds.filter(id => typeof id === "string" && id);
    } else {
      // Collection-agnostic read: v14 UserCollection iterates via values();
      // test/mocked environments may only expose filter()-style access.
      let users = [];
      if (typeof game?.users?.values === "function") users = [...game.users.values()];
      else if (typeof game?.users?.filter === "function") users = game.users.filter(() => true) ?? [];
      recipients = users
        .filter(user => user && user.isGM !== true && user.active !== false)
        .map(user => user.id)
        .filter(id => typeof id === "string" && id);
    }
    if (!recipients.length) {
      return { posted: false, recipients: 0, skipped: "no-recipients" };
    }
    await ChatMessage.create({
      content,
      speaker: { alias: "Monster Knowledge" },
      whisper: recipients,
      flags: { [SYSTEM_ID]: { mkReveal: true } }
    });
    return { posted: true, recipients: recipients.length, skipped: null };
  } catch (error) {
    console.error("[SW25 MK Relay] could not publish the Bestiary reveal notice", error);
    return { posted: false, recipients: 0, skipped: "error" };
  }
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
export function expirePendingMkRelayRequests(code = "gm-offline", gid = null) {
  let settled = 0;
  for (const [requestId, entry] of [...pendingMkRelayRequests.entries()]) {
    if (gid !== null && entry.gid !== null && entry.gid !== gid) continue;
    pendingMkRelayRequests.delete(requestId);
    entry.resolve({ ok: false, code, error: "The Game Master left before the discovery could be recorded." });
    settled += 1;
  }
  return settled;
}

function normalizeAck(ack) {
  const status = ack?.status;
  // "promoted" is a success: the species was already stored as "reputation"
  // and the weakness discovery promoted its level (weakness implies
  // reputation). Refusing it made the requester report `relay-failed` even
  // though the GM had already persisted the discovery.
  if (status === "registered" || status === "already-known" || status === "promoted") {
    return {
      ok: true,
      data: {
        status,
        speciesId: typeof ack.speciesId === "string" ? ack.speciesId : null,
        recordId: typeof ack.recordId === "string" ? ack.recordId : null,
        bestiaryActorUuid: typeof ack.bestiaryActorUuid === "string" ? ack.bestiaryActorUuid : null
      }
    };
  }
  return {
    ok: false,
    code: typeof ack?.code === "string" ? ack.code : "relay-failed",
    error: typeof ack?.error === "string" ? ack.error : "The Monster Knowledge request could not be processed."
  };
}

function notifyRelayOutcome(conclusion) {
  if (conclusion.ok) {
    // Every success status gets its own message and NONE reports a failure,
    // so a confirmed GM persist never shows as `relay-failed` to the player.
    if (conclusion.data?.status === "promoted") {
      notify("info", "Weakness recorded in the Monster Knowledge Registry (reputation promoted to weakness).");
    } else if (conclusion.data?.status === "already-known") {
      notify("info", "Weakness already known for the species.");
    } else {
      notify("info", "Weakness recorded in the Monster Knowledge Registry.");
    }
    return;
  }
  if (conclusion.code === "no-gm") {
    notify("warn", "Monster Knowledge requires a connected Game Master. The discovery was not recorded.");
    return;
  }
  notify("error", `Monster Knowledge relay failed (${conclusion.code}): ${conclusion.error}`);
}

// ── GM side ────────────────────────────────────────────────────────────────

async function emitAck(ack) {
  try {
    await game.socket.emit(MK_RELAY_SOCKET, ack);
  } catch (error) {
    console.error("[SW25 MK Relay] could not emit ack", error);
  }
}

async function rejectRelayRequest(requestId, requestedBy, ack) {
  processedMkRelayRequests.set(requestId, ack);
  notify("warn", `Monster Knowledge request rejected (${ack.code}).`);
  await emitAck(ack);
}

/**
 * Validate and persist one player discovery with GM authority.
 *
 * Validations (in order): intended GM, requestId present, sender is an
 * active connected user (the player identity for the evidence), evidence
 * shape, monster document resolution, species re-derivation. Only after all
 * of them pass does the handler call `registerMkDiscovery`.
 *
 * @param {object} payload - The relay request.
 * @param {string|null} senderId - Socket sender user id.
 * @returns {Promise<void>}
 */
async function processMkRelayRequest(payload, senderId) {
  if (typeof payload?.requestId !== "string" || !payload.requestId) {
    notify("warn", "Invalid Monster Knowledge relay request: missing requestId.");
    return;
  }
  const requestId = payload.requestId;

  // Only the designated GM processes the request (same targeting as the
  // OBSERVER relay): other GM clients ignore it. The gid is mandatory so a
  // manipulated payload cannot broadcast to every GM client.
  const requestedGid = typeof payload.gid === "string" && payload.gid ? payload.gid : null;
  if (!requestedGid || requestedGid !== currentUserId()) return;

  // Duplicate protection: reserve the slot immediately so an interleaved
  // duplicate (or a delivery repeated by the network) cannot start a second
  // processing cycle; the first cycle will ack the requester.
  const cached = processedMkRelayRequests.get(requestId);
  if (cached) {
    await emitAck(cached);
    return;
  }
  if (processedMkRelayRequests.has(requestId)) return;
  processedMkRelayRequests.set(requestId, null);

  const makeAck = ack => ({ scope: SYSTEM_ID, ...ack, requestId, gid: requestedGid });
  const sender = senderId ? (game?.users?.get?.(senderId) ?? null) : null;
  const requesterId = (typeof payload.requesterId === "string" && payload.requesterId)
    ? payload.requesterId
    : senderId;
  if (!sender || sender.active === false || sender.isGM) {
    await rejectRelayRequest(requestId, requesterId, makeAck({
      action: MK_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "invalid-sender",
      error: "The sender is unknown, inactive, or not a player client."
    }));
    return;
  }
  if (requesterId && senderId && requesterId !== senderId) {
    await rejectRelayRequest(requestId, requesterId, makeAck({
      action: MK_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "invalid-sender",
      error: "The claimed requester does not match the socket sender."
    }));
    return;
  }

  const evidence = sanitizeEvidence(payload.evidence);
  if (!evidence) {
    await rejectRelayRequest(requestId, requesterId, makeAck({
      action: MK_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "invalid-request",
      error: "The relay request carries unusable discovery evidence."
    }));
    return;
  }
  if (typeof evidence.monsterUuid !== "string" || !evidence.monsterUuid) {
    await rejectRelayRequest(requestId, requesterId, makeAck({
      action: MK_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "invalid-request",
      error: "The relay request references no monster document."
    }));
    return;
  }

  // The species is re-derived from the monster document: a manipulated
  // speciesId cannot inject knowledge about an unrelated species.
  let monster = null;
  if (typeof fromUuid === "function") {
    try { monster = await fromUuid(evidence.monsterUuid); } catch { monster = null; }
  }
  if (!monster && game?.actors?.get) monster = game.actors.get(evidence.monsterUuid);
  if (!monster || monster.type !== "monster") {
    await rejectRelayRequest(requestId, requesterId, makeAck({
      action: MK_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "monster-not-found",
      error: "The monster referenced by the relay request could not be resolved."
    }));
    return;
  }
  const speciesId = speciesFromDocument(monster);
  if (!speciesId) {
    await rejectRelayRequest(requestId, requesterId, makeAck({
      action: MK_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "rejected",
      code: "no-species",
      error: "The referenced monster has no species identifier."
    }));
    return;
  }

  try {
    const result = await registerMkDiscovery({
      speciesId,
      speciesLabel: evidence.speciesLabel ?? monster.system?.species ?? speciesId,
      monsterUuid: monster.uuid ?? evidence.monsterUuid,
      monsterName: monster.name ?? evidence.monsterName,
      className: evidence.className,
      classResult: evidence.classResult,
      level: evidence.level,
      // Roll identity is preserved: the PLAYER who rolled is the discoverer,
      // regardless of which client persists (evidence rule of F2-T1).
      source: "roll",
      discoveredBy: requesterId,
      actorUuid: evidence.actorUuid,
      actorName: evidence.actorName
    });
    let ack;
    if (result.ok) {
      ack = makeAck({
        action: MK_RELAY_ACK_ACTION,
        requestedBy: requesterId,
        status: result.data.status,
        speciesId: result.data.speciesId,
        recordId: result.data.recordId,
        bestiaryActorUuid: typeof result.data.bestiaryActorUuid === "string" ? result.data.bestiaryActorUuid : null
      });
    } else {
      ack = makeAck({
        action: MK_RELAY_ACK_ACTION,
        requestedBy: requesterId,
        status: "error",
        code: result.code,
        error: result.error
      });
    }
    processedMkRelayRequests.set(requestId, ack);
    if (!result.ok) {
      notify("warn", `Monster Knowledge request failed for ${requesterId}: ${result.code}.`);
    } else {
      notify("info", `Monster Knowledge discovery recorded for ${requesterId} (${result.data.speciesId}).`);
      if (result.data.bestiaryCopyFailed) {
        // Copy failures are action-relevant (players never get the actor
        // link) and must be visibly escalated to the GM, never silent.
        notify("warn", `Monster Knowledge Bestiary copy failed for species ${result.data.speciesId}: ${result.data.bestiaryCopyFailed}`);
      }
    }
    await emitAck(ack);
    return;
  } catch (error) {
    const ack = makeAck({
      action: MK_RELAY_ACK_ACTION,
      requestedBy: requesterId,
      status: "error",
      code: "relay-failed",
      error: String(error?.message ?? error)
    });
    processedMkRelayRequests.set(requestId, ack);
    notify("error", `Monster Knowledge relay processing failed: ${ack.error}`);
    await emitAck(ack);
  }
}

/**
 * Species id of an Actor-like document. Local copy against a circular
 * import with monster-knowledge.mjs; delegates to the shared identity
 * module when it is importable from here (it always is: mk-identity is pure).
 */
function speciesFromDocument(monster) {
  const species = monster?.system?.species;
  if (!species) return null;
  return normalizeSpeciesId(species);
}

/**
 * Ack arrived at the requester: settle the pending promise. Only an ack
 * emitted by a GM client is accepted — a forged ack from a player client
 * cannot settle (or falsify) a request.
 * @param {object} ack - The GM ack payload.
 * @param {string|null} senderId - Socket sender id.
 */
function handleMkRelayAck(ack, senderId) {
  const sender = senderId ? (game?.users?.get?.(senderId) ?? null) : null;
  if (ack?.action !== MK_RELAY_ACK_ACTION || !sender || sender.isGM !== true) {
    console.warn("[SW25 MK Relay] ignoring unauthenticated or malformed ack");
    return;
  }
  const pending = pendingMkRelayRequests.get(ack?.requestId);
  if (!pending) return;
  pendingMkRelayRequests.delete(ack.requestId);
  pending.resolve(normalizeAck(ack));
}

/**
 * Single socket entry: dispatches both directions.
 * @param {object} payload - Socket payload.
 * @param {string|null} senderId - Socket sender id.
 */
async function relaySocketHandler(payload, senderId) {
  if (!payload || typeof payload !== "object" || payload.scope !== SYSTEM_ID) return;
  if (payload.action === MK_RELAY_REQUEST_ACTION) {
    await processMkRelayRequest(payload, senderId);
    return;
  }
  if (payload.action === MK_RELAY_ACK_ACTION) {
    handleMkRelayAck(payload, senderId);
  }
}

/**
 * Register the relay on this client. Runs on EVERY client: players need the
 * ack listener to settle their requests; only GM clients process requests.
 * Wired from sw25.mjs (`Hooks.once("ready", initializeMonsterKnowledgeRelay)`)
 * and directly callable in tests.
 * @returns {void}
 */
export function initializeMonsterKnowledgeRelay() {
  if (typeof game?.socket?.on === "function") {
    game.socket.on(MK_RELAY_SOCKET, relaySocketHandler);
    console.log("[SW25 MK Relay] socket listener registered");
  }
  // Event-driven lifecycle: a targeted GM disappearing settles its pending
  // requests with an explicit failure (no queues, no timed retries).
  if (typeof Hooks !== "undefined" && Hooks && typeof Hooks.on === "function") {
    Hooks.on("updateUser", user => {
      if (user?.isGM && user?.active === false) {
        expirePendingMkRelayRequests("gm-offline", user.id ?? user._id ?? null);
      }
    });
    Hooks.on("deleteUser", user => {
      if (user?.isGM) expirePendingMkRelayRequests("gm-offline", user.id ?? user._id ?? null);
    });
  }
}

