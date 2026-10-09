import assert from 'node:assert/strict';
import { createPresenterShortcuts, presenterCodeChord, presenterChord } from '../compiler/assets/runtime/presenter-shortcuts.js';
import { SHORTCUT_REGISTRY } from '../src/shared/shortcut-registry.ts';
import { pointerPoint, pointerPixels, validPointer } from '../compiler/scripts/lib/pointer-overlay.mjs';
// stage-fit and preview iframe supply the fitted rect: bars lie outside it.
for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080], [900, 1000]]) {
    const scale = Math.min(width / 1280, height / 720);
    const rect = { left: (width - 1280 * scale) / 2, top: (height - 720 * scale) / 2, width: 1280 * scale, height: 720 * scale };
    for (const [x, y] of [[0, 0], [640, 360], [1280, 720], [321, 569]]) {
        const point = { x, y, space: 'slide' };
        const pixels = pointerPixels(point, rect);
        const mapped = pointerPoint(pixels.x, pixels.y, rect);
        assert.ok(Math.abs(mapped.x - x) < 1e-9 && Math.abs(mapped.y - y) < 1e-9);
    }
    assert.equal(pointerPoint(rect.left - 1, rect.top, rect), null);
    assert.equal(pointerPoint(rect.left, rect.top + rect.height + 1, rect), null);
}
for (const rect of [{ left: 10, top: 80, width: 400, height: 700 }, { left: 380, top: 30, width: 900, height: 300 }]) {
    const point = { x: .3, y: .8, space: 'image' };
    const pixel = pointerPixels(point, rect);
    assert.deepEqual(pointerPoint(pixel.x, pixel.y, rect, 'image'), point);
}
assert.equal(pointerPoint(0, 0, { left: 0, top: 0, width: 0, height: 1 }), null);
assert.equal(pointerPoint(NaN, 0, { left: 0, top: 0, width: 1, height: 1 }), null);
assert.ok(validPointer({ x: 1280, y: 720, space: 'slide', slideId: 'text' }));
assert.ok(validPointer('gone'));
for (const value of [null, {}, { x: Infinity, y: 1, space: 'slide', slideId: 'text' }, { x: 1.1,
        y: 0,
        space: 'image',
        slideId: 'image' }])
    assert.equal(validPointer(value), false);
console.log('PASS Pointer coordinates: four window sizes, bars, boundaries, zoomed images and round trips');
const commands = SHORTCUT_REGISTRY.filter(entry => entry.scope === 'presenter');
const values = new Map();
const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) };
const shortcuts = createPresenterShortcuts({ document: null, storage, commands, onChange() { } });
for (const command of commands) {
    if (command.id === 'presenter.pointer')
        continue;
    for (const code of command.codes) {
        assert.ok(shortcuts.taken(presenterCodeChord(code), 'presenter.pointer'), `${command.id}: ${code} is reserved`);
    }
}
for (const chord of ['1', '0', '-', '=', '?', '⇧?', '⌘Z']) {
    assert.ok(shortcuts.taken(chord, 'presenter.pointer'), `${chord} is already used`);
}
assert.equal(shortcuts.taken('Y', 'presenter.pointer'), null);
values.set('talkweaver:presenter:pointer-shortcut', 'Y');
const migrated = createPresenterShortcuts({ document: null, storage, commands, onChange() { } });
assert.equal(migrated.key('presenter.pointer', 'I'), 'Y / I');
assert.equal(values.has('talkweaver:presenter:pointer-shortcut'), false);
const loaded = createPresenterShortcuts({ document: null, storage, commands, onChange() { } });
assert.equal(loaded.key('presenter.pointer', 'I'), 'Y / I');
assert.equal(loaded.taken('Y', 'presenter.focus'), 'Pointer');
assert.equal(loaded.displaced, undefined);
assert.deepEqual(loaded.match({ key: 'y' }), { id: 'presenter.pointer', entryId: 'pointer' });
console.log('PASS presenter overrides: every registry default, template keys, current binding and legacy migration');

for (const chord of ['Space', 'Tab', 'Enter', 'Escape', '⌘A', '⌘C', '⌘W', '⌘Q', '⌃C', '⌥ArrowLeft']) {
    assert.ok(shortcuts.taken(chord, 'presenter.pointer'), `${chord} must be refused`);
}
for (const chord of ['⇧ArrowRight', '⇧ArrowLeft', '⇧Space', '⇧PageDown', '⇧PageUp', '⇧Enter', '⇧Tab', '⇧Home', '⇧End', 'Delete', '⇧Backspace', 'Home', 'PageDown']) {
    assert.ok(shortcuts.taken(chord, 'presenter.pointer'), `${chord} must be refused (navigation or editing key, shifted or not)`);
}
for (const chord of ['⇧H', '⇧I', 'F9', '.', ',']) {
    assert.equal(shortcuts.taken(chord, 'presenter.pointer'), null, `${chord} stays allowed`);
}
for (const key of ['Space', 'Tab', 'Enter', 'Escape', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'F1', 'F12', ',', '.', '/', '[', ']', '-', '=']) {
    assert.equal(presenterChord({ key: key === 'Space' ? ' ' : key }), presenterCodeChord(key));
}
assert.equal(presenterChord({ key: '<', code: 'Comma', shiftKey: true }), presenterCodeChord('Shift-,'));
assert.equal(presenterChord({ key: 'Dead', code: 'KeyE', altKey: true }), '⌥E');
assert.equal(presenterChord({ key: 'å', code: 'KeyA', altKey: true }), '⌥A');
for (const chord of ['<img onerror=x>', '⌘A', 'Space', 'Tab', 'H', '⇧⌘P']) {
    values.set('talkweaver:presenter:shortcuts', JSON.stringify({ 'presenter.pointer': { chord }, unknown: { chord: 'Y' } }));
    const invalid = createPresenterShortcuts({ document: null, storage, commands, onChange() {} });
    assert.equal(invalid.key('presenter.pointer', 'I'), 'I', chord);
    assert.equal(invalid.match({ key: 'y' }), null);
    assert.deepEqual(JSON.parse(values.get('talkweaver:presenter:shortcuts')), {});
}

values.set('talkweaver:presenter:shortcuts', JSON.stringify({
    'presenter.pointer': { chord: 'Y' }, 'presenter.focus': { chord: 'Y' },
    'palette.invented': { chord: 'D' }, 'unknown': { chord: 'N' }
}));
const colliding = createPresenterShortcuts({ document: null, storage, commands, onChange() {} });
assert.equal([colliding.key('presenter.focus', 'F'), colliding.key('presenter.pointer', 'I')].filter(key => key.startsWith('Y')).length, 1);
assert.equal(colliding.match({ key: 'd' }), null);
assert.equal(colliding.match({ key: 'n' }), null);
for (const target of ['input', 'textarea', 'select', 'contenteditable']) {
    assert.equal(colliding.match({ key: 'y', altKey: true, target: { closest: () => target } }), null);
}
console.log('PASS shortcut validation: reserved and malformed keys, collisions, Option/dead keys and typing guards');

values.set('talkweaver:presenter:shortcuts', JSON.stringify({ 'presenter.next': { chord: 'N' } }));
const nextKeys = createPresenterShortcuts({ document: null, storage, commands, onChange() {} });
assert.equal(nextKeys.key('presenter.next', '→'), `N / ${commands.find(command => command.id === 'presenter.next').keys}`);
