// Away & logs pane (COMPONENTS.md §12, M5 step 7): idle auto-away (threshold,
// custom away message, clear-on-return), the opt-in detached auto-away
// (decisions.md §10), and chat-log export — which also satisfies the
// developer-policy requirement that the log location is known and accessible
// to the user.
//
// Both away modes are decided by the bouncer from activity pooled across every
// attached device (#619), so the copy says "devices", not "this browser": the
// preference genuinely applies to the identity rather than to whichever tab
// happens to be showing this pane.

import { useState } from "react";
import { APP_NAME, PREFS_DEFAULTS } from "@emberchat/protocol";
import { api, ApiError } from "../../lib/api.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { FieldRow, GroupLabel, Segmented, Toggle } from "./controls.js";
import { patchPrefs } from "./patch.js";
import styles from "./prefs.module.css";

const IDLE_MINUTES = ["5", "10", "30", "60"] as const;
const DETACHED_MINUTES = ["10", "30", "60", "180"] as const;

/** A stored value off the preset list (another client, an old build) must
 * render as a selected segment, not as nothing-selected — the same
 * pattern M4's delay select uses (M5 audit backlog). */
function withStored(
  presets: readonly string[],
  stored: string,
): { value: string; label: string }[] {
  const values = presets.includes(stored)
    ? [...presets]
    : [...presets, stored].sort((a, b) => Number(a) - Number(b));
  return values.map((value) => ({ value, label: `${value} min` }));
}

export function AwayLogsPane({ identityId }: { identityId: string }) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const set = (patch: Parameters<typeof patchPrefs>[1]) => {
    void patchPrefs(identityId, patch);
  };
  // Free-text drafts commit on blur/Enter, not per keystroke — every commit
  // is a server round trip and a cross-device fan-out. The draft tracks the
  // synced pref until the user actually types (`dirty`): otherwise a blur
  // with no edit would PUT a stale value back over another device's change.
  const [messageDraft, setMessageDraft] = useState(prefs.autoAwayMessage);
  const [messageDirty, setMessageDirty] = useState(false);
  // Render-time adjustment (React's "state from props" pattern): when the
  // synced pref moves under a clean draft, follow it.
  const [seenMessage, setSeenMessage] = useState(prefs.autoAwayMessage);
  if (prefs.autoAwayMessage !== seenMessage) {
    setSeenMessage(prefs.autoAwayMessage);
    if (!messageDirty) {
      setMessageDraft(prefs.autoAwayMessage);
    }
  }

  function commitMessage() {
    if (!messageDirty) {
      return;
    }
    setMessageDirty(false);
    const trimmed = messageDraft.trim();
    setMessageDraft(trimmed);
    if (trimmed !== prefs.autoAwayMessage) {
      set({ autoAwayMessage: trimmed });
    }
  }

  return (
    <>
      <GroupLabel>Auto-away</GroupLabel>
      <FieldRow
        label="Away when idle"
        help="Set your status to away once every device you have open has gone quiet"
      >
        <Toggle
          label="Away when idle"
          checked={prefs.autoAwayEnabled}
          onChange={(autoAwayEnabled) => {
            set({ autoAwayEnabled });
          }}
        />
      </FieldRow>
      <FieldRow label="Idle threshold">
        <Segmented
          label="Idle threshold"
          options={withStored(IDLE_MINUTES, String(prefs.autoAwayMinutes))}
          value={String(prefs.autoAwayMinutes)}
          onChange={(value) => {
            set({ autoAwayMinutes: Number(value) });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Away message"
        help="The status message both away modes set"
      >
        <input
          className={styles.textInput}
          value={messageDraft}
          maxLength={255}
          placeholder="Away from the keyboard…"
          aria-label="Away message"
          onChange={(event) => {
            setMessageDirty(true);
            setMessageDraft(event.target.value);
          }}
          onBlur={commitMessage}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commitMessage();
            }
          }}
        />
      </FieldRow>
      <FieldRow
        label="Clear on return"
        help="Restore your previous status when you're active on any device"
      >
        <Toggle
          label="Clear on return"
          checked={prefs.autoAwayClearOnReturn}
          onChange={(autoAwayClearOnReturn) => {
            set({ autoAwayClearOnReturn });
          }}
        />
      </FieldRow>

      <GroupLabel>While detached</GroupLabel>
      <FieldRow
        label="Away when no browser is attached"
        help="The bouncer keeps you online after you close the app; opt in to show away while nothing is watching"
      >
        <Toggle
          label="Away when no browser is attached"
          checked={prefs.detachedAwayEnabled}
          onChange={(detachedAwayEnabled) => {
            set({ detachedAwayEnabled });
          }}
        />
      </FieldRow>
      <FieldRow label="Detached threshold">
        <Segmented
          label="Detached threshold"
          options={withStored(
            DETACHED_MINUTES,
            String(prefs.detachedAwayMinutes),
          )}
          value={String(prefs.detachedAwayMinutes)}
          onChange={(value) => {
            set({ detachedAwayMinutes: Number(value) });
          }}
        />
      </FieldRow>

      <GroupLabel>Chat logs</GroupLabel>
      <p className={styles.paneNote}>
        {/* The product name comes from the one constant, never a literal
            (CLAUDE.md, #556) — this line had been the one place in the client
            that forgot (#378). */}
        Your message history is stored in the {APP_NAME} server database —
        nothing is logged anywhere else. Browse it any time by scrolling up in a
        conversation, or download a full copy here.
      </p>
      <LogExport identityId={identityId} />
    </>
  );
}

/** Conversation picker + format choice + download. */
function LogExport({ identityId }: { identityId: string }) {
  const session = useSessionsStore((s) => s.sessions[identityId]);
  const [convId, setConvId] = useState("");
  const [format, setFormat] = useState<"txt" | "html" | "json">("txt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const channels = Object.values(session?.channels ?? {}).filter(
    (channel) => channel.convId !== "",
  );
  const dms = Object.values(session?.dms ?? {});
  const options = [
    ...channels.map((c) => ({ convId: c.convId, label: `# ${c.title}` })),
    ...dms.map((d) => ({ convId: d.convId, label: d.partner })),
  ].sort((a, b) => a.label.localeCompare(b.label));
  const selected = options.find((option) => option.convId === convId);

  async function download() {
    if (!selected || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const blob = await api.exportLog(identityId, selected.convId, format);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${selected.label.replace(/^# /, "")}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(
        downloadError instanceof ApiError
          ? downloadError.message
          : "Could not export the log",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.exportRow}>
      <select
        className={styles.textInput}
        value={convId}
        aria-label="Conversation to export"
        onChange={(event) => {
          setConvId(event.target.value);
        }}
      >
        <option value="">Choose a conversation…</option>
        {options.map((option) => (
          <option key={option.convId} value={option.convId}>
            {option.label}
          </option>
        ))}
      </select>
      <Segmented
        label="Export format"
        options={[
          { value: "txt", label: ".txt" },
          { value: "html", label: ".html" },
          { value: "json", label: ".json" },
        ]}
        value={format}
        onChange={setFormat}
      />
      <button
        type="button"
        className={styles.ruleAdd}
        disabled={!selected || busy}
        onClick={() => {
          void download();
        }}
      >
        Download
      </button>
      {error && (
        <p className={styles.paneError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
