// Site-aware element capture.
//
// Two entry points:
//
//   detectSite            — Called by the popup on open. Injects the site
//                           module in detect-only mode and reports
//                           { module, pageType }. Non-destructive: the
//                           module's cleanup/xpath pipeline is skipped.
//   captureSiteElement    — Called by the popup's "Capture this <X>" prompt
//                           button. Runs the full site-module pipeline
//                           (which cleans surrounding chrome and returns an
//                           xpath) + element capture.

import { captureElement } from "./elementSelect/elementClickListener.js";

// hostname → site module file (under contentScripts/sites/<name>.js)
export const SITE_MODULES = {
    "www.facebook.com": "facebook",
    "facebook.com": "facebook",
    "m.facebook.com": "facebook",
    "www.instagram.com": "instagram",
    "instagram.com": "instagram",
    "t.me": "telegram",
    "x.com": "x",
    "www.x.com": "x",
    "twitter.com": "x",
    "www.twitter.com": "x",
    "vk.com": "vk",
    "www.vk.com": "vk",
    "m.vk.com": "vk",
    "www.threads.com": "threads",
    "threads.com": "threads",
    "www.threads.net": "threads",
    "threads.net": "threads",
};

// URL gates for the popup's detect prompt. Without these, DOM selectors
// like `article` (Instagram), `[data-pagelet="GroupFeed"]` (Facebook), or
// `article[tabindex="-1"]` (X) match on feed/profile pages and the popup
// false-prompts a "Capture this post" button. The pipeline still trusts
// the module's pageType for labeling once the URL passes the gate.
const SITE_URL_PATTERNS = {
    facebook: [
        /\/posts\//,
        /\/permalink\//,
        /\/photo(?:\.php|\/|\?)/,
        /\/watch(?:\/|\?)/,
        /\/reel\//,
        /\/stories\//,
        /\/share\/[pvr]\//,
        /\/groups\/[^/]+\/(?:posts|permalink)\//,
        /[?&]story_fbid=/,
    ],
    instagram: [
        /\/(?:p|reel|tv)\/[^/?#]+/,
        /\/stories\//,
    ],
    telegram: [
        // t.me/<channel>/<numeric-post-id> — channel landings have no /<n>.
        /^\/[^/]+\/\d+(?:[/?#]|$)/,
        /^\/s\/[^/]+\/\d+(?:[/?#]|$)/,
    ],
    x: [
        /\/[^/]+\/status\/\d+/,
    ],
    vk: [
        // /wall12345_67, /wall-12345_67, also ?w=wall...
        /\/wall-?\d+_\d+/,
        /[?&]w=wall-?\d+_\d+/,
    ],
    threads: [
        // /@username/post/<id>
        /^\/@[^/]+\/post\/[^/?#]+/,
    ],
};

export function pickModule(hostname) {
    return SITE_MODULES[hostname] ?? null;
}

function urlLooksLikePostOrStory(moduleName, url) {
    const patterns = SITE_URL_PATTERNS[moduleName];
    if (!patterns) return false;
    let pathAndQuery;
    try {
        const u = new URL(url);
        pathAndQuery = u.pathname + u.search;
    } catch {
        return false;
    }
    return patterns.some((re) => re.test(pathAndQuery));
}

function measureInnerWidth(tabId) {
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
            {
                target: { tabId },
                func: () => window.innerWidth,
            },
            (results) => {
                if (chrome.runtime.lastError)
                    return reject(new Error(chrome.runtime.lastError.message));
                resolve(results?.[0]?.result ?? 1920);
            }
        );
    });
}

// Two-step injection: first set window.__SiteOptions so the IIFE can
// branch on detectOnly, then inject the module itself. Modules are
// re-injectable — each invocation overwrites window.__AutoCapturePending.
async function injectSiteModule(tabId, moduleName, options) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (opts) => { window.__SiteOptions = opts; },
        args: [options ?? {}],
    });
    await chrome.scripting.executeScript({
        target: { tabId },
        files: [
            "contentScripts/sites/_xpath.js",
            `contentScripts/sites/${moduleName}.js`,
        ],
    });
    const [{ result: plan }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__AutoCapturePending,
    });
    return plan;
}

// Non-destructive site detection for the popup prompt. Returns the page
// type the site module recognized so the popup can offer a targeted
// "Capture this <post|story|...>" button.
export async function detectSite({ tabId, url }) {
    const host = new URL(url).hostname;
    const moduleName = pickModule(host);
    if (!moduleName) return { module: null, pageType: null };

    // URL gate first — many in-page detectors match on feed/profile pages
    // too. Without this filter the popup would prompt "Capture this post"
    // on a Facebook group feed or an Instagram explore page.
    if (!urlLooksLikePostOrStory(moduleName, url)) {
        return { module: moduleName, pageType: null };
    }

    try {
        const plan = await injectSiteModule(tabId, moduleName, { detectOnly: true });
        return { module: moduleName, pageType: plan?.pageType ?? null };
    } catch (e) {
        console.warn("detectSite failed:", e);
        return { module: moduleName, pageType: null };
    }
}

// Prompt-triggered element capture. Runs the full site-module pipeline
// (cleanup + xpath build) and crops to the returned element. Errors if
// the page no longer offers an element target.
export async function captureSiteElement({ tabId, url, settings, screenshotSuffix }) {
    const scale = settings.deviceScaleFactor || 2;
    const host = new URL(url).hostname;
    const moduleName = pickModule(host);
    if (!moduleName) throw new Error(`No site module for ${host}`);

    const plan = await injectSiteModule(tabId, moduleName, { detectOnly: false });

    if (plan?.mode !== "element" || !plan.xpath) {
        throw new Error("No element target detected on this page");
    }

    // A site module may attach a `viewport` hint to its element plan when
    // the default capture frame is wrong for the target (e.g. a fixed-aspect
    // Instagram story card). The element pipeline still auto-expands the
    // viewport if the element exceeds it.
    //
    // Default width = the user's actual innerWidth so the captured layout
    // matches what the user sees in their browser at their current zoom
    // (sites render differently at 1920 desktop vs ~1462 zoomed-narrow).
    const innerWidth = await measureInnerWidth(tabId);
    const deviceMetrics = {
        width: innerWidth,
        height: 7000,
        deviceScaleFactor: scale,
        mobile: false,
        ...(plan.viewport ?? {}),
    };

    await captureElement({
        tabId,
        xpath: plan.xpath,
        deviceMetrics,
        screenshotSuffix: `${moduleName}-${screenshotSuffix}`,
        manualCrop: !!settings.manualCrop,
    });
    return { mode: "element", module: moduleName };
}
