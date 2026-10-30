# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`extension/tips-translate.ts` is a Senpi/OMO extension that renders the TUI tips in a language chosen by the user. It wraps `Text.prototype.render` from `@earendil-works/pi-tui`, replaces only "Tip: …" lines and the English pointer line, and keeps the original English on any error or missing seam. Translation uses the user's model and is cached in `<agentDir>/omo-tips-translate.json`. README.md is the user-facing spec; README.ko.md mirrors it with the same headings in the same order.

## Commands

```sh
bun test
bun test -t "<name substring>"
bun test test/extract.test.ts
omo install <path-to-this-clone>   # dev only: loads the working tree; /reload picks up edits
                                   # switch back to git install afterwards
```

It ships as an omo package: `package.json` `pi.extensions` names `extension/tips-translate.ts`, and users install it with `omo install git:github.com/yjacket/omo-tips-translate`. The installers run that same command. The package requires Bun >= 1.4.

Tests use `bun:test`; extension wiring tests use `mock.module` fakes and import a fresh module with a `?case=` query. They never use a live OMO session. Tests must not sleep; inject clocks or await an event with a bounded timeout instead.

## Architecture

- `src/extract.ts` parses tip templates from the running bundle. `TipTemplate` is `{ id, en, slots }`; the fixed `PREFIX_EN` and `POINTER_EN` strings live here. `extractTemplates` dedupes by id (first wins), `findCatalogFiles` prefers `dist/bundle/chunks/*.js` containing `_TIPS=[` and falls back to `dist/modes/interactive/tips/catalog/*-tips.js`, and `loadTemplates`/`sourceHash` complete the module. Template literals are scanned by hand (nested `${…}`, escapes, `{0}`, `{1}`, …); `eval`/`Function` are forbidden.
- `src/match.ts` turns the saved `Table` into a `Matcher`. Slotless entries match exactly; slotted entries compile to anchored regexes after escaping literals. `translateText` separates leading/trailing SGR codes, handles the `Tip: ` prefix and the exact pointer line, and fills `{n}` from captures. A translated entry with a different placeholder multiset is ignored.
- `src/store.ts` owns the version-1 `StoreData` schema and file `omo-tips-translate.json`: `storePath`, tolerant `readStore`, atomic `writeStore` (tmp in the same directory, then rename), `acquireLock`/`releaseLock` (`${path}.lock`, stale after 10 minutes), and `diffTemplates` (missing or English-changed ids).
- `src/translate.ts` builds the JSON prompt, parses a reply tolerating code fences, and validates keys, non-empty single-line strings, and placeholder equality. Failed keys are retried once in batches of 10; `translateTemplates` batches at 40 by default, reports `onProgress(done, total)`, and throws `AbortError` on abort.
- `extension/tips-translate.ts` wires those modules to senpi. The prototype hook installs once per process behind `Symbol.for("omo.tips-translate.text-hook.v1")` and dispatches through the replaceable global `Symbol.for("omo.tips-translate.impl.v1")`. `session_shutdown` clears the impl on reload. First run selects a model then a language and translates in the background; a changed `sourceHash` asks once (remembered in `declinedHash`); `/tips-translate` changes language, changes model, retranslates, toggles, or reports status.
- `qa/live-replay.mjs` and `qa/fake-translator.ts` replay an isolated TUI session against a temporary agent directory. They never touch the user's real agent dir.

## Invariants

- Never write OMO runtime files or `settings.json`, and never install or test against the user's real agent dir. Display replacement happens in memory only; removing the extension restores the original text.
- Never break the TUI. Every fallible seam, lookup, and render is feature-detected; errors and unexpected data fall back to the original renderer. A missing seam shows one warning per session, not a throw.
- Translate only tip lines and their pointer line. Keep `{n}` placeholders identical, and never translate commands, flags, file names, key names, or backticked code.
- Keep the pure modules (`src/extract.ts`, `src/match.ts`, `src/store.ts`, `src/translate.ts`) free of senpi and pi-tui imports. They may import Node builtins.
- Use the cross-session lock. Two sessions opening at once must not translate the same catalog twice, and a stale lock (over 10 minutes) must be recoverable.
- Ask at most once per changed catalog hash. Remember "no" in `declinedHash`. Never prompt when `ctx.mode !== "tui"`.
- Preserve the `Symbol.for` marker names and replace the global impl on reload instead of stacking hooks.
- Never mutate stored tool results or the English source. The English catalog is the fallback for every missing or invalid translation.

## Testing

`bun test` runs the unit suite. Cover extractor forms (minified and unminified), nested template literals, escapes, skipped concatenations, dedupe and hashing; matching with 0/1/2 slots, ANSI edges, multi-line tips, placeholder mismatch and regex metacharacters; store corruption, atomic writes, the lock boundary and diffs; and translation success, fences, missing keys, retries, and abort. Extension tests should cover first-run flow, changed-hash yes/no, no repeat question, command arguments, reload, missing `Text`, and corrupt stores. Do not add sleeps.

## Live TUI check

Do not start real omo against the user's agent dir. Run `bun qa/live-replay.mjs`, which builds a temporary agent dir (all `brandEnvNames("CODING_AGENT_DIR")` variants), loads the working tree with `-e extension/tips-translate.ts`, and drives a 150x45 PTY. The fake provider returns deterministic translation JSON. Scenarios: translated tips and pointer shown; first-run model/language dialogs followed by store creation; changed hash asks once; corrupt store stays English with no `TypeError`. Save screen text and raw output under `.omo/evidence/`.

## After an OMO update

Re-run the tests and live replay. If the render seam changed, the extension must fall back to English with one session-start notice; fix the seam detection or the catalog parser, then bump any tested-version notes in both READMEs.
