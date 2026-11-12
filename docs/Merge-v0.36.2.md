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
