// Device-local preference overrides (#581).
//
// Preferences are one server-held document per app account, fanned out to
// every attached browser (decisions.md §10). That is right for almost
// everything and wrong for appearance: a phone and a desktop want different
// font sizes, and today the last device to touch one wins everywhere.
//
// Rather than splitting the document by device — a device identity, a schema
// migration, a device-aware fan-out and a merge rule for new devices, all of
// which #586 costs out — the server document stays authoritative and this adds
// a layer *over* it, in localStorage. An overridden key reads local; lifting
// the override brings the synced value straight back, because the synced value
// was never overwritten.
//
// Two layers, lowest precedence first:
//
//   device — the appearance-sync opt-out this issue is about. Long-lived,
//            edited by the Appearance pane while the opt-out is on.
//   sfw    — the quick toggle (#580). Short-lived, dropped wholesale on exit,
//            and outranks `device` so it can hide things the device layer
//            happens to be pinning.
//
// Keeping them separate is what lets the SFW toggle restore "what was
// underneath" without bookkeeping: it deletes its own layer and whatever was
// showing through before shows through again.

import { create } from "zustand";
import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";

/** Lowest precedence first — the order `effectivePrefs` folds them in. */
export const OVERRIDE_LAYERS = ["device", "sfw"] as const;
export type OverrideLayer = (typeof OVERRIDE_LAYERS)[number];

export type PrefOverrides = Partial<Record<OverrideLayer, Partial<UserPrefs>>>;

/**
 * The keys the appearance-sync opt-out parks locally: everything the
 * Appearance pane owns — the palette, the type ramp, row shape and the
 * display toggles — and nothing else. Behaviour (highlights, notifications,
 * delayed send, allowlists) stays synced, because wanting a bigger font on
 * your phone is not wanting different highlight rules on it.
 */
export const DEVICE_APPEARANCE_KEYS = [
  "accent",
  "baseTheme",
  "density",
  "fontSize",
  "messageFont",
  "uiFontSize",
  "uiScale",
  "colorblindMode",
  "sidebarAvatars",
  "showCharacterIcons",
  "showOthersStatus",
  "miniCardPlacement",
  "timestampFormat",
  "use24HourClock",
  "groupConsecutive",
  "alignedColumns",
  "ownMessageTint",
  "showJoinPartQuit",
  "inlineComposer",
  "eiconDisplay",
  "animateEicons",
] as const satisfies readonly (keyof UserPrefs)[];

export type DeviceAppearanceKey = (typeof DEVICE_APPEARANCE_KEYS)[number];

const DEVICE_KEY_SET = new Set<string>(DEVICE_APPEARANCE_KEYS);

/** Is this key one the appearance opt-out is allowed to park locally? */
export function isDeviceAppearanceKey(key: string): key is DeviceAppearanceKey {
  return DEVICE_KEY_SET.has(key);
}

const STORAGE_KEY = "eb.prefOverrides";

/**
 * Fold the layers over the server document. Unknown keys in a stored layer are
 * dropped rather than trusted: this is localStorage, which an older build (or
 * a hand-edited devtools session) may have written, and a stray key would
 * otherwise ride into every consumer of `UserPrefs`.
 */
export function effectivePrefs(
  synced: UserPrefs,
  overrides: PrefOverrides,
): UserPrefs {
  let out: UserPrefs | undefined;
  for (const layer of OVERRIDE_LAYERS) {
    const values = overrides[layer];
    if (values === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(PREFS_DEFAULTS, key) || value === undefined) {
        continue;
      }
      out ??= { ...synced };
      (out as Record<string, unknown>)[key] = value;
    }
  }
  // No layer touched anything: hand back the same object, so selectors that
  // compare by identity don't see a change that isn't one.
  return out ?? synced;
}

/** Read the persisted layers, tolerating anything at all in storage. */
export function readOverrides(): PrefOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === "") {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const out: PrefOverrides = {};
    for (const layer of OVERRIDE_LAYERS) {
      const values = (parsed as Record<string, unknown>)[layer];
      if (typeof values === "object" && values !== null) {
        out[layer] = values;
      }
    }
    return out;
  } catch {
    // Unreadable storage (private mode, embedded webview) or unparseable
    // contents: no overrides, rather than a broken startup.
    return {};
  }
}

function persist(overrides: PrefOverrides): void {
  try {
    const empty = OVERRIDE_LAYERS.every(
      (layer) => overrides[layer] === undefined,
    );
    if (empty) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // Nothing to do — the layer still applies for this session.
  }
}

interface OverridesState {
  overrides: PrefOverrides;
  /** Replace a whole layer, or drop it with `undefined`. */
  setLayer: (
    layer: OverrideLayer,
    values: Partial<UserPrefs> | undefined,
  ) => void;
  /** Merge keys into a layer, creating it if absent. */
  mergeLayer: (layer: OverrideLayer, values: Partial<UserPrefs>) => void;
}

export const useOverridesStore = create<OverridesState>((set) => ({
  overrides: readOverrides(),
  setLayer(layer, values) {
    set((state) => {
      const next = { ...state.overrides };
      if (values === undefined) {
        delete next[layer];
      } else {
        next[layer] = values;
      }
      persist(next);
      return { overrides: next };
    });
  },
  mergeLayer(layer, values) {
    set((state) => {
      const next = {
        ...state.overrides,
        [layer]: { ...state.overrides[layer], ...values },
      };
      persist(next);
      return { overrides: next };
    });
  },
}));

/** Is the appearance-sync opt-out on for this device? */
export function useDeviceOverridesOn(): boolean {
  return useOverridesStore((s) => s.overrides.device !== undefined);
}
