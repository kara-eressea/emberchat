import { describe, expect, it, vi } from "vitest";
import { DEFAULT_IMAGE_PREVIEW_HOSTS } from "@emberchat/protocol";
import {
  contentSecurityDirectives,
  extraMediaSourceString,
  mediaHostSources,
  sanitizePreviewHost,
  unionPreviewHosts,
} from "./csp.js";
import { ImagePreviewHostRegistry } from "./image-preview-hosts.js";

describe("contentSecurityDirectives (#335)", () => {
  const directives = contentSecurityDirectives();

  it("permits the Discord CDN and twimg image hosts the client previews", () => {
    // The reported failure: these were blocked by img-src while f-list worked.
    const imgSrc = directives["img-src"];
    expect(imgSrc).toContain("https://cdn.discordapp.com");
    expect(imgSrc).toContain("https://media.discordapp.net");
    expect(imgSrc).toContain("https://pbs.twimg.com");
  });

  it("still permits f-list static avatars/eicons and inline data URIs", () => {
    const imgSrc = directives["img-src"];
    expect(imgSrc).toContain("https://static.f-list.net");
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain("data:");
  });

  it("mirrors every default preview host so shipped defaults just work", () => {
    for (const host of DEFAULT_IMAGE_PREVIEW_HOSTS) {
      expect(directives["img-src"]).toContain(`https://${host}`);
    }
  });

  it("admits unpredictable CDN subdomains of a permitted host (#593)", () => {
    // The reported case: a provider serving from per-CDN subdomains under a
    // host the client's allowlist matcher has always accepted as a suffix.
    expect(directives["img-src"]).toContain("https://*.pbs.twimg.com");
    expect(directives["media-src"]).toContain("https://*.cdn.discordapp.com");
  });

  it("permits the same hosts for <video> previews via media-src", () => {
    const mediaSrc = directives["media-src"];
    expect(mediaSrc).toContain("'self'");
    expect(mediaSrc).toContain("https://cdn.discordapp.com");
    expect(mediaSrc).toEqual(expect.arrayContaining(mediaHostSources()));
  });

  it("keeps scripts and framing locked down", () => {
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
  });
});

describe("mediaHostSources", () => {
  it("prefixes every default host with the https scheme", () => {
    for (const source of mediaHostSources()) {
      expect(source).toMatch(/^https:\/\/(?:\*\.)?[a-z0-9.-]+$/);
    }
  });

  it("emits a subdomain wildcard beside each host (#593)", () => {
    // Both forms are required: a CSP `*.example.com` matches any number of
    // leading labels but never the apex.
    for (const host of DEFAULT_IMAGE_PREVIEW_HOSTS) {
      expect(mediaHostSources()).toContain(`https://${host}`);
      expect(mediaHostSources()).toContain(`https://*.${host}`);
    }
  });
});

describe("sanitizePreviewHost (#342)", () => {
  it("accepts and lowercases a bare hostname", () => {
    expect(sanitizePreviewHost("wimg.rule34.xxx")).toBe("wimg.rule34.xxx");
    expect(sanitizePreviewHost("  WimG.Rule34.XXX  ")).toBe("wimg.rule34.xxx");
  });

  it("rejects anything that isn't a bare hostname", () => {
    for (const hostile of [
      "https://evil.example", // scheme
      "evil.example/path", // path
      "evil.example:443", // port
      "*.evil.example", // wildcard
      "evil.example twim.evil", // whitespace → two tokens
      "evil.example;script-src *", // directive injection
      "a,b.example", // comma
      "'none'", // csp keyword
      "data:", // scheme-only
      "localhost", // single label
      "",
      "   ",
    ]) {
      expect(sanitizePreviewHost(hostile)).toBeUndefined();
    }
  });

  it("rejects non-string entries", () => {
    for (const value of [null, undefined, 42, {}, ["x.example"], true]) {
      expect(sanitizePreviewHost(value)).toBeUndefined();
    }
  });
});

describe("unionPreviewHosts (#342)", () => {
  it("unions, sanitizes, lowercases, dedupes and sorts every user's list", () => {
    const union = unionPreviewHosts([
      { imagePreviewHosts: ["wimg.rule34.xxx", "Foo.Example"] },
      { imagePreviewHosts: ["foo.example", "bar.example"] },
      { imagePreviewHosts: [] },
      {}, // no key
      null, // not an object
      { imagePreviewHosts: "not-an-array" },
    ]);
    expect(union).toEqual(["bar.example", "foo.example", "wimg.rule34.xxx"]);
  });

  it("drops hostile entries and warns, keeping the valid ones", () => {
    const warn = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const union = unionPreviewHosts(
      [
        {
          imagePreviewHosts: [
            "good.example",
            "https://evil.example",
            "evil.example;script-src *",
            "*.evil.example",
          ],
        },
      ],
      log,
    );
    expect(union).toEqual(["good.example"]);
    // One warning per rejected non-empty entry (three here).
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("does not warn on empty/absent entries", () => {
    const warn = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    unionPreviewHosts([{ imagePreviewHosts: ["", "ok.example"] }], log);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("extraMediaSourceString (#342)", () => {
  it("emits https:// sources for user hosts not already shipped as defaults", () => {
    const source = extraMediaSourceString(["wimg.rule34.xxx", "new.example"]);
    expect(source).toBe(
      "https://wimg.rule34.xxx https://*.wimg.rule34.xxx " +
        "https://new.example https://*.new.example",
    );
  });

  it("drops hosts already covered by the defaults so the header stays minimal", () => {
    expect(extraMediaSourceString(["imgur.com", "i.imgur.com"])).toBe("");
  });

  it("drops a user host the defaults now cover only through a wildcard (#593)", () => {
    // `cdn.imgur.com` is on no list, but `imgur.com`'s wildcard admits it.
    expect(extraMediaSourceString(["cdn.imgur.com"])).toBe("");
  });
});

describe("contentSecurityDirectives with an extra-media provider (#342)", () => {
  it("appends the provider function to img-src and media-src only", () => {
    const provider = () => "https://wimg.rule34.xxx";
    const directives = contentSecurityDirectives(provider);
    expect(directives["img-src"]).toContain(provider);
    expect(directives["media-src"]).toContain(provider);
    // No other directive gains the function.
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["connect-src"]).toEqual(["'self'"]);
  });

  it("stays a pure string map when no provider is supplied", () => {
    const directives = contentSecurityDirectives();
    for (const value of Object.values(directives)) {
      for (const entry of value) {
        expect(typeof entry).toBe("string");
      }
    }
  });
});

describe("ImagePreviewHostRegistry (#342)", () => {
  it("recomputes the CSP source when a pref changes and refresh() is called", async () => {
    let docs: unknown[] = [{ imagePreviewHosts: ["one.example"] }];
    const registry = new ImagePreviewHostRegistry(() => Promise.resolve(docs));

    await registry.refresh();
    expect(registry.hosts()).toEqual(["one.example"]);
    expect(registry.mediaSourceString()).toBe(
      "https://one.example https://*.one.example",
    );

    // A user edits their allowlist: nothing changes until we invalidate…
    docs = [{ imagePreviewHosts: ["one.example", "wimg.rule34.xxx"] }];
    expect(registry.mediaSourceString()).toBe(
      "https://one.example https://*.one.example",
    );

    // …and the refresh hook (fired on the pref write) picks it up.
    await registry.refresh();
    expect(registry.hosts()).toEqual(["one.example", "wimg.rule34.xxx"]);
    expect(registry.mediaSourceString()).toBe(
      "https://one.example https://*.one.example " +
        "https://wimg.rule34.xxx https://*.wimg.rule34.xxx",
    );
  });

  it("starts empty before the first refresh", () => {
    const registry = new ImagePreviewHostRegistry(() => Promise.resolve([]));
    expect(registry.hosts()).toEqual([]);
    expect(registry.mediaSourceString()).toBe("");
  });
});
