// wave14 lane B: the cdp host handler (dist/.../orchestration/cdp-host/index.js).
//
// The contract has two halves that pull in opposite directions, and both are load-bearing:
//   1. the handler must be able to talk to a real browser over the Node 22 global WebSocket, and
//   2. the test must never contact a browser. A live WebSocket in a test is a test that can hang,
//      flake on a busy machine, and pass for the wrong reason.
//
// So the transport is injected: `webSocketImpl` is a constructor, the default is `globalThis.WebSocket`,
// and the whole global is replaced here with a class that throws if anything ever constructs it. Every
// assertion below therefore runs fully offline and deterministically. Proving the REAL socket path is
// the coordinator's live test, not this file's job.
//
// What is locked, per plan section 5:
//   - no cdpUrl means no socket is ever constructed, and the message names `get cdp-url`
//   - the endpoint is read through the ordinary dispatch argv, so redaction/ledgering still apply
//   - a timeout closes the socket and reports failureCategory "timeout"
//   - a failed command does NOT discard the results of the successful ones
//   - `artifact` without `artifactPath` is a validation error
//   - the raw webSocketDebuggerUrl never reaches `content`

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDP_DEFAULT_CONNECT_TIMEOUT_MS, CDP_MARKER, handleCdpHostInput } from "../dist/extensions/agent-browser/lib/orchestration/cdp-host/index.js";

// Anything that reaches the real global from here on is a test bug, not a browser call.
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
    const calls = [];
    const dispatch = async (params) => {
        calls.push(params);
        return { content: [{ text: "ok", type: "text" }], details: { data }, isError: false };
    };
    return { calls, dispatch };
}

const tempDir = mkdtempSync(join(tmpdir(), "piab-cdp-test-"));
try {
    // --- rule 1: endpoint comes from `get cdp-url` through the normal spawn pipeline -------------
    {
        const { calls, dispatch } = dispatchReturning({ active: true });
        const { sockets, StubWebSocket } = makeSocketFactory();
        const result = await handleCdpHostInput({ compiled: { commands: [{ method: "Target.getTargets" }], session: "ultron1" }, dispatch, webSocketImpl: StubWebSocket });
        assert.equal(result.isError, true, "a missing cdpUrl must fail");
        assert.equal(result.failureCategory, "upstream-error", "a missing cdpUrl is an upstream error, not a validation error");
        assert.match(result.content[0].text, /get cdp-url/, "the error must name the command that produced nothing");
        assert.equal(sockets.length, 0, "no WebSocket may be constructed when cdpUrl is unavailable");
        assert.deepEqual(calls[0].args, ["--session", "ultron1", "get", "cdp-url"], "the endpoint must be read through the ordinary dispatch argv");
        assert.equal(result.resultCategory, "failure");
    }

    // Without a session the argv is the bare getter; a literal `--session undefined` would spawn a
    // session that does not exist.
    {
        const { calls, dispatch } = dispatchReturning({});
        const { sockets, StubWebSocket } = makeSocketFactory();
        const result = await handleCdpHostInput({ compiled: { commands: [{ method: "Target.getTargets" }] }, dispatch, webSocketImpl: StubWebSocket });
        assert.equal(result.isError, true);
        assert.deepEqual(calls[0].args, ["get", "cdp-url"], "a session-less cdp call must not pass an undefined session name");
        assert.equal(sockets.length, 0);
    }

    // An upstream failure while reading the endpoint must be surfaced, not swallowed into a generic one.
    {
        const dispatch = async () => ({ content: [{ text: "session not found", type: "text" }], details: {}, isError: true, resultCategory: "failure" });
        const { sockets, StubWebSocket } = makeSocketFactory();
        const result = await handleCdpHostInput({ compiled: { commands: [{ method: "Target.getTargets" }], session: "ghost" }, dispatch, webSocketImpl: StubWebSocket });
        assert.equal(result.failureCategory, "upstream-error");
        assert.match(result.content[0].text, /get cdp-url/);
        assert.equal(sockets.length, 0);
    }

    // --- rules 2+3: one connection, sequential incremental ids, results in request order ---------
    {
        const { dispatch } = dispatchReturning({ cdpUrl: CDP_URL });
        const { sockets, StubWebSocket } = makeSocketFactory({
            replies: (message) => (message.id === 1 ? { id: 1, result: { targetInfos: [] } } : { id: message.id, result: { value: "Example Domain" } }),
        });
        const result = await handleCdpHostInput({
            compiled: {
                commands: [
                    { method: "Target.getTargets", params: {} },
                    { method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } },
                ],
                session: "ultron1",
            },
            dispatch,
            webSocketImpl: StubWebSocket,
        });
        assert.equal(sockets.length, 1, "one cdp call means exactly one socket");
        assert.equal(sockets[0].url, CDP_URL);
        assert.deepEqual(sockets[0].sent.map((message) => message.id), [1, 2], "ids must be incremental");
        assert.deepEqual(sockets[0].sent.map((message) => message.method), ["Target.getTargets", "Runtime.evaluate"], "commands must be sent in order");
        assert.deepEqual(sockets[0].sent[0].params, {}, "params must be forwarded");
        assert.equal(result.isError, false);
        assert.equal(result.resultCategory, "success");
        assert.equal(result.failureCategory, undefined, "a clean run carries no failureCategory");
        assert.deepEqual(result.details.cdp.results, [
            { index: 0, method: "Target.getTargets", ok: true },
            { index: 1, method: "Runtime.evaluate", ok: true },
        ], "results must come back in request order");
        assert.equal(result.details.cdp.commandCount, 2);
        assert.equal(result.details.cdp.endpoint.origin, "ws://127.0.0.1:41473");
        assert.equal(result.details.cdp.endpoint.path, "/devtools/browser/SUPERSECRET-TOKEN");
        assert.match(result.content[0].text, /Example Domain/, "a successful result has to be visible to the model");
        assert.equal(sockets[0].closeCalls, 1, "the socket is closed when the run ends");
    }

    // --- rule 5: a failed command never discards the successful ones ----------------------------
    {
        const { dispatch } = dispatchReturning({ cdpUrl: CDP_URL });
        const { sockets, StubWebSocket } = makeSocketFactory({
            replies: (message) => (message.id === 1
                ? { id: 1, result: { value: "kept" } }
                : { error: { code: -32601, message: "'Nope.notAMethod' wasn't found" }, id: 2 }),
        });
        const result = await handleCdpHostInput({
            compiled: { commands: [{ method: "Runtime.evaluate", params: { expression: "1" } }, { method: "Nope.notAMethod" }], session: "ultron1" },
            dispatch,
            webSocketImpl: StubWebSocket,
        });
        assert.equal(result.isError, true, "a failed command must mark the result as an error");
        assert.equal(result.resultCategory, "failure");
        assert.equal(result.failureCategory, "upstream-error");
        assert.equal(result.details.cdp.results.length, 2, "both commands stay in the report");
        assert.deepEqual(result.details.cdp.results[0], { index: 0, method: "Runtime.evaluate", ok: true }, "the successful result must survive the later failure");
        assert.equal(result.details.cdp.results[1].ok, false);
        assert.match(result.details.cdp.results[1].error, /Nope\.notAMethod/, "the failing method must be named in its error");
        assert.match(result.content[0].text, /kept/, "the surviving successful result must still be readable");
        assert.equal(sockets[0].closeCalls, 1);
    }

    // --- rule 4: timeout closes the socket, reports "timeout", and does not hang ----------------
    {
        const { dispatch } = dispatchReturning({ cdpUrl: CDP_URL });
        const { sockets, StubWebSocket } = makeSocketFactory({
            replies: (message) => (message.id === 1 ? { id: 1, result: { value: "first" } } : undefined),
        });
        const result = await handleCdpHostInput({
            compiled: { commands: [{ method: "Runtime.evaluate" }, { method: "Runtime.evaluate", params: { expression: "while(1){}" } }], session: "ultron1", timeoutMs: 60 },
            dispatch,
            webSocketImpl: StubWebSocket,
        });
        assert.equal(result.failureCategory, "timeout", "an unanswered command inside the budget is a timeout");
        assert.equal(result.resultCategory, "failure");
        assert.equal(sockets[0].closeCalls, 1, "a timed-out run must close its socket instead of leaking it");
        assert.equal(result.details.cdp.reason, "timeout");
        assert.equal(result.details.cdp.results.length, 1, "results collected before the timeout are kept");
        assert.equal(result.details.cdp.results[0].ok, true);
    }

    // A socket that never opens is a timeout too, not a hang.
    {
        const { dispatch } = dispatchReturning({ cdpUrl: CDP_URL });
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
        const result = await handleCdpHostInput({ compiled: { commands: [{ method: "Target.getTargets" }], session: "ultron1", timeoutMs: 50 }, dispatch, webSocketImpl: SilentSocket });
        assert.equal(result.failureCategory, "timeout", "a socket that never opens must not hang the call");
        assert.equal(sockets[0].closeCalls, 1);
    }

    // A refused connection is an upstream error naming the real cause, not a silent timeout.
    {
        const { dispatch } = dispatchReturning({ cdpUrl: CDP_URL });
        const { sockets, StubWebSocket } = makeSocketFactory({ open: false });
        const result = await handleCdpHostInput({ compiled: { commands: [{ method: "Target.getTargets" }], session: "ultron1", timeoutMs: 2000 }, dispatch, webSocketImpl: StubWebSocket });
        assert.equal(result.failureCategory, "upstream-error");
        assert.match(result.content[0].text, /ECONNREFUSED/, "the socket's own reason must survive");
        assert.equal(sockets[0].closeCalls, 1);
    }

    // --- rule 6: artifact without artifactPath is a validation error, before any socket ----------
    {
        const { calls, dispatch } = dispatchReturning({ cdpUrl: CDP_URL });
        const { sockets, StubWebSocket } = makeSocketFactory();
        const result = await handleCdpHostInput({
            compiled: { commands: [{ artifact: "heap.heapsnapshot", method: "HeapProfiler.takeHeapSnapshot" }], session: "ultron1" },
            dispatch,
            webSocketImpl: StubWebSocket,
        });
        assert.equal(result.failureCategory, "validation-error", "an artifact with nowhere to land is the caller's mistake");
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /artifactPath/, "the message must say what is missing");
        assert.equal(sockets.length, 0, "an invalid artifact request must not open a browser socket");
        assert.equal(calls.length, 0, "and must not even ask the browser for its endpoint");
    }

    // With an artifactPath the payload goes to a file and only the path comes back.
    const artifactDir = join(tempDir, "artifacts");
    {
        const { dispatch } = dispatchReturning({ cdpUrl: CDP_URL });
        const payload = "PAYLOAD-SHOULD-NOT-BE-IN-CONTENT".repeat(50);
        const { sockets, StubWebSocket } = makeSocketFactory({ replies: (message) => ({ id: message.id, result: { chunks: [payload] } }) });
        const result = await handleCdpHostInput({
            compiled: { artifactPath: artifactDir, commands: [{ artifact: "heap.heapsnapshot", method: "HeapProfiler.takeHeapSnapshot", params: {} }], session: "ultron1" },
            dispatch,
            webSocketImpl: StubWebSocket,
        });
        const written = join(artifactDir, "heap.heapsnapshot");
        assert.equal(result.isError, false);
        assert.equal(result.details.cdp.results[0].artifactPath, written, "the report must carry the file path, not the payload");
        assert.doesNotMatch(result.content[0].text, /PAYLOAD-SHOULD-NOT-BE-IN-CONTENT/, "an artifact payload must not be dumped into the conversation");
        assert.match(result.content[0].text, /heap\.heapsnapshot/);
        const onDisk = JSON.parse(readFileSync(written, "utf8"));
        assert.equal(onDisk.chunks[0], payload, "the payload must actually be written to the artifact file");
        assert.equal(sockets[0].closeCalls, 1);
    }

    // --- rule 7: the raw debugger URL never reaches `content` ------------------------------------
    {
        const { dispatch } = dispatchReturning({ cdpUrl: CDP_URL });
        const { StubWebSocket } = makeSocketFactory({
            replies: (message) => ({ id: message.id, result: { targetInfos: [{ targetId: "T1", webSocketDebuggerUrl: CDP_URL }] } }),
        });
        const result = await handleCdpHostInput({ compiled: { commands: [{ method: "Target.getTargets" }], session: "ultron1" }, dispatch, webSocketImpl: StubWebSocket });
        assert.doesNotMatch(result.content[0].text, /SUPERSECRET-TOKEN/, "the debugger token must never reach content");
        assert.doesNotMatch(result.content[0].text, /wss?:\/\//, "no raw ws:// endpoint may reach content, even echoed by a command result");
        assert.equal(result.details.cdp.endpoint.path, "/devtools/browser/SUPERSECRET-TOKEN", "details may carry origin+path for diagnostics");
        assert.doesNotMatch(JSON.stringify(result.details.cdp.results), /SUPERSECRET-TOKEN/);
    }

    // --- the runner's own guards: no commands, no WebSocket global, no dispatch ------------------
    {
        const { sockets, StubWebSocket } = makeSocketFactory();
        const result = await handleCdpHostInput({ compiled: { commands: [] }, dispatch: async () => ({}), webSocketImpl: StubWebSocket });
        assert.equal(result.failureCategory, "validation-error");
        assert.equal(sockets.length, 0);
    }

    {
        const { sockets, StubWebSocket } = makeSocketFactory();
        const result = await handleCdpHostInput({ compiled: { commands: [{ method: "Target.getTargets" }] }, dispatch: async () => ({}), webSocketImpl: null });
        assert.equal(result.failureCategory, "upstream-error", "a runtime without WebSocket is an environment problem, not a TypeError");
        assert.match(result.content[0].text, /Node 22/);
        assert.equal(sockets.length, 0);
    }

    {
        const { sockets, StubWebSocket } = makeSocketFactory();
        const result = await handleCdpHostInput({ compiled: { commands: [{ method: "Target.getTargets" }], session: "ultron1" }, dispatch: undefined, webSocketImpl: StubWebSocket });
        assert.equal(result.failureCategory, "validation-error");
        assert.equal(sockets.length, 0);
    }

    // The frozen exports, asserted rather than assumed: Lane C imports these by name.
    assert.equal(CDP_MARKER, "__piAgentBrowserCdp", "CDP_MARKER is part of the frozen interface");
    assert.equal(CDP_DEFAULT_CONNECT_TIMEOUT_MS, 10000, "CDP_DEFAULT_CONNECT_TIMEOUT_MS is part of the frozen interface");
    assert.equal(typeof handleCdpHostInput, "function");

    // The handler must never have reached for the global, even for a happy path.
    assert.equal(globalThis.WebSocket.name, "ForbiddenWebSocket", "the offline guard must still be installed at the end of the run");
}
finally {
    globalThis.WebSocket = realWebSocket;
    rmSync(tempDir, { force: true, recursive: true });
}

console.log("wave14 lane B cdp-host: PASS (offline, no real WebSocket opened)");
