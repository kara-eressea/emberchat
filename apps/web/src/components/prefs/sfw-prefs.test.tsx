// @vitest-environment jsdom
//
// The two display preferences the SFW toggle needs (#585), plus the eicon
// "off" mode that goes with them. Each is a preference in its own right — a
// shared screen or a slow connection wants them independently of any SFW mode
// — so each is tested here against the surfaces it actually governs, not
// against the toggle that will later flip it (#580).

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { Avatar } from "../common/Avatar.js";
import { MemberStatus } from "../chat/MemberStatus.js";
import { RichText } from "../chat/RichText.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
});

function seedPrefs(patch: Partial<UserPrefs>): void {
  useSessionsStore.setState({
    sessions: {
      id1: {
        identityId: "id1",
        prefs: { ...PREFS_DEFAULTS, ...patch },
        synced: true,
      } as unknown as IdentitySession,
    },
  });
}

describe("showCharacterIcons (#585)", () => {
  it("keeps portraits by default", () => {
    seedPrefs({});
    const { container } = render(<Avatar name="Mara Quill" size={32} />);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("drops the portrait but keeps the initial chip, so layout is unchanged", () => {
    // The fallback already exists as the loading/error state — off reuses it
    // rather than removing the box, which is what keeps rows from reflowing.
    seedPrefs({ showCharacterIcons: false });
    const { container } = render(<Avatar name="Mara Quill" size={32} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("M");
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.width).toBe("32px");
    expect(box.style.height).toBe("32px");
  });

  it("degrades an inline [icon] to a name chip that still links to the profile", () => {
    seedPrefs({ showCharacterIcons: false });
    const { container } = render(<RichText bbcode="[icon]Mara Quill[/icon]" />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Mara Quill")).toBeDefined();
    // Not showing the portrait is not the same as breaking the link.
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      "https://www.f-list.net/c/Mara%20Quill",
    );
  });

  it("hides an [icon] inside a member-row status too", () => {
    seedPrefs({ showCharacterIcons: false });
    const { container } = render(
      <MemberStatus statusmsg="[icon]Mara Quill[/icon]" />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("leaves eicons alone — they have their own preference", () => {
    seedPrefs({ showCharacterIcons: false });
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);
    expect(container.querySelector("img")).not.toBeNull();
  });
});

describe("showOthersStatus (#585)", () => {
  it("shows other people's statuses by default", () => {
    seedPrefs({});
    render(<MemberStatus statusmsg="open for RP" />);
    expect(screen.getByText("open for RP")).toBeDefined();
  });

  it("hides another member's status when off", () => {
    seedPrefs({ showOthersStatus: false });
    const { container } = render(<MemberStatus statusmsg="open for RP" />);
    expect(container.textContent).toBe("");
  });

  it("never hides your own — you must be able to see what you broadcast", () => {
    seedPrefs({ showOthersStatus: false });
    render(<MemberStatus statusmsg="open for RP" self />);
    expect(screen.getByText("open for RP")).toBeDefined();
  });

  it("defaults an unspecified row to hidden, not shown", () => {
    // `self` defaults to false so a new call site errs towards hiding: the
    // failure mode of a missed prop should be a missing status, not a leaked
    // one.
    seedPrefs({ showOthersStatus: false });
    const { container } = render(<MemberStatus statusmsg="open for RP" />);
    expect(container.textContent).toBe("");
  });
});

describe('eiconDisplay "off" (#585)', () => {
  it('renders the name chip with no image, unlike "inline"', () => {
    seedPrefs({ eiconDisplay: "off" });
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("sparkle")).toBeDefined();
  });

  it('does not preview on hover, which is what separates it from "name"', async () => {
    const user = userEvent.setup();
    seedPrefs({ eiconDisplay: "off" });
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);
    await user.hover(screen.getByText("sparkle"));
    expect(container.querySelector("img")).toBeNull();
  });

  it('"name" still previews on hover — the reason "off" had to exist', async () => {
    const user = userEvent.setup();
    seedPrefs({ eiconDisplay: "name" });
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);
    await user.hover(screen.getByText("sparkle"));
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("keeps the blocked chip's own styling distinct from off", () => {
    seedPrefs({ eiconDisplay: "off", eiconBlocked: ["sparkle"] });
    render(<RichText bbcode="[eicon]sparkle[/eicon]" />);
    // A blocked eicon still says so on hover; "off" is not a block.
    expect(screen.getByTitle("sparkle — blocked eicon")).toBeDefined();
  });

  it("hides the image in a member-row status as well", () => {
    seedPrefs({ eiconDisplay: "off" });
    const { container } = render(
      <MemberStatus statusmsg="mood [eicon]sparkle[/eicon]" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("sparkle");
  });
});
