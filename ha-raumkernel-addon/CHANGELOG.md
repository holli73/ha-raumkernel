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
