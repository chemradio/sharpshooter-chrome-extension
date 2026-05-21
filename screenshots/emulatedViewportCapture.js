import { withEmulatedCapture } from "./captureSession.js";
import { takeScreenshotClip } from "./capture/captureScreenshot.js";
import { downloadScreenshot } from "./capture/downloadScreenshot.js";

const DEFAULT_METRICS = {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
};

export const emulateCaptureViewport = (
    tabId,
    deviceMetrics = DEFAULT_METRICS,
    screenshotSuffix = "",
    deliveryOptions = {}
) =>
    withEmulatedCapture(tabId, deviceMetrics, async () => {
        const screenshot = await takeScreenshotClip(tabId);
        await downloadScreenshot(screenshot, `page-${screenshotSuffix}`, deliveryOptions);
    });
