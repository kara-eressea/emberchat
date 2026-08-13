// The M1 step-10 gate: the full slice against the real server + fchat-sim.
// One browser drives the app as Cindral; a raw sim client plays Birch Rowan
// on the other side of the relay (auth.spec owns Amber Vale — a character
// may only hold one sim connection, so the specs never share one).

import {
  delay,
  expect,
  expectCharacterOnline,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
  userScrollTo,
} from "./helpers.js";

/** How many channel messages Birch pumps in to force history pagination
 * (the initial REST page is 50). */
const SEED_COUNT = 70;
/** Above the sim's msg_flood window (50ms in the E2E world). */
const SEED_SPACING_MS = 80;

test("full slice: connect, join, chat both ways, PMs, live members, history scroll", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  // Register → identity → connect; the server-held session reaches the sim.
  await provisionAndConnect(page, "amber@example.test", "Cindral");

  // ── Join a channel ────────────────────────────────────────────────────
  await joinChannel(page, "Frontpage", "Frontpage");
  // Human-readable URL scheme (M3): identity by character name, channel by key.
  await expect(page).toHaveURL(/\/app\/Cindral\/c\/Frontpage$/);
  await expect(page.getByText("The sim's default hangout")).toBeVisible();

  // Member list: the three seeded NPCs plus us, grouped with role glyphs.
  const members = page.getByRole("complementary", { name: "Members" });
  await expect(members.getByRole("listitem")).toHaveCount(4);
  await expect(members.getByText("Nyx Firemane")).toBeVisible();
  await expect(members.getByText("Old Greywhisker")).toBeVisible();
  await expect(members.getByText("Cindral")).toBeVisible();

  // ── Member context menu (M6): right-click → §10 menu ──────────────────
  await members.getByText("Nyx Firemane").click({ button: "right" });
  const memberMenu = page.getByRole("menu", { name: "Nyx Firemane menu" });
  await expect(memberMenu).toBeVisible();
  // Frontpage is unowned ("" owner slot) — Nyx is a channel op.
  await expect(memberMenu.getByText("channel op @")).toBeVisible();
  await expect(
    memberMenu.getByRole("menuitem", { name: /Open on f-list\.net/ }),
  ).toHaveAttribute("href", "https://www.f-list.net/c/Nyx%20Firemane");
  await expect(
    memberMenu.getByRole("menuitem", { name: "Ignore" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(memberMenu).not.toBeVisible();

  // ── Profile viewer (M8 step 7): menu → modal, sim-served profile ───────
  await members.getByText("Nyx Firemane").click({ button: "right" });
  await memberMenu.getByRole("menuitem", { name: "View profile" }).click();
  const viewer = page.getByRole("dialog", { name: "Profile: Nyx Firemane" });
  await expect(viewer).toBeVisible();
  // The sim's default profile description renders through the BBCode body.
  await expect(viewer.getByText(/sim fixture character/)).toBeVisible();
  // The view lands in the history rail; Details resolves canned infotags.
  await expect(viewer.getByText("Recently viewed")).toBeVisible();

  // ── MatchStrip + Compare (M8 step 9) ───────────────────────────────────
  // Sim default profiles carry only a Gender infotag and no kinks, so the
  // matcher lands Neutral across the board — missing data is never a
  // mismatch. The strip proves the own-profile fetch; Full compare hands
  // off to the tab.
  await expect(viewer.getByText("Compatibility with Cindral")).toBeVisible();
  await viewer.getByRole("button", { name: /Full compare/ }).click();
  await expect(viewer.getByRole("tab", { name: "Compare" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    viewer.getByText("Not enough overlapping profile data for a verdict yet."),
  ).toBeVisible();
  await expect(
    viewer.getByRole("row").filter({ hasText: "Orientation" }),
  ).toBeVisible();
  await expect(
    viewer.getByText("No kinks appear on both lists — nothing to align."),
  ).toBeVisible();

  await viewer.getByRole("tab", { name: "Details" }).click();
  await expect(viewer.getByText("Gender")).toBeVisible();
  await expect(viewer.getByText("Female")).toBeVisible();
  // Insights against someone we share Frontpage with (#615). This used to
  // accept `/YOU × Nyx Firemane|crossed paths/` — the two branches are
  // mutually exclusive, so an alternation over both passed whichever way the
  // feature went and could only ever hide a regression.
  //
  // Which branch is deterministic here: `crossed` is true when messages were
  // exchanged, or the character was seen talking, or `sharedChannels` is
  // non-empty (ProfileViewer), and the server derives `sharedChannels` live
  // from session state — the channels whose member list holds the name. Nyx
  // is a seeded Frontpage member and we joined Frontpage above, so the
  // crossed branch is the only reachable one and the empty state is a bug.
  await viewer.getByRole("tab", { name: "Insights" }).click();
  await expect(viewer.getByText("YOU × Nyx Firemane")).toBeVisible();
  await expect(
    viewer.getByText("from your local history, never fetched from F-List"),
  ).toBeVisible();
  // The shared channel is what makes us "crossed" at all, so assert the value
  // and not just its label: "none right now" would mean the derivation broke
  // while the eyebrow still rendered. Exact text — the insight rows are label
  // and value spans, not table rows, so there is no row role to filter on.
  await expect(viewer.getByText("Shared channels")).toBeVisible();
  await expect(viewer.getByText("Frontpage", { exact: true })).toBeVisible();
  // No DMs with Nyx at this point, which the Conversation group states
  // positively. Exact again: the provenance line above contains the word
  // "never" mid-sentence, and a substring match would pass on that alone.
  await expect(viewer.getByText("Last chatted")).toBeVisible();
  await expect(viewer.getByText("never", { exact: true })).toBeVisible();
  // And the branch this test used to tolerate must be absent.
  await expect(
    viewer.getByText("You haven't crossed paths yet"),
  ).not.toBeVisible();

  // ── Images + Guestbook (M8 step 10) ────────────────────────────────────
  // Images come from the cached character-data payload (fixture-seeded in
  // global-setup, hotlinks intercepted); the lightbox overlays the modal.
  await viewer.getByRole("tab", { name: "Images" }).click();
  await expect(
    viewer.getByRole("button", { name: "Image 1 of 3" }),
  ).toBeVisible();
  await viewer.getByRole("button", { name: "Image 2 of 3" }).click();
  const lightbox = viewer.getByRole("dialog", { name: "Image 2 of 3" });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByText("2/3")).toBeVisible();
  await expect(lightbox.getByText("A portrait")).toBeVisible();
  await lightbox.getByRole("button", { name: "Next image" }).click();
  await expect(
    viewer.getByRole("dialog", { name: "Image 3 of 3" }).getByText("3/3"),
  ).toBeVisible();
  // Escape closes the lightbox, not the profile modal underneath.
  await page.keyboard.press("Escape");
  await expect(
    viewer.getByRole("dialog", { name: /Image \d/ }),
  ).not.toBeVisible();
  await expect(viewer).toBeVisible();

  // Guestbook: 12 seeded posts → page one shows 10, Load more fetches the
  // rest; the owner reply renders as a quoted block.
  await viewer.getByRole("tab", { name: "Guestbook" }).click();
  await expect(
    viewer.getByText("Wonderful company around the fire."),
  ).toBeVisible();
  await expect(viewer.getByText("Nyx Firemane replied")).toBeVisible();
  await expect(viewer.getByText("Guestbook entry number 9.")).toBeVisible();
  await expect(
    viewer.getByText("Guestbook entry number 11."),
  ).not.toBeVisible();
  await viewer.getByRole("button", { name: "Load more" }).click();
  await expect(viewer.getByText("Guestbook entry number 11.")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();

  // ── Mini profile card (M8 step 8): member row click → §13 popover ─────
  await members.getByText("Old Greywhisker").click();
  const card = page.getByRole("dialog", {
    name: "Profile card: Old Greywhisker",
  });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Message" })).toBeVisible();
  // Step 9: the compatibility block rides the card once own data exists.
  await expect(card.getByText("Compatibility")).toBeVisible();
  // "Open profile" hands off to the full viewer and closes the popover.
  await card.getByRole("button", { name: "Open profile" }).click();
  await expect(card).not.toBeVisible();
  const greyViewer = page.getByRole("dialog", {
    name: "Profile: Old Greywhisker",
  });
  await expect(greyViewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(greyViewer).not.toBeVisible();

  // Message opens (and routes to) the DM thread; back for the rest.
  await members.getByText("Nyx Firemane").click({ button: "right" });
  await memberMenu.getByRole("menuitem", { name: "Message" }).click();
  await expect(page).toHaveURL(/\/dm\/Nyx%20Firemane$/);
  await expect(
    page.getByRole("heading", { name: "Nyx Firemane" }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: /Frontpage/ })
    .click();
  await expect(page.getByRole("heading", { name: "Frontpage" })).toBeVisible();

  // ── Send a channel message (persisted, echoed back via the gateway) ───
  const log = page.getByTestId("message-log");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Hello from the ember side");
  await composer.press("Enter");
  await expect(log.getByText("Hello from the ember side")).toBeVisible();
  await expect(composer).toHaveValue("");

  // ── The other side: Birch Rowan joins live ────────────────────────────
  const birch = await SimClient.connect(
    "birch@example.test",
    "hunter2",
    "Birch Rowan",
  );
  try {
    birch.send("JCH", { channel: "Frontpage" });
    // Live member-list update, no refresh.
    await expect(members.getByRole("listitem")).toHaveCount(5);
    await expect(members.getByText("Birch Rowan")).toBeVisible();

    // Receive a channel message.
    birch.send("MSG", { channel: "Frontpage", message: "Evening, all." });
    await expect(log.getByText("Evening, all.")).toBeVisible();

    // Log nicks open the mini profile card too (M8 step 8).
    await log.getByRole("button", { name: "Birch Rowan" }).first().click();
    const nickCard = page.getByRole("dialog", {
      name: "Profile card: Birch Rowan",
    });
    await expect(nickCard).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(nickCard).not.toBeVisible();

    // ── PMs, both directions ────────────────────────────────────────────
    birch.send("PRI", {
      recipient: "Cindral",
      message: "A word in private?",
    });
    const nav = page.getByRole("navigation");
    const dmRow = nav.getByRole("link", { name: /Birch Rowan/ });
    await expect(dmRow).toBeVisible();
    await expect(dmRow).toContainText("1"); // unread badge
    await dmRow.click();
    await expect(log.getByText("A word in private?")).toBeVisible();

    const received = birch.waitFor(
      "PRI",
      (payload: { character: string; message: string }) =>
        payload.character === "Cindral" && payload.message === "On my way.",
    );
    await composer.fill("On my way.");
    await composer.press("Enter");
    await received;

    // ── Seed history past one REST page, then prove scroll-up loads it ──
    await nav.getByRole("link", { name: /Frontpage/ }).click();
    await expect(
      page.getByRole("heading", { name: "Frontpage" }),
    ).toBeVisible();
    for (let i = 1; i <= SEED_COUNT; i += 1) {
      birch.send("MSG", {
        channel: "Frontpage",
        message: `seed #${String(i)}`,
      });
      await delay(SEED_SPACING_MS);
    }
    await expect(
      log.getByText(`seed #${String(SEED_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Reload: the server-held session stayed online (the bouncer property);
    // the deep link routes straight back into Frontpage and the log
    // backfills its latest page over REST.
    await page.reload();
    await expect(
      log.getByText(`seed #${String(SEED_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expectCharacterOnline(page, "Cindral");

    // Scroll to the top repeatedly; each pass pages older history in until
    // the very first message of the conversation is on screen.
    await expect(async () => {
      await userScrollTo(page, 0);
      await expect(log.getByText("Hello from the ember side")).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 20_000 });

    // ── Jump to recent (#231): scrolled up, the floating pill appears;
    // both Esc and the pill snap back to the newest messages ──────────────
    const jumpPill = page.getByTestId("jump-to-recent");
    await expect(jumpPill).toBeVisible();
    // Esc returns to the bottom (Discord parity) — no popover is open, so the
    // otherwise-unhandled key reaches the log.
    await page.keyboard.press("Escape");
    await expect(
      log.getByText(`seed #${String(SEED_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(jumpPill).not.toBeVisible();
    // Scroll back up and use the pill button itself.
    await expect(async () => {
      await userScrollTo(page, 0);
      await expect(jumpPill).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await jumpPill.click();
    await expect(
      log.getByText(`seed #${String(SEED_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(jumpPill).not.toBeVisible();
    // The jump must land fully at the bottom, not short (#266): setting
    // scrollTop to the estimated height once could leave a gap that the
    // pill kept showing. The re-stick across settle frames closes it.
    await expect
      .poll(
        () =>
          log.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(2);

    // ── In-log search + jump-to-context (M9 step 3) ───────────────────────
    // The search field lives on the header toolbar and owns the query;
    // focusing it drops the results panel underneath.
    const searchInput = page.getByRole("textbox", { name: "Search log" });
    await searchInput.click();
    const searchPanel = page.getByRole("dialog", { name: "Search log" });
    await expect(searchPanel).toBeVisible();
    // The from: filter rides along to prove the mini-language end to end.
    await searchInput.fill('seed #33 from:"birch rowan"');
    await searchInput.press("Enter");
    const hit = searchPanel.getByRole("button", { name: /seed #33/ });
    await expect(hit).toBeVisible({ timeout: 10_000 });
    await hit.click();
    // Jumping dismisses the panel — it hangs over the log it just moved.
    await expect(searchPanel).not.toBeVisible();
    // The log lands on the history page containing the hit and detaches
    // from the live tail.
    await expect(
      log.getByText("Viewing older history", { exact: false }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(log.getByText("seed #33", { exact: true })).toBeVisible();
    await log.getByRole("button", { name: "Back to present" }).click();
    await expect(
      log.getByText(`seed #${String(SEED_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    // Reopening keeps the query, and Escape closes the panel again.
    await searchInput.click();
    await expect(searchPanel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(searchPanel).not.toBeVisible();
  } finally {
    birch.close();
  }
});
