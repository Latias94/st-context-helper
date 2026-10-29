import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdapter } from '../src/adapters.js';
import { analyzeSnapshot, traceRegexMessage } from '../src/analysis.js';
import { deriveCardProtocol } from '../src/protocols.js';
import { buildLocalPlan, buildRepairMessages, parseRepairResponse } from '../src/repair.js';
import { extractNarrative, inspectTags, narrativeSegments, normalizeMessage } from '../src/tags.js';

const story = 'The archivist entered the observatory, delivered the star chart, and recorded the completed handover.';
const summary = 'The star chart has been delivered.';
const nativeComment = '<!-- [IDE_AST_TRACE]\r\nCheck the chart.\r\n'
    + '<talk>Literal example.</talk> </thinking>\r\n'
    + '<content>COMMENT_BODY</content><hidden>COMMENT_HIDDEN</hidden>\r\n'
    + '<sumUp>COMMENT_SUMMARY</sumUp><pose>COMMENT_POSE</pose><choices>COMMENT_CHOICES</choices>\r\n-->';
const footer = `<sumUp>${summary}</sumUp><pose>Standing beside the desk.</pose><choices>Inspect the chart.</choices>`;
const nativeMessage = `${nativeComment}\n<content><hidden>${story}</hidden></content>\n${footer}`;

// Standalone native rule fixtures; no preset file or presentation templates are loaded.
const nativeRules = [
    { id: 'trim', scriptName: 'Trim old history', findRegex: String.raw`/^([\s\S]*?)$/`,
        replaceString: '', minDepth: 80, placement: [1, 2] },
    { id: 'prefix', scriptName: 'Remove content prefix', findRegex: String.raw`/([\s\S]*?)<content>/g`,
        replaceString: '', markdownOnly: true },
    { id: 'hidden', scriptName: 'Unwrap hidden', findRegex: String.raw`/<hidden>([\s\S]*?)<\/hidden>/g`,
        replaceString: '$1', markdownOnly: true },
    { id: 'summary', scriptName: 'Keep old summary', findRegex: String.raw`/^([\s\S]*?)<sumUp>([\s\S]*?)<\/sumUp>([\s\S]*?)$/g`,
        replaceString: '$2', minDepth: 40 },
    { id: 'choices', scriptName: 'Remove choices', findRegex: String.raw`/<choices>([\s\S]*?)<\/choices>/g`,
        replaceString: '' },
    { id: 'pose', scriptName: 'Remove old pose', findRegex: String.raw`/<pose>([\s\S]*?)<\/pose>/g`,
        replaceString: '', minDepth: 2 },
    { id: 'erase-summary', scriptName: 'Remove recent summary', findRegex: String.raw`/<sumUp>([\s\S]*?)<\/sumUp>/g`,
        replaceString: '', minDepth: 2, maxDepth: 40 },
].map((rule, index) => ({
    disabled: false, promptOnly: true, markdownOnly: false, placement: [2],
    minDepth: null, maxDepth: null, trimStrings: [], substituteRegex: 0,
    contextHelperSource: 'preset', contextHelperKey: `preset:${index}:${rule.id}`, ...rule,
}));

function runRule(rule, text) {
    const [, pattern, flags] = /^\/([\s\S]*)\/([a-z]*)$/.exec(rule.findRegex);
    return text.replace(new RegExp(pattern, flags), rule.replaceString);
}

function snapshot(text = nativeMessage, { depth = 0, user = false } = {}) {
    return {
        presetName: 'Kunlun IDE', preset: {}, metadata: {}, tables: [],
        start: 0, end: 0, fingerprint: 'kunlun-test-source',
        chat: [{ mes: text, is_user: user, swipe_id: 0 },
            ...Array.from({ length: depth }, () => ({ mes: 'Continue the observation.', is_user: true }))],
    };
}

function diagnose(text = nativeMessage, { rules = nativeRules, ...options } = {}) {
    return analyzeSnapshot(snapshot(text, options), {
        traceMessage: (source, placement, depth, evidence) =>
            traceRegexMessage(source, placement, depth, rules, runRule, evidence),
    });
}

test('explicit Kunlun selection overrides other preset markers and exposes its legacy and native formats', () => {
    const profile = resolveAdapter({ presetName: 'Izumi', adapter: 'kunlun' });
    assert.equal(profile.id, 'kunlun');
    assert.match(profile.label, /Kunlun IDE/);
    assert.equal(profile.reasoningTag, 'talk');
    assert.deepEqual(profile.reasoningTags, ['talk', 'thinking', 'think']);
    assert.equal(profile.reasoningCommentMarker, '[IDE_AST_TRACE]');
});

for (const presetName of ['local KuNlUn IDE 1.2r', '昆仑 IDE 本地预设']) {
    test(`Kunlun auto detection recognizes the preset name ${presetName}`, () => {
        assert.equal(resolveAdapter({ presetName }).id, 'kunlun');
    });
}

test('renamed presets recognize case-insensitive Kunlun markers in enabled prompt content', () => {
    const prompt = { identifier: 'format', name: 'Output format', content: 'Use the KuNlUn IDE format.' };
    assert.equal(resolveAdapter({ presetName: 'Local format', preset: { prompts: [prompt] } }).id, 'kunlun');
    const preset = { prompts: [{ ...prompt, enabled: false }], prompt_order: [
        { character_id: 100001, order: [{ identifier: 'format', enabled: true }] },
    ] };
    assert.equal(resolveAdapter({ presetName: 'Local format', preset }).id, 'kunlun');
});

test('disabled and unselected prompt markers cannot activate the Kunlun adapter', () => {
    const prompt = { identifier: 'format', content: 'Kunlun IDE output format.' };
    const presets = [
        { prompts: [{ ...prompt, enabled: false }] },
        { prompts: [{ ...prompt, enabled: true }], prompt_order: [
            { character_id: 100001, order: [{ identifier: 'format', enabled: false }] },
        ] },
        { prompts: [prompt, { identifier: 'scene', content: 'A quiet observatory.' }], prompt_order: [
            { character_id: 100001, order: [{ identifier: 'scene', enabled: true }] },
        ] },
    ];
    for (const preset of presets) assert.equal(resolveAdapter({ presetName: 'Local format', preset }).id, 'generic');
});

test('prompt names and ordinary Chinese scene content are not Kunlun adapter markers', () => {
    const preset = { prompts: [
        { identifier: 'scene', name: 'Kunlun IDE', content: 'The expedition is approaching 昆仑山.', enabled: true },
    ] };
    assert.equal(resolveAdapter({ presetName: 'Mountain expedition', preset }).id, 'generic');
});

for (const tag of ['content', 'game', 'hidden']) {
    test(`native Kunlun comments and footers remain unchanged with a ${tag} story wrapper`, () => {
        const profile = resolveAdapter({ presetName: 'Kunlun IDE' });
        const source = `${nativeComment}\n<${tag}>${story}</${tag}>\n${footer}`;
        const normalized = normalizeMessage(source, profile);
        assert.equal(normalized.text, source);
        assert.equal(normalized.changed, false);
        assert.equal(extractNarrative(source, profile), story);
        assert.deepEqual(inspectTags(source, profile).issues, []);
        assert.deepEqual(buildLocalPlan(snapshot(source)).messages, []);
    });
}

test('native comment payloads are opaque and nested hidden wrappers are transparent only to narrative extraction', () => {
    const profile = resolveAdapter({ presetName: 'Kunlun IDE' });
    const normalized = normalizeMessage(nativeMessage, profile);
    assert.equal(normalized.text, nativeMessage);
    assert.equal(normalized.changed, false);
    assert.equal(extractNarrative(nativeMessage, profile), story);
    assert.deepEqual(narrativeSegments(nativeMessage, profile), [story]);
    const inspected = inspectTags(nativeMessage, profile);
    assert.deepEqual(inspected.issues, []);
    assert.ok(inspected.blocks.every(block => block.start >= nativeComment.length));
});

test('standalone hidden wrappers preserve surrounding bare narrative in extraction and regex diagnosis', () => {
    const profile = resolveAdapter({ adapter: 'kunlun' });
    const head = 'The archivist has already arrived and signed the record.';
    const tail = 'The handover is complete and the observation now begins.';
    const source = `${nativeComment}\n${head}\n<hidden>${story}</hidden>\n${tail}${footer}`;
    assert.equal(extractNarrative(source, profile), `${head}\n${story}\n${tail}`);
    assert.deepEqual(narrativeSegments(source, profile), [head, story, tail]);
    assert.ok(!analyzeSnapshot(snapshot(source)).issues.some(issue => issue.code === 'narrative-loss'));
    const erase = { ...nativeRules[1], scriptName: 'Erase surrounding prose',
        findRegex: '/The handover is complete and the observation now begins\\./g' };
    const report = diagnose(source, { depth: 0, rules: [...nativeRules, erase] });
    assert.ok(report.issues.some(issue => issue.code === 'narrative-loss' && issue.rule === erase.scriptName));
});

test('disjoint prose around wrappers and native comments is retained without a regex trace', () => {
    const profile = resolveAdapter({ adapter: 'kunlun' });
    const first = 'The chart was handed over before the new observation began.';
    const last = 'The completed delivery must not be introduced again next turn.';
    const source = `<content>${first}<hidden>${story}</hidden><!-- [IDE_AST_TRACE] Note. -->${last}</content>`;
    assert.deepEqual(narrativeSegments(source, profile), [first, story, last]);
    assert.ok(!analyzeSnapshot(snapshot(source)).issues.some(issue => issue.code === 'narrative-loss'));
});

test('sumUp, pose and choices payloads do not become narrative when body framing is absent', () => {
    const profile = resolveAdapter({ adapter: 'kunlun' });
    const source = `${story}\n<sumUp>Summary with <talk>literal labels</talk>.</sumUp>`
        + '<pose>At <content>an example place</content>.</pose><choices>Inspect the chart.</choices>';
    assert.equal(normalizeMessage(source, profile).text, source);
    assert.equal(extractNarrative(source, profile), story);
    assert.deepEqual(narrativeSegments(source, profile), [story]);
    assert.deepEqual(inspectTags(source, profile).issues, []);
});

test('transparent hidden wrappers preserve inline, quoted and fenced code examples in story text', () => {
    const profile = resolveAdapter({ adapter: 'kunlun' });
    const body = `${story}\nUse \`<hidden>inline example</hidden>\` literally.\n`
        + 'The note reads "<hidden>quoted example</hidden>".\n'
        + '```xml\n<hidden>fenced example</hidden>\n```';
    const source = `${nativeComment}\n<content><hidden>${body}\n</hidden></content>${footer}`;
    assert.equal(normalizeMessage(source, profile).text, source);
    assert.equal(extractNarrative(source, profile), body);
    assert.deepEqual(narrativeSegments(source, profile), [body]);
    assert.deepEqual(inspectTags(source, profile).issues, []);
});

test('native prefix, hidden and footer rules do not falsely report narrative loss', () => {
    const report = diagnose(nativeMessage, { depth: 2 });
    assert.equal(report.profile.id, 'kunlun');
    assert.equal(report.messages[0].projected, `${story}</content>\n`);
    assert.deepEqual(report.messages[0].trace.map(step => step.name), [
        'Remove content prefix', 'Unwrap hidden', 'Remove choices', 'Remove old pose', 'Remove recent summary',
    ]);
    assert.ok(report.messages[0].trace.every(step => !step.narrativeLost));
    assert.deepEqual(report.issues, []);
});

test('native hidden regex removal of quoted examples remains a real narrative loss', () => {
    const body = `${story} The note reads "<hidden>keep this example</hidden>".`;
    const report = diagnose(`${nativeComment}<content><hidden>${body}</hidden></content>${footer}`, { depth: 2 });
    assert.ok(report.issues.some(issue => issue.code === 'narrative-loss' && issue.rule === 'Unwrap hidden'));
    assert.ok(!report.issues.some(issue => issue.code === 'history-trim-policy'));
});

test('legacy mixed XML reasoning normalizes to talk while escaping literal examples and retaining native comments', () => {
    const profile = resolveAdapter({ adapter: 'kunlun' });
    const source = nativeComment + '\n<thinking><talk>Check the chart.\n'
        + 'Use `<think>`, "<content>" and <node key="a > b">literal</node>.\n'
        + '<!-- </thinking><choices>Comment example.</choices> -->\n'
        + '<![CDATA[<hidden>CDATA example.</hidden>]]>\n'
        + '</talk>Keep the existing record.\n</thinking>'
        + `<content><hidden>${story}</hidden></content>${footer}`;
    const normalized = normalizeMessage(source, profile);
    assert.equal(normalized.changed, true);
    assert.ok(normalized.text.startsWith(nativeComment + '\n<talk>'));
    assert.ok(normalized.text.endsWith(`<content><hidden>${story}</hidden></content>${footer}`));
    const inspected = inspectTags(normalized.text, profile);
    const reasoning = inspected.blocks.filter(block => block.kind === 'reasoning');
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0].lower, 'talk');
    const planning = normalized.text.slice(reasoning[0].bodyStart, reasoning[0].bodyEnd);
    assert.ok(!planning.includes('<') && !planning.includes('>'));
    assert.ok(planning.includes('&lt;think&gt;'));
    assert.ok(planning.includes('Keep the existing record.'));
    assert.equal(extractNarrative(normalized.text, profile), story);
    assert.deepEqual(inspected.issues, []);
    assert.equal(normalizeMessage(normalized.text, profile).text, normalized.text);
});

test('unterminated native comments remain byte-preserved and report the unsafe boundary', () => {
    const profile = resolveAdapter({ adapter: 'kunlun' });
    const source = '<!-- [IDE_AST_TRACE]\r\nCheck the chart.\r\n'
        + `<content><hidden>${story}</hidden></content>${footer}`;
    const normalized = normalizeMessage(source, profile);
    assert.equal(normalized.text, source);
    assert.equal(normalized.changed, false);
    assert.ok(normalized.issues.some(issue => issue.code === 'unclosed-xml-literal'));
    assert.deepEqual(inspectTags(source, profile).blocks, []);
    const plan = buildLocalPlan(snapshot(source));
    assert.deepEqual(plan.messages, []);
    assert.ok(plan.issues.some(issue => issue.code === 'unclosed-xml-literal' && issue.messageId === 0));
});

for (const [body, code] of [[`<hidden>${story}`, 'unclosed-transparent'], [`${story}</hidden>`, 'orphan-transparent']]) {
    test(`an unmatched hidden delimiter inside content is preserved with a ${code} warning`, () => {
        const profile = resolveAdapter({ adapter: 'kunlun' });
        const source = `${nativeComment}<content>${body}</content>${footer}`;
        const normalized = normalizeMessage(source, profile);
        assert.equal(normalized.text, source);
        assert.equal(normalized.changed, false);
        assert.equal(extractNarrative(source, profile), body);
        assert.ok(normalized.issues.some(issue => issue.code === code && issue.severity === 'warning'));
        assert.ok(analyzeSnapshot(snapshot(source)).issues.some(issue => issue.code === code && issue.messageId === 0));
        assert.deepEqual(buildLocalPlan(snapshot(source)).messages, []);
    });
}

test('Kunlun framing coexists with character-card body and status tags', () => {
    const cardProtocol = deriveCardProtocol({ name: 'Observatory card', fields: {
        first_mes: '<maintext>A quiet observatory.</maintext><Status_block>Place: observatory</Status_block>',
    } });
    const profile = resolveAdapter({ presetName: 'Kunlun IDE', cardProtocol });
    const source = `${nativeComment}<maintext><hidden>${story}</hidden></maintext>`
        + '<Status_block>Place: observatory</Status_block>' + footer;
    assert.equal(profile.id, 'kunlun');
    assert.equal(normalizeMessage(source, profile).text, source);
    assert.equal(extractNarrative(source, profile), story);
    assert.deepEqual(narrativeSegments(source, profile), [story]);
    assert.deepEqual(inspectTags(source, profile).issues, []);
    assert.equal(extractNarrative(`<content><hidden>${story}</hidden></content>${footer}`, profile), story);
});

test('the native depth-41 summary rule retains a real summary as an informational history policy', () => {
    const report = diagnose(nativeMessage, { depth: 41 });
    assert.equal(report.messages[0].projected, summary);
    const policy = report.issues.find(issue => issue.code === 'history-trim-policy');
    assert.equal(policy?.severity, 'info');
    assert.equal(policy?.ruleKey, nativeRules[3].contextHelperKey);
    assert.equal(report.messages[0].trace.find(step => step.name === 'Keep old summary')?.policy, 'summary');
    assert.ok(!report.issues.some(issue => issue.code === 'narrative-loss' || issue.code === 'history-erased'));
    assert.equal(report.stats.policyTrimmedMessages, 1);
});

test('the native depth-40 boundary preserves bare summary text through later tag cleanup', () => {
    // Both depth ranges include 40, but bare $2 no longer matches the tag-only cleanup.
    const report = diagnose(nativeMessage, { depth: 40 });
    assert.equal(report.messages[0].projected, summary);
    assert.equal(report.issues.find(issue => issue.code === 'history-trim-policy')?.severity, 'info');
    assert.ok(!report.issues.some(issue => issue.code === 'narrative-loss' || issue.code === 'history-erased'));
    assert.equal(report.stats.policyTrimmedMessages, 1);
});

test('a later rule deleting bare retained Kunlun summary text remains a real loss', () => {
    const erase = { ...nativeRules[1], scriptName: 'Delete retained text',
        findRegex: '/The star chart has been delivered\\./g', contextHelperKey: 'preset:7:bad' };
    const report = diagnose(nativeMessage, { depth: 40, rules: [...nativeRules, erase] });
    assert.equal(report.messages[0].projected, '');
    assert.ok(report.issues.some(issue => issue.code === 'narrative-loss' && issue.rule === erase.scriptName));
    assert.ok(!report.issues.some(issue => issue.code === 'history-trim-policy'));
});

for (const user of [false, true]) {
    test(`the anchored native depth-80 trim is an informational policy for ${user ? 'user' : 'assistant'} history`, () => {
        const text = user ? 'Please record that the star chart has been delivered to the observatory.' : nativeMessage;
        const report = diagnose(text, { depth: 80, user });
        assert.equal(report.messages[0].projected, '');
        assert.deepEqual(report.messages[0].trace.map(step => step.name), ['Trim old history']);
        const policy = report.issues.find(issue => issue.code === 'history-trim-policy');
        assert.equal(policy?.severity, 'info');
        assert.equal(policy?.ruleKey, nativeRules[0].contextHelperKey);
        assert.ok(!report.issues.some(issue => issue.code === 'narrative-loss' || issue.code === 'history-erased'));
        assert.equal(report.stats.policyTrimmedMessages, 1);
        const younger = diagnose(text, { depth: 79, user });
        assert.ok(younger.messages[0].projected.trim());
        assert.ok(!younger.messages[0].trace.some(step => step.name === 'Trim old history'));
    });
}

test('missing real summaries supply no policy exemption for accidental story deletion', () => {
    const text = `${nativeComment}<content><hidden>${story}</hidden></content>`;
    const unchanged = diagnose(text, { depth: 41 });
    assert.equal(unchanged.messages[0].projected, `${story}</content>`);
    assert.deepEqual(unchanged.issues, []);
    const accidental = { ...nativeRules[1], id: 'accidental', scriptName: 'Accidental story deletion',
        contextHelperKey: 'preset:7:accidental', findRegex: '/delivered the star chart/g' };
    const report = diagnose(text, { depth: 41, rules: [...nativeRules, accidental] });
    assert.ok(report.issues.some(issue => issue.code === 'narrative-loss' && issue.rule === accidental.scriptName));
    assert.ok(!report.issues.some(issue => issue.code === 'history-trim-policy'));
});

for (const quoted of ['`<sumUp>Example summary.</sumUp>`', '"<sumUp>Example summary.</sumUp>"',
    '```xml\n<sumUp>Example summary.</sumUp>\n```']) {
    test(`a quoted-only summary cannot exempt native narrative loss: ${quoted.split('\n')[0]}`, () => {
        const source = `${nativeComment}<content><hidden>${story}</hidden></content>\n${quoted}`;
        const report = diagnose(source, { depth: 41 });
        assert.equal(report.messages[0].projected, 'Example summary.');
        assert.ok(report.issues.some(issue => issue.code === 'narrative-loss' && issue.severity === 'error'));
        assert.ok(!report.issues.some(issue => issue.code === 'history-trim-policy'));
    });
}

test('AI repair input carries the Kunlun profile, untouched native source and extracted story', () => {
    const source = snapshot();
    const before = structuredClone(source);
    const messages = buildRepairMessages(source, { issues: [] });
    assert.equal(messages[0].role, 'system');
    const input = JSON.parse(messages.at(-1).content);
    assert.equal(input.adapter.id, 'kunlun');
    assert.equal(input.adapter.reasoningTag, 'talk');
    assert.equal(input.adapter.reasoningCommentMarker, '[IDE_AST_TRACE]');
    assert.equal(input.floors[0].text, nativeMessage);
    assert.equal(input.floors[0].narrative, story);
    assert.equal(input.floors[0].deterministicCandidate, undefined);
    assert.deepEqual(source, before);
});

test('AI repair accepts preserved native source and rejects rewritten comments, narrative and footer payloads', () => {
    const source = snapshot();
    const before = structuredClone(source);
    const response = text => JSON.stringify({ version: 1, messages: [{ id: 0, swipeId: 0, text }] });
    assert.equal(parseRepairResponse(response(nativeMessage), source).messages[0].text, nativeMessage);
    for (const [original, replacement] of [
        ['Check the chart.', 'Invent a comet.'],
        ['recorded the completed handover', 'planned a future handover'],
        [summary, 'The star chart is missing.'],
        ['Standing beside the desk.', 'Walking through the garden.'],
        ['Inspect the chart.', 'Discard the chart.'],
    ]) {
        assert.throws(() => parseRepairResponse(response(nativeMessage.replace(original, replacement)), source), /preserv|payload|narrative/i);
    }
    assert.deepEqual(source, before);
});
