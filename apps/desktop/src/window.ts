import { BrowserWindow, shell } from "electron";
import { fileURLToPath } from "node:url";
import type { WindowFailure } from "./error-page.js";
import { isAppOrigin, isExternalWebUrl } from "./navigation.js";

const PRELOAD = fileURLToPath(new URL("preload.cjs", import.meta.url));

export interface MainWindowOptions {
  /**
   * Called when the window cannot show the origin at all: the top-level load
   * failed, or its renderer died. Thin-client mode passes one (the shell owns
   * that failure surface — see error-window.ts); local mode does not, because
   * the origin is a server this process started and watches by other means
   * (`onUnexpectedExit`), and a loopback load that fails has a dialog with the
   * child's own stderr in it rather than a page.
   */
  readonly onFailure?: (failure: WindowFailure) => void;
}

/**
 * The app window. Its content is the web app — served by the embedded server
 * in local mode, by the user's own server in thin-client mode. There is no
 * renderer bundle in this package (spec invariant 2), so the only things
 * decided here are the security defaults, the navigation policy, when to show
 * the frame, and who is told when none of that gets the chance to matter.
 */
export function createMainWindow(
  appOrigin: string,
  options: MainWindowOptions = {},
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 480,
    // Windows/Linux: the File/Edit/Help strip above a chat client is chrome
    // nobody asked for (#579). Hidden, not removed — Alt still summons it, so
    // Electron's roles (copy/paste/quit) and this app's own items keep their
    // home. macOS ignores this: its menu lives on the system bar, where it is
    // conventional and costs the window nothing.
    autoHideMenuBar: true,
    // No flash of empty chrome while the SPA boots.
    show: false,
    backgroundColor: "#000000",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  // A profile link, an image host, anything the chat renders: the user's own
  // browser, never a chrome-less Electron window (spec §5).
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(appOrigin, url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAppOrigin(appOrigin, url)) {
      return;
    }
    event.preventDefault();
    if (isExternalWebUrl(appOrigin, url)) {
      void shell.openExternal(url);
    }
  });

  const { onFailure } = options;
  if (onFailure !== undefined) {
    // Top-level loads only. A subframe that fails (an embedded image host, an
    // ad frame the web app renders) is the page's problem to show, not a reason
    // to replace the whole session with an error page.
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) {
          onFailure({ kind: "load", errorCode, errorDescription });
        }
      },
    );
    // The renderer died: a grey rectangle otherwise, and one that Retry fixes.
    window.webContents.on("render-process-gone", (_event, details) => {
      onFailure({ kind: "render-process-gone", reason: details.reason });
    });
  }

  // No `certificate-error` listener, here or in main.ts, and no
  // `setCertificateVerifyProc`: Electron's default is to refuse a certificate
  // it cannot verify, the refusal arrives as an ERR_CERT_* load failure above,
  // and it is shown as an explanation with no button past it (spec §5). A
  // client that carries a session token and every word the user says does not
  // get a "proceed anyway". `thin-client.test.ts` guards the absence.
  void window.loadURL(appOrigin);
  return window;
}
