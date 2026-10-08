# Test removal guard

Detects tests that disappear or are renamed between a base and HEAD, which would otherwise hide
a removed feature without any failing test. CI integration is a separate ticket.

## Scripts

- `tsx scripts/list-tests.ts --root <dir>`: prints a sorted JSON array of
  `{runner, project, file, name}` for vitest and Playwright. `file` is relative to `<dir>`; no
  line/column and no absolute paths. It runs `vitest list --json` and
  `playwright test --list --reporter=json` with `cwd=<dir>`, so it uses that checkout's own
  configuration. It needs no browser and no database (`DATABASE_URL` is cleared, so vitest does not
  run the integration `globalSetup`). Exit 2 if a command fails or the output is malformed.
- `tsx scripts/check-test-removal.ts --base <file.json> --head <file.json> [--labels <file.json|string>] [--body-file <path>]`
  - exit 0: nothing missing, or missing tests with a valid exemption (listed as `::warning`);
  - exit 1: tests missing without a valid exemption (listed as `::error`, at most 50 plus the total);
  - exit 2: tool error (empty or malformed list, unreadable file, bad arguments).
  - `--labels`: JSON array (strings or `{name}` objects, e.g. from `gh`), a JSON file, or a
    comma separated string.
  - The PR body is untrusted: it is only read from a file and parsed as text.
- `npm run test:guard -- --base-ref <ref> [--labels ...] [--body-file ...]`: local comparison between
  `<ref>` (default `origin/main`, checked out in a temporary `git worktree`) and the working copy.

## Rules

- A test id is `runner + project + file + full name`. Comparison is by occurrence count: two
  identical tests in base and one in HEAD means one is missing. Moving a test to another file or
  renaming it counts as removal; added tests are always fine.
- A test run by two Playwright projects counts twice.
- **Test names must be deterministic.** Names containing a date, a random value or any generated
  data change at every run and produce false positives. `test.each` names are kept literal
  (`%s`, `%j`, `${...}` are not interpolated).
- Exemption: label `rimozione-funzionalita` **and** a section `## Rimozione funzionalità` in the PR
  body with at least 30 characters of real text. HTML comments, empty lines and placeholder lines
  (`...`, `TODO`, `TBD`, `N/A`, lines starting with "Descrivi", `[...]` or `<...>` only) are not
  counted. The heading is matched ignoring case, accents and extra spaces.
