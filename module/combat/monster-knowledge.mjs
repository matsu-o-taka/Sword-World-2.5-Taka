import { isCriticalFailure, criticalFailureHTML, markCriticalFailure, rollDiceResults } from "../rules/critical-failure.mjs";
import { assembleRollFormula, openRollModifiersDialog } from "../rules/roll-modifiers.mjs";
import { normalizeSpeciesId, speciesId } from "../knowledge/mk-identity.mjs";
import { isMkSpeciesKnown, registerMkDiscovery, withdrawMkDiscovery } from "../knowledge/monster-knowledge-registry.mjs";
import { requestMkRelayDiscovery, publishMkBestiaryReveal } from "../knowledge/mk-relay.mjs";

const SYSTEM_ID = "sword-world-25";
export const MK_OBSERVER_SOCKET = "system.sword-world-25";

// Re-export the shared species identity (single authoritative module) so the
// pre-F1 consumers of monster-knowledge keep importing from here.
export { normalizeSpeciesId, speciesId } from "../knowledge/mk-identity.mjs";

// Pending observer grant requests keyed by request ID for duplicate detection.
const pendingObserverRequests = new Map();

// Diagnostic prefix for Monster Knowledge observer grant flow.
const LOG_PREFIX = "[SW25 MK Observer]";

// Log pending request state changes for lifecycle visibility.
function logPendingState(requestId, actorUuid, event) {
  const pending = pendingObserverRequests.get(requestId);
  console.log(
    `${LOG_PREFIX} pending-request ${event} requestId=${requestId} actorUuid=${actorUuid} ` +
    `pendingCount=${pendingObserverRequests.size}` +
    (pending ? ` currentGranted=${pending.granted}` : "")
  );
}

// Same escaping helper used by the attack-resolution chat cards.
const esc = value => foundry.utils.escapeHTML(String(value ?? ""));

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const nameKey = value => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// ── Monster Knowledge per-class rules ──────────────────────────────────────
//
// RAW citations (verified against D:\Foundry Assets\Sword-World-Sources\):
//   Sage / Rider — Core Rulebook I pp. 108, 382-383: Monster Knowledge check
//     (standard value = class level + Intelligence modifier); a successful
//     check lets the player read the monster data; only a Sage ever detects
//     Weak Points, and only when the success value is equal to or greater
//     than the monster's Weakness value. Double 6s ("automatic success")
//     also detect the Weak Point for the whole party (Sage only).
//   Dark Hunter — Abyss Breaker p. 28: "Monster Knowledge check (Limited to
//     Daemons) [Intelligence] — Automatically determines whether the
//     encountered monster is classified as a Daemon. A Monster Knowledge
//     check can be performed if it is classified as Daemon. If the Success
//     Value is equal to or greater than Daemon's weakness, the weak point
//     will also be applied." Per user correction, a successful Dark Hunter
//     check also reveals the monster statistics (A Monster Knowledge check
//     is still a Monster Knowledge check, CR I p. 382). Monsters disguising
//     their identity through mimicry or shapeshifting cannot be
//     auto-detected; that ruling stays with the GM (monster data carries no
//     mimicry marks yet).
//   ◯Monster Watch (Dark Hunter perfection) — Abyss Breaker p. 31: the Dark
//     Hunter Monster Knowledge check expands from "Daemon-only" to "Daemons,
//     Barbarous, and Undead"; with Dark Hunter level 5 or higher, against
//     Classification: Daemon the weakness is treated as 4 lower (never below
//     reputation); with level 10 or higher the weak point value is doubled
//     when applying it — weak-point application effects are not implemented
//     in Foundry yet, so the doubling has nothing mechanical to apply to
//     (documented deviation, not coded).
//   Druid / Daemonologist — Monstrous Lore pp. 21 / 41: no native class
//     check; their Monster Knowledge lives in the spells [Nature Master] and
//     [Another's Knowledge]. Selecting either manually adds it to the check
//     with the SAME skill-check formula (class level + Intelligence
//     modifier — no "Nature/Summoning Magic Power"); they are never
//     automatic candidates and never suppress native classes. Per-spell
//     target restrictions: Druid (Nature Master) — Animals and Plants;
//     Daemonologist (Another's Knowledge) — Daemons, whose classification
//     the spell also identifies.
const MK_CLASS_RULES = {
  sage: { stats: true, weakness: true, classifier: false, targets: null },
  rider: { stats: true, weakness: false, classifier: false, targets: null },
  "dark hunter": { stats: true, weakness: true, classifier: true, targets: ["daemon"] },
  druid: { stats: true, weakness: true, classifier: false, targets: ["animal", "plant"], spell: true },
  daemonologist: { stats: true, weakness: true, classifier: true, targets: ["daemon"], spell: true }
};

// ◯Monster Watch (Abyss Breaker p. 31) expands the Dark Hunter valid targets.
const MONSTER_WATCH_TARGETS = ["daemon", "barbarous", "undead"];

// The monster's game classification (system.monsterType: "Daemon",
// "Barbarous", "Undead", "Animal", "Goblinoid", …) as written by the importer.
function monsterClassification(monster) {
  return monster?.system ? nameKey(monster.system.monsterType) : null;
}

function actorHasMonsterWatch(actor) {
  const items = actor?.items;
  if (!items) return false;
  const list = typeof items.filter === "function"
    ? items.filter(item => item)
    : [...items.values()];
  return list.some(item => nameKey(item?.name) === "monster watch");
}

// Whether an MK class entry is valid against the target's classification.
// Unrestricted classes (Sage, Rider) are valid against any target. Restricted
// classes (Dark Hunter) are only valid inside their allowed classifications.
function mkClassEligible({ className, monsterWatch = false }, classification) {
  const rules = MK_CLASS_RULES[className];
  if (!rules) return false;
  if (!rules.targets) return true;
  if (!classification) return false;
  let allowed = rules.targets;
  if (monsterWatch && className === "dark hunter") allowed = MONSTER_WATCH_TARGETS;
  return allowed.includes(classification);
}

// ── Species identification ────────────────────────────────────────────────

// The species identity implementation lives in module/knowledge/mk-identity.mjs
// (single authoritative module since F1) and is re-exported above.

// ── Weakness knowledge bridge (F1 → F2 → F2-T3) ────────────────────────────
//
// Since F1 the Monster Knowledge Registry (module/knowledge/) is the ONLY
// persistent knowledge store and every write is GM-authoritative. This bridge
// keeps the pre-F1 function names working as read-only adapters over the
// registry service:
//   - Reads consult the registry service only (`isMkSpeciesKnown`). The
//     pre-F1 `weaknessRegistry` world setting and its fallback were retired
//     in F2-T3: no knowledge is read from, or written to, that legacy source.
//   - Writes act only on the registry service. There is NO code path that
//     persists knowledge outside the registry, and no code path that
//     persists it from a player client.

export function speciesWeaknessKnown(monster) {
  if (!monster || !monster.system) return false;
  const id = speciesId(monster);
  if (!id) return false;
  return isMkSpeciesKnown(id);
}

export function isSpeciesWeaknessKnown(speciesIdentifier) {
  const id = normalizeSpeciesId(speciesIdentifier);
  if (!id) return false;
  return isMkSpeciesKnown(id);
}

// ── Monster weakness discovery (GM authority since F1) ────────────────────
//
// The former manual reveal path available to Actor owners is retired
// (approved decision): discoveries persist ONLY through the GM-authoritative
// registry service, so no player client can write knowledge. A player Monster
// Knowledge roll still DISCOVERS (the chat card shows it); persisting player
// discoveries arrives in F2 through the GM relay.

export async function revealMonsterWeakness(monster, { notify = true } = {}) {
  if (!monster || monster.type !== "monster") return { status: "invalid-actor" };
  if (!game.user.isGM) return { status: "denied" };
  const id = speciesId(monster);
  if (!id) return { status: "no-species" };
  const result = await registerMkDiscovery({
    speciesId: id,
    speciesLabel: monster.system?.species ?? id,
    monsterUuid: monster.uuid ?? null,
    monsterName: monster.name ?? null,
    actorUuid: game.user?.character?.id ?? null,
    actorName: game.user?.character?.name ?? null,
    source: "gm-manual",
    level: "weakness",
    discoveredBy: game.user?.id ?? null
  });
  if (!result.ok) {
    if (notify) {
      ui.notifications.error(`The Weakness of species ${id} could not be registered in the Monster Knowledge Registry.`);
    }
    return { status: "error", code: result.code };
  }
  // Discovering the Weak Point does NOT reveal the statistics automatically:
  // those depend on the Reputation threshold of the Monster Knowledge roll.
  if (notify) {
    if (result.data.status === "already-known") {
      ui.notifications.info(`Weakness already known for species ${id}.`);
    } else {
      ui.notifications.info(`Weakness registered for species ${id}.`);
    }
  }
  return { status: "revealed" };
}

export async function toggleMonsterWeakness(monster, { notify = true } = {}) {
  if (!monster || monster.type !== "monster") return { status: "invalid-actor" };
  if (!game.user.isGM) return { status: "denied" };
  const id = speciesId(monster);
  if (!id) return { status: "no-species" };
  const known = isSpeciesWeaknessKnown(id);
  let result;
  if (known) {
    // Withdrawing the Weak Point knowledge does not hide the statistics.
    result = await withdrawMkDiscovery({ speciesIdentifier: id });
  } else {
    // Registering a Weak Point does NOT reveal the Actor statistics:
    // those depend on the Reputation threshold of the Monster Knowledge roll.
    result = await registerMkDiscovery({
      speciesId: id,
      speciesLabel: monster.system?.species ?? id,
      monsterUuid: monster.uuid ?? null,
      monsterName: monster.name ?? null,
      actorUuid: game.user?.character?.id ?? null,
      actorName: game.user?.character?.name ?? null,
      source: "gm-manual",
      level: "weakness",
      discoveredBy: game.user?.id ?? null
    });
  }
  if (!result.ok) {
    if (notify) ui.notifications.error(`The Weakness of species ${id} could not be updated in the Monster Knowledge Registry.`);
    return { status: "error", code: result.code };
  }
  if (notify) {
    if (known) ui.notifications.info(`Weakness withdrawn for ${id}.`);
    else if (result.data.status === "already-known") ui.notifications.info(`Weakness already known for ${id}.`);
    else ui.notifications.info(`Weakness registered for ${id}.`);
  }
  return { status: known ? "withdrawn" : "registered" };
}

/**
 * Persist a Monster Knowledge discovery that originates from a Monster
 * Knowledge roll, with the full evidence (species, class, individual result,
 * user, roll origin). Rolls resolve on every client, but persistence is
 * GM-authoritative:
 *   - On the GM client the discovery is written directly to the registry.
 *   - On a player client the evidence is transported through the GM relay
 *     (module/knowledge/mk-relay.mjs); the connected GM validates and
 *     persists it, keeping `discoveredBy` as the player who rolled. Without
 *     a connected GM the relay fails fast with an explicit informative
 *     notice: no local write, no pending request, no deferred work.
 * Both knowledge levels ("reputation" and "weakness") share this path so a
 * player Reputation discovery persists exactly like a Weakness one.
 *
 * The KEY reveal notice is NOT published here: the caller
 * (`resolveMkRollSection`) publishes exactly ONE reveal per monster per roll
 * for the highest level reached (`publishMkBestiaryReveal`), so a roll
 * crossing both thresholds sends a single whisper.
 *
 * @param {object} monster - The target monster Actor document.
 * @param {object} entry - The class outcome that crossed the threshold.
 * @param {string|null} [entry.actorUuid] - UUID of the Actor character that made the roll.
 * @param {string|null} [entry.actorName] - Name of the Actor character that made the roll.
 * @param {"reputation"|"weakness"} [level] - Knowledge level (defaults to "weakness").
 * @param {object} [options]
 * @param {boolean} [options.suppressRevealNotice] - Suppress the requester's
 *   per-request reveal whisper (the caller publishes one per roll).
 * @returns {Promise<{ok: boolean, data?: object, code?: string, error?: string}>}
 */
async function persistMkDiscovery(monster, entry, level = "weakness", { suppressRevealNotice = false } = {}) {
  const id = speciesId(monster);
  if (!id) return { ok: false, code: "no-species", error: "A discovery requires a monster species identifier." };
  const evidence = {
    speciesId: id,
    speciesLabel: monster.system?.species ?? id,
    monsterUuid: monster.uuid ?? null,
    monsterName: monster.name ?? null,
    actorUuid: entry?.actorUuid ?? null,
    actorName: entry?.actorName ?? null,
    className: typeof entry?.className === "string" && entry.className ? entry.className : null,
    classResult: Number.isFinite(Number(entry?.result)) ? Number(entry.result) : null,
    source: "roll",
    level,
    discoveredBy: game.user?.id ?? null
  };
  if (game?.user?.isGM) {
    const result = await registerMkDiscovery(evidence);
    if (!result.ok) {
      ui?.notifications?.error?.(`The discovery of species ${id} could not be registered in the Monster Knowledge Registry.`);
    } else if (result.data?.bestiaryCopyFailed) {
      // Copy failures are action-relevant (players never get the actor link)
      // and must be visibly escalated to the GM, never silent.
      ui?.notifications?.warn?.(`Monster Knowledge Bestiary copy failed for species ${id}: ${result.data.bestiaryCopyFailed}`);
    }
    return result;
  }
  return requestMkRelayDiscovery(evidence, { publishRevealNotice: !suppressRevealNotice });
}

// ── Native ownership permission for monster visibility ────────────────────

// A Monster Knowledge target may be the synthetic Actor view of a scene token
// (uuid pattern Scene.x.Token.y.Actor.z, e.g. unlinked monster tokens). The
// synthetic view's ownership reflects the token's actor delta, which is
// transient per-token data: Foundry gates sheet viewing on the base Actor's
// ownership, and an ownership update on the synthetic view only writes the
// delta, never granting real access. All permission checks and grants must
// therefore run against the persistent base Actor document.
const TOKEN_ACTOR_UUID_PATTERN = /^Scene\.[^.]+\.Token\.[^.]+\.Actor\.([^.]+)$/;

/**
 * Resolve a token-scoped synthetic Actor to its base Actor document.
 * Non-token uuids (e.g. Actor.xyz) are returned unchanged. If the base Actor
 * cannot be found in the actor collection, the original document is returned
 * so callers keep working with the synthetic view.
 * @param {object} actor - Any resolved Actor-like document.
 * @returns {object|null} The base Actor document (or the input when it is not token-scoped).
 */
function resolveBaseActorDocument(actor) {
  const uuid = actor?.uuid;
  if (typeof uuid !== "string") return actor ?? null;
  const match = TOKEN_ACTOR_UUID_PATTERN.exec(uuid);
  if (!match) return actor ?? null;
  const baseId = match[1];
  const collection = game.actors;
  const base = collection?.get?.(baseId)
    ?? (Array.isArray(collection)
      ? collection.find(entry => entry?.id === baseId || entry?.uuid === `Actor.${baseId}`) ?? null
      : null);
  if (base) {
    console.log(`${LOG_PREFIX} resolveBaseActorDocument token-scoped actorUuid=${uuid} baseActorId=${baseId} baseActorUuid=${base.uuid}`);
    return base;
  }
  console.log(`${LOG_PREFIX} resolveBaseActorDocument token-scoped actorUuid=${uuid} baseActorId=${baseId} not found, keeping synthetic document`);
  return actor;
}

/**
 * Grant OBSERVER ownership to a monster actor so players can view its sheet.
 * Only the default ownership level is changed; explicit per-user entries are
 * preserved. A level already at OBSERVER or higher is never downgraded.
 * Token-scoped synthetic actors are resolved to their base Actor document so
 * the ownership update persists where Foundry checks viewing permission.
 * @param {object} actor - The monster Actor document.
 * @returns {Promise<void>}
 */
export async function grantMonsterObserver(actor, targetUser) {
  actor = resolveBaseActorDocument(actor);
  console.log(`${LOG_PREFIX} grantMonsterObserver called actorUuid=${actor?.uuid ?? "null"} ` +
    `actorName=${actor?.name ?? "null"} actorType=${actor?.type ?? "null"} targetUserId=${targetUser?.id ?? targetUser}`);
  if (!actor || actor.type !== "monster") {
    console.log(`${LOG_PREFIX} grantMonsterObserver rejected: invalid actor type ${actor?.type ?? "null"}`);
    return;
  }
  if (!game.user.isGM) {
    console.log(`${LOG_PREFIX} grantMonsterObserver rejected: current user is not GM`);
    return;
  }
  const observerLevel = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  const currentOwnership = actor.ownership ?? {};
  console.log(`${LOG_PREFIX} grantMonsterObserver actorUuid=${actor.uuid} currentOwnership=`, currentOwnership, `targetUserId=${targetUser?.id ?? targetUser}`);
  // Already observable or higher for target user: do not change.
  if (targetUser) {
    if (await actor.testUserPermission(targetUser, "OBSERVER")) {
      console.log(`${LOG_PREFIX} grantMonsterObserver skipped: target user ${targetUser.id} already has OBSERVER or higher`);
      return;
    }
  } else {
    const currentDefault = currentOwnership.default;
    if (currentDefault !== undefined && currentDefault >= observerLevel) {
      console.log(`${LOG_PREFIX} grantMonsterObserver skipped: currentDefault ${currentDefault} >= observerLevel ${observerLevel}`);
      return;
    }
  }
  // Build complete ownership object preserving existing per-user entries.
  const targetUserId = targetUser?.id ?? 'default';
  const nextOwnership = { ...currentOwnership, [targetUserId]: observerLevel };
  console.log(`${LOG_PREFIX} grantMonsterObserver submitting update actorUuid=${actor.uuid} nextOwnership=`, nextOwnership);
  try {
    await actor.update({ ownership: nextOwnership });
    console.log(`${LOG_PREFIX} grantMonsterObserver update succeeded actorUuid=${actor.uuid} targetUserId=${targetUserId} ownership=`, nextOwnership);
  } catch (error) {
    console.error(`${LOG_PREFIX} grantMonsterObserver update FAILED actorUuid=${actor.uuid}`, error);
    throw error;
  }
}

/**
 * Request an OBSERVER grant for a monster actor.
 *
 * @deprecated Fase 4: the Monster Knowledge flow no longer requests Observer
 *   permission on the original monster Actors. Player visibility is provided
 *   exclusively by the independent Bestiary copies (CONSt default OBSERVER).
 *   This function is kept only for backwards compatibility (it has no callers
 *   left in the Monster Knowledge roll or Manager flows) and for the legacy
 *   socket handler test suite.
 *
 * GM users already hold implicit OWNER authority over Actors, so no grant is
 * attempted and no socket request is emitted for them: Monster Knowledge
 * discoveries made by the GM resolve without touching ownership. When the
 * current user is a player, the effective permission check runs first and a
 * validated socket request is sent to the connected GM client which performs
 * the ownership update with GM authority.
 *
 * @param {object} actor - The monster Actor document.
 * @returns {Promise<{granted: boolean, reason: string}>}
 */
export async function requestMonsterObserver(actor) {
  // Token-scoped synthetic actors are resolved to the base Actor document:
  // the effective permission check must not be fooled by the token's actor
  // delta, and the socket request must carry a base Actor uuid the GM client
  // can grant against.
  actor = resolveBaseActorDocument(actor);
  console.log(`${LOG_PREFIX} requestMonsterObserver called actorUuid=${actor?.uuid ?? "null"} ` +
    `actorName=${actor?.name ?? "null"} actorType=${actor?.type ?? "null"} isGM=${game.user.isGM}`);
  if (!actor || actor.type !== "monster") {
    console.log(`${LOG_PREFIX} requestMonsterObserver rejected: invalid actor type ${actor?.type ?? "null"}`);
    return { granted: false, reason: "invalid-actor" };
  }
  // GM users never need an OBSERVER grant (they already have full access),
  // so Monster Knowledge rolls resolve without granting anything.
  if (game.user.isGM) {
    console.log(`${LOG_PREFIX} requestMonsterObserver: current user is GM, no Observer grant attempted actorUuid=${actor.uuid}`);
    return { granted: false, reason: "gm-no-grant" };
  }
  if (await actor.testUserPermission(game.user, "OBSERVER")) {
    console.log(`${LOG_PREFIX} requestMonsterObserver rejected: already observable for user ${game.user.id}`);
    return { granted: false, reason: "already-observable" };
  }

  // Non-GM: request the GM client to perform the grant.
  console.log(`${LOG_PREFIX} requestMonsterObserver: current user is non-GM, checking for active GM`);
  const gms = game.users?.filter(u => u.active && u.isGM) ?? [];
  if (!gms.length) {
    ui.notifications.warn("No active Game Master is available to grant OBSERVER permission.");
    console.log(`${LOG_PREFIX} requestMonsterObserver rejected: no active GM`);
    return { granted: false, reason: "no-gm" };
  }
  console.log(`${LOG_PREFIX} requestMonsterObserver: active GM found, preparing socket request`);

  const requestId = foundry.utils.randomID();
  const payload = {
    action: "mk-grant-observer",
    actorUuid: actor?.uuid,
    actorName: actor?.name,
    gid: gms[0]._id,
    requestId
  };
  console.log(`${LOG_PREFIX} requestMonsterObserver: emitting socket requestId=${requestId} actorUuid=${actor.uuid} gid=${gms[0]._id} channel=${MK_OBSERVER_SOCKET}`);

  // Track the pending request so the GM response can be matched and duplicates
  // ignored.
  pendingObserverRequests.set(requestId, { actorUuid: actor?.uuid, actorName: actor?.name, granted: false });
  logPendingState(requestId, actor.uuid, "added");

  try {
    await game.socket.emit(MK_OBSERVER_SOCKET, payload);
    console.log(`${LOG_PREFIX} requestMonsterObserver: socket emission succeeded requestId=${requestId}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  } catch (error) {
    console.error(`${LOG_PREFIX} requestMonsterObserver: socket emission FAILED requestId=${requestId}`, error);
    pendingObserverRequests.delete(requestId);
    logPendingState(requestId, actor.uuid, "removed");
    return { granted: false, reason: "request-failed" };
  }

  const pending = pendingObserverRequests.get(requestId);
  const granted = Boolean(pending?.granted);
  pendingObserverRequests.delete(requestId);
  logPendingState(requestId, actor.uuid, "removed");
  if (granted) return { granted: true, reason: "granted" };
  return { granted: false, reason: "not-granted" };
}

// ── Socket handler: GM processes observer grant requests from players ───────

export function initializeMonsterKnowledgeObserver() {
  console.log(`${LOG_PREFIX} initializeMonsterKnowledgeObserver called isGM=${game.user.isGM}`);
  if (typeof game.socket?.on !== "function") {
    console.error(`${LOG_PREFIX} initializeMonsterKnowledgeObserver: game.socket.on is not available`);
    return;
  }
  game.socket.on(MK_OBSERVER_SOCKET, async (payload, senderId) => {
    // The shared system channel also carries unrelated traffic (relay
    // requests/acks, damage application, ...). Leave SILENTLY before any GM
    // check so this handler neither intercepts nor logs noise for payloads
    // owned by their own listeners: players receive relay acks on this
    // channel and are not GMs, but those acuses must flow untouched.
    if (!payload || payload.action !== "mk-grant-observer") {
      return;
    }
    console.log(`${LOG_PREFIX} socket event received channel=${MK_OBSERVER_SOCKET} senderId=${senderId} ` +
      `isGM=${game.user.isGM} payload=`, payload);
    if (!game.user.isGM) {
      console.log(`${LOG_PREFIX} socket handler rejected: current user is not GM`);
      return;
    }

    const { actorUuid, requestId } = payload;
    if (!actorUuid || !requestId) {
      console.log(`${LOG_PREFIX} socket handler rejected: missing fields actorUuid=${actorUuid} requestId=${requestId}`);
      return ui.notifications.warn("Invalid MK observer request: missing fields.");
    }

    // Only the intended GM processes this request, matching Terminal's pattern.
    const gm = game.user.isGM && game.user.id === payload.gid;
    if (!gm) {
      console.log(`${LOG_PREFIX} socket handler rejected: not the intended GM gid=${payload.gid} selfId=${game.user.id}`);
      return;
    }

    console.log(`${LOG_PREFIX} socket handler validating requestId=${requestId} actorUuid=${actorUuid} gid=${payload.gid}`);
    if (pendingObserverRequests.has(requestId) && pendingObserverRequests.get(requestId)?.granted) {
      console.log(`${LOG_PREFIX} socket handler rejected: duplicate already-granted requestId=${requestId}`);
      return;
    }

    const sender = game.users.get(senderId);
    if (!sender || sender.active === false || sender.isGM) {
      console.log(`${LOG_PREFIX} socket handler rejected: sender is invalid, inactive, or GM senderId=${senderId}`);
      return;
    }

    // Token-scoped synthetic actors (Scene.x.Token.y.Actor.z) resolve to the
    // base Actor document so the grant persists in real ownership, not in the
    // token's transient actor delta.
    const actor = resolveBaseActorDocument(await fromUuid(actorUuid));
    if (!actor) {
      console.log(`${LOG_PREFIX} socket handler rejected: actor not found actorUuid=${actorUuid}`);
      return ui.notifications.warn("MK observer request: actor not found.");
    }
    if (actor.type !== "monster") {
      console.log(`${LOG_PREFIX} socket handler rejected: actor is not a monster actorType=${actor.type} actorUuid=${actorUuid}`);
      return ui.notifications.warn("MK observer request: target is not a monster.");
    }

    console.log(`${LOG_PREFIX} socket handler: all validations passed, calling grantMonsterObserver actorUuid=${actor.uuid} targetUserId=${sender.id}`);
    try {
      await grantMonsterObserver(actor, sender);
      pendingObserverRequests.set(requestId, { actorUuid: actor?.uuid, actorName: actor?.name, granted: true });
      logPendingState(requestId, actor.uuid, "granted");
      ui.notifications.info(`OBSERVER granted for monster ${actor.name} (requested by ${sender.name}).`);
    } catch (error) {
      console.error(`${LOG_PREFIX} GM could not grant MK observer actorUuid=${actor.uuid}`, error);
      pendingObserverRequests.set(requestId, { actorUuid: actor?.uuid, actorName: actor?.name, granted: false });
      logPendingState(requestId, actor.uuid, "failed");
      ui.notifications.error("Failed to grant OBSERVER to monster.");
    }
  });
  console.log(`${LOG_PREFIX} socket listener registered channel=${MK_OBSERVER_SOCKET}`);
}

if (typeof Hooks !== "undefined") {
  console.log(`${LOG_PREFIX} registering Hooks.once("ready", initializeMonsterKnowledgeObserver)`);
  Hooks.once("ready", initializeMonsterKnowledgeObserver);
} else {
  console.log(`${LOG_PREFIX} Hooks not available (test environment), observer socket handler not registered`);
}

// ── Monster Knowledge roll card ─────────────────────────────────────────────
//
// Local copy of attackCardHtml (combat/attack-resolution.mjs), adjusted for
// Monster Knowledge: it publishes through roll.toMessage() exactly like the
// attack rolls (one single chat message per roll; Foundry renders the real
// dice result below the card). The card is shared by all evaluated classes:
// it shows the main prominent result (the class achieving the highest
// applicable effect), the outcome verdict and every individual class result
// (dice + class level + Intelligence modifier). No level/attribute/modifier
// breakdown: modifiers are applied internally but are never displayed.

// Verdict line shown on the card: Success/Partial success/Fail and what was
// learned (Weakness revealed / Statistics revealed / You don't have useful
// info). Critical failure has no comparison value: it is always a fail.
function mkVerdict(discoveries, criticalFailure) {
  if (criticalFailure) return { css: "fail", label: "Fail — You don't have useful info" };
  if (Array.isArray(discoveries) && discoveries.some(d => d.type === "weakness")) {
    return { css: "success", label: "Success — Weakness revealed" };
  }
  if (Array.isArray(discoveries) && discoveries.some(d => d.type === "stats")) {
    return { css: "partial", label: "Partial success — Statistics revealed" };
  }
  if (Array.isArray(discoveries) && discoveries.some(d => d.type === "classification")) {
    return { css: "partial", label: "Partial success — Classification identified" };
  }
  return { css: "fail", label: "You have no information about this monster." };
}

function rollMKHtml({
  title, actorName, natural, total, criticalFailure,
  targetName = null, verdict = null, warning = null,
  mainResult = null, classResultsDisplay = []
} = {}) {
  const targetHeading = targetName ? ` on ${esc(targetName)}` : "";
  // Main prominent result: the class achieving the highest applicable effect
  // (largest, centered). Below it, every evaluated class with its individual
  // result (dice + class level + Intelligence modifier) stays visible.
  const mainHtml = mainResult
    ? `<div class="sw25-mk-total">
         <span class="sw25-mk-total-value">${esc(String(mainResult.result))}</span>
         <span class="sw25-mk-total-label">${esc(mainResult.label)}</span>
       </div>`
    : "";
  // Aviso cuando la clase elegida manualmente no puede resolver el target.
  const warningHtml = warning
    ? `<p class="sw25-mk-warning"><strong>${esc(warning)}</strong></p>`
    : "";
  const listHtml = Array.isArray(classResultsDisplay) && classResultsDisplay.length
    ? `<ul class="sw25-mk-class-results">${classResultsDisplay.map(entry => `
        <li class="sw25-mk-class-result">
          <span class="sw25-mk-class-label">${esc(entry.label)}</span>
          <span class="sw25-mk-class-value">${esc(String(entry.result))}</span>
        </li>`).join("")}</ul>`
    : "";
  const verdictHtml = verdict
    ? `<p class="sw25-mk-verdict sw25-mk-${esc(verdict.css)}"><strong>${esc(verdict.label)}</strong></p>`
    : "";
  return `
    <div class="sw25-chat-card sw25-mk-roll-card">
      <h3>${esc(title)} — ${esc(actorName)}${targetHeading}</h3>
      ${criticalFailure ? criticalFailureHTML() : ""}
      ${mainHtml}
      ${warningHtml}
      ${verdictHtml}
      ${listHtml}
    </div>`;
}

export async function resolveMonsterKnowledgeResult({
  actor, targetMonster, rollTotal, natural, classResults, intBonus, fixedBonus, criticalFailure,
  automaticSuccess = false, usedClasses = null
} = {}) {
  // ── Con monstruo objetivo: comparar contra Reputation y Weakness ─────────
  const monster = targetMonster;
  const weakness = finiteNumber(monster.system.weakness);
  const reputation = finiteNumber(monster.system.reputation);
  const classification = monsterClassification(monster);

  const lines = [];
  const discoveries = [];

  // ── Evaluate class capabilities ───────────────────────────────────────
  // The single roll is evaluated against EVERY applicable Monster Knowledge
  // class: all eligible natives (Sage, Rider, Dark Hunter) plus a manually
  // selected spell class (Druid/Daemonologist, Monstrous Lore pp. 21/41).
  // The evaluated set is recorded at roll time (usedClasses/individualResults
  // with each class's individual result). Legacy chat messages fall back to
  // the entries recorded in classResults (result ?? successValue ?? rollTotal).
  let entries = Array.isArray(usedClasses) && usedClasses.length
    ? usedClasses
    : (Array.isArray(classResults) ? classResults : []).filter(entry => Boolean(MK_CLASS_RULES[nameKey(entry.className)]));
  entries = entries
    .map(entry => ({
      className: nameKey(entry.className),
      label: entry.label ?? String(entry.className ?? ""),
      level: Number(entry.level ?? 0),
      monsterWatch: entry.monsterWatch !== undefined ? Boolean(entry.monsterWatch) : actorHasMonsterWatch(actor),
      result: Number(entry.result ?? entry.successValue ?? rollTotal ?? 0)
    }))
    .filter(entry => Boolean(MK_CLASS_RULES[entry.className]) && mkClassEligible(entry, classification));

  const rulesOf = entry => MK_CLASS_RULES[entry.className];
  // Independent per-class resolution: each evaluated class gets credit for
  // every effect its own individual result reaches (midRef: effects may be
  // class-specific even when another class has a higher overall result).
  const outcomes = entries.map(entry => ({ ...entry, effects: [] }));

  // Reveal-once state for this monster: the roll publishes exactly ONE
  // Bestiary reveal whisper for the highest level reached, AFTER both
  // persistence calls (a roll crossing BOTH the reputation and the weakness
  // thresholds must not send two whisper messages).
  const reveal = { speciesId: speciesId(monster), bestiaryActorUuid: null };

  // ── Compare against thresholds ────────────────────────────────────────
  // Statistics first: Reputation threshold, or automatic success (double 6s
  // is a complete success of the check — CR I p. 382). Every stats-capable
  // class that reaches the threshold is credited (Sage, Rider, Dark Hunter).
  const statsHits = outcomes.filter(entry => rulesOf(entry).stats &&
    (automaticSuccess || (reputation !== null && entry.result >= reputation)));
  for (const hit of statsHits) hit.effects.push("stats");
  if (statsHits.length) {
    const statsEntry = statsHits[0];
    // Reputation discovery is persisted through the same GM-authoritative
    // path as the Weakness discovery (direct write on the GM client, GM relay
    // for players). Legacy Behaviour retired: NO Observer permission is
    // granted on the original monster Actor — visibility for players is
    // provided exclusively by the Bestiary copies (Fase 4 model).
    const statsPersist = await persistMkDiscovery(monster, {
      ...statsEntry,
      actorUuid: actor?.uuid,
      actorName: actor?.name
    }, "reputation", { suppressRevealNotice: true });
    if (statsPersist?.ok && statsPersist.data?.bestiaryActorUuid) {
      reveal.bestiaryActorUuid = statsPersist.data.bestiaryActorUuid;
    }
    discoveries.push({
      type: "stats",
      monster,
      className: statsEntry.className,
      classLabel: statsEntry.label
    });
    lines.push(`<li>${esc(monster.name)}: Statistics revealed.</li>`);
  }

  // Classification identification: automatic (no threshold) for the first
  // applicable classifier class — Dark Hunter (Abyss Breaker p. 28) or the
  // manually selected Daemonologist ([Another's Knowledge], ML p. 41).
  // Disguise by mimicry or shapeshifting cannot be auto-detected — that
  // ruling stays with the GM (monster data carries no mimicry marks yet).
  const classifierEntry = outcomes.find(entry => rulesOf(entry).classifier);
  if (classifierEntry && classification && !criticalFailure) {
    for (const hit of outcomes) {
      if (rulesOf(hit).classifier) hit.effects.push("classification");
    }
    discoveries.push({
      type: "classification",
      classification,
      monster,
      className: classifierEntry.className,
      classLabel: classifierEntry.label
    });
    lines.push(`<li>${esc(monster.name)}: Classification identified (${esc(String(monster.system.monsterType).trim())}).</li>`);
  }

  // Weakness: every weakness-capable class is checked with its own threshold
  // against its own individual result; any hit discovers and applies it.
  // Sage and Dark Hunter share the capability (plus Druid/Daemonologist
  // through their spells — no Weakness Exploit modeled); Sage alone gets it
  // on automatic success (CR I p. 383). ◯Monster Watch (Abyss Breaker p. 31):
  // Dark Hunter level 5+ against Daemons treats the weakness as 4 lower,
  // never below reputation.
  let weaknessEntry = null;
  if (weakness !== null) {
    for (const outcome of outcomes) {
      const rules = rulesOf(outcome);
      if (!rules.weakness) continue;
      let threshold = weakness;
      if (outcome.className === "dark hunter" && outcome.monsterWatch && outcome.level >= 5 && classification === "daemon") {
        threshold = reputation === null ? weakness - 4 : Math.max(reputation, weakness - 4);
      }
      if (outcome.result >= threshold || (outcome.className === "sage" && automaticSuccess)) {
        outcome.effects.push("weakness");
        if (!weaknessEntry || outcome.result > weaknessEntry.result) weaknessEntry = outcome;
      }
    }
  }
    if (weaknessEntry) {
    const weaknessPersist = await persistMkDiscovery(monster, {
      ...weaknessEntry,
      actorUuid: actor?.uuid,
      actorName: actor?.name
    }, "weakness", { suppressRevealNotice: true });
    if (weaknessPersist?.ok && weaknessPersist.data?.bestiaryActorUuid) {
      reveal.bestiaryActorUuid = weaknessPersist.data.bestiaryActorUuid;
    }
    discoveries.push({
      type: "weakness",
      monster,
      className: weaknessEntry.className,
      classLabel: weaknessEntry.label
    });
    lines.push(`<li>${esc(monster.name)}: Weakness discovered.</li>`);
  }

  // One reveal per monster per roll: the copy exists at (or was promoted to)
  // the highest level reached, and EVERY active player receives the whisper
  // (Monster Knowledge is table-wide visibility, not a per-roller grant).
  if (reveal.bestiaryActorUuid) {
    await publishMkBestiaryReveal({
      speciesId: reveal.speciesId,
      bestiaryActorUuid: reveal.bestiaryActorUuid
    });
  }

  if (criticalFailure) {
    lines.push(`<li>${esc(monster.name)}: Critical failure — no information gained.</li>`);
  }

  if (!lines.length) {
    lines.push(`<li>${esc(monster.name)}: No information discovered.</li>`);
  }

  // ── Main prominent result ─────────────────────────────────────────────
  // The class achieving the highest applicable effect. Tiers: weakness (3) >
  // stats (2) > classification (1); among classes reaching the same tier,
  // the higher individual result. Lower results are never discarded: every
  // evaluated class keeps its individual result (entryOutcomes below).
  const effectTier = { weakness: 3, stats: 2, classification: 1 };
  const credited = outcomes.filter(outcome => outcome.effects.length);
  let mainEntry = null;
  if (credited.length) {
    const topTier = Math.max(...credited.map(outcome =>
      Math.max(...outcome.effects.map(effect => effectTier[effect]))));
    mainEntry = credited
      .filter(outcome => Math.max(...outcome.effects.map(effect => effectTier[effect])) === topTier)
      .sort((a, b) => b.result - a.result)[0];
  }
  if (!mainEntry) {
    // No effect reached (e.g. below every threshold): the highest individual
    // result stays prominent.
    mainEntry = entries.slice().sort((a, b) => b.result - a.result)[0] ?? null;
  }

  return {
    status: "resolved",
    monster,
    discoveries,
    rollTotal,
    criticalFailure,
    entryOutcomes: outcomes.map(outcome => ({
      className: outcome.className,
      label: outcome.label,
      level: outcome.level,
      result: outcome.result,
      effects: outcome.effects
    })),
    mainResult: mainEntry
      ? { className: mainEntry.className, label: mainEntry.label, result: mainEntry.result }
      : null,
    lines
  };
}

export async function resolveMonsterKnowledgeMessage(message) {
  if (!game.user.isGM) return;
  const result = message.getFlag(SYSTEM_ID, "monsterKnowledge");
  if (!result || !Array.isArray(result.targetTokenUuids)) return;
  const roll = message.rolls?.[0];
  const successValue = finiteNumber(roll?.total);
  if (successValue === null || successValue !== finiteNumber(result.successValue)) {
    throw new Error("The Monster Knowledge result does not match the roll recorded on its chat message.");
  }
  const criticalFailure = isCriticalFailure(roll);
  const lines = [];
  for (const uuid of [...new Set(result.targetTokenUuids)]) {
    const token = await fromUuid(uuid);
    if (!token?.actor) continue;

    if (token.actor.type === "monster") {
      const resolution = await resolveMonsterKnowledgeResult({
        actor: message.speaker?.actor ?? null,
        targetMonster: token.actor,
        rollTotal: successValue,
        natural: result.natural,
        classResults: result.classResults,
        intBonus: result.intBonus,
        fixedBonus: result.fixedBonus,
        criticalFailure,
        automaticSuccess: Boolean(result.automaticSuccess),
        usedClasses: Array.isArray(result.usedClasses) && result.usedClasses.length
          ? result.usedClasses
          : (result.usedClass ? [result.usedClass] : null)
      });
      if (resolution.status === "resolved") {
        lines.push(...resolution.discoveries.map(d => {
          if (d.type === "weakness") return `<li>${esc(d.monster.name)}: Weakness discovered.</li>`;
          if (d.type === "classification") return `<li>${esc(d.monster.name)}: Classification identified (${esc(String(d.monster.system.monsterType).trim())}).</li>`;
          return `<li>${esc(d.monster.name)}: Statistics revealed.</li>`;
        }));
      }
    }
  }
  if (!lines.length) {
    ui.notifications.info("No eligible monster was selected for this Monster Knowledge Check.");
    lines.push(`<li>No information discovered.</li>`);
  }
  await ChatMessage.create({
    content: `<div class="sw25-chat-card sw25-mk-result-card"><h3>Monster Knowledge — Resolution</h3><ul>${lines.join("")}</ul></div>`
  });
}

// ── Monster Knowledge: Roller selection ─────────────────────────────────────

/**
 * Resolve which character makes a Monster Knowledge roll on behalf of the
 * user. Priority:
 *   1. Exactly ONE selected (controlled) character token on the canvas.
 *   2. Exactly ONE targeted character token.
 *   3. The user's assigned character (game.user.character).
 *
 * @returns {{ actor: object, source: string } |
 *           { status: "ambiguous" } |
 *           { status: "no-character" }}
 */
export function findMonsterKnowledgeRoller() {
  const selectedCharacters = (canvas?.tokens?.controlled ?? [])
    .map(token => token?.actor ?? token?.document?.actor ?? null)
    .filter(actor => actor?.type === "character");
  if (selectedCharacters.length === 1) {
    return { actor: selectedCharacters[0], source: "selected-token" };
  }

  const targetedCharacters = [...(game?.user?.targets ?? [])]
    .map(token => token?.actor ?? token?.document?.actor ?? null)
    .filter(actor => actor?.type === "character");
  if (targetedCharacters.length === 1) {
    return { actor: targetedCharacters[0], source: "targeted-token" };
  }

  if (selectedCharacters.length > 1 || targetedCharacters.length > 1) {
    return { status: "ambiguous" };
  }

  const assigned = game?.user?.character ?? null;
  if (assigned && assigned.type === "character") {
    return { actor: assigned, source: "assigned-character" };
  }

  return { status: "no-character" };
}

// ── Monster Knowledge: Roll flow ────────────────────────────────────────────

function mkClassResults(actor, roll, savedClassId) {
  const items = actor.items;
  const classes = items
    ? typeof items.filter === "function"
      ? items.filter(item => item.type === "class")
      : [...items.values()].filter(item => item.type === "class")
    : [];
  const total = roll === null ? null : Number(roll.total);

  return classes.map(cls => {
    const className = String(cls.name ?? "").toLowerCase();
    return {
      className,
      classId: String(cls.id),
      level: Number(cls.system?.level ?? 0),
      canRevealWeakness: className === "sage",
      successValue: total
    };
  });
}

// Determine the evaluated Monster Knowledge classes and which class shapes
// the single roll. Class selection, roll calculation and effect resolution
// are independent responsibilities:
//   - EVALUATED set (usedClasses): every eligible NATIVE MK class the actor
//     owns (Sage, Rider, Dark Hunter) plus the manually selected spell class
//     (Druid/Daemonologist, Monstrous Lore pp. 21/41) when it is eligible for
//     the target. Manual native selection never removes a native class; it
//     only shapes which class level is displayed/seeded (formulaClass).
//   - Target restrictions are enforced at roll time: refuse only when the
//     actor owns native MK classes, NONE of them is eligible AND no eligible
//     spell class was manually selected (e.g. Dark Hunter alone against a
//     Barbarous without ◯Monster Watch, Abyss Breaker p. 28).
//   - FORMULA class: the manually selected class (any MK class, including
//     spell classes) when owned and eligible, otherwise the highest-level
//     ELIGIBLE native. Druid and Daemonologist are never automatic
//     candidates: picking one manually is what adds it to the evaluation.
//   - Resolution never reduces to the formula class: every evaluated class
//     contributes its own capabilities with its own individual result.
function resolveMkUsedClasses(actor, targetMonster, savedClassId) {
  const all = mkClassResults(actor, null, "");
  const watch = actorHasMonsterWatch(actor);
  const labelOf = entry => String(actor.items.get?.(entry.classId)?.name ?? entry.className);
  const toEntry = entry => ({
    classId: entry.classId,
    className: entry.className,
    label: labelOf(entry),
    level: Number(entry.level ?? 0),
    monsterWatch: watch
  });
  const nativeClasses = all
    .filter(entry => { const rules = MK_CLASS_RULES[entry.className]; return Boolean(rules) && !rules.spell; })
    .map(toEntry);
  // Spell classes (Druid/Daemonologist): evaluable only through manual
  // selection — their Monster Knowledge comes from their spells
  // (Monstrous Lore pp. 21/41), never from class association.
  const spellClasses = all
    .filter(entry => Boolean(MK_CLASS_RULES[entry.className]?.spell))
    .map(toEntry);

  const classification = targetMonster ? monsterClassification(targetMonster) : null;
  const eligibleNatives = nativeClasses
    .filter(entry => mkClassEligible(entry, classification))
    .sort((a, b) => b.level - a.level);
  const savedEntry = savedClassId ? all.find(entry => String(entry.classId) === String(savedClassId)) : null;
  const manualEligible = savedEntry ? Boolean(mkClassEligible({ className: nameKey(savedEntry.className), monsterWatch: watch }, classification)) : false;
  const manualClass = savedEntry ? {
    classId: savedEntry.classId,
    className: nameKey(savedEntry.className),
    label: labelOf(savedEntry),
    level: Number(savedEntry.level ?? 0),
    monsterWatch: watch
  } : null;

  const eligibleSpell = savedClassId
    ? spellClasses.find(entry => String(entry.classId) === String(savedClassId)
      && mkClassEligible(entry, classification)) ?? null
    : null;

  if (nativeClasses.length && !eligibleNatives.length && !eligibleSpell) {
    if (manualClass) {
      // El usuario eligió manualmente una clase que no puede resolver este
      // target (p.ej. Dark Hunter contra un Barbarous sin ◯Monster Watch).
      // Se publica una tarjeta con el resultado de esa clase y un aviso, sin
      // aplicar efectos de clase; no se cancela en silencio.
      return { status: "resolved", usedClasses: [], formulaClass: manualClass, manualClass, manualEligible: false, manualIneligible: true, classification };
    }
    return { status: "unauthorized-target", usedClasses: [], formulaClass: null, classification };
  }

  const usedClasses = eligibleSpell ? [...eligibleNatives, eligibleSpell] : eligibleNatives;

  // La clase seleccionada manualmente siempre forma la fórmula (su nivel se
  // muestra en el diálogo y como resultado principal de la tarjeta), aunque
  // no sea elegible para el target: en ese caso se muestra con un aviso.
  let formulaClass = manualClass ?? null;
  if (!formulaClass) formulaClass = eligibleNatives[0] ?? null;

  return { status: "resolved", usedClasses, formulaClass, manualClass, manualEligible, classification };
}

export async function rollMonsterKnowledge({
  actor, targetMonster,
  diceFormula = "2d6",
  shiftKey = false
} = {}) {
  if (!actor || actor.type !== "character") return { status: "invalid-actor" };

  // Rolls of Monster Knowledge need a connected Game Master: the discovery
  // persistence is GM-authoritative (F2-T1). Without a GM the roll does not
  // happen at all — an informative notice is shown, nothing is rolled, and
  // no pending request or deferred work is created.
  if (!game?.user?.isGM && !game?.users?.activeGM) {
    ui?.notifications?.warn?.("Monster Knowledge requires a connected Game Master. Ask your GM to connect first.");
    return { status: "no-gm", phases: { dialog: false, roll: false } };
  }

  // Determine applicable native classes and enforce per-class target
  // restrictions before any dice are rolled (Abyss Breaker p. 28: Dark
  // Hunter is Daemon-only; ◯Monster Watch, p. 31, expands it to Daemons,
  // Barbarous and Undead). The refusal only triggers when no applicable
  // native class can resolve the check.
  const classResolution = resolveMkUsedClasses(actor, targetMonster ?? null, actor.system?.combat?.monsterKnowledgeClassId || "");
  if (classResolution.status === "unauthorized-target") {
    ui.notifications.warn("Dark Hunter Monster Knowledge is limited to Daemon targets. The ◯Monster Watch weave expands it to Daemons, Barbarous and Undead.");
    return { status: "unauthorized-target", phases: { dialog: false, roll: false } };
  }
  const evaluatedClasses = classResolution.usedClasses;
  const displayClass = classResolution.formulaClass;
  const manualClass = classResolution.manualClass;
  const manualIneligible = Boolean(classResolution.manualIneligible);

  // Intelligence bonus: mind ability base / 6
  const mindBase = Number(actor.system?.abilityBases?.mind ?? 0);
  const mindAdj = actor.system?.abilityAdjustments?.e ?? {};
  const mindScore = mindBase + Number(mindAdj.growth ?? 0) + Number(mindAdj.correction ?? 0) + Number(mindAdj.temporary ?? 0);
  const intBonus = Math.floor(mindScore / 6);

  const fixedBonus = Number(actor.system?.combat?.monsterKnowledgeBonus ?? 0);

  // Seed parts: one class-level part per evaluated class (its `Class level +
  // Intelligence modifier` formula, identical for all five classes) plus the
  // shared parts. Shift+click lets the user adjust or disable any part (same
  // mechanism as the attack-resolution flows).
  const classParts = evaluatedClasses.map(entry => ({
    label: `${entry.label} level`,
    value: entry.level,
    enabled: true,
    temporary: false
  }));
  const sharedSeed = [
    { label: "Intelligence", value: intBonus, enabled: true, temporary: false },
    { label: "Bonus fijo", value: fixedBonus, enabled: true, temporary: false }
  ];
  let modifiers = [...classParts, ...sharedSeed];
  if (shiftKey) {
    const result = await openRollModifiersDialog({
      title: "Monster Knowledge — Modifiers",
      diceFormula,
      submitLabel: "Roll Monster Knowledge",
      parts: modifiers
    });
    if (!result) return { status: "cancelled", phases: { dialog: true, roll: false } };
    modifiers = result;
  }

  // A SINGLE shared dice roll, dice only: no fixed total is baked into the
  // formula. Every class's individual result is derived from the same dice,
  // its own class-level dialog part (+0 when the user disables it) and the
  // shared adjustment (Intelligence + fixed bonus + temporary user parts;
  // class-level parts are excluded from the shared adjustment).
  const formula = assembleRollFormula(diceFormula, 0);

  // Roll dice
  let roll;
  try {
    roll = await new Roll(formula).evaluate();
  } catch (error) {
    console.error("Sword World 2.5 | Monster Knowledge roll failed", error);
    return { status: "error", error: error.message };
  }

  const dice = rollDiceResults(roll).reduce((sum, value) => sum + Number(value || 0), 0);
  const natural = dice;

  // Per-class individual results from the one shared roll.
  const classPartLabels = new Set(classParts.map(part => part.label));
  const sharedAdjustment = modifiers.reduce((sum, part) => {
    if (part.enabled === false) return sum;
    if (classPartLabels.has(part.label)) return sum;
    return sum + Number(part.value ?? 0);
  }, 0);
  const individualResults = evaluatedClasses.map(entry => {
    const part = modifiers.find(candidate => candidate.label === `${entry.label} level` && candidate.enabled !== false);
    return {
      className: entry.className,
      label: entry.label,
      classId: entry.classId,
      level: entry.level,
      monsterWatch: Boolean(entry.monsterWatch),
      result: dice + (part ? Number(part.value ?? 0) : 0) + sharedAdjustment
    };
  });

  // Resultado individual de la clase seleccionada manualmente (se muestra
  // como principal aunque no sea elegible para el target). No tiene parte de
  // nivel en el diálogo porque no está entre las clases evaluadas; se calcula
  // con su propio nivel + el ajuste compartido.
  const manualResult = manualClass
    ? {
        className: manualClass.className,
        label: manualClass.label,
        classId: manualClass.classId,
        level: manualClass.level,
        monsterWatch: Boolean(manualClass.monsterWatch),
        result: dice + manualClass.level + sharedAdjustment
      }
    : null;

  // Automatic success: double 6s on 2d6 (CR I — the natural success rule).
  // Double 1s (critical failure) cannot co-occur with 12 on 2d6.
  const automaticSuccess = natural === 12;

  const criticalFailure = await markCriticalFailure(actor, roll);

  const targetTokenUuids = targetMonster ? [targetMonster.uuid] : [];
  const classResults = mkClassResults(actor, roll, "");
  // Evaluated classes with their individual results from the single roll.
  // individualResults is the canonical flag; usedClasses keeps the same
  // array under the legacy field name for older consumers.
  const usedClassFlags = individualResults.map(entry => ({
    className: entry.className,
    label: entry.label,
    level: entry.level,
    monsterWatch: entry.monsterWatch,
    result: entry.result
  }));

  // Chat flags shared by both branches (GM compatibility path + tests).
  const mkFlags = {
    "sword-world-25": {
      monsterKnowledge: {
        successValue: Number(roll.total),
        natural,
        intBonus,
        fixedBonus,
        criticalFailure,
        automaticSuccess,
        targetTokenUuids,
        classResults,
        usedClasses: usedClassFlags,
        individualResults: usedClassFlags,
        sharedAdjustment,
        displayClass: displayClass
          ? { className: displayClass.className, label: displayClass.label, level: displayClass.level }
          : null
      }
    }
  };

  let discoveries = [];
  let verdict = null;
  let mainResult = null;

  if (targetMonster) {
    // Resolve the result immediately against the target monster: EVERY
    // evaluated class's individual result is checked independently.
    const resolution = await resolveMonsterKnowledgeResult({
      actor,
      targetMonster,
      rollTotal: Number(roll.total),
      natural,
      classResults,
      intBonus,
      fixedBonus,
      criticalFailure,
      automaticSuccess,
      usedClasses: usedClassFlags
    });
    discoveries = resolution.discoveries;
    verdict = mkVerdict(discoveries, criticalFailure);
    mainResult = resolution.mainResult;
  }

  // Main prominent result: si hay clase seleccionada manualmente, es la
  // principal (su resultado individual, con aviso si no es elegible para el
  // target); si no, el de la resolución por efectos o el mayor individual.
  if (manualResult) {
    mainResult = manualResult;
  } else if (!mainResult) {
    mainResult = individualResults.slice().sort((a, b) => b.result - a.result)[0] ?? null;
  }

  // Aviso cuando la clase elegida manualmente no puede resolver el target
  // (p.ej. Dark Hunter contra un Barbarous sin Monster Watch).
  let warningHtml = "";
  if (manualClass && manualIneligible && targetMonster) {
    warningHtml = `<p class="sw25-mk-warning"><strong>${esc(manualClass.label)}:</strong> ${esc(String(manualClass.label))} está limitado a objetivos ${String(MK_CLASS_RULES[manualClass.className]?.targets?.join(", ") ?? "")} — esta tirada no revela información sobre este tipo de monstruo (${esc(String(targetMonster.system.monsterType ?? "")).toLowerCase()}).</p>`;
  }

  // Single message per roll, like the attack-resolution flows: Foundry shows
  // the real dice result and the card adds the main per-class result, the
  // outcome verdict and every individual class result.
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: rollMKHtml({
      title: "Monster Knowledge",
      actorName: actor?.name,
      natural,
      total: Number(roll.total),
      criticalFailure,
      targetName: targetMonster ? targetMonster.name : null,
      verdict,
      warning: manualClass && manualIneligible && targetMonster
        ? `${esc(String(manualClass.label))} está limitado a ${String(MK_CLASS_RULES[manualClass.className]?.targets?.join(", ") ?? "")} — esta tirada no revela información sobre este tipo de monstruo (${esc(String(targetMonster.system.monsterType ?? "")).toLowerCase()}).`
        : null,
      mainResult: mainResult ? { label: mainResult.label, result: mainResult.result } : null,
      classResultsDisplay: individualResults.map(entry => ({ label: entry.label, result: entry.result }))
    }),
    flags: mkFlags
  });

  return {
    status: "resolved",
    rollTotal: Number(roll.total),
    rollNatural: natural,
    criticalFailure,
    automaticSuccess,
    targetMonster,
    usedClasses: evaluatedClasses,
    formulaClass: displayClass,
    manualClass,
    manualIneligible,
    individualResults,
    classResults,
    mainResult,
    discoveries
  };
}




