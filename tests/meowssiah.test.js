import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdapter } from '../src/adapters.js';
import { analyzeSnapshot, traceRegexMessage } from '../src/analysis.js';
import { buildRepairMessages, parseRepairResponse } from '../src/repair.js';
import { extractNarrative, extractPatches, inspectTags, normalizeMessage } from '../src/tags.js';

// Neutral protocol fixtures for Meowssiah 1.9.12; no reference preset is required.
const story = 'The archivist delivered the chart and recorded the completed handover at the observatory.';
const summary = 'The chart handover is complete.';
const updates = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/place","value":"observatory"}]</JSONPatch></UpdateVariable>';
const footer = `<summary>${summary}</summary><comment>Check the record.</comment>`
    + '<options><option>Inspect the chart.</option><option>Open the record.</option></options>';
const preset = { prompts: [
    { identifier: 'init', content: 'Use <think_nya> for planning.' },
    { identifier: 'format', content: '<<<|catgodml|registerPart:game_content:<game></game>>>>' },
    { identifier: 'old', content: 'Use <think_nya~> for planning.' },
], prompt_order: [{ character_id: 100001, order: [
    { identifier: 'init', enabled: true }, { identifier: 'format', enabled: true },
    { identifier: 'old', enabled: false },
] }] };

function snapshot(text, depth = 0) {
    return { presetName: 'Meowssiah_1.9.12', preset, metadata: {}, tables: [],
        start: 0, end: 0, fingerprint: 'meowssiah-source',
        chat: [{ mes: text, swipe_id: 0 },
            ...Array.from({ length: depth }, () => ({ mes: 'Continue the observation.', is_user: true }))] };
}

test('Meowssiah names and enabled native markers select the existing Cat God family', () => {
    for (const presetName of ['Meowssiah_1.9.12.json', 'local MEOWSSIAH', '小猫之神', '喵赛亚']) {
        assert.equal(resolveAdapter({ presetName }).id, 'cat-god');
    }
    for (const content of ['Use <think_nya>.', 'Use <report_nya~>.', '<<<|catgodml|registerPart:game_content:body>>>']) {
        assert.equal(resolveAdapter({ presetName: 'Local format',
            preset: { prompts: [{ identifier: 'format', content }] } }).id, 'cat-god');
    }
    assert.equal(resolveAdapter({ presetName: 'Local format', preset }).reasoningTag, 'think_nya');
    assert.equal(resolveAdapter({ presetName: 'Izumi', preset, adapter: 'cat-god' }).reasoningTag, 'think_nya');
});

test('inactive Cat God markers cannot change detection or the legacy reasoning preference', () => {
    const inactive = { prompts: [{ identifier: 'off', name: 'Meowssiah', content: 'Use <think_nya> catgodml.' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'off', enabled: false }] }] };
    assert.equal(resolveAdapter({ presetName: 'Local format', preset: inactive }).id, 'generic');
    assert.equal(resolveAdapter({ presetName: 'Meowssiah', preset: inactive }).reasoningTag, 'think_nya~');
    assert.equal(resolveAdapter({ presetName: 'Local format',
        preset: { prompts: [{ ...inactive.prompts[0], enabled: false }] } }).id, 'generic');
    assert.equal(resolveAdapter({ presetName: 'Local format',
        preset: { prompts: [{ name: 'Meowssiah', content: 'A quiet observatory.' }] } }).id, 'generic');
    const legacy = { prompts: [{ content: 'Use <think_nya~>.' }, { content: 'Literal <think_nya>.' }] };
    assert.equal(resolveAdapter({ presetName: 'Meowssiah', preset: legacy }).reasoningTag, 'think_nya~');
});

for (const tag of ['think_nya', 'think_nya~', 'report_nya', 'report_nya~']) {
    test(`${tag} reasoning cannot expose embedded tag examples as story or data`, () => {
        const profile = resolveAdapter({ presetName: 'Meowssiah_1.9.12', preset });
        const source = `<${tag}>\nPlan <example><item>note</item></example> and \`</${tag}>\`.\n`
            + `<!-- </${tag}> <game>Comment example.</game> -->\n</${tag}>`
            + `<game>${story}</game>${updates}${footer}`;
        const normalized = normalizeMessage(source, profile).text;
        assert.ok(normalized.startsWith('<think_nya>'));
        assert.equal(extractNarrative(normalized, profile), story);
        assert.ok(normalized.includes('&lt;example&gt;'));
        assert.equal(extractPatches(normalized, profile)[0].value, 'observatory');
        assert.ok(normalized.includes(updates));
        assert.ok(normalized.endsWith(footer));
        assert.deepEqual(inspectTags(normalized, profile).issues, []);
        assert.equal(normalizeMessage(normalized, profile).text, normalized);
    });
}

test('unclosed modern reasoning requires a real body boundary and preserves footer payloads', () => {
    const profile = resolveAdapter({ presetName: 'Meowssiah', preset });
    const source = `<think_nya>Plan.\n<game>${story}</game>${footer}`;
    const normalized = normalizeMessage(source, profile).text;
    assert.equal(extractNarrative(normalized, profile), story);
    assert.ok(normalized.includes('</think_nya><game>'));
    assert.ok(normalized.endsWith(footer));
    const ambiguous = `<report_nya>Plan and unframed story.\n${footer}`;
    assert.equal(normalizeMessage(ambiguous, profile).text, ambiguous);
    assert.ok(inspectTags(ambiguous, profile).issues.some(issue => issue.code === 'unclosed-reasoning'));
});

test('Cat God footer blocks are data when narrative has no game wrapper', () => {
    const profile = resolveAdapter({ presetName: 'Meowssiah', preset });
    const source = `<think_nya>\nPlan.\n</think_nya>\n${story}${footer}`;
    const inspected = inspectTags(source, profile);
    assert.deepEqual(inspected.blocks.filter(block => block.kind === 'data').map(block => block.lower),
        ['summary', 'comment', 'options']);
    assert.equal(extractNarrative(source, profile), story);
});

test('native depth rules hide planning and options and retain old summaries without false narrative loss', () => {
    const rules = [
        { scriptName: 'Keep old summary', minDepth: 6,
            findRegex: String.raw`/[\s\S]*?(?<!<details>\s*)<summary>([\s\S]*?)<\/summary>[\s\S]*/g`,
            replaceString: '<summary>\n$1\n</summary>' },
        { scriptName: 'Hide planning', minDepth: 1,
            findRegex: String.raw`/<(?:think_nya|report_nya)~?>([\s\S]*?)<\/(?:think_nya|report_nya)~?>/g`,
            replaceString: '' },
        { scriptName: 'Hide old options', minDepth: 1,
            findRegex: String.raw`/(<options>[\s\S]*?<\/options>)/g`, replaceString: '', markdownOnly: true },
    ].map(rule => ({ disabled: false, promptOnly: true, placement: [2], ...rule }));
    const run = (rule, text) => {
        const [, pattern, flags] = /^\/([\s\S]*)\/([a-z]*)$/.exec(rule.findRegex);
        return text.replace(new RegExp(pattern, flags), rule.replaceString);
    };
    for (const depth of [0, 1, 5, 6, 7]) {
        const report = analyzeSnapshot(snapshot(`<think_nya>\nPlan.\n</think_nya><game>${story}</game>${footer}`, depth), {
            traceMessage: (text, placement, depth, evidence) => traceRegexMessage(text, placement, depth, rules, run, evidence),
        });
        const projected = report.messages[0].projected;
        assert.equal(projected.includes('<think_nya>'), depth === 0);
        assert.equal(projected.includes('<options>'), depth === 0);
        assert.equal(projected.includes(story), depth < 6);
        assert.equal(report.issues.filter(issue => issue.code === 'history-trim-policy').length, depth >= 6 ? 1 : 0);
        assert.ok(!report.issues.some(issue => ['narrative-loss', 'history-erased'].includes(issue.code)));
    }
});

test('AI repair receives the modern format and cannot rewrite Cat God footer payloads', () => {
    const source = snapshot(`<think_nya>\nPlan.\n</think_nya><game>${story}</game>${footer}`);
    const before = structuredClone(source);
    const input = JSON.parse(buildRepairMessages(source).at(-1).content);
    assert.equal(input.adapter.id, 'cat-god');
    assert.equal(input.adapter.reasoningTag, 'think_nya');
    assert.equal(input.floors[0].narrative, story);
    const propose = text => JSON.stringify({ version: 1, messages: [{ id: 0, swipeId: 0, text }] });
    assert.equal(parseRepairResponse(propose(source.chat[0].mes), source).messages[0].text, source.chat[0].mes);
    for (const [original, replacement] of [[summary, 'The chart is missing.'],
        ['Check the record.', 'Discard the record.'], ['Inspect the chart.', 'Burn the chart.']]) {
        assert.throws(() => parseRepairResponse(propose(source.chat[0].mes.replace(original, replacement)), source),
            /preserv|payload|narrative/i);
    }
    assert.deepEqual(source, before);
});
