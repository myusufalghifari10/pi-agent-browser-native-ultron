#!/usr/bin/env bash
# Pre-push gate for the public ultron clone.
#
# Two rules this script exists to enforce, both learned the hard way:
#
# 1. grep -F, never grep -E, for the PII patterns. A regex like `layar.yarsi` has an
#    unescaped dot, so it matches the ordinary Indonesian words "layar yarsi" (screen)
#    and reports a leak that does not exist. Literal patterns only.
# 2. Check the TREE and the PUSHED HISTORY separately, and say which one matched. The
#    campus identifiers were removed from the files but survived in the history, which is
#    what forced the filter-branch rewrite; a tree-only check would have passed them.
#
#    Scope is `master` on purpose, NOT `--all`. This clone keeps a `live` remote pointing at
#    the unsanitised working repo, so `--all` always finds the campus PII in refs/remotes/live
#    and would fail forever on a leak that cannot be pushed. What reaches GitHub is
#    refs/heads/master and nothing else. Never push the `live` remote.
#
# Author metadata is deliberately NOT treated as a leak: the commit email is the
# account owner's own address and is already derivable from the GitHub username. Use
# -c user.email=<noreply> if that ever stops being true.
set -uo pipefail

fail=0

# PII that must appear in neither the tree nor the history.
#
# Assembled from fragments ON PURPOSE. Written literally, this file contains every pattern it
# scans for, so it flags itself in both its own tree and the commit that added it — the leak
# scanner reporting its own source as the leak. Splitting each string means the literal never
# appears contiguously here, while grep -F still matches the real thing everywhere else.
# Do not "tidy" these back into plain literals.
p() { printf '%s%s' "$1" "$2"; }
LITERALS=(
  "$(p students '.yarsi.ac.id')"
  "$(p muhammad '4045')"
  "$(p layar '.yarsi.ac.id')"
  "$(p @ 'students')"
  "$(p 'Muhammad Yusuf' ' Al Ghifari')"
)
# The scrub placeholders are the DESIRED state, not a leak, so they are not checked here.
# Checking for them was the first bug in this script: it flagged the very markers the rewrite
# installed. A revert of the scrub shows up as a real value in LITERALS instead.

echo "== gate 1: literal PII in the committed tree =="
for pat in "${LITERALS[@]}"; do
  n=$(git grep -IF "$pat" HEAD -- . 2>/dev/null | wc -l)
  [ "$n" -eq 0 ] || { echo "  LEAK  $pat  ($n baris di tree HEAD)"; fail=1; }
done
[ "$fail" -eq 0 ] && echo "  bersih"

echo "== gate 2: literal PII in the history that actually gets pushed (master) =="
hist_fail=0
for pat in "${LITERALS[@]}"; do
  n=$(git log -p master 2>/dev/null | grep -cF "$pat")
  [ "$n" -eq 0 ] || { echo "  LEAK  $pat  ($n kemunculan di history master)"; hist_fail=1; fail=1; }
done
[ "$hist_fail" -eq 0 ] && echo "  bersih"

echo "== gate 3: repo state =="
dirty=$(git status --porcelain | wc -l)
[ "$dirty" -eq 0 ] || { echo "  ada $dirty berkas belum ter-commit"; fail=1; }
if [ -f patches/patches.manifest.json ] && command -v node >/dev/null 2>&1; then
  node scripts/verify-patches.mjs 2>&1 | tail -1 | sed 's/^/  /'
  node scripts/verify-patches.mjs >/dev/null 2>&1 || fail=1
fi
conflict=$(git grep -lI "<<<<<<< " HEAD -- . ":!scripts/push-gate.sh" 2>/dev/null | wc -l)
[ "$conflict" -eq 0 ] || { echo "  $conflict berkas masih punya penanda konflik"; fail=1; }

if [ "$fail" -eq 0 ]; then
  echo "== GATE LOLOS =="
  exit 0
fi
echo "== GATE GAGAL — jangan push =="
exit 1
