import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCardProtocol } from '../src/protocols.js';
import { resolveAdapter } from '../src/adapters.js';
import { analyzeSnapshot } from '../src/analysis.js';
import { extractNarrative, inspectTags, normalizeMessage } from '../src/tags.js';

test('generated-card body framing combines with each preset reasoning preference', () => {
    const cardProtocol = deriveCardProtocol({ name: 'Generated card', fields: {
        first_mes: '<maintext>The story.</maintext><Status_block>Place: hall</Status_block>',
    } });
    for (const presetName of ['Izumi', '小猫之神']) {
        const profile = resolveAdapter({ presetName, cardProtocol });
        const source = '<thinking>Plan.\n<maintext>The adviser already entered.</maintext>'
            + '<Status_block>Place: study</Status_block>';
        const fixed = normalizeMessage(source, profile);
        assert.ok(fixed.text.startsWith(`<${profile.reasoningTag}>`));
        assert.equal(extractNarrative(fixed.text, profile), 'The adviser already entered.');
        assert.equal(inspectTags(fixed.text, profile).blocks.find(block => block.lower === 'status_block').kind, 'data');
    }
});

test('writer template tags do not become mandatory current conversation tags', () => {
    const protocol = deriveCardProtocol({ name: '萧谴写卡助手版_V4.5.1', entries: [
        { comment: '状态栏格式', constant: true,
            content: '生成的卡必须用 <maintext>正文</maintext><Status_block>状态</Status_block>。<character_design_complex>input</character_design_complex>' },
    ] });
    assert.deepEqual(protocol.bodyTags, []);
    assert.deepEqual(protocol.requiredTags, []);
    assert.ok(protocol.evidence.every(entry => entry.confidence === 'template'));
    assert.ok(!protocol.bodyTags.includes('character_design_complex'));
    assert.ok(protocol.evidence.some(entry => entry.tag === 'character_design_complex' && entry.kind === 'generated-artifact'));
});

test('only unconditional declared output requirements produce missing-block warnings', () => {
    const cardProtocol = deriveCardProtocol({ name: 'MVU card', source: 'Linked book', entries: [
        { comment: '[mvu_update]变量输出格式', constant: true,
            content: '每次输出必须包含 <UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>' },
        { comment: '可选正文格式', constant: false, content: '必须包裹 <maintext>正文</maintext>' },
        { comment: '变量列表', constant: true, content: '<status_current_variables>Input state</status_current_variables>' },
        { comment: '停用输出格式', disable: true, constant: true, content: '必须 <game>Game</game>' },
    ] });
    const report = analyzeSnapshot({ presetName: 'Izumi', preset: {}, cardProtocol, start: 1, end: 1,
        chat: [{ mes: 'Greeting.' }, { mes: 'The adviser has entered.' }], tables: [] });
    const missing = report.issues.filter(issue => issue.code === 'missing-required-protocol');
    assert.equal(missing.length, 2);
    assert.ok(missing.every(issue => !issue.detail.startsWith('maintext:')));
    assert.ok(!cardProtocol.bodyTags.includes('game'));
    assert.ok(!JSON.stringify(cardProtocol).includes('"tag":"status_current_variables"'));
});

test('missing linked worldbook reports the limitation and retains embedded evidence', () => {
    const protocol = deriveCardProtocol({ name: 'Card', source: 'Missing book',
        fields: { first_mes: '<maintext>Greeting</maintext>' }, loadError: 'Unable to load' });
    assert.ok(protocol.bodyTags.includes('maintext'));
    assert.equal(protocol.warnings[0].code, 'worldbook-unavailable');
});

test('optional status blocks and negated examples never become unconditional requirements', () => {
    const protocol = deriveCardProtocol({ name: 'Generated card', entries: [
        { comment: '格式增强Plus', constant: true,
            content: '每次对话必须使用 <maintext>正文</maintext>。如果没有状态栏，那么移除 <Status_block>状态</Status_block>。' },
        { comment: 'Output format', constant: true,
            content: 'Never output <game> in replies. Input examples must remain literal.' },
    ] });
    assert.ok(protocol.requiredTags.includes('maintext'));
    assert.ok(!protocol.requiredTags.includes('Status_block'));
    assert.ok(!protocol.requiredTags.includes('game'));
});

test('quoted JSONPatch examples do not satisfy a real nested block requirement', () => {
    const cardProtocol = deriveCardProtocol({ name: 'MVU', entries: [
        { comment: 'Output format', constant: true, content: 'Always use <UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>' },
    ] });
    const report = analyzeSnapshot({ presetName: 'Izumi', preset: {}, cardProtocol, start: 1, end: 1,
        chat: [{ mes: 'Greeting.' }, { mes: '<UpdateVariable>{"note":"<JSONPatch>literal"}</UpdateVariable>' }], tables: [] });
    assert.ok(report.issues.some(issue => issue.code === 'missing-required-protocol' && issue.detail.startsWith('JSONPatch')));
    assert.ok(report.issues.some(issue => issue.code === 'invalid-patch'));
});
