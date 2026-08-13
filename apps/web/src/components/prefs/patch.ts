// The one write path for preference edits: optimistic local apply (all
// slices — prefs are per user) + theme repaint, then the gateway `prefs.set`
// patch. Convergence is the `prefs.updated` fan-out; a refused ack rolls the
// optimistic state back so the UI never lies about what's persisted.
//
// Since #581 a patch can also be routed *away* from the server. While the
// appearance-sync opt-out is on, appearance keys are parked in this device's
// override layer instead: nothing goes on the wire, the synced document is
// left exactly as it was, and turning the opt-out off brings it back. A patch
// that mixes appearance with behaviour is split, each half going where it
// belongs, rather than being refused or sent whole.

import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { UserPrefs, UserPrefsPatch } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { useSessionsStore } from "../../stores/sessions.js";
import {
  DEVICE_APPEARANCE_KEYS,
  isDeviceAppearanceKey,
  useOverridesStore,
} from "../../stores/prefs-overrides.js";
import { hydrateInterface, hydrateTheme } from "../../theme/theme.js";

/** Repaint everything a preference document can change about the shell. */
function hydrate(prefs: UserPrefs): void {
  hydrateTheme(prefs);
  hydrateInterface(prefs);
}

/**
 * Push the freshly folded effective prefs into every slice and repaint.
 * Exported for the SFW toggle (#580), which changes a layer directly rather
 * than going through a patch.
 */
export function refreshEffectivePrefs(): void {
  const store = useSessionsStore.getState();
  store.reapplyPrefOverrides();
  const effective = Object.values(useSessionsStore.getState().sessions).find(
    (session) => session.synced,
  )?.prefs;
  hydrate(effective ?? PREFS_DEFAULTS);
}

/**
 * Turn the appearance-sync opt-out on or off for this device (#581).
 *
 * On: snapshot the appearance keys as they look right now, so the device keeps
 * exactly what the user is currently seeing rather than jumping to defaults.
 * Off: drop the layer, and the synced document — untouched the whole time —
 * shows through again.
 */
export function setAppearanceSync(identityId: string, synced: boolean): void {
  const store = useSessionsStore.getState();
  if (synced) {
    useOverridesStore.getState().setLayer("device", undefined);
  } else {
    const current = store.sessions[identityId]?.prefs ?? PREFS_DEFAULTS;
    const snapshot: Partial<UserPrefs> = {};
    for (const key of DEVICE_APPEARANCE_KEYS) {
      (snapshot as Record<string, unknown>)[key] = current[key];
    }
    useOverridesStore.getState().setLayer("device", snapshot);
  }
  refreshEffectivePrefs();
}

export async function patchPrefs(
  identityId: string,
  patch: UserPrefsPatch,
): Promise<boolean> {
  const store = useSessionsStore.getState();
  const deviceLayerOn =
    useOverridesStore.getState().overrides.device !== undefined;

  // Split the patch when the opt-out is on: appearance keys stay on this
  // device, everything else is still a synced preference.
  const local: Partial<UserPrefs> = {};
  const remote: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (deviceLayerOn && isDeviceAppearanceKey(key)) {
      (local as Record<string, unknown>)[key] = value;
    } else {
      remote[key] = value;
    }
  }

  if (Object.keys(local).length > 0) {
    useOverridesStore.getState().mergeLayer("device", local);
    refreshEffectivePrefs();
  }
  if (Object.keys(remote).length === 0) {
    // Nothing left for the server — a purely local edit always "succeeds".
    return true;
  }

  const remotePatch = remote as UserPrefsPatch;
  const session = store.sessions[identityId];
  const current = session?.syncedPrefs ?? session?.prefs ?? PREFS_DEFAULTS;
  const next: UserPrefs = { ...current, ...remotePatch };
  store.applyPrefsLocal(next);
  hydrate(useSessionsStore.getState().sessions[identityId]?.prefs ?? next);
  const ack = await gateway.cmd({
    identityId,
    action: "prefs.set",
    d: { prefs: remotePatch },
  });
  if (!ack.ok) {
    useSessionsStore.getState().applyPrefsLocal(current);
    hydrate(useSessionsStore.getState().sessions[identityId]?.prefs ?? current);
  }
  return ack.ok;
}
