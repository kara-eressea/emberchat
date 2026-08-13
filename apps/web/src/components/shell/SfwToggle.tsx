// The SFW quick toggle (#580) — the MeBar's second-to-last control, beside
// the preferences gear so it is one click away from anywhere in the app.
//
// The behaviour is all in `lib/sfw.ts`; this is the button, its state, and the
// asymmetric confirmation the issue asks for: on is instant (you are reaching
// for it because someone is already walking over), off asks first (the failure
// mode is uncovering an adult chat client in front of them).
//
// In the desktop app this control is also wanted in the custom title bar
// (#584, not built yet). Nothing here assumes the MeBar — it is a plain
// button, so the title bar can render a second instance against the same
// state when that lands.

import { useEffect, useRef, useState } from "react";
import { SfwGlyph } from "../icons/Glyphs.js";
import { refreshEffectivePrefs } from "../prefs/patch.js";
import { setSfw, useSfwOn } from "../../lib/sfw.js";
import styles from "./shell.module.css";

export function SfwToggle() {
  const on = useSfwOn();
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // The confirmation is a one-question popover, so it takes focus and closes
  // on Escape like the menus do.
  useEffect(() => {
    if (!confirming) {
      return;
    }
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConfirming(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [confirming]);

  return (
    <div className={styles.sfwWrap}>
      <button
        type="button"
        className={`${styles.meGear} ${on ? (styles.sfwOn ?? "") : ""}`}
        title={
          on
            ? "SFW mode on — icons, eicons, previews, ads, statuses and alerts hidden"
            : "SFW mode — hide icons, eicons, previews, ads, statuses and alerts"
        }
        aria-label="SFW mode"
        aria-pressed={on}
        onClick={() => {
          if (on) {
            // Never one click back out of it.
            setConfirming(true);
          } else {
            setSfw(true, refreshEffectivePrefs);
          }
        }}
      >
        <SfwGlyph on={on} />
      </button>
      {confirming && (
        <div
          className={styles.sfwConfirm}
          role="dialog"
          aria-label="Leave SFW mode"
        >
          <p className={styles.sfwConfirmText}>
            Turn SFW mode off? Icons, eicons, ads and status messages come back.
          </p>
          <div className={styles.sfwConfirmRow}>
            <button
              type="button"
              className={styles.sfwConfirmCancel}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Stay in SFW
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={styles.sfwConfirmGo}
              onClick={() => {
                setConfirming(false);
                setSfw(false, refreshEffectivePrefs);
              }}
            >
              Turn off
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
