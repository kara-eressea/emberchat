// markConversationRead (#315): the sidebar "Mark as read" action. It must
// reuse the viewing path — clear the local badges immediately and advance the
// persisted read cursor to the newest message so the change sticks across
// devices — without navigating anywhere.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFS_DEFAULTS, type ServerFrame } from "@emberchat/protocol";

// The cursor advance goes over the gateway socket; spy on it here. A hoisted
// standalone spy keeps the assertions off `gateway.method` (unbound-method).
const { markReadToLatest } = vi.hoisted(() => ({
  markReadToLatest: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("../gateway/socket.js", () => ({ gateway: { markReadToLatest } }));
// dispatchFrame boots the theme (localStorage) on snapshot — stub it out in
// this node-environment unit test, as the dispatch suite does.
vi.mock("../theme/theme.js", () => ({
  hydrateTheme: vi.fn(),
  hydrateInterface: vi.fn(),
}));

import { useSessionsStore } from "../stores/sessions.js";
import { dispatchFrame } from "../gateway/dispatch.js";
import { markConversationRead } from "./mark-read.js";

const IDENTITY = "11111111-1111-7111-8111-111111111111";
const CONV_CHANNEL = "22222222-2222-7222-8222-222222222222";
const CONV_DM = "33333333-3333-7333-8333-333333333333";

function snapshot(): ServerFrame {
  return {
    t: "snapshot",
    d: {
      identityId: IDENTITY,
      self: {
        character: "Amber Vale",
        sessionStatus: "online",
        status: "online",
        statusmsg: "",
        ignores: [],
        limits: {
          chatMax: 4096,
          privMax: 50000,
          lfrpMax: 50000,
          lfrpFlood: 600,
        },
        iconBlacklist: [],
        chatop: false,
        sendDelaySeconds: 0,
        prefs: PREFS_DEFAULTS,
        outbox: [],
        campaign: null,
        social: null,
      },
      channels: [
        {
          convId: CONV_CHANNEL,
          key: "Frontpage",
          title: "Frontpage",
          description: "",
          mode: "chat",
          oplist: [],
          members: [],
          seen: [],
          joined: true,
          pinned: false,
          unread: 3,
          mentions: 1,
          lastReadMessageId: 10,
        },
      ],
      dms: [
        {
          convId: CONV_DM,
          partner: "Nyx Firemane",
          title: "Nyx Firemane",
          online: true,
          status: "online",
          statusmsg: "",
          pinned: false,
          unread: 4,
          lastReadMessageId: 20,
          lastActivityId: 20,
        },
      ],
    },
  };
}

const session = () => useSessionsStore.getState().sessions[IDENTITY];

beforeEach(() => {
  useSessionsStore.getState().reset();
  markReadToLatest.mockClear();
  dispatchFrame(snapshot());
});

describe("markConversationRead", () => {
  it("clears a channel's badges and advances its read cursor", () => {
    expect(session()?.channels["Frontpage"]?.unread).toBe(3);

    markConversationRead(IDENTITY, CONV_CHANNEL);

    const channel = session()?.channels["Frontpage"];
    expect(channel?.unread).toBe(0);
    expect(channel?.mentions).toBe(0);
    expect(channel?.highlightedAt).toBe(0);
    expect(markReadToLatest).toHaveBeenCalledExactlyOnceWith(
      IDENTITY,
      CONV_CHANNEL,
    );
  });

  it("clears a DM's badge and advances its read cursor", () => {
    expect(session()?.dms[CONV_DM]?.unread).toBe(4);

    markConversationRead(IDENTITY, CONV_DM);

    expect(session()?.dms[CONV_DM]?.unread).toBe(0);
    expect(markReadToLatest).toHaveBeenCalledExactlyOnceWith(IDENTITY, CONV_DM);
  });
});
