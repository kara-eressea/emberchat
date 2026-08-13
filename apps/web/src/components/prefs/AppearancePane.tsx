// Appearance pane (COMPONENTS.md §12 + milestone-5.md): accent, base theme,
// density, font size, timestamps, grouping, aligned columns. Every control
// writes through patchPrefs — optimistic locally, synced to every device
// via the prefs fan-out (decisions.md §10). The join/part/quit toggle joins
// in M5 step 5, when those lines exist to hide.

import { PREFS_DEFAULTS, UI_SCALE_STEPS } from "@emberchat/protocol";
import { useSessionsStore } from "../../stores/sessions.js";
import { withoutEicon } from "../chat/eicon-lists.js";
import { ACCENTS, type AccentId } from "../../theme/tokens.js";
import {
  FieldRow,
  GroupLabel,
  Segmented,
  Stepper,
  Swatch,
  Toggle,
} from "./controls.js";
import { patchPrefs } from "./patch.js";
import styles from "./prefs.module.css";

export function AppearancePane({ identityId }: { identityId: string }) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const set = (patch: Parameters<typeof patchPrefs>[1]) => {
    void patchPrefs(identityId, patch);
  };

  return (
    <>
      <GroupLabel>Theme</GroupLabel>
      <FieldRow label="Accent color" help="Synced across your devices">
        <div
          className={styles.swatchRow}
          role="radiogroup"
          aria-label="Accent color"
        >
          {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
            <Swatch
              key={id}
              color={ACCENTS[id].hex}
              label={ACCENTS[id].label}
              selected={prefs.accent === id}
              onClick={() => {
                set({ accent: id });
              }}
            />
          ))}
        </div>
      </FieldRow>
      <FieldRow label="Base theme">
        <Segmented
          label="Base theme"
          options={[
            { value: "slate", label: "Slate" },
            { value: "charcoal", label: "Charcoal" },
            { value: "parchment", label: "Parchment" },
          ]}
          value={prefs.baseTheme}
          onChange={(baseTheme) => {
            set({ baseTheme });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Colorblind-friendly status colors"
        help="Okabe–Ito ok/warn/danger hues, and presence dots gain distinct shapes so hue is never the only signal"
      >
        <Toggle
          label="Colorblind-friendly status colors"
          checked={prefs.colorblindMode}
          onChange={(colorblindMode) => {
            set({ colorblindMode });
          }}
        />
      </FieldRow>

      <GroupLabel>Interface</GroupLabel>
      <FieldRow
        label="Interface font size"
        help="Size of text in the sidebar, headers, menus, and settings — separate from the message font size below"
      >
        <Segmented
          label="Interface font size"
          options={[
            { value: "s", label: "S" },
            { value: "m", label: "M" },
            { value: "l", label: "L" },
          ]}
          value={prefs.uiFontSize}
          onChange={(uiFontSize) => {
            set({ uiFontSize });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Interface scale"
        help="Zoom the whole app in or out, like your browser's zoom"
      >
        <Stepper
          label="Interface scale"
          options={UI_SCALE_STEPS}
          value={
            UI_SCALE_STEPS.includes(
              prefs.uiScale as (typeof UI_SCALE_STEPS)[number],
            )
              ? (prefs.uiScale as (typeof UI_SCALE_STEPS)[number])
              : 100
          }
          format={(value) => `${String(value)}%`}
          onChange={(uiScale) => {
            set({ uiScale });
          }}
        />
      </FieldRow>

      <FieldRow
        label="Show avatars in the sidebar"
        help="Off makes the channel and people rows shorter, with names only"
      >
        <Toggle
          label="Show avatars in the sidebar"
          checked={prefs.sidebarAvatars}
          onChange={(sidebarAvatars) => {
            set({ sidebarAvatars });
          }}
        />
      </FieldRow>

      <FieldRow
        label="Show character icons"
        help="Off replaces every profile picture with the character's initial, and stops [icon] tags in messages and statuses from loading one"
      >
        <Toggle
          label="Show character icons"
          checked={prefs.showCharacterIcons}
          onChange={(showCharacterIcons) => {
            set({ showCharacterIcons });
          }}
        />
      </FieldRow>

      <FieldRow
        label="Show other people's status messages"
        help="Off hides them in member lists, headers and profiles. Your own status stays visible"
      >
        <Toggle
          label="Show other people's status messages"
          checked={prefs.showOthersStatus}
          onChange={(showOthersStatus) => {
            set({ showOthersStatus });
          }}
        />
      </FieldRow>

      <FieldRow
        label="Profile card position"
        help="Anchored opens the card under the name you clicked; docked parks it in the bottom-right corner, out of the conversation"
      >
        <Segmented
          label="Profile card position"
          options={[
            { value: "anchored", label: "Anchored" },
            { value: "corner", label: "Docked" },
          ]}
          value={prefs.miniCardPlacement}
          onChange={(miniCardPlacement) => {
            set({ miniCardPlacement });
          }}
        />
      </FieldRow>

      <GroupLabel>Messages</GroupLabel>
      <FieldRow label="Message density">
        <Segmented
          label="Message density"
          options={[
            { value: "cozy", label: "Cozy" },
            { value: "compact", label: "Compact" },
          ]}
          value={prefs.density}
          onChange={(density) => {
            set({ density });
          }}
        />
      </FieldRow>
      <FieldRow label="Message font size">
        <Segmented
          label="Message font size"
          options={[
            { value: "s", label: "S" },
            { value: "m", label: "M" },
            { value: "l", label: "L" },
          ]}
          value={prefs.fontSize}
          onChange={(fontSize) => {
            set({ fontSize });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Message font"
        help="The face message text is set in — names and timestamps keep their own"
      >
        <Segmented
          label="Message font"
          options={[
            { value: "sans", label: "Sans" },
            { value: "serif", label: "Serif" },
            { value: "mono", label: "Mono" },
          ]}
          value={prefs.messageFont}
          onChange={(messageFont) => {
            set({ messageFont });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Group consecutive messages"
        help="Hide the sender on back-to-back messages from the same person"
      >
        <Toggle
          label="Group consecutive messages"
          checked={prefs.groupConsecutive}
          onChange={(groupConsecutive) => {
            set({ groupConsecutive });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Aligned columns"
        help="Fixed time and name columns so message text lines up. Phone-sized windows always use the full-width flow — there is no room for the columns"
      >
        <Toggle
          label="Aligned columns"
          checked={prefs.alignedColumns}
          onChange={(alignedColumns) => {
            set({ alignedColumns });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Tint your own messages"
        help="A faint background on the messages you sent, so they stay findable in a busy channel"
      >
        <Toggle
          label="Tint your own messages"
          checked={prefs.ownMessageTint}
          onChange={(ownMessageTint) => {
            set({ ownMessageTint });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Show join/part/quit"
        help="Live channel comings and goings — not kept in history"
      >
        <Toggle
          label="Show join/part/quit"
          checked={prefs.showJoinPartQuit}
          onChange={(showJoinPartQuit) => {
            set({ showJoinPartQuit });
          }}
        />
      </FieldRow>

      <GroupLabel>Eicons</GroupLabel>
      <FieldRow label="Eicon display">
        <Segmented
          label="Eicon display"
          options={[
            { value: "inline", label: "Inline" },
            { value: "name", label: "Name only" },
            { value: "off", label: "Off" },
          ]}
          value={prefs.eiconDisplay}
          onChange={(eiconDisplay) => {
            set({ eiconDisplay });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Animate eicons"
        help="Off freezes them on their first frame"
      >
        <Toggle
          label="Animate eicons"
          checked={prefs.animateEicons}
          onChange={(animateEicons) => {
            set({ animateEicons });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Eicon search"
        help="Search uses an eicon index the server downloads from xariah.net, a third-party service — your search text never leaves the server"
      >
        <Toggle
          label="Eicon search"
          checked={prefs.eiconSearchEnabled}
          onChange={(eiconSearchEnabled) => {
            set({ eiconSearchEnabled });
          }}
        />
      </FieldRow>

      <GroupLabel>Favourite eicons</GroupLabel>
      <EiconList
        names={prefs.eiconFavorites}
        label="Favourite eicons"
        removeVerb="Unfavourite"
        empty="No favourites yet — right-click any eicon, or use the ☆ in the composer's eicon picker."
        onRemove={(eiconFavorites) => {
          set({ eiconFavorites });
        }}
      />

      <GroupLabel>Blocked eicons</GroupLabel>
      <EiconList
        names={prefs.eiconBlocked}
        label="Blocked eicons"
        removeVerb="Unblock"
        empty="Nothing blocked — right-click an eicon in a message to hide its image everywhere."
        onRemove={(eiconBlocked) => {
          set({ eiconBlocked });
        }}
      />

      <GroupLabel>Timestamps</GroupLabel>
      <FieldRow label="Timestamp format">
        <Segmented
          label="Timestamp format"
          options={[
            { value: "time", label: "[12:04]" },
            { value: "seconds", label: "[12:04:33]" },
            { value: "off", label: "Off" },
          ]}
          value={prefs.timestampFormat}
          onChange={(timestampFormat) => {
            set({ timestampFormat });
          }}
        />
      </FieldRow>
      <FieldRow label="24-hour clock">
        <Toggle
          label="24-hour clock"
          checked={prefs.use24HourClock}
          onChange={(use24HourClock) => {
            set({ use24HourClock });
          }}
        />
      </FieldRow>
    </>
  );
}

/**
 * The favourite/blocked eicon review lists — both are built by right-clicking
 * eicons in chat (and the picker's ☆), so this is a management surface only,
 * mirroring the muted-conversations list in Notifications.
 */
function EiconList({
  names,
  label,
  removeVerb,
  empty,
  onRemove,
}: {
  names: readonly string[];
  label: string;
  removeVerb: string;
  empty: string;
  onRemove: (next: string[]) => void;
}) {
  if (names.length === 0) {
    return <p className={styles.rulesEmpty}>{empty}</p>;
  }
  return (
    <ul className={styles.ruleList} aria-label={label}>
      {names.map((name) => (
        <li key={name} className={styles.ruleChip}>
          <span className={styles.rulePattern}>{name}</span>
          <button
            type="button"
            className={styles.ruleRemove}
            aria-label={`${removeVerb} ${name}`}
            onClick={() => {
              onRemove(withoutEicon(names, name));
            }}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}
