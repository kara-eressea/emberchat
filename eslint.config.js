import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "prototype/**",
      // Spike harnesses kept as evidence, not as code we ship (#297): they
      // import dependencies that are deliberately absent from the workspace.
      "design/spikes/**",
      // The desktop shell's build artifact (MX3): a deployed copy of the
      // server plus its whole prod dependency tree. Not our source.
      "apps/desktop/server-runtime/**",
      // electron-builder's output (MX4): an Electron runtime, an unpacked app
      // and the installers built from them. Derived, and none of it ours.
      "apps/desktop/release/**",
      // Claude Code's per-repo state, including `.claude/worktrees/` — full
      // checkouts of this monorepo living inside it. Flat config does not read
      // `.gitignore`, so without this `eslint .` walks every worktree's source
      // as if it were ours and dies of heap exhaustion on a machine that has a
      // few of them. CI never saw it (fresh checkout); a local `pnpm lint` did.
      // Prettier already skips them — since 3.0 it reads `.gitignore` by
      // default, and this path is gitignored.
      ".claude/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    // Plain-node scripts (scripts/*.mjs, config files).
    languageOptions: { globals: globals.node },
  },
  {
    // The desktop shell's two own pages: the first-run chooser
    // (mx3-desktop-shell.md §4) and the remote session's error page (§5). They
    // ship verbatim as file:// documents with no bundler over them, so they are
    // plain browser JS rather than node scripts — `document` and `window` are
    // their globals.
    files: ["apps/desktop/chooser/*.js", "apps/desktop/error/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    // The push service worker (design/web-push.md §4) is the one .js file that
    // is neither a script nor a bundle: it ships verbatim out of public/ and
    // runs in a ServiceWorkerGlobalScope, so `self`, `clients` and friends are
    // its globals rather than node's.
    files: ["apps/web/public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
);
