'use strict';
// Loaded via  node --require ./tunein-patch.cjs index.js
// Runs before ANY other module is evaluated, so our patched http.request /
// http.get / globalThis.fetch are captured by node-raumkernel's MediaListManager
// at its own module-load time.
//
// node-raumkernel's MediaListManager fetches the raw opml.radiotime.com
// relay URL stored in each renderer's AVTransportURI / AVTransportURIMetaData.
// TuneIn counts each such fetch as a new session request against the shared
// serial (78:a5:04:f1:82:ee), which triggers CDN-token throttle and causes
// stream drops on playing rooms.
//
// The kernel's own ebrowse session renewals are made from the kernel *binary*
// (a native process, not Node.js http), so this patch never affects them.

// ── Startup diagnostic ───────────────────────────────────────────────────────
// This message appears WITHOUT a timestamp (console override runs later in
// index.js).  Its presence in the log confirms --require loaded this file.
process.stdout.write('[Command] [TuneIn-Intercept] CJS preloader active — patching http + fetch\n');

const http = require('http');
const { EventEmitter } = require('events');

const BLOCKED_HOST = 'opml.radiotime.com';
const FAKE_BODY = Buffer.from('#EXTM3U\n');

function isTuneIn(urlOrOpts) {
    let host = '';
    if (typeof urlOrOpts === 'string') {
        try { host = new URL(urlOrOpts).hostname; } catch { /* ignore */ }
    } else if (urlOrOpts && typeof urlOrOpts === 'object') {
        // Handles plain options objects AND URL instances (both have .hostname)
        host = (urlOrOpts.hostname || urlOrOpts.host || '').split(':')[0];
    }
    return host === BLOCKED_HOST;
}

function fakeRequest(callback) {
    const fakeReq = new EventEmitter();
    fakeReq.end          = () => fakeReq;
    fakeReq.write        = () => fakeReq;
    fakeReq.destroy      = () => {};
    fakeReq.abort        = () => {};
    fakeReq.setHeader    = () => {};
    fakeReq.removeHeader = () => {};
    fakeReq.setTimeout   = () => fakeReq;
    fakeReq.flushHeaders = () => {};
    fakeReq.socket       = null;
    fakeReq.headersSent  = false;
    setImmediate(() => {
        const fakeRes = new EventEmitter();
        fakeRes.statusCode    = 200;
        fakeRes.statusMessage = 'OK';
        fakeRes.headers       = { 'content-type': 'audio/x-mpegurl' };
        fakeRes.httpVersion   = '1.1';
        fakeRes.destroy = () => {};
        fakeRes.resume  = () => {};
        fakeRes.pipe    = () => fakeRes;
        if (callback) {
            callback(fakeRes);
        } else {
            fakeReq.emit('response', fakeRes);
        }
        setImmediate(() => {
            fakeRes.emit('data', FAKE_BODY);
            fakeRes.emit('end');
        });
    });
    return fakeReq;
}

// ── Patch http.request and http.get ─────────────────────────────────────────
const _origRequest = http.request.bind(http);
const _origGet     = http.get.bind(http);

http.request = function patchedRequest(url, options, cb) {
    const callback = typeof options === 'function' ? options : cb;
    if (isTuneIn(url)) {
        console.log('[Command] [TuneIn-Intercept] Blocked http.request → opml.radiotime.com (serial throttle prevented)');
        return fakeRequest(callback);
    }
    return _origRequest(url, options, cb);
};

http.get = function patchedGet(url, options, cb) {
    const callback = typeof options === 'function' ? options : cb;
    if (isTuneIn(url)) {
        console.log('[Command] [TuneIn-Intercept] Blocked http.get → opml.radiotime.com (serial throttle prevented)');
        const req = fakeRequest(callback);
        req.end(); // http.get always auto-calls end()
        return req;
    }
    return _origGet(url, options, cb);
};

// ── Patch globalThis.fetch (Node.js 18+ built-in / undici) ──────────────────
// node-fetch v3 may use the native global fetch when running on Node.js 18+,
// bypassing http.request entirely.  Patch it here while we still have the
// earliest possible execution slot.
if (typeof globalThis.fetch === 'function') {
    const _origFetch = globalThis.fetch;
    globalThis.fetch = function patchedFetch(resource, options) {
        let hostname = '';
        try {
            const urlStr = typeof resource === 'string'
                ? resource
                : (resource && resource.url ? resource.url : String(resource));
            hostname = new URL(urlStr).hostname;
        } catch { /* ignore */ }
        if (hostname === BLOCKED_HOST) {
            console.log('[Command] [TuneIn-Intercept] Blocked global fetch → opml.radiotime.com (serial throttle prevented)');
            // Return a minimal Response-like object that satisfies node-fetch's
            // internal consumer (text(), json(), body checks).
            const body = FAKE_BODY.toString();
            const fakeResponse = {
                ok: true, status: 200, statusText: 'OK',
                url: typeof resource === 'string' ? resource : (resource.url || ''),
                headers: {
                    get: (name) => name.toLowerCase() === 'content-type' ? 'audio/x-mpegurl' : null,
                    has: (name) => name.toLowerCase() === 'content-type',
                    forEach: (fn) => fn('audio/x-mpegurl', 'content-type'),
                },
                redirected: false, type: 'basic',
                text:        async () => body,
                json:        async () => ({}),
                arrayBuffer: async () => Buffer.from(body).buffer,
                blob:        async () => new Blob([body]),
                clone:       function() { return this; },
                body: null,
            };
            return Promise.resolve(fakeResponse);
        }
        return _origFetch.apply(this, arguments);
    };
    process.stdout.write('[Command] [TuneIn-Intercept] globalThis.fetch patched\n');
}
