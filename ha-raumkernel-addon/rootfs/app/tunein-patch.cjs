'use strict';
// Loaded via  node --require ./tunein-patch.cjs index.js
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
//
// Problem 2 — Startup stream drop: kernel zone health-check with stale durability
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// When node-raumkernel subscribes to virtual zone renderers the Raumfeld kernel
// runs an internal zone health-check ~5 s after the first subscription.  If
// AVTransportURIMetaData.durability is negative (the ContentDirectory reference
// for the zone was not refreshed since the stream was started hours ago), the
// kernel stops the stream.
//
// Fix B — zone-aware physical subscription filter:
//   Physical speaker SUBSCRIBE requests are held pending while we wait for
//   RaumkernelHelper.js to parse the Zone Configuration and populate
//   global._raumfeldActivePhysicalHosts (a Set of IP strings).
//   Polling fires every PHYSICAL_POLL_INTERVAL_MS; once the global is set
//   (or PHYSICAL_MAX_WAIT_MS expires → fail-open) physical renderers whose
//   IP is in the active-host set get a real subscription ("presence certificate"
//   that satisfies the health-check); standby renderers receive a fake 24 h SID.
//
//   NOTE: physical device event endpoints use paths like /AVTransport/event
//   and do NOT embed the renderer UDN in the path.  Filtering MUST be done
//   on the HOST (IP address), not on the URL path.
//
// Problem 3 — TuneIn ebrowse contention from ContentDirectory NOTIFYs (P2)
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// The MediaListManager subscribes to the Raumfeld MediaServer's ContentDirectory
// service.  The kernel sends NOTIFY batches every ~60 s which trigger internal
// processing inside the kernel (refreshing zone-state metadata, potentially
// including ebrowse-adjacent calls).  This processing competes with the kernel's
// own ebrowse session-renewal timer, causing renewals to be delayed or rejected
// by TuneIn (throttle), which eventually stops the stream (P2, observed at T+355s).
//
// We already disabled MediaListManager.loadMediaItemListsByContainerUpdateIds to
// prevent Browse calls from our side.  But the kernel still processes each NOTIFY
// it sends us, generating unnecessary internal churn.
//
// Fix C — suppress ContentDirectory subscriptions via polling proxy:
//   ALL non-physical kernel SUBSCRIBE requests are held in kernelSubscribeProxy
//   until global._raumfeldMediaServerPorts is populated by RaumkernelHelper.js
//   (systemReady handler, fired ~30–200 ms after startup).  This closes the
//   startup race where the ContentDirectory SUBSCRIBE fires BEFORE systemReady
//   sets _raumfeldMediaServerPorts, which caused the initial subscription to
//   slip through in earlier versions.
//
//   Once the port set is known:
//     • port matches MediaServer OR path matches /contentdirectory|\/cd\// →
//         return a fake 24 h SID (suppress the ContentDirectory subscription)
//     • other port (virtual renderer AVTransport / RC) → allow real SUBSCRIBE
//     • timeout after 5 s → fail-open (real SUBSCRIBE allowed through)
//
//   The MediaServer's ContentDirectory eventSubURL on current Raumfeld firmware
//   uses the path '/cd/Event' (not '/ContentDirectory/event'), so the path
//   pattern was updated accordingly.
//
// Problem 4 — MediaListManager TuneIn relay fetches
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
// node-raumkernel's MediaListManager could fetch opml.radiotime.com relay URLs
// stored in renderer metadata, consuming TuneIn serial slots.  http/fetch patch
// blocks those fetches.

process.stdout.write('[Command] [TuneIn-Intercept] CJS preloader active — patching http + fetch\n');

// ── UPnP subscription renewal jitter ─────────────────────────────────────────
const _origSetTimeout = global.setTimeout;
global.setTimeout = function jitteredSetTimeout(fn, delay, ...args) {
    // Intercept only the subscription-renewal-timer range: 120 s – 300 s.
    // Jitter capped at 15 s:  210 s + 15 s = 225 s  ≪  240 s (grant expiry)
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
// RaumkernelHelper.js sets global._raumfeldActivePhysicalHosts (Set of IP
// strings) once the Zone Configuration is parsed.  We poll every
// PHYSICAL_POLL_INTERVAL_MS until the global is defined, then filter.
// null = fail-open (couldn't determine IPs; allow all physical subscriptions).
const PHYSICAL_POLL_INTERVAL_MS = 100;
const PHYSICAL_MAX_WAIT_MS      = 3000;

// ── Kernel subscription polling constants ─────────────────────────────────────
// RaumkernelHelper.js sets global._raumfeldMediaServerPorts (Set<string>) in
// the systemReady handler.  ALL non-physical kernel SUBSCRIBE calls are held
// in kernelSubscribeProxy until this global is populated (or KERNEL_MAX_WAIT_MS
// elapses → fail-open), then the port/path check decides suppress vs allow.
// This closes the startup race where the ContentDirectory SUBSCRIBE fires
// BEFORE systemReady sets _raumfeldMediaServerPorts, causing the initial
// subscription to slip through undetected.
const KERNEL_POLL_INTERVAL_MS = 50;
const KERNEL_MAX_WAIT_MS      = 5000;

// ── Constants ─────────────────────────────────────────────────────────────────
const BLOCKED_HOST = 'opml.radiotime.com';
const FAKE_BODY    = Buffer.from('#EXTM3U\n');

// ── Helper: extract host / port / path / method from http.request arguments ──
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

function _reqMethod(url, options) {
    if (url && typeof url === 'object' && !(url instanceof URL)) {
        return (url.method || 'GET').toUpperCase();
    }
    if (options && typeof options === 'object') {
        return (options.method || 'GET').toUpperCase();
    }
    return 'GET';
}

// ── Helper: extract port from http.request arguments ─────────────────────────
function _reqPort(url, options) {
    if (typeof url === 'string') {
        try { return new URL(url).port || '80'; } catch { /* ignore */ }
    } else if (url instanceof URL) {
        return url.port || '80';
    } else if (url && typeof url === 'object') {
        return String(url.port || '80');
    }
    if (options && typeof options === 'object') {
        return String(options.port || '80');
    }
    return '80';
}

// ── Helper: is this a physical (non-kernel) Raumfeld device? ─────────────────
function _isPhysicalDevice(host) {
    const kernelHost = global._raumfeldKernelHost || '192.168.243.1';
    return host !== kernelHost && /^192\.168\.243\.\d+$/.test(host);
}

// ── Helper: is this IP in the active-zone physical host allowlist? ────────────
// _raumfeldActivePhysicalHosts:
//   undefined  → not yet set (zone config not parsed)
//   null       → fail-open  (IPs could not be determined; allow all)
//   Set<string>→ only allow IPs in the set
function _isActivePhysicalHost(host) {
    const allowed = global._raumfeldActivePhysicalHosts;
    if (allowed === null)      return true;  // fail-open
    if (allowed === undefined) return false; // not ready yet
    return allowed.has(host);
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

// ── Fake 200 OK SUBSCRIBE response (no actual subscription) ──────────────────
function fakeSubscribeOk(callback, label) {
    const fakeSid = `uuid:suppressed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
        fakeRes.headers       = { sid: fakeSid, timeout: 'Second-86400' };
        fakeRes.destroy       = () => {};
        fakeRes.resume        = () => {};
        if (callback) callback(fakeRes);
        else fakeReq.emit('response', fakeRes);
        setImmediate(() => fakeRes.emit('end'));
    });
    return fakeReq;
}

// ── Physical subscription proxy — polls until Zone Config is available ────────
// Returns a ClientRequest-like EventEmitter immediately; polls
// global._raumfeldActivePhysicalHosts every PHYSICAL_POLL_INTERVAL_MS.
//   IP in active-host set → real SUBSCRIBE to the physical device
//   IP not in set         → fake 24 h SID (no actual subscription)
//   null (fail-open)      → real SUBSCRIBE (couldn't determine active IPs)
//   timeout (>3 s)        → fail-open, real SUBSCRIBE
const _origRequest = http.request.bind(http);

// ── Request a longer UPnP subscription timeout ───────────────────────────────
// node-raumkernel's default request is ~240 s (grant) / 210 s (renewal timer).
// Renewal bursts every 4 min can disrupt active streams by overwhelming the
// kernel during device-list changes.  Requesting 1800 s makes the kernel grant
// longer subscriptions → fewer renewal bursts per hour.
// We clone the options object to avoid mutating the caller's copy.
function _extendSubscribeTimeout(url, options) {
    const LONG_TIMEOUT = 'Second-1800';
    if (options && typeof options === 'object') {
        const newOpts = Object.assign({}, options);
        newOpts.headers = Object.assign({}, options.headers || {}, { timeout: LONG_TIMEOUT });
        return { urlArg: url, optsArg: newOpts };
    }
    if (url && typeof url === 'object' && !(url instanceof URL)) {
        const newUrl = Object.assign({}, url);
        newUrl.headers = Object.assign({}, url.headers || {}, { timeout: LONG_TIMEOUT });
        return { urlArg: newUrl, optsArg: options };
    }
    return { urlArg: url, optsArg: options };
}

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

    const host      = _reqHost(url, options);
    const pollStart = Date.now();

    function decide() {
        if (_destroyed) return;

        const allowed = global._raumfeldActivePhysicalHosts;

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

        // null = IP lookup failed in RaumkernelHelper → fail-open
        if (allowed === null || allowed.has(host)) {
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
        const { urlArg, optsArg } = _extendSubscribeTimeout(url, options);
        _realReq = _origRequest(urlArg, optsArg, cb);
        if (_timeout) _realReq.setTimeout(_timeout.t, _timeout.fn);
        if (!callback) {
            _realReq.on('response', (res) => fakeReq.emit('response', res));
        }
        _realReq.on('error',  (err) => fakeReq.emit('error', err));
        _realReq.on('socket', (s)   => { fakeReq.socket = s; fakeReq.emit('socket', s); });
        if (_ended) _realReq.end();
    }

    _origSetTimeout(decide, PHYSICAL_POLL_INTERVAL_MS);
    return fakeReq;
}

// ── Kernel (non-physical) subscription proxy ──────────────────────────────────
// Holds ALL non-physical kernel SUBSCRIBE calls until global._raumfeldMediaServerPorts
// is populated by RaumkernelHelper.js (systemReady handler).  Once known:
//   • Port matches MediaServer OR path matches /contentdirectory|\/cd\// →
//       return a fake 24 h SID (suppress the ContentDirectory subscription)
//   • Otherwise →  allow through (virtual renderer AVTransport / RC subs)
// Timeout after KERNEL_MAX_WAIT_MS → fail-open (real SUBSCRIBE).
function kernelSubscribeProxy(url, options, cb) {
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

    const port      = _reqPort(url, options);
    const path      = _reqPath(url, options);
    const host      = _reqHost(url, options);
    const pollStart = Date.now();

    function decide() {
        if (_destroyed) return;

        const mediaPorts = global._raumfeldMediaServerPorts;

        if (mediaPorts === undefined) {
            if (Date.now() - pollStart < KERNEL_MAX_WAIT_MS) {
                _origSetTimeout(decide, KERNEL_POLL_INTERVAL_MS);
                return;
            }
            // systemReady did not fire in time — fail-open
            process.stdout.write(
                `[Command] [KernelSub] Zone Config timeout — allowing SUBSCRIBE → ` +
                `host=${host} port=${port} path=${path} (fail-open)\n`
            );
            makeReal();
            return;
        }

        const portMatch = mediaPorts instanceof Set && mediaPorts.has(port);
        const pathMatch = /contentdirectory|\/cd\//i.test(path);

        process.stdout.write(
            `[Command] [KernelSub] SUBSCRIBE → kernel host=${host} port=${port} path=${path}` +
            ` portMatch=${portMatch} pathMatch=${pathMatch}\n`
        );

        if (portMatch || pathMatch) {
            process.stdout.write(
                `[Command] [ContentDirSub] Suppressed ContentDirectory SUBSCRIBE → kernel` +
                ` port=${port} path=${path} (portMatch=${portMatch} pathMatch=${pathMatch})\n`
            );
            const fakeSid = `uuid:cds-suppress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const fakeRes = new EventEmitter();
            fakeRes.statusCode    = 200;
            fakeRes.statusMessage = 'OK';
            fakeRes.headers       = { sid: fakeSid, timeout: 'Second-86400' };
            fakeRes.destroy       = () => {};
            fakeRes.resume        = () => {};
            if (callback) callback(fakeRes);
            else fakeReq.emit('response', fakeRes);
            setImmediate(() => fakeRes.emit('end'));
        } else {
            makeReal();
        }
    }

    function makeReal() {
        const { urlArg, optsArg } = _extendSubscribeTimeout(url, options);
        _realReq = _origRequest(urlArg, optsArg, cb);
        if (_timeout) _realReq.setTimeout(_timeout.t, _timeout.fn);
        if (!callback) {
            _realReq.on('response', (res) => fakeReq.emit('response', res));
        }
        _realReq.on('error',  (err) => fakeReq.emit('error', err));
        _realReq.on('socket', (s)   => { fakeReq.socket = s; fakeReq.emit('socket', s); });
        if (_ended) _realReq.end();
    }

    _origSetTimeout(decide, KERNEL_POLL_INTERVAL_MS);
    return fakeReq;
}

// ── Patch http.request ───────────────────────────────────────────────────────
const _origGet = http.get.bind(http);

http.request = function patchedRequest(url, options, cb) {
    const callback = typeof options === 'function' ? options : cb;

    // Block TuneIn relay fetches from Node.js code.
    if (isTuneIn(url)) {
        console.log('[Command] [TuneIn-Intercept] Blocked http.request → opml.radiotime.com');
        return fakeRequest(callback);
    }

    if (_reqMethod(url, options) === 'SUBSCRIBE') {
        const host = _reqHost(url, options);

        // All non-physical (kernel) SUBSCRIBE requests go through kernelSubscribeProxy,
        // which polls until _raumfeldMediaServerPorts is set and then decides:
        //   MediaServer port or /cd/ path → suppress (ContentDirectory)
        //   all other ports               → allow (virtual renderer AVTransport/RC)
        if (!_isPhysicalDevice(host)) {
            return kernelSubscribeProxy(url, options, cb);
        }

        // Zone-aware physical subscription filter (presence certificate).
        // Physical device event endpoints use paths like /AVTransport/event and
        // do NOT embed the renderer UDN.  Filtering must be on the HOST (IP).
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
