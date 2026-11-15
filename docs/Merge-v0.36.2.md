# Upstream v0.36.2 merge

Merged into local `main` from upstream tag `v0.36.2` at
`8b5d071ee`. The pre-merge branch tip was `2f261cbe2`. No push was performed.

## Resolutions

- Moved nation/tribe elimination into the new engine packages, including their
  config fields, binary-wire intents, and saved-game snapshot registrations.
  Preserved pause-after-spawn, elimination controls, and the extra replay speeds.
- Kept upstream's audio mixer, cue budgets, ambience, and audio settings.
  Extracted the fork's uploaded/bundled playlist and ReplayGain processing into
  `MusicLibraryPlayer`, following the mixer's master/music/focus gain and cue
  activity. Preserved music shortcuts, media-session controls, upload controls,
  solo Ctrl+Delete, custom sound effects, and the tagged original music files.
- Preserved solo victory messages instead of the victory modal, while retaining
  upstream's result voting. Kept the longer event log and upstream replay-seek
  cleanup; corrected consuming the update feed twice.
- Kept both nginx music-upload and upstream admin-pool routes. Regenerated the
  lockfile with npm 12.1.0 and installed locked dependencies without scripts.
- Kept upstream's LF text policy and marked all map binaries as binary. Restored
  exact indexed bytes for ten existing maps that Windows had checked out with
  CRLF conversion. No map terrain was regenerated.
- Migrated custom map metadata away from removed frequency fields and added
  JSON Schema references and default nation counts. Preserved map identities.

## Lower-confidence decisions and remaining issues

1. **Audio integration:** automated tests cover mixer gain, ducking, ReplayGain,
   uploads, deletion failures, teardown, cues, and ambience. Real browser audio,
   especially iOS volume restrictions, media-session controls, and autoplay,
   still needs a listening/playback check. The custom music path uses its own
   media-element/Web Audio graph instead of upstream's Howler music playlist.
2. **Legacy custom maps:** preserved the existing chicken map's canonical name
   and the existing unregistered Hillbilly Head assets. Renaming a wire-format
   map or enabling an unfinished map would change existing fork behavior.
   Upstream's stricter validation now rejects this data. Six tests remain red:
   - `MapConsistency`: chicken map name does not normalize to its folder;
     Hillbilly Head has a translation but no registration; Hillbilly Head's
     resource/generator folders have no registration.
   - `MapManifestSchema`: chicken `info.json` and `manifest.json` names exceed
     29 characters and contain an apostrophe; Hillbilly Head's manifest retains
     legacy `metadata` and `generatedAt` fields.
     The chicken name also conflicts with the upstream hosted API's documented
     map-name constraints. Hosted archival/link previews require a deliberate
     compatibility decision; the merge does not change those external services.
     The chicken-map issues were subsequently resolved in the follow-up below.

## Validation

- `npm run typecheck`: passed for the root and all engine/shared/zbin packages.
- `npm run lint`: passed.
- `npm run build-prod`: passed, including asset hashes and core version output.
- Full suite with Git Bash on PATH and four workers: 11,044 passed, 34 skipped,
  seven failed. Six are the map checks above. The seventh was a RenderHtml test
  assuming no production build existed; its manifest dependency is now mocked.
- Final focused rerun: 185 tests passed across seven files, including RenderHtml,
  elimination/snapshot, audio, and chat tests. Other focused runs verified the
  elimination wire round trips and replay/event-log behavior.
- Desktop CLI tests passed outside the Windows sandbox; inside it, tsx failed
  at `uv_os_get_passwd`. Deployment shell tests passed with Git Bash instead of
  Windows' WSL launcher.
- All Git conflict entries and conflict markers were resolved. Upstream's
  existing CSS/chunk-size build warnings remain.

## Chicken map restoration follow-up

- Changed the internal name to `AintNobodyHereButUsChickens` in the generator
  metadata, generated registry, and resource manifest. Kept the display title
  `Ain't Nobody Here But Us Chickens`, the featured category, and all 42 nations.
  Terrain binaries and the thumbnail are unchanged.
- Added old-name compatibility when reading presets, favorites, achievements,
  archived analytics, replay records, and saved-game snapshots. Old names also
  resolve to the existing terrain and preview paths. New configs and saves use
  the canonical name. Replay version checks remain in effect.
- Kept the live config enum schema and its ordering intact; alias conversion
  occurs at saved-data boundaries. Snapshot and binary-wire regressions pass.
- Type checking, lint, and the production build pass. Focused tests cover the
  metadata, legacy-name migration, and loading/resuming/resaving a legacy-name
  snapshot. The chicken map now passes the map consistency and manifest checks.
- Three existing map-validation failures remain, all for Hillbilly Head: its
  unregistered translation, unregistered folders, and legacy manifest fields.
  No new low-confidence conflict resolutions were needed for this follow-up.
  These three failures were subsequently resolved in the follow-up below.

## Hillbilly Head restoration follow-up

- Registered `HillbillyHead` / `Hillbilly Head` in the generated enum and map
  list, with nine default nations and the existing North America category.
  It is selectable in the map picker's All tab under North America.
- Moved the legacy manifest's author and description into the supported
  generator metadata and map picker fields, preserving the credit to Jeff
  Lawlor and the description "My very first map". Removed the unsupported
  manifest fields `metadata` and `generatedAt`; the old generation timestamp
  was `2026-04-05T03:36:57.588Z`.
- Preserved the existing terrain binaries and thumbnail. All three binary
  lengths and land counts match the manifest. Tests load the actual files
  through the game loader and start both normal (5000x5000) and compact
  (2500x2500) games; all nine nations spawn on passable land.
- All 486 focused map/loading/binary-wire checks pass, including the three
  previously failing Hillbilly Head checks.
- Final full suite: 743 test files passed and three skipped; 11,065 tests
  passed, 34 skipped, and none failed. Type checking, lint, and the production
  build also pass. Existing jsdom/media test and build warnings remain.
- **Source limitation:** `map-generator/assets/maps/hillbillyhead/image.png`
  is a 1x1 placeholder. The checked history for that path also only contains
  this placeholder. Gameplay uses the intact generated files, but the original
  full-resolution source image must be recovered before regenerating this map.
  Do not run an unrestricted `npm run gen-maps` or target `hillbillyhead` with
  the generator while that placeholder remains: it would overwrite usable
  terrain. The registry was updated to match the source metadata without
  running terrain generation.
- Adding the enum entry follows the generator's alphabetical ordering and
  changes later binary enum ordinals. Clients and servers must run the same
  rebuilt version, as required by the binary protocol.

## Music startup and playback controls follow-up

- Confirmed the reported silence came with Master at zero. Upstream's startup
  reset cleared existing audio choices; the playlist's Play path then returned
  immediately at zero output, including when invoked by a hotkey or media key.
- Replaced the destructive startup reset with migration of the fork's old
  two-slider settings. Existing music levels and modern channel choices are
  preserved; previously unchosen legacy effects stay silent.
- Explicit music Play now enables zero Master/Music sliders at their defaults
  and persists those levels. Nonzero levels and other settings are preserved.
  Automatic startup still honors mute settings. After refreshing the rebuilt
  client, press backslash or media Play once to recover from an already-applied
  reset; the previous erased slider value cannot be reconstructed.
- Media Session Play and Pause are now separate, idempotent actions. A click
  retries requested playback blocked by the browser, and Play resumes a
  suspended Web Audio graph even if the media element reports playing. Stop
  cancels pending startup, and disposal removes the playback handlers.
- Type checking, lint, production build, and 480 audio/settings/input tests
  pass. Live listening verification was unavailable because the browser access
  host was unavailable; tests simulate media events and the suspended context.
