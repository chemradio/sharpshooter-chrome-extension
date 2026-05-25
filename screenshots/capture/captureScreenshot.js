import { withOverlayHidden } from "../../support/captureOverlay.js";

export const takeScreenshotClip = (tabId, clip = {}) => {
    const hasValidClip =
        clip.x != null &&
        clip.y != null &&
        clip.width != null &&
        clip.height != null;

    const params = hasValidClip
        ? {
              clip: {
                  x: clip.x,
                  y: clip.y,
                  width: clip.width,
                  height: clip.height,
                  scale: 1,
              },
          }
        : {};

    return withOverlayHidden(tabId, () =>
        new Promise((resolve, reject) => {
            chrome.debugger.sendCommand(
                { tabId },
                "Page.captureScreenshot",
                params,
                (result) => {
                    if (chrome.runtime.lastError)
                        return reject(chrome.runtime.lastError);
                    console.log("Screenshot captured");
                    resolve(result.data);
                }
            );
        })
    );
};
