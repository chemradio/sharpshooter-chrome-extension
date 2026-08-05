// SHA-256 of the extension's own source files that produce a Legal Capture
// package, recorded into the sealed manifest.
//
// `provenance.installType` ("normal" = published Web Store build, "development"
// = an unpacked copy the operator can edit) is reported by the very code whose
// integrity is in question, and a modified build can simply lie about it. This
// does not fix that — nothing running on the operator's machine can. What it
// does is make the claim *checkable against an outside source*: anyone can
// download the published .crx for the recorded version, hash the same paths,
// and compare. Agreement means the package was produced by the published build;
// disagreement is a fact worth an explanation.
//
// That is the same principle already applied to the server IP and the CT log
// entries — push each self-report toward something a third party can test —
// rather than a claim to be self-protecting.
//
// The list is explicit rather than discovered. MV3 offers no way to enumerate
// the extension's own bundle (chrome.runtime.getPackageDirectoryEntry does not
// exist in MV3), so an incomplete list is unavoidable; an explicit one is at
// least honest about its own scope, which `coverage` states in the manifest.
// When you add a module that shapes the package's contents, add it here too.
const HASHED_PATHS = [
    "manifest.json",
    "backgroundScript.js",
    "support/legalCapture/legalCaptureSession.js",
    "support/legalCapture/networkRecorder.js",
    "support/legalCapture/warcWriter.js",
    "support/legalCapture/zipWriter.js",
    "support/legalCapture/tsaClient.js",
    "support/legalCapture/legalCaptureOptions.js",
    "support/legalCapture/operatorKey.js",
    "support/legalCapture/captureChain.js",
    "support/legalCapture/codeIntegrity.js",
    "support/binary.js",
    "support/pageMeasure.js",
    "support/inputSuppression.js",
];

async function hashOwnFile(path) {
    try {
        const res = await fetch(chrome.runtime.getURL(path));
        if (!res.ok) return null;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
        return null;
    }
}

export async function collectCodeIntegrity() {
    try {
        const entries = await Promise.all(
            HASHED_PATHS.map(async (path) => [path, await hashOwnFile(path)])
        );
        const files = {};
        for (const [path, hash] of entries) if (hash) files[path] = hash;
        return {
            algorithm: "sha256",
            coverage:
                "Explicit list of the modules that produce this package — not the whole extension. " +
                "Compare against the published build of the version recorded in provenance.",
            files,
            unreadable: entries.filter(([, h]) => !h).map(([p]) => p),
        };
    } catch {
        return null;
    }
}
