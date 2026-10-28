import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRegexRules, isDepthTrimRule, isDepthSummaryRule, prepareRegexToggle, retainsNarrative } from '../src/regex.js';
import { presentIssue, diagnosisSummary, repairOutcome } from '../src/diagnostics.js';

const trim = { id: 'limit', scriptName: '上下文限制[10]', findRegex: '/[\\s\\S]*/gm', replaceString: '',
    minDepth: 10, maxDepth: null, placement: [1, 2], promptOnly: true, disabled: false };

test('regex inventory separates configured, allowed and prompt-effective states', () => {
    const report = describeRegexRules([
        { source: 'global', scriptType: 0, allowed: true, scripts: [trim, { ...trim, id: 'off', disabled: true },
            { ...trim, id: 'display', promptOnly: false, markdownOnly: true }] },
        { source: 'preset', scriptType: 2, allowed: false, scripts: [trim] },
    ]);
    assert.deepEqual(report.rules.map(rule => rule.activeForPrompt), [true, false, false, false]);
    assert.equal(report.rules[0].depthLabel, '深度 ≥ 10');
    assert.equal(report.rules[1].status, '规则已关闭');
    assert.equal(report.rules[2].status, '不处理发送上下文');
    assert.equal(report.rules[3].status, '此来源未获授权');
    assert.notEqual(report.rules[0].key, report.rules[3].key);
    assert.ok(describeRegexRules([{ source: 'global', scriptType: 0, allowed: true, scripts: [trim] }], false)
        .rules.every(rule => !rule.activeForPrompt));
});

test('a single toggle preserves all other scripts and never grants source permission', () => {
    const groups = [{ source: 'preset', scriptType: 2, allowed: false, scripts: [trim, { ...trim, id: 'second' }] }];
    const report = describeRegexRules(groups);
    const changed = prepareRegexToggle(groups, report.rules[0], false);
    assert.equal(changed.scripts[0].disabled, true);
    assert.deepEqual(changed.scripts[1], groups[0].scripts[1]);
    assert.equal(groups[0].scripts[0].disabled, false);
    assert.equal(groups[0].allowed, false);
    groups[0].scripts[0] = { ...trim, minDepth: 12 };
    assert.throws(() => prepareRegexToggle(groups, report.rules[0], false), /修改|重新分析/);
});

test('policy recognition needs actual full erasure and finite old-history depth, never a reassuring name', () => {
    assert.equal(isDepthTrimRule(trim), true);
    for (const minDepth of [null, 0, NaN, Infinity]) assert.equal(isDepthTrimRule({ ...trim, minDepth }), false);
    assert.equal(isDepthTrimRule({ ...trim, findRegex: '/<content>[\\s\\S]*?<\\/content>/g' }), false);
    assert.equal(isDepthTrimRule({ ...trim, replaceString: 'Summary' }), false);
    assert.equal(isDepthTrimRule({ ...trim, substituteRegex: 1 }), false);
    assert.equal(isDepthSummaryRule({ ...trim, scriptName: 'Keep summary', findRegex: '/<content>.*<\\/content>/gs' }), false);
});

test('material narrative truncation cannot pass a majority-fragment heuristic', () => {
    const story = ['A', 'B', 'C', 'D', 'E'].map(char => char.repeat(30)).join('');
    assert.equal(retainsNarrative(story.slice(0, 90), story), false);
    assert.equal(retainsNarrative(story.slice(60), story), false);
    assert.equal(retainsNarrative('PREFIX ' + story + ' SUFFIX', story), true);
    assert.equal(retainsNarrative('First line.\nSecond line.', 'First line. Second line.'), true);
});

test('diagnostic guidance distinguishes repair, policy and review without hiding remaining errors', () => {
    const issues = [{ code: 'history-trim-policy', severity: 'info' }, { code: 'unclosed-reasoning', severity: 'error' },
        { code: 'narrative-loss', severity: 'error' }];
    assert.deepEqual(diagnosisSummary(issues), { repair: 1, policy: 1, review: 1 });
    assert.equal(presentIssue(issues[0]).action, 'regex');
    assert.ok(presentIssue(issues[0]).recommendation.includes('重新分析'));
    assert.equal(presentIssue(issues[1]).action, 'local');
    assert.ok(repairOutcome(issues).includes('仍有 2 项错误'));
    assert.ok(repairOutcome([issues[2]]).includes('正文丢失'));
    assert.ok(repairOutcome([issues[0]]).includes('裁剪'));
});
