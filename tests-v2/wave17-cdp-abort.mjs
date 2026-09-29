// wave17 lane w17_cdp_abort: an AbortSignal must cancel a cdp run in the MIDDLE, not only at the top.
//
// Before this lane `handleCdpHostInput` read `signal.aborted` once, before the endpoint was even
// fetched. After that instant the signal was ignored: Ctrl-C during a slow cdp call did not stop
// anything, the run kept waiting on a dead socket, and when it finally returned the model was told
// "Command 1 (Runtime.evaluate) did not answer within the remaining cdp budget of 120000 ms" - a
// timeout story about a command that was never given a chance, because the caller had walked away.
//
// What is locked here:
//   - an abort that fires mid-run returns failureCategory "timeout" and a message that says the run
//     was CANCELLED, not that a command failed to answer (the two diagnoses send the model to
//     completely different next moves)
//   - it returns PROMPTLY: bounded by the abort, not by the 120s budget
//   - the socket is closed on the abort path, so Ctrl-C does not leak the connection
//   - results collected before the abort survive, like any other partial run
//   - the abort listener is removed afterwards; a 10k-command run must not leak 10k listeners on the
//     caller's signal
//   - a signal that never aborts changes nothing: the ordinary timeout still reports "did not answer"
//
// Transport is injected exactly as in wave14-cdp-host.mjs, so this file is fully offline.

import assert from "node:assert/strict";
import { handleCdpHostInput } from "../dist/extensions/agent-browser/lib/orchestration/cdp-host/index.js";

const realWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class ForbiddenWebSocket {
    constructor() {
        throw new Error("this test must never construct a real WebSocket");
    }
};

const CDP_URL = "ws://127.0.0.1:41473/devtools/browser/SUPERSECRET-TOKEN";

function makeSocketFactory({ open = true, replies = () => undefined } = {}) {
    const sockets = [];
    class StubWebSocket {
        constructor(url) {
            this.closeCalls = 0;
            this.listeners = new Map();
            this.sent = [];
            this.url = url;
            sockets.push(this);
            queueMicrotask(() => this.emit(open ? "open" : "error", open ? {} : { error: { message: "connect ECONNREFUSED 127.0.0.1:41473" } }));
        }

        addEventListener(name, listener) {
            if (!this.listeners.has(name)) {
                this.listeners.set(name, []);
            }
            this.listeners.get(name).push(listener);
        }

        send(text) {
            const message = JSON.parse(text);
            this.sent.push(message);
            queueMicrotask(() => {
                const reply = replies(message, this);
                if (reply !== undefined) {
                    this.emit("message", { data: JSON.stringify(reply) });
                }
            });
        }

        close() {
            this.closeCalls += 1;
        }

        emit(name, event) {
            for (const listener of this.listeners.get(name) ?? []) {
                listener(event);
            }
        }
    }
    return { sockets, StubWebSocket };
}

function dispatchReturning(data) {
    return async () => ({ content: [{ text: "ok", type: "text" }], details: { data }, isError: false });
}

// A signal wrapper that counts listener bookkeeping, so "the handler removed what it added" is an
// assertion rather than a hope. Forwards everything else to the real AbortSignal.
function makeCountingSignal() {
    const controller = new AbortController();
    const counters = { added: 0, removed: 0 };
    return {
        abortAfter(ms) {
            setTimeout(() => controller.abort(), ms).unref?.();
        },
        assertBalanced(what) {
            assert.equal(counters.added, counters.removed, `the cdp run must remove every abort listener it adds (${what})`);
        },
        get outstanding() {
            return counters.added - counters.removed;
        },
        signal: {
            get aborted() {
                return controller.signal.aborted;
            },
            addEventListener(name, listener, options) {
                if (name === "abort") {
                    counters.added += 1;
                }
                controller.signal.addEventListener(name, listener, options);
            },
            removeEventListener(name, listener, options) {
                if (name === "abort") {
                    counters.removed += 1;
                }
                controller.signal.removeEventListener(name, listener, options);
            },
        },
    };
}

try {
    // --- the headline case: abort lands between two commands ------------------------------------
    {
        const dispatch = dispatchReturning({ cdpUrl: CDP_URL });
        let evaluates = 0;
        const { sockets, StubWebSocket } = makeSocketFactory({
            // The first Runtime.evaluate answers, the second never does. Without the race the run
            // would sit on the unanswered command until the whole budget expired, and would then
            // report a timeout about a command nobody was waiting for any more.
            replies: (message) => {
                if (message.method !== "Runtime.evaluate") {
                    return { id: message.id, result: { targetInfos: [{ targetId: "TAB1", type: "page" }] } };
                }
                evaluates += 1;
                return evaluates === 1 ? { id: message.id, result: { value: "first" } } : undefined;
            },
        });
        const counting = makeCountingSignal();
        counting.abortAfter(25);
        const startedAt = Date.now();
        const result = await handleCdpHostInput({
            compiled: { commands: [{ method: "Runtime.evaluate", params: { expression: "1" } }, { method: "Runtime.evaluate", params: { expression: "while(1){}" } }], session: "ultron1", timeoutMs: 5000 },
            dispatch,
            signal: counting.signal,
            webSocketImpl: StubWebSocket,
        });
        const elapsedMs = Date.now() - startedAt;
        assert.equal(result.failureCategory, "timeout", "a cancelled run keeps the timeout category the contract already promised");
        assert.equal(result.isError, true);
        assert.equal(result.resultCategory, "failure");
        assert.equal(result.details.cdp.reason, "aborted", "the run must be distinguishable from a plain timeout");
        assert.match(result.content[0].text, /cancel/i, "the message must name the cancellation");
        assert.doesNotMatch(result.content[0].text, /did not answer within/, "a cancelled run must not be reported as a command that failed to answer");
        assert.ok(elapsedMs < 1000, `an abort must end the run promptly, not after the budget (took ${elapsedMs} ms)`);
        assert.equal(sockets[0].closeCalls, 1, "an aborted run must close its socket");
        assert.equal(result.details.cdp.results.length, 1, "results collected before the abort survive");
        assert.deepEqual(result.details.cdp.results[0], { index: 0, method: "Runtime.evaluate", ok: true });
        counting.assertBalanced("mid-run abort");
    }

    // --- abort while the socket is still opening ---------------------------------------------------
    {
        const sockets = [];
        class SilentSocket {
            constructor(url) {
                this.closeCalls = 0;
                this.url = url;
                sockets.push(this);
            }

            addEventListener() {}

            send() {}

            close() {
                this.closeCalls += 1;
            }
        }
        const counting = makeCountingSignal();
        counting.abortAfter(25);
        const startedAt = Date.now();
        const result = await handleCdpHostInput({
            compiled: { commands: [{ method: "Target.getTargets" }], session: "ultron1", timeoutMs: 20000 },
            dispatch: dispatchReturning({ cdpUrl: CDP_URL }),
            signal: counting.signal,
            webSocketImpl: SilentSocket,
        });
        assert.equal(result.failureCategory, "timeout", "cancelling during the connect wait must not hang the call");
        assert.equal(result.details.cdp.reason, "aborted", "a cancellation during connect is a cancellation, not an unanswered command");
        assert.match(result.content[0].text, /cancel/i);
        assert.doesNotMatch(result.content[0].text, /did not open within/, "the connect-wait timeout text must not survive an abort");
        assert.ok(Date.now() - startedAt < 1000, "the connect wait must be interruptible");
        assert.equal(sockets[0].closeCalls, 1, "a socket that never opened is still closed on the abort path");
        counting.assertBalanced("abort during connect");
    }

    // --- abort during the target handshake --------------------------------------------------------
    {
        const { sockets, StubWebSocket } = makeSocketFactory({
            // The discovery probe never answers, so the abort has to interrupt the pre-command wait
            // rather than one of the caller's own commands.
            replies: () => undefined,
        });
        const counting = makeCountingSignal();
        counting.abortAfter(25);
        const result = await handleCdpHostInput({
            compiled: { commands: [{ method: "Runtime.evaluate", params: { expression: "1" } }], session: "ultron1", timeoutMs: 20000 },
            dispatch: dispatchReturning({ cdpUrl: CDP_URL }),
            signal: counting.signal,
            webSocketImpl: StubWebSocket,
        });
        assert.equal(result.details.cdp.reason, "aborted", "the handshake waits must be raced against the signal too");
        assert.equal(result.failureCategory, "timeout");
        assert.equal(sockets[0].closeCalls, 1);
        assert.equal(sockets[0].sent.filter((m) => m.method === "Runtime.evaluate").length, 0, "nothing may be sent after the cancellation");
        counting.assertBalanced("abort during the handshake");
    }

    // --- a signal that never aborts changes nothing ----------------------------------------------
    {
        const { StubWebSocket } = makeSocketFactory({
            replies: (message) => (message.method === "Target.getTargets" ? { id: message.id, result: { targetInfos: [] } } : { id: message.id, result: { value: "kept" } }),
        });
        const counting = makeCountingSignal();
        const result = await handleCdpHostInput({
            compiled: { commands: [{ method: "Runtime.evaluate", params: { expression: "1" } }], session: "ultron1" },
            dispatch: dispatchReturning({ cdpUrl: CDP_URL }),
            signal: counting.signal,
            webSocketImpl: StubWebSocket,
        });
        assert.equal(result.isError, false, "a live signal must not disturb a successful run");
        assert.equal(result.details.cdp.results[0].ok, true);
        counting.assertBalanced("un-aborted run");
    }

    // The real timeout is still a timeout, and still says so: the race must not have swallowed the
    // distinction between "the caller left" and "the browser never answered".
    {
        const { sockets, StubWebSocket } = makeSocketFactory({
            replies: (message) => (message.method === "Target.getTargets" ? { id: message.id, result: { targetInfos: [] } } : undefined),
        });
        const counting = makeCountingSignal();
        const result = await handleCdpHostInput({
            compiled: { commands: [{ method: "Runtime.evaluate", params: { expression: "while(1){}" } }], session: "ultron1", timeoutMs: 60 },
            dispatch: dispatchReturning({ cdpUrl: CDP_URL }),
            signal: counting.signal,
            webSocketImpl: StubWebSocket,
        });
        assert.equal(result.failureCategory, "timeout");
        assert.equal(result.details.cdp.reason, "timeout", "an unanswered command on a live signal is still a timeout, not a cancellation");
        assert.match(result.content[0].text, /did not answer within/, "the pre-existing timeout wording must be unchanged");
        assert.doesNotMatch(result.content[0].text, /cancel/i);
        assert.equal(sockets[0].closeCalls, 1);
        counting.assertBalanced("ordinary timeout");
    }

    // The pre-flight check is untouched: a signal already aborted before any socket still fails
    // before the endpoint is even read.
    {
        const { calls, dispatch } = (() => {
            const seen = [];
            return { calls: seen, dispatch: async (params) => { seen.push(params); return { content: [], details: { data: { cdpUrl: CDP_URL } }, isError: false }; } };
        })();
        const { sockets, StubWebSocket } = makeSocketFactory();
        const controller = new AbortController();
        controller.abort();
        const result = await handleCdpHostInput({
            compiled: { commands: [{ method: "Target.getTargets" }], session: "ultron1" },
            dispatch,
            signal: controller.signal,
            webSocketImpl: StubWebSocket,
        });
        assert.equal(result.failureCategory, "timeout");
        assert.equal(result.details.cdp.reason, "aborted");
        assert.equal(sockets.length, 0, "an already-aborted call must not open a socket");
        assert.equal(calls.length, 0, "nor read the endpoint");
    }

    assert.equal(globalThis.WebSocket.name, "ForbiddenWebSocket", "the offline guard must still be installed at the end of the run");
}
finally {
    globalThis.WebSocket = realWebSocket;
}

console.log("wave17 cdp abort: PASS (offline, no real WebSocket opened)");
