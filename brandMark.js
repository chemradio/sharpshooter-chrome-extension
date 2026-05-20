// Loads the brand-mark SVG out of static/embed-{dark,light}.html and injects
// it into every [data-brand-mark] placeholder. The embed HTML files are the
// single source of truth for the icon design; editing them updates both the
// standalone embed pages and the popup brand mark.

(() => {
    const themeQuery = matchMedia("(prefers-color-scheme: dark)");
    const cache = new Map();

    async function loadEmbedSvg(dark) {
        const key = dark ? "dark" : "light";
        if (cache.has(key)) return cache.get(key);
        const url = chrome.runtime.getURL(`static/embed-${key}.html`);
        const html = await fetch(url).then((r) => r.text());
        const match = html.match(/<svg[\s\S]*?<\/svg>/i);
        const svg = match ? match[0] : "";
        cache.set(key, svg);
        return svg;
    }

    async function paint() {
        const svg = await loadEmbedSvg(themeQuery.matches);
        if (!svg) return;
        document.querySelectorAll("[data-brand-mark]").forEach((el) => {
            el.innerHTML = svg;
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", paint, { once: true });
    } else {
        paint();
    }
    themeQuery.addEventListener("change", paint);
})();
