# UNDERSTANDING — pi-agent-browser-native 0.6.13 (local, patched)

Written for a head-to-head comparison against another browser tool.
Source of the numbers: full re-read of `dist/` (104 files, 27.5k lines) + `docs/` + an audit against the
pristine 0.6.13 tarball from the local npm cache. Local patches: see `PATCHES.md`.

## 1. Essence in one paragraph

It is a **wrapper, not a driver**. It owns no browser, no CDP client, no page model. Every action becomes
one `spawn("agent-browser", argv)` call against the upstream Vercel Labs CLI (`agent-browser` 0.37.0,
floor 0.35.0), with `--json` injected and the JSON envelope parsed back into a Pi tool result. Its entire
value is what it adds around that process: argv planning and guarding, session ownership, evidence-based
verification of claims upstream makes, bounded agent-facing presentation, redaction, and a machine-readable
outcome contract. Consequence: latency and process count are worse than an in-process driver, but every
truth comes from the same binary a human would run, and upstream feature growth is inherited, not reimplemented.

## 2. Layers and the call chain

```
Pi host
 └─ dist/extensions/agent-browser/index.js        (1833 L)  factory: registers tools, 6 pi.on hooks, all mutable state
     ├─ lib/input-modes/          8 mode compilers → one `kind`, one argv/stdin, one redacted shape
     ├─ lib/orchestration/input-plan.js          deterministic mode/guard chain (347 L)
     ├─ lib/orchestration/native-session-defaults.js  native config/root identity, launch-scope guard (180 L)
     ├─ lib/orchestration/browser-run/index.js   run entry (81 L)
     │   └─ prepare.js (1189 L)  ~17 early returns + 45 guards + wrapper-side feature shims
     │       └─ lib/process.js (571 L)  the ONLY spawn site: env, timeouts, socket-dir trust, stdout spill
     │           └─ process-output.js (841 L)  parse → recover → ~25 diagnostics → state machine → presentation
     │               └─ final-result.js (540 L)  content + `details` (79 keys) + redaction
     ├─ lib/orchestration/electron-host/index.js  host-only Electron actions (829 L), never the browser pipeline
     └─ lib/input-modes/script.js + script-worker.js  sandboxed one-shot JS with its own isolated browser session
```

Supporting substrate: `runtime.js` (1043 L: argv planner, redaction, implicit session names, transcript replay),
`results/presentation/*` (per-command formatters), `lib/managed-session-*` (restore keys, snapshots, policy lock),
`lib/session-page-state.js` (tab target, ref snapshot, read confirmations), `lib/temp.js` (temp roots, budgets),
`lib/web-search.js` (optional second tool).

## 3. Surface: one tool, 8 mutually exclusive input modes

`agent_browser` schema = 12 optional top-level props; exactly one of these must compile
(`input-plan.js:155-167`):

| Mode | Compiles to | Notable |
| --- | --- | --- |
| `args` | verbatim argv | 1:1 upstream coverage; the escape hatch |
| `semanticAction` | `find …` / direct selector / `select` | 4 actions × 7 locators; echoes `details.compiledSemanticAction` |
| `job` | `batch --bail` (11 step actions) | fail-fast default; semantic locators allowed per step |
| `qa` | `batch --bail` fixed recipe | asserts text/selector, console/network/page-error evidence; can pass→fail alone |
| `sourceLookup` | `batch` | EXPERIMENTAL UI→file candidates, ≤5000 workspace files |
| `networkSourceLookup` | `batch` | EXPERIMENTAL failed-request→source candidates |
| `script` | sandboxed Node child + recursive tool calls | 25 calls, 64 KiB source, 120 s/300 s, isolated always-closed session |
| `electron` | host-only lifecycle | list/launch/status/probe/cleanup; temp profile + OS-chosen CDP port |
| `debug` | `batch --bail` | one-shot devtools report (console/errors/failed requests/bounded snapshot) |
| `settle` | `eval --stdin` | real page-quiet probe (resources + DOM mutations), counts only |
| `networkBody` | `network request <id>` | bounded body preview, honest when upstream exposes ids only |
| `vault` | host-side store + page script | encrypted credential vault, exact-origin fill, TOTP, masked intake |
| `devServer` | host process | detect/wait/start/stop the local dev server (owned processes only) |
| `login` | `batch --bail` | login preset with the vault credential injected via the page script |

Every browser mode ultimately speaks the upstream CLI grammar: 84 known command tokens, 75 value flags,
23 optional-value booleans. That grammar is hand-mirrored in `argv-grammar.js` + `command-taxonomy.js`.

## 4. Session model

* **Implicit managed** `piab-<slug>-<12hex>-<8hex>`: reusable across calls, `/reload`, `resume`, branch switches; closed on Pi quit.
* **Root/native** `pi-root-<sha256(root Pi id)[:24]>`: caller-owned; shared by parent + subagents (`PI_SUBAGENT_ROOT_SESSION_ID`); survives quit.
* **Explicit** `--session X`: wrapper stops owning it; live URL verified before content calls.
* **Fresh** `sessionMode:"fresh"`: rotates the managed session so launch-scoped flags can apply.
* **Attached** (`connect`/`--cdp`/`--auto-connect`) and **script/electron** identities have separate, always-closed lifecycles.
* State is **replayed from the Pi transcript**, not from a wrapper-owned store. Restore keys are
  project-generation-scoped (git dir inode + birthtime + UUID marker), so a second checkout cannot adopt another's login.
* `details.managedSessionOutcome` reports one of `created|replaced|unchanged|closed|preserved|abandoned`.

## 5. What it does that a plain CLI wrapper would not

1. **Refuses instead of degrading.** 45 pre-spawn guards; 8 blocks exist purely because upstream 0.37.0 lies or destroys data.
2. **Emulates missing features wrapper-side**: `snapshot --search/--filter/--viewport/--diff`, `scroll to`, `network requests --current-page`, loopback direct anchor download, local `state rename`, geolocation stub.
3. **Verifies claims**: click-dispatch DOM-event probe, fill value re-read, scroll no-op diff, page-change observed-vs-dispatched, artifact existence/size/mtime, recording stop receipts via `session info`.
4. **Ref lifecycle**: per-session ref snapshot + URL alignment + batch ordering ⇒ stale `@eN` fails before spawn with an executable recovery action.
5. **Bounded output**: snapshot compaction (6000 chars/80 lines/60 refs), spill files with per-session 32 MiB budget, `outputPath` export, 512 KiB stdout cap with 0600 spill.
6. **Redaction as a construction rule**: argv, envelopes, `details`, spills, batch roll-ups, URLs (SAML/nonce), storage values.
7. **Machine-readable outcomes**: `resultCategory` / `successCategory` (5) / `failureCategory` (15) / `nextActions` (46 ids in results + 33 in orchestration) / `artifactVerification` / `pageChangeSummary` / `timeoutPartialProgress`, plus a `tool_result` hook that repairs Pi's `isError`.

## 6. Numbers worth citing

| Area | Value |
| --- | --- |
| Code | 104 files, 27.5k lines, 1 runtime dep (`cross-spawn`) |
| Process timeouts | 35 s wrapper default, 25 s `AGENT_BROWSER_DEFAULT_TIMEOUT` clamp, SIGTERM→SIGKILL 2 s |
| Stdout | 512 KiB RAM cap, 32 000-char tail, 0600 spill |
| Sessions | idle 900 s, close 5 s, policy lock 1 s (10 ms retry) |
| Snapshot | 6000 chars / 80 lines / 60 refs inline; ≤10 high-value controls/line class |
| Generic output | 8000 chars / 120 lines inline; preview 2500 chars / 40 lines |
| Artifacts | 5 MiB inline image, manifest 100 entries, 32 MiB budgets, 24 h stale age |
| Script | 25 calls, 64 KiB source/emit, 120 s default / 300 s max, 64 MiB heap, 1 MiB msg / 8 MiB cumulative IPC |
| Electron | launch 15 s (max 120 s), probe/status 35 s, CDP fetch 1 s, cleanup 5 s, 4096-byte log tails |
| Web search | Exa default + Brave, 1.1 s global gate, 15–90 s timeouts, 5 results default |
| Docs | 8 docs, ~750 KB (TOOL_CONTRACT 251 KB, COMMAND_REFERENCE 210 KB) |
| Vault | AES-256-GCM, 32-byte key file (0600) or scrypt passphrase, entries bound to an exact origin; secret registry scrubs filled values by identity |
| Round-2 modes | `debug`, `settle`, `networkBody`, `vault`, `devServer`, `login` + `revealSecrets` (≤8 named headers, network reads only) + `verbosity: quiet\|normal\|verbose` |

## 7. Trust boundaries (its actual security story)

Socket dir must be absolute, uid-owned, mode exactly 0700, symlink-free, trusted ancestors (16 384-entry scan);
restore storage requires a hardened HOME walk + real git checkout (.git dir or `gitdir:` file, uid-owned, ≤1024 B)
+ a 0600 UUID marker; temp roots carry an ownership marker + PID start-identity (POSIX `ps lstart`, win32 ticks)
before removal; cross-process FIFO ticket lock to avoid signalling a reused PID; no-follow `lstat` + `wx` + rename
everywhere. Explicitly **not** boundaries: the bash guard ("ergonomics guard, not a security boundary"),
Electron sensitivity labels (advisory), `file://` reads (documented pass-through).

## 8. Reality check on verification (read this before trusting any claim)

* This copy is a **deployed artifact**: no `extensions/` source, no `test/` (50 test files are cited in docs), no
  tsconfig, no git, no lockfile. `npm run verify`/`typecheck`/`docs`/`test`/`build` all reference files that do not exist here.
* The repo's own SHIPPED author claim is that ~779 tests pass and that a Crabbox macOS/Ubuntu/native-Windows matrix must be green;
  none of that is reproducible in this checkout. `SUPPORT_MATRIX.md` itself concedes the dated rows are "not qualification of the
  current 0.37.0 candidate", and macOS/Windows gates are waived across 0.6.0–0.6.13.
* What *is* independently verified: the live behavior of all 10 local patches (see `PATCHES.md`), the byte-level divergence
  from pristine 0.6.13 (§9), and every number above (read from code).

## 9. Divergence from stock 0.6.13

Round 1: 8 modified files (282 delta lines) + 2 new files (`geolocation-stub.js`, `snapshot-step-filter.js`) + 3 doc edits.
Round 2 adds 11 modified files (≈705 delta lines) + 17 more new files across `lib/vault/`, `lib/input-modes/`, and
`lib/orchestration/{vault-host,login-host,dev-server-host}/`, plus always-on prompt guidance for the new modes.
`package.json`, `README.md`, `CHANGELOG.md`, `scripts/` are byte-identical to the published tarball. Full table in `PATCHES.md`.

## 9b. Credential vault (added after studying `NousResearch/hermes-agent`)

The vault exists because the wrapper's own redaction made authentication impossible: it hid `authorization` so well that the
agent could not log in anywhere. The design ports the policy from Hermes (the model never receives a secret, fills are bound
to an exact origin and re-checked inside the page, the identifier is typed by the agent while only the password goes through
the vault, codes are entered not printed, card fills require a human confirmation and a refusal is never auto-retried) onto
this wrapper's own mechanisms: an encrypted store, a masked Pi-TUI prompt (Pi's `ui.input` has no mask), an in-page fill
script delivered over `eval --stdin` so the value never enters argv, and a session-scoped registry that scrubs the exact
value from every model-facing surface afterwards.

Upstream `agent-browser` already ships an encrypted auth vault (`auth save/login/list/show/delete`, key at
`~/.agent-browser/.encryption-key`, plus credential-provider plugins). This wrapper does not duplicate it for profile
credentials; it adds what upstream lacks: human intake, TOTP, cards/addresses, the in-page origin re-check, exact-value
redaction, and the confirmation/refusal policy.

## 10. Comparison axes (use these as the checklist)

| # | Axis | This tool | Ask of the rival |
| --- | --- | --- | --- |
| 1 | Architecture | external CLI subprocess, wrapper owns planning only | in-process CDP/Playwright driver? browser bundled or BYO? |
| 2 | Session identity | 5-tier model (managed/root/explicit/fresh/attached) + transcript replay | does it survive reload/branch? who closes what? |
| 3 | Failure honesty | fails closed when a "success" cannot be evidenced | does a reported success prove the page changed? |
| 4 | Ref/element model | `@eN` snapshot refs + stale-ref preflight + recovery actions | selector re-resolution? auto-retry? |
| 5 | Context cost | compaction + spill + caps everywhere | does it dump DOM/HTML into context? caps? |
| 6 | Secret handling | redaction before persistence, argv+envelope+presentation | any redaction at all? where? |
| 7 | Outcome contract | categories + 79-key details + executable nextActions | structured error taxonomy or prose only? |
| 8 | Orchestration | one-shot sandboxed `script` (25 calls, no recipe registry) | reusable named workflow/recipe layer? |
| 9 | Desktop apps | Electron lifecycle incl. isolated profile + cleanup | supported? |
| 10 | Verification harness | Crabbox matrix + dogfood + real-upstream suite (not runnable here) | what is actually tested and where? |
| 11 | Trust boundaries | socket/temp/restore hardening, PID-reuse safety | path/permission hardening? |
| 12 | Extensibility/drift | hand-mirrored 84-token CLI grammar = drift surface | API-first (typed) vs text-grammar coupling |
| 13 | Maturity | 111 releases/158 days, fix-heavy (71 Fixed vs 25 Added), 0.x | release cadence, breaking-change policy |
| 14 | Local divergence | 10 patched upstream defects (data loss, lying successes) | does stock upstream behave as documented? |

## 11. Known weaknesses (deduped, ranked by impact for a comparison)

1. **God-function `prepare.js`**: 1189 lines, 17 early returns, implicit guard *ordering* where each later stage overwrites `executionPlan.validationError` — the user sees only the last error, and earlier (sometimes more relevant) ones are lost.
2. **Verification gap in this environment**: no source, no tests, no git ⇒ patches exist only as compiled JS whose provenance is prose. A `npm install`/rebuild either fails or silently drops them.
3. **Hand-mirrored CLI grammar**: 84 tokens + 75 flags maintained by hand in two files that can disagree; `--flag=value` launch-scope detection misses command flags (only `--restore` handled).
4. **Process-per-probe**: 38 `runSessionCommandData` sites; one call can spawn several extra CLI processes (latency, more failure surface). `runSessionCommandData` has no default timeout.
5. **Input-mode conflict reporting can be masked**: mode conflicts are counted only for successfully compiled modes, so a call with two modes where one fails to compile reports the compile error, not the conflict.
6. **Post-spawn failures cannot unwind**: a click-dispatch miss or Electron health failure flips the result to failed while the newly created session stays current.
7. **Category classification is regex over concatenated text** ⇒ a benign stderr banner containing "about:blank" can flip a result to `tab-drift`.
8. **`--json` escapes prose redaction** (content bypasses `redactSensitiveText`); a secret visible only in page text leaks into the JSON payload while `details` stays redacted.
9. **Over-invalidation by design**: transitions, failed transitions, WebMCP calls and recording starts all drop refs ⇒ an extra snapshot round trip on the next call.
10. **Regex/heuristic prompt guards** (17 artifact patterns) can gate `close` on a false positive; the bash guard is explicitly bypassable by prompt content or env.
11. **Dead/misleading API**: `results/contracts.js` is `export {}` while docs cite it as the type home; `isPlaintextCredentialValue`/`isProjectSafeCredentialValueForProvider` have no callers; `browser-run/types.js` is a 1-line placeholder.
12. **Docs drifts from code**: `state rename`/`cookies --url`/`set device` names were documented-but-broken upstream (3 of them now patched locally), and `docs/` links to files absent from the package.

## 12. Raw evidence maps

Full per-cluster maps (file/line anchored) live in `/tmp/piab-map/{A-surface,B-orchestration,C-presentation,D-infra,E-meta}.md`.
Move them somewhere durable if they will be needed after a reboot.
