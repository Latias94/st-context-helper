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
    assert.ok(report.prompt.note.includes('not'));
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
