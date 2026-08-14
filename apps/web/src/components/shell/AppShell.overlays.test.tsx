// @vitest-environment jsdom
//
// The phone tier's right-hand panels (#375, MP1 package D): the member list
// and the DM profile as full-height overlays over the conversation, and the
// docked columns on compact and wide left exactly as they were.
//
// The bug package B worked around by removing the member list from this tier
// is the first case below, so it stays fixed: `membersOpen` defaults to open
// and there is no column to dock into, so a docked list meant every channel a
// phone opened showed its roster instead of its conversation.
//
// Geometry is a stylesheet's business and the E2E's to verify
// (e2e/phone-overlays.spec.ts); what the shell decides — which surface exists,
// what opens it, what closes it, and where focus lands — is this one's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { PREFS_DEFAULTS, type ProfileResponse } from "@emberchat/protocol";
import { AppShell } from "./AppShell.js";
import { useProfileStore } from "../../stores/profile.js";
import { useRatingsStore } from "../../stores/ratings.js";
import {
  useSessionsStore,
  type ChannelView,
  type DmView,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { setWindowWidth } from "../../test-support/dom.js";

vi.mock("../../gateway/socket.js", () => ({
  gateway: {
    connect: vi.fn(),
    sub: vi.fn(),
    unsub: vi.fn(),
    cmd: vi.fn(() => Promise.resolve({ ok: true })),
    readAck: vi.fn(),
    markReadToLatest: vi.fn(),
    activity: vi.fn(),
  },
}));

vi.mock("../../lib/social.js", () => ({
  loadSocial: () => Promise.resolve(),
}));

vi.mock("../../lib/use-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/use-meta.js")>()),
  useServerMeta: () => undefined,
}));

// The conversation toolbar folds by measurement (#375 package C), so the
// member-list chip only reaches the ⋯ menu once the row has been measured —
// which in jsdom means driving the observer by hand. Every observed element is
// kept and `measureRow` reports only to the header's; the log and the composer
// toolbar observe themselves too and must not be handed a header width.
const observed: { element: Element; callback: ResizeObserverCallback }[] = [];

class ObserverStub {
  readonly #callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }
  observe(element: Element): void {
    observed.push({ element, callback: this.#callback });
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** Report `width` to the conversation toolbar's own ResizeObserver. */
function measureRow(width: number) {
  const rows = observed.filter((entry) => entry.element.tagName === "HEADER");
  if (rows.length === 0) {
    throw new Error("the conversation toolbar was never observed");
  }
  act(() => {
    for (const row of rows) {
      row.callback(
        [{ contentRect: { width } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    }
  });
}

const IDENTITY = "Vane Overlay";
const PARTNER = "Sheet Wren";
const CHANNEL_KEY = "Frontpage";
const CONV_ID = "conv-frontpage";
const DM_CONV_ID = "conv-dm";

function channel(): ChannelView {
  return {
    convId: CONV_ID,
    key: CHANNEL_KEY,
    title: "Frontpage",
    description: "",
    mode: "chat",
    oplist: [],
    members: [
      {
        character: "Rowan Ash",
        gender: "Female",
        status: "online",
        statusmsg: "",
      },
      {
        character: "Dell Marsh",
        gender: "Male",
        status: "online",
        statusmsg: "",
      },
    ],
    seen: [],
    joined: true,
    pinned: false,
    unread: 0,
    mentions: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

function dm(): DmView {
  return {
    convId: DM_CONV_ID,
    partner: PARTNER,
    title: PARTNER,
    online: true,
    status: "online",
    statusmsg: "",
    pinned: false,
    typing: "clear",
    unread: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
    lastActivityId: 0,
  };
}

function session(): IdentitySession {
  return {
    identityId: "id-1",
    character: IDENTITY,
    sessionStatus: "online",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    invites: [],
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs: PREFS_DEFAULTS,
    outbox: [],
    campaign: null,
    channels: { [CHANNEL_KEY]: channel() },
    dms: { [DM_CONV_ID]: dm() },
    channelByConvId: { [CONV_ID]: CHANNEL_KEY },
    synced: true,
    social: {
      friends: [],
      bookmarks: [],
      incoming: [],
      outgoing: [],
      fetchedAt: 0,
    },
  };
}

/** The bare minimum of a profile response — the DM panel runs the matcher
 * over it, which walks the infotag groups. */
function profileOf(name: string): ProfileResponse {
  return {
    profile: {
      id: 1,
      name,
      description: "",
      views: 1,
      customTitle: null,
      customsFirst: false,
      createdAt: null,
      updatedAt: null,
      settings: {
        guestbook: false,
        showFriends: false,
        preventBookmarks: false,
        public: true,
      },
      badges: [],
      infotagGroups: [],
      kinks: [],
      customKinks: [],
      images: [],
      inlines: {},
      timezone: null,
    },
    fetchedAt: 1_752_000_000_000,
    stale: false,
    budgetExhausted: false,
    note: null,
    timezone: null,
  };
}

function renderShell(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/:identity" element={<AppShell />} />
        <Route path="/app/:identity/c/:channel" element={<AppShell />} />
        <Route path="/app/:identity/dm/:partner" element={<AppShell />} />
      </Routes>
    </MemoryRouter>,
  );
}

const channelPath = `/app/${encodeURIComponent(IDENTITY)}/c/${CHANNEL_KEY}`;
const dmPath = `/app/${encodeURIComponent(IDENTITY)}/dm/${encodeURIComponent(PARTNER)}`;
const OVERFLOW = "More conversation actions";

/** Reach a control through the ⋯ overflow, which is where every one of them
 * lives on a phone (spec §3 keeps exactly two chips on the row). */
async function fromOverflowMenu(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("button", { name: OVERFLOW }));
  const menu = screen.getByRole("dialog", { name: OVERFLOW });
  await user.click(within(menu).getByRole("button", { name }));
}

/** The shared Escape stack listens on window, in the capture phase. */
function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
}

beforeEach(() => {
  observed.length = 0;
  vi.stubGlobal("ResizeObserver", ObserverStub);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  useSessionsStore.setState({
    identities: [
      { id: "id-1", name: IDENTITY, autoConnect: true, unread: 0, mentions: 0 },
    ],
    sessions: { "id-1": session() },
  });
  useRatingsStore.setState({ loaded: true });
  useUiStore.setState({
    windowFocused: false,
    membersOpen: true,
    membersDrawerOpen: false,
    dmSidebarOpen: true,
    dmDrawerOpen: false,
  });
  // Pre-cached profiles keep DmProfile off the network: it loads the partner's
  // profile and the viewer's own the moment it mounts, and both short-circuit
  // on a cache hit.
  useProfileStore.setState({
    profiles: {
      [PARTNER.toLowerCase()]: { state: "ok", response: profileOf(PARTNER) },
    },
    ownProfile: profileOf(IDENTITY),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useProfileStore.setState({ profiles: {}, ownProfile: undefined });
  setWindowWidth(1024);
});

describe("phone tier", () => {
  beforeEach(() => {
    setWindowWidth(390);
  });

  it("opens a channel on its conversation, not on its member list", () => {
    // The exact bug package B worked around: membersOpen is a persisted
    // preference that defaults to OPEN, and the stack has no column to dock
    // into. Nothing about that pref may put a roster on screen here.
    expect(useUiStore.getState().membersOpen).toBe(true);
    renderShell(channelPath);
    measureRow(390);

    expect(screen.queryByRole("complementary", { name: "Members" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();
  });

  it("opens the member list as an overlay, and Escape gives focus back to the opener", async () => {
    const user = userEvent.setup();
    renderShell(channelPath);
    measureRow(390);

    await fromOverflowMenu(user, "Toggle member list");

    const overlay = screen.getByRole("dialog", { name: "Members" });
    expect(overlay).toHaveAttribute("aria-modal", "true");
    // The panel itself, not a phone-only rewrite of it: the same roster, the
    // same filter, inside the overlay.
    expect(
      within(overlay).getByRole("complementary", { name: "Members" }),
    ).toBeInTheDocument();
    expect(within(overlay).getByLabelText("Find members")).toBeInTheDocument();
    expect(within(overlay).getByText("Rowan Ash")).toBeInTheDocument();
    // The docked preference was not touched on the way (it governs the
    // columns on the tiers that have one).
    expect(useUiStore.getState().membersOpen).toBe(true);

    pressEscape();
    expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();
    // …at the ⋯ button the menu row was opened from, which is the one element
    // in that path that outlives the click.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: OVERFLOW }),
    );
  });

  it("closes the overlay from its own ✕", async () => {
    const user = userEvent.setup();
    renderShell(channelPath);
    measureRow(390);
    await fromOverflowMenu(user, "Toggle member list");

    await user.click(screen.getByRole("button", { name: "Close Members" }));
    expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();
    expect(useUiStore.getState().membersDrawerOpen).toBe(false);
  });

  it("lets Escape close the top layer only", async () => {
    const user = userEvent.setup();
    renderShell(channelPath);
    measureRow(390);
    await fromOverflowMenu(user, "Toggle member list");

    const overlay = screen.getByRole("dialog", { name: "Members" });
    const row = within(overlay).getByText("Rowan Ash").closest("button");
    fireEvent.contextMenu(row ?? document.body);
    const menu = screen.getByRole("menu", { name: "Rowan Ash menu" });
    expect(menu).toBeInTheDocument();

    // The member menu opened on top of the overlay, so it goes first…
    pressEscape();
    expect(screen.queryByRole("menu", { name: "Rowan Ash menu" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Members" })).toBeInTheDocument();
    // …and the next press takes the overlay.
    pressEscape();
    expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();
  });

  it("puts the overlay away when the conversation is left", async () => {
    const user = userEvent.setup();
    renderShell(channelPath);
    measureRow(390);
    await fromOverflowMenu(user, "Toggle member list");
    expect(screen.getByRole("dialog", { name: "Members" })).toBeInTheDocument();

    await user.click(
      screen.getByRole("link", { name: "Back to conversations" }),
    );
    expect(screen.getByTestId("app-shell")).toHaveAttribute(
      "data-pane",
      "list",
    );
    // Transient and per-visit: coming back must not find a panel over the
    // conversation, the way the persisted preference would.
    expect(useUiStore.getState().membersDrawerOpen).toBe(false);
  });

  it("opens the DM profile as the same overlay, and starts it closed", async () => {
    const user = userEvent.setup();
    // Open on the wide layout's preference — which must not reach this tier.
    expect(useUiStore.getState().dmSidebarOpen).toBe(true);
    renderShell(dmPath);
    measureRow(390);

    const label = `Profile: ${PARTNER}`;
    expect(screen.queryByRole("dialog", { name: label })).toBeNull();
    expect(screen.queryByRole("complementary", { name: label })).toBeNull();

    await fromOverflowMenu(user, "Toggle profile panel");
    const overlay = screen.getByRole("dialog", { name: label });
    expect(overlay).toHaveAttribute("aria-modal", "true");
    expect(
      within(overlay).getByRole("button", { name: "Open full profile" }),
    ).toBeInTheDocument();

    pressEscape();
    expect(screen.queryByRole("dialog", { name: label })).toBeNull();
  });
});

describe("compact and wide", () => {
  it("keeps the member list docked on a compact window", async () => {
    const user = userEvent.setup();
    setWindowWidth(800);
    renderShell(channelPath);
    measureRow(700);

    expect(
      screen.getByRole("complementary", { name: "Members" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();

    // …and the chip still drives the persisted column preference there.
    await user.click(
      screen.getByRole("button", { name: "Toggle member list" }),
    );
    expect(useUiStore.getState().membersOpen).toBe(false);
    expect(useUiStore.getState().membersDrawerOpen).toBe(false);
    expect(screen.queryByRole("complementary", { name: "Members" })).toBeNull();
  });

  it("keeps the member list docked on the desktop grid", () => {
    setWindowWidth(1400);
    renderShell(channelPath);

    const members = screen.getByRole("complementary", { name: "Members" });
    expect(members).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Toggle member list" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("leaves the compact DM drawer the non-modal drawer it was", async () => {
    const user = userEvent.setup();
    setWindowWidth(800);
    renderShell(dmPath);
    measureRow(700);

    const label = `Profile: ${PARTNER}`;
    // Narrow: the grid column steps out and the drawer starts closed (#170).
    expect(screen.queryByRole("complementary", { name: label })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Toggle profile panel" }),
    );
    expect(
      screen.getByRole("complementary", { name: label }),
    ).toBeInTheDocument();
    // Still a drawer, not the phone tier's modal overlay.
    expect(screen.queryByRole("dialog", { name: label })).toBeNull();
  });
});
