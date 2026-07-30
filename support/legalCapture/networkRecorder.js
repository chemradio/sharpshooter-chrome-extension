// Records the raw network exchange for one tab during a Legal Capture
// session, via CDP's Network domain — this is genuinely new CDP surface for
// this extension (no prior chrome.debugger.onEvent usage existed anywhere in
// the codebase; only chrome.debugger.onDetach was hooked, in
// support/debugerAttachment.js). Feeds warcWriter.js, which turns the
// recorded exchanges into WARC request/response record pairs.
//
// Convention match with the rest of the repo: "enable" rejects on failure,
// "disable/teardown" swallows chrome.runtime.lastError (see
// screenshots/emulation/emulationEnabler.js, support/debugerAttachment.js).
//
// Also records, on a best-effort basis:
//   - WebSocket handshakes + frames (Network.webSocket*), since real page
//     content on some sites arrives over WS rather than plain HTTP and a
//     WARC of HTTP exchanges alone would silently miss it.
//   - The page's own Service Worker network activity, by attaching a
//     *second* debugger session directly to matching "service_worker"
//     targets (chrome.debugger.getTargets()). A tab-scoped debugger session
//     does not see requests a Service Worker intercepts/serves from its own
//     cache — those run on a separate debugging target — so without this,
//     SW-served resources on PWA-style sites would be present on screen but
//     absent from the evidence archive with no indication why.

const GET_BODY_TIMEOUT_MS = 5000;

const cdpSend = (debuggee, command, params = {}) =>
    new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(debuggee, command, params, (result) => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            resolve(result);
        });
    });

// One entry per active recording session, keyed by tabId.
const sessions = new Map();

function newExchange(requestId) {
    return {
        requestId,
        url: null,
        method: null,
        type: null,
        frameId: null,
        requestHeaders: {},
        requestPostData: null,
        wallTime: null, // epoch seconds, from Network.requestWillBeSent
        response: null, // {status, statusText, headers, mimeType, protocol, remoteIPAddress, remotePort, securityDetails}
        body: null,     // {base64Encoded, data}
        bodyError: null,
        failed: null,   // errorMessage from loadingFailed, if any
        isMainDocument: false,
        viaServiceWorker: false,
        isRedirectLeg: false,
    };
}

function newWebSocket(requestId, url) {
    return {
        requestId,
        url,
        handshakeRequest: null,  // {headers, wallTime}
        handshakeResponse: null, // {status, statusText, headers}
        frames: [],              // [{direction: "sent"|"received", ts, opcode, payloadData}]
        error: null,
        closedAt: null,
        viaServiceWorker: false,
    };
}

// Finalizes the exchange currently open under `requestId` as one leg of a
// redirect chain (using the just-arrived redirectResponse as its response),
// files it under a synthetic key so it survives, and returns a *new* open
// exchange for the caller to populate with the post-redirect request.
function splitOffRedirectLeg(session, requestId, redirectResponse) {
    const prior = session.exchanges.get(requestId);
    if (prior) {
        const r = redirectResponse;
        prior.response = {
            status: r.status,
            statusText: r.statusText ?? "",
            headers: r.headers ?? {},
            mimeType: r.mimeType ?? "",
            protocol: r.protocol,
            remoteIPAddress: r.remoteIPAddress,
            remotePort: r.remotePort,
            securityDetails: r.securityDetails ?? null,
        };
        prior.isRedirectLeg = true;
        const n = (session.redirectCounts.get(requestId) ?? 0) + 1;
        session.redirectCounts.set(requestId, n);
        session.exchanges.set(`${requestId}#redirect${n}`, prior);
    }
    const fresh = newExchange(requestId);
    session.exchanges.set(requestId, fresh);
    return fresh;
}

function handleNetworkEvent(session, method, params, { viaServiceWorker } = {}) {
    if (!session.captureWebSockets && method.startsWith("Network.webSocket")) return;
    switch (method) {
        case "Network.requestWillBeSent": {
            let ex;
            if (params.redirectResponse) {
                // Same CDP requestId is reused across a redirect chain — the
                // browser fires requestWillBeSent again with the *new*
                // request, carrying the *previous* leg's response in
                // redirectResponse. Without splitting these apart, the
                // redirect response (and its headers/status) is lost
                // entirely and only the final destination survives.
                ex = splitOffRedirectLeg(session, params.requestId, params.redirectResponse);
            } else {
                ex = session.exchanges.get(params.requestId) ?? newExchange(params.requestId);
            }
            ex.url = params.request.url;
            ex.method = params.request.method;
            ex.type = params.type ?? ex.type;
            ex.frameId = params.frameId ?? ex.frameId;
            ex.requestHeaders = { ...ex.requestHeaders, ...params.request.headers };
            ex.requestPostData = params.request.postData ?? ex.requestPostData;
            ex.wallTime = params.wallTime;
            ex.viaServiceWorker = ex.viaServiceWorker || !!viaServiceWorker;
            ex.isMainDocument = ex.type === "Document" && params.frameId === session.mainFrameId;
            session.exchanges.set(params.requestId, ex);
            if (ex.isMainDocument) session.mainDocumentRequestId = params.requestId;
            break;
        }
        case "Network.requestWillBeSentExtraInfo": {
            // Raw headers as actually sent on the wire — supersedes the
            // simplified header set on requestWillBeSent where they differ.
            const ex = session.exchanges.get(params.requestId) ?? newExchange(params.requestId);
            ex.requestHeaders = { ...ex.requestHeaders, ...params.headers };
            session.exchanges.set(params.requestId, ex);
            break;
        }
        case "Network.responseReceived": {
            const ex = session.exchanges.get(params.requestId) ?? newExchange(params.requestId);
            const r = params.response;
            ex.response = {
                ...ex.response,
                status: r.status,
                statusText: r.statusText,
                headers: { ...(ex.response?.headers ?? {}), ...r.headers },
                mimeType: r.mimeType,
                protocol: r.protocol,
                remoteIPAddress: r.remoteIPAddress,
                remotePort: r.remotePort,
                securityDetails: r.securityDetails ?? ex.response?.securityDetails ?? null,
            };
            ex.viaServiceWorker = ex.viaServiceWorker || !!viaServiceWorker;
            session.exchanges.set(params.requestId, ex);
            break;
        }
        case "Network.responseReceivedExtraInfo": {
            const ex = session.exchanges.get(params.requestId) ?? newExchange(params.requestId);
            ex.response = {
                ...ex.response,
                headers: { ...(ex.response?.headers ?? {}), ...params.headers },
            };
            session.exchanges.set(params.requestId, ex);
            break;
        }
        case "Network.loadingFinished": {
            const ex = session.exchanges.get(params.requestId);
            if (!ex) break;
            const fetchBody = cdpSend(session.debuggeeFor(params.requestId), "Network.getResponseBody", { requestId: params.requestId })
                .then((res) => { ex.body = { base64Encoded: res.base64Encoded, data: res.body }; })
                .catch((err) => { ex.bodyError = err.message; session.stats.bodyFailures++; });
            session.pending.push(fetchBody);
            break;
        }
        case "Network.loadingFailed": {
            const ex = session.exchanges.get(params.requestId);
            if (ex) {
                ex.failed = params.errorMessage;
                session.stats.loadFailures++;
            }
            break;
        }
        case "Network.webSocketCreated": {
            const ws = newWebSocket(params.requestId, params.url);
            ws.viaServiceWorker = !!viaServiceWorker;
            session.webSockets.set(params.requestId, ws);
            break;
        }
        case "Network.webSocketWillSendHandshakeRequest": {
            const ws = session.webSockets.get(params.requestId);
            if (ws) ws.handshakeRequest = { headers: params.request?.headers ?? {}, wallTime: params.wallTime };
            break;
        }
        case "Network.webSocketHandshakeResponseReceived": {
            const ws = session.webSockets.get(params.requestId);
            if (ws) {
                ws.handshakeResponse = {
                    status: params.response?.status,
                    statusText: params.response?.statusText,
                    headers: params.response?.headers ?? {},
                };
            }
            break;
        }
        case "Network.webSocketFrameSent": {
            const ws = session.webSockets.get(params.requestId);
            if (ws) {
                ws.frames.push({
                    direction: "sent",
                    ts: params.timestamp,
                    opcode: params.response?.opcode,
                    payloadData: params.response?.payloadData ?? "",
                });
            }
            break;
        }
        case "Network.webSocketFrameReceived": {
            const ws = session.webSockets.get(params.requestId);
            if (ws) {
                ws.frames.push({
                    direction: "received",
                    ts: params.timestamp,
                    opcode: params.response?.opcode,
                    payloadData: params.response?.payloadData ?? "",
                });
            }
            break;
        }
        case "Network.webSocketFrameError": {
            const ws = session.webSockets.get(params.requestId);
            if (ws) {
                ws.error = params.errorMessage;
                session.stats.webSocketFrameErrors++;
            }
            break;
        }
        case "Network.webSocketClosed": {
            const ws = session.webSockets.get(params.requestId);
            if (ws) ws.closedAt = params.timestamp;
            break;
        }
        default:
            break;
    }
}

// Discovers Service Worker debug targets belonging to the same origin as the
// captured tab and attaches a second debugger session to each so their
// network activity (requests the SW intercepts/serves without the page ever
// seeing a network round trip) is captured too. Best-effort only: a worker
// may not be running, may already be held by another debugger client, or
// Service Worker target debugging may not be available — none of that
// should abort the capture, it just means that slice of evidence is
// unavailable (disclosed in the report, not silently dropped).
async function attachServiceWorkerTargets(tabId, session) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) return;

    let origin;
    try {
        origin = new URL(tab.url).origin;
    } catch {
        return;
    }

    const targets = await new Promise((resolve) => {
        chrome.debugger.getTargets((result) => {
            if (chrome.runtime.lastError) return resolve([]);
            resolve(result ?? []);
        });
    });

    const swTargets = targets.filter((t) => {
        if (t.type !== "service_worker" || !t.url) return false;
        try {
            return new URL(t.url).origin === origin;
        } catch {
            return false;
        }
    });

    for (const target of swTargets) {
        const debuggee = { targetId: target.id };
        try {
            await new Promise((resolve, reject) => {
                chrome.debugger.attach(debuggee, "1.3", () => {
                    const err = chrome.runtime.lastError;
                    if (err) return reject(new Error(err.message));
                    resolve();
                });
            });
            await cdpSend(debuggee, "Network.enable", {});
            session.swDebuggees.push(debuggee);
            session.stats.serviceWorkerAttached++;
        } catch {
            session.stats.serviceWorkerAttachFailures++;
        }
    }
}

async function detachServiceWorkerTargets(session) {
    for (const debuggee of session.swDebuggees) {
        await new Promise((resolve) => chrome.debugger.detach(debuggee, () => {
            void chrome.runtime.lastError;
            resolve();
        }));
    }
}

export async function startRecording(tabId, { captureWebSockets = true, captureServiceWorker = true } = {}) {
    if (sessions.has(tabId)) {
        throw new Error(`Network recording already active for tab ${tabId}`);
    }

    const tabDebuggee = { tabId };
    const session = {
        exchanges: new Map(),
        webSockets: new Map(),
        pending: [],
        redirectCounts: new Map(),
        swDebuggees: [],
        mainFrameId: null,
        mainDocumentRequestId: null,
        captureWebSockets,
        stats: {
            bodyFailures: 0,
            loadFailures: 0,
            webSocketFrameErrors: 0,
            serviceWorkerAttachFailures: 0,
            serviceWorkerAttached: 0,
        },
        // getResponseBody must be sent to whichever debuggee (tab or a
        // service-worker target) actually saw the request.
        debuggeeFor(requestId) {
            const ex = session.exchanges.get(requestId);
            return ex?.viaServiceWorker && session.swDebuggees.length ? session.swDebuggees[0] : tabDebuggee;
        },
    };
    sessions.set(tabId, session);

    const onEvent = (source, method, params) => {
        if (!method.startsWith("Network.")) return;
        if (source.tabId === tabId) {
            handleNetworkEvent(session, method, params, { viaServiceWorker: false });
            return;
        }
        const sw = session.swDebuggees.find((d) => d.targetId === source.targetId);
        if (sw) handleNetworkEvent(session, method, params, { viaServiceWorker: true });
    };
    session.onEvent = onEvent;
    chrome.debugger.onEvent.addListener(onEvent);

    try {
        await cdpSend(tabDebuggee, "Page.enable", {});
        const { frameTree } = await cdpSend(tabDebuggee, "Page.getFrameTree", {});
        session.mainFrameId = frameTree?.frame?.id ?? null;
    } catch {
        // Best-effort: main-frame id just makes TLS-summary/main-document
        // detection exact instead of heuristic; its absence isn't fatal.
    }

    try {
        await cdpSend(tabDebuggee, "Network.enable", {});
    } catch (err) {
        chrome.debugger.onEvent.removeListener(onEvent);
        sessions.delete(tabId);
        throw err;
    }
    // Security domain adds page-level securityStateChanged events; the
    // per-response cert details we actually need already ride along on
    // Network.responseReceived's `securityDetails`, so a Security.enable
    // failure here is not fatal to the capture.
    await cdpSend(tabDebuggee, "Security.enable", {}).catch(() => {});

    // Best-effort — see attachServiceWorkerTargets doc comment. Skipped
    // entirely (not even attempted) when the operator has turned the
    // Service Worker capture toggle off.
    if (captureServiceWorker) {
        await attachServiceWorkerTargets(tabId, session).catch(() => {});
    }
}

// Stops listening, waits (briefly) for in-flight getResponseBody calls, and
// returns { exchanges, webSockets, stats, mainDocumentRequestId } —
// exchanges/webSockets in the order their requests were first seen.
export async function stopRecording(tabId) {
    const session = sessions.get(tabId);
    if (!session) return { exchanges: [], webSockets: [], stats: null, mainDocumentRequestId: null };

    const tabDebuggee = { tabId };
    await cdpSend(tabDebuggee, "Network.disable", {}).catch(() => {});
    await cdpSend(tabDebuggee, "Security.disable", {}).catch(() => {});
    await cdpSend(tabDebuggee, "Page.disable", {}).catch(() => {});
    for (const debuggee of session.swDebuggees) {
        await cdpSend(debuggee, "Network.disable", {}).catch(() => {});
    }
    chrome.debugger.onEvent.removeListener(session.onEvent);
    await detachServiceWorkerTargets(session);
    sessions.delete(tabId);

    await Promise.race([
        Promise.allSettled(session.pending),
        new Promise((resolve) => setTimeout(resolve, GET_BODY_TIMEOUT_MS)),
    ]);

    return {
        exchanges: [...session.exchanges.values()].sort((a, b) => (a.wallTime ?? 0) - (b.wallTime ?? 0)),
        webSockets: [...session.webSockets.values()],
        stats: session.stats,
        mainDocumentRequestId: session.mainDocumentRequestId,
    };
}
