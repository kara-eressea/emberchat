// @vitest-environment jsdom
//
// The toggle's interaction rule (#580), which is deliberately asymmetric:
// going *into* SFW mode must never be slowed down — you are reaching for it
// because someone is already walking over — while coming *out* asks first,
// because the failure mode is uncovering an adult chat client in front of
// them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const cmdMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));
vi.mock("../../gateway/socket.js", () => ({ gateway: { cmd: cmdMock } }));
vi.mock("../../theme/theme.js", () => ({
  hydrateTheme: vi.fn(),
  hydrateInterface: vi.fn(),
}));

import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { SfwToggle } from "./SfwToggle.js";
import { useOverridesStore } from "../../stores/prefs-overrides.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";

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

const sfwOn = () => useOverridesStore.getState().overrides.sfw !== undefined;

describe("SfwToggle", () => {
  it("turns on in one click, with nothing to confirm", async () => {
    const user = userEvent.setup();
    render(<SfwToggle />);
    await user.click(screen.getByRole("button", { name: "SFW mode" }));
    expect(sfwOn()).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports its state to assistive tech", async () => {
    const user = userEvent.setup();
    render(<SfwToggle />);
    const button = screen.getByRole("button", { name: "SFW mode" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("asks before turning off, and stays on until you say so", async () => {
    const user = userEvent.setup();
    useOverridesStore.getState().setLayer("sfw", { showCharacterIcons: false });
    render(<SfwToggle />);
    await user.click(screen.getByRole("button", { name: "SFW mode" }));
    expect(screen.getByRole("dialog")).toBeDefined();
    // The click alone changed nothing.
    expect(sfwOn()).toBe(true);
  });

  it("stays on when the confirmation is declined", async () => {
    const user = userEvent.setup();
    useOverridesStore.getState().setLayer("sfw", { showCharacterIcons: false });
    render(<SfwToggle />);
    await user.click(screen.getByRole("button", { name: "SFW mode" }));
    await user.click(screen.getByRole("button", { name: "Stay in SFW" }));
    expect(sfwOn()).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays on when the confirmation is dismissed with Escape", async () => {
    const user = userEvent.setup();
    useOverridesStore.getState().setLayer("sfw", { showCharacterIcons: false });
    render(<SfwToggle />);
    await user.click(screen.getByRole("button", { name: "SFW mode" }));
    await user.keyboard("{Escape}");
    expect(sfwOn()).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("turns off only on the explicit confirmation", async () => {
    const user = userEvent.setup();
    useOverridesStore.getState().setLayer("sfw", { showCharacterIcons: false });
    render(<SfwToggle />);
    await user.click(screen.getByRole("button", { name: "SFW mode" }));
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    expect(sfwOn()).toBe(false);
  });
});
