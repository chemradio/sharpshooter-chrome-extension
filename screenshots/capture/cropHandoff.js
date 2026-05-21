// Manual-crop handoff: stash the just-captured PNG bytes in IndexedDB
// under a one-shot token, then open cropEditor.html?token=… in a new
// tab. The editor reads + deletes the blob on load, draws it into a
// canvas, and lets the user adjust the crop before downloading.
//
// IndexedDB (not chrome.storage.session) because large page captures
// commonly exceed the 10 MiB session-storage quota.

const DB_NAME    = "sharpshooter-crop";
const STORE_NAME = "blobs";
const DB_VERSION = 1;

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function withStore(mode, fn) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, mode);
            const store = tx.objectStore(STORE_NAME);
            const result = fn(store);
            tx.oncomplete = () => resolve(result);
            tx.onerror    = () => reject(tx.error);
            tx.onabort    = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function putCropBlob(token, payload) {
    await withStore("readwrite", (store) => store.put(payload, token));
}

export async function takeCropBlob(token) {
    let value;
    await withStore("readwrite", (store) => {
        const getReq = store.get(token);
        getReq.onsuccess = () => {
            value = getReq.result;
            store.delete(token);
        };
    });
    return value;
}

function makeToken() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Convert base64 PNG → Blob without round-tripping through atob (which
// chokes on multi-MB strings on some Chromium builds).
async function base64PngToBlob(base64) {
    const res = await fetch(`data:image/png;base64,${base64}`);
    return await res.blob();
}

// Stash the screenshot and open the crop editor. The editor takes
// ownership of the blob — this function returns once the tab is open.
export async function handoffToCropEditor(base64, filename) {
    const blob = await base64PngToBlob(base64);
    const token = makeToken();
    await putCropBlob(token, { blob, filename });
    const url = chrome.runtime.getURL(
        `cropEditor.html?token=${encodeURIComponent(token)}`
    );
    await chrome.tabs.create({ url });
}
