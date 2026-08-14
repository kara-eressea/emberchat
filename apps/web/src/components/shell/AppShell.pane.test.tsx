// @vitest-environment jsdom
//
// The phone stack, wired end to end through the shell (#375): the route picks
// the pane, the back affordance is a link to the canonical identity path, and
// the desktop tiers get no stack at all.
//
// The assertions read `data-pane` and hrefs rather than computed visibility:
// the geometry lives in a CSS module, which vitest resolves to class names
// without a stylesheet. What a browser paints is the E2E's job
// (e2e/pane-stack.spec.ts); what the shell decides is this one's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { AppShell } from "./AppShell.js";
import { useRatingsStore } from "../../stores/ratings.js";
import {
  useSessionsStore,
  type ChannelView,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { setWindowWidth } from "../../test-support/dom.js";

// The shell opens the socket and subscribes every identity on mount; none of
// that is under test here.
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

// Four upstream F-List calls behind the sidebar's social sections.
vi.mock("../../lib/social.js", () => ({
  loadSocial: () => Promise.resolve(),
}));

// The sidebar head's version comes from /api/meta.
vi.mock("../../lib/use-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/use-meta.js")>()),
  useServerMeta: () => undefined,
}));

// The message log and the composer toolbar measure themselves (#288, #460);
// jsdom has no ResizeObserver, so a no-op stand-in lets the tree mount.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

const IDENTITY = "Pane Hollow";
const CHANNEL_KEY = "Frontpage";
const CONV_ID = "conv-frontpage";

function channel(): ChannelView {
  return {
    convId: CONV_ID,
    key: CHANNEL_KEY,
    title: "Frontpage",
    description: "",
    mode: "chat",
    oplist: [],
    members: [],
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
    dms: {},
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

const shell = () => screen.getByTestId("app-shell");

beforeEach(() => {
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
  // One fetch per app session — pre-satisfied so the shell's mount effect
  // doesn't reach for the network.
  useRatingsStore.setState({ loaded: true });
  useUiStore.setState({ windowFocused: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setWindowWidth(1024);
});

describe("phone tier", () => {
  beforeEach(() => {
    setWindowWidth(390);
  });

  it("opens an identity route on the list pane", () => {
    renderShell(`/app/${encodeURIComponent(IDENTITY)}`);
    expect(shell()).toHaveAttribute("data-pane", "list");
  });

  it("opens a conversation route on the conversation pane", () => {
    renderShell(`/app/${encodeURIComponent(IDENTITY)}/c/${CHANNEL_KEY}`);
    expect(shell()).toHaveAttribute("data-pane", "conversation");
  });

  it("takes back to the list, at the canonical identity path", async () => {
    const user = userEvent.setup();
    renderShell(`/app/${encodeURIComponent(IDENTITY)}/c/${CHANNEL_KEY}`);

    const back = screen.getByRole("link", { name: "Back to conversations" });
    // Canonical already: the shell builds this from `identityPath` of the
    // resolved identity, which is exactly what its own canonicalizing
    // redirect produces — so arriving here must not bounce again.
    expect(back).toHaveAttribute(
      "href",
      `/app/${encodeURIComponent(IDENTITY)}`,
    );

    await user.click(back);
    expect(shell()).toHaveAttribute("data-pane", "list");
  });

  it("offers a way back from a conversation route that resolves to nothing", () => {
    // No toolbar renders for an unjoined channel, so the empty state carries
    // the escape instead — an installed PWA has no browser Back to fall on.
    renderShell(`/app/${encodeURIComponent(IDENTITY)}/c/Never%20Joined`);
    expect(shell()).toHaveAttribute("data-pane", "conversation");
    expect(
      screen.getByRole("link", { name: "Back to conversations" }),
    ).toHaveAttribute("href", `/app/${encodeURIComponent(IDENTITY)}`);
  });
});

describe("compact and wide", () => {
  it("keeps both columns, and no stack, on a compact window", () => {
    setWindowWidth(800);
    renderShell(`/app/${encodeURIComponent(IDENTITY)}/c/${CHANNEL_KEY}`);
    expect(shell()).not.toHaveAttribute("data-pane");
    expect(
      screen.queryByRole("link", { name: "Back to conversations" }),
    ).toBeNull();
  });

  it("keeps both columns, and no stack, on the desktop grid", () => {
    setWindowWidth(1400);
    renderShell(`/app/${encodeURIComponent(IDENTITY)}/c/${CHANNEL_KEY}`);
    expect(shell()).not.toHaveAttribute("data-pane");
    expect(
      screen.queryByRole("link", { name: "Back to conversations" }),
    ).toBeNull();
  });
});
