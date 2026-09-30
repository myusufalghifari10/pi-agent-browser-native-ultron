# Live honesty harness

`node tests-v2/live/honesty-harness.mjs [--session NAME]`

Drives the **real** `TOOL.execute` behind a mocked pi against a **real** browser and a page whose
state it put there itself. Nothing is reimplemented, so this exercises the same code path Pi runs —
and therefore the same host parameter coercion.

## Why it exists

The defect class that has bitten this extension repeatedly is not a crash. It is a check reporting a
verdict it never earned: an empty `expectedText` compiling into a preset that asserts nothing, a
preset with no batch rows staying "succeeded", an unreadable `wait --fn` verdict scoring as a PASS, a
source lookup with no rows reading as a clean negative, a malformed network route command erasing
every configured route.

A reviewer finds those by asking a lucky question. This finds them by construction: **for every mode
that reports a verdict, it drives a positive case that must pass and a negative case that must fail.**
A mode that cannot tell those apart is broken, and that is the entire test.

## Using it

Needs one **idle** browser profile. It does not start or stop sessions, so it cannot disturb one
being used. Point it at a free one with `--session`.

## Two things a green run does not mean

Both found by sabotaging the harness, not by reading it:

1. **The unreadable-verdict path is not covered here.** Sabotaging that branch produced zero failures
   against this harness, while the same sabotage fails the offline test. Structural: the predicate qa
   compiles returns a boolean, so a real page never produces an unreadable verdict — and that verdict
   is the only thing the path exists for. Covering it needs a synthetic batch row, which is what
   `tests-v2/wave23-qa-silent-pass.mjs` does.
2. **A sabotage must re-pin `patches/patches.manifest.json`.** Without that the patch-integrity ledger
   refuses to start the tool, and every check fails with the same "drifted" error. That looks like a
   loud, convincing sabotage and measures nothing about behaviour. The first three sabotages here did
   exactly that.

## What it checks, and what it deliberately does not

Covers: `qa`, `debug`, `sourceLookup`, `job`, `act`, `networkBody`, plus plain `args` navigation and
eval. It does not start or close sessions, does not touch a profile Yusuf is using, and does not cover
`electron`, `vault`, `cdp` or `login` — those need a real desktop app, a real credential, or a raw CDP
session, none of which a fixture page can stand in for.
