// Sword World 2.5 - Monster Knowledge Registry store (persistence layer).
//
// Owns the ONLY persistent store of the Monster Knowledge Registry:
// the `mkRegistry` world setting (scope world, config false, type Object).
// Consumers must never touch the setting directly and must never mutate the
// objects returned by this module: all writes go through
// `commitRegistry(...)` which
//   1. gates the operation on the current user being the GM,
//   2. serializes read-modify-write cycles inside the GM client (no
//      interleaved accidental updates from concurrent service calls),
//   3. hydrates and normalizes the stored snapshot (integrity auto-fixes),
//   4. persists the next state atomically through game.settings.set.
//
// Schema v2 (see reports/monster-knowledge-registry-architecture.md §4.1):
//   {
//     version: 2,
//     active: { kind: "session"|"campaign"|null, id: string|null },
//     sessions: [record],
//     campaigns: [record]
//   }
//   record: { id, kind, name, createdAt, updatedAt, status, policy,
//             discoveries: [discovery] }
//   discovery: { id, speciesId, speciesLabel, monsterUuid, monsterName,
//                className, classResult, discoveredBy, discoveredAt, source }
//
// Integrity rules implemented here (F1 task §8):
//   - missing/empty registry        -> fresh registry (auto-fixed)
//   - unknown version               -> backfilled to current (auto-fixed)
//   - future version                -> reads allowed, writes rejected
//   - non-array lists               -> empty lists (auto-fixed)
//   - malformed records/discoveries -> reported (review), data is KEPT
//   - duplicate record ids / duplicate species discoveries -> reported
//     (review), data is KEPT
//   - orphan/invalid active pointer -> auto-pointed at the most recent
//     session record by createdAt ("most recent wins", functional decision),
//     else cleared
// Ambiguous data is NEVER deleted or merged automatically.

/** World setting scope id of the Sword World 2.5 system. */
export const SYSTEM_ID = "sword-world-25";

/** World setting key of the registry store. */
export const MK_REGISTRY_KEY = "mkRegistry";

/** Current schema version of the registry snapshot. */
export const MK_REGISTRY_VERSION = 2;

const VALID_POINTER_KINDS = new Set([null, "session", "campaign"]);
const LIST_KEYS = ["sessions", "campaigns"];

/**
 * Whether the current runtime has Foundry's Folder API available. Used to
 * decide if the "mock-copy" placeholder cleanup applies: the sentinel only
 * exists legitimately in headless test harnesses, where this returns false. */
function _foldersAvailableForSanitize() {
  return Boolean(typeof Folder !== "undefined" && globalThis.game?.folders);
}

/**
 * Build a fresh empty registry snapshot in schema v2.
 * @returns {object} The fresh registry snapshot (plain object).
 */
export function emptyRegistry() {
  return {
    version: MK_REGISTRY_VERSION,
    active: { kind: null, id: null },
    sessions: [],
    campaigns: []
  };
}

/**
 * Generate a stable-enough identifier for records and discoveries.
 * Uses foundry.utils.randomID when available (runtime), with a deterministic
 * fallback for headless environments that do not mock it.
 * @param {string} [prefix] - Prefix to namespace the id (e.g. "mks", "mkd").
 * @returns {string} A unique-enough id string.
 */
export function generateMkId(prefix = "mk") {
  let suffix = null;
  try {
    suffix = foundry?.utils?.randomID?.();
  } catch {
    suffix = null;
  }
  if (typeof suffix !== "string" || !suffix.length) {
    suffix = `${Math.random().toString(36).slice(2, 10)}`;
  }
  return `${prefix}${suffix}`;
}

/**
 * Read the raw stored registry value without any normalization.
 * @returns {*} The raw world setting value (undefined when unset).
 */
export function readRawRegistry() {
  const settings = game?.settings;
  if (!settings || typeof settings.get !== "function") return undefined;
  return settings.get(SYSTEM_ID, MK_REGISTRY_KEY);
}

/**
 * Normalize the effective createdAt timestamp of a record. Records without a
 * parseable createdAt are treated as oldest (0) and reported for review.
 * @param {object} record - Any record-like object.
 * @returns {number} The effective createdAt epoch, 0 when unknown.
 */
function effectiveCreatedAt(record) {
  const value = Number(record?.createdAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Find the first (most recent by createdAt) valid session record.
 * @param {Array} records - Session records (possibly malformed entries).
 * @returns {object|null} The newest session record, or null.
 */
export function newestSessionRecord(registry) {
  const records = Array.isArray(registry?.sessions) ? registry.sessions : [];
  let best = null;
  let bestTime = 0;
  for (const record of records) {
    if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id) continue;
    const time = effectiveCreatedAt(record);
    if (best === null || time > bestTime) {
      best = record;
      bestTime = time;
    }
  }
  return best;
}

/**
 * Recompute record `status` values from the active pointer. The pointer is
 * the single source of truth for which record is active; every other record
 * of the same list is archived. Lossless: status is metadata, not knowledge.
 * @param {object} registry - Hydrated registry snapshot (mutated in place).
 */
export function normalizeRecordStatuses(registry) {
  for (const key of LIST_KEYS) {
    // The active pointer stores the singular kind ("session"/"campaign"),
    // while collections use plural keys ("sessions"/"campaigns").
    const kind = key === "sessions" ? "session" : "campaign";
    for (const record of registry[key]) {
      if (!record || typeof record !== "object") continue;
      const isPointed = record.id
        && registry.active?.id === record.id
        && registry.active?.kind === kind;
      record.status = isPointed ? "active" : "archived";
    }
  }
}

/**
 * Hydrate and integrity-check a raw stored registry value.
 * Returns a normalized in-memory copy of the registry plus an issue list.
 * Auto-fixed issues are lossless normalizations applied to the in-memory
 * copy; review issues flag ambiguous data that is KEPT and reported to the
 * GM (never deleted by this module).
 * @param {*} raw - The raw stored value.
 * @returns {{registry: object, issues: Array<{code, severity, detail}>, futureVersion: boolean}}
 */
export function hydrateRegistry(raw) {
  const issues = [];
  let futureVersion = false;
  let registry;

  const isBlank =
    raw === undefined
    || raw === null
    || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0);

  if (isBlank) {
    registry = emptyRegistry();
    issues.push({
      code: raw === undefined ? "registry-missing" : "registry-empty",
      severity: "auto-fixed",
      detail: "No Monster Knowledge registry snapshot was stored; a fresh registry was prepared. Knowledge discovered before this point is not retained by the new registry."
    });
  } else if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({
      code: "registry-invalid-type",
      severity: "review",
      detail: `The stored Monster Knowledge registry has an unsupported type (${Array.isArray(raw) ? "array" : typeof raw}). The stored value was NOT modified and may contain recoverable data; a fresh registry was prepared in memory for reads.`
    });
    registry = emptyRegistry();
  } else {
    registry = structuredClone(raw);

    // ── Version ────────────────────────────────────────────────────────
    const storedVersion = Number(registry.version);
    if (registry.version === undefined || registry.version === null || !Number.isFinite(storedVersion)) {
      registry.version = MK_REGISTRY_VERSION;
      issues.push({
        code: "version-missing",
        severity: "auto-fixed",
        detail: "The registry snapshot had no valid schema version; it was backfilled to the current version."
      });
    } else if (storedVersion > MK_REGISTRY_VERSION) {
      futureVersion = true;
      issues.push({
        code: "version-future",
        severity: "review",
        detail: `The registry was written by a newer schema version (${storedVersion}); writes are refused to protect it from accidental downgrades.`
      });
    } else if (storedVersion < MK_REGISTRY_VERSION) {
      // Future migrations plug in here (stamp-per-step); with only v2 shipped
      // there is nothing to migrate yet.
      registry.version = MK_REGISTRY_VERSION;
      issues.push({
        code: "version-outdated",
        severity: "auto-fixed",
        detail: `The registry used an older schema version (${storedVersion}); it was upgraded to version ${MK_REGISTRY_VERSION}.`
      });
    }

    // ── Lists ──────────────────────────────────────────────────────────
    for (const key of LIST_KEYS) {
      if (!Array.isArray(registry[key])) {
        registry[key] = [];
        issues.push({
          code: `${key}-invalid`,
          severity: "auto-fixed",
          detail: `The "${key}" collection was not an array and has been rebuilt as an empty list.`
        });
      }
    }

    // ── Records ────────────────────────────────────────────────────────
    const idSeen = new Set();
    for (const key of LIST_KEYS) {
      for (const record of registry[key]) {
        if (typeof record.id === "string" && record.id) {
          if (idSeen.has(record.id)) {
            issues.push({
              code: "duplicate-record-id",
              severity: "review",
              detail: `Record id "${record.id}" appears more than once; the first entry wins for lookups and the duplicates were kept.`
            });
          }
          idSeen.add(record.id);
        }
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          issues.push({
            code: "record-malformed",
            severity: "review",
            detail: `A ${key} entry is not a record object; it was kept in place and is not addressable by the service.`
          });
          continue;
        }
        // Normalize the singular kind wrapped by the plural list key.
        const singularKind = key === "sessions" ? "session" : "campaign";
        if (record.kind !== singularKind) {
          record.kind = singularKind;
          issues.push({
            code: "record-kind-corrected",
            severity: "auto-fixed",
            detail: `A ${key} entry declared kind "${String(record.kind)}" or none; it was normalized to "${singularKind}".`
          });
        }
        if (typeof record.id !== "string" || !record.id) {
          issues.push({
            code: "record-missing-id",
            severity: "review",
            detail: `A ${key} entry has no id; it was kept, but only id-addressed records can win the active pointer or receive operations.`
          });
        }
        if (!Number.isFinite(Number(record.createdAt))) {
          issues.push({
            code: "record-missing-createdat",
            severity: "review",
            detail: `Record "${String(record.id ?? "?")}" has no createdAt timestamp; it is treated as the oldest session for tie-breaks.`
          });
        }
        if (!record.policy || typeof record.policy !== "object" || !record.policy.capabilities) {
          record.policy = record.kind === "session"
            ? { name: "session-generic", capabilities: sessionDefaultCapabilities() }
            : { name: "generic", capabilities: campaignDefaultCapabilities() };
          issues.push({
            code: "policy-backfilled",
            severity: "auto-fixed",
            detail: `Record "${String(record.id ?? "?")}" had no model policy; the default baseline policy was applied.`
          });
        }
        if (!Array.isArray(record.discoveries)) {
          record.discoveries = [];
          issues.push({
            code: "discoveries-invalid",
            severity: "auto-fixed",
            detail: `Record "${String(record.id ?? "?")}" had a malformed discoveries collection; it was rebuilt as empty.`
          });
        }
      }
    }

    // ── Discoveries sanity: duplicates and malformed entries ───────────
    for (const key of LIST_KEYS) {
      for (const record of registry[key]) {
        if (!record || typeof record !== "object" || !Array.isArray(record.discoveries)) continue;
        const speciesSeen = new Set();
        for (const discovery of record.discoveries) {
          if (!discovery || typeof discovery !== "object") {
            issues.push({
              code: "discovery-malformed",
              severity: "review",
              detail: `Record "${String(record.id ?? "?")}" contains a malformed discovery entry; it was kept in place.`
            });
            continue;
          }
          const species = typeof discovery.speciesId === "string" ? discovery.speciesId : null;
          if (species) {
            if (speciesSeen.has(species)) {
              issues.push({
                code: "duplicate-discovery",
                severity: "review",
                detail: `Record "${record.id}" contains multiple discoveries for species "${species}"; duplicates were kept in place and the first one is authoritative.`
              });
            } else {
              speciesSeen.add(species);
            }
          }
          // Backfill bestiaryActorUuid for discoveries written before F4.3.
          if (typeof discovery.bestiaryActorUuid !== "string") {
            discovery.bestiaryActorUuid = null;
            issues.push({
              code: "discovery-bestiary-backfill",
              severity: "auto-fixed",
              detail: `Discovery "${String(discovery.id ?? "?")}" in record "${String(record.id ?? "?")}" had no bestiaryActorUuid; backfilled to null.`
            });
          }
          // Repair discoveries stamped with the "mock-copy" placeholder. The
          // sentinel is only legitimate in headless test harnesses (no
          // Foundry Folder API); in any real world it is a stale invalid
          // pointer that blocks copy repair and reveal notifications. Reset
          // it so reconciliation or the next discovery rebuilds the copy.
          if (discovery.bestiaryActorUuid === "mock-copy" && _foldersAvailableForSanitize()) {
            discovery.bestiaryActorUuid = null;
            issues.push({
              code: "discovery-bestiary-placeholder-cleared",
              severity: "auto-fixed",
              detail: `Discovery "${String(discovery.id ?? "?")}" in record "${String(record.id ?? "?")}" carried the invalid placeholder uuid "mock-copy"; reset to null so the Bestiary copy is rebuilt.`
            });
          }
        }
      }
    }

    // ── Active pointer ─────────────────────────────────────────────────
    // EXACTLY ONE register must be active at any time (the active-register
    // toggle never clears the pointer; deletes re-point it to the newest
    // remaining session). So any invalid — including cleared/null — pointer
    // is repaired by "most recent wins" (functional decision D5):
    const active = (registry.active && typeof registry.active === "object")
      ? registry.active
      : null;
    const validKind = active && VALID_POINTER_KINDS.has(active.kind);
    const idString = active && typeof active.id === "string" ? active.id : null;
    // The active pointer stores the singular kind ("session"/"campaign"),
    // while collections use plural keys ("sessions"/"campaigns").
    const listKeyByKind = active?.kind === "session" ? "sessions" : active?.kind === "campaign" ? "campaigns" : null;
    const targetList = listKeyByKind ? registry[listKeyByKind] : null;
    const targetFound = targetList && idString
      ? targetList.some(record => record && typeof record === "object" && record.id === idString)
      : false;
    if (!active || !validKind || !targetFound) {
      // Orphan, absent, cleared, or typed-id pointer: "most recent wins"
      // (functional decision D5). Newest session by explicit createdAt
      // becomes active; with no session records the pointer is cleared and
      // the next discovery registration auto-creates a session.
      const newest = newestSessionRecord(registry);
      if (newest) {
        registry.active = { kind: "session", id: newest.id };
      } else {
        registry.active = { kind: null, id: null };
      }
      issues.push({
        code: "orphan-active-pointer",
        severity: "auto-fixed",
        detail: newest
          ? `The stored registry has no valid active record; the most recent session by createdAt is now active ("most recent wins").`
          : `The stored registry has no valid active record and no session exists; the pointer was cleared and the next discovery registration will create a session.`
      });
    }

    // Leftover session records: in schema v2 a healthy registry keeps a
    // single session record (the active one). Extras are inert ambiguous
    // data ("most recent wins" already decided the pointer).
    const validSessions = registry.sessions.filter(record => record && typeof record === "object" && typeof record.id === "string" && record.id);
    if (validSessions.length > 1) {
      issues.push({
        code: "stale-sessions",
        severity: "review",
        detail: `${validSessions.length} session records exist; only the pointed one is active. Leftover sessions are kept; removing them requires an explicit start-new-session action.`
      });
    }
  }

  normalizeRecordStatuses(registry);
  return { registry, issues, futureVersion };
}

// ── Baseline capabilities (recorded here so the store can backfill policies) ─

/**
 * Default capability set for session records.
 * @returns {object} The baseline session capabilities (plain object).
 */
export function sessionDefaultCapabilities() {
  return {
    individualWithdraw: true,
    restart: true,
    deleteRecord: false,
    replaceOnStart: true,
    autoCreate: true
  };
}

/**
 * Default capability set for generic campaign records.
 * @returns {object} The baseline campaign capabilities (plain object).
 */
export function campaignDefaultCapabilities() {
  return {
    individualWithdraw: true,
    restart: true,
    deleteRecord: true,
    replaceOnStart: false,
    autoCreate: false
  };
}

// ── GM-authoritative, serialized commit ─────────────────────────────────────

// The write chain serializes every commit inside this client. A commit is a
// complete hydrate -> mutate -> persist cycle, so two service calls racing in
// the same GM client cannot interleave their read-modify-write windows.
let commitChain = Promise.resolve();

function assertGmWriter() {
  return Boolean(game?.user?.isGM === true);
}

function cloneSnapshot(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * Run one GM-authoritative serialized mutation of the stored registry.
 *
 * The mutation callback receives the hydrated, normalized registry snapshot
 * (a private clone) and returns either `{ ok: true, registry, data }` to
 * commit, or `{ ok: false, code, error }` for an expected failure. Nothing
 * else may persist registry data.
 *
 * @param {(registry: object) => object} mutation - The mutation callback.
 * @returns {Promise<{ok: boolean, data?: object, code?: string, error?: string}>}
 */
export function commitRegistry(mutation) {
  // Attach to the tail of the chain; failures never break serialization.
  const run = commitChain.then(async () => {
    if (!assertGmWriter()) {
      return { ok: false, code: "not-gm", error: "Only the Game Master can modify the Monster Knowledge Registry." };
    }
    const { registry: current, futureVersion } = hydrateRegistry(readRawRegistry());
    if (futureVersion) {
      return { ok: false, code: "version-too-new", error: "The registry was written by a newer schema version; writes are refused until the system is updated." };
    }
    let outcome;
    try {
      outcome = await mutation(current);
    } catch (error) {
      return { ok: false, code: "mutation-failed", error: String(error?.message ?? error) };
    }
    if (!outcome || outcome.ok !== true) {
      return outcome ?? { ok: false, code: "mutation-failed", error: "The registry mutation produced no result." };
    }
    // Mutations operate on the private hydrated copy in place; the explicit
    // registry key is only required when a mutation swaps the object itself.
    const nextRegistry = outcome.registry ?? current;
    normalizeRecordStatuses(nextRegistry);
    try {
      if (typeof game?.settings?.set === "function") {
        await game.settings.set(SYSTEM_ID, MK_REGISTRY_KEY, cloneSnapshot(nextRegistry));
      }
    } catch (error) {
      return { ok: false, code: "persist-failed", error: String(error?.message ?? error) };
    }
    return { ok: true, data: outcome.data ?? null };
  });
  commitChain = run.then(() => {}, () => {});
  return run;
}

/**
 * Read the current hydrated registry state WITHOUT any write side effects.
 * @returns {{registry: object, issues: Array, futureVersion: boolean}}
 */
export function readRegistryState() {
  return hydrateRegistry(readRawRegistry());
}

/**
 * Deep-clone a registry snapshot (or any part of it) for external consumers.
 * Consumers receive private copies and can never corrupt the stored data.
 * @template T
 * @param {T} value - Any registry part (or the whole snapshot).
 * @returns {T} A deep clone.
 */
export function snapshotRegistry(value) {
  return structuredClone(value);
}
