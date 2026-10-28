import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdapter } from '../src/adapters.js';
import { inspectTags, normalizeMessage, extractPatches, extractNarrative } from '../src/tags.js';

const izumi = resolveAdapter({ presetName: 'Izumi 1026.1' });

test('quoted protocol tags in nested planning cannot consume the following story', () => {
    const text = '<thinking><konatan_planning~>\nUse `<thinking>`, `<IzumiEdit>` and `<UpdateVariable>` later.\n'
        + '</konatan_planning~>\n</thinking><content>Already met the adviser.</content>\n'
        + '<UpdateVariable>\n<JSONPatch>[{"op":"replace","path":"/place","value":"study"}]</JSONPatch>\n</UpdateVariable>';
    const result = normalizeMessage(text, izumi);
    assert.notEqual(result.text, text);
    assert.equal(extractNarrative(result.text, izumi), 'Already met the adviser.');
    assert.equal(extractPatches(result.text, izumi)[0].value, 'study');
    assert.equal(inspectTags(result.text, izumi).issues.filter(x => x.severity === 'error').length, 0);
    assert.ok(!result.text.includes('`<thinking>`'));
});

test('a closed inner planning block provides a boundary for an unclosed legacy outer wrapper', () => {
    const text = '<thinking><konatan_planning~>\nA plan with `<thinking>`.\n</konatan_planning~>\n'
        + '<tucao>Comment.</tucao>\nThe adviser has already entered.\n'
        + '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
    const result = normalizeMessage(text, izumi);
    assert.ok(result.text.includes('The adviser has already entered.'));
    assert.ok(result.text.startsWith('<konatan_planning~>'));
    assert.ok(!result.text.startsWith('<thinking>'));
    assert.equal(extractPatches(result.text, izumi).length, 0);
});

test('literal code outside planning and JSON strings inside updates stay byte-for-byte intact', () => {
    const text = 'A literal `<thinking>` example.\n```xml\n<thinking>example</thinking>\n```\n'
        + '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/note","value":"<thinking>literal</thinking>"}]</JSONPatch></UpdateVariable>';
    assert.equal(normalizeMessage(text, izumi).text, text);
    assert.equal(extractPatches(text, izumi)[0].value, '<thinking>literal</thinking>');
});

test('ambiguous unfinished reasoning is reported without truncating prose', () => {
    const text = '<thinking>Unfinished text without a reliable body boundary.';
    const result = normalizeMessage(text, izumi);
    assert.equal(result.text, text);
    assert.ok(inspectTags(text, izumi).issues.some(x => x.code === 'unclosed-reasoning'));
});

test('protocol terminators inside JSON strings do not close a real update block', () => {
    const value = 'Literal </JSONPatch> and </UpdateVariable> in a saved note.';
    const text = '<UpdateVariable><JSONPatch>'
        + JSON.stringify([{ op: 'replace', path: '/note', value }])
        + '</JSONPatch></UpdateVariable>';
    assert.equal(extractPatches(text, izumi)[0].value, value);
    assert.equal(normalizeMessage(text, izumi).text, text);
});

test('an unfinished wrapper cannot turn unwrapped narrative into hidden reasoning', () => {
    const text = '<thinking>Plan.\nThe adviser has already entered.\n'
        + '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
    assert.equal(normalizeMessage(text, izumi).text, text);
    assert.ok(inspectTags(text, izumi).issues.some(issue => issue.code === 'unclosed-reasoning'));
});

test('long Markdown fences end at the matching run before a real variable update', () => {
    const text = '````xml\n<thinking>literal</thinking>\n````\n'
        + '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/x","value":1}]</JSONPatch></UpdateVariable>';
    assert.equal(extractPatches(text, izumi).length, 1);
});

test('cat-god and renamed presets use enabled content to choose their own format', () => {
    const cat = resolveAdapter({ presetName: 'Local', preset: { prompts: [
        { identifier: 'cat', content: 'Use <think_nya~> and <game>.' },
    ], prompt_order: [{ order: [{ identifier: 'cat', enabled: true }] }] } });
    assert.equal(cat.id, 'cat-god');
    assert.equal(extractNarrative('<think_nya~>Plan</think_nya~><game>Story</game>', cat), 'Story');
    assert.equal(resolveAdapter({ presetName: 'My unrelated preset' }).id, 'generic');
});

test('inline bare tag examples in reasoning do not terminate the real planning block', () => {
    const source = '<thinking>Use <thinking> later, and </thinking> is an example.\n'
        + 'Keep this planning sentence.\n</thinking><content>The introduction is complete.</content>';
    const fixed = normalizeMessage(source, izumi);
    assert.equal(extractNarrative(fixed.text, izumi), 'The introduction is complete.');
    assert.ok(fixed.text.includes('Keep this planning sentence.'));
    assert.ok(fixed.text.includes('&lt;/thinking&gt; is an example.'));
    assert.equal(normalizeMessage(fixed.text, izumi).text, fixed.text);
});

test('normalization retains text around nested wrappers and unmatched inline Markdown ticks', () => {
    const source = '<thinking>Outer plan.\n<konatan_planning~>Inner plan with an unmatched `.\n'
        + '</konatan_planning~>Outer tail.\n</thinking><content>Story.</content>';
    const fixed = normalizeMessage(source, izumi);
    assert.ok(fixed.text.includes('Outer plan.'));
    assert.ok(fixed.text.includes('Inner plan'));
    assert.ok(fixed.text.includes('Outer tail.'));
    assert.equal(extractNarrative(fixed.text, izumi), 'Story.');
});

test('a previous completed reasoning block is not evidence for closing a later unfinished one', () => {
    const source = '<thinking>Earlier.</thinking>\n<thinking>Unfinished plan and story.\n'
        + '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
    assert.ok(normalizeMessage(source, izumi).text.includes('<thinking>Unfinished plan and story.'));
    const open = inspectTags(source, izumi).blocks.find(block => block.kind === 'reasoning' && !block.closed);
    assert.equal(open.recoverable, false);
});

test('body terminators inside code examples cannot truncate extracted narrative', () => {
    const source = '<content>Use `</content>` literally.\n````xml\n</content>\n````\nStory continues.</content>';
    assert.equal(extractNarrative(source, izumi), 'Use `</content>` literally.\n````xml\n</content>\n````\nStory continues.');
});

test('missing body and fenced-code terminators have actionable diagnostics', () => {
    assert.ok(inspectTags('<content>Incomplete story.', izumi).issues.some(issue => issue.code === 'unclosed-body'));
    const source = '<thinking>Plan.\n```xml\n<content>Example</content>';
    assert.equal(normalizeMessage(source, izumi).text, source);
    assert.ok(inspectTags(source, izumi).issues.some(issue => issue.code === 'unclosed-code-fence'));
});

test('single-quoted and typographic quoted protocol examples stay opaque', () => {
    const source = '<thinking>Use \'<thinking>\' or “</thinking>” as examples.\n</thinking>'
        + '<content>Story.</content><tableEdit>insertRow(0, {\'1\':\'literal </tableEdit>\'})</tableEdit>';
    const normalized = normalizeMessage(source, izumi).text;
    assert.equal(extractNarrative(normalized, izumi), 'Story.');
    const table = inspectTags(normalized, izumi).blocks.find(block => block.lower === 'tableedit');
    assert.equal(normalized.slice(table.bodyStart, table.bodyEnd), 'insertRow(0, {\'1\':\'literal </tableEdit>\'})');
});

test('mixed XML, attributes, comments and CDATA cannot terminate either preset reasoning wrapper', () => {
    for (const presetName of ['Izumi', '小猫之神']) {
        const profile = resolveAdapter({ presetName });
        const source = '<thinking>Plan <foo id="x"><bar>note</bar></foo> then <role/>.\n'
            + '<!--\n</thinking>\n<UpdateVariable>comment only</UpdateVariable>\n-->\n'
            + '<![CDATA[\n</thinking>\n<content>example</content>\n<UpdateVariable>literal</UpdateVariable>\n]]>\n'
            + '<unknown key="a > b">Keep planning.</unknown>\n</thinking><content>Already introduced.</content>'
            + '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/note","value":"</thinking>"}]</JSONPatch></UpdateVariable>';
        const fixed = normalizeMessage(source, profile);
        assert.equal(extractNarrative(fixed.text, profile), 'Already introduced.');
        assert.equal(extractPatches(fixed.text, profile).length, 1);
        assert.equal(extractPatches(fixed.text, profile)[0].value, '</thinking>');
        const thinking = inspectTags(fixed.text, profile).blocks.find(block => block.kind === 'reasoning');
        const body = fixed.text.slice(thinking.bodyStart, thinking.bodyEnd);
        assert.ok(!body.includes('<') && !body.includes('>'));
        assert.ok(body.includes('Keep planning.'));
        assert.equal(normalizeMessage(fixed.text, profile).text, fixed.text);
    }
});

test('standalone bare terminators that conflict with later closes need AI boundary review', () => {
    const source = '<thinking>Plan.\n<example>\n</thinking>\n</example>\nKeep planning.\n'
        + '</thinking><content>Already introduced.</content>';
    assert.equal(normalizeMessage(source, izumi).text, source);
    assert.ok(inspectTags(source, izumi).issues.some(issue => issue.code === 'orphan-close'));
});

test('unclosed XML literal regions cannot expose apparent story or update boundaries', () => {
    for (const opener of ['<!--', '<![CDATA[']) {
        const source = '<thinking>Plan.\n' + opener + '\n<content>Example</content>\n</thinking>';
        assert.equal(normalizeMessage(source, izumi).text, source);
        assert.ok(inspectTags(source, izumi).issues.some(issue => issue.code === 'unclosed-xml-literal'));
        assert.ok(inspectTags(source, izumi).issues.some(issue => issue.code === 'unclosed-reasoning'));
    }
});
