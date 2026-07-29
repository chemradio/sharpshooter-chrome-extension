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

const GET_BODY_TIMEOUT_MS = 5000;

const cdpSend = (tabId, command, params = {}) =>
    new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, command, params, (result) => {
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
        requestHeaders: {},
        requestPostData: null,
        wallTime: null, // epoch seconds, from Network.requestWillBeSent
        response: null, // {status, statusText, headers, mimeType, protocol, remoteIPAddress, remotePort, securityDetails}
        body: null,     // {base64Encoded, data}
        bodyError: null,
        failed: null,   // errorMessage from loadingFailed, if any
    };
}

function handleEvent(tabId, session, method, params) {
    switch (method) {
        case "Network.requestWillBeSent": {
            const ex = session.exchanges.get(params.requestId) ?? newExchange(params.requestId);
            ex.url = params.request.url;
            ex.method = params.request.method;
            ex.requestHeaders = { ...ex.requestHeaders, ...params.request.headers };
            ex.requestPostData = params.request.postData ?? ex.requestPostData;
            ex.wallTime = params.wallTime;
            session.exchanges.set(params.requestId, ex);
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
            const fetchBody = cdpSend(tabId, "Network.getResponseBody", { requestId: params.requestId })
                .then((res) => { ex.body = { base64Encoded: res.base64Encoded, data: res.body }; })
                .catch((err) => { ex.bodyError = err.message; });
            session.pending.push(fetchBody);
            break;
        }
        case "Network.loadingFailed": {
            const ex = session.exchanges.get(params.requestId);
            if (ex) ex.failed = params.errorMessage;
            break;
        }
        default:
            break;
    }
}

export async function startRecording(tabId) {
    if (sessions.has(tabId)) {
        throw new Error(`Network recording already active for tab ${tabId}`);
    }

    const session = { exchanges: new Map(), pending: [] };
    sessions.set(tabId, session);

    const onEvent = (source, method, params) => {
        if (source.tabId !== tabId || !method.startsWith("Network.")) return;
        handleEvent(tabId, session, method, params);
    };
    session.onEvent = onEvent;
    chrome.debugger.onEvent.addListener(onEvent);

    try {
        await cdpSend(tabId, "Network.enable", {});
    } catch (err) {
        chrome.debugger.onEvent.removeListener(onEvent);
        sessions.delete(tabId);
        throw err;
    }
    // Security domain adds page-level securityStateChanged events; the
    // per-response cert details we actually need already ride along on
    // Network.responseReceived's `securityDetails`, so a Security.enable
    // failure here is not fatal to the capture.
    await cdpSend(tabId, "Security.enable", {}).catch(() => {});
}

// Stops listening, waits (briefly) for in-flight getResponseBody calls, and
// returns the recorded exchanges in the order their requests were first seen.
export async function stopRecording(tabId) {
    const session = sessions.get(tabId);
    if (!session) return [];

    await cdpSend(tabId, "Network.disable", {}).catch(() => {});
    await cdpSend(tabId, "Security.disable", {}).catch(() => {});
    chrome.debugger.onEvent.removeListener(session.onEvent);
    sessions.delete(tabId);

    await Promise.race([
        Promise.allSettled(session.pending),
        new Promise((resolve) => setTimeout(resolve, GET_BODY_TIMEOUT_MS)),
    ]);

    return [...session.exchanges.values()].sort(
        (a, b) => (a.wallTime ?? 0) - (b.wallTime ?? 0)
    );
}
