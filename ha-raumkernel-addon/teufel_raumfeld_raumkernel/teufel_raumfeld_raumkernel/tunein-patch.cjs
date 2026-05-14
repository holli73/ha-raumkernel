'use strict';
// Loaded via  node --require ./tunein-patch.cjs index.js
// Runs before ANY other module is evaluated, so our patched global.setTimeout,
// http.request, http.get and globalThis.fetch are captured by node-raumkernel
// at its own module-load time.
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// Problem 1 — UPnP subscription renewal burst at T+210 s
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// node-raumkernel subscribes to AVTransport + RenderingControl for every
// renderer it discovers.  The Raumfeld kernel typically grants a ~240 s
// subscription timeout.  upnp-device-client schedules each renewal at
// (grantedTimeout − 30) seconds, so without jitter all renewals fire
// simultaneously at T+210 s — a burst that can hit the kernel while it is
// also handling a TuneIn CDN session renewal.
//
// Fix A — jitter the renewal timers:
//   global.setTimeout is patched to add 0–15 s of random jitter for delays
//   in 120 000–300 000 ms (exclusive to UPnP renewal timers in node-raumkernel).
//   15 s keeps all renewals safely within the 240 s grant window
//   (210 s + 15 s = 225 s ≪ 240 s) while spreading the burst across
//   ~15 s — well within the kernel's capacity.
//
// Problem 2 — Startup stream drop when a live zone has stale durability
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// When node-raumkernel subscribes to virtual zone renderers, the Raumfeld
// kernel runs an internal zone health-check ~5 s after the first subscription.
// The check inspects AVTransportURIMetaData.durability for active zones.
// If durability is negative (the dlna-playsingle:// station reference has not
// been refreshed since the zone was last loaded, which can be hours ago),
// the kernel concludes the TuneIn session is expired and stops the stream.
//
// In the native app only scenario the kernel never performs this check because
// no UPnP subscriptions are active.  Adding even one physical speaker
// subscription per active zone acts as a "presence certificate" that satisfies
// the kernel's health-check and prevents the stop.
//
// Fix B — zone-aware physical subscription filter:
//   Physical speaker SUBSCRIBE requests are held pending while we wait for
//   RaumkernelHelper.js to parse the Zone Configuration and populate
//   global._raumfeldActivePhysicalUdns.  The global is polled every
//   PHYSICAL_POLL_INTERVAL_MS; once available (or after PHYSICAL_MAX_WAIT_MS
//   fail-open) the filter allows through physical renderers belonging to
//   ACTIVE zones and fakes a 24 h subscription for standby zones.
//   This keeps physical subscriptions only for the zones that actually need
//   the presence certificate (typically 2–4 active zones vs all 12+).
//
// Problem 3 — MediaListManager TuneIn relay fetches (secondary)
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// node-raumkernel's MediaListManager could fetch raw opml.radiotime.com relay
// URLs stored in renderer metadata, registering new TuneIn sessions against
// the shared serial and triggering CDN-token throttle.  The http/fetch patch
// below blocks those fetches.
//
// The kernel's own ebrowse session renewals are made from the kernel *binary*
// (a native process, not Node.js http), so neither patch affects them.

// ── Startup diagnostic ───────────────────────────────────────────────────────
process.stdout.write('[Command] [TuneIn-Intercept] CJS preloader active — patching http + fetch\n');

// ── UPnP subscription renewal jitter ─────────────────────────────────────────
const _origSetTimeout = global.setTimeout;
global.setTimeout = function jitteredSetTimeout(fn, delay, ...args) {
    // Intercept only the subscription-renewal-timer range: 120 s – 300 s.
    // upnp-device-client uses setTimeout(renew, renewTimeout * 1000) where
    // renewTimeout = max(grantedTimeout − 30, 30).  For a 240 s grant that
    // is 210 000 ms; for a 300 s grant it is 270 000 ms — both land here.
    // Nothing else in node-raumkernel uses a 2–5-minute timer.
    //
    // Jitter capped at 15 s to stay safely inside the grant window:
    //   210 s + 15 s = 225 s  ≪  240 s (grant expiry)
    if (typeof delay === 'number' && delay >= 120000 && delay <= 300000) {
        const jitter = Math.floor(Math.random() * 15000); // 0–15 s
        return _origSetTimeout(fn, delay + jitter, ...args);
    }
    return _origSetTimeout(fn, delay, ...args);
};
process.stdout.write('[Command] [SubRenewal-Jitter] setTimeout patched — subscription renewal burst prevention active\n');

const http = require('http');
const { EventEmitter } = require('events');

// ── Physical subscription polling constants ───────────────────────────────────
// RaumkernelHelper.js sets global._raumfeldActivePhysicalUdns once the Zone
// Configuration is parsed (typically ~200–1500 ms after process start).
// We poll every PHYSICAL_POLL_INTERVAL_MS until the global is defined.
// If it is still undefined after PHYSICAL_MAX_WAIT_MS we fail-open: the
// real SUBSCRIBE request is made without filtering (presence certificate for
// all zones, safe fallback).
const PHYSICAL_POLL_INTERVAL_MS = 100;
const PHYSICAL_MAX_WAIT_MS      = 3000;

// ── Constants ─────────────────────────────────────────────────────────────────
const BLOCKED_HOST = 'opml.radiotime.com';
const FAKE_BODY    = Buffer.from('#EXTM3U\n');

// ── Helper: extract host from http.request arguments ────────────────────────
function _reqHost(url, options) {
    if (typeof url === 'string') {
        try { return new URL(url).hostname; } catch { /* ignore */ }
    } else if (url instanceof URL) {
        return url.hostname;
    } else if (url && typeof url === 'object') {
        return (url.hostname || (url.host || '').split(':')[0]) || '';
    }
    if (options && typeof options === 'object') {
        return (options.hostname || (options.host || '').split(':')[0]) || '';
    }
    return '';
}

// ── Helper: extract path from http.request arguments ────────────────────────
function _reqPath(url, options) {
    if (typeof url === 'string') {
        try { return new URL(url).pathname; } catch { /* ignore */ }
    } else if (url instanceof URL) {
        return url.pathname;
    } else if (url && typeof url === 'object') {
        return url.path || url.pathname || '';
    }
    if (options && typeof options === 'object') {
        return options.path || options.pathname || '';
    }
    return '';
}

// ── Helper: extract method from http.request arguments ──────────────────────
function _reqMethod(url, options) {
    if (url && typeof url === 'object' && !(url instanceof URL)) {
        return (url.method || 'GET').toUpperCase();
    }
    if (options && typeof options === 'object') {
        return (options.method || 'GET').toUpperCase();
    }
    return 'GET';
}

// ── Helper: is this a physical (non-kernel) Raumfeld device? ─────────────────
function _isPhysicalDevice(host) {
    // Kernel IP is known dynamically via global._raumfeldKernelHost set by
    // RaumkernelHelper.js; fall back to the default subnet pattern.
    const kernelHost = global._raumfeldKernelHost || '192.168.243.1';
    return host !== kernelHost && /^192\.168\.243\.\d+$/.test(host);
}

// ── Helper: is this physical UDN in the active-zone allowlist? ───────────────
function _isActivePhysicalUdn(path) {
    const allowed = global._raumfeldActivePhysicalUdns;
    if (!allowed) return false;
    for (const udn of allowed) {
        if (path.includes(udn)) return true;
    }
    return false;
}

// ── Helper: check TuneIn relay host ─────────────────────────────────────────
function isTuneIn(urlOrOpts) {
    let host = '';
    if (typeof urlOrOpts === 'string') {
        try { host = new URL(urlOrOpts).hostname; } catch { /* ignore */ }
    } else if (urlOrOpts && typeof urlOrOpts === 'object') {
        host = (urlOrOpts.hostname || urlOrOpts.host || '').split(':')[0];
    }
    return host === BLOCKED_HOST;
}

// ── Fake 200 OK response for blocked TuneIn relay fetches ───────────────────
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

// ── Physical subscription proxy — polls until Zone Config is available ────────
// Returns a ClientRequest-like EventEmitter immediately; internally polls
// global._raumfeldActivePhysicalUdns every PHYSICAL_POLL_INTERVAL_MS until it
// is defined (set by RaumkernelHelper._updateSubscriptionFilter).
//   - ACTIVE zone renderer  → makes the real SUBSCRIBE request
//   - Standby zone renderer → returns a fake 24 h SID (no actual subscription)
//   - Zone Config timeout   → fail-open, makes the real request for all devices
//
const _origRequest = http.request.bind(http);

function physicalSubscribeProxy(url, options, cb) {
    const callback = typeof options === 'function' ? options : cb;
    const fakeReq  = new EventEmitter();
    let _ended     = false;
    let _destroyed = false;
    let _timeout   = null;
    let _realReq   = null;

    fakeReq.end = () => {
        _ended = true;
        if (_realReq) _realReq.end();
        return fakeReq;
    };
    fakeReq.write        = () => fakeReq;
    fakeReq.destroy      = () => { _destroyed = true; if (_realReq) _realReq.destroy(); };
    fakeReq.abort        = () => { _destroyed = true; if (_realReq && _realReq.abort) _realReq.abort(); };
    fakeReq.setTimeout   = (t, fn) => {
        _timeout = { t, fn };
        if (_realReq) _realReq.setTimeout(t, fn);
        return fakeReq;
    };
    fakeReq.setHeader    = () => {};
    fakeReq.removeHeader = () => {};
    fakeReq.flushHeaders = () => {};
    fakeReq.socket       = null;
    fakeReq.headersSent  = false;

    const host     = _reqHost(url, options);
    const path     = _reqPath(url, options);
    const pollStart = Date.now();

    function decide() {
        if (_destroyed) return;

        const allowed = global._raumfeldActivePhysicalUdns;

        if (allowed === undefined) {
            if (Date.now() - pollStart < PHYSICAL_MAX_WAIT_MS) {
                _origSetTimeout(decide, PHYSICAL_POLL_INTERVAL_MS);
                return;
            }
            // Zone Config did not arrive in time — fail-open
            process.stdout.write(
                `[Command] [ActivePhysicalSub] Zone Config timeout — allowing SUBSCRIBE → ${host} (fail-open)\n`
            );
            makeReal();
            return;
        }

        if (_isActivePhysicalUdn(path)) {
            process.stdout.write(
                `[Command] [ActivePhysicalSub] Allowed SUBSCRIBE → ${host} (active-zone physical renderer)\n`
            );
            makeReal();
        } else {
            process.stdout.write(
                `[Command] [NoPhysicalSub] Suppressed SUBSCRIBE → physical device ${host} (standby zone)\n`
            );
            const fakeSid = `uuid:standby-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const fakeRes = new EventEmitter();
            fakeRes.statusCode    = 200;
            fakeRes.statusMessage = 'OK';
            fakeRes.headers       = { sid: fakeSid, timeout: 'Second-86400' };
            fakeRes.destroy       = () => {};
            fakeRes.resume        = () => {};
            if (callback) callback(fakeRes);
            else fakeReq.emit('response', fakeRes);
            setImmediate(() => fakeRes.emit('end'));
        }
    }

    function makeReal() {
        _realReq = _origRequest(url, options, cb);
        if (_timeout) _realReq.setTimeout(_timeout.t, _timeout.fn);
        if (!callback) {
            _realReq.on('response', (res) => fakeReq.emit('response', res));
        }
        _realReq.on('error',  (err) => fakeReq.emit('error', err));
        _realReq.on('socket', (s)   => { fakeReq.socket = s; fakeReq.emit('socket', s); });
        if (_ended) _realReq.end();
    }

    // Start the first poll on the next tick so the caller can attach .end() first
    _origSetTimeout(decide, PHYSICAL_POLL_INTERVAL_MS);

    return fakeReq;
}

// ── Patch http.request ───────────────────────────────────────────────────────
const _origGet = http.get.bind(http);

http.request = function patchedRequest(url, options, cb) {
    const callback = typeof options === 'function' ? options : cb;

    // Block TuneIn relay fetches from Node.js code (MediaListManager guard).
    if (isTuneIn(url)) {
        console.log('[Command] [TuneIn-Intercept] Blocked http.request → opml.radiotime.com');
        return fakeRequest(callback);
    }

    if (_reqMethod(url, options) === 'SUBSCRIBE' && _isPhysicalDevice(_reqHost(url, options))) {
        return physicalSubscribeProxy(url, options, cb);
    }

    return _origRequest(url, options, cb);
};

// ── Patch http.get ───────────────────────────────────────────────────────────
http.get = function patchedGet(url, options, cb) {
    const callback = typeof options === 'function' ? options : cb;
    if (isTuneIn(url)) {
        console.log('[Command] [TuneIn-Intercept] Blocked http.get → opml.radiotime.com');
        const req = fakeRequest(callback);
        req.end();
        return req;
    }
    return _origGet(url, options, cb);
};

// ── Patch globalThis.fetch (Node.js 18+ built-in / undici) ──────────────────
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
            console.log('[Command] [TuneIn-Intercept] Blocked global fetch → opml.radiotime.com');
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

process.stdout.write('[Command] [ActivePhysicalSub] Physical subscription filter active — polling for Zone Config\n');
