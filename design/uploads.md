# UP — Chat uploads

Design for #594: upload an image from the composer, get a link, post it.

Status: **spec for review, nothing built.** Written 2026-08-13 after the issue
was triaged as milestone-sized rather than issue-sized. Sections 1–8 are the
implementation once the four decisions in §0 are settled.

## Why this is a milestone

The issue asks for four things — upload, scrub, link, gallery — and the server
has none of the machinery for any of them. There is no multipart parser, no
storage layer, no image processing, and no route that serves bytes we produced
(`plugins/web-static.ts` serves the built SPA and nothing else). Every one of
those is new surface.

More importantly, the feature changes what an EmberChat instance *is*. Today
the server holds chat state and talks to F-List; nothing it hosts is reachable
without an auth cookie. Uploads make it a public file host, because the people
who need to load the image are on the **official F-Chat client** and have no
account here. That is not a detail to discover during the build.

## 0. Decisions to settle first

Four forks in the road. Recommendations given; all are the user's call.

### 0.1 Video: in or out of v1?

The issue says "image or video". Images can be scrubbed and re-encoded with one
library. Video cannot: stripping container/track metadata and generating a
poster frame means ffmpeg — a very large dependency in the image, a second
codec-licensing question, and a much longer job than a request should run
inline.

**Recommendation: images in v1, video as its own follow-up.** Everything below
is written so video slots in later as a second `kind` without reshaping the
schema or the routes.

### 0.2 Scrub by re-encode, or by metadata strip?

Two ways to honour "file name and EXIF data should be cleared":

- **Re-encode** (`sharp`/libvips). Decode, apply EXIF orientation, re-emit in a
  fixed format. Metadata is gone because nothing carries it over, and the bytes
  we serve are bytes *we* produced — which also kills polyglot files (a JPEG
  that is also valid HTML) before they can matter. Costs a native dependency.
- **Strip in place** (pure JS). Drop JPEG `APPn` segments and non-critical PNG
  chunks, leave the pixel data untouched. No native dependency, no quality
  loss, but the file we serve is still substantially the file we were handed.

**Recommendation: re-encode.** The polyglot defence is the deciding factor
given §0.3 — we serve this content from the app's own origin. Native-dependency
cost is manageable if `sharp` is a lazy `import()` behind the upload route: the
embedded desktop server (§6) never has uploads enabled, so it never loads it,
which sidesteps the Electron ABI question rather than solving it.

### 0.3 Same origin, or a second one?

User content served from the app's own origin is the classic stored-XSS shape:
anything the browser can be talked into treating as HTML runs as us. The clean
answer is a second origin (`media.example.com`), which is also a second DNS
name and a second certificate for every self-hoster.

**Recommendation: same origin, defended in depth** — reject SVG outright, serve
only formats we re-encoded into, `X-Content-Type-Options: nosniff`,
`Content-Disposition: inline` with a filename we generated, and
`Content-Security-Policy: sandbox` on the media response itself. Document the
second-origin option for anyone who wants it, and make the base URL
configurable (§3) so choosing it later is config, not a rewrite.

### 0.4 What is the admin agreeing to host?

An EmberChat instance with uploads on is publicly hosting whatever its users
paste, at URLs that work for anyone. On an adult chat network that is a real
exposure for whoever's name is on the VPS. It is also, unlike everything else
in this project, storage that grows without bound.

**Recommendation: uploads are opt-in per instance** (`UPLOADS_ENABLED`,
default **off**), with the exposure spelled out in `docs/self-hosting.md` and a
new entry in `design/risks-and-open-questions.md`. Nothing here changes our
F-List posture — we post a URL like any other client — but the hosting is ours.

## 1. Storage

Files on disk, records in Postgres. No object store: the deployment story is one
VPS with docker-compose, and S3 would add a credential and a network hop to a
feature whose whole job is "serve these bytes".

```
${UPLOAD_DIR}/<aa>/<bb>/<sha256>.<ext>
```

Content-addressed by the SHA-256 of the **re-encoded** bytes, two levels of
fan-out so no directory holds a million entries. Content addressing gives
deduplication for free, which is half of the issue's gallery request
("prevent uploading the same thing several times") — the same image uploaded
twice is one file and one URL.

**The public path is not the storage path.** Serving by content hash would let
anyone who has seen a file prove another user uploaded it, and hash-guessing a
known image is trivial. Each upload row carries its own `token`: 16 random bytes
from `randomBytes`, base64url. Deliberately **not** `uuidv7()` — the schema's
default id everywhere else is time-ordered, which is exactly wrong for a value
whose only protection is being unguessable.

Two rows may point at one file. Delete removes the row; the file goes when the
last row referencing its hash does.

## 2. Schema

```ts
export const uploads = pgTable(
  "uploads",
  {
    id: uuid().primaryKey().default(uuidv7),
    userId: uuid().notNull().references(() => appUsers.id, { onDelete: "cascade" }),
    /** Public URL segment — random, not derived from anything. */
    token: text().notNull().unique(),
    /** SHA-256 of the stored (re-encoded) bytes; the on-disk filename. */
    sha256: text().notNull(),
    kind: uploadKind().notNull(),          // "image" (video later, §0.1)
    mime: text().notNull(),                // what we re-encoded *to*
    bytes: integer().notNull(),
    width: integer(),
    height: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Touched on serve, throttled — feeds retention (§3), not analytics. */
    lastAccessedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    index().on(table.userId, table.createdAt.desc()),  // the gallery's query
    index().on(table.sha256),                          // last-reference check
  ],
);
```

No original filename column. The issue asks for the name to be cleared, and the
surest way not to leak it is not to store it.

## 3. Config

| Key | Default | Meaning |
|---|---|---|
| `UPLOADS_ENABLED` | `false` | Master switch (§0.4). Off = routes not registered, UI hides the control. |
| `UPLOAD_DIR` | `/data/uploads` | Storage root. A compose volume, sibling of `pgdata`. |
| `UPLOAD_MAX_BYTES` | `10485760` (10 MiB) | Per file, enforced by the multipart parser before we hold the whole thing. |
| `UPLOAD_USER_QUOTA_BYTES` | `1073741824` (1 GiB) | Sum of a user's rows. Exceeded = a clear error, never a silent eviction. |
| `UPLOAD_RETENTION` | `forever` | `forever` \| `30d` \| `90d` \| `1y`, mirroring `RETENTION_POLICY`'s vocabulary and swept by the same job shape. |
| `UPLOAD_BASE_URL` | unset → `APP_BASE_URL` | The origin links are built from, so §0.3's second origin is config. |

## 4. Server module `modules/uploads/`

**`POST /api/uploads`** — authenticated, `@fastify/multipart`, one file per
request. Rate-limited well below the general limit; this writes to disk.

The pipeline, in order, refusing early:

1. Size cap at the parser, so an oversized body is rejected mid-stream.
2. Sniff the **magic bytes**, never the client's `Content-Type` or extension.
   Accept JPEG, PNG, WebP, GIF, AVIF. **SVG is rejected** (§0.3).
3. Decode, apply EXIF orientation, re-encode. Metadata does not survive; the
   orientation step is what stops correctly-tagged photos coming out sideways.
   GIF keeps animation (re-encode as GIF/animated WebP rather than flattening).
4. Hash the result, check the quota, write the file (temp file + atomic
   `rename`, so a crash never leaves a half file at a real path), insert the row.
5. Return `{ token, url, width, height, bytes, mime }`.

**`GET /u/:token`** — public, no auth, this is the point of the feature.

- `Content-Type` from the row, never from the request.
- `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`.
- `Content-Disposition: inline; filename="<token>.<ext>"`.
- `Cache-Control: public, max-age=31536000, immutable` — the bytes at a token
  never change.
- Range requests supported (free via `@fastify/static`'s sender; matters when
  video lands).
- Its own rate limit bucket, keyed by IP: this route is reachable by the world.

**`GET /api/uploads`** — the gallery. The user's own rows, newest first, cursor
paginated like history.

**`DELETE /api/uploads/:id`** — own rows only. Removes the file when no other
row shares its hash.

**Retention sweep** — extends `history/retention.ts`'s existing job rather than
adding a second scheduler.

## 5. Web client

**Composer.** A paperclip button, plus paste-from-clipboard and drag-and-drop
onto the composer — both of which are how people actually do this. Upload
happens immediately on drop with an inline progress row; on success the URL is
inserted at the cursor as a plain link. It is a normal message from there, so
delayed send, the markdown→BBCode translation and every length limit apply
unchanged.

**Gallery.** A panel listing the user's uploads as a thumbnail grid: click to
insert into the composer, copy link, delete. Reached from the composer button
and from Preferences. This is the issue's "post them into a new chat" request,
and dedup by hash (§1) means re-uploading a duplicate quietly lands on the
existing entry instead of growing the grid.

**Deletion is honest about what it can't do.** A link already posted lives in
other people's logs and on the official client's screen; deleting the upload
breaks that image for them rather than unsending it. The confirm dialog says so.

**Preview.** Our own host must be on the link-preview allowlist for the inline
preview to render — `UPLOAD_BASE_URL`'s host is added to
`DEFAULT_IMAGE_PREVIEW_HOSTS`' effective set at runtime rather than being
something each user has to add by hand. (Same-origin already clears the CSP:
`img-src 'self'`.)

## 6. Desktop

The two modes answer differently, and the difference is not cosmetic.

**Thin client** — the renderer talks to a real, publicly reachable instance.
Uploads work exactly as in the browser; nothing extra to build.

**Embedded (pglite) mode** — the server is on loopback. A link to
`http://127.0.0.1:39xxx/u/<token>` is unreachable for every recipient, and the
recipient is the entire point. So: **uploads are unavailable in embedded mode**,
the composer control is hidden, and the Preferences entry explains why in one
sentence. `UPLOADS_ENABLED` is forced off by the desktop's config seeding, which
is also what keeps `sharp` unloaded there (§0.2).

## 7. Tests

- **Scrub, provably.** A fixture JPEG with GPS EXIF and a distinctive filename;
  assert the stored bytes contain neither, and that the pixels survived the
  orientation fix (a rotated fixture compares against its expected corner).
- **Sniffing beats claims.** An SVG named `.png` with an `image/png` header is
  rejected; a valid PNG named `.txt` is accepted.
- **Token unguessability is structural**, so the test is that the public path is
  not derived from the hash, the id, or the time — assert two uploads of the
  *same bytes* by the same user get the same `sha256` and different `token`s.
- **Quota** rejects at the boundary and the rejected upload leaves no file.
- **Dedup** stores one file for two uploads, and deleting one row keeps the file
  until the second row goes.
- **The public route needs no cookie**, and carries `nosniff` + sandbox headers.
- **Crash safety**: an interrupted write leaves no file at a servable path.
- **Embedded desktop** refuses to register the routes.
- **E2E**: drop a file on the composer, see the link inserted, see the preview
  render, find it in the gallery, delete it.

## 8. Docs

- `docs/self-hosting.md`: the `UPLOADS_ENABLED` opt-in, the exposure in plain
  words (§0.4), the volume, and — importantly — that **backups now have a
  second half**. The bundled `backup` service does `pg_dump` only; a database
  dump without `${UPLOAD_DIR}` restores rows pointing at files that are gone.
- `docs/desktop.md`: why the paperclip isn't there in embedded mode.
- `design/risks-and-open-questions.md`: hosting third-party adult content on the
  admin's own box, and unbounded storage growth.

## Package cut

Dependency-ordered, each landable on its own:

- **UP-A — storage + schema + config.** The module's guts with no HTTP: write,
  hash, dedup, quota, delete, sweep. Fully testable without a route.
- **UP-B — the two routes.** `POST /api/uploads` and public `GET /u/:token`,
  with the scrub pipeline and the header set.
- **UP-C — composer.** Button, paste, drag-drop, progress, insertion.
- **UP-D — gallery.** List, insert, copy, delete.
- **UP-E — desktop + docs.** Embedded-mode refusal, self-hosting and desktop
  docs, the risks entry, the backup correction.

Video (§0.1), if it happens, is UP-F and touches §2's `kind`, §4's pipeline and
nothing else.

## Open questions

1. **§0.1–0.4** — the four decisions above.
2. **Does the gallery need folders or tags?** The issue doesn't ask for them and
   a reverse-chronological grid with dedup may be enough. Cheaper to add later
   than to guess now.
3. **Should an upload be attributable to a character?** Rows hang off the app
   user today. Filtering the gallery by the identity that posted it would need
   an `identityId` column, which is cheap to add now and awkward to backfill.
