import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { patchStatusDocument, patchStatusRenderer } from '../tools/patch-status-reader.js';
import { readProtocolBlock } from '../src/reader.js';
import { resolveAdapter } from '../src/adapters.js';

// The observed renderer's extraction and call sites, with neutral presentation stubs.
const legacy = String.raw`
        function extractMaintext(message) {
          if (!message || typeof message !== 'string') return '';
          const match = message.match(/<maintext>([\s\S]*?)<\/maintext>/i);
          return match ? match[1].trim() : '';
        }
        function extractStatusBlock(message) {
          if (!message || typeof message !== 'string') return '';

          const match = message.match(/<Status_block>\s*([\s\S]*?)\s*<\/Status_block>/i);
          return match ? cleanYamlContent(match[1].trim()) : '';
        }
        function cleanYamlContent(value) { return value; }
        function renderPageFromMessage(actualMessageData) {
          const messageContent = actualMessageData.message;
          const maintextContent = extractMaintext(messageContent);
          if (maintextContent) updateMaintext(maintextContent);
          const statusContent = extractStatusBlock(messageContent);
          if (statusContent) {
            updateYamlDataSource(statusContent);
            setTimeout(() => reRenderStatusBar(), 100);
          }
        }
`;
const real = 'record:\n  place: observatory';
const status = `<Status_block>${real}</Status_block>`;

function reader(template = legacy) {
    const state = { yaml: 'OLD', errors: [], renders: 0, narrative: '' };
    const context = vm.createContext({
        updateMaintext(text) { state.narrative = text; },
        updateYamlDataSource(text) { state.yaml = text; },
        reRenderStatusBar() { state.renders++; },
        setTimeout(callback) { callback(); },
        document: { getElementById: () => ({ set textContent(text) { state.yaml = text; } }) },
        StoryRenderer: class { handleError(error) { state.errors.push(error.message); } },
    });
    vm.runInContext(patchStatusRenderer(template), context);
    return { state, extract: text => context.extractStatusBlock(text),
        render: message => context.renderPageFromMessage({ message }) };
}

test('the installed reader selects real status without normalizing or deleting reasoning', () => {
    const { extract } = reader();
    for (const example of ['Use `<Status_block>...</Status_block>`.',
        '```yaml\n<Status_block>...</Status_block>\n```',
        '<!-- <Status_block>...</Status_block> -->',
        '<![CDATA[<Status_block>...</Status_block>]]>']) {
        const message = `<think>Plan.</think>\n<think_nya>\n${example}\n</think_nya>\n`
            + `<game>The chart was delivered.</game>\n${status}`;
        const before = message;
        assert.equal(extract(message), real);
        assert.equal(message, before);
    }
});

test('all supported reasoning families and nested wrappers stay opaque to the installed reader', () => {
    const { extract } = reader();
    for (const tag of ['think', 'thinking', 'think_nya', 'think_nya~', 'report_nya', 'report_nya~',
        'konatan_planning~', 'talk']) {
        const message = `<${tag}>\nUse \`<Status_block>...</Status_block>\`.\n</${tag}>\n${status}`;
        assert.equal(extract(message), real);
    }
    assert.equal(extract('<think>\n<think_nya>\nUse `<Status_block>...</Status_block>`.\n'
        + `</think_nya>\n</think>\n${status}`), real);
});

test('story, code, native comments and table literals cannot become status data', () => {
    const { extract } = reader();
    for (const example of ['<game>Use `<Status_block>...</Status_block>`.</game>',
        '```xml\n<Status_block>...</Status_block>\n```',
        '<!-- [IDE_AST_TRACE] <Status_block>...</Status_block> -->',
        '<tableEdit>insertRow(0,{"note":"<Status_block>...</Status_block>"});</tableEdit>']) {
        assert.equal(extract(`${example}\n${status}`), real);
        assert.equal(extract(example), '');
    }
});

test('multiple real blocks and ambiguous or incomplete boundaries fail instead of guessing', () => {
    const { extract } = reader();
    for (const message of [status + status, '<think_nya>Unfinished.\n' + status,
        '<Status_block>record:', '<!-- Unfinished.\n' + status,
        '```xml\n' + status, '</think>\n' + status,
        '<think_nya>\nUse a bare <Status_block> example.\n</think_nya>\n' + status,
        '<think_nya>\n<Status_block>...</Status_block>\n</think_nya>\n' + status]) {
        assert.throws(() => extract(message), /ambiguous|incomplete|multiple/i);
    }
});

test('unquoted nested status and body openers are ambiguous while quoted payload labels remain literal', () => {
    const { extract, render, state } = reader();
    assert.throws(() => extract('<Status_block>place: outer\nnote: <Status_block>inner</Status_block>'), /ambiguous|nested/i);
    render('<maintext>Outer <maintext>inner</maintext>' + status);
    assert.match(state.errors[0], /ambiguous|nested/i);
    assert.equal(state.yaml, '');
    assert.equal(extract('<Status_block>place: outer\nnote: "<Status_block>literal"</Status_block>'),
        'place: outer\nnote: "<Status_block>literal"');
});

test('indented code and Markdown table examples never supply state or hide a later real block', () => {
    const { extract } = reader();
    for (const example of ['    <Status_block>place: example</Status_block>',
        '\t<Status_block>place: example</Status_block>',
        ' \t<Status_block>place: example</Status_block>',
        '  \t<Status_block>place: example</Status_block>',
        '   \t<Status_block>place: example</Status_block>',
        '| example |\n| --- |\n| <Status_block>place: example</Status_block> |',
        'Example | Value\n--- | ---\nStatus | <Status_block>place: example</Status_block>']) {
        assert.equal(extract(example), '');
        assert.equal(extract(example + '\n\n' + status), real);
    }
});

test('rendering clears stale YAML and reports structural failures through the existing error UI', () => {
    const { render, state } = reader();
    render(`<maintext>The chart was delivered.</maintext>${status}`);
    assert.equal(state.yaml, real);
    assert.equal(state.narrative, 'The chart was delivered.');
    assert.equal(state.renders, 1);
    render(status + status);
    assert.equal(state.yaml, '');
    assert.equal(state.renders, 1);
    assert.match(state.errors[0], /multiple/i);
    render('<game>No status yet.</game>');
    assert.equal(state.yaml, '');
    assert.equal(state.renders, 2);
});

test('the body reader also ignores quoted examples in reasoning', () => {
    const { render, state } = reader();
    render('<think>\nUse `<maintext>EXAMPLE</maintext>`.\n</think>\n'
        + `<maintext>The chart was delivered.</maintext>${status}`);
    assert.equal(state.narrative, 'The chart was delivered.');
    assert.equal(state.yaml, real);
});

test('installation is idempotent and refuses unknown extraction or render templates', () => {
    const patched = patchStatusRenderer(legacy);
    assert.equal(patchStatusRenderer(patched), patched);
    assert.throws(() => patchStatusRenderer('An unrelated renderer.'), /unsupported/i);
    assert.throws(() => patchStatusRenderer(legacy.replace('setTimeout(() => reRenderStatusBar(), 100);',
        'customRender();')), /unsupported/i);
    assert.throws(() => patchStatusRenderer(patched.replace("contextHelperReadBlock(message, 'Status_block')", 'customReader(message)')),
        /unsupported/i);
    assert.throws(() => patchStatusRenderer(legacy + '\nfunction extractStatusBlock(message) { return "UNVALIDATED"; }'),
        /unsupported/i);
    assert.throws(() => patchStatusRenderer(patched + legacy), /unsupported/i);
    assert.throws(() => patchStatusRenderer(patched + '\nfunction extractMaintext(message) { return "UNVALIDATED"; }'),
        /unsupported/i);
});

test('the shared selector preserves exact payload bytes, accepts empty payloads and never selects the last duplicate', () => {
    const profile = resolveAdapter({ adapter: 'cat-god', cardProtocol: { bodyTags: [], statusTags: ['Status_block'] } });
    const payload = '\r\nrecord:\r\n  note: "Keep <thinking> and </Status_block> literal."\r\n';
    assert.equal(readProtocolBlock(`<Status_block>${payload}</Status_block>`, 'Status_block', profile).text, payload);
    assert.equal(readProtocolBlock('<Status_block></Status_block>', 'Status_block', profile).status, 'ok');
    assert.equal(readProtocolBlock('<Status_block>\n    record:\n      place: observatory\n    </Status_block>',
        'Status_block', profile).text, '\n    record:\n      place: observatory\n    ');
    assert.equal(readProtocolBlock(status + '<Status_block>OTHER</Status_block>', 'Status_block', profile).reason, 'multiple');
    for (const source of [undefined, null, '', 123]) assert.equal(readProtocolBlock(source, 'Status_block', profile).status, 'missing');
});

function writerFixture() {
    const rules = ['Integrated status', 'Status only'].map((scriptName, index) => ({
        id: `template-${index}`, scriptName, findRegex: '<Status_block>(.*?)</Status_block>',
        replaceString: legacy, disabled: true, markdownOnly: true, placement: [2],
    }));
    const names = ['一体式美化状态栏[元数据模板,勿动]', '美化状态栏[元数据模板,勿动]'];
    const entries = rules.map((rule, index) => ({ id: index + 21, comment: names[index],
        content: JSON.stringify(rule, null, 4), disable: true, enabled: false, keys: ['preserve-key'] }));
    entries.push({ id: 99, comment: 'An unrelated quoted example', content: legacy, disable: false });
    entries.push({ id: 100, comment: names[0] + ' copy', content: JSON.stringify(rules[0]), disable: true });
    return { rules, entries,
        card: { spec: 'chara_card_v3', data: { name: 'Neutral writer fixture', first_mes: 'Keep this greeting.',
            extensions: { world: 'Neutral linked world', regex_scripts: [] }, character_book: { entries } } },
        world: { entries: Object.fromEntries(entries.map(entry => [entry.id, entry])),
            originalData: { name: 'Neutral source book', entries: structuredClone(entries) }, unrelated: { keep: true } } };
}

test('writer templates export safe readers in both display modes without changing authoring data', () => {
    const fixture = writerFixture(), before = structuredClone(fixture);
    const result = patchStatusDocument(fixture.world);
    assert.equal(result.changed, true);
    assert.equal(result.templates, 4);
    const message = '<think_nya>\nUse `<Status_block>...</Status_block>`.\n</think_nya>\n' + status;
    for (const key of ['21', '22']) {
        const entry = result.document.entries[key], rule = JSON.parse(entry.content);
        const original = fixture.world.entries[key], originalRule = JSON.parse(original.content);
        assert.ok(rule.replaceString.includes('context-helper-status-reader:v1'));
        assert.deepEqual({ ...rule, replaceString: originalRule.replaceString }, originalRule);
        assert.equal(entry.content, original.content.replace(JSON.stringify(originalRule.replaceString),
            () => JSON.stringify(rule.replaceString)));
        assert.deepEqual({ ...entry, content: original.content }, original);
        assert.equal(reader(rule.replaceString).extract(message), real);
        assert.equal(result.document.originalData.entries.find(row => row.id === Number(key)).content, entry.content);
    }
    assert.deepEqual(result.document.entries['99'], fixture.world.entries['99']);
    assert.deepEqual(result.document.unrelated, fixture.world.unrelated);
    assert.deepEqual(fixture, before);
    const repeat = patchStatusDocument(result.document);
    assert.equal(repeat.changed, false);
    assert.deepEqual(repeat.document, result.document);
});

test('the embedded writer book carries the same safe templates as its linked source book', () => {
    const fixture = writerFixture(), before = structuredClone(fixture.card);
    const result = patchStatusDocument(fixture.card);
    const linked = patchStatusDocument(fixture.world);
    assert.equal(result.templates, 2);
    for (const entry of result.document.data.character_book.entries.filter(entry => entry.id < 99)) {
        assert.equal(entry.content, linked.document.entries[entry.id].content);
    }
    assert.deepEqual(result.document.data.character_book.entries.filter(entry => entry.id >= 99),
        fixture.card.data.character_book.entries.filter(entry => entry.id >= 99));
    assert.equal(result.document.data.first_mes, before.data.first_mes);
    assert.deepEqual(result.document.data.extensions, before.data.extensions);
    assert.deepEqual(fixture.card, before);
});

test('malformed or unsupported named writer templates reject the entire proposal before any mutation', () => {
    for (const content of ['not JSON', JSON.stringify({ replaceString: 'An unknown renderer.' })]) {
        const fixture = writerFixture();
        fixture.world.entries['22'].content = content;
        const before = structuredClone(fixture.world);
        assert.throws(() => patchStatusDocument(fixture.world), /unsupported|invalid/i);
        assert.deepEqual(fixture.world, before);
    }
});
