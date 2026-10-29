import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVariablePatches, buildLocalPlan, buildRepairMessages, parseRepairResponse } from '../src/repair.js';

function fixture() {
    const update = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/place","value":"study"}]</JSONPatch></UpdateVariable>';
    const old = { stat_data: { place: 'hall', goodwill: 75 }, schema: 'existing schema' };
    return {
        chatId: 'chat-1', characterId: 0, groupId: null, avatar: 'character.png',
        start: 1, end: 2, presetName: 'Izumi', preset: {},
        chat: [
            { mes: 'Earlier', is_user: false, variables: [structuredClone(old)], swipe_id: 0 },
            { mes: '<thinking><konatan_planning~>Use `<thinking>`.</konatan_planning~></thinking>'
                + '<content>We moved to the study.</content>' + update,
            is_user: false, variables: [structuredClone(old)], swipe_id: 0 },
            { mes: 'Continue.', is_user: true, variables: [structuredClone(old)] },
        ],
        metadata: {}, tables: [], fingerprint: 'source',
    };
}

test('local repair recovers a stalled MVU snapshot and the next inherited user snapshot', () => {
    const snapshot = fixture();
    const before = JSON.stringify(snapshot);
    const plan = buildLocalPlan(snapshot);
    assert.ok(plan.messages.some(x => x.id === 1));
    assert.equal(plan.variables.find(x => x.id === 1).data.stat_data.place, 'study');
    assert.equal(plan.variables.find(x => x.id === 2).data.stat_data.place, 'study');
    assert.equal(plan.variables.find(x => x.id === 1).data.schema, 'existing schema');
    assert.equal(JSON.stringify(snapshot), before);
});

test('already-applied numeric deltas are not applied again', () => {
    const snapshot = fixture();
    snapshot.chat[1].mes = '<content>Done.</content><UpdateVariable><JSONPatch>'
        + '[{"op":"delta","path":"/goodwill","value":10}]</JSONPatch></UpdateVariable>';
    snapshot.chat[1].variables[0].stat_data.goodwill = 85;
    snapshot.chat[2].variables[0].stat_data.goodwill = 85;
    assert.equal(buildLocalPlan(snapshot).variables.length, 0);
});

test('an identical repeated insertion is idempotent while different existing data requires review', () => {
    const snapshot = fixture();
    snapshot.chat[0].variables[0].stat_data.person = { goodwill: 65 };
    snapshot.chat[1].variables[0].stat_data.person = { goodwill: 65 };
    snapshot.chat[2].variables[0].stat_data.person = { goodwill: 65 };
    snapshot.chat[1].mes = '<content>Already introduced.</content><UpdateVariable><JSONPatch>'
        + '[{"op":"insert","path":"/person","value":{"goodwill":65}},'
        + '{"op":"replace","path":"/place","value":"study"}]</JSONPatch></UpdateVariable>';
    const plan = buildLocalPlan(snapshot);
    assert.equal(plan.issues.length, 0);
    assert.equal(plan.variables[0].data.stat_data.person.goodwill, 65);
});

test('AI proposals may not edit another floor, another swipe or unsafe variable paths', () => {
    const snapshot = fixture();
    const wrap = changes => JSON.stringify({ version: 1, summary: 'Repair', messages: [], variables: [], tables: [], ...changes });
    assert.throws(() => parseRepairResponse(wrap({ messages: [{ id: 0, swipeId: 0, text: 'Overwrite' }] }), snapshot), /scope|range/i);
    assert.throws(() => parseRepairResponse(wrap({ messages: [{ id: 1, swipeId: 99, text: 'Overwrite' }] }), snapshot), /swipe/i);
    assert.throws(() => parseRepairResponse(wrap({ variables: [{ id: 1, swipeId: 0,
        patch: [{ op: 'replace', path: '/__proto__/polluted', value: true }] }] }), snapshot), /path/i);
    assert.equal({}.polluted, undefined);
});

test('AI input explains the selected preset and preserves evidence as data', () => {
    const snapshot = fixture();
    const messages = buildRepairMessages(snapshot, { issues: [] }, { prompt: 'Keep completed events completed.' });
    assert.equal(messages[0].role, 'system');
    assert.ok(messages[0].content.includes('JSON'));
    assert.ok(messages.at(-1).content.includes('We moved to the study.'));
    assert.ok(messages.at(-1).content.includes('Keep completed events completed.'));
});

test('AI text fixes preserve existing narrative and protocol payloads', () => {
    const snapshot = fixture();
    const response = JSON.stringify({ version: 1, messages: [{ id: 1, swipeId: 0,
        text: '<content>We moved to the study.</content>', reason: 'Remove tags' }] });
    assert.throws(() => parseRepairResponse(response, snapshot), /payload|data block/i);
});

test('array metadata is never accepted as a patch index', () => {
    for (const op of ['replace', 'remove', 'insert']) {
        assert.throws(() => applyVariablePatches({ items: ['a', 'b'] },
            [{ op, path: '/items/length', value: 0 }]), /index/i);
    }
});

test('AI state changes cannot violate existing types or required schema keys', () => {
    const snapshot = fixture();
    snapshot.chat[1].variables[0].stat_data.person = { name: 'Adviser' };
    snapshot.chat[1].variables[0].schema = { type: 'object',
        properties: { person: { type: 'object', required: true } } };
    for (const patch of [{ op: 'replace', path: '/person', value: 'Gone' }, { op: 'remove', path: '/person' }]) {
        assert.throws(() => parseRepairResponse(JSON.stringify({ version: 1,
            variables: [{ id: 1, swipeId: 0, patch: [patch] }] }), snapshot), /type|required/i);
    }
});

test('AI can supply an ambiguous reasoning boundary while preserving all original text', () => {
    const snapshot = fixture();
    snapshot.chat[1].mes = '<thinking>Plan.\nThe adviser has already entered.\n'
        + '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
    const local = buildLocalPlan(snapshot);
    assert.equal(local.messages.length, 0);
    assert.ok(local.issues.some(issue => issue.code === 'unclosed-reasoning'));
    const text = '<konatan_planning~>Plan.</konatan_planning~>\n'
        + '<content>The adviser has already entered.</content>\n'
        + '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
    const response = repaired => JSON.stringify({ version: 1, messages: [{ id: 1, swipeId: 0, text: repaired }] });
    assert.equal(parseRepairResponse(response(text), snapshot).messages.length, 1);
    assert.throws(() => parseRepairResponse(response(text.replace('already entered', 'will arrive')), snapshot), /preserve/i);
    assert.throws(() => parseRepairResponse(response(text.replace('Plan.', '')), snapshot), /preserve/i);
});

test('AI can close an incomplete data wrapper but cannot rewrite its JSON payload', () => {
    const snapshot = fixture();
    snapshot.chat[1].mes = '<content>We moved to the study.</content>'
        + '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/place","value":"study"}]';
    const fixed = snapshot.chat[1].mes + '</JSONPatch></UpdateVariable>';
    const response = text => JSON.stringify({ version: 1, messages: [{ id: 1, swipeId: 0, text }] });
    assert.equal(parseRepairResponse(response(fixed), snapshot).messages.length, 1);
    assert.throws(() => parseRepairResponse(response(fixed.replace('"study"', '"garden"')), snapshot), /payload|preserve/i);
});

test('a familiar table name does not justify deleting distinct rows', () => {
    const snapshot = fixture();
    snapshot.tables = [{ uid: 'current', name: '当前信息', headers: ['时间', '地点'], pieceIndex: 2,
        rows: [['09:00', 'hall'], ['10:00', 'study']] }];
    assert.equal(buildLocalPlan(snapshot).tables.length, 0);
});

test('an ambiguous tail never permits hiding an already established body block', () => {
    const snapshot = fixture();
    snapshot.chat[1].mes = '<content>DONE</content>\n<thinking>PLAN';
    assert.throws(() => parseRepairResponse(JSON.stringify({ version: 1, messages: [{ id: 1, swipeId: 0,
        text: '<thinking>DONE PLAN</thinking><content></content>' }] }), snapshot), /narrative/i);
});

test('incomplete data wrappers may only gain missing trailing terminators', () => {
    const snapshot = fixture();
    const patch = '[{"op":"replace","path":"/place","value":"study"}]';
    snapshot.chat[1].mes = '<content>Story.</content><UpdateVariable><JSONPatch>' + patch + '</JSONPatch>';
    assert.throws(() => parseRepairResponse(JSON.stringify({ version: 1, messages: [{ id: 1, swipeId: 0,
        text: '<content>Story.</content><UpdateVariable>' + patch + '</UpdateVariable>' }] }), snapshot), /payload/i);
});

test('literal and entity-escaped reasoning labels cannot be deleted or turned into hidden content', () => {
    const snapshot = fixture();
    const propose = text => JSON.stringify({ version: 1, messages: [{ id: 1, swipeId: 0, text }] });
    snapshot.chat[1].mes = '<thinking>Use <thinking> later.\n</thinking><content>Story.</content>';
    assert.throws(() => parseRepairResponse(propose('<thinking>Use later.</thinking><content>Story.</content>'), snapshot), /preserve/i);
    snapshot.chat[1].mes = '<content>Story.</content>&lt;thinking&gt;LITERAL_EXAMPLE&lt;/thinking&gt;';
    assert.throws(() => parseRepairResponse(propose('<content>Story.</content><thinking>LITERAL_EXAMPLE</thinking>'), snapshot), /preserve/i);
});

test('Kunlun native precheck completion only inserts a terminator before an existing body', () => {
    const snapshot = fixture();
    snapshot.presetName = 'kunlun_IDE_1.2r';
    snapshot.chat[1].mes = '<!-- [IDE_AST_TRACE]\nPlan is complete.\n<content>The adviser has already arrived.</content>'
        + '<sumUp>Arrival complete.</sumUp>';
    const fixed = snapshot.chat[1].mes.replace('\n<content>', '-->\n<content>');
    const propose = text => JSON.stringify({ version: 1, messages: [{ id: 1, swipeId: 0, text }] });
    assert.equal(buildLocalPlan(snapshot).messages.length, 0);
    assert.equal(parseRepairResponse(propose(fixed), snapshot).messages[0].text, fixed);
    for (const bad of [
        fixed.replace('already arrived', 'not yet arrived'),
        fixed.replace('Arrival complete.', 'Arrival pending.'),
        fixed.replace('Plan is complete.', ''),
        fixed.replace('-->\n<content>', '\n<content>').replace('</content>', '</content>-->'),
        fixed.replace('[IDE_AST_TRACE]', '[OTHER_COMMENT]'),
    ]) assert.throws(() => parseRepairResponse(propose(bad), snapshot), /preserve|payload|ambiguous/i);
    snapshot.chat[1].mes = snapshot.chat[1].mes.replace('[IDE_AST_TRACE]', '[OTHER_COMMENT]');
    assert.throws(() => parseRepairResponse(propose(fixed.replace('[IDE_AST_TRACE]', '[OTHER_COMMENT]')), snapshot), /preserve|payload|ambiguous/i);
});

test('Kunlun transparent wrappers cannot hide adjacent unframed narrative in AI reasoning', () => {
    const snapshot = fixture();
    snapshot.presetName = 'kunlun_IDE_1.2r';
    const propose = text => JSON.stringify({ version: 1, messages: [{ id: 1, swipeId: 0, text }] });
    for (const [source, changed] of [
        ['<hidden>BODY</hidden>\nTAIL', '<hidden>BODY</hidden>\n<talk>TAIL</talk>'],
        ['HEAD\n<hidden>BODY</hidden>', '<talk>HEAD</talk>\n<hidden>BODY</hidden>'],
    ]) {
        snapshot.chat[1].mes = source;
        assert.throws(() => parseRepairResponse(propose(changed), snapshot), /preserve/i);
    }
});

test('unfinished Kunlun comments require strict completion even when generic comparisons could pass', () => {
    const snapshot = fixture();
    snapshot.presetName = 'kunlun_IDE_1.2r';
    const propose = text => JSON.stringify({ version: 1, messages: [{ id: 1, swipeId: 0, text }] });
    snapshot.chat[1].mes = '<hidden>BODY</hidden>\n<!-- [IDE_AST_TRACE]\nKeep  this --&gt;';
    assert.throws(() => parseRepairResponse(propose('<hidden>BODY</hidden>\n<!-- [IDE_AST_TRACE]\nKeep this -->'), snapshot), /preserve all bytes/i);
    snapshot.chat[1].mes = '<!-- [IDE_AST_TRACE]\nKeep  this.\n<content>Story.</content>';
    const valid = snapshot.chat[1].mes.replace('\n<content>', '-->\n<content>');
    assert.throws(() => parseRepairResponse(propose(valid.replace('Keep  this.', 'Keep this.')), snapshot), /preserve all bytes/i);
    snapshot.chat[1].mes = '<thinking>Existing plan.\n</thinking><content>Earlier story.</content>\n' + snapshot.chat[1].mes;
    const mixed = snapshot.chat[1].mes.replace('\n<content>Story.', '-->\n<content>Story.');
    assert.equal(parseRepairResponse(propose(mixed), snapshot).messages[0].text, mixed);
});
