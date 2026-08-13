# Feature-parity audit vs. the official F-Chat 3.0 client

> **Historical snapshot — read as a record, not a plan.** This is what the
> comparison looked like at M6 (2026-07-15). Its five `❓ decision` items were
> all made, and the outcomes are recorded in the Decisions section at the
> bottom. Its `📅 M8` labels predate the MX desktop and MP mobile tracks and no
> longer describe the plan — "Auto-updater, tray, Electron shell 📅 M8" became
> the whole MX track, for instance. Nothing here is a backlog: open work is on
> the issue board (`gh issue list`).

M6 step 8 (2026-07-15). Compares EmberChat against the official client
(github.com/f-list/exported, "chat3client") feature by feature, and lists
the popular Rising fork's additions separately. Sources: the official
client's `chat/localize.ts` string inventory and `chat/slash_commands.ts`,
its component tree, the fchat-rising archive, and the F-List wiki.

Verdict shorthand:

- **✅ Mx** — shipped, milestone noted.
- **📅 Mx** — planned, on a milestone checklist.
- **≠ design** — deliberately different by design; no action.
- **❓ decision** — needs a user decision; collected at the bottom.
- **⛔ out of scope** — not planned; reason given.

## Where EmberChat already goes beyond the official client

The official client has none of these; they are the product's reason to
exist (project-description.md):

- Server-held sessions: stay online with no browser attached, multi-device
  login, catch-up on missed history with unread cursors (M2/M4).
- Server-side history in Postgres — logs exist without the app running,
  browsable/exportable from any device (M1–M5).
- Markdown composing translated to BBCode, live preview (M4).
- Delayed send with recall — the closest thing to message editing F-Chat
  can support (M4).
- Outbound typing suppression (delayed sends never leak typing state) and
  per-recipient TPN dedup (M4).
- Granular highlight rules (word/nick/regex) matched server-side at persist
  time, so badges are consistent across devices (M5).
- Detached auto-away — away when no device is attached (M5, beyond scope).

## Feature map — official client (base)

### Conversations, channels, composing

| chat3client feature | EmberChat |
|---|---|
| Channel/PM/console tabs | ✅ M1–M3 — sidebar + main pane; **console** is ≠ design: global SYS/ERR surface as a dismissable notice strip, durable channel SYS persist into the channel log |
| Channel browser (official/open, filter, create) | ✅ M6 |
| Pin/close/unread per conversation | ✅ M2/M3 (pinning doubles as the reconnect-rejoin set) |
| Recent conversations | ≠ design — conversations are server-persisted and never vanish from the sidebar unless removed; "recent" is the DM list itself |
| Channel modes chat/ads/both + ad countdown | ✅ M6 (mode gating) + **M10** (per-channel "next allowed in Xm" in the post flow via the `ads.cooldowns` query; the composer still surfaces flood refusals in friendly copy) |
| In-tab message search | 📅 M8 (client polish; server history makes this a REST query, arguably better than chat3's buffer-only search) |
| Tab settings (per-conversation overrides) | ≠ design — per-conversation mute exists (M5); finer per-tab overrides deferred until asked for |
| Typing indicators (PMs) | ✅ M4 (both directions) |
| BBCode toolbar | ✅ M4 (Markdown-first; toolbar hints for bold/code/eicon; full toolbar is M8 polish) |
| Enter-sends toggle | ⛔ — Enter sends, Shift+Enter breaks; no demand yet |
| /me, /roll, /bottle | ✅ M4 (/me as emote), M6 (/roll, /bottle) |
| Slash-command help ("?") | 📅 M8 — the framework exists (M6); a help surface lands with the composer polish pass |
| Copy with/without BBCode | ⛔ — browser selection copies rendered text; revisit on demand |

### Discovery and profiles

| chat3client feature | EmberChat |
|---|---|
| **Character search (FKS)** — kinks/genders/orientations/languages/roles filters | ✅ **M10** (full filter set, client-side name filter over the returned names, cache-only match chips, saved searches with a "N new" rerun diff) |
| **In-app profile viewer** (character-data API: infotags, kinks, images, guestbook, memos) | ❓ **decision 2** — today profile links open f-list.net in a new tab (deliberate M6 choice) |
| Memo dialog | folds into decision 2 (same API family) |
| Report character from profile | folds into decision 4 (SFC) |

### Notifications and presence

| chat3client feature | EmberChat |
|---|---|
| **RTB events** (notes, friend requests, helpdesk/comment replies) | ❓ **decision 3** — currently logged and swallowed |
| Desktop notifications, sounds, mention highlighting, highlight words | ✅ M5 (regex rules go beyond chat3) |
| Status switcher + statusmsg | ✅ M3 |
| Idle auto-away | ✅ M5 (plus detached-away, which chat3 cannot have) |
| Broadcasts (BRO) shown + notified | ❓ **decision 5** — currently logged and swallowed; admin broadcasts are rare but server-critical |
| Login/logout/status/join/leave event lines | ✅ M5 (presence lines behind a pref) |

### Friends, bookmarks, users

| chat3client feature | EmberChat |
|---|---|
| Friends/bookmarks lists + colored members | ✅ M6 sidebar sections; member-list coloring 📅 M8 polish |
| Right-click user menu (profile, PM, bookmark, ignore, memo, report, kick) | ✅ M6 (memo/report per decisions 2/4) |
| Friend request send/accept/deny/cancel | ✅ M6 |
| Ignore list (/ignore etc. + anti-circumvention notify) | ✅ M3 (IGN notify included) |
| Hide ads from specific users | ≠ design — EmberChat has a view default + per-channel Chat/Ads/Both selector (M6 boolean → M10 tri-state); M11's ratings cover the sharper want (≤2★ posters collapse to a stub); full per-user hiding stays pooled |
| Click-user behavior setting | ⛔ — left-click profile, right-click menu, Message item for PMs |

### Logs and settings

| chat3client feature | EmberChat |
|---|---|
| Local logs + log browser + export (txt/html) | ✅ M5, ≠ design — server-side logs, export as txt/html/json; no corruption-repair tool needed (Postgres) |
| Settings sync/import between characters | ✅ M5, ≠ design — prefs are per app account, synced across devices by construction |
| Themes + custom themes | ✅ M5 (base themes + accent swap); custom user themes ⛔ v1.0+ |
| Spellcheck | ≠ design — the browser provides it |
| slimCat import | ⛔ |
| Auto-updater, tray, Electron shell | 📅 M8 (Electron wrapper milestone) |

### Moderation and staff

| chat3client feature | EmberChat |
|---|---|
| Channel op tools (kick/ban/unban/banlist/timeout/op/deop/setowner/invite/open-close/setmode/setdescription) | ✅ M6 |
| Manage Channel dialog | ✅ M6 (RoomChip popover; a fuller dialog is M8 polish) |
| /warn formatted warnings, /code channel link | 📅 M8 (slash polish) |
| **Alert Staff (SFC) report dialog with attached logs** | ❓ **decision 4** |
| Global staff tools (gkick/gban/broadcast/…) | ⛔ — F-List staff tooling; EmberChat targets regular users and chanops. Revisit only if staff ever ask |
| killchannel | ⛔ with the staff set |

### Wire commands still logged-and-swallowed (policy-compliant)

`FKS` `RTB` `BRO` `SFC` `UPT` `KID` `PRD` `AOP` `DOP` and the admin-only
client set (`ACB CRC KIK TMO UNB RWD AWC RLD XYZ`). `UPT`/`KID`/`PRD` are
legacy or trivia; the rest are covered by the decisions below or the staff
⛔ above.

## Rising fork (out of parity scope, listed as future inspiration)

The parity target is the official client. Rising's additions are noted for
later milestones, not gaps: profile match scoring and kink comparison,
smart filters with auto-reply, ad ratings *(✅ shipped M11 — local ★1–5 +
note, ≤2★ collapse; never sent to F-List)*, link/image hover previews,
search history and extra search filters, status-message history, unread
counters, colorblind mode. Two cautions: **auto ad posting** (rotation/
reposting) is automation the F-List policy environment may frown on for a
hosted service — treat as ⛔ unless cleared *(cleared for the self-host
admin-only posture and shipped M11 as attached-only campaigns: 12-min
floors, honored `[ads: N min]`, 1-hour renewable expiry, visible pauses,
kill switch — see `milestone-11-discovery-extras.md`)*; smart-filter
auto-replies send messages on the user's behalf — same caution (still ⛔,
parked in the M11 deferred pool).

## Decisions (made with the user, 2026-07-15)

1. **FKS character search — skipped for now, revisit later.** No in-app
   search for v1.0; recorded on the post-v1.0 wishlist in `milestones.md`.
   *(Superseded 2026-07-16: scoped into **M10**,
   `milestone-10-ads-and-search.md`; **shipped 2026-07-18** with M10
   step 9.)*
2. **In-app profile viewer — eventually, but not v1.0.** Website links
   stay for now; the viewer (character-data + mapping-list, memos riding
   along, <200 character-data requests/hour budget) joins the post-v1.0
   wishlist. *(Superseded 2026-07-16: committed as **M8** scope —
   `milestone-8-nice-to-haves.md`, decisions.md §11.)*
3. **RTB note/notification bridge — surface as notifications.** Landed in
   M6 step 9: RTB parses, notes/friend requests/comment replies show as
   notices, notes + friend requests optionally raise desktop notifications
   behind the new `desktopNotifyNotes` pref, and inbound friend requests
   auto-refresh the sidebar's social lists. Reading and acting stay on
   f-list.net.
4. **SFC "Alert Staff" reporting — M7.** Added to the M7 scope: a hosted
   client should let users reach F-List staff.
5. **BRO admin broadcasts — surfaced.** Landed in M6 step 9: BRO parses
   and fans out as a global notice ("Server broadcast: …").
