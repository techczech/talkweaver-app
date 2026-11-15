// Every check the journey makes, by stage, with a stable id and the claim it stands for. The runner requires
// every id of a stage to be reported exactly once in that stage's ledger (policy.mjs); a stage that skips a
// check, or records one twice, fails. A stage may also record `<stage>.harness` (always a FAIL: the script
// itself broke). COULD-NOT is allowed only for ids in could-not-allowed.mjs, under that file's conditions.

const printChecks = (route, label) => ({
  [`print.${route}.qr-address`]: `${label}: the title and closing pages carry the whole QR address`,
  [`print.${route}.own-text`]: `${label}: no printed page carries text that is not the talk's own`,
  [`print.${route}.video-page`]: `${label}: the video page prints its picture (not blank)`,
})

const scVariant = (v) => ({
  [`sc.${v}.leads`]: `${v}: each section divider has its lead (overrides on sections 2 and 4)`,
  [`sc.${v}.no-warning`]: `${v}: no section-colour warning`,
  [`sc.${v}.present-open`]: `${v}: the overrides do not block Present`,
})

const RETAKE_OFF = {
  'retake.editor-ready': 'the recording editor opens with its slides and camera pictures ready',
  'retake.not-offered': '"Record this slide again" is not offered while the feature is switched off',
}
const RETAKE_ON = {
  'retake.editor-ready': RETAKE_OFF['retake.editor-ready'],
  'retake.banner': '"Record this slide again" opens a presenter at that slide with the retake banner',
  'retake.no-resume-prompt': 'no "Resume from slide N?" prompt over a retake',
  'retake.on-slide': 'the presenter is on the retake slide when recording starts',
  'retake.saves': 'the take records and saves',
  'retake.choose': 'choose the new take',
  'retake.play-across': 'play across the new take',
  'retake.cut-after': 'cut words just after the new take',
  'retake.first-take': '"Use the first take" goes back to the original',
  'retake.undo-redo': 'undo and redo across the take choices',
}

export const CHECKS = {
  'section-colours': { ...scVariant('no-line'), ...scVariant('off'), ...scVariant('list') },
  'edit-present-share': {
    'open.lists-talk': 'the app starts on an empty profile and lists the temporary vault\'s two talks',
    'open.editor': 'the talk opens in the editor with its own text',
    'open.preview-steps': 'the editor preview (Inspector stage) moves three slides forward on three Next presses',
    'open.grid': 'the Grid view shows one cell per slide, and each draws its picture when in view',
    'open.slide-browser': 'the Slide Browser (⌘S) shows the other talk\'s slides without help',
    'open.edit-saved-and-previewed': 'a changed line is saved to disk and reaches the preview',
    'open.talk-tab': 'the Talk tab\'s fields hold the talk\'s title, subtitle and author',
    'open.section-colours-control': 'the Talk tab has a visible Section colours control',
    'present.presenter-opens': 'the action bar "Presenter view" opens the presenter window',
    'present.audience-opens': 'the audience window opens (with the presenter or by F5)',
    'present.idle-capture-choice': 'idle presenter bar at 1440×900 shows the capture choice',
    'present.walk-forward': 'the keyboard walks every slide and every reveal, focus, card and chat step forwards, in order',
    'present.walk-back': 'the keyboard walks every slide and step back to the start, in reverse order',
    'present.audience-matches-presenter': 'the presenter\'s preview and the audience window show the same slide and step at every press',
    'present.carousel': 'the carousel steps through its four cards, dots following',
    'present.legible-loop-steps': 'the loop and the step slide are legible at every step',
    'present.legible-other': 'every other slide is legible (no word split, no text over text, nothing outside the slide)',
    'present.timer-in-section': 'the audience timer shows on every step of its section',
    'present.timer-not-outside': 'the audience timer is not shown outside its section',
    'present.no-page-errors': 'no page errors in the presenter or audience window',
    'present.section-leads': 'section colours: each of the five sections has its lead (rotation, overrides as written)',
    'present.status-bar-1280': 'presenter at 1280 px: the status bar keeps its items',
    'present.qr-title': 'the title slide shows every character of the long QR address on screen',
    'present.qr-closing': 'the closing slide shows every character of the long QR address on screen',
    'present.mindmap-size': 'the mind map\'s drawn box uses most of its content area',
    'present.widget-visible': 'the embedded widget is visible in the audience window without full screen',
    'print.sim-restored': 'print with a simulation part-way and scrolled: same slide, step and scroll position after printing',
    ...printChecks('presenter', 'presenter route print'),
    'print.notes-guide-page': 'a printed page carries its slide\'s notes below the slide (guide picture)',
    'print.one-page-per-slide': 'the presenter\'s print gives exactly one page per slide (one per card on the carousel)',
    'print.notes': 'the deck print carries the speaker notes below their slides',
    'print.layout-intact': 'after printing, the presenter and audience screen layout is intact',
    'print.repeat-same': 'printing again gives the same pages with the same text',
    'share.offers-presentation': 'the Share menu offers the single-file presentation',
    'share.builds-presentation': 'Share builds the single-file presentation file',
    'share.offers-handout': 'the Share menu offers the handout',
    'share.builds-handout': 'Share builds the handout file',
    'share.presentation-steps': 'the single-file presentation opens in a browser and steps through every slide, without page errors',
    'share.handout-steps': 'the handout opens in a browser and steps through every one of its slides, each the expected slide with its pictures loaded, without page errors',
    'share.handout-no-notes': 'the handout carries no speaker notes',
    ...printChecks('saved-presentation', 'page.pdf() of the saved presentation'),
    'print.saved-presentation.pages': 'page.pdf() on the saved presentation gives one page per slide (one per carousel card)',
    ...printChecks('saved-handout', 'page.pdf() of the saved handout'),
    'print.saved-handout.pages': 'page.pdf() on the saved handout gives one page per slide (one per carousel card)',
  },
  record: {
    'record.offers-camera': 'the presenter offers Record with a camera choice',
    'record.device-check': 'the device check shows the fake camera\'s picture and enables Continue',
    'record.countdown': 'the countdown shows a number and ends, then recording starts',
    'record.status-1280-pause-stop': 'at 1280×800 while recording the status bar shows Pause and Stop',
    'record.audience-counts-1280': 'at 1280×800 while recording the audience counts show',
    'record.pause-resume': 'pause and resume',
    'record.six-slides': 'six or more slides with reveals presented while recording',
    'record.saved-note': 'saved note and recording cluster (one-line note, "Start again" as a button)',
    'record.clip-once': 'a slide-video play (M in the presenter) is saved once in the Run',
    'record.run-saved': 'stop saves a Run with camera and slides layers, complete',
    'record.transcript-fixture': 'the test-mode transcription writes its fixture words for the Run',
    'record.runs-view': 'the Run appears in the Runs view',
    'record.delivered-today': 'the main window shows the talk as delivered today',
  },
  edit: {
    'edit.transcript-is-fixture': 'the Run\'s transcript is the test-mode fixture the record stage checked (only then is a richer stand-in written)',
    'edit.run-opens': 'the Run opens in the Tools window with its slides and camera pictures ready',
    'edit.studio-place': 'Studio says the Run just recorded is "on this Mac" (its files are here), and the Run names this Mac as holding its recording',
    'edit.play': 'Play plays the recording (the playhead moves)',
    'edit.trim-start': '"Trim start here" sets the start at the playhead',
    'edit.trim-end': '"Trim end here" sets the end at the playhead',
    'edit.editor-opens': 'Edit video opens the editor with the slides, words and pictures ready',
    'edit.cut': 'select three words and cut them',
    'edit.leave-out': 'leave a slide out, then put it back',
    'edit.move-start': 'drag a slide\'s start to a pause: that slide\'s start moves to the gap before the word, no other slide start changes',
    'edit.start-at-sentence': '"Start at the sentence" is offered exactly where the transcript and slide marks call for it, and moves that slide\'s start to the sentence start',
    'edit.face-one': 'face position for one slide (Side by side): that slide changes, nothing else',
    'edit.face-range': 'face position for a run of slides (corner, large, slides N to N+2): those three change, nothing else',
    'edit.sheet-click-outside': 'a sheet closes with a click outside',
    'edit.face-whole': 'face position for the whole video (corner, large) replaces the per-slide choices',
    'edit.sheet-escape': 'a sheet closes with Escape',
    'edit.look-sound': 'even volume and smooth joins turn off and on',
    'edit.sheet-done': 'a sheet closes with Done',
    'edit.undo-redo': 'undo all edits back to the unedited Run (every editable field), then redo them all',
    'edit.saved-before-close': 'the editor\'s last edit is saved to disk before the app closes',
  },
  reopen: {
    'reopen.edits-kept': 'after closing and restarting the app every edit is as left',
  },
  export: {
    'export.editor-ready': 'the editor opens with its slides and camera pictures ready',
    'export.saves': 'Export… saves the video',
    'export.streams': 'the file has video and sound streams',
    'export.length': 'its length equals the editor\'s stated length within a frame (34 ms)',
    'export.decodes': 'it decodes fully from start to end',
    'export.chapters': 'the exported chapters are the sections shown in the kept video, in order (MP4 and chapter list)',
    'export.captions': 'the .srt and .vtt captions hold the kept words, in order, in timed cues inside the video',
    'export.second': 'after one more cut, a second export is shorter and matches the editor',
  },
  sentence: {
    'sentence.drag-label': 'dragging a slide start over a sentence start inside speech says "at a sentence start · needs a listen"',
    'sentence.row-note': 'a slide change inside speech starts at the sentence spoken across it (row says so)',
  },
  retake: RETAKE_OFF,
  // 0.45, second Mac: a second app instance on a second profile shares the vault (record-edit-export.mjs, phase second-mac).
  'second-mac': {
    'second-mac.ordinary-no-copy': 'an ordinary save on this Mac leaves no copy beside the edits; Kept edits lists the save it replaced as the previous save on this Mac',
    'second-mac.second-saves': 'a second app instance (its own profile and Mac name, the same vault) saves a change to the edits while the first has the editor open',
    'second-mac.first-saves-own': 'the first instance\'s next change is saved as its editor shows it, not refused, and names the first Mac',
    'second-mac.other-kept': 'the second instance\'s version is kept beside the edits as a copy, byte for byte',
    'second-mac.notice': 'the editor says the edits were also changed elsewhere, naming the other Mac and its TalkWeaver version',
    'second-mac.header-1000': 'at 1000 px the editor keeps one bar, with the Kept edits button in it and nothing overlapping',
    'second-mac.kept-listed': 'Kept edits lists the copy with when, which Mac and which TalkWeaver saved it, inside the window at 1000 px',
    'second-mac.opens-read-only': 'the kept copy opens read only: its edits shown, Undo and Export off, the file unchanged',
    'second-mac.restores': 'Restore makes the kept copy the edits; the edits it replaced are kept as another copy, and the restored copy stays',
  },
  // ADR-0044: the one click, on a loopback feed (updates.mjs). The file is downloaded and checked; a run from source
  // stops before installing and logs the restart (the real replacement: scripts/prove-in-place-update.mjs).
  updates: {
    'updates.mark': 'a feed offering a newer version shows the status-bar mark, and the popover offers Update',
    'updates.click-only': 'nothing is downloaded until Update is pressed: no request for the update file after the check, the mark and the popover',
    'updates.downloads-on-click': 'Update downloads the file once, with progress in the mark, and the app checks it against the feed\'s SHA-512',
    'updates.fits-1000': 'at 1000 px the popover fits inside the window and the status bar stays one line',
    'updates.restart-waits': 'while a presenter window is open the download finishes but nothing restarts, and Restart is refused',
    'updates.restart-after': 'presenting over, the mark reads "Restart to finish updating" and Restart restarts into the new version',
  },
  delete: {
    'delete.removes': 'Delete this Run (after asking) removes the Run file and its recordings folder',
    'delete.none-shown': 'the Runs view shows no Run afterwards',
  },
}

/** The ids a stage must report. ctx.recordAgain: "Record this slide again" switched on for this run. */
export function requiredIds(stage, ctx = {}) {
  if (stage === 'retake') return Object.keys(ctx.recordAgain ? RETAKE_ON : RETAKE_OFF)
  const c = CHECKS[stage]
  if (!c) throw new Error(`no checks registered for stage ${stage}`)
  return Object.keys(c)
}

export function claimOf(stage, id, ctx = {}) {
  if (id === `${stage}.harness`) return 'the stage script ran to the end'
  if (stage === 'retake') return (ctx.recordAgain ? RETAKE_ON : RETAKE_OFF)[id] ?? null
  return CHECKS[stage]?.[id] ?? null
}
