// wave6 W6-2: the login preset must not report success on an unverified credential write.
//
// Live origin (LAYAR, 2026-09-28): the login preset filled the username, never filled the password, and
// the tool did not say so. The in-page fill script already computes the precise reason and RETURNS it as
// `{ ok: false, reason: "field-not-found" }` - but an `eval` row that merely returns that object is still a
// SUCCESSFUL batch step to the browser pipeline, and the login host only ever looked at the batch's own
// success flag. So the real cause was swallowed twice: either a false "Completed on <origin>", or, with a
// `waitForUrl`/`waitForText` attached, a failure on an unrelated timeout that never mentioned the password.
//
// This asserts the fix: scan the batch's step matrix for a fill row that reported `ok: false`, surface its
// reason through the existing describeVaultFillFailure prose, and fail the flow even when the batch itself
// reported success. It also pins the guards that keep the scan narrow.
import assert from "node:assert/strict";

import { handleLoginHostInput } from "../dist/extensions/agent-browser/lib/orchestration/login-host/index.js";

const PASSWORD = "wave6-fixture-password-never-real";
const ORIGIN = "https://login-fixture.example";

/** A dispatch that records its calls and returns the given canned browser result. */
const dispatchReturning = (result, calls = []) => async (request) => {
    calls.push(request);
    return result;
};

/** The batch roll-up shape: `details.data` is a `{ success, command, result }` matrix. */
const batchWithFillRows = (rows, overrides = {}) => ({
    isError: false,
    details: {
        resultCategory: "success",
        data: rows.map((row) => ({
            success: true,
            command: row.command,
            result: row.result,
        })),
        ...overrides,
    },
});

const evalRow = (result) => ({ command: ["eval", "-b", "cGF5bG9hZA=="], result });
const fillOk = { ok: true, origin: ORIGIN, fields: [{ role: "password", tag: "input" }] };
const loginInput = { url: `${ORIGIN}/login`, origin: ORIGIN, password: PASSWORD, submit: true, session: "wave6" };

// 1. THE FIX: a fill row that reported ok:false now fails the flow and names the real reason, even though
//    the batch itself succeeded. Before the fix this returned isError:false and "Completed on ...".
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning(batchWithFillRows([
            evalRow({ ok: true, origin: ORIGIN, fields: [{ role: "username", tag: "input" }] }),
            evalRow({ ok: false, origin: ORIGIN, reason: "field-not-found", failedRole: "password" }),
        ])),
    });
    assert.equal(result.isError, true, "a fill script failure fails the login flow");
    assert.equal(result.details.login.fill?.reason, "field-not-found", "the fill reason is exposed in details");
    assert.equal(result.details.login.fill?.failedRole, "password", "the failed role is exposed in details");
    assert.equal(result.details.login.reason, "field-not-found", "reason is the fill failure, not a browser category");
    const text = result.content[0].text;
    assert.match(text, /Refused to fill/, "the existing fill-failure prose is reused");
    assert.match(text, /password/, "the prose names the field that was not written");
    assert.match(text, /NOT written/, "the prose states the credential was not written");
    assert.match(text, /"password" field/, "and names the field that was skipped");
    assert.doesNotMatch(text, /Completed on/, "no false completion line");
}

// 1b. A MULTI-FIELD row that wrote some fields and then failed must not be told to "submit explicitly":
//     the credential that matters was never entered, so submitting would fail. This is why the advice
//     branches on `reason` and not on `filledCount`.
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning(batchWithFillRows([
            evalRow({ ok: false, origin: ORIGIN, reason: "field-not-found", failedRole: "otp", fields: [{ role: "password", tag: "input" }] }),
        ])),
    });
    assert.equal(result.isError, true, "a partially written multi-field row still fails");
    assert.match(result.content[0].text, /NOT written/, "the unwritten field is called out");
    assert.doesNotMatch(result.content[0].text, /Submit the form explicitly/, "and it is not told to submit anyway");
}

// 2. POSITIVE CONTROL: every fill row ok:true keeps the ordinary success result and adds no fill detail.
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning(batchWithFillRows([evalRow(fillOk)])),
    });
    assert.equal(result.isError, false, "a fully successful fill still succeeds");
    assert.equal(result.details.login.fill, undefined, "no fill diagnostics on the happy path");
    assert.match(result.content[0].text, /Completed on https:\/\/login-fixture\.example/, "happy path keeps its completion line");
}

// 3. A downstream wait timeout no longer MASKS the cause: when both are present the fill reason wins, so the
//    agent is told the credential was never typed instead of only seeing a timeout category.
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning({
            isError: true,
            details: {
                resultCategory: "failure",
                failureCategory: "timeout",
                data: [evalRow({ ok: false, origin: ORIGIN, reason: "value-rejected", failedRole: "password" })],
            },
        }),
    });
    assert.equal(result.isError, true, "still a failure");
    assert.equal(result.details.login.reason, "value-rejected", "the fill reason outranks the timeout category");
    assert.match(result.content[0].text, /rejected the typed value/, "value-rejected gets its own prose");
}

// 4. GUARD: a non-fill eval payload (no `ok`/`reason`) is not misread as a credential failure.
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning(batchWithFillRows([evalRow({ title: "Sign in", forms: 1 })])),
    });
    assert.equal(result.isError, false, "an unrelated eval payload is left alone");
}

// 5. GUARD: a step the browser itself already failed is skipped, so the flow does not report two causes.
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning({
            isError: true,
            details: {
                resultCategory: "failure",
                failureCategory: "selector-not-found",
                data: [{ success: false, command: ["eval", "-b", "eA=="], result: { ok: false, reason: "field-not-found" } }],
            },
        }),
    });
    assert.equal(result.details.login.fill, undefined, "an already-failed step is not re-reported as a fill failure");
    assert.equal(result.details.login.reason, "selector-not-found", "the browser's own category is reported instead");
}

// 6. submit-control-not-found: the fields WERE written, so the prose must not claim otherwise, but the flow
//    still fails because the preset's job (complete the sign-in) did not happen.
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning(batchWithFillRows([
            evalRow({ ok: false, origin: ORIGIN, reason: "submit-control-not-found", fields: [{ role: "password", tag: "input" }] }),
        ])),
    });
    assert.equal(result.isError, true, "a missing submit control fails the login flow");
    assert.match(result.content[0].text, /Filled the fields but found no enabled submit control/, "accurate prose for a filled-but-unsubmitted form");
    assert.doesNotMatch(result.content[0].text, /NOT written/, "does not wrongly claim the credential was unwritten");
    assert.match(result.content[0].text, /All fields were written, but the form was not submitted/, "accurate closing line for a filled-but-unsubmitted form");
}

// 7. origin mismatch inside the page is surfaced with the origin it actually saw.
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning(batchWithFillRows([
            evalRow({ ok: false, reason: "origin-mismatch", origin: "https://evil.example", expectedOrigin: ORIGIN }),
        ])),
    });
    assert.equal(result.isError, true, "origin mismatch fails the flow");
    assert.match(result.content[0].text, /page origin does not match/, "origin-mismatch prose is reused");
}

// 8. The scan must not depend on data shape: a non-array details.data is simply "no fill evidence".
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning({ isError: false, details: { resultCategory: "success" } }),
    });
    assert.equal(result.isError, false, "missing step data does not invent a failure");
    assert.match(result.content[0].text, /Completed on/, "and does not invent a fill diagnostic");
}

// 9. The secret is never echoed: the password literal appears in no result text or detail value.
{
    const result = await handleLoginHostInput({
        compiled: loginInput,
        dispatch: dispatchReturning(batchWithFillRows([evalRow({ ok: false, reason: "field-not-found", failedRole: "password" })])),
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(PASSWORD), false, "the login result never contains the password literal");
}

console.log("wave6-login-fill-failure: all assertions passed");
