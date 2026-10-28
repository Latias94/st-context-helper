import test from 'node:test';
import assert from 'node:assert/strict';
import { takeSnapshot, applyPlan, undoRepair, verifyRepairState, readTables } from '../src/persistence.js';

function host() {
    const context = { chatId: 'chat', characterId: 0, groupId: null,
        characters: [{ avatar: 'a.png' }], chatMetadata: {},
        chat: [{ mes: 'Old', swipes: ['Old', 'Other branch'], swipe_id: 0,
            variables: [{ stat_data: { place: 'hall' } }, { stat_data: { place: 'garden' } }] }] };
    const storage = {
        saved: structuredClone([{ chat_metadata: context.chatMetadata }, ...context.chat]),
        async save() { this.saved = structuredClone([ { chat_metadata: context.chatMetadata }, ...context.chat ]); },
        async read() { return this.saved; },
    };
    return { context, storage };
}

test('repair persists selected swipe, verifies saved data and supports undo without touching another branch', async () => {
    const { context, storage } = host(), snapshot = takeSnapshot(context, { start: 0, end: 0 });
    const plan = { fingerprint: snapshot.fingerprint, messages: [{ id: 0, swipeId: 0, text: 'Fixed' }],
        variables: [], tables: [] };
    await applyPlan(context, snapshot, plan, storage);
    assert.equal(context.chat[0].mes, 'Fixed');
    assert.deepEqual(context.chat[0].swipes, ['Fixed', 'Other branch']);
    await undoRepair(context, storage);
    assert.equal(context.chat[0].mes, 'Old');
    assert.equal(context.chat[0].variables[1].stat_data.place, 'garden');
});

test('a newer server edit is rejected before the old preview can overwrite it', async () => {
    const { context, storage } = host(), snapshot = takeSnapshot(context, { start: 0, end: 0 });
    storage.saved[1].mes = 'Edited in another browser';
    let saves = 0;
    storage.save = async () => { saves++; };
    await assert.rejects(applyPlan(context, snapshot, { fingerprint: snapshot.fingerprint,
        messages: [{ id: 0, swipeId: 0, text: 'Fixed' }], variables: [], tables: [] }, storage), /server|differs/i);
    assert.equal(saves, 0);
    assert.equal(context.chat[0].mes, 'Old');
    assert.equal(storage.saved[1].mes, 'Edited in another browser');
});

test('a newly edited message invalidates a pending repair before any mutation', async () => {
    const { context, storage } = host(), snapshot = takeSnapshot(context, { start: 0, end: 0 });
    context.chat[0].mes = 'User edit';
    await assert.rejects(applyPlan(context, snapshot, { fingerprint: snapshot.fingerprint,
        messages: [{ id: 0, swipeId: 0, text: 'Overwrite' }], variables: [], tables: [] }, storage), /changed/i);
    assert.equal(context.chat[0].mes, 'User edit');
});

test('undo cannot overwrite a newer turn', async () => {
    const { context, storage } = host(), snapshot = takeSnapshot(context, { start: 0, end: 0 });
    await applyPlan(context, snapshot, { fingerprint: snapshot.fingerprint,
        messages: [{ id: 0, swipeId: 0, text: 'Fixed' }], variables: [], tables: [] }, storage);
    context.chat.push({ mes: 'New', is_user: true });
    await assert.rejects(undoRepair(context, storage), /changed/i);
});

test('an empty repair preserves the prior undo backup', async () => {
    const { context, storage } = host();
    await applyPlan(context, takeSnapshot(context, { start: 0, end: 0 }), {
        fingerprint: takeSnapshot(context, { start: 0, end: 0 }).fingerprint,
        messages: [{ id: 0, swipeId: 0, text: 'Fixed' }], variables: [], tables: [],
    }, storage);
    const snapshot = takeSnapshot(context, { start: 0, end: 0 });
    await applyPlan(context, snapshot, { fingerprint: snapshot.fingerprint, messages: [], variables: [], tables: [] }, storage);
    await undoRepair(context, storage);
    assert.equal(context.chat[0].mes, 'Old');
});

test('edits during the asynchronous save invalidate success without reverting the user edit', async () => {
    const { context, storage } = host(), snapshot = takeSnapshot(context, { start: 0, end: 0 });
    storage.save = async function () {
        this.saved = structuredClone([{ chat_metadata: context.chatMetadata }, ...context.chat]);
        context.chat.push({ mes: 'New user input', is_user: true });
    };
    await assert.rejects(applyPlan(context, snapshot, { fingerprint: snapshot.fingerprint,
        messages: [{ id: 0, swipeId: 0, text: 'Fixed' }], variables: [], tables: [] }, storage), /changed/i);
    assert.equal(context.chat.at(-1).mes, 'New user input');
});

test('table repairs synchronize the memory replay cache, preserve cells and undo the cache change', async () => {
    const { context, storage } = host();
    context.chat[0].mes = '<tableEdit>insertRow(0, {"0":"A"})</tableEdit>';
    context.chat[0].hash_sheets = { t: [['h0', 'h1'], ['r1', 'v1'], ['r2', 'v2']] };
    context.chatMetadata.sheets = [{ uid: 't', name: 'People', enable: true,
        hashSheet: structuredClone(context.chat[0].hash_sheets.t),
        cellHistory: Object.entries({ h0: '', h1: 'Name', r1: '', v1: 'A', r2: '', v2: 'A' })
            .map(([uid, value]) => ({ uid, data: { value } })) }];
    storage.saved = structuredClone([{ chat_metadata: context.chatMetadata }, ...context.chat]);
    const snapshot = takeSnapshot(context, { start: 0, end: 0 });
    const backup = await applyPlan(context, snapshot, { fingerprint: snapshot.fingerprint,
        messages: [], variables: [], tables: [{ uid: 't', rows: [['A']] }] }, storage);
    assert.deepEqual(context.chat[0].tableEditMatches, ['insertRow(0, {"0":"A"})']);
    assert.equal(context.chatMetadata.sheets[0].cellHistory.length, 6);
    assert.equal(readTables(context.chat, context.chatMetadata)[0].rows.length, 1);
    await verifyRepairState(context, backup, storage);
    context.chat[0].hash_sheets.t.push(['r2', 'v2']);
    await assert.rejects(verifyRepairState(context, backup, storage), /reload|extension/i);
    context.chat[0].hash_sheets.t.pop();
    await undoRepair(context, storage);
    assert.equal(context.chat[0].tableEditMatches, undefined);
    assert.equal(readTables(context.chat, context.chatMetadata)[0].rows.length, 2);
});

test('undo identity survives character list reordering', async () => {
    const { context, storage } = host();
    const snapshot = takeSnapshot(context, { start: 0, end: 0 });
    await applyPlan(context, snapshot, { fingerprint: snapshot.fingerprint,
        messages: [{ id: 0, swipeId: 0, text: 'Fixed' }], variables: [], tables: [] }, storage);
    context.characters.unshift({ avatar: 'another.png' });
    context.characterId = 1;
    await undoRepair(context, storage);
    assert.equal(context.chat[0].mes, 'Old');
});

test('missing table references remain inspectable but are never an automatic repair target', () => {
    const { context } = host();
    context.chat[0].hash_sheets = {};
    context.chatMetadata.sheets = [{ uid: 't', name: 'Partial', cellHistory: [], hashSheet: [['missing']] }];
    const table = readTables(context.chat, context.chatMetadata)[0];
    assert.equal(table.repairable, false);
    assert.ok(table.warning.includes('missing'));
});
