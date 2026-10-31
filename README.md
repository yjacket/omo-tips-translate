# omo-tips-translate

English | [한국어](README.ko.md)

An OMO (senpi) extension that shows the TUI tips in the language you choose. "Tip:" lines at startup and while the agent works, plus the `↳ Want the full story…` pointer line, are replaced with translations made by your own model. Values OMO computes at render time, such as key chords and the app name, stay exactly right. Nothing in the OMO runtime is modified: the extension swaps text only while it is drawn, and removing the extension puts the original English back.

## What you see

```
팁: 언제든 Esc를 눌러 실행 중인 작업을 멈출 수 있습니다.
↳ 각 팁의 자세한 설명이 궁금하세요? 물어보세요 — give-me-tips 스킬에 안내가 있습니다.
```

The first run takes a few moments to translate the whole catalog in the background. Tips are shown in English until every batch finishes, then the translated table is installed at once; translations do not appear batch by batch. The session is never blocked waiting for the catalog. A status line shows progress, for example `🌐 팁 12/180`.

## Install

```sh
omo install git:github.com/yjacket/omo-tips-translate
```

omo clones the repository into `~/.omo/agent/git/github.com/yjacket/omo-tips-translate` and adds it to `packages` in `~/.omo/agent/settings.json`. Type `/reload` in running sessions.

Or use the convenience scripts, which run the same command:

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/yjacket/omo-tips-translate/main/install.ps1 | iex
```

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/yjacket/omo-tips-translate/main/install.sh | sh
```

**Update:** `omo update --extensions` pulls the latest for every git-installed extension. To update just this one: `omo update --extension git:github.com/yjacket/omo-tips-translate`. Then `/reload` in running sessions.

**Uninstall:** `omo remove git:github.com/yjacket/omo-tips-translate`, then `/reload` or restart omo. The tips render in English again. To delete the saved translations too, remove `~/.omo/agent/omo-tips-translate.json`.

## First run

With no saved translation, the extension asks two questions in the TUI:

1. **Model** - the model used for translation. Your current model is listed first. Any model available in the session can be picked.
2. **Language** - 한국어, 日本語, 简体中文, 繁體中文, Español, Français, Deutsch, Português, Русский, or a language typed in directly.

The answer is saved, and translation runs in the background. Failures are reported but do not block the session; tips that could not be translated stay in English.

After an OMO update changes the tip catalog, the extension asks once whether to translate the new tips. If the update only removed tips, there is nothing to translate and it does not ask. Yes translates only the changed and new ones and keeps the rest. No remembers that catalog hash, so the same question does not come back. Tips that did not change keep their existing translations either way.

In print, JSON, and RPC modes there are no prompts. The saved table is used as is.

## `/tips-translate`

Run it with no arguments to open the menu:

- **Change language** - pick another language and translate again.
- **Change model** - pick a different model for future translations.
- **Translate again** - rebuild the table from the current catalog.
- **Turn off / Turn on** - stop or resume replacing tip text. Turning it off keeps the saved table.
- **Status** - show language, model, OMO version, translated item count, and failed count.

`/tips-translate <language>` skips the menu and translates into that language immediately, for example `/tips-translate 한국어` or `/tips-translate Español`.

## Saved translations

Translations live in one file shared by every session:

```
~/.omo/agent/omo-tips-translate.json
```

The agent directory follows OMO's normal overrides (`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`). The file records the OMO version, a hash of the original tips, the model, the language, whether the extension is enabled, and an `en`/`tr` pair for each tip. Writes are atomic, and a 10-minute lock keeps several sessions opening at once from translating the same catalog twice.

The file is yours to delete. Deleting it makes the next session ask for a model and language again.

## How it works and safety

The extension wraps `Text.prototype.render` from `@earendil-works/pi-tui`, the path every tip line goes through, and only touches lines that start with `Tip: ` and the exact English pointer line. The catalog is read from the running OMO installation at `dist/bundle/chunks/*.js`, falling back to `dist/modes/interactive/tips/catalog/*-tips.js`. The English text is parsed with a hand-written scanner, never `eval` or `Function`.

- **No runtime edits.** The extension never writes OMO's files or `settings.json`. Rendering is changed only in memory.
- **English fallback.** A missing translation, a placeholder mismatch, a corrupt store file, or a missing internal leaves the original English text in place.
- **One warning per session.** If the render seam is unavailable after an OMO update, the extension leaves the display alone and says so once.
- **Placeholders are preserved.** A translation is accepted only if it has the same `{0}`, `{1}`, … slots as the original. Commands, flags, file names, key names, and backticked code are kept untranslated.
- **Reload safe.** A `Symbol.for` marker installs the prototype hook once per process; `/reload` replaces the dispatch target instead of stacking hooks.
- **No outside service.** Translations use the model you choose through the running OMO session. There is no external translation API.

## Limitations

- It relies on a pi-tui internal. An OMO update may remove that seam, in which case tips stay English and one warning is shown.
- Only tip lines and their pointer line are translated. Other UI text is untouched.
- A model without credentials, or a translation reply that cannot be validated, leaves the affected tips in English.

## Development

Changes land through a PR. Create a worktree, work there, and open a PR. The `test` check is required to pass before merging.

Run tests locally:

```sh
bun test
```

The tests are `bun:test` unit tests for the pure modules and the extension wiring. They cover catalog extraction and hashing, matching with placeholders and ANSI codes, the atomic store and cross-session lock, batched translation validation, and the extension's first-run, changed-hash, command, reload, missing-seam, and corrupt-store paths. Extension tests use fake senpi and pi-tui modules and fresh imports, never a live OMO session, and no test sleeps.

An isolated live replay (`bun qa/live-replay.mjs`) drives a real TUI against a temporary agent directory; see [CLAUDE.md](CLAUDE.md). Live tests never touch `~/.omo`, the real health daemon, the inbox server, or HKCU Run values. They use a temp HOME/USERPROFILE/APPDATA/LOCALAPPDATA under a throwaway directory.

The package requires Bun >= 1.4.

## License

MIT. See [LICENSE](LICENSE).
