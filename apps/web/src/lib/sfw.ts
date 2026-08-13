// SFW quick toggle (#580).
//
// One click hides everything on screen that would be awkward for someone
// walking past, and one click (plus a confirmation) puts it all back. It is
// deliberately a *preset over the override layer* (#581) rather than a second
// display-control mechanism: every value below is an ordinary preference with
// its own place in Preferences, and SFW just pins a set of them for as long as
// it is on.
//
// That choice is what makes "restore what was underneath" free. The `sfw`
// layer shadows; nothing is copied aside, and dropping the layer reveals
// whatever the user had — synced values, or their own device overrides — with
// no bookkeeping and no way for the two to disagree.
//
// Asymmetric confirmation, from the issue: turning SFW *on* must never be
// slowed down (the reason you are reaching for it is that someone is already
// walking over), while turning it *off* asks first, because the failure mode
// is uncovering an adult chat client in front of them.

import type { UserPrefs } from "@emberchat/protocol";
import { useOverridesStore } from "../stores/prefs-overrides.js";

/**
 * The preference values SFW pins. Each maps to one of the six behaviours the
 * issue asks for:
 *
 *   1. hide all profile icons          → showCharacterIcons
 *   2. stop rendering eicons           → eiconDisplay: "off" (#585's new mode:
 *                                        "name" still previews on hover)
 *   3. no link preview on hover        → linkPreviewMode: "off"
 *   4. no ads                          → adViewDefault + channelAdView, because
 *                                        a per-channel override would otherwise
 *                                        outrank the default and keep showing
 *                                        ads in exactly the channel you were
 *                                        reading
 *   5. hide others' status messages    → showOthersStatus
 *   6. notifications and sounds quiet  → the highlight and desktop-notify
 *                                        prefs; the notification inbox is not
 *                                        among them, so it keeps recording
 *                                        everything for later, which is what
 *                                        the issue asks for
 *
 * KNOWN GAP — Web Push. The server decides whether to send a push from the
 * *server-held* prefs (`modules/push/sender.ts` → `kindEnabled`), and this
 * layer is device-local by design, so a subscribed browser can still surface a
 * push notification while SFW is on. Everything in-app goes quiet — chime,
 * title flash, in-page toast — but the OS-level one is out of reach without
 * either patching the server (and then having to restore it, which is the
 * bookkeeping this design exists to avoid) or teaching the sender about device
 * state. Worth settling deliberately rather than silently; see the PR.
 */
export const SFW_PREFS: Partial<UserPrefs> = {
  showCharacterIcons: false,
  eiconDisplay: "off",
  linkPreviewMode: "off",
  adViewDefault: "chat",
  channelAdView: {},
  showOthersStatus: false,
  highlightSound: false,
  highlightFlashTitle: false,
  highlightBump: false,
  desktopNotifyMentions: false,
  desktopNotifyPms: false,
  desktopNotifyNotes: false,
};

/** Is SFW mode on for this device right now? */
export function isSfwOn(): boolean {
  return useOverridesStore.getState().overrides.sfw !== undefined;
}

/** Reactive form of `isSfwOn`, for the toggle's own rendering. */
export function useSfwOn(): boolean {
  return useOverridesStore((s) => s.overrides.sfw !== undefined);
}

/**
 * Turn SFW on or off. `onApplied` runs after the layer changes so the caller
 * can re-fold the layers over every slice and repaint — the store layer
 * deliberately knows nothing about sessions or the theme.
 */
export function setSfw(on: boolean, onApplied: () => void): void {
  useOverridesStore.getState().setLayer("sfw", on ? SFW_PREFS : undefined);
  onApplied();
}
