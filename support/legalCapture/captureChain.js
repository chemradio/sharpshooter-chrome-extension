// A tamper-evident log across captures: every manifest records its position
// in a sequence and the hash of the manifest before it.
//
// Everything else in this package answers "was this capture altered?". This
// answers two questions nothing else touches:
//
//   1. SELECTIVE DISCLOSURE. A hash-sealed, timestamped capture says nothing
//      about the captures that were NOT produced. An operator who runs ten and
//      discloses the two favourable ones commits no forgery and breaks no
//      seal. With a sequence, the disclosed packages are #3 and #7 and the
//      gaps are on the face of the record — visible to the other side, and
//      answerable by the operator if the missing ones were irrelevant.
//
//   2. REBUILD. A forger holding a package can re-forge every artifact, write
//      a fresh manifest and obtain a genuine new timestamp over it; all
//      internal checks then pass (the timestamp's date is the only tell — see
//      report.txt). To place that forgery inside an existing series they must
//      also produce a manifest whose `previousManifestSha256` matches the real
//      #6 and whose hash matches the real #8's back-pointer — i.e. a hash
//      collision, not an edit.
//
// HONEST LIMITS, which the report states rather than glosses:
//   - The chain lives in this profile's chrome.storage.local and the operator
//     controls it. It can be cleared. Clearing is not silent: the sequence
//     restarts at 1 under a NEW chainId, so a fresh chain appearing mid-matter
//     is itself a disclosable fact.
//   - It proves ordering and completeness *within* one chain. It does not
//     prove the chain contains everything the operator ever captured (they
//     could run a second profile).
//   - It is corroborative, not conclusive. Its value is that suppression
//     stops being invisible and starts requiring an explanation.
//
// The chain is bound to the installation's signing key (see operatorKey.js):
// chainId is derived from the key fingerprint, so a new key necessarily starts
// a new chain and the two facts can never disagree.

const STORAGE_KEY = "legalCaptureChain";

function randomId() {
    return [...crypto.getRandomValues(new Uint8Array(8))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

// Read the current chain state, starting a new chain if there is none or if
// the signing key has changed underneath it.
export async function readChainState(keyFingerprint) {
    let stored = null;
    try {
        ({ [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY));
    } catch {
        stored = null;
    }

    const boundKey = keyFingerprint ?? null;
    const keyChanged = stored && stored.keyFingerprint !== boundKey;

    if (!stored || keyChanged) {
        return {
            chainId: randomId(),
            sequence: 1,
            previousManifestSha256: null,
            keyFingerprint: boundKey,
            // Distinguishes "first capture this profile ever made" from "the
            // chain was reset or the key changed" — the second is the one a
            // reader should ask about.
            chainRestarted: Boolean(keyChanged),
            previousChainId: keyChanged ? stored.chainId : null,
        };
    }

    return {
        chainId: stored.chainId,
        sequence: (stored.sequence ?? 0) + 1,
        previousManifestSha256: stored.lastManifestSha256 ?? null,
        keyFingerprint: boundKey,
        chainRestarted: false,
        previousChainId: null,
    };
}

// Committed only after the package has actually been handed to the downloader.
// Advancing on a capture that failed would burn a sequence number and leave a
// permanent gap that no package explains — precisely the signal this is
// supposed to make meaningful.
export async function commitChainState(state, manifestSha256) {
    try {
        await chrome.storage.local.set({
            [STORAGE_KEY]: {
                chainId: state.chainId,
                sequence: state.sequence,
                lastManifestSha256: manifestSha256,
                keyFingerprint: state.keyFingerprint ?? null,
                updatedAt: new Date().toISOString(),
            },
        });
    } catch {
        // A failed bookkeeping write must not fail a completed capture. The
        // next capture reuses this sequence number, which shows up as a
        // duplicate rather than as a silent gap — the safer failure.
    }
}
