# PATCHES — pi-agent-browser-native (local extension)

Local patches applied to the local copy at
`/home/yusuf/.pi/agent/extensions/pi-agent-browser-native` (wrapper 0.6.13 + upstream
`agent-browser` 0.37.0). They exist because this copy is a **local pi extension**, not an npm
install: `bun`/`npm` updates will not restore them, and `pi install npm:pi-agent-browser-native`
must NOT be run again (duplicate tool registration).

Paired versions: wrapper **0.6.13** requires upstream **>= 0.35.0**; this machine runs 0.37.0.
A full Pi restart is required for changes to load (`/reload` keeps already-imported modules).

## Environment fixes (not code)

| # | Change |
| --- | --- |
| E1 | Removed the duplicated extension source that registered `agent_browser` twice (old v0.3.0 moved to `~/.pi/agent/backup/pi-agent-browser-native.bak-0.3.0`). |
| E2 | Upgraded wrapper 0.3.0 → **0.6.13** and upstream `agent-browser` 0.34.0 → **0.37.0** (`bun add -g agent-browser@0.37.0`); Chrome 153 downloaded. |
| E3 | Installed the extension as a **local** extension: `settings.json` line 57 points at the directory instead of `npm:pi-agent-browser-native@0.6.13`; `cross-spawn` and its 5 transitive deps are vendored into the extension's `node_modules`. |

## Upstream bugs worked around in wrapper JS

| # | Upstream defect (verified on 0.37.0) | Wrapper behaviour | Files |
| --- | --- | --- | --- |
| P1 | `storage local get <missing-key>` rendered a redacted `[REDACTED]` for a nonexistent value. | A missing/empty value now renders empty instead of falsely redacting. | `lib/results/presentation/diagnostics.js` |
| P2 | Launch-scoped flags were only guarded for managed sessions. | 11 more flags recognised (`--no-auto-dialog`, `--color-scheme`, `--proxy`, `--proxy-bypass`, `--ignore-https-errors`, `--engine`, `--extension`, `--allow-file-access`, `--config`, `--pin-tab`, `--no-pin-tab`); `LAUNCH_SCOPED_FLAGS` 26 → 37 (verified against the pristine 0.6.13 tarball; nothing removed). | `lib/launch-scoped-flags.js` |
| P2b | Root sessions (`pi-root-*`) accepted mid-session launch-scoped flags that upstream silently ignores. | The launch-scoped guard now also covers root sessions, with the "would replace the live browser context" wording. | `lib/orchestration/native-session-defaults.js` |
| P3 | Batch snapshot `--search`/`--filter` steps were presented unfiltered, contradicting the same command run directly. | Batch snapshot steps apply the requested filter in presentation and print the `Snapshot filter: …` header. | `lib/results/presentation/snapshot-step-filter.js` (new), `…/batch.js` |
| P5 | `state clear <name>` **ignores the name and deletes every saved state file** in the state dir. | All forms blocked (direct, `--all`, `-a`, prefixed globals, batch steps) with guidance to delete specific files with host tools. Verified: 9 state files before → 9 after a blocked attempt. | `lib/orchestration/input-plan.js` |
| P6 | `diff snapshot` without `--baseline` diffs against an empty baseline, so it always reports `changed: true` with 0 removals — a silently wrong "the page changed" signal. | Blocked with both working alternatives (`--baseline <file>`, or the wrapper-side `snapshot --diff`). `diff url`, `diff screenshot`, and batch steps with `--baseline` are untouched. | `lib/orchestration/input-plan.js` |
| P7 | `errors --clear` reported "Page error buffer cleared" but the rows survive (they reappear on the next read). | The result now says the clear was *requested* and that 0.37.0 may not purge the buffer. Patched in **both** `formatDiagnosticSummary` and the model-visible `formatErrorsText`. | `lib/results/presentation/diagnostics.js` |
| P8 | `state rename <old> <new>` fails in every documented form: sessionless forwarding → `Missing 'path' parameter`; any path-like operand → `Invalid session name …`. | The wrapper performs the rename itself (`fs.rename`, relative names resolved against the working directory), refuses self-rename and overwriting an existing file, reports both absolute paths, and rejects the command inside `batch` (it cannot be delegated upstream). | `lib/orchestration/browser-run/prepare.js`, `lib/orchestration/input-plan.js` |
| P9 | `set geo <lat> <lon>` succeeds but never grants the geolocation permission, so pages always get `User denied Geolocation` (`permissions.query` → `denied`) and the documented emulation is invisible to the page. | After the upstream override, the wrapper installs a page-level `navigator.geolocation` stub (`getCurrentPosition`, `watchPosition`, `clearWatch`, plus `permissions.query → granted`) in the active document, writes `/tmp/piab-geolocation-init-script.js` (mode 600) for the same coordinates, and appends a note with the `--init-script` + `sessionMode: "fresh"` recipe that keeps it working across navigations. | `lib/orchestration/browser-run/geolocation-stub.js` (new), `…/process-output.js`, `…/final-result.js` |
| P10 | `cookies get` is scoped to the active page origin and **silently ignores `--url`**, so an empty list reads as proof that no cookies exist. | Empty reads carry an explicit note: origin-scope wording normally, plus the ignored-`--url` wording when `--url` was passed. | `lib/results/presentation/diagnostics.js` |

## Documentation fixes (our files)

| # | Change |
| --- | --- |
| D1 | `docs/COMMAND_REFERENCE.md`: `state list` vs `state save <path>` scope, relative-name resolution, and that `state rename` is performed locally (cannot run in `batch`). |
| D2 | `docs/COMMAND_REFERENCE.md`: canonical `set device` presets (`iPhone 15`, `iPhone 16`, `iPhone 16 Pro`, `iPhone 17`, `iPad`, `iPad Pro`, `Pixel 9`, `Galaxy S25`) and that the upstream README examples (`iPhone 14`, `iPhone 15 Pro`) are stale. |
| D3 | `docs/COMMAND_REFERENCE.md`: `cookies get` origin scope and ignored `--url`. |

## Intentionally NOT changed

| Surface | Reason |
| --- | --- |
| `file://` navigation reads local files (e.g. `/etc/passwd`) | Upstream policy, not a bug: `docs/TOOL_CONTRACT.md` states `file://` navigation/inspection pass through unchanged. Re-adding a guard would contradict documented behaviour — decide explicitly if you want it back. |
| `state save <path>` not appearing in `state list` | Design, not a defect: `state save` writes to the path you give, `state list` enumerates restore states under `~/.agent-browser/sessions`. Now documented (D1). |
| `set device` stale names | Upstream README drift, not our file; the canonical list is now documented (D2) and upstream's error already prints it. |
| iOS provider / cloud provider setup | Requires external accounts, Xcode/Appium; the wrapper stays thin by design. |

## Verification

* Offline: resolver/unit checks for P5, P6, P8 (guards, 11/11 + 7/7), P10 (cookie notes 11/11), P9 stub shape (position `{coords,timestamp}`, `permissions.query → granted`, `watchPosition`).
* Live (fresh processes, real browser): P1, P2b, P3, P5 confirmed in the parent session after restart; P6/P7 11/12 then 7/7 after the wording fix; P8/P9/P10 21/22 then 9/9 after the stub shape fix; regression sweep of P1, P5, P6, P7, P3, P1-storage, P2b all green.
* All ten patches re-confirmed live in the parent session after the final restart.

## Verified divergence from pristine 0.6.13

Audited with `diff -rq` against the 0.6.13 tarball recovered from the local npm cache
(`_cacache` → `pi-agent-browser-native-0.6.13.tgz`). Nothing outside this table differs:

| File | Delta |
| --- | --- |
| `lib/launch-scoped-flags.js` | 47 lines (P2) |
| `lib/orchestration/input-plan.js` | 81 lines (P5, P6, P8-batch) |
| `lib/orchestration/browser-run/prepare.js` | 62 lines (P8) |
| `lib/orchestration/browser-run/process-output.js` | 6 lines (P9) |
| `lib/orchestration/browser-run/final-result.js` | 5 lines (P9) |
| `lib/orchestration/native-session-defaults.js` | 23 lines (P2b) |
| `lib/results/presentation/diagnostics.js` | 38 lines (P1, P7, P10) |
| `lib/results/presentation/batch.js` | 20 lines (P3) |
| `lib/orchestration/browser-run/geolocation-stub.js` | new file (P9) |
| `lib/results/presentation/snapshot-step-filter.js` | new file (P3) |
| `docs/COMMAND_REFERENCE.md` | D1–D3 |

`package.json`, `README.md`, `CHANGELOG.md`, `scripts/`, and `platform-smoke.config.mjs` are byte-identical to the
published release, so the ten files above are the complete local delta.

Two measurement traps worth remembering when re-auditing by hand:

* Counting `"--flag"` string literals in `launch-scoped-flags.js` yields **36**, not 37, because the short provider flag
  `-p` has no `--` prefix. The exported array length (37) is the real number.
* Naming: there is no `P4` in this file. The numbering follows the investigation order (P2b was split out of P2), and the
  original P4 candidate turned out to be the documented `file://` policy, which is not a bug — see the table below.

## Round 2: credential vault + requested features (P11–P22)

The second round adds a credential vault ported from `NousResearch/hermes-agent` (studied read-only from a local clone)
plus the features requested after the comparison with `pi-config/extensions/browser`.

| # | What | Why | Files |
| --- | --- | --- | --- |
| P11 | **Credential vault**: encrypted store (AES-256-GCM, 32-byte key file at 0600, optional scrypt passphrase), entries bound to an exact origin, entries for login/totp/card/address | The wrapper redacts secrets so hard that the agent could not authenticate anywhere; upstream `auth save/login` stores profile credentials but has no room for TOTP seeds, cards, addresses, or a wrapper-enforced origin binding | `lib/vault/store.js`, `lib/vault/fill.js`, `lib/vault/intake.js` |
| P12 | **Secret registry**: every filled value is registered in memory and scrubbed by exact value from content, `details` and spills | Once a real password reaches a session, field-name redaction cannot catch it if the page or a console message echoes it back | `lib/vault/secret-registry.js`, `final-result.js` |
| P13 | **`revealSecrets`**: per-call opt-in that stops redacting named headers on matching network rows, prints a warning, and deletes any spill file for that call | Redaction made auth debugging impossible — the one job a browser tool is really needed for | `lib/orchestration/browser-run/reveal-secrets.js` |
| P14 | **`verbosity: quiet\|normal\|verbose`**: gates diagnostic prose and the next-action list only; structure, categories, `details` and every security warning are unaffected | ~21 prose blocks were appended to every result | `lib/orchestration/browser-run/verbosity.js` |
| P15 | **Input-mode conflicts are counted from supplied modes and named**; an unknown mode list is rejected with the supported list | Previously only successfully *compiled* modes were counted, so `{args, semanticAction}` reported the semanticAction compile error and a lone invalid mode produced a misleading “provide exactly one” failure | `input-plan.js` |
| P16 | **`debug` mode**: one-shot devtools report (url/title, console errors, page errors, bounded failed requests, optional eval result/screenshot) compiled to a fail-fast batch | Replaced four separate diagnostic calls for the most common frontend question | `lib/input-modes/debug.js` |
| P17 | **`settle` mode**: in-page quiet probe (`readyState` + no new resources + no DOM mutations for `quietMs`) that reports only counts and the URL | Flakiness: there was no reliable “the page is actually quiet now” primitive | `lib/input-modes/settle.js` |
| P18 | **`details.compiledScript`**: bytes, line count, sha256, bounded preview | Script was the most powerful input mode and left no audit trace at all | `final-result.js` |
| P19 | **`networkBody` mode**: bounded body preview for one request, honest `missingReason` when upstream only exposes ids | Bodies previously required a full HAR capture | `lib/input-modes/network-body.js` |
| P20 | **`devServer` mode**: detect candidates from `package.json`, wait for readiness, start/stop an owned process with log tails, and stop it on shutdown | Local QA always starts with “is my dev server up and on which port” | `lib/input-modes/dev-server.js`, `lib/orchestration/dev-server-host/handler.js` |
| P21 | **Opt-in tool activation** (`PI_AGENT_BROWSER_TOOL_ACTIVATION=opt-in`) with `/agentbrowser on\|off\|status`, persisted per session; default stays `always` | The schema + guidelines cost prompt tokens every turn even in sessions that never browse | `index.js` |
| P22 | **`login` preset**: load state → open → fill the vault credential through the page script → submit → wait → optional state save, all in one fail-fast batch | A login otherwise takes four calls and leaves a password with the model | `lib/input-modes/login-flow.js`, `lib/orchestration/login-host/index.js` |
| P23 | **Prompt guidance**: always-on guidance for the new modes, a secrets-handling rule (never type a password/card/2FA code by hand, never repeat one in chat, never auto-retry a declined card fill), and an explicit instruction to follow the user's directions without unsolicited objection | The model cannot use features it is not told about, and the vault policy is only real if it is stated | `lib/playbook.js` |

### Verification for round 2

* Live browser runs in fresh processes: **19/19** (vault round trip, ciphertext at rest, fail-closed permissions, registry
  scrubbing, RFC 6238 TOTP vector, then real page fills: mismatched origin refused with nothing written, origin-bound fill
  verified by reading the value back out of the page, explicit-selector fill, ambiguous-selector refusal, secret absent
  from argv).
* Live mode runs: **10/10** (`settle` against a real page, `devServer` start → status → detect → stop with the port confirmed
  closed afterwards). The live run found and fixed a real bug: `stop` claimed `still-alive` from a lagging `exitCode`
  even though the port was already closed; it now decides from the observable port probe.
* Offline regression: **21/22** on the P1–P10 guards and every input mode (the one miss is a test stub whose guard lives in
  `prepare.js`, verified separately by grep).
* Every touched file passes `node --check`, and the extension entry (`index.js`) plus all new modules import cleanly.

### Re-sweep after the first reload (what changed, what still needs a fix)

The second verification round ran through the tool with the fixes loaded. Results, honestly:

| Item | Outcome |
| --- | --- |
| `settle` | PASS - `{"reason":"quiet","settled":true,"waitedMs":401}` on a real page |
| `networkBody` | PASS - returned the real response body text for a request id (no crash, no false `missingReason`) |
| `login` preset | **PASS on the key assertion** - `Completed on http://127.0.0.1:39412`, plan `5 rows (open → wait → eval → get → wait)`, and the old "active page became unverified" refusal is gone |
| Diagnostics ring buffer | PASS - first `errors` read said `1 new errors row(s) since the previous read`, the second said `1 of 1 errors row(s) were already reported earlier in this session (0 new)`; the same held for `console` |
| `debug` report text | still partial: the steps render and nothing crashes, but the compact report line was not yet in the text (the renderer landed after this run) |
| `revealSecrets` header line | still partial: the warning fired (`… on 1 rows matching example`) but the indented `→ authorization: …` line was missing (the presentation half landed after this run) |
| `verbosity` quiet | inconclusive on `get title` (that command appends no diagnostics, so normal and quiet are identical) - needs a diagnostic-heavy command such as a failing click |

Two real fixes came out of this round:

* `debug`'s network step now reads `network requests --current-page` (plus `--filter` when given), so the report is scoped to the page instead of echoing the whole session aggregate (a first manual run displayed 40 subresource rows).
* `login` now takes the identifier from the vault entry when the caller only supplies a handle: previously a handle-only preset filled the password but left the username field empty (`{"u":0,"p":12}`), because the identifier had no source.

Residual limitation recorded by the verifier: exact-value redaction matches whole values only, so a *partial* echo of a secret (for example its first two characters) is not scrubbed. That is inherent to identity-based scrubbing and is why the fill path never returns the value in the first place.

### Second re-sweep: live verification of the round-2 fixes

Run through the tool after the next reload, on real pages:

| Item | Live evidence |
| --- | --- |
| `debug` report | The `Debug report:` block now leads the appended prose, with `counts` (actionableFailedRequests, consoleErrors, pageErrors, steps) |
| `verbosity: quiet` | A failing `get text #missing` printed the failure and its category under `normal`, and only the failure under `quiet` - the `Next actions:` block disappeared while `details` kept everything |
| `login` preset, handle only | `Login flow: 6 rows (open → wait → fill → eval → get → wait)` and `Completed on http://127.0.0.1:39421`; the identifier came from the vault entry's metadata (`u:18` = the stored username) and the password from the secret (`p:10`) |
| `devServer` | `start` answered `Started … and it answers at http://127.0.0.1:39421/`; `stop` reported `Stopped devserver-…` and the port stopped answering |
| Diagnostics ring buffer | `1 new network row(s) since the previous read` on the first read, `… already reported earlier …` on the repeat |
| Input-mode conflict | `Provide exactly one input mode, but this call supplied args and devServer` plus the full supported-mode list |
| Ref guards (regression) | a stale `@e999` from another page was still refused with `failureCategory: stale-ref` |

Two refinements came out of this round and are verified offline (8/8) but need one more reload:

* `debug`'s network step now scopes itself with `--filter <host:port>` derived from the URL being debugged. The previous attempt used `--current-page`, and the live run showed why that cannot work: `--current-page` is a wrapper-side *early-result* filter that is only parsed for a top-level `network requests` command, so inside a batch step it does nothing and the step returned the whole session aggregate (40+ subresource rows).
* `revealSecrets` now prints the indented `→ authorization: …` line for `network request <id>`, whose payload really does carry `headers`. For the *list* command it instead states honestly that this payload has no request headers and points at the detail read - the previous behaviour printed a warning implying a value had been shown.

A live check then found one more piece of plumbing for that feature: `presentation.js` built `commandInfoWithTokens` without the reveal scope, so the formatters saw the flag only as `undefined` even though redaction had been told about it. The first call after the fix is what proves it (a warning plus either the revealed `→ authorization: …` line or an explicit "this payload has no request headers" sentence).

That fix then exposed the real reason the value never appeared, which is worth recording because it is easy to get wrong twice: the prose formatter receives the **unredacted** payload while the reveal annotation lands on the **redacted** copy, and - more decisively - the visible prose is run through `redactSensitiveText`, which rewrites `Bearer <token>` back to a placeholder. Measured directly:

```
redactSensitiveText("  → authorization: Bearer closing-check-999")
  -> "  → authorization: Bearer [REDACTED]"
```

So the revealed value is now printed **after** every redaction pass, as a trailing `Revealed value(s):` block appended by `final-result.js`, and the prose only points at it. `collectRevealedHeaderLines` reads the value from the presentation payload, skips `[REDACTED]` placeholders, and returns nothing when the payload carries no headers - which is why the list command gets an explicit sentence instead of an empty promise.

A final live run showed the same redaction ordering biting one more time: the per-row `→ authorization: …` line in the *list* prose printed `Bearer [REDACTED]`, because the formatter emitted the real value and the string redactor then rewrote it. Since prose can never carry a revealed value, that per-row line was removed entirely; exactly one place prints values, and it is the trailing block after all redaction. The list prose keeps a neutral pointer instead ("Reveal requested for: authorization. Values, when this payload carries them, are printed at the end of this result…"), which cannot contradict the block.

Confirmed live in the same round: `debug`'s network step is scoped (`network requests --filter 127.0.0.1:39422`, two rows instead of the 40+ row session aggregate), and the `Debug report:` block leads the appended prose.

### Still to verify after a Pi restart

These paths are wired and unit-checked but were not exercised end to end through the tool itself, because the running Pi
process still has the previous code loaded: the `vault`/`login`/`devServer` host branches inside `execute()`,
`details.debugReport`/`settleReport`/`networkBody`, the reveal warning rendering, quiet-mode output, and the
`/agentbrowser` command.

## Round 2b: what the first E2E sweep found, and the fixes

The first sweep through the tool (three parallel verifiers, one of them against a real local login form) produced five
defects. All five are fixed; every fix is syntax-checked and covered by an offline assertion run.

| Defect found by the sweep | Root cause | Fix |
| --- | --- | --- |
| `debug`, `settle`, and `networkBody` crashed with `Cannot destructure property 'compiledElectron' of 'normalizeRunInput(...)' as it is undefined` | `normalizeRunInput`'s `switch (kind)` had no case for the new kinds and no `default`, so it returned `undefined` | added the new kinds plus a `default: return base` (`prepare.js`) |
| `verbosity` was inert and the `revealSecrets` warning never printed | the `prepared` literal in `prepare.js` carried none of the new fields, so `final-result` always saw `undefined` | threaded `verbosity`, `revealSecrets`, `compiledDebug/Settle/NetworkBody/Script/Vault/Login` and `kind` through the run plan |
| The `login` preset was refused wholesale: *"The active page became unverified after a … script … transition"* | an `eval` fill row is a page transition for the wrapper's own page-target validation, and the compiled plan had no `get url` afterwards | the compiler now emits one `get url` row after the credential scripts, inside the same fail-fast batch (`login-flow.js`) |
| `login` was rejected by the tool schema (`must not have additional properties`) | the schema lacked `password`, `otp`, `otpSeed`, `totp`, `settleAfterEachStep` | schema and wrapper are back in sync (`params.js`) |
| `vault fill` with no explicit `fields` said *"None of the requested roles can be filled from this entry"* | `entryFieldsForType` returned the `{ role }` objects and the caller wrapped them a second time; a handle-only fill also demanded an explicit `origin` even though the entry carries it | returns role names now, and `origin` is optional when a `handle` is given (the page is still verified against the entry's origin) |

Two more fixes came out of the same round, both found by reasoning about the sweep rather than by it:

| Fix | Why |
| --- | --- |
| `revealSecrets` can actually show a header now | the sweep proved the warning could fire but there were no header rows to reveal: network presentation never printed request headers, and the payload was redacted before presentation. `redactPresentationData` now copies the named header values back from the untouched payload (leaving the main payload redacted) and the list formatter prints them under the row. |
| A masked prompt in a subagent refuses instantly instead of hanging | `ctx.ui.custom` has no timeout, so an unattended prompt could block a run forever. A `PI_SUBAGENT_CHILD=1` session now gets `prompt_unavailable` with an explanation (saved credentials still work there), and the component carries its own 5-minute deadline because Pi's `custom()` accepts no timeout option. |
| `verbose` now does something real | `shouldAppendDetailedSections` was unused, so `verbose` behaved exactly like `normal`. It now raises the suggested-action list from six entries to twenty-five. |
| Diagnostics ring buffer (P24) is wired | `console`/`errors`/`network requests` reads are annotated with how many rows are new versus already reported, because upstream's `--clear` does not purge its buffer. Rows are never dropped; the annotation only adds counts and indexes. |

### Real-world vault proof (not a fixture)

With a real university LMS account, through the tool, on the currently loaded build:

1. `open https://<student-portal-removed>/login/index.php` → the sign-in page.
2. `vault save` (handle `yarsi-layar`, origin `https://<student-portal-removed>`, identifier + password) → *"Saved vault entry … The password is stored encrypted and is only ever filled into that exact origin."* and the password field was filled in the same call; the snapshot then showed `textbox "Password": ••••••••••••` with no value anywhere in the result.
3. The identifier was typed by the agent itself (it is not a secret) and the sign-in button clicked.
4. Verification read straight from the page: `{"url":"https://<student-portal-removed>/my/","title":"Dashboard | LAYAR","user":"You are logged in as … (Log out)","hasLogout":true,"passwordFieldPresent":false}`.

The password was never typed by the model into a page and never appeared in any tool result.

## Round 2c: the masked-prompt save path was broken (P25)

Found by using it for real, on the first attempt to save a login **without** passing `secret` — which is the
documented, privacy-preserving flow (the user types the password into the masked dialog; the model never sees
it):

```
vault.save with type "login" needs at least a username or a secret.
```

Reproduced against the validator with a username present:

| input | result (before the fix) |
| --- | --- |
| `{ type: "login", username: "…" }` | **rejected** — "needs at least a username or a secret" |
| `{ type: "login", secret: "…" }` | accepted |
| `{ type: "login", username: "…", secret: "…" }` | accepted |

Root cause was ordering, not logic: `normalizeVaultSave` builds its plan as `{ action, handle, origin,
overwrite, type }` and copies `label`/`username` onto it at the *end* of the function, but the login check
`if (input.type === "login" && !value.secret && !value.otpSeed && !value.username)` runs before that copy.
So `value.username` was always `undefined` at check time, and the only way to save a login was to pass the
secret yourself — exactly what the vault exists to avoid. The non-secret fields are now copied onto the plan
before the type-specific checks, and the validator is pinned by assertions for all six combinations
(username-only accepted, secret-only accepted, both accepted, neither rejected, card+secret rejected,
totp-without-seed rejected, card-without-card rejected).

This is why the real-account proof above passed: that flow supplied the credential through the vault fill
path, so it never exercised a secret-free `save`. A test that only ever takes the happy path through one
door will not notice a locked second door.

### Operational note: an aborted `vault.save` can still have written the entry

`handleSave` writes the encrypted entry and *then* runs its post-save fill on the current page
(`fillAfterSave = true`). A call that is cancelled or times out during that fill step reports
`This operation was aborted` while the entry is already on disk - observed live, where a temporary
one-time-code entry survived an aborted save and had to be removed with `vault.remove`. So an abort is not
a rollback: after any aborted `vault.save`, read `vault.list` before assuming nothing was written.

Related, and worth stating plainly because a one-time code looks like a secret but is not one: storing a
TOTP/email OTP in the vault has no value. The code changes every time it is issued, and the way to stop
being asked for it is not to keep it but to tick `This is a trusted device` on the password screen before
continuing, which suppresses the verification step for that browser profile.

## Round 2d: prompt-guidance placement (P26)

Two things were wrong with where the guidance lived, and both were measured rather than assumed.

### The obedience rule sat in the conditional channel

"Follow the user's explicit instructions directly … proceed without further objection" lived only in
`PROJECT_RULE_PROMPT`, which `before_agent_start` appends to the system prompt **only when the user's prompt
matches `BROWSER_PROMPT_PATTERNS`** - and that list is English-only. Measured against the real patterns:

| prompt | appended? |
| --- | --- |
| `screenshot halaman ini` | yes |
| `buka https://example.com dan ambil judulnya` | **no** |
| `login ke situs itu` | **no** |
| `cari dokumentasi di web` | **no** |

So an Indonesian request could miss the rule entirely. It now lives in `RUNTIME_PROMPT_GUIDELINES` (the
always-sent `promptGuidelines`, first entry), and `PROJECT_RULE_PROMPT` keeps only its original
prefer-the-native-tool job so the sentence is moved, not duplicated. Tier A grew from 9 entries / 2,483 chars
to 11 entries / 3,279 chars; the built payload (14 guidelines / 3,686 chars) is asserted to contain both new
lines. The same obedience clause was added to the operator's global `AGENTS.md` rule 1, since that file is
always in context regardless of extension state.

### Browsing was headless by default

The operator wants to watch the work. Tier A now carries a visible-browser default: launch the first call with
`--headed` plus `sessionMode: "fresh"`, stay headless only when asked or when the run is unattended, and carry
an authenticated session across the launch with `state save` → `--state <file>` (a headed launch is a new
browser with an empty profile). The same practice is written into `README.md` ("Local default in this setup")
and `docs/COMMAND_REFERENCE.md` (the headed section, including the `chmod 600` note for the saved-state file
that holds session cookies), and into `AGENTS.md` rule 2.

### Still open (documented, not patched)

`before_agent_start` is registered outside the `PI_AGENT_BROWSER_TOOL_ACTIVATION=opt-in` gate, so in opt-in
mode with the tools off, the "Project rule: prefer `agent_browser`" paragraph can still be appended for a
pattern-matching prompt - pointing at an inactive tool. The activation gate should also gate that hook.

### Token-slim prompt surface (guide-gate companion)

The operator runs a prompt-slimming setup (`~/.pi/agent/extensions/pi-guide-gate`) where each
extension ships a one-line description + mandatory guide path, and a gate blocks first use until
the guide is read. Three changes here, all marked `local patch` in `dist/extensions/agent-browser/index.js`:
(1) `AGENT_BROWSER_PARAMS_SLIM` replaces `AGENT_BROWSER_PARAMS` at registration — top-level mode
names only, `additionalProperties: true`; real validation stays in `resolveAgentBrowserInput` and
CLI errors. (2) Tool description is a one-liner + input-mode list + guide path
(`docs/COMMAND_REFERENCE.md`). (3) `toolPromptGuidelines` keeps only config-driven lines
(`agent_browser config sets…`) plus a slim always-on canonical block: 5 invariants (always-on tool
use, secrets via vault/login, verify mutations, explicit user stop boundaries, follow
`details.nextActions`) + the 4-gate map (LIHAT/LAKUKAN/KELOLA/OTOMASI) + the docs guide-gate
pointer, joined ≤900 chars (guard: `tests-v2/wave1-d-prompt-length.mjs`).
Effect: agent_browser payload dropped from ~4,788 to ~243 tokens (o200k estimate). Upgrade will
clobber this file — reapply or restore from this note.

## Round 2f: the vault could not reach a profile browser (P27)

Found in live use on 2026-09-17. The operator runs a persistent profile browser under an explicit session
(`--session ultron1 --profile ~/.pi/agent/browser-profiles/ultron1`) so logins survive restarts. Logging
out of LAYAR and trying to log back in through the vault failed with:

```
Refused to fill: the entry yarsi-layar is bound to https://<student-portal-removed>, but the page is about:blank.
```

Nothing was wrong with the vault or the page: `vault` and `login` had **no way to name a session**, so their
browser calls (`get url`, `eval --stdin`, the compiled batch) always ran against the implicit root session,
whose browser sat on `about:blank`. Under a profile policy the vault was therefore unusable — the one mode
whose whole job is re-authentication could not address the browser that holds the login.

| # | What | Why | Files |
| --- | --- | --- | --- |
| P27 | **`session` field for `vault` (`fill`, `totp`) and for the `login` preset**: validated as `[A-Za-z0-9][A-Za-z0-9._-]*` (≤64 chars, matching upstream session naming) and prefixed as `--session <name>` on every browser call the action makes | A fill has to land in the browser that owns the session; the implicit root session is a different browser | `lib/input-modes/vault-mode.js`, `lib/orchestration/vault-host/index.js`, `lib/input-modes/login-flow.js`, `lib/orchestration/login-host/index.js`, `lib/input-modes/params.js` |

Implementation notes:

- `vault-host` and `login-host` wrap the injected `dispatch` once (`withExplicitSession`) instead of threading
  the name through every call site, so `get url`, the fill/totp `eval`, and the compiled login batch all inherit
  the same session prefix, and every existing guard (origin check, ref guards, redaction, presentation) still runs.
- `session` is deliberately absent from `status`, `list`, `save`, `remove` and `unlock`: those are host-side and
  never touch a page.
- Usage: `{ "vault": { "action": "fill", "handle": "yarsi-layar", "origin": "https://<student-portal-removed>", "session": "ultron1" } }`
  and `{ "login": { "url": "https://<student-portal-removed>/login/", "handle": "yarsi-layar", "session": "ultron1", "submit": true } }`.
- A restart is required before the patch is live (Pi keeps the compiled module it loaded at startup).

## Round 3: every `args`-mode call failed with "Provide exactly one input mode" (P28)

Found live on 2026-09-17 while opening the profile browser. Every `agent_browser` call with
`args: [...]` returned `failureCategory: "validation-error"` with the zero-modes message, while
`script` mode worked fine. Root cause: the harness/provider delivers array and object tool params
as JSON strings, so `params.args` arrived as a string — `Array.isArray` failed and
`resolveAgentBrowserInput` counted zero supplied modes. Pi core's own `edit` tool compensates for
exactly this provider quirk via `prepareEditArguments` (JSON-parses a stringified `edits` field),
but the agent-browser tool definition had no `prepareArguments` at all.

| # | What | Why | Files |
| --- | --- | --- | --- |
| P28 | **`prepareArguments` on the agent_browser tool definition**: JSON-parses stringified `args`/`stdin` (array) and the eleven object mode fields (`semanticAction`, `job`, `qa`, `electron`, `debug`, `settle`, `networkBody`, `vault`, `devServer`, `login`, `sourceLookup`, `networkSourceLookup`) before pi core validates and dispatches | Without it, every args-mode call from a provider that stringifies array params reports "Provide exactly one input mode" (zero modes supplied) | `dist/extensions/agent-browser/index.js` (tool definition, next to `promptGuidelines`) |

Implementation notes:

- Parse-only guard: a field is replaced only when `JSON.parse` succeeds AND the parsed value has the
  expected shape (array for `args`/`stdin`, plain object for the mode fields). Literal string payloads
  (e.g. `stdin` for `eval --stdin`, non-JSON `args` text) pass through untouched.
- `script` mode was unaffected (string param) and continues to work.
- A restart is required before the patch is live (Pi keeps the compiled module it loaded at startup).

## Round 4: Patch Integrity Ledger (PL1)

The 28 hand-applied patches had no structural guard: an update or re-install could silently clobber them and the wrapper would keep spawning. FINAL-DESIGN.md §5 step 1 closes that hole with a checksum ledger verified before every spawn.

| # | What | Why | Files |
| --- | --- | --- | --- |
| PL1 | `patches/patches.manifest.json` pins sha256 of every divergent file (the 11 code files from the divergence table + `index.js`, plus the ledger itself); `verifyPatchLedger()` checks once per process and caches the verdict; `runAgentBrowserProcess` refuses to spawn naming each drifted/missing file | Drift must be detectable structurally, not by mysterious downstream failures — drift = hard refusal, "No silent fallback"; a missing manifest is tolerated (fresh install) | `patches/patches.manifest.json` (new), `lib/patches-ledger.js` (new), `…/process.js` (pre-spawn hook), `scripts/verify-patches.mjs` (offline CLI) |
| PL2 | Prompt-slim v2: always-on Tier A block in `lib/playbook.js` (`RUNTIME_PROMPT_GUIDELINES` — 5 invariants incl. explicit user stop boundaries + 4-gate map + guide-gate pointer, ≤900 chars, guarded by `tests-v2/wave1-d-prompt-length.mjs`); tool `description`/`promptSnippet` switched opt-in → always-on; dead `buildInstalledDocsGuideline`/`TOOL_PROMPT_GUIDELINES_SUFFIX` exports removed | Opt-in wording contradicted the always-on policy; the removed stop-boundary line was safety-bearing | `dist/extensions/agent-browser/lib/playbook.js`, `dist/extensions/agent-browser/index.js` |

PL1-fix: settle-retry excludes batch (double-dispatch), adds settleRetryOutcome detail + retry timeout clamp (review round 1)

After any package update: `node scripts/verify-patches.mjs` must print all-OK (exit 0) before restarting Pi. On DRIFT/MISSING, re-apply the patches above, then re-pin the hashes from the verified tree.
