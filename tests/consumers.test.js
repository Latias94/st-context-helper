import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSnapshot } from '../src/analysis.js';
import { buildLocalPlan, buildRepairMessages, parseRepairResponse } from '../src/repair.js';
import { describeRegexRules } from '../src/regex.js';

const cardProtocol = { bodyTags: ['maintext'], statusTags: ['Status_block'], requiredTags: [], warnings: [] };
const renderer = { id: 'status', scriptName: 'Status renderer',
    findRegex: String.raw`.*?<Status_block>([\s\S]*?)<\/Status_block>`,
    replaceString: String.raw`getChatMessages(currentMessageId); const messageContent = actualMessageData.message;
const match = message.match(/<Status_block>\s*([\s\S]*?)\s*<\/Status_block>/i);`,
    disabled: false, markdownOnly: true, promptOnly: false, placement: [2], substituteRegex: 0 };

function snapshot(source, { presetName = 'Meowssiah', rule = renderer, allowed = true, enabled = true, depth = 0, ...extra } = {}) {
    return { presetName, cardProtocol, start: 0, end: 0, metadata: {}, tables: [],
        chat: [{ mes: source }, ...Array.from({ length: depth }, () => ({ mes: 'Continue.', is_user: true }))],
        regex: describeRegexRules([{ source: 'character', scriptType: 1, allowed, scripts: rule ? [rule] : [] }], enabled), ...extra };
}
const codes = report => report.issues.map(issue => issue.code);

test('a known raw status reader warns about examples in story code without rewriting the story', () => {
    const source = '<game>Use `<Status_block>EXAMPLE</Status_block>` literally.</game><Status_block>REAL</Status_block>';
    const state = snapshot(source), before = structuredClone(state);
    const issue = analyzeSnapshot(state).issues.find(issue => issue.code === 'raw-reader-collision');
    assert.equal(issue?.action, 'regex');
    assert.equal(issue?.ruleKey, state.regex.rules[0].key);
    assert.deepEqual(buildLocalPlan(state).messages, []);
    assert.deepEqual(state, before);
});

test('native precheck comments can collide with raw readers while remaining unchanged locally', () => {
    const source = '<!-- [IDE_AST_TRACE] <Status_block>EXAMPLE</Status_block> -->'
        + '<content>STORY</content><Status_block>REAL</Status_block>';
    const state = snapshot(source, { presetName: 'Kunlun' });
    assert.ok(codes(analyzeSnapshot(state)).includes('raw-reader-collision'));
    assert.deepEqual(buildLocalPlan(state).messages, []);
});

test('known-reader checks respect permission, switches, depth, placement and direct-source evidence', () => {
    const source = '<game>`<Status_block>EXAMPLE</Status_block>`</game><Status_block>REAL</Status_block>';
    for (const options of [{ allowed: false }, { enabled: false }, { rule: { ...renderer, disabled: true } },
        { rule: { ...renderer, markdownOnly: false } }, { rule: { ...renderer, placement: [1] } },
        { rule: { ...renderer, minDepth: 2 } }, { rule: { ...renderer, maxDepth: 0 }, depth: 1 },
        { rule: { ...renderer, replaceString: 'A custom renderer without a known raw-message reader.' } }]) {
        assert.ok(!codes(analyzeSnapshot(snapshot(source, options))).includes('raw-reader-collision'));
    }
});

test('display depth excludes hidden tool messages even when prompt depth includes them', () => {
    const source = '<game>`<Status_block>EXAMPLE</Status_block>`</game><Status_block>REAL</Status_block>';
    const state = snapshot(source, { rule: { ...renderer, maxDepth: 0 }, chat: [{ mes: source },
        { mes: 'TOOL', is_system: true, extra: { tool_invocations: [] } }] });
    const depths = [];
    const report = analyzeSnapshot(state, { canUseTools: true, traceMessage(text, placement, depth) {
        depths.push(depth); return { text, trace: [] };
    } });
    assert.deepEqual(depths, [1]);
    assert.ok(codes(report).includes('raw-reader-collision'));
});

test('narrator display uses slash-command placement rather than assistant placement', () => {
    const source = '<game>`<Status_block>EXAMPLE</Status_block>`</game><Status_block>REAL</Status_block>';
    for (const placement of [[2], [3]]) {
        const state = snapshot(source, { rule: { ...renderer, placement }, chat: [{ mes: source, extra: { type: 'narrator' } }] });
        assert.equal(codes(analyzeSnapshot(state)).includes('raw-reader-collision'), placement[0] === 3);
    }
});

test('known-reader evidence preserves source-example guidance when card metadata is unavailable', () => {
    const source = '<think_nya>Use `<Status_block>EXAMPLE</Status_block>`.</think_nya><game>STORY</game><Status_block>REAL</Status_block>';
    const report = analyzeSnapshot(snapshot(source, { cardProtocol: null }));
    const issue = report.issues.find(issue => issue.code === 'unescaped-protocol-example');
    assert.ok(issue?.tags.includes('Status_block'));
    assert.equal(issue?.action, 'local');
});

test('an integrated renderer supplies bounded maintext evidence without card metadata', () => {
    const rule = { ...renderer, findRegex: String.raw`<maintext>[\s\S]*?<\/Status_block>` };
    const source = '<maintext>STORY</maintext><Status_block>REAL</Status_block>';
    assert.ok(!codes(analyzeSnapshot(snapshot(source, { rule, cardProtocol: null }))).includes('render-boundary-mismatch'));
});

test('a raw reader selecting only a story example is diagnosed even without real status data', () => {
    assert.ok(codes(analyzeSnapshot(snapshot('<game>`<Status_block>EXAMPLE</Status_block>`</game>'))).includes('raw-reader-collision'));
});

test('an integrated reader that cannot trigger reports its wrapper mismatch without a readback collision', () => {
    const source = '<game>`<Status_block>EXAMPLE</Status_block>`</game><Status_block>REAL</Status_block>';
    const rule = { ...renderer, findRegex: String.raw`<maintext>[\s\S]*?<\/Status_block>` };
    const report = analyzeSnapshot(snapshot(source, { rule }));
    assert.ok(codes(report).includes('render-boundary-mismatch'));
    assert.ok(!codes(report).includes('raw-reader-collision'));
});

test('a real status block before a later quoted example does not collide with a first-block reader', () => {
    const source = '<Status_block>REAL</Status_block><game>`<Status_block>EXAMPLE</Status_block>`</game>';
    assert.ok(!codes(analyzeSnapshot(snapshot(source))).includes('raw-reader-collision'));
});

for (const opening of ['<status_block>', '<Status_block >']) {
    test(`strict display boundaries report the otherwise valid opening ${opening}`, () => {
        const source = `<game>STORY</game>${opening}REAL</Status_block>`;
        const state = snapshot(source);
        const issue = analyzeSnapshot(state).issues.find(issue => issue.code === 'render-boundary-mismatch');
        assert.equal(issue?.ruleKey, state.regex.rules[0].key);
        assert.deepEqual(buildLocalPlan(state).messages, []);
    });
}

test('case-insensitive native rules and unknown custom status rules are not treated as strict failures', () => {
    const source = '<game>STORY</game><status_block>REAL</status_block>';
    for (const rule of [{ ...renderer, findRegex: `/${renderer.findRegex}/gi` },
        { ...renderer, findRegex: String.raw`/<Status_block\s*>([\s\S]*?)<\/Status_block\s*>/gi` }]) {
        assert.ok(!codes(analyzeSnapshot(snapshot(source, { rule }))).includes('render-boundary-mismatch'));
    }
});

test('invalid duplicate regex flags cannot interrupt analysis or masquerade as active readers', () => {
    const source = '<game>`<Status_block>EXAMPLE</Status_block>`</game><Status_block>REAL</Status_block>';
    for (const flags of ['ii', 'gg']) {
        const rule = { ...renderer, findRegex: `/${renderer.findRegex}/${flags}` };
        const report = analyzeSnapshot(snapshot(source, { rule }));
        assert.ok(!codes(report).includes('raw-reader-collision'));
    }
});

test('integrated display contracts require a body opener with matching case and whitespace', () => {
    const rule = { ...renderer, findRegex: String.raw`<maintext>[\s\S]*?<\/Status_block>` };
    for (const body of ['<game>STORY</game>', '<MAINTEXT>STORY</MAINTEXT>', '<maintext >STORY</maintext>']) {
        assert.ok(codes(analyzeSnapshot(snapshot(body + '<Status_block>REAL</Status_block>', { rule })))
            .includes('render-boundary-mismatch'));
    }
    assert.ok(!codes(analyzeSnapshot(snapshot('<maintext>STORY</maintext><Status_block>REAL</Status_block>', { rule })))
        .includes('render-boundary-mismatch'));
});

test('duplicate real status blocks require review and are never silently selected or merged', () => {
    const source = '<game>STORY</game><Status_block>OLD</Status_block><Status_block>NEW</Status_block>';
    const state = snapshot(source);
    const issue = analyzeSnapshot(state).issues.find(issue => issue.code === 'duplicate-protocol-block');
    assert.equal(issue?.count, 2);
    assert.equal(issue?.action, 'none');
    assert.deepEqual(buildLocalPlan(state).messages, []);
    assert.equal(state.chat[0].mes, source);
});

test('sequential table and variable update blocks remain valid', () => {
    const source = '<game>STORY</game><tableEdit>FIRST</tableEdit><tableEdit>SECOND</tableEdit>'
        + '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>'.repeat(2);
    assert.ok(!codes(analyzeSnapshot(snapshot(source))).includes('duplicate-protocol-block'));
});

test('a table terminator inside a quoted value is diagnosed without editing the payload', () => {
    const source = '<game>STORY</game><tableEdit><!-- insertRow(0, {"note":"literal </tableEdit> example"}); --></tableEdit>';
    const state = snapshot(source);
    const issue = analyzeSnapshot(state).issues.find(issue => issue.code === 'consumer-delimiter-collision');
    assert.equal(issue?.action, 'none');
    assert.equal(issue?.tag, 'tableEdit');
    assert.deepEqual(buildLocalPlan(state).messages, []);
});

test('self-closing placeholder examples are diagnosed and safely escaped in reasoning', () => {
    const source = '<think_nya>Use `<StatusPlaceHolderImpl/>` as an example.</think_nya><game>STORY</game>';
    const state = snapshot(source);
    const issue = analyzeSnapshot(state).issues.find(issue => issue.code === 'unescaped-protocol-example');
    assert.ok(issue?.tags.includes('StatusPlaceHolderImpl'));
    const fixed = buildLocalPlan(state).messages[0].text;
    assert.ok(fixed.includes('&lt;StatusPlaceHolderImpl/&gt;'));
    assert.ok(!codes(analyzeSnapshot(snapshot(fixed))).includes('unescaped-protocol-example'));
});

test('adjacent legacy and native reasoning blocks merge without moving story or status data', () => {
    const source = '<think>PLAN_A</think>\n<think_nya>PLAN_B</think_nya>\n<game>STORY</game><Status_block>REAL</Status_block>';
    const state = snapshot(source);
    const issue = analyzeSnapshot(state).issues.find(issue => issue.code === 'repeated-reasoning');
    assert.equal(issue?.action, 'local');
    const fixed = buildLocalPlan(state).messages[0].text;
    assert.equal(fixed, '<think_nya~>\nPLAN_A\n\nPLAN_B\n</think_nya~>\n<game>STORY</game><Status_block>REAL</Status_block>');
    assert.ok(!codes(analyzeSnapshot(snapshot(fixed))).includes('repeated-reasoning'));
    assert.deepEqual(buildLocalPlan(snapshot(fixed)).messages, []);
});

test('reasoning blocks separated by narrative remain separate and require review', () => {
    const source = '<think_nya~>\nPLAN_A\n</think_nya~><game>STORY</game><think_nya~>\nPLAN_B\n</think_nya~>';
    const state = snapshot(source);
    const issue = analyzeSnapshot(state).issues.find(issue => issue.code === 'repeated-reasoning');
    assert.equal(issue?.action, 'none');
    assert.equal(issue?.count, 2);
    assert.deepEqual(buildLocalPlan(state).messages, []);
});

test('empty adjacent reasoning is merged idempotently, and quoted markers are not counted as extra blocks', () => {
    const state = snapshot('<think></think>\n<think_nya>PLAN</think_nya><game>STORY</game>');
    const fixed = buildLocalPlan(state).messages[0].text;
    assert.equal(fixed, '<think_nya~>\nPLAN\n</think_nya~><game>STORY</game>');
    assert.deepEqual(buildLocalPlan(snapshot(fixed)).messages, []);
    const quoted = '<think_nya>Use `<think_nya>EXAMPLE</think_nya>` literally.</think_nya><game>STORY</game>';
    assert.ok(!codes(analyzeSnapshot(snapshot(quoted))).includes('repeated-reasoning'));
});

test('reasoning is not merged across status, table, comments or unframed text', () => {
    for (const gap of ['<Status_block>REAL</Status_block>', '<tableEdit>REAL_TABLE</tableEdit>', '<!-- NOTE -->', 'VISIBLE_TEXT']) {
        const source = `<think_nya~>\nPLAN_A\n</think_nya~>\n${gap}\n<think_nya~>\nPLAN_B\n</think_nya~>`;
        const state = snapshot(source);
        assert.equal(analyzeSnapshot(state).issues.find(issue => issue.code === 'repeated-reasoning')?.action, 'none');
        assert.deepEqual(buildLocalPlan(state).messages, []);
    }
});

test('AI repair receives the layout preference and cannot relocate a separated reasoning phase', () => {
    const source = '<think_nya~>\nPLAN_A\n</think_nya~><game>STORY</game><think_nya~>\nPLAN_B\n</think_nya~>';
    const state = snapshot(source);
    const input = JSON.parse(buildRepairMessages(state).at(-1).content);
    assert.equal(input.adapter.reasoningLayout, 'single-leading');
    const reordered = '<think_nya~>\nPLAN_A\nPLAN_B\n</think_nya~><game>STORY</game>';
    assert.throws(() => parseRepairResponse(JSON.stringify({ version: 1,
        messages: [{ id: 0, swipeId: 0, text: reordered }] }), state), /preserve/i);
});

test('user and hidden messages do not receive consumer-specific repair guidance', () => {
    const source = '<game>`<Status_block>EXAMPLE</Status_block>`</game><Status_block>REAL</Status_block>';
    for (const role of [{ is_user: true }, { is_system: true }]) {
        const report = analyzeSnapshot(snapshot(source, { chat: [{ mes: source, ...role }] }));
        assert.ok(!codes(report).includes('raw-reader-collision'));
    }
});
