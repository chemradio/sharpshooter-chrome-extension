// Message resolution for the popup.
//
// By default the popup localizes against chrome.i18n, which resolves the
// locale from the browser UI language. The Settings panel lets the user
// force a specific language ("langOverride"); when set, this module fetches
// that locale's _locales/<lang>/messages.json directly and resolves messages
// from it instead — chrome.i18n itself cannot be overridden at runtime.
//
// Exposed as window.__i18n, consumed by i18n.js (DOM localization) and
// popup.js (its t() helper). Loaded before both.
(function () {
    let table = null;          // {key: {message, placeholders?}} | null = auto
    let currentLang = "auto";

    function chromeGet(key, subs) {
        return chrome.i18n.getMessage(
            key,
            subs && subs.length ? subs : undefined
        );
    }

    // Resolve a message from a fetched messages.json table, applying both
    // named ($name$) and bare ($1..$9) positional substitutions the same way
    // chrome.i18n does.
    function customGet(key, subs) {
        const entry = table[key];
        if (!entry) return "";
        let msg = entry.message;
        const ph = entry.placeholders || {};
        msg = msg.replace(/\$([a-zA-Z0-9_]+)\$/g, (m, name) => {
            const def = ph[name] || ph[name.toLowerCase()];
            if (!def || !def.content) return m;
            const idx = parseInt(String(def.content).replace(/[^0-9]/g, ""), 10);
            if (!idx) return m;
            return subs && subs[idx - 1] != null ? subs[idx - 1] : "";
        });
        msg = msg.replace(/\$([1-9])/g, (m, d) =>
            subs && subs[d - 1] != null ? subs[d - 1] : ""
        );
        return msg;
    }

    // Returns the localized string, or the key itself when no message exists.
    function get(key, subs) {
        const v = table ? customGet(key, subs) : chromeGet(key, subs);
        return v || key;
    }

    async function load(lang) {
        currentLang = lang || "auto";
        if (!lang || lang === "auto") {
            table = null;
            return;
        }
        try {
            const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
            const res = await fetch(url);
            table = res.ok ? await res.json() : null;
        } catch (e) {
            console.warn("locale load failed, falling back to auto:", e);
            table = null;
        }
    }

    const ready = chrome.storage.local
        .get("langOverride")
        .then(({ langOverride }) => load(langOverride))
        .catch(() => { table = null; });

    window.__i18n = {
        ready,
        get,
        // Switch locale at runtime (Settings → language change).
        reload: (lang) => load(lang),
        get lang() { return currentLang; },
    };
})();
