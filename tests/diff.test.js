import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTextDiff, diffText, splitUnchanged } from '../src/diff.js';

test('diff serialization preserves empty strings, whitespace and distinct structured values', () => {
    assert.equal(diffText(''), '');
    assert.equal(diffText('  \r\n'), '  \r\n');
    assert.equal(diffText(null), 'null');
    assert.equal(diffText(undefined), 'undefined');
    assert.equal(diffText({ place: '书房', rows: [['a', 1]] }), '{\n  "place": "书房",\n  "rows": [\n    [\n      "a",\n      1\n    ]\n  ]\n}');
});

test('folding keeps surrounding lines and preserves every byte including CRLF and final newlines', () => {
    for (const ending of ['\n', '\r\n']) {
        const text = Array.from({ length: 30 }, (_, i) => `Unchanged line ${i}${ending}`).join('');
        const parts = splitUnchanged(text);
        assert.equal(parts.head + parts.hidden + parts.tail, text);
        assert.ok(parts.head.includes('line 2'));
        assert.ok(parts.tail.includes('line 29'));
        assert.ok(parts.hidden.includes('line 15'));
    }
    assert.equal(splitUnchanged('A short unchanged paragraph.\n'), null);
});

test('long single-line context folds without splitting emoji or combining characters', () => {
    const text = '👩🏽‍💻e\u0301'.repeat(1000);
    const parts = splitUnchanged(text);
    assert.equal(parts.head + parts.hidden + parts.tail, text);
    for (const part of Object.values(parts)) {
        assert.ok(!/^[\uDC00-\uDFFF\u0301]|[\uD800-\uDBFF]$/.test(part));
    }
});

test('identical text skips the diff engine and retains the complete source', () => {
    const text = '<game>Already delivered.</game>\r\n';
    assert.deepEqual(buildTextDiff(text, text, null), { parts: [[0, text]], added: 0, removed: 0, coarse: false });
});

test('the native-engine boundary encodes whole graphemes and decodes equal and changed parts exactly', () => {
    const before = '猫👩🏽‍💻e\u0301', after = '猫👨🏽‍💻e\u0301';
    const engine = { diff_main(left, right, checkLines) {
        assert.equal(left.length, 3);
        assert.equal(right.length, 3);
        assert.equal(left[0], right[0]);
        assert.equal(left[2], right[2]);
        assert.equal(checkLines, false);
        return [[0, left[0]], [-1, left[1]], [1, right[1]], [0, left[2]]];
    } };
    const model = buildTextDiff(before, after, engine);
    assert.equal(model.parts.filter(([op]) => op !== 1).map(([, text]) => text).join(''), before);
    assert.equal(model.parts.filter(([op]) => op !== -1).map(([, text]) => text).join(''), after);
    assert.deepEqual(model.parts, [[0, '猫'], [-1, '👩🏽‍💻'], [1, '👨🏽‍💻'], [0, 'e\u0301']]);
    assert.equal(engine.Diff_Timeout, .15);
});

test('very large replacements bypass expensive diff work and remain complete', () => {
    const before = 'A'.repeat(100001), after = 'B'.repeat(100000);
    const model = buildTextDiff(before, after, null);
    assert.equal(model.coarse, true);
    assert.deepEqual(model.parts, [[-1, before], [1, after]]);
    assert.equal(model.added, after.length);
    assert.equal(model.removed, before.length);
});
