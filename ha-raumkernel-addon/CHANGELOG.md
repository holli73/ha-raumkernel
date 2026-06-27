## 1.3.31

- Fix (`TypeError: data.log.includes is not a function`): the logger suppression
  added for capability detection did not guard against non-string log values.
  Added `typeof data.log === 'string'` check before calling `.includes()`.

## 1.3.30

- Add Eco mode button per room (puts device into automatic standby).
- Add Power status sensor per room (Off / On / ECO mode).
- Add Input sensor per room (current source: Streaming, Line-in, Optical, TV, Spotify, Radio).
- Add source switching for Soundbars/Sounddecks (TV ARC, Optical, Line-in, Streaming via Select Source).
- Add Line-in switching for devices without Source Select but with a physical Line-in port.
- Track and broadcast current "Source Select" value with periodic refresh (picks up external changes like TV auto-switching to ARC).
- Fix: remove duplicate startup log line.
- Fix: add `BatchMode=yes` and `ConnectTimeout=5` to SSH reboot command.

Credits to contributor Simanias (upstream ulilicht#56)

## 1.3.29

- Fix: Rooms still joined each other's zone when **resuming** a stopped stream
  via `play()` (e.g. Bad joining Kueche after the user stopped both and then
  resumed Kueche first).

  Root cause: `play()` had a second hidden zone-join path — the
  `STOPPED→zone-join` branch — that called `connectRoomToZone()` whenever the
  room's `play()` was called while another room was actively playing the same
  station (same TuneIn `stationId`).  This was missed by the v1.3.28 fix which
  only removed the zone-join from `loadSingle()`.

  The debug log showed the exact trigger:
  ```
  play() live stream (STOPPED→zone-join) for Bad → Kueche
    (station s8007, zone uuid:4F944EBA-...)
  ```
  This happened ~30 s after Kueche resumed independently, confirming the
  zone-join was fired from `play()`, not `loadSingle()`.

  Fix: removed the `STOPPED→zone-join` loop from `play()`.  Each room now
  resumes by calling its own `renderer.play()` independently, exactly as the
  native Raumfeld app does.

## 1.3.28

- Fix: Playing the same radio station on multiple rooms simultaneously (e.g.
  Kueche + KellerStueberl + Bad all playing Ö3) could fail, cause unexpected
  restarts, or trigger TuneIn throttling.

  Root cause: `loadSingle()` contained two zone-grouping blocks that called
  `connectRoomToZone()` whenever another room was already streaming the same
  station.  This "join the existing zone" shortcut disrupted the running zone,
  sometimes stopped playback on the already-playing room, and caused extra
  TuneIn session registrations in rapid succession — hitting the shared serial
  throttle.

  Analysis via mitmproxy capture of the native Raumfeld iOS app (playing Ö3
  on Kueche, KellerStueberl, and Bad simultaneously):
  • The native app **never** calls `connectRoomToZone`.
  • Each room keeps its own independent virtual renderer on the Expand host.
  • Each room receives its own `SetAVTransportURI` with a `dlna-playsingle://`
    URI pointing to the station's ContentDirectory item.
  • No TuneIn throttle is hit; no zone disruption occurs.

  Fix: removed both zone-grouping blocks from `loadSingle()` (physical-renderer
  fast-path and virtual-renderer path).  Every room now always falls through to
  its own independent `renderer.loadSingle(itemId)` call, matching native app
  behaviour exactly.

## 1.3.27

- Fix: Bad room (and any room in AUTOMATIC_STANDBY) plays for ~30 s then
  stops when "PLAY" is pressed in HA after the device has been idle for a
  long time:

  When a room's physical speaker enters AUTOMATIC_STANDBY (no audio for
  several minutes), the existing `dlna-playsingle://` TuneIn session
  registered with the kernel becomes stale.  The previous code called bare
  UPnP `Play()` to resume, which told the kernel to re-use the old session.
  TuneIn rejected the expired session → the kernel went TRANSITIONING for
  ~30 s then gave up and went STOPPED — no audio, no error shown in HA.

  Fix: before issuing bare `Play()` for a live stream in STOPPED state, the
  code now checks the room's `powerState` in the Raumfeld zone configuration.
  If the room is in any `*_STANDBY` state (device powered down), it routes
  through `loadSingle()` instead.  `loadSingle` creates a fresh TuneIn
  session and re-establishes playback reliably.

  Three code paths are covered:
  1. `play()` `STOPPED→native` path (dlna-playsingle:// URI already loaded)
  2. `loadSingle()` "already-loaded (STOPPED)" shortcut (skipped in standby)
  3. `play()` final fallback (bare Play for unknown/stale rendererState)

## 1.3.26

- Fix: Kueche (and any TuneIn room) stops for 1–3 minutes after a long
  stable session, even though the stream was healthy:

  TuneIn routinely refreshes its CDN stream URL every 5–15 minutes
  server-side. When this happens the stream drops and the auto-restart
  fires. The rate-limiter was counting EVERY restart equally, so after a
  few normal TuneIn URL refreshes (each > 5 min apart!) the back-off
  escalated to 1 min, then 3 min, then 15 min — even though the room had
  been playing without issue.

  Fix: sessions lasting >= 300 s (5 minutes) are treated as healthy TuneIn
  URL refreshes. They always restart immediately (base 500 ms delay) and
  are NOT added to the rate-limit history. Only short sessions (< 300 s)
  count as instability and accumulate rate-limit credits. The rate-limit
  thresholds are otherwise unchanged:
    3–4 short restarts / 60 min →  60 s back-off
    5–7 short restarts / 60 min →   3 min back-off
    8 + short restarts / 60 min →  15 min back-off

- Fix: Bad room cannot start — PLAY/favourite/power button all fail with
  "Please turn on a device." in HA; only the native Raumfeld app can wake
  it:

  The `_wakeRenderer` function detected standby by reading
  `physicalDevice.rendererState.PowerState`. Speaker Bad #2 does not
  report PowerState via its own UPnP subscription — PowerState is only
  visible on the virtual zone renderer ("Bad") and in the zone
  configuration. So `_wakeRenderer` saw `undefined`, skipped the wake,
  and immediately called `renderer.play()` while the physical speaker was
  still asleep.

  Fix: added a zone-config fallback in `_wakeRenderer`. When a physical
  device's own `rendererState.PowerState` is missing, the function now
  looks up the room that owns that physical renderer in the zone config
  (by matching UDN) and reads the room's `powerState` attribute. Both the
  initial standby-detection and the active-polling loop use this fallback,
  so `leaveStandby()` is called correctly and the poll waits until the
  device is genuinely ACTIVE before proceeding.

## 1.3.25

- Fix regression from 1.3.24 (Kueche plays only a few seconds, PLAY button not
  changing to STOP, loading favourite has no effect):

  **Regression 1 — zone-join timing changed for virtual renderers:**
  In 1.3.24 the zone-join check was moved before `_wakeRenderer` for ALL
  renderer types. For virtual renderers this changed when the check runs:
  previously it ran after the standby-wake wait (~15 s), so a room that came
  online during that wait would be caught and Kueche would join its zone instead
  of calling `renderer.loadSingle()` (which interrupts the playing stream).
  With the early timing, the check ran at t=0 when that room wasn't yet online,
  zone-join missed, `renderer.loadSingle()` fired, and interrupted Kueche.
  Fix: the physical-renderer fast-path zone-join (new in 1.3.24) now applies
  ONLY when `!renderer?.loadSingle` (physical renderer, no virtual zone). For
  virtual renderers the zone-join is restored to its original position — inside
  `if (renderer?.loadSingle)` AFTER `_wakeRenderer`. Also added `_wakeRenderer`
  before zone-join in the physical-renderer fast-path so a standby speaker is
  woken before joining the zone.

  **Regression 2 — 2-second dedup blocked user retries:**
  The 2-second short-window dedup added in 1.3.24 blocked favourite-load retries
  within 2 s even when the room was STOPPED (not just TRANSITIONING). Users
  tapping the favourite a second time within 1–2 s got silently ignored.
  Fix: reduced the unconditional short window from 2000 ms to 500 ms — still
  long enough to catch duplicate HA play commands arriving 100–200 ms apart,
  but short enough to allow user retries at ≥ 1 s.

## 1.3.24

- Fix (Bad room silent alarm — play fails with 701 / 16-second delay):

  **Root cause 1 — physical renderer fallback in play():**
  After a room leaves a multi-room zone (e.g. user stops Bad from a shared zone),
  the Raumfeld kernel may not register a new solo zone immediately.
  `_getRendererForRoom` fell through to Strategy 5 — the raw physical renderer —
  which has no subscription state (`TransportState = undefined`).
  All state-based guards in `play()` (`isNoMedia`, live-stream STOPPED path)
  silently missed because they test against `undefined`. The code fell through to
  bare `renderer.play()` → UPnP error 701 (no AV queue on the physical device).
  Fix: added a physical-renderer guard in `play()`. When only a physical renderer
  is available and `room._lastItemId` is set, route immediately to `loadSingle()`
  instead of attempting `renderer.play()`.

  **Root cause 2 — 6-second delay inside loadSingle():**
  The 701-catch handler called `loadSingle()`, which called `_ensureVirtualRenderer`
  (up to 7.5 s polling loop) BEFORE checking if zone-join to a still-playing room
  was possible. Since Kueche was already PLAYING the same station, zone-join
  should have fired immediately. Instead it waited for a new solo zone to be created.
  Fix: moved stationId derivation and the zone-join check to BEFORE the
  `_ensureVirtualRenderer` call in `loadSingle()`. If another room is playing the
  same station, `connectRoomToZone()` fires right away (no virtual renderer needed).
  Total delay reduced from ~16 s to ~2 s.

  **Root cause 3 — concurrent zone-joins from duplicate HA commands:**
  HA sends duplicate `play` commands ~110 ms apart. Both triggered `loadSingle`,
  both attempted `connectRoomToZone` simultaneously → the room went
  TRANSITIONING → STOPPED before finally reaching PLAYING.
  Fix: added a 2-second short-window dedup in `loadSingle()`. Duplicate calls
  with the same item ID within 2 s are silently dropped regardless of play state.

## 1.3.23

- Fix (morning playback failure after physical speaker standby — Bad / Kueche scenario):

  **Root cause 1 — zone lost while playing (Bad):**
  When a virtual-zone renderer goes offline (ECONNREFUSED / device standby) while
  a room is actively streaming, the normal PLAYING→STOPPED auto-restart never fires
  because the UPnP subscription itself disappears before a state-change NOTIFY arrives.
  The zone stays dead overnight; the morning play command has to do a cold loadSingle
  (including a 6–7 s _ensureVirtualRenderer poll) before audio starts.
  Fix: `_handleZoneStateChange` now snapshots zone assignments before each update.
  If a room had a zone that is absent after the update, and the room was playing,
  a `loadSingle` recovery is scheduled (10 s delay to let the kernel stabilise).
  Bad now self-heals within seconds of the ECONNREFUSED — by morning the zone is
  warm and the user's play command resumes instantly.

  **Root cause 2 — TuneIn ebrowse throttle (Kueche):**
  Rapid CDN stream drops trigger rapid auto-restarts. Each restart causes the
  Raumkernel to call TuneIn's ebrowse API to open a new CDN session. With 15
  restarts in 2 hours TuneIn's per-device quota is exhausted; subsequent ebrowse
  calls return throttled / short-lived CDN URLs → even shorter sessions → more
  restarts → spiral. By 10:28 the quota was still exhausted; native-app play
  received "stream could not be loaded".
  Fix: a rolling 60-minute restart-rate limiter is applied before each auto-restart:
    - 3–4 restarts / 60 min → 60 s back-off
    - 5–7 restarts / 60 min →  3 min back-off
    - 8 + restarts / 60 min → 15 min back-off
  The throttle note is logged (e.g. "auto-restart in 3min [rate-limited: 5 restarts/60min]").

  **Root cause 3 — zone reset to NO_MEDIA_PRESENT (defensive fix):**
  When a physical device reboots, the Raumkernel can reset its zone's
  AVTransportURI to empty and send a NOTIFY with TransportState=NO_MEDIA_PRESENT.
  If the room was STOPPED (not PLAYING) at the time, the existing PLAYING→STOPPED
  auto-restart guard doesn't fire. The zone is now broken: "stream could not be
  loaded" on the next play attempt from any client.
  Fix: a new STOPPED→NO_MEDIA_PRESENT transition detector schedules `loadSingle`
  3 s later to restore the zone to "stopped but ready" state. If the room was
  user-stopped, playback is aborted at TRANSITIONING (SetAVTransportURI already
  applied, no audio) so the station is ready but silent.

## 1.3.22

- Fix (701 exception thrown when play is called on a room with no loaded station):
  The NO_MEDIA_PRESENT guard only matched TransportState === 'NO_MEDIA_PRESENT'.
  But after a zone dissolution, long idle, or cold start the physical speaker
  reports TransportState === 'STOPPED' with an empty AVTransportURI — which also
  cannot play and would produce a 701.  The guard missed this case, fell through
  to renderer.play(), and the 701 was rethrown as an unhandled exception.

  Fix 1: Broaden the guard to also catch STOPPED-with-no-URI
  (isNoMedia = NO_MEDIA_PRESENT || (STOPPED && !AVTransportURI)).

  Fix 2: When the guard fires but no last-known item ID can be derived (fresh
  install, room never played via this integration), return gracefully with a
  WARN log instead of rethrowing a 701 exception.  The same graceful return
  is applied in the 701 catch block.  Presence automations that call
  media_play on a room with no loaded station no longer produce HA errors;
  the addon log shows "no last-known station — use play_media to load a
  station first."

## 1.3.21

- Fix (play fails when device is in standby — wake-up not awaited):
  _wakeRenderer() called leaveStandby() and returned immediately without
  waiting for the device to actually become ready.  The subsequent play/
  loadSingle command arrived while the speaker was still booting → ECONNRESET
  or 701 "Action Play is currently not allowed".
  Fix: after calling leaveStandby(), poll the physical renderer's PowerState
  every 500 ms until it transitions out of STANDBY (or 15 s timeout).  This
  also gives subscription NOTIFY events time to arrive while the device wakes,
  so _extractNowPlaying can populate _lastItemId and _isLiveStream before
  the play/loadSingle command is sent — recovering without stored state on
  devices that retain their last-played metadata across standby cycles.

## 1.3.20

- Fix (701 error on fresh install / room that has never played since upgrade):
  The NO_MEDIA_PRESENT guard and the 701 catch in play() were both gated on
  room._isLiveStream === true.  After a fresh addon restart, rooms that have no
  persisted state (e.g. Bad, whose last play was via zone-join in an older
  pre-persistence session) have _isLiveStream = undefined, so both guards are
  bypassed and renderer.play() fires on the physical speaker in NO_MEDIA_PRESENT
  state → 701 exception thrown.

  Fix 1: Remove room._isLiveStream === true from both guards.  The inner
  if (derivedId) check is sufficient — if there is no usable item ID the code
  falls through and rethrows, same as before.

  Fix 2: Persist _lastStationId alongside _lastItemId and _isLiveStream in
  /data/room-state.json.  When _lastItemId is unavailable but _lastStationId is
  known, a RadioTime path (0/RadioTime/Search/s-s{id}) is constructed as a
  fallback item ID for loadSingle recovery.  This covers rooms whose last play
  was via zone-join (where _lastItemId may not have been set) but whose station
  ID was captured in _extractNowPlaying.  The zone-join path in loadSingle now
  also sets room._lastStationId so it is persisted immediately.

## 1.3.19

- Fix (701 "Action Play is currently not allowed" on fresh addon restart):
  After an addon restart all in-memory room flags (_isLiveStream, _lastItemId)
  are cleared.  Every guard in play() that handles NO_MEDIA_PRESENT / 701 is
  gated on room._isLiveStream === true, so they are all bypassed on a cold
  start.  renderer.play() then fires directly against the physical speaker
  which is in NO_MEDIA_PRESENT state → 701.
  Fix: persist _lastItemId and _isLiveStream to /data/room-state.json whenever
  they are set (loadSingle, zone-join, CDN shortcut, and _extractNowPlaying
  when a live stream is confirmed).  On startup the values are restored for
  each room as it is registered so play() can recover via the existing
  NO_MEDIA_PRESENT→loadSingle guard without needing a prior playing session.
  The persist is skipped when the stored values have not changed to avoid
  unnecessary disk writes on every renderer state update.

## 1.3.18

- Fix (701 error when playing Bad after Kueche was dropped from shared zone):
  play() calls _dropUserStoppedZoneMembers() which may drop a zone member and
  trigger a zone reconfiguration in the Raumfeld kernel.  The `renderer`
  reference captured at the start of play() is now stale: the old zone renderer
  may have been dissolved or rebuilt.  Continuing with the stale renderer causes
  it to forward the Play UPnP action to the physical speaker directly, which
  is in NO_MEDIA_PRESENT state → 701 "Action Play is currently not allowed".
  Fix: _dropUserStoppedZoneMembers() now returns a boolean indicating whether
  any member was actually dropped.  When true and the room is a live stream,
  play() waits 500 ms for the kernel to settle, then routes through loadSingle()
  instead of continuing with the stale renderer.  loadSingle() calls
  _ensureVirtualRenderer() which creates a fresh zone renderer and loads the
  station cleanly.

## 1.3.17

- Fix (stopped room restarts uninvited when a zone-mate presses Play):
  When stop() is called for a room in a multi-room zone and node-raumkernel
  has already marked the other zone member as "inactive", getRoomCountForZone
  returns 1, so stop() falls through to zone.stop() instead of
  dropRoomFromZone.  Both rooms remain in the stopped zone.  When the other
  room later presses Play, the zone renderer starts and restarts ALL zone
  members — including the one the user explicitly stopped.
  Fix: play() now calls _dropUserStoppedZoneMembers() at the very beginning.
  It inspects all other members of the current zone and drops any that have
  _userStopped = true before allowing the zone renderer to start.  This
  ensures the user's stop decision is always respected, regardless of how
  the zone was originally stopped.


- Fix (room joins multi-room zone but plays silence):
  When Bad started playing and our zone-join logic connected Kueche to
  Bad's zone (same station), Kueche would show as playing but produce no
  audio.  Root cause: the zone-join triggers a device-list change which
  calls _rebuildPlayingHosts() while Kueche is still STOPPED.  Kueche's
  physical speaker IP is absent from _raumfeldPlayingPhysicalHosts, so
  the SUBSCRIBE burst that immediately follows is suppressed.  Without a
  real subscription, the Raumfeld kernel has no subscriber for Kueche's
  physical speaker and skips setting up its CDN proxy slot → the room
  joins the zone but receives no audio.
  Fix: _preAdmitPhysicalHosts() adds the joining room's physical IPs to
  the playing set immediately before connectRoomToZone is called, so the
  device-list-change SUBSCRIBE burst is allowed through.  Additionally,
  _rebuildPlayingHosts() now includes TRANSITIONING state (not only
  PLAYING) and rebuilds on every TRANSITIONING entry so any zone-join
  path not going through our loadSingle code is also covered.


- Fix (play fails with UPnP 701 after leaving a multi-room zone):
  When Bad joined Kueche's zone and the user then pressed Stop on Bad,
  stop() correctly called dropRoomFromZone(Bad) — Bad left the zone while
  Kueche kept playing.  However, after leaving the zone Bad's physical
  speaker transitions to NO_MEDIA_PRESENT (URI cleared).  A subsequent
  Play press on Bad fell through to renderer.play() on the physical speaker
  which returned UPnP error 701 (Action not allowed) and threw an exception.
  Fix: play() now detects NO_MEDIA_PRESENT state for live streams and routes
  to loadSingle(_lastItemId) instead, which also re-creates the virtual zone
  renderer via _ensureVirtualRenderer.  A belt-and-suspenders 701 catch in
  the final fallback handles any residual race where the state update arrives
  late.  After this fix, pressing Play after a zone-dissolution stop works
  identically to loading from favorites.


- Fix (eliminate physical subscription burst for stopped rooms):
  node-raumkernel subscribes to physical speakers for ALL active-zone rooms,
  even those not currently playing audio.  On every device-list change
  (e.g. presence automation starting/stopping music in any room), it
  re-subscribes to all of them simultaneously.  The burst disrupts the
  kernel's CDN proxy connection for any concurrently-playing stream.
  Fix: RaumkernelHelper now maintains global._raumfeldPlayingPhysicalHosts
  (a Set of physical-speaker IPs currently in PLAYING state), updated on
  every PLAYING/STOPPED transition.  physicalSubscribeProxy in
  tunein-patch.cjs uses this set as its primary filter: SUBSCRIBE requests
  for rooms that are not actively playing receive a fake response instead
  of being forwarded to the physical speaker.  When nothing is playing the
  filter falls back to the active-zone set (fail-open) so new zones can
  still complete their initial handshake.  Combined with the v1.3.13 burst
  stagger, presence automations now cause zero real subscription traffic
  for stopped rooms and therefore cannot disrupt Kueche's live stream.


- Fix (root-cause reduction of stream drops caused by presence-automation bursts):
  When any room starts or stops (e.g. a presence automation in another room),
  the Raumfeld Host fires a "device-list changed" event.  node-raumkernel
  responds by re-subscribing to ALL physical speakers simultaneously.  This
  burst of concurrent SUBSCRIBE requests hits the kernel while it is
  reconfiguring zones, disrupting the CDN proxy connection for any active live
  stream in other rooms (e.g. Kueche).
  Fix: `tunein-patch.cjs` now detects when multiple physical SUBSCRIBE requests
  arrive within a 100 ms window (a burst) and delays each request beyond the
  first by a random 500–2500 ms.  This staggers the burst so the kernel
  completes its zone reconfiguration before the subscriptions land, preventing
  interference with active streams.  The native Raumfeld app never caused drops
  because it sends no background subscriptions — this change brings our
  integration much closer to that behaviour.


- Improvement (reduce audible gap on stream drop from ~6s to ~3.5s):
  Long sessions (>120s) that drop due to UPnP subscription bursts need no
  throttle back-off.  Auto-restart delay reduced from 3000ms to 500ms for
  sessions longer than 120s.  Short sessions (<45s, TuneIn-throttled) still
  use the 8s back-off; medium sessions use 3s.

- Improvement (request longer UPnP subscription timeouts):
  When forwarding real SUBSCRIBE requests to physical speakers and virtual
  zone renderers, now request `Timeout: Second-1800` (30 min) instead of
  the default ~240s.  If the Raumfeld kernel/speakers honour the longer
  grant, subscription renewal bursts happen every ~30 min instead of every
  ~4 min, greatly reducing the chance of a burst coinciding with a
  presence-automation device-list change that causes stream drops.

## 1.3.11

- Fix (auto-restart did not fire — `no item ID` message in log):
  When a live stream was started outside the addon's `play()` path
  (kernel resuming on addon startup, or user pressing play in the native
  Raumfeld app), `_lastItemId` was never set, causing the auto-restart
  guard to skip.  The metadata subscription callback now backfills
  `_lastItemId` from the DIDL-Lite item ID whenever it detects a live
  radio stream and the field is empty.

## 1.3.10

- Fix (SyntaxError on startup introduced in v1.3.9):
  A `try {` opening brace and the `dropRoomFromZone` call were accidentally
  removed when inserting `_autoRestartPending = false` into the zone-drop
  rejoin path, leaving a bare `catch` that caused a `SyntaxError: Unexpected
  token 'catch'` and prevented the addon from starting.

## 1.3.9

- Fix (live radio stream stops unexpectedly and requires manual Play press):
  The Raumfeld kernel sets `CurrentTransportActions='Play'` after a CDN
  stream drop but does **not** restart playback on its own — it simply
  waits for an explicit Play command.  The addon now schedules an automatic
  `play()` call after every unintentional stream drop so the user no longer
  has to press Play manually.
  Back-off: throttled sessions (< 45 s) use an 8 s delay to give TuneIn a
  brief breathing window; longer sessions restart after 3 s.
  Auto-restart is skipped when the user intentionally stops the player
  (`_userStopped` flag) or when a partial zone-drop rejoin is already
  in progress.

## 1.3.8

- Fix (addon update fails with "dockerfile is missing" after HA Supervisor update):
  HA Supervisor scans recursively for `config.yaml` files in the repository.
  A copy of the addon's `config.yaml` (same slug, no Dockerfile) had been sitting
  inside the integration bundle directory since early in the project.  A recent
  Supervisor update changed which duplicate it resolves first, causing it to pick
  the bundle copy (no Dockerfile) over the real addon directory — triggering the
  "dockerfile is missing" error on every update attempt.
  Fix: renamed to `addon_config_ref.yaml` so Supervisor ignores it.
  `prepare-build.sh` now explicitly removes any `config.yaml` from the bundle
  after copying, preventing this from recurring.
- Fix (`sync-version.sh` sed syntax incompatible with Linux):
  The `sed -i ''` fallback used macOS BSD syntax; replaced with portable
  `sed -i` for Linux environments.

## 1.3.7

- Fix (`ReferenceError: renderer is not defined` crash in `pause()`):
  The `pause()` function in `RaumkernelHelper.js` was missing
  `const renderer = this._getRendererForRoom(room)` — the variable was
  referenced but never declared, so every `pause` command threw a
  `ReferenceError`.  This was visible in the logs as an unhandled exception
  whenever `async_turn_off` was called (which internally calls pause before
  entering standby).

- Fix (`async_turn_off` now calls `stop()` instead of `pause()` before standby):
  Calling `pause` before entering standby was triggering the bug above.
  `stop` is also semantically more appropriate here — turning a device off
  should release the stream rather than hold it in a paused buffer.

## 1.3.6

- Fix group indication in HA player view when rooms are in a zone together:
  `zoneMembers` is now always populated with canonical `roomUdn` values
  (resolved via `_findRoomByAnyUdn`) rather than the raw UDN from the zone
  data, which could be a virtual-renderer UDN that doesn't match the
  `room_udn` attribute used by the HA `group_members` lookup.



## 1.3.5

- Remove shuffle and repeat buttons from live radio player:
  `SHUFFLE_SET` and `REPEAT_SET` features are now only advertised for
  regular track playback.  The radio/broadcast player card shows only the
  controls that are meaningful for a live stream (play, stop, volume, mute).



- Revert zone/device volume mode toggle (repeat button repurposing removed):
  The repeat-button-as-zone-volume-toggle introduced in v1.3.2 / v1.3.3 had
  too many edge cases.  The feature has been removed.

  Volume behaviour is now simple and stable:
  - Volume slider always controls **this device only** (per-room physical renderer).
  - Repeat button works normally for all content (OFF / ONE / ALL sent to device).
  - Shuffle button works normally.
  - The **Device Volume** `number` entity (device page) continues to provide
    per-device control independently of any zone grouping.

  The `setZoneVolume` and `setZoneVolumeMode` addon commands remain available
  for automation use if needed in future.



- Fix (zone volume mode caused audio to stop / buttons out of sync / repeat stuck):

  Three root-cause bugs in v1.3.2 have been fixed:

  1. **"No audio" after zone-volume drag**: The Raumfeld zone renderer's
     `SetVolume` is delta-based (it subtracts the new value from the current
     zone-master and applies the difference to every member).  When a member
     already had a very low volume (e.g. 1) and the delta was large and negative,
     its volume went negative (stored as −29, clamped to 0 on the device = silent).

     Fix: `setZoneVolume` now computes the delta itself, then applies it to each
     room's **physical** renderer with explicit `Math.max(0, Math.min(100, …))`
     clamping.  All members stay in the valid range.

  2. **"Buttons out of sync"**: Each HA media-player entity tracked
     `_zone_volume_mode` as a local Python flag.  Activating zone mode on
     TischlerEi left KellerStueberl's repeat button at OFF, making the cards
     visually inconsistent.

     Fix: mode is now stored on each room object in the addon (`room._zoneVolumeMode`)
     and broadcast as `nowPlaying.zoneVolumeMode`.  `setZoneVolumeMode` writes the
     flag to **every room in the zone** before broadcasting, so both cards update
     to the same repeat state simultaneously.

  3. **"Repeat button stuck / can't switch back"**: `async_set_repeat` was
     updating local state and relying on `async_write_ha_state()` without
     any server round-trip.  A concurrent state-update callback could race and
     restore the old value before the write propagated.

     Fix: `async_set_repeat` for live radio now calls `set_zone_volume_mode` on
     the server.  The server broadcasts the updated state to all listeners;
     `update_state` picks it up and writes the correct repeat icon.  No local
     flag to race against.



- Improvement (volume mode toggle via repeat button on live radio):
  The volume slider defaults to **device-only** control at all times.

  For live radio the repeat button (which is meaningless for a live stream) is
  repurposed as a zone/device volume mode toggle:

  - Repeat **off** (default) — volume slider controls this device only.
  - Repeat **all** — volume slider controls the zone master (all grouped
    speakers move together, like the native Raumfeld app).

  Pressing the repeat button while playing live radio toggles between the two
  modes.  HA's repeat cycle goes OFF→ONE→ALL→OFF; ONE is silently treated as
  ALL so the button jumps straight to zone mode on the first press, giving a
  clean two-state toggle.  The mode is stored locally and persists across
  device state-update callbacks; it resets to device mode on HA restart.

  For regular music tracks repeat continues to work as before (OFF/ONE/ALL
  sent to the device).

  The **Device Volume** `number` entity (device page) always controls only
  this speaker regardless of the toggle state.



- Improvement (volume slider context-aware behaviour):
  The media-player volume slider now acts on the zone master when the room is
  grouped, and on the individual device when solo.

  - **Grouped** → slider shows and controls the zone-master volume (all zone
    members move together, matching the native Raumfeld app's group slider).
  - **Solo** → slider shows and controls the device volume only.

  A new **Device Volume** `number` entity is also created per room.  When a
  room is in a zone this entity lets you fine-tune a single speaker's level
  without affecting the other members.  It always reflects and controls the
  per-room absolute volume (from `state.RoomVolumes`).

  The previous "Zone Volume" `number` entity (added in 1.3.0 but renamed) is
  replaced by "Device Volume"; if you see a stale "Zone Volume" entity in HA
  it can be deleted from the entity registry.



- Fix (volume up on one room appeared to affect the other room):
  `_extractNowPlaying` was returning `state.Volume` as the `volume` field for every room.
  `state.Volume` is the **zone-master** volume — the highest absolute volume among all zone
  members.  When one room's volume was raised above the current master the zone master updated,
  making the HA slider for every other room appear to jump in sync.

  Fix: per-room volume is now read from `state.RoomVolumes` (e.g.
  `uuid:TischlerEi=88,uuid:KellerStueberl=22`).  The device-volume slider in HA now tracks each
  room's individual speaker level independently.  Negative values (artefact of a prior buggy
  zone-level delta) are clamped to 0.

- Feature (zone/group volume slider):
  A new `number` entity **Zone Volume** is created for every room alongside the existing
  `media_player` entity.  It shows the zone-master volume and, when adjusted, calls
  `setZoneVolume` which routes through the virtual zone renderer — the same behaviour as the
  native Raumfeld app's group slider: all rooms in the zone move together.  When a room is
  not in a zone the zone volume equals the device volume.

  - New `number.py` platform in the custom component.
  - New `setZoneVolume` command in the addon (`RaumkernelHelper.js`, `index.js`).
  - New `set_zone_volume` method in `api.py`.
  - `zone_volume` exposed in `extra_state_attributes` of the media player entity.


- Fix (changing volume on one room adjusts the whole zone):
  `setVolume` and `setMute` were calling `renderer.setVolume(volume)` on the zone's virtual
  renderer without specifying a room UDN.  The Raumfeld zone renderer interprets this as a
  zone-level relative change: it takes the current zone-master volume as the reference point
  and applies the delta to every room in the zone simultaneously.

  Fix: both methods now resolve the physical renderer via
  `deviceManager.mediaRenderers.get(room.rendererUdn)`.  The physical renderer controls only
  that one device, so the volume change is isolated to the target room.  Falls back to the
  zone renderer if no physical renderer is found (e.g. a speaker in deep standby).

- Fix (spurious partial-zone-drop timers fired on initial zone join):
  When a room first joined a zone it appeared briefly as `STOPPED` in `RoomStates` before
  the kernel promoted it to `PLAYING`.  The partial-drop auto-recovery code scheduled a
  rejoin timer even though the room had never been playing in the zone yet, because it
  didn't check `prevState`.

  Two guards added:
  1. `prevState === 'PLAYING'` — only schedule a rejoin when the room actually *dropped*
     from an active stream (not on initial join where `prevState` is `undefined` or
     `'STOPPED'`).
  2. `room._partialDropRejoinPending` flag — prevents duplicate timers when multiple
     subscription callbacks fire within milliseconds for the same state-change event.

## 1.2.109

- Fix (Kueche stops while TischlerEi keeps playing — partial zone drop not detected or recovered):
  When the TuneIn CDN session renews every 120 s, one physical renderer in the zone can lose
  its CDN proxy connection while the zone itself stays alive (the other room continues playing).
  Because the zone renderer's overall `TransportState` remained `PLAYING`, our drop detection
  (which checked `state.TransportState`) never noticed Kueche had stopped.

  Fix — three coordinated changes in `RaumkernelHelper.js`:

  1. **Correct per-room state detection**: `_extractNowPlaying` now parses `state.RoomStates`
     (e.g. `uuid:Kueche=STOPPED,uuid:TischlerEi=PLAYING`) to derive the room-specific
     `currState` instead of using the zone-level `TransportState`.  Partial drops are now
     logged as "Stream dropped for Kueche (session Xs)".

  2. **Auto-recovery (3 s timer)**: When a partial drop is detected (`currState=STOPPED` but
     zone `TransportState=PLAYING`, room not user-stopped), a 3-second timer fires.
     If the room hasn't self-healed, it is dropped from the zone via `dropRoomFromZone()`
     and then re-added via `loadSingle()`.  The `loadSingle` zone-join logic finds the
     still-playing zone (TischlerEi) and calls `connectRoomToZone()` — Kueche rejoins
     without interrupting TischlerEi.

  3. **Manual recovery via Play button**: `play()` now checks if the room is `STOPPED` in
     `RoomStates` while the zone is `PLAYING`.  If so, it performs the same drop+rejoin
     instead of falling through to a no-op `renderer.play()`.

## 1.2.108

- Fix (stopping TischlerEi also stops Kueche when they share a zone):
  Once a room joins another room's zone via `connectRoomToZone`, calling `stop()` on
  the joining room resolved to the shared zone renderer and stopped the entire zone,
  silencing all rooms in it.

  Fix: `stop()` now checks whether the room belongs to a multi-room zone
  (`getRoomCountForZoneUDN > 1`).  If so, it calls `zoneManager.dropRoomFromZone()`
  instead of `renderer.stop()` — this ejects just the stopped room from the zone
  while the other room(s) continue playing.  Falls back to zone stop on error.

- Note: the `ECONNREFUSED` / `UNSUBSCRIBE_ALL` errors seen during zone-join startup
  are harmless: they occur when the old standalone zone port is closed by the kernel
  immediately after the room is moved into the shared zone.  The subscription was
  already torn down on the kernel side; the error is a cleanup artifact only.

## 1.2.107

- Fix (zone-join missing from `play()` STOPPED→native path):
  When a room was in STOPPED state with a `dlna-playsingle://` URI already loaded
  (e.g. after a stream drop or HA restart), pressing Play in HA called `play()` which
  took the `STOPPED→native` branch and called `renderer.play()` directly — bypassing
  the zone-join logic entirely.  Both rooms then ran independent TuneIn sessions for
  the same station, which is what the zone-join fix was meant to prevent.

  Fix: the `STOPPED→native` branch in `play()` now performs the same zone-join check
  as `loadSingle()`: if another room is already PLAYING the same station (matched via
  `room._lastStationId`, which is now set from running kernel metadata), the room joins
  the existing zone via `zoneManager.connectRoomToZone()` instead of calling
  `renderer.play()`.  Falls back to native `Play()` on any error.

## 1.2.106

- Fix (zone-join never triggered because stationId lookup relied solely on stale browse cache):
  `loadSingle()` determined the TuneIn station ID via `_getItemRefIdFromCache()`, which returns
  null when the item was added to favourites after the last fresh browse (e.g. favourite removed
  and re-added, getting a new numeric ID).  With `stationId = null` the zone-join block was
  silently skipped and each room started an independent TuneIn session.

  Fix 1 – `_extractNowPlaying`: when a live-stream is detected, extract the station ID directly
  from the raw `refID` attribute in the kernel's live metadata (e.g. `refID="0/RadioTime/Search/s-s8007"`)
  and store it on `room._lastStationId`.  This is independent of the browse cache and runs on
  every subscription update while the station is playing.

  Fix 2 – `loadSingle()` stationId fallback: if the browse-cache lookup returns null, scan other
  rooms for one that (a) previously loaded the same `itemId` and (b) has a known `_lastStationId`
  from running metadata.  This lets TischlerEi correctly identify that it wants to join Kueche's
  s8007 zone even when the item ID is not in the local browse cache.

  Fix 3 – `_lastStationId` is now reset to `undefined` alongside `_isLiveStream` when a new
  media source URI is detected (prevents stale station IDs from matching the wrong zones).

- Fix ("already active but none was playing" error when starting a station that is already loaded
  but STOPPED):
  When the kernel already has `dlna-playsingle://…?iid=<itemId>` as its `AVTransportURI` and the
  room is in STOPPED state, calling `SetAVTransportURI` with the identical URI causes the kernel
  to respond "already active".  `loadSingle()` now detects this case and calls `renderer.play()`
  directly instead, which is the correct command to restart a loaded-but-stopped stream.

- Fix (dedup guard prevents restart after stream drop):
  The 60-second duplicate-loadSingle guard was firing when a user tried to reload a station
  whose stream had just dropped (room in STOPPED state), silently ignoring the request and leaving
  HA showing the entity as active while nothing was playing.  The guard now only applies when the
  room is in PLAYING or TRANSITIONING state; STOPPED rooms can always reload immediately.

## 1.2.105

- Fix (multi-room TuneIn rate limit causes ~10 min drops when several rooms play same station):
  Each room was creating its own independent TuneIn session via `loadSingle`.  With
  N rooms all calling ebrowse every 120 s on the same serial, the TuneIn API is
  throttled (15–25+ calls/5 min) and the ebrowse renewal fails → stream drops.

  The native Raumfeld app avoids this by using zone grouping — all rooms playing
  the same station share ONE zone with ONE TuneIn session.

  Fix: `loadSingle()` now checks if any other room is already PLAYING the same
  station (identified via the browse-cache `refID` → TuneIn station ID).  If a
  match is found, the room joins the existing zone via
  `zoneManager.connectRoomToZone(roomUdn, targetZoneUdn)` instead of creating a
  new independent TuneIn session.  This mirrors exactly how the native app handles
  multi-room playback.
  - Station matching uses the TuneIn station ID (e.g. `s8007`) extracted from the
    browse-cache `refID` so that `0/Favorites/RecentlyPlayed/62620` and
    `0/Favorites/MyFavorites/62621` are correctly recognised as the same station.
  - `room._lastStationId` is now tracked alongside `room._lastItemId`.
  - Zone join errors fall through to native `loadSingle` as a safe fallback.

## 1.2.104

- Fix (stream drops at 40–143 s, getting shorter with each restart):
  All `play()` paths were calling `SetAVTransportURI` with stripped/corrupted DIDL
  metadata (no `raumfeld:ebrowse`, no `raumfeld:section`).  Each successive run read
  back that degraded kernel state as its input, making it worse.  The Raumfeld kernel
  auto-retried the raw CDN connection but without valid TuneIn credentials each reconnect
  lasted shorter than the last (40 s → 15 s → …).

  Root cause: our code used `renderer.rendererState.AVTransportURIMetaData` as the
  metadata source, but that state was already stripped by previous integration runs.
  We were iteratively corrupting the kernel's own state.

  Fix: **stop using `SetAVTransportURI` with CDN URLs in `play()` entirely.**
  - `dlna-playsingle://` state → bare `renderer.play()` (kernel manages TuneIn natively)
  - CDN-URL state (corrupted from a previous run) → `renderer.loadSingle(itemId)`,
    deriving the ContentDirectory item ID from the corrupted metadata (`ext/X` → `0/X`).
    This restores the kernel to `dlna-playsingle://` mode with a full fresh TuneIn
    session (ebrowse + section + durability) so it can play indefinitely.
  - ECONNRESET retry now uses `renderer.loadSingle(itemId)` instead of
    `SetAVTransportURI` with stale metadata.
  - `loadSingle()` CDN shortcut guarded by `hasEbrowse` check: only bypasses
    session-dispatch when the cached metadata still contains `raumfeld:ebrowse`;
    falls through to native `loadSingle` when metadata is corrupted.
  - `room._lastItemId` now tracked so `play()` can reload the correct station
    even after multiple stop/start cycles.

## 1.2.103

- Fix (ebrowse stripped from CDN metadata causes ~143 s stream drop):
  `_stripTuneInMarkers` was removing `raumfeld:ebrowse` from the DIDL metadata.
  The CDN server (e.g. orf-live.ors-shoutcast.at) closes TCP connections every
  ~120–143 s and expects the client to reconnect.  The Raumfeld kernel uses the
  ebrowse URL to obtain a fresh CDN session token on reconnect.  Without ebrowse
  the kernel cannot renew the session when the TCP connection closes, so the stream
  drops at exactly that ~143 s boundary.  This explained why v1.2.102 still dropped
  at 143 s despite the section=RadioTime preservation fix.

  The native Raumfeld app plays indefinitely because it always provides full TuneIn
  metadata (ebrowse + section) to the kernel, allowing transparent CDN reconnection.

  Fix: keep `raumfeld:ebrowse` in the DIDL sent to SetAVTransportURI.  Instead:
    - Zero `raumfeld:durability` (force an immediate ebrowse refresh on connect)
    - Remove `<res>` elements whose URL contains `Tune.ashx?id=` (session-dispatch
      URLs that are throttled); the kernel will use the cheaper ebrowse path instead
    - Keep id/parentID neutralisation (0/ → ext/) and refID stripping to block
      ContentDirectory lookups that would re-expose session-dispatch res URLs

  Summary of what _stripTuneInMarkers now keeps vs strips:
    KEPT:   raumfeld:ebrowse            (CDN session renewal — CRITICAL)
            raumfeld:section=RadioTime  (live-radio kernel mode)
            dc:title, upnp:albumArtURI, upnp:class, raumfeld:name
    ZEROED: raumfeld:durability 0       (force immediate ebrowse refresh)
    REMOVED: <res Tune.ashx?id=…>       (session-dispatch, throttled)
             refID attribute            (blocks ContentDirectory walk-back)
    CHANGED: id/parentID prefix 0/ → ext/  (blocks ContentDirectory lookup)

## 1.2.102

- Fix (stripped raumfeld:section=RadioTime causes kernel ~143 s reconnect drop):
  `_stripTuneInMarkers` removed `raumfeld:section=RadioTime` from the DIDL metadata.
  Without this field the Raumfeld kernel no longer recognises the stream as a live
  radio broadcast — it treats it as a regular media file instead.  In regular-file
  mode the kernel exposes `CurrentTransportActions = Pause,Stop,Seek,…` (instead of
  the live-radio `Stop`-only set) and applies an internal reconnect / end-of-track
  timer at approximately 120–150 s.  When that timer fires the kernel drops the
  stream, resulting in the new 143 s drops observed in v1.2.101.

  Fix: keep `raumfeld:section=RadioTime` in the stripped metadata — it is required
  so the kernel treats the stream as an infinite live broadcast (no pause, no seek,
  no reconnect timer).  Without an ebrowse URL or a valid ContentDirectory refID the
  kernel has no path to call TuneIn, so the no-TuneIn goal is preserved.

  To additionally block ContentDirectory lookup by item id (which could recover the
  ebrowse URL from the item hierarchy), change the id / parentID prefix from "0/" to
  "ext/" — a prefix that does not exist in the kernel's ContentDirectory.  Per-item
  uniqueness is preserved (no cross-room coupling).

  Summary of what _stripTuneInMarkers now keeps vs strips:
    KEPT:   raumfeld:section=RadioTime  (live-radio kernel mode)
            dc:title, upnp:albumArtURI, upnp:class, raumfeld:name  (display)
            item id uniqueness (ext/ prefix)
    STRIPPED: raumfeld:ebrowse, raumfeld:durability, refID attribute,
              id/parentID prefix changed 0/ → ext/

## 1.2.101

- Fix (v1.2.100 permanent-CDN shortcut missed the play() STOPPED→native path):
  v1.2.100 added `_isPermanentCdnUrl` / `_stripTuneInMarkers` and applied them to
  every `setAvTransportUri` call site (Path A, Path B, ECONNRESET, loadSingle CDN
  shortcut).  However, the `play()` method's `dlna-playsingle://` guard fires BEFORE
  any of those paths are reached and calls bare `renderer.play()` directly.  With the
  kernel's AVTransportURI still set to `dlna-playsingle://` at startup (from the
  previous session), all three rooms went through the native guard → each created its
  own independent TuneIn session → 3 ebrowse calls per 60 s → rate-limit at ~280 s →
  drop.  Confirmed in the log: `play() live stream (STOPPED→native)` for all 3 rooms;
  no `STOPPED→permanent-CDN` log entry.
  Fix: extend the `dlna-playsingle://` guard in `play()` to first attempt the
  permanent CDN shortcut.  When a cached permanent CDN URL is available AND the
  kernel's `AVTransportURIMetaData` `refID` matches the cached metadata's `refID`
  (same station), call `SetAVTransportURI(CDN URL, stripped metadata)` instead of
  bare `play()`.  Falls through to native play only when no CDN cache or station
  mismatch.  This activates correctly at startup because the Raumfeld kernel reports
  `CurrentTrackURI = CDN URL` even for rooms in STOPPED state with a
  `dlna-playsingle://` AVTransportURI (the last-played URL is retained in
  CurrentTrackURI between sessions), so `_lastSeenCdnUri` is always populated.

## 1.2.100

- Fix (3-room same-station TuneIn rate-limit → ~300 s drops):
  With three rooms independently playing the same station (e.g. Ö3), the Raumfeld
  kernel creates a separate TuneIn session per room.  Each session calls
  `Tune.ashx?c=ebrowse` every 60 s for renewal.  Three rooms = 3 ebrowse calls per
  minute for the same (serial, station) pair.  TuneIn's rate limit for the pair is
  roughly 12–15 calls per 5-minute window; the 13th–15th call returns a throttled
  (very short) session, causing the stream to drop at approximately 300 s — exactly
  5 renewal windows × 60 s.  This was observed consistently: sessions always lasted
  288–298 s before dropping, regardless of whether the initial load came from the
  integration or from the native app.

  Root observation: Ö3's CDN URL (`orf-live.ors-shoutcast.at/oe3-q2a`) is a
  permanent, public ORF/Shoutcast stream with no TuneIn session token in the URL.
  It does not need ebrowse calls to remain alive — the CDN connection stays open
  indefinitely.  However, because the DIDL-Lite metadata still carries
  `raumfeld:section=RadioTime`, `refID`, and `raumfeld:ebrowse`, the kernel
  treats it as a TuneIn-managed stream and keeps calling ebrowse every 60 s.
  Stripping those markers makes the kernel play it as a plain HTTP stream — zero
  TuneIn calls, zero rate-limit exposure, plays forever regardless of room count.

  Fix: add `_isPermanentCdnUrl(url)` (returns true for direct CDN streams that
  do not carry a TuneIn session token; returns false for `rndfnk.`
  dispatcher URLs, `radiotime.com`, `tunein.com`, `aggregator=tunein`, etc.) and
  `_stripTuneInMarkers(metaXml)` (removes `raumfeld:ebrowse`, `raumfeld:durability`,
  `raumfeld:section`, and `refID` from DIDL-Lite while preserving the item `id` and
  all display fields so each room keeps its own unique item reference).

  Applied in all SetAVTransportURI call sites:
  - Path A (play STOPPED→CDN): permanent URL → stripped metadata, kernel plays as
    plain HTTP.
  - Path B (CDN-direct fallback): same.
  - ECONNRESET retry: same.
  - loadSingle CDN shortcut: permanent URL → stripped metadata (replaces
    durability=0 path); TuneIn-dispatcher URL → durability=0 unchanged.

  For TuneIn-dispatcher URLs (e.g. `dispatcher.rndfnk.com/…?aggregator=tunein`),
  session markers are preserved and the existing ebrowse renewal path continues
  unchanged.  A single-room dispatcher stream is unaffected; multi-room same-station
  dispatcher streams may still see ~300 s drops with 3+ rooms, which requires zone
  grouping to solve at the Raumfeld layer.

## 1.2.99

- Fix (loadSingle triggers slow TuneIn session-dispatch → 90 s TRANSITIONING):
  When the user selects a station from the HA media browser, `loadSingle` makes the
  kernel load the item via `dlna-playsingle://`.  The kernel then calls two TuneIn
  endpoints in sequence: (1) `Tune.ashx?c=ebrowse` for session metadata — fast,
  not throttled, always returns durability=120 — and (2) `Tune.ashx?id=<event-id>`
  (session-dispatch) to resolve the actual CDN stream URL.  The dispatch endpoint has
  a separate, stricter throttle tier.  When throttled it does not fail outright: it
  stalls for 90+ seconds before timing out, leaving the renderer in TRANSITIONING
  with the user seeing no playback.  The native Raumfeld app avoids this entirely
  by reusing the active CDN connection when restarting the same station; it never
  hits the dispatch endpoint again.
  Fix: `loadSingle` now applies a CDN shortcut when (a) the room is STOPPED,
  (b) we have a cached CDN URL and station metadata, and (c) the requested item's
  `refID` (looked up from the browse cache) resolves to the same station ID as the
  cached metadata.  In that case `SetAVTransportURI(CDN URL, metadata with
  durability=0)` is called directly, bypassing `dlna-playsingle://` entirely.
  `durability=0` tells the kernel the session is expired, so it calls ebrowse
  immediately (the fast path) to obtain a fresh CDN session rather than waiting for
  the 60 s renewal window.  This mirrors the native app's reconnect-via-CDN behaviour
  and brings loadSingle response time from 90 s to under 2 s even when the
  session-dispatch endpoint is throttled.
  Also added `refID` field to `_parseBrowseXml` item parsing so the browse cache
  can supply refID lookups for the station-match check.

## 1.2.98

- Fix (SetAVTransportURI corrupts native dlna-playsingle:// state → 3-room TuneIn throttle):
  When the native Raumfeld app (or the kernel itself) sets a room's AVTransportURI to a
  `dlna-playsingle://` reference, the kernel manages TuneIn session registration,
  renewal and cross-room session sharing internally — exactly one ebrowse call per
  station shared across all rooms playing that station.  Our integration was bypassing
  this by calling SetAVTransportURI(CDN URL, ebrowse DIDL) via Path B (CDN-direct),
  which replaced the `dlna-playsingle://` state with an independent CDN URL for each
  room.  With 3 rooms each registering their own TuneIn session for the same station
  and serial, TuneIn throttled aggressively → sessions as short as 8 s → chain of
  drops and restarts → more ebrowse calls → deeper throttle.  The stale
  `raumfeld:durability` value captured at startup (109 s remaining) made it worse: the
  kernel saw an already-expired session and called TuneIn immediately.
  Fix: add a `dlna-playsingle://` guard at the top of the STOPPED live-radio branch in
  `play()`.  When `AVTransportURI` starts with `dlna-playsingle://`, always call bare
  `renderer.play()` instead of any SetAVTransportURI path.  The kernel takes over
  natively — session sharing, renewal scheduling and ContentDirectory browsing are all
  handled internally, matching the native Raumfeld app's behaviour.

## 1.2.97

- Fix (serial extraction always fails — `&amp;` XML encoding not handled):
  The TuneIn device serial lives inside a `raumfeld:ebrowse` URL embedded in DIDL-Lite
  XML.  XML requires `&` to be escaped as `&amp;`, so the URL looks like
  `...&amp;serial=78%3Aa5...`.  The extraction regex `/[?&]serial=/` expects a literal
  `&`, which never appears in the encoded string — so `_tuneInSerial` was always `null`
  and `_tryInjectEbrowse` always skipped with "serial not yet populated".
  Fix: change the regex to `/[?&](?:amp;)?serial=/` to match both the encoded and
  unencoded forms.

- Fix (CDN metadata cache never populated for native-app rooms):
  `_lastSeenCdnUri` was only updated when `AVTransportURI` was an HTTPS CDN URL.
  Rooms loaded via the native app use `dlna-playsingle://` as their `AVTransportURI`
  but still report the resolved CDN URL in `CurrentTrackURI`.  Because `_lastSeenCdnUri`
  was never set for those rooms, their full TuneIn ebrowse DIDL (available in
  `CurrentTrackMetaData`) was never saved to the shared CDN metadata cache on disk.
  Fix: when `AVTransportURI` is not an HTTPS CDN URL, also check `CurrentTrackURI`
  as a fallback source for `_lastSeenCdnUri`.  This allows rooms like Kati (which has
  the full ebrowse DIDL from a native-app load) to contribute to the cross-room cache.

- Fix (room processed before cache contributor — cross-room metadata not restored):
  In `_broadcastRoomStates`, rooms are iterated in registry-insertion order.  Kueche
  (whose `AVTransportURIMetaData` is `id="cdn/direct"` from a previous run) was
  inserted before Kati (which has the good ebrowse DIDL).  When the cold-start
  recovery ran for Kueche during the first-pass loop, Kati had not yet been processed
  and `_cdnMetaCache` was still empty → recovery failed → `_radioAvtMetadata` stayed
  `null` → `play()` fell through to the `cdn/direct` raw fallback → kernel in CDN-direct
  mode → ~100 s drops (same symptom as `_makeCdnMeta`).
  Fix: add a second-pass loop in `_broadcastRoomStates` that runs after all rooms have
  been processed and caches fully populated.  Any room that still lacks
  `_radioAvtMetadata` is restored from `_cdnMetaCache` using its `_lastSeenCdnUri`.

## 1.2.96

- Fix (stream drops after ~296 s — TuneIn ebrowse/refID stripped for permanent CDN URLs):
  The `_makeCdnMeta()` helper was applied to metadata before `SetAVTransportURI` for all
  permanent CDN URLs (e.g. `orf-live.ors-shoutcast.at`).  This stripped `raumfeld:ebrowse`,
  `raumfeld:durability`, `refID`, and `raumfeld:section` from the DIDL, leaving the kernel
  with no TuneIn session management capability.  Result: the kernel had to borrow an existing
  TuneIn session from another renderer; when that session expired the stream dropped.
  Empirical evidence: `_makeCdnMeta` → ~100 s drops; refID preserved → ~296 s drops;
  full ebrowse preserved → ~291 s (all three scenarios bottleneck at TuneIn throttling
  from repeated test runs, not at the CDN URL itself).
  Fix: remove `_makeCdnMeta()` from Path A, Path B CDN-direct, and the ECONNRESET
  retry path.  Metadata is now passed as-is so the kernel can manage its own independent
  TuneIn session via `raumfeld:ebrowse` (direct renewal) or via `refID` (ContentDirectory
  lookup → ebrowse URL).  In production (serial not throttled) this results in indefinite
  play; during heavy testing (throttled serial) drop intervals grow with throttle recovery.
- Fix (`_tryInjectEbrowse` always fails on cold start — serial not persisted):
  `_tuneInSerial` (the Raumfeld device MAC used for TuneIn `ebrowse` calls) was extracted
  from subscription events but never written to disk.  After an add-on restart the serial
  was `null` until at least one room reported an ebrowse URL in its state — which could
  take minutes or never happen at all when all rooms had been left in a CDN-URL state.
  Fix: persist the serial to `/data/tunein_serial.json` the first time it is extracted
  and reload it at startup.  `_tryInjectEbrowse` now works on the very first `play()`
  call after a restart without waiting for a room state event to supply the serial.

## 1.2.95

- Fix (100 s stream drop — Kueche loses TuneIn session when another room changes station):
  When `_radioAvtMetadata` is null at play time (startup metadata has no `raumfeld:ebrowse`)
  the raw-fallback path in Path A uses `renderer.rendererState.AVTransportURIMetaData`
  directly.  Previous code then applied `_makeCdnMeta()` which stripped `refID` and
  `raumfeld:section` from the DIDL.  Without those markers the kernel has no way to
  look up the station's `ebrowse` URL in its own ContentDirectory, so it *borrows* the
  TuneIn session from another renderer that happens to be playing the same CDN URL (e.g.
  KellerStueberl playing Hitradio Ö3 via `dlna-playsingle://`).  When that renderer
  changes station, its session expires ~19 s later — and Kueche drops simultaneously.
  Fix: track the raw-fallback path with an `isRawFallback` flag and skip `_makeCdnMeta()`
  for that case.  The DIDL keeps `refID` / `raumfeld:section`; the kernel follows the
  `refID` to the ContentDirectory entry for the station, finds the `ebrowse` URL there,
  and establishes an **independent** TuneIn session for Kueche — not shared with other
  renderers.
- Diagnostic: add per-guard log lines to `_tryInjectEbrowse()` so future logs reveal
  exactly which condition (no DIDL, no serial, no refID match) prevents ebrowse
  injection.

## 1.2.94

- Fix (stream always falls to bare `play()` — `_radioAvtMetadata` absent when kernel
  reports no `raumfeld:ebrowse` in startup metadata):
  After a clean restart the Raumfeld kernel populates `AVTransportURIMetaData` for
  zones that were last playing a radio station, but the metadata it reports may contain
  only minimal DIDL (song title, `refID`, `raumfeld:section`) **without** a
  `raumfeld:ebrowse` element.  The existing caching guard (`hasRealEbrowse`) therefore
  leaves `room._radioAvtMetadata = null`.  As a result:
  - Path A gate (`isDirectCdn && effectiveMeta`) evaluates false even though the zone
    renderer's `CurrentTrackURI` is a valid permanent CDN URL.
  - Path B CDN-direct gate (`fallbackCdnUri && fallbackMeta`) also evaluates false
    because `_makeCdnMeta(null)` returns null.
  Both paths fall through to the bare `Play()` which causes TuneIn session management
  and the associated throttle-induced drops (93 s, 59 s in the latest test).
  Fix (Path A): when `_tryInjectEbrowse` cannot produce ebrowse metadata and the
  current `AVTransportURI` is a permanent CDN URL (not rndfnk / aggregator=tunein),
  use the renderer's raw `AVTransportURIMetaData` as `effectiveMeta` directly.
  `_makeCdnMeta()` then strips all TuneIn markers before the `SetAVTransportURI`
  call, so the kernel plays the CDN URL as a plain stream — no ebrowse, no TuneIn
  session management.
  Fix (Path B CDN-direct): restrict CDN-direct to permanent CDN URLs only (rndfnk
  and aggregator=tunein continue to use bare `Play()` so the kernel manages TuneIn
  session renewal).  When `room._radioAvtMetadata` is absent, fall back to
  `renderer.rendererState?.AVTransportURIMetaData` as the metadata source for
  `_makeCdnMeta()`.

## 1.2.93

- Fix (recurring ~157 s stream drop — multi-room TuneIn session throttling):
  When multiple rooms (Sauna, Kati, Bad, Kueche) all have the same TuneIn station
  as their last-played item, the Raumfeld kernel calls `ebrowse` for each room at
  startup.  This burst of concurrent ebrowse calls exceeds TuneIn's per-serial
  rate limit, causing the kernel to receive a throttled session with
  `durability=37.6 s`.  After 37.6 + 120 = **157.6 s** the throttled session
  expires and the stream stops — regardless of whether the CDN URL itself is still
  perfectly valid.
  Root cause: `_stripEbrowse()` removes `raumfeld:ebrowse` and
  `raumfeld:durability` from the metadata, but leaves `refID` (e.g.
  `refID="0/RadioTime/Search/s-s8007"`) and `raumfeld:section="RadioTime"`.  The
  kernel follows the `refID` to its internal ContentDirectory entry for the
  station, finds the stored ebrowse URL there, and still manages a TuneIn session
  — completely bypassing the stripped metadata.
  Fix: new `_makeCdnMeta()` method strips ALL TuneIn markers: ebrowse, durability,
  `raumfeld:section`, `raumfeld:name`, the `refID` attribute, and neutralises
  `item id` / `parentID` to `cdn/direct` / `cdn`.  With no ContentDirectory
  reference left, the kernel treats the play as a plain audio stream — zero
  ebrowse calls, zero TuneIn rate-limit exposure, stream plays indefinitely.
  Changes: (1) Path A (permanent CDN URL restart) now calls `_makeCdnMeta()` in
  place of `_stripEbrowse()`; (2) Path B (bare `play()` fallback) now first
  attempts a `setAvTransportUri` with `_makeCdnMeta(room._radioAvtMetadata)` +
  `room._lastSeenCdnUri` before falling back to the kernel-managed bare `play()`,
  ensuring the CDN-direct path is taken even when `CurrentTrackURI` on the zone
  renderer is a `dlna-playsingle://` URI; (3) ECONNRESET recovery path also uses
  `_makeCdnMeta()` for permanent CDN URLs.

## 1.2.92

- Fix (recurring ~291 s stream drop — stale durability in CDN restart metadata):
  When the integration restarts Kueche via a CDN URL (Path A in `play()`), the
  cached `_radioAvtMetadata` still contains `<raumfeld:durability>37.6</raumfeld:durability>`
  from a previous session stored in the kernel's `RecentlyPlayed` database.  The
  kernel reads this value and schedules ebrowse renewal calls every ~37.6 s.
  TuneIn rate-limits those calls and eventually returns a zero-durability response
  that tears the stream down (~291 s = 8 × 37.6 s after stream start).
  Root cause: `_stripEbrowse()` already existed for exactly this scenario
  ("When streaming from a permanent CDN URL ebrowse/durability must NOT be sent")
  but was never called in Path A or the ECONNRESET fallback.  Fix: for permanent
  CDN URLs (not `rndfnk` / `aggregator=tunein` TuneIn CDN URLs that do require
  renewal), both call sites now wrap the metadata with `_stripEbrowse()` before
  passing it to `setAvTransportUri`.
- Fix (pre-fetch introduced 2 s drop): the v1.2.91 pre-fetch called
  `ContentDirectory.Browse('0/Favorites/MyFavorites')` 3 s after `systemReady`,
  creating TuneIn sessions for all favourites stations (including s8007 /
  Hitradio Ö3).  When the user then played Hitradio Ö3 ~99 s later via
  `loadSingle`, the kernel found the pre-fetch session with only ~21 s remaining
  and fired a pre-emptive renewal — conflicting with the `dlna-playsingle`
  session — causing a 2 s stream drop.  Fix: the pre-fetch is removed entirely.
- Fix (browse cache lost on restart): the `_browseCache` Map was in-memory only,
  so the cache was empty on every addon restart and the first browse always hit
  the kernel (triggering ebrowse for all TuneIn stations and potentially causing
  a stream drop).  Fix: cache is now persisted to `/data/browse_cache.json`.  On
  startup the file is read before `systemReady` so all subsequent Browse requests
  are served from cache without ever contacting the kernel.  The cache is updated
  after each kernel Browse and cleared (+ file wiped) by `clearBrowseCache()`.

## 1.2.91

- Fix (Browse first-hit still drops stream): the v1.2.90 browse cache prevented
  all *subsequent* browse calls from hitting the kernel, but the very *first*
  `ContentDirectory.Browse('0/Favorites/MyFavorites')` still reached the kernel
  and triggered ebrowse for every radio station in the container, stopping the
  active TuneIn stream ~48 s later (TuneIn throttles the new session). Fix: at
  `systemReady + 3 s`, a new `_preFetchBrowseCache()` method pre-warms the cache
  for `0/Favorites` and `0/Favorites/MyFavorites` in the background. The
  pre-fetch is skipped if a live stream is already PLAYING (e.g. stream started
  via the native app before the addon), to avoid triggering the same ebrowse
  problem. When the stream is STOPPED at startup (the normal case), the cache is
  populated before the user opens the media browser, so every browse from then on
  is served from cache.
- Feature (Stop vs Pause button for live streams): the native Raumfeld app shows
  a Stop button (not Pause) when a live radio station is playing, and a Pause
  button for regular tracks. The HA integration now matches this behaviour: the
  `PAUSE` feature flag is removed and only `STOP` is advertised when the currently
  playing item is an `audiobroadcast` (UPnP class). For regular music tracks both
  `PAUSE` and `STOP` are advertised (HA shows the Pause button).

## 1.2.90

- Fix (Browse kills stream): clicking FAVOURITES in the HA media browser caused
  Kueche (and any room playing a TuneIn station) to stop immediately. Root cause:
  `ContentDirectory.Browse('0/Favorites/MyFavorites')` causes the Raumfeld kernel
  to call the TuneIn ebrowse endpoint for every radio station in the container,
  including the one currently playing. This creates a new TuneIn session for that
  station, which the kernel then loads by tearing down and restarting the active
  stream (~3 s interruption). Fix: Browse results are now cached in
  `RaumkernelHelper._browseCache` (Map). The first call for each container still
  hits the kernel (and may cause a brief interruption), but all subsequent calls
  are served from cache with no kernel contact. Add `clearBrowseCache()` for
  programmatic cache invalidation.
- Fix (ContentDirectory SUBSCRIBE startup race): the ContentDirectory SUBSCRIBE
  fired at T+0 ms (during device discovery), BEFORE `systemReady` set
  `global._raumfeldMediaServerPorts` at T~30–200 ms. Because the port was unknown
  at that moment, `portMatch=false` and the subscription slipped through,
  meaning ContentDirectory NOTIFYs were still being delivered for the first
  ~5 minutes (until the 5-min renewal was correctly suppressed). Fix: all
  non-physical kernel SUBSCRIBE calls now go through a new `kernelSubscribeProxy`
  (modelled on `physicalSubscribeProxy`). The proxy polls every 50 ms until
  `_raumfeldMediaServerPorts` is set, then decides: MediaServer port or
  `/cd/` path → fake 24 h SID (suppress); all other ports → real SUBSCRIBE
  (allow virtual renderer AVTransport/RC). Timeout after 5 s → fail-open.
  Also extended the path pattern to match the actual eventSubURL used by current
  Raumfeld firmware: `/cd/Event` (not `/ContentDirectory/event`).
- Fix (KellerStueberl / standby device Play fails): when a device is in
  PAUSED_PLAYBACK state but its physical speaker is in deep standby, calling
  bare `renderer.play()` returns ECONNRESET. The integration now catches this
  for live streams and retries via a CDN URL reload (`setAvTransportUri`) so
  the kernel sends a fresh SetAVTransportURI to the device, waking it up and
  re-establishing the TuneIn session.

## 1.2.89

- Fix (P2 ContentDirectory suppression was broken in v1.2.88): the previous
  check matched the SUBSCRIBE request path against `/contentdirectory/i`, but
  the Raumfeld MediaServer's ContentDirectory eventSubURL apparently does not
  embed the service name in its path (e.g. it may be just `/event`), so the
  regex never matched and ContentDirectory subscriptions were never suppressed.
  Fix: dual-check approach — (1) port-based: `RaumkernelHelper` now discovers
  the MediaServer's dynamically-assigned UPnP HTTP port at `systemReady` and
  stores it in `global._raumfeldMediaServerPorts` (Set\<string\>); the patch
  compares the SUBSCRIBE request port against this set (robust against any
  eventSubURL path format); (2) path-based fallback retained for firmware
  variants that do embed the service name. Either match suppresses.
- Add diagnostic logging: every non-physical kernel SUBSCRIBE call now emits a
  `[KernelSub]` line showing host, port, path, and both match flags so the
  actual eventSubURL structure is visible in logs for future analysis.

## 1.2.88

- Fix (presence certificate): physical SUBSCRIBE filter was matching renderer UDN
  against the URL *path* of the SUBSCRIBE request, but physical Raumfeld speaker
  event endpoints use paths like `/AVTransport/event` — the UDN never appears in
  the path. As a result all 12 physical subscriptions were suppressed in v1.2.87,
  the same as v1.2.85, making the "presence certificate" ineffective. Fix: switch
  to HOST (IP address) based filtering. `RaumkernelHelper._updateSubscriptionFilter`
  now resolves active renderer UDNs → IP addresses via `deviceManager.mediaRenderers`
  and stores them in `global._raumfeldActivePhysicalHosts`. The proxy in
  `tunein-patch.cjs` checks `_raumfeldActivePhysicalHosts.has(host)`. If the IP
  lookup fails for all active renderers the global is set to `null` (fail-open:
  all physical subscriptions are allowed, same as v1.2.84).
- Fix (P2 stream drop at T+355s): suppress ContentDirectory subscriptions from
  the MediaListManager. The Raumfeld MediaServer sends 4 ContentDirectory NOTIFY
  callbacks every ~60 s to our HTTP server. Even though
  `loadMediaItemListsByContainerUpdateIds` is patched to a no-op, the kernel
  processes each NOTIFY it sends us internally; this processing competes with the
  kernel's own ebrowse TuneIn-session renewal timer. When that renewal loses the
  race to TuneIn's throttle, the stream stops. Fix: intercept SUBSCRIBE requests
  to the kernel host whose path contains "ContentDirectory" and return a fake 24 h
  SID — the kernel never establishes the subscription, never sends NOTIFY batches,
  and its ebrowse timer operates uncontested.

## 1.2.87

- Fix (P1): subscribe to physical (speaker) renderers only for ACTIVE zones.
  Raumfeld's kernel runs an internal zone health-check ~5 s after the first UPnP
  subscription arrives. The check reads `AVTransportURIMetaData.durability` for
  every playing zone. When the integration starts while a stream has been running
  through the native app for more than a few minutes, that durability value is
  stale (negative). Without any physical subscriptions the kernel performs a full
  session validation and stops the stream. Having at least one physical speaker
  subscription per active zone acts as a "presence certificate" that satisfies the
  health-check without triggering the validation. v1.2.85 suppressed all physical
  subscriptions → P1. v1.2.86 re-enabled all physical subscriptions to fix P1 but
  increased load. v1.2.87 takes the middle path: only subscribe to the physical
  renderer for each ACTIVE zone (typically 2–4 devices), suppressing all standby-
  zone physical renderers with a fake 24 h subscription (no real UPnP traffic).
  Implementation: `RaumkernelHelper._updateSubscriptionFilter()` parses the Zone
  Configuration `powerState` attributes on first `systemReady` (and on subsequent
  `zoneConfigurationChanged` events) and writes the active renderer UDN set to
  `global._raumfeldActivePhysicalUdns`. A polling proxy in `tunein-patch.cjs`
  (`physicalSubscribeProxy`) holds each physical SUBSCRIBE request until that
  global is populated (polled every 100 ms, fail-open after 3 s), then routes it
  to the real device or returns a fake 24 h SID.
- Fix (load): reduces physical subscription count from all-zones (12+) to
  active-zones only (typically 2–4), lowering UPnP traffic and kernel processing
  load, which also gives the kernel more headroom for TuneIn ebrowse renewals
  (mitigates P2 840 s drops).

## 1.2.86

- Revert: re-enable UPnP subscriptions to physical (speaker) renderer devices. Field testing of v1.2.85 revealed that suppressing physical-device subscriptions introduced an immediate 3-second stream drop at addon startup (followed by a ~5-minute kernel self-restart), a regression absent in v1.2.84. Root cause: physical speaker subscriptions change the Node.js event-loop timing at startup — the 23 incoming initial NOTIFYs from physical speakers stagger the processing of virtual-renderer NOTIFYs, preventing a concentrated burst that the Raumfeld kernel interprets as a trigger to drop the playing TuneIn session. Without those NOTIFYs the burst is sharper and hits a kernel timing edge-case. The 0–15 s renewal jitter (from v1.2.85) safely handles the increased ~46-subscription renewal burst, so keeping physical subscriptions active does not reintroduce the HTTP 412 renewal errors that prompted their removal.

## 1.2.85

- Fix: stop subscribing to physical (speaker) renderers — subscribe only to virtual (zone/room) renderers. Physical renderer subscriptions were redundant: virtual renderers carry all zone-level state needed by the integration (TransportState, volume, metadata). The extra ~24 physical subscriptions doubled the startup burst to the Raumfeld kernel's HTTP server, triggered unnecessary internal zone health checks in the kernel (causing the kernel to reload stale TuneIn sessions when the integration starts), and generated an equal-sized renewal burst at T+210 s. Fix: intercept `http.request` in `tunein-patch.cjs` and return a fake 200 OK for any SUBSCRIBE or UNSUBSCRIBE request whose target host is not the Raumfeld kernel host (`192.168.243.1`). The fake SUBSCRIBE response carries a 24-hour timeout so the renewal timer effectively never fires. Physical devices never receive a SUBSCRIBE; they never send NOTIFYs to our server. Subscription count drops from ~47 to ~23.
- Fix: reduce subscription renewal jitter from 0–60 s to 0–15 s. The previous 60 s cap caused HTTP 412 (Precondition Failed) errors: for a 240 s granted timeout the renewal window is 210 s; adding up to 60 s pushed some renewals to 270 s — 30 s past the 240 s expiry. With 15 s jitter, renewals land at 210–225 s, safely within the 240 s window. The 23 remaining virtual-renderer renewals spread across 15 s (~1.5/s) — well within the kernel's capacity.

## 1.2.84

- Fix: prevent subscription renewal burst from killing live-stream TuneIn sessions. All ~46 UPnP subscriptions (AVTransport + RenderingControl for every renderer) are created within a 5-second window at startup. The Raumfeld kernel grants ~240-second subscription timeouts, so `upnp-device-client` schedules every renewal at T+210 s — a second burst identical in size to the startup burst. This burst hits the kernel's HTTP server at the exact moment Kueche's TuneIn CDN-session renewal is also due, causing the kernel to miss the renewal window and drop the stream (~T+211 s, confirmed in logs). Fix: patch `global.setTimeout` before any module loads (in `tunein-patch.cjs`) to add 0–60 s of random jitter to timers whose delay falls in the 120 000–300 000 ms range. That range is exclusive to UPnP subscription renewal timers. With jitter, ~46 renewals spread evenly across 60 seconds (~0.8/s) instead of all at once.

## 1.2.83

- Fix: detect and recover from a stuck TRANSITIONING state. Previously, if the Raumfeld kernel entered TRANSITIONING (e.g. triggered by the native app or an HA automation) and then got stuck there because TuneIn was throttled and the CDN connection never opened, pressing Play via HA would log "kernel already loading, not interrupting" and do nothing — leaving the room unresponsive until the native app was used. Fix: track `room._transitioningStartTime` on every TRANSITIONING entry. In `play()`, if the kernel has been in TRANSITIONING for more than 30 seconds, force-call `renderer.stop()` (600 ms pause for the STOPPED subscription to arrive), then proceed with the normal Path A / Path B play logic. This means pressing Play on a hung room via HA will always recover within one press, regardless of how long the kernel has been stuck.

## 1.2.82

- Fix: eliminate the last source of unnecessary TuneIn session registrations — the "Poisoned CDN" cleanup. The `loadSingle` approach used since v1.2.80 registers a new TuneIn session at every startup where the kernel is in "poisoned" state (CDN URL + no ebrowse in metadata). Even though this cleanup was the right fix structurally, TuneIn throttles all recent sessions from the same serial, so the cleanup was deepening throttle instead of helping. New approach: at play time, if `_radioAvtMetadata` is empty (no cached ebrowse) but `CurrentTrackURI` is a direct CDN URL, `play()` attempts to reconstruct the ebrowse element directly from the kernel's `AVTransportURIMetaData` `refID` attribute (station ID) and `_tuneInSerial` (the device serial, extracted from the first real ebrowse URL seen in any room's subscription data). This produces complete station metadata with `raumfeld:ebrowse` and `raumfeld:durability` using only information already available from the kernel state, with **no ContentDirectory lookup and no new TuneIn session registration**.
- The `_tuneInSerial` field is now extracted passively from the first ebrowse URL seen in any room's `AVTransportURIMetaData` or `CurrentTrackMetaData` subscription events, making it available by the time the user presses Play.

## 1.2.81

- Fix: strip `<res>` from `AVTransportURIMetaData` before caching in `_radioAvtMetadata`. Previously, when the cleanup `loadSingle` (or a native-app play) produced `AVTransportURIMetaData` with both `raumfeld:ebrowse` and a `<res>` TuneIn relay URL, the metadata was cached as-is. Path A then called `setAvTransportUri(cdnUrl, metaWith<res>)`, which caused the kernel to fetch `<res>` and register yet another new TuneIn session. Registering Session 3 on top of the cleanup's Session 2 caused TuneIn to throttle the 2nd renewal → short-lived CDN token → drop at 312 s. Fix: always strip `<res>` from `AVTransportURIMetaData` before caching, exactly as the `CurrentTrackMetaData` path already did.
- Fix: at cleanup TRANSITIONING, save the fresh CDN URL (`CurrentTrackURI` = Session 2's URL) in `room._cleanupCdnUri`. Path A now prefers this URL over the stale pre-cleanup `CurrentTrackURI`, ensuring the active TuneIn session and the CDN URL used for streaming are always consistent.
- Fix: sync the bundled integration copy (`ha-raumkernel-addon/teufel_raumfeld_raumkernel/`) from `custom_components`, ensuring `integration=` in the startup log matches the addon version.

## 1.2.80

- Fix live radio drops after Play on a "poisoned CDN" state: v1.2.78 called `SetAVTransportURI` with stripped metadata (no `raumfeld:ebrowse`), leaving the kernel's persisted `AVTransportURI` as a plain HTTPS CDN URL with no ebrowse in its stored metadata. On the next restart, `_radioAvtMetadata` stays empty because no ebrowse is found in either `AVTransportURIMetaData` or `CurrentTrackMetaData`; Path A is skipped; bare `Play()` (Path B) falls through; the kernel re-resolves ContentDirectory and registers a new TuneIn session — which is throttled → drops at 102 s / 63 s. Fix: on initial subscription (`prevState === undefined`), if a stopped renderer has a direct HTTPS CDN URL as `AVTransportURI` but no `<raumfeld:ebrowse>` in its metadata, run the same `loadSingle + stop-at-TRANSITIONING` cleanup already used for stale TuneIn relay URLs. This restores the kernel to proper `dlna-playsingle://` state with full ContentDirectory metadata (including ebrowse) before the user presses Play, so Path A works correctly on the next play command.

## 1.2.79

- Fix live radio stream drops at ~511 s after pressing Play: the CDN URL used for BR Schlager and similar stations (`?aggregator=tunein`) is a TuneIn-session-dependent URL — without ebrowse renewal the CDN closes the connection once the initial token expires. v1.2.78 was stripping `raumfeld:ebrowse` and `raumfeld:durability` from the metadata before calling `SetAVTransportURI`, preventing the kernel from renewing. Fix: preserve ebrowse/durability in the metadata so the kernel renews the TuneIn session normally. The `_radioAvtMetadata` cache already has `<res>` stripped (from the stateChanged logic), so the metadata is correct: CDN URL via `CurrentURI`, station-level ebrowse for renewal, no raw TuneIn relay `<res>` URL.

## 1.2.78

- Fix live radio drops after pressing Play on a stopped stream: replace bare `Play()` (Path B) with CDN URL path (Path A) as the primary restart mechanism. Bare `Play()` on a `dlna-playsingle://` AVTransportURI forces the Raumfeld kernel to re-browse ContentDirectory and register a new TuneIn session; TuneIn throttles repeated registrations from the same device serial, causing drops at 82–126 s. Path A sends `SetAVTransportURI` with the CDN URL (retained in `CurrentTrackURI` across PLAYING→STOPPED) and station metadata with `ebrowse`/`durability` stripped, so the kernel streams the CDN URL directly with no TuneIn involvement, no renewal clock, and no throttle risk. Path B (bare `Play()`) is retained as fallback when no CDN URL is available (cold start).

## 1.2.77

- Fix TuneIn throttle from duplicate loadSingle: if the user taps a favorites item a second time within 60 s (e.g. because the HA frontend hadn't yet refreshed to show PLAYING), the second call is silently ignored. Without this guard, two TuneIn session registrations in quick succession trigger throttling and produce drops as short as 7 s.

## 1.2.76

- Fix persistent live radio drops caused by the HA integration calling `SetAVTransportURI` when the user presses Play on a stopped stream (Path C). Each such call registers a new TuneIn session; back-to-back registrations (e.g. Play then `loadSingle` within 30 s) trigger TuneIn throttling, causing drops as short as 37 s. The fix: always use a bare UPnP `Play()` for stopped live streams — identical to the native Raumfeld app — so the kernel reuses its own session context, which handles renewals stably even when durability is deeply negative. Also remove Path D (kernel auto-switch session refresh) for the same reason.

## 1.2.75

- Fix live radio stream drops at :02 past the minute: the root cause was that Path A (SetAVTransportURI with CDN URL) skipped the ContentDirectory lookup that fetches the TuneIn `<res>` session URL. Without that fetch, TuneIn has no record of a new session and kills renewal calls after 1–2 cycles. Replace Path A with Path C: always use the `dlna-playsingle://` URI (identical to what the native Raumfeld app does), which causes the kernel to fetch ContentDirectory → `<res>` URL → fresh TuneIn session registration → stable renewals indefinitely. Cache the dlna-playsingle:// URI so it remains available even if a previous run had corrupted AVTransportURI to a CDN URL.

## 1.2.74

- Fix live radio streams dropping at :02 past the minute after pressing Play via HA: Path A (CDN URL restart) was passing `<raumfeld:ebrowse>` and `<raumfeld:durability>` in the metadata, causing the kernel to schedule periodic TuneIn session renewal calls. TuneIn rate-limits those calls and tears down the stream. Strip both elements before calling `SetAVTransportURI` so the kernel streams the permanent CDN URL as a plain HTTP stream with no renewal cycle.

## 1.2.73

- Fix spurious "Previous" button on live radio streams: instead of routing play through `dlna-playsingle://` (which re-introduces TuneIn session renewal and drops at :02 past the minute), suppress `canPlayPrev` for any live stream directly in state extraction. The stable CDN URL path (Path A) is now the only live-stream restart path.

## 1.2.71

- Fix spurious "Previous" button appearing in HA media player when play is triggered via the integration after the native app had loaded a station via dlna-playsingle://

## 1.2.13

- Fix track images which are hosted on Raumfeld devices (e.g. Local music, Tidal) not showing up.
- Add information/debug page to the addon (reachable at the default port).

## 1.2.12

- Added a setting to manually set the Raumfeld host address if auto discovery fails.

## 1.2.11

- Add support for media_content_id. It is now possible to see which media is currently playing.

## 1.2.10

- Fixes a crash if homeassistant sends a "prev" command even if prev is not allowed
- Fix issues with seek.

## 1.2.9

- Automatic install of integration

## 1.2.7

- Add Seek
- Improved Zone Handling
- Reboot Devices

## 1.2.2

- Add reboot feature to restart Raumfeld devices via SSH

## 1.0.0

- Initial release
