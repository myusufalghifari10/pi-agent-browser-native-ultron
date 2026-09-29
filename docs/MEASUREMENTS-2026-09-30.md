================================================================================
agent_browser USAGE MEASURED FROM Pi SESSION LOGS — raw numbers only
================================================================================
Corpus root : /home/yusuf/.pi/agent/sessions/--home-yusuf--/
Snapshot    : 2026-09-30T06:16:33+07:00 -> 06:16:34+07:00 (local)
Stability   : the pass was re-run 20 s later (06:16:54) and returned byte-identical
              counters (calls 2505, doc occurrences 2453). One file was still being
              appended to during measurement (see CAVEAT 1).
Analyzer    : /tmp/aban/final.py  (streaming, byte-capped line reader)
              python3 /tmp/aban/final.py      -> writes /tmp/aban/metrics.json
Helper passes (same corpus, same streaming rule):
              /tmp/aban/docdetail.py  (doc-read accounting)
              /tmp/aban/badargs.py    (malformed args payload dump)
              /tmp/aban/errtax.py     (error taxonomy by failureCategory)
              /tmp/aban/gate.py       (guide-gate -> doc-read timing)
Memory rule : every file is read line-by-line with a per-file byte cap equal to its
              size at pass start; no file is ever loaded whole. Largest file is
              69,958,346 bytes. Peak RSS of the pass is bounded by the longest single
              line, not by file size.

SCAN SCOPE (from the same pass)
  .jsonl files scanned ................................. 657
    top-level main sessions (dir itself) .............. 45
    nested subagent run-0/session.jsonl ................ 407
    subagent-artifacts/*_transcript.jsonl ............. 205
  bytes read .......................................... 396,309,716
  lines read .......................................... 78,848
  line-level JSON parse errors ......................... 0
  lines dropped by the byte cap (truncated tails) ..... 0
  agent_browser toolCalls found ....................... 2,505
  agent_browser toolResults found ..................... 2,505
  toolResults whose toolCallId matched no call ........ 0

================================================================================
1. TOTAL agent_browser CALLS
================================================================================
Method: count of message.content blocks where type=="toolCall" and
name=="agent_browser", per file, over all 657 .jsonl files.

  TOTAL CALLS, all files ............................... 2,505
  TOTAL RESULTS, all files ............................. 2,505  (1:1, 0 orphans)
  Files with >= 1 agent_browser call .................... 23
  Files with 0 agent_browser calls ...................... 634

  By population
    main-session logs (45 top-level .jsonl) ............ 1,618
    nested subagent run-0/session.jsonl ................ 887
    subagent-artifacts transcripts ..................... 0
    (measured in metrics.json key "pop_calls")

  Distinct ROOT sessions that ever used the tool ......... 4
    1,577  2026-09-27T06-08-48-495Z_01a0e17a-fb6e-7046-841a-62547c37c0eb.jsonl
      887  2026-09-15T20-28-25-065Z_01a0a6c1-aa69-730f-8fe4-bf161a18f651/ (20 subagent runs)
       22  2026-09-26T18-37-34-373Z_01a0df02-2325-76f8-8aed-3de80f69bf2c.jsonl
       19  2026-09-24T22-13-30-579Z_01a0d57b-1d52-76f8-8aed-3de6f9e9dbed.jsonl
  Share of all calls coming from the single largest file .. 1,577/2,505 = 62.95%

TOP 10 FILES BY CALL COUNT  (of 23 files with >=1 call; all 23 listed)
   #   calls  file
    1   1577  2026-09-27T06-08-48-495Z_01a0e17a-fb6e-7046-841a-62547c37c0eb.jsonl
    2    210  2026-09-15T20-28-25-065Z.../d7953db0-e4f6-4b6a-a342-bdf5b36828c4/run-0/session.jsonl
    3    129  2026-09-15T20-28-25-065Z.../c5db7def-4a0f-442a-93a1-7f1d175d8b12/run-0/session.jsonl
    4    123  2026-09-15T20-28-25-065Z.../af179529-d045-4e6b-af06-514b1096963b/run-0/session.jsonl
    5     53  2026-09-15T20-28-25-065Z.../a3ca4827-5656-44cf-b6fe-5fd56aa0dfb8/run-0/session.jsonl
    6     44  2026-09-15T20-28-25-065Z.../618cf505-5774-4ec2-bf96-45ba9560cdce/run-0/session.jsonl
    7     38  2026-09-15T20-28-25-065Z.../dd98a916-3213-4db1-89be-302a8f1b9b0b/run-0/session.jsonl
    8     38  2026-09-15T20-28-25-065Z.../1b68b7ec-6704-4a95-b8bd-8cf16629fc46/run-0/session.jsonl
    9     36  2026-09-15T20-28-25-065Z.../ab313264-eb0c-41d5-833d-81d882e2c4c4/run-0/session.jsonl
   10     34  2026-09-15T20-28-25-065Z.../d780bd24-79a5-410d-9218-0b6204e34a79/run-0/session.jsonl
  (11: 27  00405d20-...  | 12: 22  2026-09-26T18-37-34-373Z...jsonl  | 13: 21  e150894d-...
   14: 20  41513673-...  | 15: 20  0234d328-...  | 16: 19  2026-09-24T22-13-30-579Z...jsonl
   17: 18  082ccf18-...  | 18: 17  c5728fb5-...  | 19: 15  b75826ce-...  | 20: 12  6c48a765-...
   21: 12  d24d04ad-...  | 22: 10  9912b412-...  | 23: 10  5ae59ae1-...)
  Exact paths: python3 -c "import json;M=json.load(open('/tmp/aban/metrics.json'));
  [print(n,f) for f,n in sorted(M['per_file'].items(), key=lambda kv:-kv[1])]"

  Duplicate check: all 2,505 toolCall blocks carry a string id and all 2,501 ids
  checked in an earlier pass were unique (0 ids appearing twice). The only duplicated
  records found anywhere in the corpus are 2 read-toolCall records that appear both in
  a run-0/session.jsonl and in the matching subagent-artifacts transcript with the same
  id (/tmp/aban/dedupe.py). No agent_browser call is double-counted.

CAVEAT 1 (corpus is live): 2026-09-27T06-08-48-495Z_...jsonl was being written while
  the pass ran (69,958,346 bytes, mtime = measurement time). Un-frozen earlier runs of
  the same logic gave 2,499 calls (06:16:15) and 2,501 calls (06:16:26) versus 2,505 in
  the reported snapshot; the doc-occurrence count moved 2,437 -> 2,445 -> 2,453 over the
  same minutes. All figures below are the frozen 06:16:33 pass, and were identical on
  the 06:16:54 re-run.

================================================================================
2. MODE DISTRIBUTION  (key present in the toolCall "arguments" object)
================================================================================
Method: for each agent_browser toolCall, take b["arguments"] (a dict) and test key
presence for each of the 16 requested mode keys. Denominator = 2,505 calls.
"main-only" = the same count restricted to the 45 top-level session logs.

  mode key            calls   % of 2505   main-only
  args                2361     94.25%       1554
  script                5      0.20%          0
  job                   18      0.72%         15
  qa                     6      0.24%          0
  act                    7      0.28%          7
  cdp                   20      0.80%         20
  vault                 31      1.24%          2
  checkpoint            15      0.60%         15
  devServer              2      0.08%          0
  login                 14      0.56%          2
  electron               0      0.00%          0
  debug                 10      0.40%          0
  settle                 6      0.24%          3
  networkBody            2      0.08%          0
  sourceLookup           0      0.00%          0
  networkSourceLookup    0      0.00%          0

  Non-mode (auxiliary) keys, same denominator:
  stdin                594     23.77%     | timeoutMs    107     4.28%
  outputPath            35      1.40%     | sessionMode   25     1.00%
  verbosity             20      0.80%     | semanticAction  9     0.36%
  revealSecrets          6      0.24%

  Mode keys supplied per call:  1 key -> 2,493 calls | 0 keys -> 10 | 2 keys -> 2
  Arithmetic reconciliation: the per-key counts above sum to 2,497, not 2,505, because
  the 10 zero-mode-key calls contribute no row and the 2 two-mode-key calls contribute
  two rows each (2,493 + 4 = 2,497; 2,505 - 2,497 = 8 = 10 zero-key - 2 extra keys).
  All percentages in this table use the 2,505-call denominator.
  The 2 two-mode calls are args+cdp; the corpus contains 5 results with the text
  "Provide exactly one input mode. Supported modes: script, args, semanticAction, job,
  qa, sourceLookup, networkSourceLookup, electron, debug, settle, networkBody, vault,
  checkpoint, devServer, login, cdp."

  Whole "arguments" object key counts per call: 1 key -> 1,737 | 2 -> 747 | 3 -> 18
  | 4 -> 2 | 0 -> 1  (the 0-key case is the 1 call counted as "no mode key" below)

  args-VALUE SHAPE (2,361 calls carrying an "args" key) — this is the malformed-rate
  measurement, JSON.parse done inside try/except exactly as specified:
  args value is a JSON STRING that parses to an array ....... 1,535  (65.0% of 2361)
  args value is already a native JSON array ................... 807  (34.2%)
  args value is a dict {"item": [...]}  (host array->object
    coercion; recoverable by unwrapping "item") ............... 12  (0.51%)
  args value is a dict {"item": {"item": [...]}} (double wrap,
    recoverable) .............................................. 2  (0.08%)
  args value is a string that JSON.parse REJECTS ................ 4  (0.17%)
  args value is an unrecoverable mangled dict .................... 1  (0.04%)

  MALFORMED ARGS RATE
    unrecoverable (no argv derivable) ............ 5 / 2,361 = 0.21%
    host-mangled in any way (incl. recoverable) .. 19 / 2,361 = 0.80%
  The 4 rejected strings, verbatim (truncated at 70 chars by the dumper):
    ["eval", "--stdin"],
    ["eval", "--stdin"], "stdin": "console.log('sweep-marker-2026'); 'done
    ["--session", "ultron3", "batch", "--bail"], "stdin": "[[\"get\",\"tit
    ["keyboard", "type", "MDP 1 - Greenhouse climate controller. States: t
  The 1 unrecoverable dict: {"session", \"ultron1\", \"eval\", "--stdin\"]": ""}
  (these are the host comma-joins described in the task)

================================================================================
3. ARG SUBCOMMAND DISTRIBUTION  (args calls only)
================================================================================
Method: for each call with an "args" key, normalize the value to an argv list
(string -> JSON.parse; native array -> as-is; dict -> unwrap "item"), then take the
first non-flag token. Calls whose args value could not be normalized are excluded
(149 calls have no args-derived argv at all: 144 use a non-args mode, 5 are the
malformed payloads above). Base = 2,356 calls with a usable argv; 68 distinct
command tokens observed.

  Two rules are reported because they disagree materially:
  (A) "value-flag-aware" = skip any token starting with "-" AND skip the token that
      follows a known value-taking global flag (--session, --profile, --state, --cdp,
      --allowed-domains, --ua, --timeout, --output, --port, --host).
  (B) "naive" = first token not starting with "-", as literally specified in the task.

  TOP 20 — RULE (A), value-flag-aware, base 2,356
   #  command        calls    % of 2356
   1  eval             916    38.88%
   2  snapshot         207     8.79%
   3  open             206     8.74%
   4  click            165     7.00%
   5  batch            128     5.43%
   6  get               88     3.74%
   7  wait              80     3.40%
   8  state             67     2.84%
   9  type              41     1.74%
  10  find              40     1.70%
  11  close             33     1.40%
  12  screenshot        28     1.19%
  13  tab               27     1.15%
  14  press             26     1.10%
  15  storage           26     1.10%
  16  errors            24     1.02%
  17  console           23     0.98%
  18  cookies           23     0.98%
  19  session           19     0.81%
  20  set               17     0.72%
  (next: network 15, react 14, diff 13, dialog 12, fill 11, keyboard 9, read 7,
   scroll 6, stream 6, doctor 5, ns 4, upload 2, help/device/args/addinitscript 1 each)

  TOP 12 — RULE (B), naive first-non-flag, base 2,356
   ultron1 1296 | eval 124 | snapshot 112 | open 104 | get 76 | state 67 | batch 63
   | click 59 | close 30 | ultron3 28 | type 26 | storage 26
   Under the naive rule the top token is a SESSION NAME, not a command, for
   1,350 / 2,356 = 57.3% of calls (ultron1 1296, ultron3 28, ultron2 1, piab-recon-init 2,
   piab-ckpt-f2cf3f09 1, session 19, other 3). 1,482 argv calls contain --session.
   Both rules are reported; rule (A) is the one whose tokens match the command set.

  MAIN-SESSION-ONLY (1,549 argv calls from the 45 top-level logs), rule (A):
   eval 814 | snapshot 144 | click 135 | open 102 | batch 84 | wait 73 | type 41
   | find 30 | screenshot 25 | press 23 | get 20 | tab 17 | session 10 | fill 8
   | keyboard 6 | console 5 | network 3 | close 2 | scroll 1
   (subagent logs contribute the remaining 807 argv calls, all native arrays, and
   account for the difference: state, storage, errors, cookies, set, react, diff...)

  Most frequent flags appearing inside argv: --session 1482, --stdin 889, -i 200,
  --bail 30, --clear 25, --name 21, --text 20, --help 12, --timeout 11, --headed 10,
  --color-scheme 9, --url 8, --profile 7, --namespace 7 (61 distinct flags total).

================================================================================
4. BATCH USAGE
================================================================================
Method: calls whose rule-(A) command token is "batch"; step count = length of
JSON.parse(arguments.stdin) when that is an array.

  calls using the batch command .............................. 128  (5.43% of 2,356
                                                                argv calls; 5.11% of all
                                                                2,505 calls)
  stdin parsed as a JSON array ............................... 123
  stdin present but not an array (non-parseable for step count) .. 2
  no stdin key at all (step count not obtainable) ............. 3
  => step-count statistics are computed on 123 of 128 batch calls (96.1%)

  STEP COUNT PER BATCH (n=123)
    min ......... 1
    max ......... 65
    mean ........ 4.488
    median ...... 2
    MODE ........ 2 steps   (45 of 123 batches = 36.59%)   <-- single most common
    total steps in all batches ... 552
  Full histogram (steps: batches):
    1:17   2:45   3:37   4:9   5:6   6:2   7:2   11:1   37:1   64:1   65:2
  Batches with >= 10 steps: 5 of 123 (4.07%); <= 3 steps: 99 of 123 (80.49%).

  FIRST TOKEN OF EACH BATCH STEP (all 552 steps across the 123 batches)
    mouse 345 (62.50%) | wait 64 (11.59%) | get 37 (6.70%) | snapshot 32 (5.80%)
    | click 23 (4.17%) | open 13 (2.36%) | fill 12 (2.17%) | eval 10 (1.81%)
    | screenshot 7 (1.27%) | state 5 (0.91%) | diff 4 (0.72%)

  Batch results that reported failure ("Batch failed:" in the result text): 11
  of 128 batch calls = 8.59%.

  For contrast, the "job" mode: 18 calls, of which 16 yielded a step count
  (min 1, max 3, mean 2.125, median 2, histogram 1:5 2:4 3:7). 2 job payloads could
  not be step-counted.

================================================================================
5. DOC READ FREQUENCY — COMMAND_REFERENCE.md
================================================================================
Path: /home/yusuf/.pi/agent/extensions/pi-agent-browser-native/docs/COMMAND_REFERENCE.md
(file exists, 248,550 bytes, last modified 2026-09-30 05:43)

Method (docdetail.py + gate.py + final.py): every toolCall in the corpus is tested for
the substring "COMMAND_REFERENCE.md" in its serialized arguments, bucketed by tool name;
read toolCalls are de-duplicated by toolCall id.

  UNIQUE read toolCalls naming COMMAND_REFERENCE.md ........... 28
  raw log occurrences of such read toolCalls .................. 30  (2 of them are the
     same record logged twice: run-0/session.jsonl + subagent-artifacts transcript,
     identical toolCall id)
  distinct log files containing such a read .................... 6
     21  2026-09-27T06-08-48-495Z_...eb.jsonl      (main session)
      5  2026-09-24T22-13-30-579Z_...d74aff.jsonl  (main session)
      1  2026-09-27T06-08-48-495Z.../8541497a-.../run-0/session.jsonl  (subagent)
      1  2026-09-27T06-08-48-495Z.../073523c2-.../run-0/session.jsonl  (subagent)
      1  subagent-artifacts/073523c2-..._worker_0_transcript.jsonl     (duplicate)
      1  subagent-artifacts/8541497a-..._worker_0_transcript.jsonl     (duplicate)
  first read 2026-09-26T18:03:04.809Z  |  last read 2026-09-29T23:03:35.432Z

  AS A RATE
    28 unique reads / 2,505 agent_browser calls ......... 1.12%
    26 reads in the two main sessions / 1,618 main-session agent_browser calls = 1.61%
    28 / 7,576 read toolCalls corpus-wide ............... 0.37%
    sessions that used agent_browser: 4  -> the doc was read in 3 of those 4 root
    sessions (all 3 of the ones that used it; the 2026-09-26T18-37-34 session, 22
    calls, never read it)

  READS OF EVERY FILE IN THE SAME docs/ DIRECTORY (read toolCalls only)
    COMMAND_REFERENCE.md 28 | TOOL_CONTRACT.md 10 | ARCHITECTURE.md 4
    ELECTRON.md 3 | SUPPORT_MATRIX.md 2 | REQUIREMENTS.md 1 | RELEASE.md 1
    platform-smoke.md 1
    (28 of the 30 COMMAND_REFERENCE reads are deduped ids; the 10/4/3/2/1/1/1 counts
     are raw read toolCalls.)

  RAW SUBSTRING COUNT (the misleading number, for contrast)
    "COMMAND_REFERENCE.md" appears 2,453 times across 100 log files. Location split:
      624  toolResult echo of a read result
      437  records with no message field
      298  toolResult echo of a bash result
      155  system message text
      148  bash toolCall command text naming the doc
      125  bash toolCall (other files, doc appears in the result)
      101  toolResult echo of an edit
       83  records with role=null
       66  toolResult echo of a grep
       59  edit toolCall
       56  grep toolCall
       55  write toolCall
       30  read toolCall (the 28 unique + 2 duplicates)
       22  read toolCall of other files
       21  user message
       15  agent_browser toolResult (guide-gate text)
       12  TaskCreate toolCall | 9 subagent toolCall | 4 agent_browser toolCall | 3 ls
    i.e. only 1.2% of the 2,453 substring hits are an actual read of the file.

  OTHER TOOL CALLS NAMING THE DOC
    unique bash toolCalls ......... 78
    grep toolCalls ................ 6
    write/edit toolCalls ......... 52   (extension development on the doc itself)
    agent_browser toolCalls ....... 0   (the doc path never appears in a browser call)

  GUIDE-GATE (the tool's own "read the guide first" block, text contains "guide-gate")
    blocked agent_browser results ......................... 15  (5.47% of the 274
                                                            errors; 0.60% of 2,505 calls)
    14 in 2026-09-27T06-08-48-495Z_...eb.jsonl, 1 in 2026-09-24T22-13-30-579Z_...d74aff.jsonl
    first block 2026-09-26T18:03:01.386Z, last 2026-09-29T22:50:36.666Z
    followed by a read of COMMAND_REFERENCE.md in the same file: 15 of 15 (100%)
    delay from block to that read: min 3.2 s, median 5.1 s, max 20.7 s
    reads NOT explained by a gate block: 26 - 15 = 11 in the main sessions, 2 in subagents

================================================================================
6. ERROR RATE
================================================================================
Method: every message with role=="toolResult" and toolName=="agent_browser".
  isError flag read from the record; failureCategory extracted with
  regex /failureCategory:\s*([A-Za-z0-9_-]+)/. Call attribution is done by joining
  toolResult.toolCallId to the recorded command of the matching toolCall (0 unmatched).

  results ................................. 2,505
  results with isError == true ............ 274   = 10.94% of results
  errors carrying "Result category: failure; failureCategory: X" ... 229  (83.58% of
     errors; 9.14% of all results)
  errors WITHOUT any failureCategory ...... 45   (16.42% of errors)
  occurrences of the string "Result category:" in the corpus ... 229, and the only
     value ever observed is "failure" (no success category is emitted in these logs)
  results whose text contains "Batch failed:" ... 11

  FAILURECATEGORY BREAKDOWN (n = 229)
   value                        count   % of 274 errors   % of 2505 results
   validation-error                94      34.31%              3.75%
   upstream-error                  76      27.74%              3.03%
   timeout                         25       9.12%              1.00%
   stale-ref                       12       4.38%              0.48%
   tab-drift                        8       2.92%              0.32%
   selector-not-found               5       1.82%              0.20%
   parse-failure                    4       1.46%              0.16%
   confirmation-required            2       0.73%              0.08%
   policy-blocked                   2       0.73%              0.08%
   checkpoint-reauth-required       1       0.36%              0.04%

  Most frequent individual error messages (first line of the result text):
     18  Upstream agent-browser 0.37.0 `state clear` ignores the requested session name
     15  Blocked by guide-gate: before using agent_browser ... read the guide first
     14  args is not iterable
     12  Missing 'path' parameter
     11  The active page became unverified after a tab, attachment, history, script,
          or state-load transition
      8  agent-browser could not re-select and verify the intended tab before running
      8  Cannot destructure property 'compiledElectron' of 'normalizeRunInput(...)'
      7  `args` must contain at least one agent-browser command token.
      6  The current extension-managed agent-browser session is already running, so
         launch-scoped flags ...
      5  Provide exactly one input mode. Supported modes: ...
      4  Wait timed out after 25000ms
      4  Invalid JSON input: invalid type: integer `489`, expected a string ...
      4  Batch failed: 1/2 succeeded
      4  Upstream agent-browser 0.37.0 `diff snapshot` without `--baseline` ...
      3  agent-browser exceeded the 35000ms wrapper watchdog ...
      3  Evaluation error: TypeError: Cannot read properties of undefined
      3  agent_browser batch stdin step 0 token 2 must be a string. ...
      3  Batch failed: 3/4 succeeded
      3  Invalid session name '/home/yusuf/piab-recon-a'. ...
      3  vault.save with type "login" needs at least a username or a secret.
      3  Validation failed for tool "agent_browser":
      3  Unknown ref: e999

  THE 45 ERRORS WITH NO failureCategory, bucketed by first line:
     15  guide-gate block
     14  "args is not iterable"            <- the malformed-args payloads of section 2
      8  "Cannot destructure property 'compiledElectron' ..."
      3  "Validation failed for tool \"agent_browser\":"
      1  "token.startsWith is not a function"
      3  cdp results where one sub-command failed (e.g. "cdp: 2 command(s) ...")
      1  a result whose text starts with "{"
      (15+14+8+3+1+3+1 = 45)

  ERRORS BY THE COMMAND THAT PRODUCED THEM (id-joined; top 20 of 68 commands)
   command      errors/calls   rate
   state           35 /  67     52.24%
   batch           32 / 128     25.00%
   get             21 /  88     23.86%
   open            20 / 206      9.71%
   click           17 / 165     10.30%
   wait            16 /  80     20.00%
   eval            16 / 916      1.75%
   find            11 /  40     27.50%
   snapshot         8 / 207      3.86%
   type             7 /  41     17.07%
   tab              4 /  27     14.81%
   session          3 /  19     15.79%
   diff             3 /  13     23.08%
   cookies          3 /  23     13.04%
   set              3 /  17     17.65%
   ns               3 /   4     75.00%
   doctor           3 /   5     60.00%
   download         2 /   3     66.67%
   read             2 /   7     28.57%
   ALL argv commands 220 / 2356    9.34%
  Errors produced by non-args modes (id-joined labels): job 12, cdp 10, vault 6,
  args-payload-malformed 5, settle 5, debug 5, checkpoint 4, no-mode-key 2,
  and 54 in total for all non-args modes. Non-args-mode error rate: 54 / 144 = 37.5%
  (versus 220 / 2,356 = 9.34% for argv commands).

================================================================================
NOT OBTAINABLE / EXPLICIT GAPS
================================================================================
- Reasoning about *why* a command was chosen (intent) is not in the logs; only the
  emitted call arguments and results were counted.
- Step count for 5 of 128 batch calls is not obtainable (3 have no stdin key, 2 have a
  stdin that is not a JSON array).
- Step count for 2 of 18 job calls is not obtainable.
- The "first non-flag token = command" rule is ambiguous in this corpus because 57.3%
  of argv calls carry a value-taking --session flag before the command. Both rules
  are reported; no single number is claimed as the command.
- Total corpus size is not stable: the log set grew by ~6 agent_browser calls and ~16
  doc occurrences during the ~40 s the measurement took. Numbers are the frozen
  06:16:33 pass.
- "isError" is the Pi-level flag; a browser step can fail inside an otherwise
  isError:false batch result. 11 results contain "Batch failed:"; those are counted
  separately and are not in the 274.
