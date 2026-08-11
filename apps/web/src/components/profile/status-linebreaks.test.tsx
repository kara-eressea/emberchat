// @vitest-environment jsdom
//
// #583: a status message carries its own line breaks — the case that made it
// visible is a 2x2 eicon grid, authored as two rows and rendered as one
// wrapping run, which splits the icons that were meant to sit under each
// other. The message log has always been right (`.body` is pre-wrap); the two
// profile surfaces were not.
//
// Two halves, because either alone would let the bug back in: the render path
// has to hand the newline through to the DOM, and the stylesheet has to be
// told not to collapse it. jsdom applies no stylesheet, so the CSS half is
// asserted as text — the shape base.test.ts and popover.test.ts use.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Header } from "./ProfileViewer.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";

// Read as text rather than imported: vitest stubs CSS imports out. Vitest's
// cwd is the web app.
const profileCss = readFileSync(
  resolve("src/components/profile/profile.module.css"),
  "utf8",
);

/** A rule's body, so an assertion cannot match a declaration in its neighbour. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} not found`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
});

function seedSession(name: string, statusmsg: string) {
  const session = {
    identityId: "id1",
    character: "Me",
    channels: { Frontpage: { members: [{ character: name, statusmsg }] } },
    dms: {},
  } as unknown as IdentitySession;
  useSessionsStore.setState({ sessions: { id1: session } });
}

const profile = { name: "Ada Lovelace", infotagGroups: [] } as never;

describe("status message line breaks (#583)", () => {
  // Both surfaces render the same status through the same RichText, so they
  // broke together and are fixed together.
  it.each([".cardStatus", ".headerStatus"])(
    "%s preserves authored newlines",
    (selector) => {
      expect(ruleBody(profileCss, selector)).toContain("white-space: pre-wrap");
    },
  );

  // The CSS above is only worth anything if the newline survives the BBCode
  // parse and reaches a text node. If this fails, pre-wrap has nothing to act
  // on and the fix is in the render path instead.
  it("hands the newline between two eicon rows through to the DOM", () => {
    seedSession(
      "Ada Lovelace",
      "[eicon]one[/eicon][eicon]two[/eicon]\n[eicon]three[/eicon][eicon]four[/eicon]",
    );
    const { container } = render(<Header identityId="id1" profile={profile} />);
    const line = container.querySelector("div[class*='headerStatus']");
    expect(line?.textContent).toContain("\n");
  });

  it("leaves a single-line status alone", () => {
    seedSession("Ada Lovelace", "[b]Looking[/b] for adventures");
    const { container } = render(<Header identityId="id1" profile={profile} />);
    const line = container.querySelector("div[class*='headerStatus']");
    expect(line?.textContent).not.toContain("\n");
    expect(screen.getByText(/Looking/)).toBeInTheDocument();
  });
});
