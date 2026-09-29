# FINAL DESIGN — pi-browser v2 ("Ultron Browser")

Status: FINAL untuk approval Yusuf. TIDAK ADA EKSEKUSI sampai disetujui.
Date: 2026-09-27 · Proses: pemahaman penuh extension → riset 3 lane (30+ sumber terverifikasi) → draft → blackbox deep tier (30 ide, 6 kluster, 3 deepen, 3 red-team) → dokumen ini.

---

## BRIEF

**Problem P:** Redesign `pi-agent-browser-native` menjadi extension browser terbaik untuk agen Pi: lebih ramping (tools + panduan), semua fitur terjaga, fitur baru berbasis bukti, agen bisa melakukan apa pun di browser.
**Lens:** design (dominan) + strategy. **Tier:** deep (5 frame diverge × 6 ide → score/cluster → deepen top-3 → red-team × 3).

---

## 1. VERDICT RED-TEAM & PENYESUAIANNYA (bentuk final tiap pilar)

| Pilar | Verdict | Serangan paling tajam | BENTUK FINAL (reshape) |
|---|---|---|---|
| **A. Reflex kernel** (loop mekanis wrapper-side) | needs-shape | Zero-round-trip buta = kontra-produktif: fact #3 justru mensyaratkan re-read dipicu sinyal; anchor rebind per-op menghapus keunggulan fact #4 (model memilih dari kandidat kecil); probe membuktikan dispatch, bukan outcome; blind N-op = leverage injeksi ×N (fact #7) | **DIBONGKAR ke bentuk aditif**: (1) **auto-settle-retry** ladder ① wrapper-side (satu op, 300ms, max 2, no-LLM) — lolos red-team; (2) **job++ verification receipts**: per-op probe hasil (dispatch/echo/url) dilampirkan sebagai *receipt*, bukan lisensi eksekusi buta; (3) model TETAP titik keputusan sebelum op konsekuensial apapun yang mengikuti kondisi/anchor-rebind. Program-butuh-round-trip sebagai core → DITOLAK. |
| **B. Save-states & timeline forks** | needs-shape | "Byte-identical" gugur: IDB tak lossless via CDP, MHTML statis, sessionStorage/SW/permissions/CHIPS hilang; refresh-token rotation mematikan fork B; fingerprint discontinuity → re-challenge (pola fraud); restore = stop-the-world (konflik dgn subagent sharing); checkpoint id = bearer capability → bolak invarian secrets | **DIRESHAPE jadi auth-state yang jujur**: (1) **origin auth-snapshots** (cookies+localStorage, terenkripsi vault-key) + TTL + reauth health-check — untuk *bootstrapping sesi baru*, bukan fork komparatif; (2) **pre-consequential checkpoint**: state save sebelum aksi berisiko, recovery = restore+replan, label eksplisit "fidelity: cookies+localStorage"; (3) restore **lineage-scoped** (hanya ke sesi satu root/checkout — handle tak berarti di tempat lain) + konfirmasi untuk restore konsekuensial; (4) fork timeline & mount lintas-mesin → DITOLAK untuk iterasi ini. |
| **C. Self-maintaining harness** | needs-shape | Auto-expire sirkular (deteksi fix butuh menjalankan path yang dipatch blokir); fixture halaman tak bisa mensertifikasi bug pipeline (P25/P27/P28); checksum samakan hotfix sah dgn drift → vendored-fallback = lubang hitam; korpus sub-detik tak bisa menguji patch topologi; TTL lease tanpa heartbeat = pencurian sesi; tak ada predikat re-arm = degradasi terkunci | **DIKECILKAN ke 20% biaya / 80% nilai**: (1) **Patch Integrity Ledger**: `patches.manifest.json` (id, files, sha256, upstream-defect) + checksum verify sebelum spawn — drift = penolakan KERAS + panduan re-apply (TANPA vendored fallback diam-diam); (2) **failure ledger** append-only (category+guard+remediation) — murah, jadi korpus fix permanen; (3) **capability health chip** dari sweep yang SUDAH terbukti di PATCHES.md, diotomasi sebagai command eksplisit (bukan gate per-sesi); (4) **degradation receipts** jujur untuk operasi parsial (pelajaran P25); (5) auto-expire sirkular, golden-corpus per-sesi, vendored-pin, TTL-lease → DITOLAK (diganti: command "probe upstream fix" manual satu-off; PID-liveness check sederhana untuk fan-out). |

**Pilar yang tidak di-red-team tapi lolos uji bukti draft:** slimming 3 lapis, delta-snapshot default (sejalan dgn temuan RT-1 soal re-read tersinyal), vision fallback lane (F2), WebMCP first-class + provenance gating (F3 — diperkuat RT-1), HITL handoff (F5), recipes opsional user-owned (F6 — program-memory-as-core ditolak RQ-0068), debug lane + perf (F7), stealth posture jujur (F8), injection hygiene (F9 — diperkuat RT-1), 7 perbaikan internal (bongkar god-function, grammar generation, tutup lubang `--json`, unwinding, timeout default, dst).

---

## 2. ARSITEKTUR FINAL — satu kalimat per lapis

1. **Kanal**: axtree + `@eN` refs tetap kanal utama; delta-snapshot default utk halaman besar (`snapshotDelta: auto|always|never`); screenshot/SoM = fallback on-demand (selector-not-found, canvas, shadow-DOM, pertanyaan spasial).
2. **Aksi**: 4 gerbang mental (LIHAT · LAKUKAN · KELOLA · OTOMASI) di atas SATU tool slim; mode kompilasi otomatis `act`-chain → jalur batch yang sudah di-guard; `job++` dgn verification receipts + settle-retry ladder ①.
3. **Verifikasi**: fail-closed tetap (click-dispatch probe, fill re-read, artifact verify) + receipts per-op; label jujur "dispatch-verified ≠ outcome-verified".
4. **Pemulihan**: ladder ① otomatis (settle-retry) → ② replan dgn dossier ringkas (failed op, assertion, ref-diff minimal, nextActions) → ③ vision fallback → ④ HITL handoff dgn state-dump.
5. **State & auth**: 5-tier session tetap; tambahan origin auth-snapshots (TTL + health check + lineage-scoped restore); pre-consequential checkpoint; patch integrity ledger menjaga semua patch lokal.
6. **Keamanan**: vault + secret registry tetap; tutup lubang `--json`; provenance label utk page-declared tools (WebMCP) + instruction-density marker; konten halaman tidak pernah = instruksi.
7. **Prompt**: Tier A ≤800 chars (4 kalimat invarian + 4 gerbang); failure-driven teaching via nextActions; docs guide-gate untuk sisanya; verbosity adaptif.

---

## 3. MENGAPA BENTUK INI MENANG (kontras dgn runner-up)

- **vs blind reflex kernel (runner-up skoring tertinggi pre-red-team)**: hemat token jangka pendek, tapi membayar dgn silent-desync (klas kehilangan data), kehilangan fact #4, leverage injeksi ×N, dan failure-path bloat yang menumbuhkan kembali bobot prompt yang justru mau dibunuh. Bentuk aditif (job++) mengambil 80% manfaat (ladder ① + receipts) tanpa taruhan itu. Kill-criterion red-team (silent-desync >5%) tertanam sebagai pengukuran wajib sebelum fitur receipt dilebarkan.
- **vs byte-identical checkpoints**: klaim yang tidak bisa dipenuhi CDP; industri (Browserbase/Kernel) memakai persistent profile justru karena itu — dan setup Yusuf SUDAH memakai persistent profile. Bentuk final menambah yang benar-benar hilang: auth-snapshot lintas-profil dgn health check.
- **vs full self-maintaining apparatus**: asimetri biaya (apparatus ≫ aset yang dilindungi — 28 patch yang bisa di-apply ulang manual dalam sehari). Ledger + checksum + chip = nilai nyata hari ini; sisanya = dokumen arah, bukan kode.

---

## 4. RISIKO & MITIGASI (final)

| Risiko | Mitigasi |
|---|---|
| Delta-snapshot mengubah perilaku yang sudah dipelajari model | Flag 3-mode; default `auto` hanya halaman besar; docs diupdate |
| Receipts per-op menambah bobot respons | Receipt = 1 baris/op, ikut verbosity adaptif; detail penuh di `details` |
| `act`-chain ambiguity dgn `job` | Kompilasi ke jalur batch/job yang SAMA; docs menyarankan satu gerbang; mode lama tetap compat |
| Patch ledger false-green thd perubahan semantik upstream | Diterima sebagai batas: ledger menjaga FILE kita; health chip menjaga PERILAKU via sweep eksplisit; keduanya dilaporkan terpisah |
| Restore auth-snapshot dipakai lintas scope | Lineage check (root+checkout) + konfirmasi konsekuensial; isi blob tetap terenkripsi |
| Pekerjaan di dist/ tanpa test suite | Setiap fase wajib verifier offline + live sweep (pola PATCHES.md) sebelum dianggap selesai; ledger mencatat semua |

---

## 5. FIRST STEPS (urutan eksekusi setelah approval)

1. **Patch Integrity Ledger** (±1 hari): transcribe tabel divergensi → `patches.manifest.json` + `scripts/verify-patches.mjs` (~50 baris) + hook checksum pra-spawn. Zero behavior change.
2. **Auto-settle-retry** (±1–2 hari): wrapper-side ladder ① di process-output pipeline; field `recoveredBy` di details; offline verifier + live sweep.
3. **Tutup lubang redaksi `--json`** (±1 hari): redactSensitiveValue atas konten JSON caller (struktur utuh, nilai disaring).
4. **job++ verification receipts** (±2–3 hari): probe field per-op reuse aset existing; receipts 1 baris; pengukuran kill-criterion (replay 20–50 episode transkrip: silent-desync rate & token delta).
5. **Tier A prompt ≤800 chars** + 4 gerbang + verbosity adaptif (±1 hari) — ukur payload sebelum/sesudah.
6. **Delta-snapshot default** + flag (±2 hari) — ukur token/halaman besar.
7. **Origin auth-snapshots + health check + lineage restore** (±3–4 hari).
8. **WebMCP surface + provenance gating**; **vision fallback lane**; **HITL handoff**; **F6 recipes opsional**; sisanya sesuai prioritas.
Setiap langkah: patch diekstrak ke `patches/` (manifest + test) SEBELUM lanjut — tahan clobber.

---

## 6. OPEN QUESTIONS — ANSWERED BY MEASUREMENT (2026-09-30)

All five were left open on purpose because each needed real usage data rather than a guess.
They were measured; three are now closed and two await the log analysis. Numbers, not opinions.

### 6.1 Framing "4 gerbang" vs multi-tool — CLOSED, keep one tool

Measured what actually reaches the prompt on every call:

| part | chars | tokens |
|---|---|---|
| tool description (17 modes) | 566 | ~141 |
| playbook, after the slimming patch | 593 | ~148 |
| **total cold-start** | **1,159** | **~289** |

`playbook.js` is 40 KB of teaching material but only 593 characters reach the prompt — the
slimming patch already did its job. ~289 tokens for 17 modes is not a cost worth restructuring
for. **One tool, many modes. Do not split it.** The premise that mode choice is a cold-start
problem is false at this size.

### 6.2 Delta-snapshot threshold — CLOSED, and the unit was wrong

The open question said "node threshold, proposed >2k". The code said
`DEFAULT_SNAPSHOT_DELTA_MIN_LINES = 2000`. Same number, **different unit** — lines, not nodes.
That coincidence is what let the designer and the implementer believe they were the same knob.

Measured rendered snapshot lines (cdp + snapshot JSON):

| site | nodes | refs | lines | fires @2000? |
|---|---|---|---|---|
| tokopedia | 624 | 56 | 253 | no |
| github | 1809 | 141 | 732 | no |
| wikipedia | 4164 | 547 | 3238 | yes |

2000 only fired on the 4000+ node class, so an ordinary large page (github, ~24k chars,
~6k tokens) re-rendered in full on every snapshot. **Lowered to 600** (commit 116d6c8).
Safe because the delta is presentation-only — the tracked refSnapshot always stays the full new
snapshot, so refs keep working and only the rendered text shrinks. The delta also only pays off
on the second snapshot of a URL: on a first load every ref is "added", so the delta is the
whole page anyway.

Caveat: three sites is a thin sample for a tuning constant. It is env-overridable
(`PI_AGENT_BROWSER_SNAPSHOT_DELTA_MIN_LINES`) precisely because it is a guess with a floor.

### 6.3 `act`-chain vs `job` coexistence — CLOSED, do not merge

Measured over 2,505 agent_browser tool calls (1,618 in main sessions, 887 in subagent runs),
independently parsed twice with agreeing results:

| mode | main-only calls | % of 1,618 |
|---|---|---|
| args | 1554 | 96.0% |
| cdp | 20 | 1.2% |
| checkpoint | 15 | 0.9% |
| job | 15 | 0.9% |
| act | 7 | 0.4% |
| settle / login / vault | 3 / 2 / 2 | ~0.4% |
| script, qa, electron, debug, devServer, networkBody, sourceLookup, networkSourceLookup | 0 | 0% |

`job` is used 15 times and `act` 7. Merging them would rewrite both to deduplicate 22 calls —
churn against noise. **Keep them separate.** `act` is three days old; 7 calls is not a verdict on it.

The real finding is elsewhere. Subcommand distribution over 1,535 parsed calls:
`eval` 813 (53%), `snapshot` 144, `click` 135, `open` 95, `batch` 84, `wait` 73, `type` 36,
`find` 29. **`find` is 29 calls while `eval` is 813** — the agent is hand-writing candidate walks
in JS instead of using `find`, because upstream `find` takes the first match. That is exactly
what `act` was built for, and the ratio confirms the premise was right.

Batch: 82 calls, 446 steps, median 7, max 65, most common 2 (40) then 3 (26).

Error rate: 274 / 2,505 = 10.9%. validation-error 94, upstream-error 76, timeout 25,
stale-ref 12, **tab-drift 8 (0.32%)**. The 25 real timeouts are the class wave 15's
unknown-flag guard exists to kill.

### 6.4 Heartbeat lease — CLOSED, do not build

The stated precondition was "build only if fan-out collisions actually happen". They never have.

Overlapping usage across all sessions, measured minute-by-minute from the session logs:

- 9 session pairs overlap in time, and **every one is a different session name**.
- `ultron1 <-> ultron3`: 252 minutes side by side — two separate profiles, each with its own
  browser. That is the safe case, not a collision.
- `piab-ckpt-*` restore sessions: 1–2 minutes each, also distinct names.
- **Zero cases of two agents driving the same session concurrently.**

The 320 tab-drift strings in the logs are not evidence of collision — they were our own bugs
(an unthreaded session, a host-coerced stdin), all since fixed. Building a lease would be
ceremony: the DEATHS entry for metered-mode tolls already ruled that out as a category.
`lib/temp.js` already implements a lease with staleness where ownership genuinely matters.

### 6.5 F6 recipes: wrapper dir vs pi-knowledge — CLOSED, keep them in the wrapper

The criterion was "decide when F6 starts". Measured baseline so a future decision has something
to argue with:

- 28 unique `read` toolCalls name COMMAND_REFERENCE.md, over 2,505 agent_browser calls = **1.12%**
  (1.61% against main-session calls alone) — roughly one read per 62 browser calls.
- 0.37% of all 7,576 read toolCalls corpus-wide.
- The doc was read in **3 of the 4** root sessions that ever drove a browser.
- Sibling docs in the same directory: TOOL_CONTRACT 10, ARCHITECTURE 4, ELECTRON 3, rest 1–2.

So the passive playbook **is** reached, in most sessions that use the tool, just rarely — it
behaves as a reference the agent consults on demand, not a prompt it pays for every turn. That is
the behaviour wrapper-owned docs already produce, so moving the lessons to pi-knowledge would
trade a working 1.6% channel for a new one with no evidence behind it. **Keep them where they
are.** Reopen only if the read rate falls while error rate rises.

### 6.6 A measurement trap worth recording

Three of my own intermediate numbers were wrong and had to be discarded:

1. `grep -c "mode": *.jsonl` reported `script`, `qa`, `devServer`, `electron`, `settle`, `debug`,
   `sourceLookup` at **exactly 93 each**. Nine different modes cannot share a count; those were
   matches on the mode list inside the schema and the "Provide exactly one input mode" error
   text, not invocations. Real distribution required parsing `parts[] -> type=="toolCall"`.
2. `grep -c COMMAND_REFERENCE.md` reported 2,453 — the string appears in the playbook's
   guide-gate line, in system prompts, and in every read result echo. The real figure is 28 reads.
3. `grep -ci "tab-drift"` reported 320 hits, against **8 actual tab-drift failures** in 2,505
   calls. The other 312 were the word appearing in documentation and prompts.

Grep counts mentions; only a parse counts events. Any number that comes from grep alone in this
project should be treated as a hypothesis.

## 7. CONFIDENCE

- **High**: arsitektur dasar (thin wrapper + refs + fail-closed) — dikonfirmasi riset sebagai pemenang industri; slimming 3 lapis; ladder ①; patch ledger.
- **Medium**: delta-snapshot default (perlu ukur), auth-snapshots (perlu ukur fidelity nyata di LAYAR/AWS), 4-gerbang framing (perlu validasi cold-start).
- **Low**: tidak ada — semua klaim low-confidence sudah dipangkas oleh red-team (blind programs, byte-identical forks, auto-expire, vendored fallback).

**Eviden kunci**: 3 red-team needs-shape semuanya TELAH direshape ke bentuk di atas — tidak ada verdict `dead` yang dipaksa hidup, tidak ada `needs-shape` yang dibawa mentah-mentah.

---

## LAMPIRAN — Jejak blackbox (ringkas)

- **Wide set**: 30 ide, 6 kluster — Pindahkan-loop-ke-runtime · Surface-jadi-router · State-durable · Harness-merawat-diri · Ekonomi-atensi · Manusia-sebagai-author. (Detail: `/tmp/piab-understanding/blackbox-phase1.md`)
- **Traps yang dihindari**: mode tolls (seremoni), browser-as-mount (rewrite total), session-as-event-log & content-addressed sessions (rework masif), escalation credits (menggergi HITL sah), REPL cache (illusion — navigation wipe), driver inversion (arah strategis jangka panjang, bukan iterasi ini — dicatat sebagai arah, bukan kode).
- **Focus & Verify**: `/tmp/piab-understanding/blackbox-phase2.md` (3 deepen), `/tmp/piab-understanding/blackbox-phase3.md` (3 red-team).
- **Provocation** (wildcard): kalau suatu saat upstream membuka akses CDP-protocol pass-through (ide "raw-CDP verb", skor tertinggi fase diverge 8.65), permukaan wrapper bisa menyusut menjadi router murni — pantulkan ke upstream sebagai feature request; itu satu-satunya jalan menuju "bisa apa pun di browser" tanpa menambah permukaan.
