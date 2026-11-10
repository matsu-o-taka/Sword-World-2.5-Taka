// Sword World 2.5 - Monster Knowledge Registry service (model + operations).
//
// The registry records which monster species' Weak Points are known by the
// current play session (sessions model, intentionally ephemeral) or by a
// durable named group/archive (campaigns model). Monsters later reflect that
// knowledge through derived state (F2).
//
// Core rules implemented here:
//   - The registry is GM-authoritative: every write goes through the store's
//     serialized commit, which refuses non-GM clients ("not-gm"). Player
//     discovery relay arrives in F2; the roll flow already persists GM rolls.
//   - Two independent models share one record shape and one engine:
//       sessions  - exactly one active, replaced on start (no history)
//       campaigns - several named records, activatable and deletable
//   - Persist rules are CAPABILITIES of the model, never scattered checks:
//       individualWithdraw (always true in the baseline),
//       restart / deleteRecord / replaceOnStart / autoCreate (per model).
//     Future official campaign models can forbid reset while keeping
//     individual withdraw without touching this service.
//   - A discovery stores EVIDENCE (speciesId, class, result, user, origin),
//     never a copy of the monster's Weak Point text.
//   - Discoveries deduplicate by speciesId inside each record.
//   - Any registration without an active record falls back to a fresh
//     session (auto-create, functional decision D5).
//
// API contract: every structured operation returns
//   { ok: true, data } or { ok: false, code, error }
// Expected failures are structured; unexpected ones also stay structured
// ("mutation-failed" / "persist-failed") so callers never break. The only
// synchronous accessor is `isSpeciesKnown(identifier)` (read-only bridge).

import { normalizeSpeciesId } from "./mk-identity.mjs";
import {
  commitRegistry,
  generateMkId,
  readRegistryState,
  sessionDefaultCapabilities,
  campaignDefaultCapabilities,
  snapshotRegistry,
  MK_REGISTRY_VERSION,
  SYSTEM_ID
} from "./monster-knowledge-store.mjs";

// ── Foundry runtime guard ───────────────────────────────────────────────────
// Folder operations require Foundry's Folder API and game.folders collection,
// which are unavailable in headless test environments. When absent, folder
// functions return success with mock data so Registry operations continue to
// work without Foundry runtime.
function _foldersAvailable() {
  return Boolean(typeof Folder !== "undefined" && game?.folders);
}

// ── Actor document access helpers ───────────────────────────────────────────

// Bestiary copies must be built from the persistent base Actor when the
// discovery carries a token-scoped synthetic uuid ("Scene.x.Token.y.Actor.z",
// e.g. unlinked monster tokens): the synthetic view is transient per-token
// data, while the base Actor survives the token leaving the scene.
const TOKEN_ACTOR_UUID_PATTERN = /^Scene\.[^.]+\.Token\.[^.]+\.Actor\.([^.]+)$/;

/**
 * Create a persisted (world-level) Actor document in the v14 compatible way.
 *
 * Foundry v14 exposes the canonical creation route as the Document static
 * (`Actor.create`, which routes to `this.implementation.createDocuments` and
 * persists through the database backend — the same route `Folder.create`
 * uses). The collection-level method `game.actors.create` may not exist on
 * every v14 runtime, so it is only a late fallback (mock harnesses).
 * @param {object} copyData - The copy document data.
 * @returns {Promise<object>} The created Actor document.
 */
async function createMkActorDocument(copyData) {
  if (typeof Actor !== "undefined" && typeof Actor?.create === "function") {
    return Actor.create(copyData);
  }
  if (typeof game?.actors?.create === "function") {
    return game.actors.create(copyData);
  }
  throw new Error("No Actor creation API is available (checked Actor.create and game.actors.create).");
}

/**
 * Resolve a monster uuid to an Actor document, preferring the persistent base
 * Actor for token-scoped synthetic uuids. Falls back to `fromUuid` (which
 * resolves the synthetic token-actor view) when the collection lookup fails.
 * @param {string} uuid - Actor or token-scoped Actor uuid.
 * @returns {Promise<object|null>} The resolved Actor document (or null).
 */
async function resolveMkMonsterActor(uuid) {
  if (typeof uuid !== "string" || !uuid) return null;
  const collection = game?.actors;
  let actor = collection?.get?.(uuid) ?? collection?.get?.(uuid.split(".").pop()) ?? null;
  if (!actor) {
    const match = TOKEN_ACTOR_UUID_PATTERN.exec(uuid);
    if (match) {
      const baseId = match[1];
      actor = collection?.get?.(baseId) ?? collection?.get?.(`Actor.${baseId}`) ?? null;
    }
  }
  if (!actor && typeof fromUuid === "function") {
    try { actor = await fromUuid(uuid); } catch { actor = null; }
  }
  return actor ?? null;
}

// â”€â”€ Model policies and capabilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Baseline model policies by record kind. `generic` campaigns are the only
 * campaign policy in this phase; official campaign models will register
 * additional policies or travel inline via record.policy without changing
 * this file.
 */
export const MK_MODEL_POLICIES = {
  session: {
    name: "session-generic",
    capabilities: sessionDefaultCapabilities()
  },
  campaign: {
    name: "generic",
    capabilities: campaignDefaultCapabilities()
  }
};

/**
 * Resolve the effective capabilities of a record: the record's own policy
 * overrides the baseline of its kind. Consumers (UI in F3) must query this
 * instead of hard-coding model rules.
 * @param {object|null} record - A hydrated record (or null).
 * @returns {object} The effective capability map (plain object).
 */
export function mkCapabilitiesOf(record) {
  const baseline = record?.kind === "session"
    ? MK_MODEL_POLICIES.session.capabilities
    : MK_MODEL_POLICIES.campaign.capabilities;
  const override = record?.policy?.capabilities;
  if (override && typeof override === "object") return { ...baseline, ...override };
  return { ...baseline };
}

function allowsCapability(record, capability) {
  return mkCapabilitiesOf(record)?.[capability] === true;
}

// â”€â”€ Record and discovery factories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function defaultSessionName(createdAt) {
  const date = new Date(createdAt);
  const timestamp = Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 19).replace("T", " ")
    : new Date().toISOString().slice(0, 19).replace("T", " ");
  return `Session ${timestamp}`;
}

/**
 * Create a session record in schema v2. Sessions carry the explicit
 * createdAt required by the "most recent wins" integrity rule.
 * @param {string|null} [name] - Visible session name (optional).
 * @param {number} [createdAt] - Explicit creation epoch (defaults to now).
 * @returns {object} The new session record.
 */
export function createSessionRecord(name, createdAt = Date.now()) {
  return {
    id: generateMkId("mks"),
    kind: "session",
    name: typeof name === "string" && name.trim() ? name.trim() : defaultSessionName(createdAt),
    createdAt: Number(createdAt) || Date.now(),
    updatedAt: Number(createdAt) || Date.now(),
    status: "active",
    policy: {
      name: MK_MODEL_POLICIES.session.name,
      capabilities: snapshotRegistry(MK_MODEL_POLICIES.session.capabilities)
    },
    discoveries: []
  };
}

/**
 * Create a campaign record in schema v2. Campaigns are born archived:
 * activating one is an explicit GM step (functional decision D6).
 * @param {string} name - Visible campaign name.
 * @param {number} [createdAt] - Explicit creation epoch (defaults to now).
 * @returns {object} The new campaign record.
 */
export function createCampaignRecord(name, createdAt = Date.now()) {
  return {
    id: generateMkId("mkc"),
    kind: "campaign",
    name: String(name ?? "").trim(),
    createdAt: Number(createdAt) || Date.now(),
    updatedAt: Number(createdAt) || Date.now(),
    status: "archived",
    policy: {
      name: MK_MODEL_POLICIES.campaign.name,
      capabilities: snapshotRegistry(MK_MODEL_POLICIES.campaign.capabilities)
    },
    discoveries: []
  };
}

// â”€â”€ Internal lookup helpers (operate on hydrated/private copies) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function findRecord(registry, recordId) {
  if (!recordId) return null;
  for (const key of ["sessions", "campaigns"]) {
    for (const record of registry[key]) {
      if (record && typeof record === "object" && record.id === recordId) return record;
    }
  }
  return null;
}

function validActiveRecord(registry) {
  const kind = registry.active?.kind;
  const id = registry.active?.id;
  if (kind !== "session" && kind !== "campaign") return null;
  if (!id) return null;
  return findRecord(registry, id);
}

// Result shape helpers for structured reads/writes.
const ok = data => ({ ok: true, data });

// â”€â”€ Read operations (no GM authority required; read-only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Read the full registry snapshot plus its integrity issues.
 * @returns {{ok: true, data: {registry: object, issues: Array, futureVersion: boolean}}}
 */
export function readMkRegistry() {
  const state = readRegistryState();
  return ok({
    registry: snapshotRegistry(state.registry),
    issues: snapshotRegistry(state.issues),
    futureVersion: state.futureVersion
  });
}

/**
 * Read the record currently pointed at by the active pointer (any model).
 * @returns {{ok: true, data: {kind: string|null, id: string|null, record: object|null}}}
 */
export function readMkActiveRecord() {
  const state = readRegistryState();
  const record = validActiveRecord(state.registry);
  return ok({
    kind: state.registry.active?.kind ?? null,
    id: state.registry.active?.id ?? null,
    record: record ? snapshotRegistry(record) : null
  });
}

/**
 * Read the active session record (sessions model), or null.
 * @returns {{ok: true, data: object|null}}
 */
export function readMkSession() {
  const state = readRegistryState();
  if (state.registry.active?.kind !== "session") return ok(null);
  return ok(state.registry.active.id ? snapshotRegistry(findRecord(state.registry, state.registry.active.id)) : null);
}

/**
 * Read every session record (normally a single pointed one; extras are
 * inert corruption leftovers reported by the integrity diagnosis).
 * @returns {{ok: true, data: Array<object>}}
 */
export function readMkSessions() {
  const state = readRegistryState();
  return ok(state.registry.sessions.map(record => snapshotRegistry(record)));
}

/**
 * Read every campaign record with its discovery count.
 * @returns {{ok: true, data: Array<object>}}
 */
export function readMkCampaigns() {
  const state = readRegistryState();
  const campaigns = state.registry.campaigns
    .filter(record => record && typeof record === "object")
    .map(record => ({
      ...snapshotRegistry(record),
      discoveriesCount: Array.isArray(record.discoveries) ? record.discoveries.length : 0
    }));
  return ok(campaigns);
}

/**
 * Read the discoveries of the active record (or of a specific record id).
 * @param {string|null} [recordId] - Optional record id; defaults to active.
 * @returns {{ok: true, data: Array<object>} | {ok: false, code: string, error: string}}
 */
export function readMkDiscoveries(recordId = null) {
  const state = readRegistryState();
  let record = null;
  if (recordId) {
    record = findRecord(state.registry, recordId);
    if (!record) return { ok: false, code: "record-not-found", error: "No registry record matches that id." };
  } else if (state.registry.active?.id) {
    record = findRecord(state.registry, state.registry.active.id);
  }
  return ok(record ? snapshotRegistry(record.discoveries ?? []) : []);
}

/**
 * Synchronous species lookup against the active record. Kept boolean (not
 * the {ok,...} contract) because the monster-sheet indicator and the roll
 * flow need a cheap, always-available read on any client.
 * @param {string} speciesIdentifier - Raw or normalized species id.
 * @returns {boolean} Whether the species' Weak Point is known in the active record.
 */
export function isMkSpeciesKnown(speciesIdentifier) {
  const id = normalizeSpeciesId(speciesIdentifier);
  if (!id) return false;
  return getMkSpeciesLevel(id) === "weakness";
}

/**
 * Synchronous reputation lookup against the active record. Returns true when
 * the species is known at reputation level or higher (weakness implies
 * reputation).
 * @param {string} speciesIdentifier - Raw or normalized species id.
 * @returns {boolean} Whether the species is known at reputation level or above.
 */
export function isMkSpeciesReputationKnown(speciesIdentifier) {
  const id = normalizeSpeciesId(speciesIdentifier);
  if (!id) return false;
  return getMkSpeciesLevel(id) !== null;
}

// â”€â”€ GM-authoritative write operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Register a knowledge discovery in the record the registry points at
 * (or a specific record). Registrations without an active record create a
 * fresh session first (auto-create, D5). Discoveries deduplicate by
 * speciesId within each record.
 *
 * Knowledge has two levels: "reputation" (species identified, statistics
 * revealed) and "weakness" (Weak Point discovered). Weakness implies
 * Reputation: registering "weakness" for a species already known as
 * "reputation" promotes it; registering "reputation" for a species already
 * known as "weakness" is a no-op.
 *
 * @param {object} evidence - Discovery evidence.
 * @param {string} evidence.speciesId - Raw or normalized species id (required).
 * @param {string|null} [evidence.speciesLabel] - Display species text.
 * @param {string|null} [evidence.monsterUuid] - Actor UUID of the evidence monster.
 * @param {string|null} [evidence.monsterName] - Display monster name.
 * @param {string|null} [evidence.actorUuid] - UUID of the Actor character that made the discovery.
 * @param {string|null} [evidence.actorName] - Name of the Actor character that made the discovery.
 * @param {string|null} [evidence.className] - Knowledge class that crossed the threshold.
 * @param {number|null} [evidence.classResult] - Individual class result.
 * @param {string|null} [evidence.discoveredBy] - Originating user id (defaults to current user).
 * @param {number} [evidence.discoveredAt] - Discovery epoch (defaults to now).
 * @param {"roll"|"gm-manual"} [evidence.source] - Discovery origin.
 * @param {"reputation"|"weakness"} [evidence.level] - Knowledge level (defaults to "reputation").
 * @param {object} [options] - Options.
 * @param {string|null} [options.recordId] - Optional explicit record target.
 * @returns {Promise<{ok: true, data: {status: "registered"|"already-known"|"promoted", speciesId, recordId, discoveryId, bestiaryActorUuid: string|null, bestiaryCopyFailed?: string}} | {ok: false, code: string, error: string}>}
 */
export async function registerMkDiscovery(evidence, options = {}) {
  const species = normalizeSpeciesId(evidence?.speciesId ?? evidence?.speciesIdentifier);
  if (!species) {
    return { ok: false, code: "no-species", error: "A discovery requires a monster species identifier." };
  }
  const requestedRecordId = options?.recordId ?? null;
  const level = evidence?.level === "weakness" ? "weakness" : "reputation";
  return commitRegistry(registry => {
    let record = null;
    let createdSession = null;
    if (requestedRecordId) {
      record = findRecord(registry, requestedRecordId);
      if (!record) {
        return { ok: false, code: "record-not-found", error: "No registry record matches that id." };
      }
    } else {
      record = validActiveRecord(registry);
      if (!record) {
        // D5: a valid MK operation always finds a record to land on.
        createdSession = createSessionRecord(null);
        registry.sessions.push(createdSession);
        registry.active = { kind: "session", id: createdSession.id };
        record = createdSession;
      }
    }
    const existingIdx = record.discoveries.findIndex(entry => entry && typeof entry === "object" && entry.speciesId === species);
    const existing = existingIdx >= 0 ? record.discoveries[existingIdx] : null;
    if (existing) {
      // Weakness implies Reputation: promote reputation -> weakness, never
      // demote weakness -> reputation. Same level is idempotent.
      if (level === "weakness" && existing.level === "reputation") {
        existing.level = "weakness";
        existing.speciesLabel = String(evidence?.speciesLabel ?? existing.speciesLabel);
        existing.monsterUuid = evidence?.monsterUuid ?? existing.monsterUuid;
        existing.monsterName = evidence?.monsterName ?? existing.monsterName;
        existing.actorUuid = evidence?.actorUuid ?? existing.actorUuid;
        existing.actorName = evidence?.actorName ?? existing.actorName;
        existing.className = typeof evidence?.className === "string" && evidence.className ? evidence.className : existing.className;
        existing.classResult = Number.isFinite(Number(evidence?.classResult)) ? Number(evidence.classResult) : existing.classResult;
        existing.discoveredBy = evidence?.discoveredBy ?? existing.discoveredBy;
        existing.discoveredAt = Number.isFinite(Number(evidence?.discoveredAt)) ? Number(evidence.discoveredAt) : existing.discoveredAt;
        existing.source = evidence?.source === "roll" ? "roll" : existing.source;
        record.updatedAt = Date.now();
        return ok({
          status: "promoted",
          speciesId: species,
          recordId: record.id,
          discoveryId: existing.id,
          createdRecord: false
        });
      }
      return ok({
        status: "already-known",
        speciesId: species,
        recordId: record.id,
        discoveryId: typeof existing.id === "string" ? existing.id : null,
        createdRecord: false
      });
    }
    const discoveredAt = Number.isFinite(Number(evidence?.discoveredAt))
      ? Number(evidence.discoveredAt)
      : Date.now();
    const discovery = {
      id: generateMkId("mkd"),
      speciesId: species,
      speciesLabel: String(evidence?.speciesLabel ?? evidence?.speciesId ?? species),
      monsterUuid: evidence?.monsterUuid ?? null,
      monsterName: evidence?.monsterName ?? null,
      actorUuid: evidence?.actorUuid ?? null,
      actorName: evidence?.actorName ?? null,
      className: typeof evidence?.className === "string" && evidence.className ? evidence.className : null,
      classResult: Number.isFinite(Number(evidence?.classResult)) ? Number(evidence.classResult) : null,
      discoveredBy: evidence?.discoveredBy ?? game?.user?.id ?? null,
      discoveredAt,
      source: evidence?.source === "roll" ? "roll" : "gm-manual",
      level,
      bestiaryActorUuid: null
    };
    record.discoveries.push(discovery);
    record.updatedAt = Date.now();
    return ok({
      status: "registered",
      speciesId: species,
      recordId: record.id,
      discoveryId: discovery.id,
      createdRecord: Boolean(createdSession)
    });
  }).then(async result => {
    if (!result.ok) return result;
    if (result.data.discoveryId) {
      // Re-read from the store to find the committed discovery.
      const state = readRegistryState();
      const rec = findRecord(state.registry, result.data.recordId);
      const disc = rec && Array.isArray(rec.discoveries)
        ? rec.discoveries.find(d => d && d.id === result.data.discoveryId)
        : null;
      if (disc) {
        // Create a Bestiary copy for a brand-new registration, or for a
        // promoted discovery that still has no copy (e.g. registered before
        // the Bestiary existed or after a folder failure). Already-known
        // records and promoted discoveries that already carry a copy are
        // untouched. The copy is created outside the Registry commit so a
        // folder failure does not roll back knowledge.
        if ((result.data.status === "registered" || result.data.status === "promoted") && disc.monsterUuid && !disc.bestiaryActorUuid) {
          // Pass the owning record's kind explicitly: manual additions may
          // target a record that is NOT the active one, and the copy's
          // folder/idempotency bucket follow the record, not the pointer.
          const copyResult = await createBestiaryActorCopy(disc, result.data.recordId, rec.kind ?? null);
          if (copyResult.ok && copyResult.data?.bestiaryActorUuid) {
            // Stamp the copy UUID onto the discovery via a second commit.
            const stampResult = await commitRegistry(reg => {
              const r = findRecord(reg, result.data.recordId);
              if (!r) return { ok: false, code: "record-not-found", error: "No registry record matches that id." };
              const d = r.discoveries.find(x => x && x.id === result.data.discoveryId);
              if (!d) return { ok: false, code: "discovery-not-found", error: "No discovery matches that id." };
              d.bestiaryActorUuid = copyResult.data.bestiaryActorUuid;
              r.updatedAt = Date.now();
              // `ok(data)` already wraps in the commit envelope; the commit
              // surfaces this as `stampResult.data.bestiaryActorUuid`.
              return ok({ bestiaryActorUuid: d.bestiaryActorUuid });
            });
            if (stampResult.ok && stampResult.data?.bestiaryActorUuid) {
              disc.bestiaryActorUuid = stampResult.data.bestiaryActorUuid;
            } else if (!stampResult.ok) {
              result.data.bestiaryCopyFailed = stampResult.error;
            }
          } else if (!copyResult.ok) {
            // Folder/copy creation failed: knowledge is still registered, but
            // report the issue so the GM can reconcile later.
            result.data.bestiaryCopyFailed = copyResult.error;
          }
        }
        // Surface the copy pointer for EVERY success status so consumers (the
        // relay ack, the reveal notice) can point the player at the copy:
        // freshly stamped copies, or a copy already carried by an
        // already-known / promoted discovery.
        result.data.bestiaryActorUuid = disc.bestiaryActorUuid ?? null;
      }
    }
    return result;
  });
}

/**
 * Find a discovery by id inside the (private) registry snapshot.
 * @param {object} registry - Hydrated registry snapshot.
 * @param {string} discoveryId - Discovery id.
 * @returns {object|null} The discovery object or null.
 */
function recordDiscoveryById(registry, discoveryId) {
  for (const key of ["sessions", "campaigns"]) {
    for (const record of registry[key] ?? []) {
      if (!record || !Array.isArray(record.discoveries)) continue;
      const d = record.discoveries.find(x => x && x.id === discoveryId);
      if (d) return d;
    }
  }
  return null;
}

/**
 * Read the highest knowledge level for a species in the active record.
 * @param {string} speciesIdentifier - Raw or normalized species id.
 * @returns {"reputation"|"weakness"|null} The highest known level, or null.
 */
export function getMkSpeciesLevel(speciesIdentifier) {
  const id = normalizeSpeciesId(speciesIdentifier);
  if (!id) return null;
  const state = readRegistryState();
  const record = validActiveRecord(state.registry);
  if (!record || !Array.isArray(record.discoveries)) return null;
  const entry = record.discoveries.find(entry => entry && typeof entry === "object" && entry.speciesId === id);
  return entry ? entry.level : null;
}

/**
 * Count how many distinct species have at least one discovery across all
 * records (sessions and campaigns). Used to decide whether to revoke GM
 * observer grants when the last knowledge disappears.
 * @returns {number} Number of species with at least one discovery.
 */
export function countSpeciesWithKnowledge() {
  const state = readRegistryState();
  const speciesSeen = new Set();
  for (const key of ["sessions", "campaigns"]) {
    for (const record of state.registry[key] ?? []) {
      if (!record || !Array.isArray(record.discoveries)) continue;
      for (const entry of record.discoveries) {
        if (entry && typeof entry === "object" && entry.speciesId) {
          speciesSeen.add(entry.speciesId);
        }
      }
    }
  }
  return speciesSeen.size;
}

/**
 * Withdraw an individual Weak Point discovery by species. Allowed on every
 * F1 model (capability `individualWithdraw`); GM-authoritative.
 *
 * @param {object} params - Withdrawal parameters.
 * @param {string} params.speciesIdentifier - Raw or normalized species id.
 * @param {string|null} [params.recordId] - Optional explicit record target.
 * @returns {Promise<{ok: true, data: {status: "withdrawn"|"not-found", speciesId, recordId, removed}} | {ok: false, code: string, error: string}>}
 */
export async function withdrawMkDiscovery({ speciesIdentifier, recordId = null } = {}) {
  const species = normalizeSpeciesId(speciesIdentifier);
  if (!species) {
    return { ok: false, code: "no-species", error: "A withdrawal requires a monster species identifier." };
  }
  const result = await commitRegistry(registry => {
    let record = null;
    if (recordId) {
      record = findRecord(registry, recordId);
      if (!record) {
        return { ok: false, code: "record-not-found", error: "No registry record matches that id." };
      }
    } else {
      record = validActiveRecord(registry);
      if (!record) {
        return { ok: false, code: "no-active-record", error: "The registry has no active record to withdraw knowledge from." };
      }
    }
    if (!allowsCapability(record, "individualWithdraw")) {
      return { ok: false, code: "capability-denied", error: "This model does not allow withdrawing individual discoveries." };
    }
    const existingIdx = record.discoveries.findIndex(entry => entry && typeof entry === "object" && entry.speciesId === species);
    if (existingIdx < 0) {
      return ok({ status: "not-found", speciesId: species, recordId: record.id, removed: 0 });
    }
    const existing = record.discoveries[existingIdx];
    // Weakness implies Reputation: withdrawing weakness demotes to reputation
    // instead of removing the knowledge entirely. The Bestiary copy is kept.
    if (existing.level === "weakness") {
      existing.level = "reputation";
      record.updatedAt = Date.now();
      return ok({
        status: "withdrawn",
        speciesId: species,
        recordId: record.id,
        removed: 0,
        demotedTo: "reputation",
        discoveredBy: existing.discoveredBy,
        recordKind: record.kind
      });
    }
    // Withdrawing reputation removes the discovery entirely.
    record.discoveries.splice(existingIdx, 1);
    const removed = 1;
    if (removed) record.updatedAt = Date.now();
    return ok({
      status: "withdrawn",
      speciesId: species,
      recordId: record.id,
      removed,
      discoveredBy: existing.discoveredBy,
      recordKind: record.kind,
      bestiaryActorUuid: existing.bestiaryActorUuid ?? null
    });
  });
  if (!result.ok) return result;
  // When reputation was fully withdrawn (not demoted), delete the Bestiary copy.
  if (result.data.removed > 0 && result.data.bestiaryActorUuid) {
    await deleteBestiaryActorCopy(result.data.bestiaryActorUuid);
  }
  return result;
}

/**
 * Remove one species discovery from a record ENTIRELY, regardless of its
 * knowledge level, together with its Bestiary copy. This is the manager's
 * per-species red X: a GM correction surface for roll/register mistakes,
 * distinct from `withdrawMkDiscovery` (whose weakness case demotes to
 * reputation instead of deleting). Capability-gated (`individualWithdraw`)
 * like every individual entry modification.
 *
 * @param {object} params - Removal parameters.
 * @param {string} params.speciesIdentifier - Raw or normalized species id.
 * @param {string|null} [params.recordId] - Optional explicit record target.
 * @returns {Promise<{ok: true, data: {status: "removed"|"not-found", speciesId, recordId, removed, level}} | {ok: false, code: string, error: string}>}
 */
export async function deleteMkDiscovery({ speciesIdentifier, recordId = null } = {}) {
  const species = normalizeSpeciesId(speciesIdentifier);
  if (!species) {
    return { ok: false, code: "no-species", error: "A removal requires a monster species identifier." };
  }
  const result = await commitRegistry(registry => {
    let record = null;
    if (recordId) {
      record = findRecord(registry, recordId);
      if (!record) {
        return { ok: false, code: "record-not-found", error: "No registry record matches that id." };
      }
    } else {
      record = validActiveRecord(registry);
      if (!record) {
        return { ok: false, code: "no-active-record", error: "The registry has no active record to remove a discovery from." };
      }
    }
    if (!allowsCapability(record, "individualWithdraw")) {
      return { ok: false, code: "capability-denied", error: "This model does not allow removing individual discoveries." };
    }
    const existingIdx = record.discoveries.findIndex(entry => entry && typeof entry === "object" && entry.speciesId === species);
    if (existingIdx < 0) {
      return ok({ status: "not-found", speciesId: species, recordId: record.id, removed: 0, level: null });
    }
    const existing = record.discoveries[existingIdx];
    record.discoveries.splice(existingIdx, 1);
    record.updatedAt = Date.now();
    return ok({
      status: "removed",
      speciesId: species,
      recordId: record.id,
      removed: 1,
      level: existing.level ?? null,
      bestiaryActorUuid: existing.bestiaryActorUuid ?? null
    });
  });
  if (!result.ok) return result;
  // The Bestiary copy of the removed species is deleted with the entry.
  if (result.data.removed > 0 && result.data.bestiaryActorUuid) {
    await deleteBestiaryActorCopy(result.data.bestiaryActorUuid);
  }
  return result;
}

/**
 * Start a new play session. Replaces the session model completely
 * (functional decision D5: no session history): the previous session
 * records and their knowledge are discarded by this explicit GM action,
 * and leftovers from inconsistencies are cleaned with the same stroke.
 * If the active record is a campaign, the pointer switches to the new
 * session without touching campaign data.
 *
 * @param {object} [params] - Parameters.
 * @param {string|null} [params.name] - Optional visible session name.
 * @returns {Promise<{ok: true, data: {sessionId, name, createdAt, replacedKnowledge}} | {ok: false, code: string, error: string}>}
 */
export async function startMkSession({ name = null } = {}) {
  // Capture the old session id before the commit so we can clean up its
  // Bestiary copies after the session is replaced.
  const stateBefore = readRegistryState();
  const oldSessionId = stateBefore.registry.active?.kind === "session"
    ? stateBefore.registry.active.id
    : null;

  const result = await commitRegistry(registry => {
    const current = validActiveRecord(registry);
    if (current && current.kind === "session" && !allowsCapability(current, "replaceOnStart")) {
      return { ok: false, code: "capability-denied", error: "This model does not allow replacing the active session on start." };
    }
    const replacedKnowledge = registry.sessions
      .filter(record => record && typeof record === "object" && Array.isArray(record.discoveries))
      .reduce((sum, record) => sum + record.discoveries.length, 0);
    const session = createSessionRecord(name);
    registry.sessions = [session];
    registry.active = { kind: "session", id: session.id };
    return ok({
      sessionId: session.id,
      name: session.name,
      createdAt: session.createdAt,
      replacedKnowledge
    });
  });
  if (!result.ok) return result;
  // Clean up Bestiary copies belonging to the old session (replaced by D5)
  // BEFORE the folder sync so the cleanup is not skipped when the folder
  // operation fails.
  if (oldSessionId) {
    const copiesCleanup = await deleteBestiaryCopiesForRecord(oldSessionId, "session");
    if (!copiesCleanup.ok) {
      console.error(`[SW25 MK Bestiary] Could not delete copies of replaced session ${oldSessionId}: ${copiesCleanup.error}`);
    }
  }
  // Sync the Current Session folder after the Registry commit succeeds.
  const folderResult = await getOrCreateSessionFolder(result.data.sessionId);
  if (!folderResult.ok) return folderResult;
  return result;
}

/**
 * Create a named campaign record. Campaigns are born archived; activation
 * is a separate explicit step. The campaigns of other groups are untouched.
 *
 * @param {object} params - Parameters.
 * @param {string} params.name - Visible campaign name (required).
 * @returns {Promise<{ok: true, data: {campaignId, name, createdAt}} | {ok: false, code: string, error: string}>}
 */
export async function createMkCampaign({ name } = {}) {
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, code: "missing-name", error: "A campaign requires a visible name." };
  }
  const result = await commitRegistry(registry => {
    const campaign = createCampaignRecord(name);
    registry.campaigns.push(campaign);
    return ok({ campaignId: campaign.id, name: campaign.name, createdAt: campaign.createdAt });
  });
  if (!result.ok) return result;
  // Create the campaign folder after the Registry commit succeeds.
  const folderResult = await getOrCreateCampaignFolder(result.data.campaignId, result.data.name);
  if (!folderResult.ok) return folderResult;
  return result;
}

/**
 * Activate a campaign record: only the active pointer changes; no other
 * campaign and no session record is modified (functional decision D6).
 *
 * @param {string} campaignId - Target campaign record id.
 * @returns {Promise<{ok: true, data: {campaignId}} | {ok: false, code: string, error: string}>}
 */
export async function activateMkCampaign(campaignId) {
  const result = await commitRegistry(registry => {
    const campaign = findRecord(registry, campaignId);
    if (!campaign || campaign.kind !== "campaign") {
      return { ok: false, code: "record-not-found", error: "No campaign matches that id." };
    }
    registry.active = { kind: "campaign", id: campaign.id };
    return ok({ campaignId: campaign.id, name: campaign.name });
  });
  if (!result.ok) return result;
  // Ensure the campaign folder exists after the Registry commit succeeds.
  const folderResult = await getOrCreateCampaignFolder(result.data.campaignId, result.data.name);
  if (!folderResult.ok) return folderResult;
  return result;
}

/**
 * Deactivate the currently active campaign, returning to session mode.
 * The campaign record is preserved intact; only the active pointer is cleared.
 * New discoveries will auto-create a session (D5).
 *
 * @param {string} [campaignId] - Optional explicit campaign record id to deactivate.
 *   Defaults to the currently active campaign if it is a campaign.
 * @returns {Promise<{ok: true, data: {campaignId}} | {ok: false, code: string, error: string}>}
 */
export function deactivateMkCampaign(campaignId = null) {
  return commitRegistry(registry => {
    if (!campaignId) {
      // Deactivate whatever is active if it's a campaign
      if (registry.active && registry.active.kind === "campaign") {
        registry.active = { kind: null, id: null };
        return ok({ campaignId: null });
      }
      return { ok: false, code: "no-active-campaign", error: "No campaign is currently active." };
    }
    const campaign = findRecord(registry, campaignId);
    if (!campaign || campaign.kind !== "campaign") {
      return { ok: false, code: "record-not-found", error: "No campaign matches that id." };
    }
    if (registry.active?.id !== campaign.id || registry.active?.kind !== "campaign") {
      return { ok: false, code: "not-active-campaign", error: "The specified campaign is not active." };
    }
    registry.active = { kind: null, id: null };
    return ok({ campaignId: campaign.id });
  });
}

/**
 * Activate a session record: the active pointer points at it. Exactly ONE
 * record (session or campaign) is active at any time, so activating a
 * session automatically takes the pointer from the previously active
 * campaign or session (the pointer is never left cleared).
 *
 * @param {string} sessionId - Target session record id.
 * @returns {Promise<{ok: true, data: {sessionId}} | {ok: false, code: string, error: string}>}
 */
export async function activateMkSession(sessionId) {
  const result = await commitRegistry(registry => {
    const session = findRecord(registry, sessionId);
    if (!session || session.kind !== "session") {
      return { ok: false, code: "record-not-found", error: "No session matches that id." };
    }
    registry.active = { kind: "session", id: session.id };
    return ok({ sessionId: session.id, name: session.name });
  });
  if (!result.ok) return result;
  // Keep the Current Session folder bound to the activated session.
  const folderResult = await getOrCreateSessionFolder(result.data.sessionId);
  if (!folderResult.ok) return folderResult;
  return result;
}

/**
 * Delete a campaign record and its knowledge. Capability-gated
 * (`deleteRecord`); sessions are never deleted through this operation
 * (a session ends by replacement, not deletion).
 *
 * @param {string} campaignId - Target campaign record id.
 * @returns {Promise<{ok: true, data: {campaignId, removedKnowledge, pointerCleared}} | {ok: false, code: string, error: string}>}
 */
export async function deleteMkCampaign(campaignId) {
  const result = await commitRegistry(registry => {
    const campaign = findRecord(registry, campaignId);
    if (!campaign || campaign.kind !== "campaign") {
      return { ok: false, code: "record-not-found", error: "No campaign matches that id." };
    }
    if (!allowsCapability(campaign, "deleteRecord")) {
      return { ok: false, code: "capability-denied", error: "This model does not allow deleting records." };
    }
    const removedKnowledge = Array.isArray(campaign.discoveries) ? campaign.discoveries.length : 0;
    registry.campaigns = registry.campaigns.filter(record => record !== campaign);
    let pointerCleared = false;
    if (registry.active?.id === campaign.id && registry.active?.kind === "campaign") {
      registry.active = { kind: null, id: null };
      pointerCleared = true;
    }
    return ok({ campaignId: campaign.id, removedKnowledge, pointerCleared });
  });
  if (!result.ok) return result;
  // Delete the managed campaign folder after the Registry commit succeeds.
  const folderResult = await deleteCampaignFolder(result.data.campaignId);
  if (!folderResult.ok) return folderResult;
  // Delete all Bestiary copies belonging to this campaign.
  const copiesResult = await deleteBestiaryCopiesForRecord(result.data.campaignId, "campaign");
  if (!copiesResult.ok) return copiesResult;
  return result;
}

/**
 * Delete any registry record (session or campaign) explicitly, as a GM
 * correction surface for records created by mistake (e.g. stray rolls).
 * This is deliberately NOT gated by the record's deleteRecord capability:
 * it is the manager's red X action, always available to the GM behind an
 * explicit confirmation. The record, all its discoveries and its managed
 * Bestiary copies are removed; the original monster Actors are untouched.
 *
 * @param {string} recordId - Target record id (session or campaign).
 * @returns {Promise<{ok: true, data: {recordId, recordKind, removedKnowledge, pointerCleared}} | {ok: false, code: string, error: string}>}
 */
export async function deleteMkRecord(recordId) {
  const result = await commitRegistry(registry => {
    const record = findRecord(registry, recordId);
    if (!record) {
      return { ok: false, code: "record-not-found", error: "No registry record matches that id." };
    }
    const removedKnowledge = Array.isArray(record.discoveries) ? record.discoveries.length : 0;
    if (record.kind === "campaign") {
      registry.campaigns = registry.campaigns.filter(candidate => candidate !== record);
    } else {
      registry.sessions = registry.sessions.filter(candidate => candidate !== record);
    }
    let pointerCleared = false;
    let repointedTo = null;
    if (registry.active?.id === record.id && registry.active?.kind === record.kind) {
      // Exactly ONE register must always be active ("default: session").
      // After deleting the active record, the most recent remaining session
      // takes the pointer; with no remaining session the pointer is cleared
      // and the next discovery auto-creates one (D5).
      const remaining = registry.sessions
        .filter(candidate => candidate && typeof candidate === "object")
        .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
      const newest = remaining[0] ?? null;
      registry.active = newest ? { kind: "session", id: newest.id } : { kind: null, id: null };
      pointerCleared = true;
      repointedTo = newest?.id ?? null;
    }
    return ok({
      recordId: record.id,
      recordKind: record.kind,
      removedKnowledge,
      pointerCleared,
      repointedTo
    });
  });
  if (!result.ok) return result;
  // Campaign folders belong to the deleted record and go with it; the
  // session folder is the shared singleton "Current Session" folder, kept.
  if (result.data.recordKind === "campaign") {
    const folderResult = await deleteCampaignFolder(result.data.recordId);
    if (!folderResult.ok) return folderResult;
  }
  const copiesResult = await deleteBestiaryCopiesForRecord(result.data.recordId, result.data.recordKind);
  if (!copiesResult.ok) return copiesResult;
  return result;
}

/**
 * Reset the knowledge of a record (default: the active one). Capability-gated
 * (`restart`) so future official campaign models can forbid a general reset
 * while keeping individual withdrawals. Discoveries are cleared; sessions
 * and campaigns keep their records.
 *
 * @param {object} [params] - Parameters.
 * @param {string|null} [params.recordId] - Optional explicit record target.
 * @returns {Promise<{ok: true, data: {status: "reset", recordId, removed}} | {ok: false, code: string, error: string}>}
 */
export async function resetMkKnowledge({ recordId = null } = {}) {
  const result = await commitRegistry(registry => {
    let record = null;
    if (recordId) {
      record = findRecord(registry, recordId);
      if (!record) {
        return { ok: false, code: "record-not-found", error: "No registry record matches that id." };
      }
    } else {
      record = validActiveRecord(registry);
      if (!record) {
        return { ok: false, code: "no-active-record", error: "The registry has no active record to reset." };
      }
    }
    if (!allowsCapability(record, "restart")) {
      return { ok: false, code: "capability-denied", error: "This model does not allow resetting the knowledge." };
    }
    const removed = Array.isArray(record.discoveries) ? record.discoveries.length : 0;
    record.discoveries = [];
    record.updatedAt = Date.now();
    return ok({ status: "reset", recordId: record.id, removed, recordKind: record.kind });
  });
  if (!result.ok) return result;
  // Delete all Bestiary copies for this record after the Registry commit.
  await deleteBestiaryCopiesAfterReset(result.data.recordId, result.data.recordKind);
  return result;
}

/**
 * Delete all Bestiary copies for a record after a reset, outside the commit.
 * @param {string} recordId - The registry record id.
 * @param {string} recordKind - "session" or "campaign".
 * @returns {Promise<void>}
 */
async function deleteBestiaryCopiesAfterReset(recordId, recordKind) {
  const result = await deleteBestiaryCopiesForRecord(recordId, recordKind);
  if (!result.ok) {
    console.error(`[SW25 MK Bestiary] Failed to delete copies after reset of ${recordId}: ${result.error}`);
  }
}

// â”€â”€ Integrity diagnosis and repair â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Run the integrity diagnosis without any write side effect.
 * Result shape mirrors reports/monster-knowledge-registry-architecture.md Â§11.
 * @returns {{ok: true, data: {issues: Array, autoFixed: number, review: number, futureVersion: boolean}}}
 */
export function diagnoseMkRegistry() {
  const state = readRegistryState();
  const issues = snapshotRegistry(state.issues);
  return ok({
    issues,
    autoFixed: issues.filter(issue => issue.severity === "auto-fixed").length,
    review: issues.filter(issue => issue.severity === "review").length,
    futureVersion: state.futureVersion
  });
}

/**
 * Persist the current snapshot in its normalized form. Auto-fixable issues
 * (missing registry, version backfill, orphan pointer, rebuilt lists) are
 * resolved by the regular hydration cycle; ambiguous data (review issues) is
 * KEPT and reported, never removed. GM-authoritative.
 *
 * @returns {Promise<{ok: true, data: {status: "repaired", autoFixed, review}} | {ok: false, code: string, error: string}>}
 */
export function repairMkRegistry() {
  const state = readRegistryState();
  const autoFixed = state.issues.filter(issue => issue.severity === "auto-fixed").length;
  const review = state.issues.filter(issue => issue.severity === "review").length;
  return commitRegistry(registry => ok({
    status: "repaired",
    autoFixed,
    review,
    reviewIssues: snapshotRegistry(state.issues.filter(issue => issue.severity === "review"))
  }));
}

/**
 * Get or create the root "Monster Knowledge Bestiary" folder.
 * @returns {Promise<{ok: true, data: {folderId: string, folderName: string}} | {ok: false, code: string, error: string}>}
 */
export async function getOrCreateMkRegistryFolder() {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can manage the Monster Knowledge Bestiary." };
  }
  if (!_foldersAvailable()) {
    return ok({ folderId: "mock-root", folderName: "Monster Knowledge Bestiary" });
  }
  try {
    let rootFolder = game.folders?.find(f => f.flags?.[SYSTEM_ID]?.mkRegistryRoot === true);
    if (!rootFolder) {
      rootFolder = await Folder.create({
        name: "Monster Knowledge Bestiary",
        type: "Actor",
        flags: { [SYSTEM_ID]: { mkRegistryRoot: true } }
      });
    }
    return ok({ folderId: rootFolder.id, folderName: rootFolder.name });
  } catch (error) {
    return { ok: false, code: "folder-creation-failed", error: String(error?.message ?? error) };
  }
}

export async function getOrCreateSessionFolder(sessionId) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can manage the Monster Knowledge Bestiary." };
  }
  if (!_foldersAvailable()) {
    return ok({ folderId: "mock-session", folderName: "Current Session" });
  }
  try {
    const rootResult = await getOrCreateMkRegistryFolder();
    if (!rootResult.ok) return rootResult;
    // Identify Current Session by a stable flag, not by sessionId. The sessionId
    // is stored in mkSessionId and updated whenever the active session changes.
    const sessionFolders = (game.folders ?? []).filter(f => f.flags?.[SYSTEM_ID]?.mkSessionFolder === true);
    if (sessionFolders.length > 1) {
      return { ok: false, code: "folder-conflict", error: "Multiple 'Current Session' folders found; reconciliation required." };
    }
    let sessionFolder = sessionFolders[0];
    if (!sessionFolder) {
      sessionFolder = await Folder.create({
        name: "Current Session",
        folder: rootResult.data.folderId,
        type: "Actor",
        flags: { [SYSTEM_ID]: { mkSessionFolder: true, mkSessionId: sessionId, mkRegistryRoot: false } }
      });
    } else {
      // Reuse the stable folder and update the associated session id.
      await sessionFolder.setFlag(SYSTEM_ID, "mkSessionId", sessionId);
      // Safe repair: a folder created under a wrong parent (pre-`folder` field
      // data) is moved under the Bestiary root instead of duplicated.
      if (sessionFolder.folder !== rootResult.data.folderId) {
        await sessionFolder.update({ folder: rootResult.data.folderId });
      }
    }
    return ok({ folderId: sessionFolder.id, folderName: sessionFolder.name });
  } catch (error) {
    return { ok: false, code: "folder-creation-failed", error: String(error?.message ?? error) };
  }
}

export async function getOrCreateCampaignFolder(campaignId, campaignName) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can manage the Monster Knowledge Bestiary." };
  }
  if (!_foldersAvailable()) {
    return ok({ folderId: `mock-campaign-${campaignId}`, folderName: campaignName || "Campaign" });
  }
  try {
    const rootResult = await getOrCreateMkRegistryFolder();
    if (!rootResult.ok) return rootResult;
    let campaignFolder = game.folders?.find(f => f.flags?.[SYSTEM_ID]?.mkCampaignFolder === campaignId);
    if (!campaignFolder) {
      campaignFolder = await Folder.create({
        name: campaignName || "Campaign",
        folder: rootResult.data.folderId,
        type: "Actor",
        flags: { [SYSTEM_ID]: { mkCampaignFolder: campaignId, mkRegistryRoot: false } }
      });
    } else if (campaignFolder.folder !== rootResult.data.folderId) {
      // Safe repair: move an existing campaign folder under the Bestiary root
      // instead of duplicating it.
      await campaignFolder.update({ folder: rootResult.data.folderId });
    }
    return ok({ folderId: campaignFolder.id, folderName: campaignFolder.name });
  } catch (error) {
    return { ok: false, code: "folder-creation-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Delete the managed folder for a campaign. GM-authoritative.
 * @param {string} campaignId - The campaign record id whose folder should be removed.
 * @returns {Promise<{ok: true, data: {campaignId, deleted: boolean}} | {ok: false, code: string, error: string}>}
 */
export async function deleteCampaignFolder(campaignId) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can manage the Monster Knowledge Bestiary." };
  }
  if (!_foldersAvailable()) {
    return ok({ campaignId, deleted: false });
  }
  try {
    const campaignFolder = (game.folders ?? []).find(f => f.flags?.[SYSTEM_ID]?.mkCampaignFolder === campaignId);
    if (campaignFolder) {
      await campaignFolder.delete();
      return ok({ campaignId, deleted: true });
    }
    return ok({ campaignId, deleted: false });
  } catch (error) {
    return { ok: false, code: "folder-deletion-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Resolve the Bestiary folder for a record (session or campaign).
 * @param {string} recordKind - "session" or "campaign".
 * @param {string} recordId - The record id.
 * @returns {Promise<{ok: true, data: {folderId: string}} | {ok: false, code: string, error: string}>}
 */
async function getBestiaryActorFolder(recordKind, recordId) {
  if (recordKind === "session") {
    const result = await getOrCreateSessionFolder(recordId);
    if (!result.ok) return result;
    return ok({ folderId: result.data.folderId });
  }
  if (recordKind === "campaign") {
    // Find the campaign name from the registry.
    const state = readRegistryState();
    const campaign = findRecord(state.registry, recordId);
    const result = await getOrCreateCampaignFolder(recordId, campaign ? campaign.name : null);
    if (!result.ok) return result;
    return ok({ folderId: result.data.folderId });
  }
  return { ok: false, code: "invalid-record-kind", error: `Unknown record kind "${recordKind}".` };
}

/**
 * Create an independent Bestiary copy of a monster Actor in the folder for
 * the given record. GM-authoritative.
 *
 * The copy:
 *   - Is a new Actor document (new UUID), not the original.
 *   - Lives in the Bestiary folder for the record (session or campaign).
 *   - Grants players OBSERVER ownership so they can view it.
 *   - Carries system flags identifying it as a Bestiary copy.
 *   - Does not modify the original Actor.
 *
 * @param {object} discovery - The discovery record (must have monsterUuid).
 * @param {string} recordId - The registry record id.
 * @param {string} [recordKind] - "session" or "campaign"; defaults to active.
 * @returns {Promise<{ok: true, data: {bestiaryActorUuid: string, actorId: string}} | {ok: false, code: string, error: string}>}
 */
export async function createBestiaryActorCopy(discovery, recordId, recordKind = null) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can create Bestiary copies." };
  }
  if (!discovery || !discovery.monsterUuid) {
    return { ok: false, code: "no-monster", error: "A Bestiary copy requires a monster UUID." };
  }
  // Copy creation routes through createMkActorDocument (Actor.create first),
  // so the legacy collection method no longer decides availability.
  if (!_foldersAvailable() || !game?.actors) {
    return ok({ bestiaryActorUuid: "mock-copy", actorId: "mock-copy" });
  }
  try {
    // Resolve the folder for this record.
    const kind = recordKind || (readRegistryState().registry.active?.kind ?? "session");
    const folderResult = await getBestiaryActorFolder(kind, recordId);
    if (!folderResult.ok) return folderResult;

    // Resolve the original monster Actor. Token-scoped synthetic uuids are
    // resolved to their persistent base Actor when it exists.
    const original = await resolveMkMonsterActor(discovery.monsterUuid);
    if (!original || original.type !== "monster") {
      return { ok: false, code: "monster-not-found", error: "The original monster Actor could not be resolved." };
    }

    // Check idempotency: if a Bestiary copy already exists for this species
    // and record, reuse it instead of duplicating. The match intentionally
    // IGNORES the recordKind flag: copies created before the kind was passed
    // correctly (e.g. manual additions that landed in the active-kind bucket)
    // are found and reused instead of creating a duplicate.
    const existing = await findExistingBestiaryCopy(discovery.speciesId, recordId);
    if (existing) {
      return ok({ bestiaryActorUuid: existing.uuid, actorId: existing.id });
    }

    // Build the copy data from the original, overriding identity and ownership.
    const sourceData = original.toObject ? original.toObject() : structuredClone(original);
    const copyData = {
      name: sourceData.name,
      type: "monster",
      folder: folderResult.data.folderId,
      ownership: {
        default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER
      },
      flags: {
        [SYSTEM_ID]: {
          mkbestiary: true,
          speciesId: discovery.speciesId,
          recordKind: kind,
          recordId,
          sourceActorUuid: discovery.monsterUuid
        }
      },
      system: sourceData.system,
      img: sourceData.img,
      token: sourceData.token,
      prototypeToken: sourceData.prototypeToken
    };

    const created = await createMkActorDocument(copyData);
    if (!created) {
      return { ok: false, code: "copy-creation-failed", error: "Actor creation returned no document." };
    }

    return ok({
      bestiaryActorUuid: created.uuid,
      actorId: created.id
    });
  } catch (error) {
    return { ok: false, code: "copy-creation-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Find an existing Bestiary copy for a species in a record.
 * @param {string} speciesId - The species id.
 * @param {string} recordId - The registry record id.
 * @returns {Promise<object|null>} The Actor document or null.
 */
async function findExistingBestiaryCopy(speciesId, recordId) {
  if (!_foldersAvailable() || !game?.actors) return null;
  try {
    const actors = [...game.actors.values()];
    return actors.find(actor =>
      actor.flags?.[SYSTEM_ID]?.mkbestiary === true &&
      actor.flags?.[SYSTEM_ID]?.speciesId === speciesId &&
      actor.flags?.[SYSTEM_ID]?.recordId === recordId
    ) ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete a Bestiary copy Actor by UUID. GM-authoritative.
 * @param {string} uuid - The Actor uuid of the Bestiary copy.
 * @returns {Promise<{ok: true, data: {deleted: boolean}} | {ok: false, code: string, error: string}>}
 */
export async function deleteBestiaryActorCopy(uuid) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can delete Bestiary copies." };
  }
  if (!uuid) return ok({ deleted: false });
  if (!_foldersAvailable() || !game?.actors) return ok({ deleted: false });
  try {
    // Verify this is actually a Bestiary copy before deleting.
    const actor = game.actors.get(uuid) || (typeof fromUuid === "function" ? await fromUuid(uuid) : null);
    if (!actor) return ok({ deleted: false });
    if (actor.flags?.[SYSTEM_ID]?.mkbestiary !== true) {
      return { ok: false, code: "not-bestiary-copy", error: "The Actor is not a managed Bestiary copy." };
    }
    await actor.delete();
    return ok({ deleted: true });
  } catch (error) {
    return { ok: false, code: "copy-deletion-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Delete all Bestiary copies for a given registry record. GM-authoritative.
 * @param {string} recordId - The registry record id.
 * @param {string} recordKind - "session" or "campaign".
 * @returns {Promise<{ok: true, data: {deleted: number}} | {ok: false, code: string, error: string}>}
 */
export async function deleteBestiaryCopiesForRecord(recordId, recordKind) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can delete Bestiary copies." };
  }
  if (!_foldersAvailable() || !game?.actors) return ok({ deleted: 0 });
  try {
    let deleted = 0;
    for (const actor of [...game.actors.values()]) {
      if (
        actor.flags?.[SYSTEM_ID]?.mkbestiary === true &&
        actor.flags?.[SYSTEM_ID]?.recordId === recordId &&
        actor.flags?.[SYSTEM_ID]?.recordKind === recordKind
      ) {
        await actor.delete();
        deleted += 1;
      }
    }
    return ok({ deleted });
  } catch (error) {
    return { ok: false, code: "copy-deletion-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Idempotent reconciliation of Bestiary actor copies against the Registry.
 * Ensures every registered species with a monsterUuid has a Bestiary copy,
 * and reports (without deleting) copies that lack a corresponding discovery.
 * @returns {Promise<{ok: true, data: {status, issues, autoFixed, review}} | {ok: false, code: string, error: string}>}
 */
export async function reconcileMkBestiary() {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can reconcile the Bestiary." };
  }
  if (!_foldersAvailable() || !game?.actors) {
    return ok({ status: "reconciled", issues: [], autoFixed: 0, review: 0 });
  }
  try {
    const issues = [];
    const state = readRegistryState();
    const registry = state.registry;

    // Build a set of (recordId, speciesId) pairs that should have copies.
    const expected = new Set();
    for (const key of ["sessions", "campaigns"]) {
      for (const record of registry[key] ?? []) {
        if (!record || !Array.isArray(record.discoveries)) continue;
        for (const disc of record.discoveries) {
          if (!disc || typeof disc !== "object") continue;
          if (disc.monsterUuid) {
            expected.add(`${record.id}|${disc.speciesId}`);
          }
        }
      }
    }

    // Find existing Bestiary copies.
    const existingCopies = [];
    for (const actor of [...game.actors.values()]) {
      if (actor.flags?.[SYSTEM_ID]?.mkbestiary === true) {
        existingCopies.push(actor);
      }
    }

    // ── Missing copies: create them ──
    for (const key of expected) {
      const [recordId, speciesId] = key.split("|");
      const hasCopy = existingCopies.some(a =>
        a.flags?.[SYSTEM_ID]?.speciesId === speciesId &&
        a.flags?.[SYSTEM_ID]?.recordId === recordId
      );
      if (!hasCopy) {
        // Find the discovery to get the monsterUuid and record kind.
        let sourceUuid = null;
        let recordKind = null;
        for (const k of ["sessions", "campaigns"]) {
          for (const record of registry[k] ?? []) {
            if (!record || record.id !== recordId) continue;
            recordKind = k === "sessions" ? "session" : "campaign";
            const disc = Array.isArray(record.discoveries)
              ? record.discoveries.find(d => d && d.speciesId === speciesId)
              : null;
            if (disc) { sourceUuid = disc.monsterUuid; break; }
          }
          if (sourceUuid) break;
        }
        if (sourceUuid && recordKind) {
          const created = await createBestiaryActorCopy(
            { speciesId, monsterUuid: sourceUuid },
            recordId,
            recordKind
          );
          if (created.ok) {
            // Re-stamp the copy pointer onto the discovery. Discoveries whose
            // stored pointer is stale or null (e.g. the retired "mock-copy"
            // placeholder, or a copy created before the discovery was
            // committed) would otherwise keep blocking reveal notices even
            // though the copy now exists.
            let restored = true;
            if (created.data?.bestiaryActorUuid) {
              const stamp = await commitRegistry(reg => {
                const regRecord = findRecord(reg, recordId);
                if (!regRecord) return { ok: false, code: "record-not-found", error: "No registry record matches that id." };
                const regDiscovery = regRecord.discoveries.find(d => d && d.speciesId === speciesId);
                if (!regDiscovery) return { ok: false, code: "discovery-not-found", error: "No discovery matches that species id." };
                if (regDiscovery.bestiaryActorUuid === created.data.bestiaryActorUuid) {
                  return ok({ stamped: false });
                }
                regDiscovery.bestiaryActorUuid = created.data.bestiaryActorUuid;
                regRecord.updatedAt = Date.now();
                return ok({ stamped: true });
              });
              restored = stamp.ok;
            }
            if (restored) {
              issues.push({ code: "bestiary-copy-created", severity: "auto-fixed", detail: `Bestiary copy created for species "${speciesId}" in record "${recordId}".` });
            } else {
              issues.push({ code: "bestiary-copy-stamp-failed", severity: "review", detail: `Bestiary copy created for species "${speciesId}" in record "${recordId}", but the registry pointer could not be updated.` });
            }
          } else {
            issues.push({ code: "bestiary-copy-missing-source", severity: "review", detail: `Cannot create Bestiary copy for species "${speciesId}" in record "${recordId}": ${created.error}.` });
          }
        } else {
          issues.push({ code: "bestiary-copy-unrecoverable", severity: "review", detail: `No source monster for species "${speciesId}" in record "${recordId}"; copy cannot be recreated.` });
        }
      }
    }

    // ── Orphaned copies: report but do not delete ──
    for (const actor of existingCopies) {
      const { speciesId, recordId, recordKind, sourceActorUuid } = actor.flags?.[SYSTEM_ID] ?? {};
      if (!expected.has(`${recordId}|${speciesId}`)) {
        issues.push({ code: "bestiary-copy-orphaned", severity: "review", detail: `Bestiary copy "${actor.name}" (${actor.uuid}) has no corresponding discovery; it will not be removed automatically.` });
        continue;
      }
      // Verify the source actor still exists for copies that have a discovery.
      // Token-scoped source uuids resolve to their base Actor when it exists.
      if (sourceActorUuid) {
        const source = await resolveMkMonsterActor(sourceActorUuid);
        if (!source) {
          issues.push({ code: "bestiary-copy-unrecoverable", severity: "review", detail: `Bestiary copy "${actor.name}" (${actor.uuid}) references source Actor "${sourceActorUuid}" which no longer exists; copy cannot be recreated.` });
        }
      }
    }

    // ── Duplicate copies: report ──
    const byKey = new Map();
    for (const actor of existingCopies) {
      const { speciesId, recordId } = actor.flags?.[SYSTEM_ID] ?? {};
      const k = `${recordId}|${speciesId}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(actor);
    }
    for (const [k, actors] of byKey.entries()) {
      if (actors.length > 1) {
        issues.push({ code: "bestiary-copy-duplicate", severity: "review", detail: `${actors.length} Bestiary copies for ${k}; duplicates will not be removed automatically.` });
      }
    }

    return ok({
      status: "reconciled",
      issues,
      autoFixed: issues.filter(i => i.severity === "auto-fixed").length,
      review: issues.filter(i => i.severity === "review").length
    });
  } catch (error) {
    return { ok: false, code: "bestiary-reconciliation-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Idempotent reconciliation of the Monster Knowledge Bestiary folder tree against
 * the Registry state. Ensures:
 *   - The root folder exists.
 *   - Exactly one Current Session folder exists (reports conflict if multiple).
 *   - Every campaign in the Registry has a folder (creates missing ones).
 *   - Reports orphaned campaign folders (folders for campaigns that no longer exist).
 *
 * Never deletes ambiguous documents automatically.
 * @returns {Promise<{ok: true, data: {status, issues, autoFixed, review}} | {ok: false, code: string, error: string}>}
 */
export async function reconcileMkFolders() {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", error: "Only the Game Master can manage the Monster Knowledge Bestiary." };
  }
  if (!_foldersAvailable()) {
    return ok({ status: "reconciled", issues: [], autoFixed: 0, review: 0 });
  }
  try {
    const rootResult = await getOrCreateMkRegistryFolder();
    if (!rootResult.ok) return rootResult;

    const issues = [];
    const state = readRegistryState();
    const registry = state.registry;

    // ── Current Session folder ──
    const sessionFolders = (game.folders ?? []).filter(f => f.flags?.[SYSTEM_ID]?.mkSessionFolder === true);
    if (sessionFolders.length > 1) {
      issues.push({ code: "duplicate-session-folder", severity: "review", detail: "Multiple 'Current Session' folders found; none will be removed automatically." });
    } else if (sessionFolders.length === 0) {
      const created = await Folder.create({
        name: "Current Session",
        folder: rootResult.data.folderId,
        type: "Actor",
        flags: { [SYSTEM_ID]: { mkSessionFolder: true, mkSessionId: null, mkRegistryRoot: false } }
      });
      issues.push({ code: "session-folder-created", severity: "auto-fixed", detail: "Missing 'Current Session' folder was created." });
    } else {
      // Sync mkSessionId to the active session if one exists.
      const activeSession = registry.active?.kind === "session" ? registry.active.id : null;
      const currentSessionId = sessionFolders[0].flags?.[SYSTEM_ID]?.mkSessionId ?? null;
      if (activeSession && currentSessionId !== activeSession) {
        await sessionFolders[0].setFlag(SYSTEM_ID, "mkSessionId", activeSession);
      }
      // Safe repair: move a Current Session folder created outside the
      // Bestiary root (e.g. by older data using the wrong field) under the
      // root, instead of duplicating it.
      if (sessionFolders[0].folder !== rootResult.data.folderId) {
        await sessionFolders[0].update({ folder: rootResult.data.folderId });
        issues.push({ code: "session-folder-reparented", severity: "auto-fixed", detail: "'Current Session' folder was moved under the Monster Knowledge Bestiary root." });
      }
    }

    // ── Campaign folders ──
    const campaignIds = new Set((registry.campaigns ?? []).map(c => c?.id).filter(Boolean));
    const campaignFolders = (game.folders ?? []).filter(f => Boolean(f.flags?.[SYSTEM_ID]?.mkCampaignFolder));

    for (const cf of campaignFolders) {
      const campaignId = cf.flags?.[SYSTEM_ID]?.mkCampaignFolder;
      if (!campaignIds.has(campaignId)) {
        issues.push({ code: "orphan-campaign-folder", severity: "review", detail: `Campaign folder for unknown campaign "${campaignId}" was found; it will not be removed automatically.` });
        continue;
      }
      // Safe repair: move an existing campaign folder created outside the
      // Bestiary root under the root, instead of duplicating it.
      if (cf.folder !== rootResult.data.folderId) {
        await cf.update({ folder: rootResult.data.folderId });
        issues.push({ code: "campaign-folder-reparented", severity: "auto-fixed", detail: `Campaign folder for "${campaignId}" was moved under the Monster Knowledge Bestiary root.` });
      }
    }

    for (const campaignId of campaignIds) {
      const existing = campaignFolders.find(cf => cf.flags?.[SYSTEM_ID]?.mkCampaignFolder === campaignId);
      if (!existing) {
        const campaign = (registry.campaigns ?? []).find(c => c?.id === campaignId);
        await Folder.create({
          name: campaign?.name || "Campaign",
          folder: rootResult.data.folderId,
          type: "Actor",
          flags: { [SYSTEM_ID]: { mkCampaignFolder: campaignId, mkRegistryRoot: false } }
        });
        issues.push({ code: "campaign-folder-created", severity: "auto-fixed", detail: `Missing folder for campaign "${campaignId}" was created.` });
      }
    }

    return ok({
      status: "reconciled",
      issues,
      autoFixed: issues.filter(i => i.severity === "auto-fixed").length,
      review: issues.filter(i => i.severity === "review").length
    });
  } catch (error) {
    return { ok: false, code: "folder-reconciliation-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Ready-time integrity announcement: warns the GM client when the stored
 * registry reports issues needing manual intervention. Wired from sw25.mjs;
 * never loads in headless test environments that do not run sw25.mjs.
 * @returns {Promise<void>}
 */
export async function initializeMonsterKnowledgeRegistry() {
  const state = readRegistryState();
  const review = state.issues.filter(issue => issue.severity === "review");
  if (!review.length) {
    // Still reconcile folders and bestiary even when there are no registry review issues.
    if (game?.user?.isGM === true) {
      await reconcileMkFolders();
      await reconcileMkBestiary();
    }
    return;
  }
  if (game?.user?.isGM !== true) return;
  for (const issue of review) {
    console.warn(`[SW25 MK Registry] ${issue.code}: ${issue.detail}`);
  }
  await reconcileMkFolders();
  await reconcileMkBestiary();
}

/**
 * Convenience namespace for future consumers (UI in F3): every documented
 * operation, ready to be destructured. Kept in addition to the named exports
 * so callers can import a single symbol.
 */
export const monsterKnowledgeRegistry = {
  // reads
  readRegistry: readMkRegistry,
  readActiveRecord: readMkActiveRecord,
  readSession: readMkSession,
  readSessions: readMkSessions,
  readCampaigns: readMkCampaigns,
  readDiscoveries: readMkDiscoveries,
  isSpeciesKnown: isMkSpeciesKnown,
  getSpeciesLevel: getMkSpeciesLevel,
  countSpeciesWithKnowledge: countSpeciesWithKnowledge,
  // writes (GM authority)
  registerDiscovery: registerMkDiscovery,
  withdrawDiscovery: withdrawMkDiscovery,
  startSession: startMkSession,
  createCampaign: createMkCampaign,
  activateCampaign: activateMkCampaign,
  deactivateCampaign: deactivateMkCampaign,
  deleteCampaign: deleteMkCampaign,
  resetKnowledge: resetMkKnowledge,
  // integrity
  diagnose: diagnoseMkRegistry,
  repair: repairMkRegistry,
  getOrCreateMkRegistryFolder,
  getOrCreateSessionFolder,
  getOrCreateCampaignFolder,
  deleteCampaignFolder,
  reconcileMkFolders,
  createBestiaryActorCopy,
  deleteBestiaryActorCopy,
  deleteBestiaryCopiesForRecord,
  reconcileMkBestiary,
  // constants/helpers
  capabilitiesOf: mkCapabilitiesOf,
  policies: MK_MODEL_POLICIES,
  schemaVersion: MK_REGISTRY_VERSION
};
