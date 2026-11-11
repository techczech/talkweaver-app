// Which microphone a recording uses (src/shared/microphone-choice.ts; 9 Nov 2026 incident: a room
// AV system became the Mac's default input and a resume opened it instead of the laptop mic).
// Over fake device lists as Chromium on a Mac gives them:
//  1. the Microphone menu lists real inputs by name, never the "default"/"communications" entries;
//  2. Record uses the chosen device when connected, else the Mac's built-in microphone (naming the
//     missing one, so the presenter is told), else nothing: never the system's current input, never
//     the first one, never a guess from a list without names;
//  3. the recorder opens exactly one device ({ exact }) and a reconnect finds only that same device:
//     by deviceId, then groupId, then name; never another input, never the moving "default";
//  4. a newly connected input is offered once per session, never the one in use, never at baseline.
import assert from 'node:assert/strict'
import {
  audioInputs, createNewInputWatch, defaultInput, exactInputConstraints, findSameInput, inputForRecording, inputName, isBuiltIn, microphoneMenu, microphoneSettingOptions, needsPermission
} from '../src/shared/microphone-choice.ts'

let count = 0
const pass = (name) => console.log(`ok ${++count}. ${name}`)
const dev = (deviceId, label, groupId = `g-${deviceId}`, kind = 'audioinput') => ({ kind, deviceId, groupId, label })

const LAPTOP = dev('mbp', 'MacBook Pro Microphone (Built-in)')
const asInput = ({ deviceId, groupId, label }) => ({ deviceId, groupId, label })
const EXTRON = dev('extron', 'Extron USB Audio (2b55:0001)')
const AIRPODS = dev('airpods', 'AirPods Pro (Bluetooth)')
// The room system plugged in has become the system default.
const roomDay = [
  dev('default', 'Default - Extron USB Audio (2b55:0001)', 'g-extron'),
  dev('communications', 'Communications - Extron USB Audio (2b55:0001)', 'g-extron'),
  LAPTOP, EXTRON, AIRPODS,
  dev('spk', 'MacBook Pro Speakers (Built-in)', 'g-mbp', 'audiooutput')
]

// 1.
assert.deepEqual(audioInputs(roomDay).map((i) => i.deviceId), ['mbp', 'extron', 'airpods'])
assert.deepEqual(audioInputs([dev('default', 'Default - MacBook Pro Microphone', 'g1')]), [], 'a default entry alone is not an input')
assert.deepEqual(audioInputs([dev('', '', '')]), [], 'an entry without an id (no permission yet) is not an input')
assert.equal(needsPermission([dev('default', 'Default - X', 'g1')]), true, 'only a default entry: ask for permission and list again')
assert.equal(needsPermission([dev('mbp', ''), dev('ex', '')]), true, 'no names: ask for permission and list again')
assert.equal(needsPermission(roomDay), false)
assert.equal(inputName({ label: 'Default - MacBook Pro Microphone (Built-in)' }), 'MacBook Pro Microphone (Built-in)')
assert.deepEqual(microphoneMenu(audioInputs(roomDay), LAPTOP).map((r) => [r.name, r.selected]), [
  ['MacBook Pro Microphone (Built-in)', true], ['Extron USB Audio (2b55:0001)', false], ['AirPods Pro (Bluetooth)', false]
])
assert.deepEqual(microphoneMenu(audioInputs([LAPTOP]), EXTRON).map((r) => [r.name, r.selected, r.missing]), [
  ['Extron USB Audio (2b55:0001)', true, true], ['MacBook Pro Microphone (Built-in)', false, false]
], 'a chosen device that is not connected is shown as chosen and missing, not swapped')
assert.deepEqual(microphoneSettingOptions(audioInputs(roomDay), 'Gone USB Mic').map((o) => o.label), [
  'Built-in microphone', 'MacBook Pro Microphone (Built-in)', 'Extron USB Audio (2b55:0001)', 'AirPods Pro (Bluetooth)', 'Gone USB Mic (not connected)'
], 'Settings lists the same inputs; a remembered one not connected stays, marked')
pass('the menu lists real inputs by name, never the moving default entries')

// 2.
assert.equal(defaultInput(roomDay)?.deviceId, 'mbp', 'the built-in microphone, although the room system is the system default')
assert.equal(defaultInput(roomDay, 'AirPods Pro (Bluetooth)')?.deviceId, 'airpods', 'the remembered device when connected')
assert.equal(defaultInput(roomDay, 'Gone USB Mic')?.deviceId, 'mbp', 'a remembered device not connected: the built-in one')
assert.ok(isBuiltIn({ label: 'Built-in Microphone' }) && isBuiltIn({ label: 'iMac Microphone' }) && !isBuiltIn(EXTRON))
const jackFirst = [dev('jack', 'External Microphone (Built-in)'), LAPTOP]
assert.equal(defaultInput(jackFirst)?.deviceId, 'mbp', 'the Mac\'s own microphone before a headset in the jack')
const mini = [dev('default', 'Default - Studio Display Microphone', 'g-sd'), dev('usb', 'Yeti Stereo Microphone', 'g-yeti'), dev('sd', 'Studio Display Microphone', 'g-sd')]
assert.equal(defaultInput(mini), null, 'no built-in input: nothing, never the system default')
assert.equal(defaultInput([dev('a', 'One'), dev('b', 'Two')]), null, 'never the first one')
assert.equal(defaultInput([dev('mbp', ''), dev('ex', '')]), null, 'no names: no guess')
assert.equal(defaultInput([]), null)
assert.deepEqual(inputForRecording(roomDay, 'Gone USB Mic'), { input: asInput(LAPTOP), missing: 'Gone USB Mic' }, 'the remembered one is missing: the built-in one, naming the missing one')
assert.deepEqual(inputForRecording(roomDay, 'AirPods Pro (Bluetooth)'), { input: asInput(AIRPODS), missing: '' })
assert.deepEqual(inputForRecording(roomDay, '', EXTRON), { input: asInput(EXTRON), missing: '' }, 'this session\'s pick wins')
assert.deepEqual(inputForRecording([LAPTOP, AIRPODS], 'AirPods Pro (Bluetooth)', EXTRON), { input: asInput(LAPTOP), missing: 'Extron USB Audio (2b55:0001)' }, 'this session\'s pick unplugged: built-in, told')
assert.equal(inputForRecording(mini, 'Gone USB Mic'), null, 'missing and no built-in: the presenter picks')
assert.equal(inputForRecording([dev('default', 'Default - MacBook Pro Microphone (Built-in)', 'g-mbp')], ''), null, 'a default entry alone is never recorded')
pass('Record: chosen, else the built-in microphone with a notice, else nothing')

// 3.
assert.deepEqual(exactInputConstraints(LAPTOP), { audio: { deviceId: { exact: 'mbp' } } })
const chosen = audioInputs(roomDay)[0]
// The laptop mic is still there after the room system took over the default: the same device.
assert.equal(findSameInput(audioInputs(roomDay), chosen)?.deviceId, 'mbp')
// Unplugged: gone, and nothing else is offered in its place.
assert.equal(findSameInput(audioInputs([dev('default', 'Default - Extron USB Audio', 'g-extron'), EXTRON]), chosen), null)
assert.equal(findSameInput(audioInputs([dev('default', 'Default - Extron USB Audio', 'g-extron')]), EXTRON), null, 'never the default entry by group')
// Back with a new deviceId: found by group, or by name when the group changed too.
assert.equal(findSameInput([dev('extron-2', 'Extron USB Audio (2b55:0001)', 'g-extron')], EXTRON)?.deviceId, 'extron-2')
assert.equal(findSameInput([LAPTOP, dev('extron-3', 'Extron USB Audio (2b55:0001)', 'g-new')], EXTRON)?.deviceId, 'extron-3')
assert.equal(findSameInput([LAPTOP], null), null)
const pseudo = dev('default', 'Default - MacBook Pro Microphone (Built-in)', 'g-mbp')
assert.equal(findSameInput([pseudo, LAPTOP], pseudo), null, 'a default entry is never an identity, even when listed again')
assert.equal(findSameInput([pseudo], LAPTOP), null, 'never found as the default entry by id, group or name')
pass('a reconnect finds only the same device: id, then group, then name; never another input')

// 4.
const watch = createNewInputWatch()
assert.deepEqual(watch.observe(audioInputs([dev('default', '', '')])), [], 'no names yet: nothing is offered, no baseline')
assert.deepEqual(watch.observe(audioInputs([LAPTOP, AIRPODS]), LAPTOP), [], 'the first named list is the baseline')
assert.deepEqual(watch.observe(audioInputs(roomDay), LAPTOP).map((i) => i.deviceId), ['extron'], 'the room system is offered')
assert.deepEqual(watch.observe(audioInputs(roomDay), LAPTOP), [], 'once')
assert.deepEqual(watch.observe(audioInputs([LAPTOP]), LAPTOP), [], 'unplugged')
assert.deepEqual(watch.observe(audioInputs([LAPTOP, dev('extron-2', 'Extron USB Audio (2b55:0001)', 'g-extron')]), LAPTOP), [], 'plugged in again: not offered again')
const w2 = createNewInputWatch()
w2.observe(audioInputs([LAPTOP]))
assert.deepEqual(w2.observe(audioInputs([LAPTOP, EXTRON]), EXTRON), [], 'not the device already in use')
pass('a new input is offered once per session, never the one in use')

console.log('microphone-choice: all checks passed')
