// General pane (COMPONENTS.md §12): account-wide behavior defaults. Its
// first real control lands with M6 — roleplay-ad visibility. hideAds is
// what every channel inherits; the channel header's ads chip stores
// per-channel exceptions on top of it.

import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  APP_NAME,
  DEFAULT_IMAGE_PREVIEW_HOSTS,
  IMAGE_PREVIEW_HOST,
  PREFS_DEFAULTS,
} from "@emberchat/protocol";
import { useServerMeta } from "../../lib/use-meta.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { FieldRow, GroupLabel, Segmented, Toggle } from "./controls.js";
import { patchPrefs } from "./patch.js";
import styles from "./prefs.module.css";

export function GeneralPane({
  identityId,
  onClose,
}: {
  identityId: string;
  onClose: () => void;
}) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  // About surface (M7): running version + the server's quiet update hint.
  const meta = useServerMeta();

  return (
    <>
      <GroupLabel>Channel list</GroupLabel>
      <FieldRow
        label="Hide offline people"
        help="Keeps offline friends, bookmarks, and direct-message partners out of the sidebar — though a pinned chat, one with unread messages, or the chat you have open always stays put. This sets all three sections at once; to show or hide offline people in just one, right-click that section's heading in the sidebar."
      >
        <Toggle
          label="Hide offline people"
          checked={
            !prefs.showOfflineFriends &&
            !prefs.showOfflineBookmarks &&
            !prefs.showOfflineDms
          }
          onChange={(hide) => {
            void patchPrefs(identityId, {
              showOfflineFriends: !hide,
              showOfflineBookmarks: !hide,
              showOfflineDms: !hide,
            });
          }}
        />
      </FieldRow>
      <GroupLabel>Message box</GroupLabel>
      <FieldRow
        label="Style formatting as you type"
        help="Shows **bold**, *italic* and friends styled right in the message box while you write, instead of in a separate preview above it. The markers stay visible, just dimmed. What you send is the same either way."
      >
        <Toggle
          label="Style formatting as you type"
          checked={prefs.inlineComposer}
          onChange={(on) => {
            void patchPrefs(identityId, { inlineComposer: on });
          }}
        />
      </FieldRow>
      <GroupLabel>Roleplay ads</GroupLabel>
      <FieldRow
        label="Hide ads everywhere"
        help="Channels inherit this default; the Show selector in a channel's header overrides it per channel. Hidden ads are kept in history."
      >
        <Toggle
          label="Hide ads everywhere"
          checked={prefs.adViewDefault === "chat"}
          onChange={(hide) => {
            void patchPrefs(identityId, {
              adViewDefault: hide ? "chat" : "both",
            });
          }}
        />
      </FieldRow>
      <GroupLabel>Link previews</GroupLabel>
      <FieldRow
        label="Media link previews"
        help="Loading a preview fetches the image straight from its host — the host sees your IP, like any image on a webpage. Click mode: a plain click on a media link previews it; Ctrl/Cmd+click follows the link"
      >
        <Segmented
          label="Media link previews"
          options={[
            { value: "off", label: "Off" },
            { value: "hover", label: "Hover" },
            { value: "click", label: "Click" },
          ]}
          value={prefs.linkPreviewMode}
          onChange={(linkPreviewMode) => {
            void patchPrefs(identityId, { linkPreviewMode });
          }}
        />
      </FieldRow>
      <ImagePreviewHosts
        hosts={prefs.imagePreviewHosts}
        onChange={(imagePreviewHosts) => {
          void patchPrefs(identityId, { imagePreviewHosts });
        }}
      />

      <GroupLabel>Accounts</GroupLabel>
      <p className={styles.stub}>
        Identities and F-List accounts are managed on the{" "}
        <Link to="/identities" onClick={onClose}>
          identity screen
        </Link>
        .
      </p>
      <GroupLabel>About</GroupLabel>
      <p className={styles.stub}>
        {APP_NAME}
        {meta && ` v${meta.version}`}
        {meta?.updateAvailable && meta.latestVersion !== undefined && (
          <>
            {" · "}
            <a
              href={meta.releasesUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Update available: {meta.latestVersion} ↗
            </a>
          </>
        )}
      </p>
    </>
  );
}

const MAX_PREVIEW_HOSTS = 100;

/** Strip anything that isn't a bare hostname: scheme, path, query, port, and
 * surrounding whitespace — so pasting a full URL still yields just its host. */
function normalizeHostInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // scheme://
    .replace(/[/?#].*$/, "") // path / query / fragment
    .replace(/:\d+$/, ""); // :port
}

/**
 * The image-preview allowlist editor (#215): a chip list of hosts, an add
 * form with light hostname validation, and a reset-to-defaults affordance.
 * The whole array is patched on every change (the prefs array convention).
 */
function ImagePreviewHosts({
  hosts,
  onChange,
}: {
  hosts: readonly string[];
  onChange: (hosts: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();

  const isDefault =
    hosts.length === DEFAULT_IMAGE_PREVIEW_HOSTS.length &&
    DEFAULT_IMAGE_PREVIEW_HOSTS.every((host, index) => hosts[index] === host);

  function add(event: FormEvent) {
    event.preventDefault();
    const host = normalizeHostInput(draft);
    if (host === "") {
      return;
    }
    if (!IMAGE_PREVIEW_HOST.test(host)) {
      setError("Enter a site address like imgur.com");
      return;
    }
    if (hosts.includes(host)) {
      setError("That site is already on the list");
      return;
    }
    if (hosts.length >= MAX_PREVIEW_HOSTS) {
      setError(`You can add up to ${String(MAX_PREVIEW_HOSTS)} sites`);
      return;
    }
    onChange([...hosts, host]);
    setDraft("");
    setError(undefined);
  }

  return (
    <div className={styles.rulesEditor}>
      <div className={styles.fieldText}>
        <div className={styles.fieldLabel}>
          Show image previews from these sites
        </div>
        <div className={styles.fieldHelp}>
          Previews load only for sites on this list — links from anywhere else
          stay plain links you can open in a new tab. A site covers its
          subdomains too, so adding imgur.com also allows i.imgur.com.
        </div>
      </div>
      <div className={styles.hostEditorBody}>
        {hosts.length === 0 ? (
          <p className={styles.rulesEmpty}>
            No sites yet — add one below to see image previews.
          </p>
        ) : (
          <ul className={styles.ruleList} aria-label="Allowed preview sites">
            {hosts.map((host) => (
              <li key={host} className={styles.ruleChip}>
                <span className={styles.rulePattern}>{host}</span>
                <button
                  type="button"
                  className={styles.ruleRemove}
                  aria-label={`Remove ${host}`}
                  onClick={() => {
                    onChange(hosts.filter((entry) => entry !== host));
                    setError(undefined);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className={styles.ruleForm} onSubmit={add}>
          <input
            className={styles.textInput}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(undefined);
            }}
            maxLength={253}
            placeholder="imgur.com"
            aria-label="Site address"
          />
          <button
            type="submit"
            className={styles.ruleAdd}
            disabled={draft.trim() === "" || hosts.length >= MAX_PREVIEW_HOSTS}
          >
            Add
          </button>
        </form>
        <p className={styles.rulesHint}>
          Enter a site address only — no “https://” or path.
          {!isDefault && (
            <>
              {" "}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  onChange([...DEFAULT_IMAGE_PREVIEW_HOSTS]);
                  setError(undefined);
                }}
              >
                Reset to defaults
              </button>
            </>
          )}
        </p>
        {error !== undefined && (
          <p className={styles.paneError} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
