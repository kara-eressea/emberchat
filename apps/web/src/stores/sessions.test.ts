// DM row presence: a freshly opened DM must reflect the partner's live
// presence at once (#229), then keep folding live NLN/STA updates.
// Plus the "Seen recently" moves (#200): part adds to seen, rejoin removes —
// a nick is never in both rosters.

import { beforeEach, describe, expect, it } from "vitest";
import { PREFS_DEFAULTS, UNREAD_DISPLAY_CAP } from "@emberchat/protocol";
import type { ConversationDto, MemberDto } from "@emberchat/protocol";
import {
  genderOf,
  useSessionsStore,
  type IdentitySummary,
} from "./sessions.js";

const IDENTITY = "11111111-1111-7111-8111-111111111111";
const CONV = "22222222-2222-7222-8222-222222222222";

function pmConversation(
  partner: string,
  presence?: ConversationDto["presence"],
): ConversationDto {
  return {
    id: CONV,
    kind: "pm",
    channelKey: null,
    partnerCharacter: partner,
    title: partner,
    pinned: false,
    joined: true,
    lastReadMessageId: null,
    ...(presence ? { presence } : {}),
  };
}

beforeEach(() => {
  useSessionsStore.getState().reset();
});

describe("DM row presence seeding (#229)", () => {
  it("seeds a new DM row from the pm.open presence", () => {
    useSessionsStore.getState().applyConversation(
      IDENTITY,
      pmConversation("Nyx Firemane", {
        online: true,
        status: "away",
        statusmsg: "brb",
      }),
    );
    const dm = useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV];
    expect(dm).toMatchObject({
      partner: "Nyx Firemane",
      online: true,
      status: "away",
      statusmsg: "brb",
    });
  });

  it("defaults to offline when no presence rides the conversation", () => {
    useSessionsStore
      .getState()
      .applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    const dm = useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV];
    expect(dm).toMatchObject({ online: false, status: "", statusmsg: "" });
  });

  it("keeps folding live presence after creation, case-insensitively", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(
      IDENTITY,
      pmConversation("Nyx Firemane", {
        online: true,
        status: "online",
        statusmsg: "",
      }),
    );
    store.applyPresence(IDENTITY, {
      character: "nyx firemane",
      online: false,
    });
    const dm = useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV];
    expect(dm?.online).toBe(false);
  });
});

const KEY = "Frontpage";

function member(character: string, gender = "Female"): MemberDto {
  return { character, gender, status: "online", statusmsg: "" };
}

function channelState() {
  return useSessionsStore.getState().sessions[IDENTITY]?.channels[KEY];
}

describe("Seen recently roster moves (#200)", () => {
  beforeEach(() => {
    const store = useSessionsStore.getState();
    store.applyChannelMembers(IDENTITY, {
      key: KEY,
      mode: "chat",
      members: [member("Amber Vale"), member("Nyx Firemane")],
    });
  });

  it("moves a departing member into seen with their gender and a fresh stamp", () => {
    const before = Date.now();
    useSessionsStore.getState().applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    const channel = channelState();
    expect(channel?.members.map((m) => m.character)).toEqual(["Amber Vale"]);
    expect(channel?.seen).toHaveLength(1);
    expect(channel?.seen[0]).toMatchObject({
      character: "Nyx Firemane",
      gender: "Female",
    });
    expect(channel?.seen[0]?.lastSeen).toBeGreaterThanOrEqual(before);
  });

  it("removes a rejoining member from seen — never in both rosters", () => {
    const store = useSessionsStore.getState();
    store.applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    store.applyMemberJoin(IDENTITY, KEY, member("Nyx Firemane"));
    const channel = channelState();
    expect(channel?.seen).toEqual([]);
    expect(channel?.members.map((m) => m.character)).toContain("Nyx Firemane");
  });

  it("treats a global offline (FLN) as a part in every channel", () => {
    useSessionsStore
      .getState()
      .applyPresence(IDENTITY, { character: "Nyx Firemane", online: false });
    const channel = channelState();
    expect(channel?.members.map((m) => m.character)).toEqual(["Amber Vale"]);
    expect(channel?.seen[0]?.character).toBe("Nyx Firemane");
  });

  it("drops present members from seen on a full roster overwrite (ICH)", () => {
    const store = useSessionsStore.getState();
    store.applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    store.applyChannelMembers(IDENTITY, {
      key: KEY,
      mode: "chat",
      members: [member("Amber Vale"), member("nyx firemane")],
    });
    expect(channelState()?.seen).toEqual([]);
  });

  it("keeps newest-first order and dedupes on repeat parts", () => {
    const store = useSessionsStore.getState();
    store.applyMemberLeave(IDENTITY, KEY, "Amber Vale");
    store.applyMemberJoin(IDENTITY, KEY, member("Nyx Firemane"));
    store.applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    store.applyMemberJoin(IDENTITY, KEY, member("Nyx Firemane"));
    store.applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    const seen = channelState()?.seen ?? [];
    expect(seen.map((entry) => entry.character)).toEqual([
      "Nyx Firemane",
      "Amber Vale",
    ]);
  });

  it("keeps the seen roster when our own leave clears the live list", () => {
    const store = useSessionsStore.getState();
    store.applySnapshot({
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
          convId: CONV,
          key: KEY,
          title: KEY,
          description: "",
          mode: "chat",
          oplist: [],
          members: [member("Amber Vale"), member("Nyx Firemane")],
          seen: [{ character: "Tally Marsh", gender: "Male", lastSeen: 1 }],
          joined: true,
          pinned: false,
          unread: 0,
          mentions: 0,
          lastReadMessageId: null,
        },
      ],
      dms: [],
    });
    useSessionsStore.getState().applyMemberLeave(IDENTITY, KEY, "Amber Vale");
    const channel = channelState();
    expect(channel?.members).toEqual([]);
    expect(channel?.seen.map((entry) => entry.character)).toEqual([
      "Tally Marsh",
    ]);
  });

  it("merges a stray raw-keyed private-room duplicate on reattach (#311)", () => {
    const roomId = "ADH-abc123";
    const snapshotChannel = (
      convId: string,
      key: string,
      title: string,
      joined: boolean,
      unread: number,
    ) => ({
      convId,
      key,
      title,
      description: "",
      mode: "both",
      oplist: [],
      members: [],
      seen: [],
      joined,
      pinned: false,
      unread,
      mentions: 0,
      lastReadMessageId: null,
    });
    useSessionsStore.getState().applySnapshot({
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
      // A pre-fix session persisted both the real room and a stray
      // conversation keyed/titled by the lowercased id.
      channels: [
        snapshotChannel("conv-real", roomId, "Ember Attic", true, 0),
        snapshotChannel("conv-stray", "adh-abc123", "adh-abc123", false, 3),
      ],
      dms: [],
    });

    const channels =
      useSessionsStore.getState().sessions[IDENTITY]?.channels ?? {};
    expect(Object.keys(channels)).toEqual([roomId]);
    expect(channels[roomId]).toMatchObject({ title: "Ember Attic", unread: 0 });
  });
});

function channelConversation(
  lastReadMessageId: number | null,
): ConversationDto {
  return {
    id: CONV,
    kind: "channel",
    channelKey: KEY,
    partnerCharacter: null,
    title: KEY,
    pinned: false,
    joined: true,
    lastReadMessageId,
  };
}

describe("live unread saturation (#582)", () => {
  // A client that stays attached through a flood counts every message itself.
  // Left unbounded it would climb past the point the server's own counts stop
  // at, so the same conversation reported one number live and a different one
  // after a reattach. Both now mean "at least this many".
  it("holds a channel's live counters at the wire's saturation point", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, channelConversation(null));
    for (let i = 1; i <= UNREAD_DISPLAY_CAP + 25; i += 1) {
      store.bumpUnread(IDENTITY, CONV, 100 + i, true);
    }
    const channel = channelState();
    expect(channel?.unread).toBe(UNREAD_DISPLAY_CAP + 1);
    expect(channel?.mentions).toBe(UNREAD_DISPLAY_CAP + 1);
    // Still the newest id, which the read-ack guard (#264) depends on.
    expect(channel?.newestMessageId).toBe(100 + UNREAD_DISPLAY_CAP + 25);
  });

  it("holds a DM's live counter at the same point", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    for (let i = 1; i <= UNREAD_DISPLAY_CAP + 25; i += 1) {
      store.bumpUnread(IDENTITY, CONV, 200 + i);
    }
    const dm = useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV];
    expect(dm?.unread).toBe(UNREAD_DISPLAY_CAP + 1);
  });

  it("leaves counts below the cap exact", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, channelConversation(null));
    for (let i = 1; i <= 5; i += 1) {
      store.bumpUnread(IDENTITY, CONV, 100 + i);
    }
    expect(channelState()?.unread).toBe(5);
  });
});

describe("read-ack echo vs. live unread (#264)", () => {
  it("keeps unread when a slow ack echo lands below a newer live message", () => {
    const store = useSessionsStore.getState();
    // Register the channel + convId → key mapping.
    store.applyConversation(IDENTITY, channelConversation(null));
    // A live message id=101 bumps unread and records the newest id.
    store.bumpUnread(IDENTITY, CONV, 101, true);
    // A read-ack echo advances the cursor to 100 — below the live message,
    // so the genuinely-unread id=101 must survive.
    store.applyConversation(IDENTITY, channelConversation(100));
    const channel = channelState();
    expect(channel?.unread).toBe(1);
    expect(channel?.mentions).toBe(1);
  });

  it("zeroes once the cursor catches up to the newest live message", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, channelConversation(null));
    store.bumpUnread(IDENTITY, CONV, 101, true);
    // The cursor reaches the newest message (e.g. another device read all).
    store.applyConversation(IDENTITY, channelConversation(101));
    const channel = channelState();
    expect(channel?.unread).toBe(0);
    expect(channel?.mentions).toBe(0);
  });

  it("still zeroes on an advance when nothing live was tracked", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, channelConversation(50));
    // Seed a snapshot-style unread with no live message tracked yet.
    useSessionsStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [IDENTITY]: {
          ...s.sessions[IDENTITY]!,
          channels: {
            ...s.sessions[IDENTITY]!.channels,
            [KEY]: { ...s.sessions[IDENTITY]!.channels[KEY]!, unread: 3 },
          },
        },
      },
    }));
    // Another device advances the read cursor — clears as before.
    store.applyConversation(IDENTITY, channelConversation(80));
    expect(channelState()?.unread).toBe(0);
  });

  it("keeps a DM unread when the ack echo trails a live message", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    store.bumpUnread(IDENTITY, CONV, 205);
    store.applyConversation(IDENTITY, {
      ...pmConversation("Nyx Firemane"),
      lastReadMessageId: 200,
    });
    expect(
      useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV]?.unread,
    ).toBe(1);
  });
});

// #611: a message.new can, in principle, be dispatched before the
// conversation.upsert that registers its convId → row mapping. The bump then
// has no row to land on and no guard can help — the target does not exist —
// so it is held and folded in when the row arrives. Every case below drives
// the events in that order deliberately; the server's own ordering means it
// is not what happens in practice, which is exactly why it needs a test.
describe("a bump that arrives before its conversation row (#611)", () => {
  const dmState = () =>
    useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV];

  /** A snapshot carrying no conversations — the server's authoritative view. */
  const seedSnapshot = () => {
    useSessionsStore.getState().applySnapshot({
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
      channels: [],
      dms: [],
    });
  };

  it("lands on the channel row the upsert creates", () => {
    const store = useSessionsStore.getState();
    store.bumpUnread(IDENTITY, CONV, 101, true);
    store.bumpUnread(IDENTITY, CONV, 102, false);
    store.bumpHighlight(IDENTITY, CONV);
    expect(channelState()).toBeUndefined(); // nowhere to land yet

    store.applyConversation(IDENTITY, channelConversation(null));
    const channel = channelState();
    expect(channel?.unread).toBe(2);
    expect(channel?.mentions).toBe(1);
    expect(channel?.highlightedAt).toBeGreaterThan(0);
    // Tracked as live, so the #264 read-cursor rule applies to it as it
    // would have if the row had existed all along.
    expect(channel?.newestMessageId).toBe(102);
  });

  it("lands on the DM row the upsert creates", () => {
    const store = useSessionsStore.getState();
    store.bumpUnread(IDENTITY, CONV, 205);
    store.applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    expect(dmState()?.unread).toBe(1);
    expect(dmState()?.newestMessageId).toBe(205);
  });

  it("is dropped when the server's read cursor already covers it", () => {
    // The upsert says the conversation is read through 300; a held bump for
    // message 205 is a badge the user has demonstrably already cleared
    // elsewhere, so folding it in would resurrect it.
    const store = useSessionsStore.getState();
    store.bumpUnread(IDENTITY, CONV, 205);
    store.applyConversation(IDENTITY, channelConversation(300));
    expect(channelState()?.unread).toBe(0);
  });

  it("is consumed once, not re-applied by later upserts", () => {
    const store = useSessionsStore.getState();
    store.bumpUnread(IDENTITY, CONV, 101);
    store.applyConversation(IDENTITY, channelConversation(null));
    expect(channelState()?.unread).toBe(1);
    store.applyConversation(IDENTITY, channelConversation(null));
    expect(channelState()?.unread).toBe(1);
  });

  it("is discarded by a snapshot, whose counts supersede it", () => {
    const store = useSessionsStore.getState();
    store.bumpUnread(IDENTITY, CONV, 101);
    seedSnapshot();
    store.applyConversation(IDENTITY, channelConversation(null));
    expect(channelState()?.unread).toBe(0);
  });

  it("is discarded when the conversation goes away instead", () => {
    const store = useSessionsStore.getState();
    store.bumpUnread(IDENTITY, CONV, 101);
    store.removeConversation(IDENTITY, CONV);
    store.applyConversation(IDENTITY, channelConversation(null));
    expect(channelState()?.unread).toBe(0);
  });

  it("holds bumps for a bounded number of unknown conversations", () => {
    // The only writer is inbound traffic for a conversation this client has
    // never heard of. Rare by the server's ordering, but not a map to leave
    // growing on an untrusted count.
    const store = useSessionsStore.getState();
    for (let i = 0; i < 200; i += 1) {
      store.bumpUnread(IDENTITY, `conv-${String(i)}`, 100 + i);
    }
    const held = useSessionsStore.getState().sessions[IDENTITY]?.pendingBumps;
    expect(Object.keys(held ?? {})).toHaveLength(64);
  });
});

// #515: the people sections sort on DM activity, so the store has to hold a
// per-DM activity id that counts messages in BOTH directions and survives the
// badge being cleared. Message ids are one global server-assigned sequence —
// no clocks are involved, which is also what makes the order identical on
// every attached device.
describe("DM activity stamp (#515)", () => {
  const dmState = () =>
    useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV];

  it("advances on a message and never goes backwards", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    expect(dmState()?.lastActivityId).toBe(0);
    store.noteDmActivity(IDENTITY, CONV, 300);
    expect(dmState()?.lastActivityId).toBe(300);
    // A late/duplicate delivery of an older id must not un-rank the row.
    store.noteDmActivity(IDENTITY, CONV, 120);
    expect(dmState()?.lastActivityId).toBe(300);
  });

  it("survives the unread badge being cleared", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    store.bumpUnread(IDENTITY, CONV, 300);
    store.noteDmActivity(IDENTITY, CONV, 300);
    store.clearUnread(IDENTITY, CONV);
    expect(dmState()?.unread).toBe(0);
    // Reading is not "this conversation stopped existing" — the row keeps its
    // rank, which is the whole point of retiring the unread float.
    expect(dmState()?.lastActivityId).toBe(300);
  });

  it("is a no-op for a channel conversation", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, channelConversation(null));
    expect(() => {
      store.noteDmActivity(IDENTITY, CONV, 300);
    }).not.toThrow();
    expect(channelState()).toMatchObject({ unread: 0 });
  });
});

describe("case-insensitive member-set moves (#265)", () => {
  beforeEach(() => {
    useSessionsStore.getState().applyChannelMembers(IDENTITY, {
      key: KEY,
      mode: "chat",
      members: [member("Amber Vale"), member("Nyx Firemane")],
    });
  });

  it("moves a member to seen on an FLN whose casing differs from the roster", () => {
    useSessionsStore
      .getState()
      .applyPresence(IDENTITY, { character: "NYX FIREMANE", online: false });
    const channel = channelState();
    // No ghost left behind in the live list.
    expect(channel?.members.map((m) => m.character)).toEqual(["Amber Vale"]);
    expect(channel?.seen[0]?.character).toBe("Nyx Firemane");
  });

  it("dedupes a rejoin whose casing differs — never two rows", () => {
    useSessionsStore
      .getState()
      .applyMemberJoin(IDENTITY, KEY, member("NYX firemane"));
    const names = channelState()?.members.map((m) => m.character) ?? [];
    expect(
      names.filter((n) => n.toLowerCase() === "nyx firemane"),
    ).toHaveLength(1);
  });

  it("folds a live presence update onto the differently-cased member", () => {
    useSessionsStore.getState().applyPresence(IDENTITY, {
      character: "nyx firemane",
      online: true,
      status: "away",
    });
    const nyx = channelState()?.members.find(
      (m) => m.character === "Nyx Firemane",
    );
    expect(nyx?.status).toBe("away");
  });
});

describe("presence identity preservation (#355)", () => {
  // The global NLN/STA/FLN stream fires ~14×/sec. A presence event for a
  // character who isn't in a given channel/DM/social row must leave that
  // object (and its members array) at its exact previous reference, or every
  // subscriber re-renders on every event.
  const OTHER_KEY = "OtherRoom";
  const OTHER_CONV = "33333333-3333-7333-8333-333333333333";

  beforeEach(() => {
    const store = useSessionsStore.getState();
    // A channel that holds Nyx, and one that doesn't.
    store.applyChannelMembers(IDENTITY, {
      key: KEY,
      mode: "chat",
      members: [member("Amber Vale"), member("Nyx Firemane")],
    });
    store.applyChannelMembers(IDENTITY, {
      key: OTHER_KEY,
      mode: "chat",
      members: [member("Amber Vale")],
    });
    // A DM with Nyx, and one with an unrelated partner.
    store.applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    store.applyConversation(IDENTITY, {
      ...pmConversation("Amber Vale"),
      id: OTHER_CONV,
    });
    store.applySocial(IDENTITY, {
      bookmarks: [
        {
          name: "Nyx Firemane",
          online: false,
          status: "offline",
          statusmsg: "",
        },
      ],
      friends: [
        { name: "Amber Vale", online: true, status: "online", statusmsg: "" },
      ],
      incoming: [],
      outgoing: [],
      fetchedAt: 0,
    });
  });

  it("keeps untouched channel, DM, and social references identical", () => {
    const session = () => useSessionsStore.getState().sessions[IDENTITY]!;
    const before = session();
    const otherChannel = before.channels[OTHER_KEY]!;
    const otherMembers = otherChannel.members;
    const otherDm = before.dms[OTHER_CONV]!;
    const friends = before.social!.friends;

    useSessionsStore.getState().applyPresence(IDENTITY, {
      character: "Nyx Firemane",
      online: true,
      status: "away",
    });

    const after = session();
    // The channel Nyx isn't in — same object, same members array.
    expect(after.channels[OTHER_KEY]).toBe(otherChannel);
    expect(after.channels[OTHER_KEY]!.members).toBe(otherMembers);
    // The DM whose partner isn't Nyx — same object.
    expect(after.dms[OTHER_CONV]).toBe(otherDm);
    // The friends array (no matching row) — same array.
    expect(after.social!.friends).toBe(friends);
  });

  it("replaces only the channel/DM/social row the character appears in", () => {
    const session = () => useSessionsStore.getState().sessions[IDENTITY]!;
    const before = session();
    const nyxChannel = before.channels[KEY]!;
    const nyxDm = before.dms[CONV]!;
    const bookmarks = before.social!.bookmarks;

    useSessionsStore.getState().applyPresence(IDENTITY, {
      character: "Nyx Firemane",
      online: true,
      status: "away",
    });

    const after = session();
    // The channel Nyx is in gets a new object carrying the updated status.
    expect(after.channels[KEY]).not.toBe(nyxChannel);
    expect(
      after.channels[KEY]!.members.find((m) => m.character === "Nyx Firemane")
        ?.status,
    ).toBe("away");
    // The DM with Nyx gets a new object reflecting the presence.
    expect(after.dms[CONV]).not.toBe(nyxDm);
    expect(after.dms[CONV]!.online).toBe(true);
    expect(after.dms[CONV]!.status).toBe("away");
    // The bookmarks array (Nyx matched) is rebuilt with the updated row.
    expect(after.social!.bookmarks).not.toBe(bookmarks);
    expect(after.social!.bookmarks[0]).toMatchObject({
      name: "Nyx Firemane",
      online: true,
      status: "away",
    });
  });

  it("preserves references for a character in no channel/DM/social row", () => {
    const session = () => useSessionsStore.getState().sessions[IDENTITY]!;
    const before = session();

    useSessionsStore.getState().applyPresence(IDENTITY, {
      character: "Stranger Nobody",
      online: true,
      status: "away",
    });

    const after = session();
    expect(after.channels).toBe(before.channels);
    expect(after.dms).toBe(before.dms);
    expect(after.social).toBe(before.social);
  });

  it("applyPresenceBulk leaves unmatched DMs and social rows identical", () => {
    const session = () => useSessionsStore.getState().sessions[IDENTITY]!;
    const before = session();
    const otherDm = before.dms[OTHER_CONV]!;
    const friends = before.social!.friends;
    const bookmarks = before.social!.bookmarks;

    // Only Nyx is in the batch — an unrelated partner/friend must not churn.
    useSessionsStore
      .getState()
      .applyPresenceBulk(IDENTITY, [["Nyx Firemane", "Female", "online", ""]]);

    const after = session();
    expect(after.dms[OTHER_CONV]).toBe(otherDm);
    expect(after.social!.friends).toBe(friends);
    // Nyx is a bookmark — that array is rebuilt.
    expect(after.social!.bookmarks).not.toBe(bookmarks);
    expect(after.dms[CONV]!.online).toBe(true);
  });
});

describe("removeConversation (#327)", () => {
  it("drops a channel row and its convId mapping outright", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, channelConversation(null));
    expect(
      useSessionsStore.getState().sessions[IDENTITY]?.channels[KEY],
    ).toBeDefined();

    store.removeConversation(IDENTITY, CONV);
    const session = useSessionsStore.getState().sessions[IDENTITY];
    expect(session?.channels[KEY]).toBeUndefined();
    expect(session?.channelByConvId[CONV]).toBeUndefined();
  });

  it("drops a DM row by convId", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    expect(
      useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV],
    ).toBeDefined();

    store.removeConversation(IDENTITY, CONV);
    expect(
      useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV],
    ).toBeUndefined();
  });

  it("is a no-op for an unknown conversation id", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, channelConversation(null));
    store.removeConversation(IDENTITY, "99999999-9999-7999-8999-999999999999");
    expect(
      useSessionsStore.getState().sessions[IDENTITY]?.channels[KEY],
    ).toBeDefined();
  });
});

// The rail's local mirror for REST-driven identity CRUD: `ready` is the
// authority but only arrives at socket connect, so the picker's own
// creates/renames/deletes have to land in this tab straight away.
describe("identity mirror maintenance", () => {
  const OTHER = "33333333-3333-7333-8333-333333333333";

  function summary(id: string, name: string): IdentitySummary {
    return { id, name, autoConnect: false, unread: 0, mentions: 0 };
  }

  const identities = () => useSessionsStore.getState().identities;

  it("appends an identity the ready frame never carried", () => {
    useSessionsStore.getState().applyReady([summary(IDENTITY, "Amber Vale")]);
    useSessionsStore.getState().upsertIdentity(summary(OTHER, "Nyx Firemane"));

    expect(identities()?.map((i) => i.name)).toEqual([
      "Amber Vale",
      "Nyx Firemane",
    ]);
  });

  it("updates an existing identity in place, keeping its rail position", () => {
    useSessionsStore
      .getState()
      .applyReady([summary(IDENTITY, "Amber Vale"), summary(OTHER, "Nyx")]);
    useSessionsStore.getState().upsertIdentity({
      ...summary(IDENTITY, "Amber Vale"),
      autoConnect: true,
      unread: 4,
    });

    expect(identities()).toHaveLength(2);
    expect(identities()?.[0]).toMatchObject({
      id: IDENTITY,
      autoConnect: true,
      unread: 4,
    });
  });

  it("seeds the list when an identity arrives before any ready frame", () => {
    useSessionsStore.getState().upsertIdentity(summary(IDENTITY, "Amber Vale"));

    expect(identities()).toEqual([summary(IDENTITY, "Amber Vale")]);
  });

  it("leaves the session slices alone on upsert", () => {
    useSessionsStore.getState().applyReady([summary(IDENTITY, "Amber Vale")]);
    useSessionsStore
      .getState()
      .applyConversation(IDENTITY, pmConversation("Nyx Firemane"));

    useSessionsStore
      .getState()
      .upsertIdentity({ ...summary(IDENTITY, "Amber Vale"), unread: 1 });

    expect(
      useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV],
    ).toBeDefined();
  });

  it("drops the identity and its session slice together", () => {
    useSessionsStore
      .getState()
      .applyReady([summary(IDENTITY, "Amber Vale"), summary(OTHER, "Nyx")]);
    useSessionsStore
      .getState()
      .applyConversation(IDENTITY, pmConversation("Nyx Firemane"));

    useSessionsStore.getState().removeIdentity(IDENTITY);

    expect(identities()?.map((i) => i.id)).toEqual([OTHER]);
    // A ghost slice would resurface stale state if the id came back.
    expect(useSessionsStore.getState().sessions[IDENTITY]).toBeUndefined();
  });

  it("leaves other identities' slices untouched", () => {
    useSessionsStore
      .getState()
      .applyReady([summary(IDENTITY, "Amber Vale"), summary(OTHER, "Nyx")]);
    useSessionsStore.getState().applyConversation(OTHER, pmConversation("Bea"));

    useSessionsStore.getState().removeIdentity(IDENTITY);

    expect(
      useSessionsStore.getState().sessions[OTHER]?.dms[CONV],
    ).toBeDefined();
  });

  it("is a no-op for an unknown identity", () => {
    useSessionsStore.getState().applyReady([summary(IDENTITY, "Amber Vale")]);
    useSessionsStore.getState().removeIdentity(OTHER);

    expect(identities()?.map((i) => i.id)).toEqual([IDENTITY]);
  });
});

// The other half of #355 (#560). Reference preservation spares the *render*;
// it does not spare the *selector* — zustand runs every subscriber's selector
// on every `set()`, whatever that set produced. A stream carrying every
// character on F-List must therefore not write at all when it changed nothing.
describe("presence writes nothing when it changes nothing (#560)", () => {
  const OTHER_IDENTITY = "44444444-4444-7444-8444-444444444444";

  beforeEach(() => {
    const store = useSessionsStore.getState();
    store.applyChannelMembers(IDENTITY, {
      key: KEY,
      mode: "chat",
      members: [member("Amber Vale"), member("Nyx Firemane")],
    });
    store.applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    store.applySocial(IDENTITY, {
      bookmarks: [],
      friends: [
        { name: "Amber Vale", online: true, status: "online", statusmsg: "" },
      ],
      incoming: [],
      outgoing: [],
      fetchedAt: 0,
    });
  });

  /** How many times the store notified its subscribers during `run`. */
  function notifications(run: () => void): number {
    let count = 0;
    const unsubscribe = useSessionsStore.subscribe(() => {
      count += 1;
    });
    run();
    unsubscribe();
    return count;
  }

  it("notifies nobody for a character in no channel, DM or social row", () => {
    const before = useSessionsStore.getState().sessions[IDENTITY];
    const count = notifications(() => {
      for (let i = 0; i < 5; i += 1) {
        useSessionsStore.getState().applyPresence(IDENTITY, {
          character: `Stranger ${String(i)}`,
          online: true,
          status: "online",
        });
      }
    });

    expect(count).toBe(0);
    // Not merely equal — the same object, which is what AppShell subscribes to.
    expect(useSessionsStore.getState().sessions[IDENTITY]).toBe(before);
  });

  it("still notifies for a character the viewer can see", () => {
    const count = notifications(() => {
      useSessionsStore.getState().applyPresence(IDENTITY, {
        character: "Nyx Firemane",
        online: true,
        status: "away",
      });
    });

    expect(count).toBe(1);
    expect(
      useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV]?.status,
    ).toBe("away");
  });

  it("still notifies for our own STA, which no channel row carries", () => {
    // The MeBar and the rail read ownStatus, and an STA for ourselves may
    // arrive while we are in no channel at all — the bail must not eat it.
    useSessionsStore.getState().applySnapshot({
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
      channels: [],
      dms: [],
    });

    const count = notifications(() => {
      useSessionsStore.getState().applyPresence(IDENTITY, {
        character: "amber vale",
        online: true,
        status: "busy",
        statusmsg: "writing",
      });
    });

    expect(count).toBe(1);
    expect(useSessionsStore.getState().sessions[IDENTITY]?.ownStatus).toBe(
      "busy",
    );
  });

  it("notifies nobody for an LIS batch that touches nothing", () => {
    const before = useSessionsStore.getState().sessions[IDENTITY];
    const count = notifications(() => {
      useSessionsStore
        .getState()
        .applyPresenceBulk(IDENTITY, [
          ["Stranger Nobody", "Male", "online", ""],
        ]);
    });

    expect(count).toBe(0);
    expect(useSessionsStore.getState().sessions[IDENTITY]).toBe(before);
  });

  it("still creates a slice for an identity it has never seen", () => {
    // The bail is only available to a session that already exists: the first
    // event for an identity has to bring its slice into being regardless.
    const count = notifications(() => {
      useSessionsStore.getState().applyPresence(OTHER_IDENTITY, {
        character: "Stranger Nobody",
        online: true,
        status: "online",
      });
    });

    expect(count).toBe(1);
    expect(useSessionsStore.getState().sessions[OTHER_IDENTITY]).toBeDefined();
  });
});

// genderOf answers from a per-roster index rather than scanning every member
// of every channel with two string allocations per comparison (#560). Same
// answers — including the orderings that make it the shared source of truth
// for the member list and the log (#338).
describe("gender lookup (#560)", () => {
  const OTHER_KEY = "OtherRoom";

  beforeEach(() => {
    useSessionsStore.getState().applyChannelMembers(IDENTITY, {
      key: KEY,
      mode: "chat",
      members: [member("Nyx Firemane", "Female")],
    });
  });

  const session = () => useSessionsStore.getState().sessions[IDENTITY];

  it("finds a present member, case-insensitively (#265)", () => {
    expect(genderOf(session(), "nyx firemane")).toBe("Female");
    expect(genderOf(session(), "NYX FIREMANE")).toBe("Female");
  });

  it("has nothing for a character no roster holds", () => {
    expect(genderOf(session(), "Stranger Nobody")).toBeUndefined();
    expect(genderOf(undefined, "Nyx Firemane")).toBeUndefined();
  });

  it("re-reads a gender the presence stream just changed", () => {
    // The index is cached against the roster array's identity, so a write that
    // rebuilds that array has to be visible on the very next lookup.
    useSessionsStore.getState().applyPresence(IDENTITY, {
      character: "Nyx Firemane",
      online: true,
      gender: "Male",
      status: "online",
    });

    expect(genderOf(session(), "Nyx Firemane")).toBe("Male");
  });

  it("prefers any present member over every seen roster", () => {
    // Nyx is present in one channel and only remembered in another; the live
    // roster wins wherever it sits in the iteration order.
    useSessionsStore.getState().applyChannelMembers(IDENTITY, {
      key: OTHER_KEY,
      mode: "chat",
      members: [member("Nyx Firemane", "Male")],
    });
    useSessionsStore.getState().applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");

    expect(session()?.channels[KEY]?.seen).toHaveLength(1);
    expect(genderOf(session(), "Nyx Firemane")).toBe("Male");
  });

  it("falls back to the seen roster once nobody holds them", () => {
    useSessionsStore.getState().applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");

    expect(session()?.channels[KEY]?.members).toHaveLength(0);
    expect(genderOf(session(), "nyx firemane")).toBe("Female");
  });
});
