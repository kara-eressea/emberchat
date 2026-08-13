// @vitest-environment jsdom
//
// The device-local override layer (#581): the server document stays
// authoritative, a layer shadows it locally, and lifting the layer reveals the
// untouched document again. That last property is the whole design — it is
// what lets the appearance opt-out and, later, the SFW toggle (#580) restore
// "what was underneath" without storing a copy of it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cmdMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));
vi.mock("../gateway/socket.js", () => ({ gateway: { cmd: cmdMock } }));
vi.mock("../theme/theme.js", () => ({
  hydrateTheme: vi.fn(),
  hydrateInterface: vi.fn(),
}));

import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import {
  DEVICE_APPEARANCE_KEYS,
  effectivePrefs,
  isDeviceAppearanceKey,
  readOverrides,
  useOverridesStore,
} from "./prefs-overrides.js";
import { useSessionsStore, type IdentitySession } from "./sessions.js";
import { patchPrefs, setAppearanceSync } from "../components/prefs/patch.js";

const initialSessions = useSessionsStore.getState().sessions;

beforeEach(() => {
  localStorage.clear();
  useOverridesStore.setState({ overrides: {} });
  useSessionsStore.setState({
    sessions: {
      id1: {
        identityId: "id1",
        prefs: { ...PREFS_DEFAULTS },
        syncedPrefs: { ...PREFS_DEFAULTS },
        synced: true,
      } as unknown as IdentitySession,
    },
  });
  cmdMock.mockClear();
});

afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useOverridesStore.setState({ overrides: {} });
  localStorage.clear();
});

const prefsOf = (): UserPrefs =>
  useSessionsStore.getState().sessions.id1?.prefs ?? PREFS_DEFAULTS;
const syncedOf = (): UserPrefs =>
  useSessionsStore.getState().sessions.id1?.syncedPrefs ?? PREFS_DEFAULTS;

describe("effectivePrefs", () => {
  it("returns the very same object when no layer applies", () => {
    // Identity matters: selectors compare by reference, and a fresh object on
    // every fold would repaint the app on every unrelated store write.
    const synced = { ...PREFS_DEFAULTS };
    expect(effectivePrefs(synced, {})).toBe(synced);
    expect(effectivePrefs(synced, { device: {} })).toBe(synced);
  });

  it("shadows the synced value without mutating it", () => {
    const synced = { ...PREFS_DEFAULTS, uiScale: 100 };
    const out = effectivePrefs(synced, { device: { uiScale: 125 } });
    expect(out.uiScale).toBe(125);
    expect(synced.uiScale).toBe(100);
  });

  it("lets sfw outrank device, so the toggle can hide what a device pins", () => {
    const out = effectivePrefs(PREFS_DEFAULTS, {
      device: { showCharacterIcons: true },
      sfw: { showCharacterIcons: false },
    });
    expect(out.showCharacterIcons).toBe(false);
  });

  it("drops keys that are not preferences", () => {
    const out = effectivePrefs(PREFS_DEFAULTS, {
      device: { nonsense: 1 } as unknown as Partial<UserPrefs>,
    });
    expect(out).not.toHaveProperty("nonsense");
  });
});

describe("persistence", () => {
  it("survives a reload and disappears when the last layer goes", () => {
    useOverridesStore.getState().setLayer("device", { uiScale: 125 });
    expect(readOverrides()).toEqual({ device: { uiScale: 125 } });
    useOverridesStore.getState().setLayer("device", undefined);
    expect(readOverrides()).toEqual({});
    expect(localStorage.getItem("eb.prefOverrides")).toBeNull();
  });

  it("ignores junk in storage rather than throwing at startup", () => {
    localStorage.setItem("eb.prefOverrides", "not json{");
    expect(readOverrides()).toEqual({});
    localStorage.setItem("eb.prefOverrides", '"a string"');
    expect(readOverrides()).toEqual({});
  });
});

describe("the appearance-sync opt-out (#581)", () => {
  it("keeps what you are looking at when you turn it off", () => {
    useSessionsStore.getState().applyPrefsLocal({
      ...PREFS_DEFAULTS,
      uiScale: 125,
      accent: "moss",
    });
    setAppearanceSync("id1", false);
    // No jump to defaults: the snapshot is the values that were on screen.
    expect(prefsOf().uiScale).toBe(125);
    expect(prefsOf().accent).toBe("moss");
  });

  it("stops appearance edits from reaching the server", async () => {
    setAppearanceSync("id1", false);
    await patchPrefs("id1", { uiScale: 150 });
    expect(cmdMock).not.toHaveBeenCalled();
    expect(prefsOf().uiScale).toBe(150);
    // The synced document is untouched — that is what makes this reversible.
    expect(syncedOf().uiScale).toBe(PREFS_DEFAULTS.uiScale);
  });

  it("still syncs behaviour prefs while appearance is local", async () => {
    setAppearanceSync("id1", false);
    await patchPrefs("id1", { highlightSound: !PREFS_DEFAULTS.highlightSound });
    expect(cmdMock).toHaveBeenCalledTimes(1);
  });

  it("splits a mixed patch instead of refusing or sending it whole", async () => {
    setAppearanceSync("id1", false);
    await patchPrefs("id1", {
      uiScale: 150,
      highlightSound: !PREFS_DEFAULTS.highlightSound,
    });
    expect(cmdMock).toHaveBeenCalledTimes(1);
    expect(cmdMock.mock.calls[0]?.[0]).toMatchObject({
      d: { prefs: { highlightSound: !PREFS_DEFAULTS.highlightSound } },
    });
    expect(prefsOf().uiScale).toBe(150);
  });

  it("ignores another device's appearance fan-out while it is on", () => {
    setAppearanceSync("id1", false);
    void patchPrefs("id1", { uiScale: 150 });
    // Another device changes the synced document and the server tells us.
    useSessionsStore.getState().applyPrefs("id1", {
      sendDelaySeconds: 0,
      prefs: { ...PREFS_DEFAULTS, uiScale: 80 },
    });
    expect(prefsOf().uiScale).toBe(150);
    expect(syncedOf().uiScale).toBe(80);
  });

  it("restores the synced appearance when turned back on", () => {
    setAppearanceSync("id1", false);
    void patchPrefs("id1", { uiScale: 150 });
    useSessionsStore.getState().applyPrefs("id1", {
      sendDelaySeconds: 0,
      prefs: { ...PREFS_DEFAULTS, uiScale: 80 },
    });
    setAppearanceSync("id1", true);
    // Nothing was stored to restore *from* — the synced document simply stops
    // being shadowed.
    expect(prefsOf().uiScale).toBe(80);
  });
});

describe("the device key set", () => {
  it("covers appearance and nothing behavioural", () => {
    expect(isDeviceAppearanceKey("uiScale")).toBe(true);
    expect(isDeviceAppearanceKey("accent")).toBe(true);
    // Behaviour stays synced: a bigger font on your phone is not different
    // highlight rules on it.
    expect(isDeviceAppearanceKey("highlightSound")).toBe(false);
    expect(isDeviceAppearanceKey("imagePreviewHosts")).toBe(false);
    expect(isDeviceAppearanceKey("sendDelaySeconds")).toBe(false);
  });

  it("names only real preferences", () => {
    for (const key of DEVICE_APPEARANCE_KEYS) {
      expect(Object.hasOwn(PREFS_DEFAULTS, key)).toBe(true);
    }
  });
});
