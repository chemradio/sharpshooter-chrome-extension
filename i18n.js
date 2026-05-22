// Localizes the popup DOM against window.__i18n (see localize.js — which
// honors the Settings language override). Markup-driven: elements carry one
// of four data attributes —
//   data-i18n        → textContent
//   data-i18n-html   → innerHTML  (for strings that contain markup)
//   data-i18n-title  → title attribute
//   data-i18n-ph     → placeholder attribute
//
// Applied once __i18n is ready; popup.js may override individual strings
// afterwards. Exposed as window.__applyI18n so a runtime language change can
// re-localize the whole DOM in place.
(function () {
    function apply() {
        const get = window.__i18n.get;
        const run = (attr, fn) => {
            for (const el of document.querySelectorAll(`[${attr}]`)) {
                const key = el.getAttribute(attr);
                const value = get(key);
                // get() falls back to the key itself for missing messages —
                // leave the markup default in that case.
                if (value && value !== key) fn(el, value);
            }
        };
        run("data-i18n",       (el, v) => { el.textContent = v; });
        run("data-i18n-html",  (el, v) => { el.innerHTML = v; });
        run("data-i18n-title", (el, v) => { el.title = v; });
        run("data-i18n-ph",    (el, v) => { el.placeholder = v; });
    }

    window.__applyI18n = apply;
    window.__i18n.ready.then(apply);
})();
