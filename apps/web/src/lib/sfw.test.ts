// @vitest-environment jsdom
//
// The SFW quick toggle (#580) as a preset over the override layer (#581):
// what it pins, that it covers all six behaviours the issue lists, and that
// exiting restores whatever was underneath — including a device's own
// appearance overrides — without having stored a copy of it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cmdMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));
vi.mock("../gateway/socket.js", () => ({ gateway: { cmd: cmdMock } }));
vi.mock("../theme/theme.js", () => ({
  hydrateTheme: vi.fn(),
  hydrateInterface: vi.fn(),
}));

import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { isSfwOn, setSfw, SFW_PREFS } from "./sfw.js";
import { useOverridesStore } from "../stores/prefs-overrides.js";
import { useSessionsStore, type IdentitySession } from "../stores/sessions.js";
import {
  refreshEffectivePrefs,
  setAppearanceSync,
} from "../components/prefs/patch.js";

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
});

afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useOverridesStore.setState({ overrides: {} });
  localStorage.clear();
});

const prefsOf = (): UserPrefs =>
  useSessionsStore.getState().sessions.id1?.prefs ?? PREFS_DEFAULTS;

describe("what SFW pins", () => {
  it("covers all six behaviours the issue asks for", () => {
    setSfw(true, refreshEffectivePrefs);
    const prefs = prefsOf();
    // 1. profile icons  2. eicons  3. link previews  4. ads
    expect(prefs.showCharacterIcons).toBe(false);
    expect(prefs.eiconDisplay).toBe("off");
    expect(prefs.linkPreviewMode).toBe("off");
    expect(prefs.adViewDefault).toBe("chat");
    // 5. others' statuses  6. alerts
    expect(prefs.showOthersStatus).toBe(false);
    expect(prefs.highlightSound).toBe(false);
    expect(prefs.highlightFlashTitle).toBe(false);
    expect(prefs.highlightBump).toBe(false);
    expect(prefs.desktopNotifyMentions).toBe(false);
    expect(prefs.desktopNotifyPms).toBe(false);
    expect(prefs.desktopNotifyNotes).toBe(false);
  });

  it("beats a per-channel ad override, which would otherwise survive", () => {
    // The audit's open question: `adViewDefault` alone leaves `channelAdView`
    // showing ads in exactly the channel you were reading.
    useSessionsStore.getState().applyPrefsLocal({
      ...PREFS_DEFAULTS,
      channelAdView: { "adh-lfrp": "both" },
    });
    setSfw(true, refreshEffectivePrefs);
    expect(prefsOf().channelAdView).toEqual({});
  });

  it("leaves the notification inbox recording", () => {
    setSfw(true, refreshEffectivePrefs);
    // Nothing in the preset touches the inbox — the issue asks for alerts to
    // stop being prominent, not for the record to stop being kept.
    expect(SFW_PREFS).not.toHaveProperty("notificationInboxEnabled");
    for (const key of Object.keys(SFW_PREFS)) {
      expect(key.toLowerCase()).not.toContain("inbox");
    }
  });

  it("names only real preferences", () => {
    for (const key of Object.keys(SFW_PREFS)) {
      expect(Object.hasOwn(PREFS_DEFAULTS, key)).toBe(true);
    }
  });

  it("never writes to the server — SFW is this device's business", () => {
    setSfw(true, refreshEffectivePrefs);
    setSfw(false, refreshEffectivePrefs);
    expect(cmdMock).not.toHaveBeenCalled();
  });
});

describe("leaving SFW", () => {
  it("restores the synced values it was hiding", () => {
    useSessionsStore.getState().applyPrefsLocal({
      ...PREFS_DEFAULTS,
      showCharacterIcons: true,
      linkPreviewMode: "hover",
    });
    setSfw(true, refreshEffectivePrefs);
    expect(prefsOf().linkPreviewMode).toBe("off");
    setSfw(false, refreshEffectivePrefs);
    expect(prefsOf().showCharacterIcons).toBe(true);
    expect(prefsOf().linkPreviewMode).toBe("hover");
  });

  it("restores a device override rather than the synced value under it", () => {
    // The reason the layers are separate: SFW must not flatten the device's
    // own appearance choices on its way out.
    setAppearanceSync("id1", false);
    useOverridesStore.getState().mergeLayer("device", { uiScale: 150 });
    refreshEffectivePrefs();
    setSfw(true, refreshEffectivePrefs);
    setSfw(false, refreshEffectivePrefs);
    expect(prefsOf().uiScale).toBe(150);
    expect(useOverridesStore.getState().overrides.device).toBeDefined();
  });

  it("outranks the device layer while it is on", () => {
    setAppearanceSync("id1", false);
    useOverridesStore.getState().mergeLayer("device", {
      showCharacterIcons: true,
    });
    refreshEffectivePrefs();
    setSfw(true, refreshEffectivePrefs);
    expect(prefsOf().showCharacterIcons).toBe(false);
  });

  it("survives a reload while on, and leaves no trace once off", () => {
    setSfw(true, refreshEffectivePrefs);
    expect(isSfwOn()).toBe(true);
    expect(localStorage.getItem("eb.prefOverrides")).toContain("sfw");
    setSfw(false, refreshEffectivePrefs);
    expect(isSfwOn()).toBe(false);
    expect(localStorage.getItem("eb.prefOverrides")).toBeNull();
  });
});
