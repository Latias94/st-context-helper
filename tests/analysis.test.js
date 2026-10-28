import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSnapshot, traceRegexMessage } from '../src/analysis.js';

test('diagnosis identifies recent narrative loss and names the responsible regex', () => {
    const snapshot = {
        start: 0, end: 0, presetName: 'Izumi', preset: {}, metadata: {}, tables: [],
        chat: [{ mes: '<content>The adviser has already entered the study and finished the introduction.</content>', is_user: false }],
    };
    const report = analyzeSnapshot(snapshot, {
        traceMessage: () => ({ text: 'Plan: introduce the adviser.', trace: [
            { name: 'bad cleanup', source: 'preset', before: 94, after: 27, removed: 67 },
        ] }),
    });
    assert.ok(report.issues.some(issue => issue.code === 'narrative-loss' && issue.messageId === 0));
    assert.equal(report.messages[0].trace[0].name, 'bad cleanup');
    assert.equal(report.prompt.kind, 'simulated');
    assert.ok(report.prompt.note.includes('不是完整请求'));
});

test('captured messages retain their actual order and are distinguished from simulated history', () => {
    const captured = { stage: 'chat_completion_settings_ready', capturedAt: '2026-10-28',
        messages: [{ role: 'system', content: 'World.' }, { role: 'user', content: 'Now.' }] };
    const report = analyzeSnapshot({ start: 0, end: 0, presetName: 'Izumi', preset: {}, metadata: {},
        chat: [{ mes: 'Original.', is_user: true }], tables: [] }, { promptCapture: captured });
    assert.equal(report.prompt.kind, 'captured');
    assert.deepEqual(report.prompt.messages.map(message => message.role), ['system', 'user']);
});

test('normal-send depth excludes hidden messages and starts the newest floor at zero', () => {
    const depths = [];
    const snapshot = { start: 0, end: 2, chat: [{ mes: 'Old.' }, { mes: 'Hidden.', is_system: true },
        { mes: 'New.', is_user: true }], preset: {}, tables: [] };
    const report = analyzeSnapshot(snapshot, { traceMessage: (text, placement, depth) => {
        depths.push(depth);
        return { text, trace: [] };
    } });
    assert.deepEqual(depths, [1, 0]);
    assert.equal(report.messages[1].projected, '');
});

test('negative native maxDepth means unlimited rather than discarding the rule', () => {
    const rule = { promptOnly: true, placement: [2], maxDepth: -1, minDepth: null, scriptName: 'Unlimited' };
    assert.equal(traceRegexMessage('Source', 2, 3, [rule], () => 'Output').text, 'Output');
});

const narrative = 'The adviser has already entered the study, completed the introduction, and started discussing the next matter.';
const runSimpleRule = (rule, text) => {
    const match = /^\/(.*)\/([a-z]*)$/.exec(rule.findRegex);
    return text.replace(new RegExp(match[1], match[2]), rule.replaceString);
};
const limit = { id: 'limit', scriptName: '上下文限制[10]', contextHelperKey: 'global:0:limit',
    contextHelperSource: 'global', findRegex: '/[\\s\\S]*/gm', replaceString: '',
    minDepth: 10, maxDepth: null, placement: [1, 2], promptOnly: true };
function diagnoseRules(scripts, { text = `<content>${narrative}</content>`, depth = 10, user = false } = {}) {
    const snapshot = { presetName: 'Izumi', preset: {}, metadata: {}, tables: [], start: 0, end: 0,
        chat: [{ mes: text, is_user: user }, ...Array.from({ length: depth }, () => ({ mes: 'Later.' }))] };
    return analyzeSnapshot(snapshot, { traceMessage: (text, placement, depth, evidence) =>
        traceRegexMessage(text, placement, depth, scripts, runSimpleRule, evidence) });
}

test('the actual depth-10 global limit produces one actionable policy item for old assistant and user floors', () => {
    for (const user of [false, true]) {
        const report = diagnoseRules([limit], { user });
        assert.deepEqual(report.issues.map(issue => issue.code), ['history-trim-policy']);
        assert.equal(report.issues[0].severity, 'info');
        assert.equal(report.issues[0].ruleKey, 'global:0:limit');
        assert.ok(report.issues[0].detail.includes('10'));
        assert.ok(report.issues[0].recommendation.includes('标签修复不会改变它'));
        assert.equal(report.stats.policyTrimmedMessages, 1);
    }
    assert.equal(diagnoseRules([limit], { depth: 9 }).issues.length, 0);
    assert.equal(diagnoseRules([{ ...limit, disabled: true }]).issues.length, 0);
    assert.equal(diagnoseRules([limit], { text: 'A short reply.' }).issues[0].code, 'history-trim-policy');
});

test('small literal-word filters and supplementary markup do not masquerade as erased scenes', () => {
    const words = { ...limit, scriptName: 'Word cleanup', minDepth: null,
        findRegex: '/极其|由于|共犯|并不存在的/g' };
    const prose = narrative + ' The meeting is 极其 calm.';
    assert.ok(!diagnoseRules([words], { text: '<content>' + prose + '</content>', depth: 0 })
        .issues.some(issue => issue.code === 'narrative-loss'));
    const aside = { ...words, scriptName: 'Hide aside', findRegex: '/<tucao>[\\s\\S]*?<\\/tucao>/g' };
    assert.ok(!diagnoseRules([aside], { text: '<tucao>Commentary.</tucao>\n' + narrative, depth: 0 })
        .issues.some(issue => issue.code === 'narrative-loss'));
    const tooMuch = { ...words, findRegex: '/adviser/g' };
    assert.ok(diagnoseRules([tooMuch], { text: '<content>' + 'The adviser '.repeat(10) + '</content>', depth: 0 })
        .issues.some(issue => issue.code === 'narrative-loss'));
});

test('disjoint narrative spans separated by status and memory blocks remain individually visible', () => {
    const edits = [
        { ...limit, minDepth: null, scriptName: 'Hide table', findRegex: '/<tableEdit>[\\s\\S]*?<\\/tableEdit>/g' },
        { ...limit, minDepth: null, scriptName: 'Hide status', findRegex: '/<StatusPlaceHolderImpl\\/>/g' },
        { ...limit, minDepth: null, scriptName: 'Hide aside', findRegex: '/<tucao>[\\s\\S]*?<\\/tucao>/g' },
    ];
    const text = '<tucao>Supplementary aside.</tucao>' + narrative + '<StatusPlaceHolderImpl/>'
        + '<tableEdit>insertRow(0,{"0":"data"})</tableEdit>The story continues after the table.';
    const report = diagnoseRules(edits, { depth: 0, text });
    assert.ok(!report.issues.some(issue => issue.code === 'narrative-loss'));
    const truncated = diagnoseRules([...edits, { ...limit, minDepth: null, scriptName: 'Bad story cleanup',
        findRegex: '/The story continues after the table\\./g' }], { depth: 0, text });
    assert.ok(truncated.issues.some(issue => issue.code === 'narrative-loss' && issue.rule === 'Bad story cleanup'));
});

test('a named context limit cannot exempt partial body deletion or unbounded latest-message erasure', () => {
    const partial = { ...limit, findRegex: '/<content>[\\s\\S]*?<\\/content>/g' };
    assert.ok(diagnoseRules([partial]).issues.some(issue => issue.code === 'narrative-loss' && issue.severity === 'error'));
    for (const minDepth of [null, 0]) {
        const report = diagnoseRules([{ ...limit, minDepth }], { depth: 0, text: 'Short user command.', user: true });
        assert.ok(report.issues.some(issue => issue.code === 'history-erased' && issue.severity === 'warning'));
        assert.ok(!report.issues.some(issue => issue.category === 'policy'));
    }
});

test('real source errors and earlier accidental narrative deletion remain visible beside a later trim policy', () => {
    const broken = diagnoseRules([limit], { text: '<thinking>Plan.\n<content>' + narrative + '</content>' });
    assert.ok(broken.issues.some(issue => issue.code === 'unclosed-reasoning'));
    assert.ok(broken.issues.some(issue => issue.code === 'history-trim-policy'));
    const bad = { ...limit, minDepth: null, scriptName: 'Bad cleanup',
        findRegex: '/<content>[\\s\\S]*?<\\/content>/g', contextHelperKey: 'global:1:bad' };
    const earlierLoss = diagnoseRules([bad, limit], { text: '<content>' + narrative + '</content>Extra.' });
    assert.ok(earlierLoss.issues.some(issue => issue.code === 'narrative-loss' && issue.rule === 'Bad cleanup'));
    assert.ok(!earlierLoss.issues.some(issue => issue.code === 'history-trim-policy'));
});

test('known progress retention is a policy only when real source summary content survives', () => {
    const summary = { ...limit, scriptName: '9只保留Progress(11楼后)', minDepth: 11,
        findRegex: '/([\\s\\S]*?)(<progress>[\\s\\S]*?<\\/progress>)([\\s\\S]*?$)/g', replaceString: '$2' };
    const report = diagnoseRules([summary], { depth: 11,
        text: '<content>' + narrative + '</content><progress>The introduction is complete.</progress>' });
    assert.equal(report.issues.find(issue => issue.code === 'history-trim-policy')?.severity, 'info');
    assert.ok(report.issues[0].detail.includes('保留摘要'));
    const forged = diagnoseRules([{ ...summary, replaceString: '<progress>Invented.</progress>' }], {
        depth: 11, text: '<content>' + narrative + '</content><progress>Original.</progress>',
    });
    assert.ok(forged.issues.some(issue => issue.code === 'narrative-loss'));
    const quoted = diagnoseRules([summary], { depth: 11,
        text: '<content>' + narrative + '</content> `<progress>Example only.</progress>`' });
    assert.ok(quoted.issues.some(issue => issue.code === 'narrative-loss'));
});

test('summary-policy evidence must survive later rules and come from outside reasoning or details', () => {
    const summary = { ...limit, scriptName: 'Keep progress', minDepth: 11,
        findRegex: '/([\\s\\S]*?)(<progress>[\\s\\S]*?<\\/progress>)([\\s\\S]*?$)/g', replaceString: '$2' };
    const eraseSummary = { ...limit, scriptName: 'Delete progress', minDepth: null,
        findRegex: '/<progress>[\\s\\S]*?<\\/progress>/g', contextHelperKey: 'character:0:erase' };
    const erased = diagnoseRules([summary, eraseSummary], { depth: 11,
        text: '<content>' + narrative + '</content><progress>Original summary.</progress>' });
    assert.ok(erased.issues.some(issue => issue.code === 'narrative-loss' && issue.rule === 'Delete progress'));
    assert.ok(!erased.issues.some(issue => issue.code === 'history-trim-policy'));
    for (const text of [
        '<thinking>Planning example: <progress>EXAMPLE_ONLY</progress>\n</thinking><content>' + narrative + '</content>',
        '<content>' + narrative + '</content><DETAILS><summary>Heading</summary><progress>INSIDE_DETAILS</progress></DETAILS>',
    ]) {
        const report = diagnoseRules([summary], { depth: 11, text });
        assert.ok(report.issues.some(issue => issue.code === 'narrative-loss'));
        assert.ok(!report.issues.some(issue => issue.code === 'history-trim-policy'));
    }
});

test('automation report shows configured/effective state and a bounded last-operation record', () => {
    const snapshot = { start: 0, end: 0, preset: {}, presetName: 'Unknown', tables: [],
        metadata: { context_helper: { normalizeIncoming: true } },
        chat: [{ mes: 'Story.', extra: { context_helper_original: 'Original.' }, send_date: 'date' }] };
    const observed = analyzeSnapshot(snapshot);
    assert.equal(observed.automation.enabled, true);
    assert.equal(observed.automation.effective, false);
    assert.deepEqual(observed.automation.lastNormalization, { id: 0, at: 'date', status: '已规范化' });
    const supported = analyzeSnapshot({ ...snapshot, presetName: 'Izumi' });
    assert.equal(supported.automation.effective, true);
    assert.equal(supported.automation.configuredAdapter, 'auto');
    assert.equal(supported.automation.aiMode, 'manual');
    assert.equal(supported.automation.historyMode, 'preview');
});
