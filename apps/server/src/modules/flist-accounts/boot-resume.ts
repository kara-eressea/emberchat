// Boot-time session resume (M9, decisions.md §15): with stored credentials
// and CREDENTIALS_KEY configured, a server restart no longer logs every
// character out — accounts unlock themselves and autoConnect identities
// come back with their exact channel sets (§9 scenario 2). Identities
// whose persisted lastDetachedAt is already past the detached-disconnect
// ceiling stay down: an abandoned instance must not resurrect ghosts.
// Ticket discipline is untouched — every ticket still flows through the
// per-account TicketManager behind the process-wide 1 req/s throttle.

import { inArray, and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/index.js";
import { identities } from "../../db/schema.js";
import type { AutoAway } from "../away/auto-away.js";
import type { HistorySink } from "../history/sink.js";
import type {
  CredentialVault,
  SessionRegistry,
} from "@emberchat/session-engine";
import type { CredentialStore } from "./credential-store.js";

export interface BootResumeDeps {
  db: Db;
  store: CredentialStore;
  vault: CredentialVault;
  sessions: SessionRegistry;
  history: HistorySink;
  autoAway: AutoAway;
  logger: FastifyBaseLogger;
  /** The detached-disconnect ceiling in ms; 0 = no ceiling. */
  disconnectAfterMs: number;
  now?: () => number;
}

export async function resumeStoredSessions(
  deps: BootResumeDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  if (!deps.store.enabled) {
    // The promised loud refusal (decisions.md §15): rows left behind by a
    // since-removed CREDENTIALS_KEY must never be silently ignored — the
    // admin believes storage is off while ciphertext still rides every
    // backup. Counting needs no key.
    const orphaned = await deps.store.storedAccountIds();
    if (orphaned.size > 0) {
      deps.logger.error(
        { count: orphaned.size },
        "flist_credentials holds stored rows but CREDENTIALS_KEY is unset — they are unusable and still ride backups; users can delete them via the Forget toggle, or restore the key",
      );
    }
    return;
  }
  const stored = await deps.store.loadAll();
  if (stored.length === 0) {
    return;
  }
  const byAccount = new Map(stored.map((entry) => [entry.accountId, entry]));
  for (const entry of stored) {
    // A concurrent unlock may already have vaulted a FRESHER password
    // (changed on F-List since it was stored) — never downgrade it (audit).
    if (!deps.vault.has(entry.accountId)) {
      deps.vault.set(entry.accountId, entry.password);
    }
  }
  const wanted = await deps.db
    .select({
      id: identities.id,
      characterName: identities.characterName,
      flistAccountId: identities.flistAccountId,
      lastDetachedAt: identities.lastDetachedAt,
    })
    .from(identities)
    .where(
      and(
        eq(identities.autoConnect, true),
        inArray(identities.flistAccountId, [...byAccount.keys()]),
      ),
    );
  let resumed = 0;
  for (const identity of wanted) {
    const account = byAccount.get(identity.flistAccountId);
    if (!account) {
      continue;
    }
    const detachedAtMs = identity.lastDetachedAt?.getTime();
    if (
      deps.disconnectAfterMs > 0 &&
      detachedAtMs !== undefined &&
      now() - detachedAtMs >= deps.disconnectAfterMs
    ) {
      deps.logger.info(
        { identityId: identity.id },
        "boot resume skipped: past the detached-disconnect ceiling",
      );
      continue;
    }
    try {
      deps.sessions.start({
        identityId: identity.id,
        character: identity.characterName,
        accountId: account.accountId,
        accountName: account.accountName,
        seedChannels: await deps.history.channelsForResume(identity.id),
      });
      if (detachedAtMs !== undefined) {
        // The ceiling keeps counting from the pre-restart detach.
        deps.autoAway.seedDetachment(identity.id, detachedAtMs);
      }
      resumed += 1;
    } catch (error) {
      deps.logger.error(
        { err: error, identityId: identity.id },
        "boot resume failed for identity",
      );
    }
  }
  deps.logger.info(
    { accounts: stored.length, identities: resumed },
    "boot resume: stored credentials unlocked",
  );
}
