// Full-viewport "Capturing…" overlay shown to the user during a capture
// session. The emulated viewport jumps around (resize, zoom reset, expansion
// up to 16384 px) and that visual churn is alarming without context.
//
// The overlay lives in the page DOM (the popup closes the moment focus
// leaves it, so we can't host UI there). It must be invisible to
// `Page.captureScreenshot` — `withHidden` toggles `display:none` via the
// debugger's `Runtime.evaluate` so the hide/restore happens in the same
// CDP channel as the screenshot itself.

const OVERLAY_ID = "__sharpshooter-capture-overlay";

const installOverlay = (id) => {
    if (document.getElementById(id)) return;
    const root = document.createElement("div");
    root.id = id;
    root.setAttribute("data-sharpshooter", "overlay");
    root.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "background:rgba(10,12,16,0.55)",
        "backdrop-filter:blur(2px)",
        "-webkit-backdrop-filter:blur(2px)",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "font:600 14px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        "color:#e6f7ff",
        "pointer-events:auto",
        "cursor:wait",
        "user-select:none",
    ].join(";");
    const pill = document.createElement("div");
    pill.style.cssText = [
        "padding:14px 22px",
        "border-radius:999px",
        "background:rgba(20,24,32,0.92)",
        "border:1px solid rgba(0,229,255,0.55)",
        "box-shadow:0 0 24px rgba(0,229,255,0.35),0 8px 30px rgba(0,0,0,0.5)",
        "display:flex",
        "align-items:center",
        "gap:10px",
        "letter-spacing:0.02em",
    ].join(";");
    const dot = document.createElement("span");
    dot.style.cssText = [
        "width:10px",
        "height:10px",
        "border-radius:50%",
        "background:#00e5ff",
        "box-shadow:0 0 10px #00e5ff",
        "animation:__sharpshooterPulse 1s ease-in-out infinite",
    ].join(";");
    const label = document.createElement("span");
    label.textContent = "Capturing… please wait";
    pill.appendChild(dot);
    pill.appendChild(label);
    root.appendChild(pill);

    const style = document.createElement("style");
    style.setAttribute("data-sharpshooter", "overlay-style");
    style.textContent =
        "@keyframes __sharpshooterPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.35;transform:scale(0.7)}}";
    root.appendChild(style);

    (document.documentElement || document.body).appendChild(root);
};

const removeOverlay = (id) => document.getElementById(id)?.remove();

export const showCaptureOverlay = (tabId) =>
    chrome.scripting
        .executeScript({
            target: { tabId },
            func: installOverlay,
            args: [OVERLAY_ID],
        })
        .catch(() => {});

export const hideCaptureOverlay = (tabId) =>
    chrome.scripting
        .executeScript({
            target: { tabId },
            func: removeOverlay,
            args: [OVERLAY_ID],
        })
        .catch(() => {});

// Toggle the overlay off for the duration of `fn` via the debugger's
// Runtime.evaluate. Same CDP channel as Page.captureScreenshot, so the
// hide is in effect at the moment the renderer composites the frame.
export const withOverlayHidden = async (tabId, fn) => {
    const setDisplay = (display) =>
        new Promise((resolve) => {
            chrome.debugger.sendCommand(
                { tabId },
                "Runtime.evaluate",
                {
                    expression: `(()=>{const el=document.getElementById(${JSON.stringify(
                        OVERLAY_ID
                    )});if(el)el.style.display=${JSON.stringify(display)};})()`,
                },
                () => {
                    void chrome.runtime.lastError;
                    resolve();
                }
            );
        });
    await setDisplay("none");
    try {
        return await fn();
    } finally {
        await setDisplay("flex");
    }
};
