export const BACKUP_KEY = 'context_helper_backup';
export const BACKUP_VERSION = 1;
const clone = value => structuredClone(value);

function metadataWithoutBackup(metadata = {}) {
    const { [BACKUP_KEY]: ignored, ...rest } = metadata;
    return rest;
}

function identity(context) {
    return [context.chatId, context.groupId, context.characters?.[context.characterId]?.avatar];
}

function fingerprint(context) {
    // Exact comparison is intentional: a pending preview must not overwrite even a small edit.
    return JSON.stringify([identity(context), context.chat, metadataWithoutBackup(context.chatMetadata)]);
}

export function readTables(chat, metadata = {}, end = chat.length - 1) {
    const pieceIndex = chat.findLastIndex((row, id) => id <= end && row.hash_sheets);
    if (pieceIndex < 0) return [];
    return (metadata.sheets ?? []).filter(sheet => sheet.enable !== false).map(sheet => {
        const references = chat[pieceIndex].hash_sheets[sheet.uid];
        const hashes = references ?? sheet.hashSheet;
        const cells = new Map((sheet.cellHistory ?? []).map(cell => [cell.uid, cell.data?.value ?? '']));
        const validRows = Array.isArray(hashes) ? hashes.filter(Array.isArray) : [];
        const repairable = Array.isArray(references) && references.length > 0
            && validRows.length === hashes.length && validRows.every(row => row.every(uid => cells.has(uid)));
        const values = validRows.map(row => row.slice(1).map(uid => cells.get(uid) ?? ''));
        return { uid: sheet.uid, name: sheet.name, headers: values[0] ?? [], rows: values.slice(1), pieceIndex,
            repairable, referenceSource: references ? 'message' : 'metadata',
            ...repairable ? {} : { warning: 'Some message references or historical cells are missing. Metadata fallback is inspection-only.' } };
    });
}

export function takeSnapshot(context, options = {}, extra = {}) {
    if (!context.chatId || !context.chat?.length) throw new Error('Open a saved conversation first.');
    const start = Math.max(0, Number(options.start ?? Math.max(0, context.chat.length - 12)));
    const end = Math.min(context.chat.length - 1, Number(options.end ?? context.chat.length - 1));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) throw new Error('Invalid message range.');
    return { ...extra, chatId: context.chatId, characterId: context.characterId, groupId: context.groupId,
        avatar: context.characters?.[context.characterId]?.avatar,
        start, end, chat: clone(context.chat), metadata: clone(metadataWithoutBackup(context.chatMetadata)),
        tables: readTables(context.chat, context.chatMetadata, end), fingerprint: fingerprint(context),
        chatReference: context.chat, metadataReference: context.chatMetadata };
}

function assertCurrent(context, snapshot) {
    if (context.chat !== snapshot.chatReference || context.chatMetadata !== snapshot.metadataReference
        || fingerprint(context) !== snapshot.fingerprint) throw new Error('Conversation changed. Inspect again before applying.');
}

async function assertServerCurrent(context, storage) {
    let saved;
    try { saved = await storage.read(); }
    catch { throw new Error('Unable to check the current server state. No repair was written.'); }
    if (!Array.isArray(saved) || !saved[0]?.chat_metadata) throw new Error('Invalid server baseline; no repair was written.');
    const loaded = { ...context, chat: saved.slice(1), chatMetadata: saved[0].chat_metadata };
    if (fingerprint(loaded) !== fingerprint(context)
        || JSON.stringify(loaded.chatMetadata[BACKUP_KEY]) !== JSON.stringify(context.chatMetadata[BACKUP_KEY])) {
        throw new Error('Server conversation differs from this page. Reload and inspect again before writing.');
    }
}

function selectedFields(context, backup) {
    const storedBackup = context.chatMetadata[BACKUP_KEY];
    const { expected: ignored, ...backupContent } = storedBackup ?? {};
    return JSON.stringify({
        identity: identity(context), length: context.chat.length,
        rows: backup.rows.map(({ id }) => {
            const row = context.chat[id];
            return [id, row.mes, row.swipe_id ?? 0, row.swipes, row.variables, row.variables_initialized, row.tableEditMatches];
        }),
        tables: backup.tables.map(({ uid, pieceIndex }) => [
            uid, context.chatMetadata.sheets.find(sheet => sheet.uid === uid)?.hashSheet,
            context.chat[pieceIndex]?.hash_sheets?.[uid],
            context.chatMetadata.sheets.find(sheet => sheet.uid === uid)?.cellHistory,
        ]),
        backup: storedBackup ? backupContent : null,
    });
}

function rebuildTable(context, table, change) {
    const stored = context.chatMetadata.sheets.find(sheet => sheet.uid === table.uid);
    const piece = context.chat[table.pieceIndex];
    const oldHashes = piece.hash_sheets[table.uid] ?? stored.hashSheet;
    const known = new Map(stored.cellHistory.map(cell => [cell.uid, cell.data?.value ?? '']));
    const available = new Map();
    for (const row of oldHashes.slice(1)) {
        const key = JSON.stringify(row.slice(1).map(uid => known.get(uid) ?? ''));
        if (!available.has(key)) available.set(key, []);
        available.get(key).push(row);
    }
    const hashes = [clone(oldHashes[0])];
    for (const row of change.rows) {
        const existing = available.get(JSON.stringify(row))?.shift();
        if (existing) { hashes.push(clone(existing)); continue; }
        const rowHash = [];
        for (const value of ['', ...row]) {
            const uid = `cell_${table.uid}_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
            stored.cellHistory.push({ uid, data: { value }, ...(rowHash.length ? {} : { type: 'row_header' }) });
            rowHash.push(uid);
        }
        hashes.push(rowHash);
    }
    stored.hashSheet = clone(hashes);
    piece.hash_sheets[table.uid] = clone(hashes);
}

async function persistAndVerify(context, backup, storage) {
    backup.expected = selectedFields(context, backup);
    const expectedContext = fingerprint(context);
    await storage.save();
    if (fingerprint(context) !== expectedContext) throw new Error('Conversation changed during saving. New edits and the backup were retained.');
    let saved;
    try {
        saved = await storage.read();
    } catch {
        throw new Error('Save verification is unavailable. In-memory repair and undo backup are retained; inspect the connection before retrying.');
    }
    if (!Array.isArray(saved) || !saved[0]?.chat_metadata) throw new Error('Invalid save verification response.');
    const loaded = { ...context, chat: saved.slice(1), chatMetadata: saved[0].chat_metadata };
    if (fingerprint(context) !== expectedContext) throw new Error('Conversation changed during verification. New edits were retained.');
    if (fingerprint(loaded) !== expectedContext || selectedFields(loaded, backup) !== backup.expected) {
        throw new Error('Saved conversation does not match this repair. Backup retained; no automatic overwrite was attempted.');
    }
}

export async function verifyRepairState(context, backup, storage) {
    if (!backup) return;
    if (selectedFields(context, backup) !== backup.expected) {
        throw new Error('An extension changed repaired fields during chat reload. Inspect again; the saved backup is retained.');
    }
    const saved = await storage.read();
    if (!Array.isArray(saved) || !saved[0]?.chat_metadata
        || selectedFields({ ...context, chat: saved.slice(1), chatMetadata: saved[0].chat_metadata }, backup) !== backup.expected) {
        throw new Error('Repaired fields changed on the server after reload. Inspect again before continuing.');
    }
}

export function canUndoRepair(context) {
    const backup = context.chatMetadata?.[BACKUP_KEY];
    try {
        return Boolean(backup?.version === BACKUP_VERSION && selectedFields(context, backup) === backup.expected);
    } catch {
        return false;
    }
}

export async function applyPlan(context, snapshot, plan, storage) {
    assertCurrent(context, snapshot);
    if (plan.fingerprint !== snapshot.fingerprint) throw new Error('Repair belongs to another snapshot.');
    if (!plan.messages.length && !plan.variables.length && !plan.tables.length) return null;
    await assertServerCurrent(context, storage);
    assertCurrent(context, snapshot);
    const ids = [...new Set([...plan.messages, ...plan.variables].map(change => change.id).concat(
        plan.tables.map(change => snapshot.tables.find(table => table.uid === change.uid)?.pieceIndex)))];
    for (const change of [...plan.messages, ...plan.variables]) {
        if (!Number.isInteger(change.id) || change.id < snapshot.start || change.id > snapshot.end
            || change.swipeId !== (context.chat[change.id].swipe_id ?? 0)) throw new Error('Repair scope or swipe changed.');
    }
    const backup = {
        version: BACKUP_VERSION, createdAt: new Date().toISOString(), rows: ids.map(id => ({ id, row: clone(context.chat[id]) })),
        tables: plan.tables.map(change => {
            const table = snapshot.tables.find(table => table.uid === change.uid);
            if (!table) throw new Error('Repair targets an unknown table.');
            if (table.repairable === false) throw new Error('Incomplete table references require manual review.');
            if (table.pieceIndex < snapshot.start || table.pieceIndex > snapshot.end) {
                throw new Error('Table snapshot is outside the selected range.');
            }
            const stored = context.chatMetadata.sheets.find(sheet => sheet.uid === change.uid);
            return { uid: change.uid, pieceIndex: table.pieceIndex, hashSheet: clone(stored.hashSheet),
                pieceHashes: clone(context.chat[table.pieceIndex].hash_sheets[change.uid]) };
        }),
    };
    context.chatMetadata[BACKUP_KEY] = backup;
    for (const change of plan.messages) {
        const row = context.chat[change.id];
        row.mes = change.text;
        if (row.swipes) row.swipes[change.swipeId] = change.text;
    }
    for (const change of plan.variables) {
        const row = context.chat[change.id];
        row.variables ??= [];
        row.variables[change.swipeId] = clone(change.data);
        row.variables_initialized ??= [];
        row.variables_initialized[change.swipeId] = true;
    }
    for (const change of plan.tables) rebuildTable(context, snapshot.tables.find(table => table.uid === change.uid), change);
    for (const id of ids) {
        const row = context.chat[id];
        if (!row.hash_sheets || !context.chatMetadata.sheets?.length) continue;
        // st-memory-enhancement otherwise replays unchanged table actions on render.
        row.tableEditMatches = [...row.mes.matchAll(/<tableEdit>(.*?)<\/tableEdit>/gs)].map(match => match[1]);
    }
    await persistAndVerify(context, backup, storage);
    return backup;
}

export async function undoRepair(context, storage) {
    const backup = context.chatMetadata?.[BACKUP_KEY];
    if (!backup || backup.version !== BACKUP_VERSION) throw new Error('No compatible context repair is available to undo.');
    if (!canUndoRepair(context)) throw new Error('Conversation changed after repair; automatic undo is unavailable.');
    const currentFingerprint = fingerprint(context);
    await assertServerCurrent(context, storage);
    if (fingerprint(context) !== currentFingerprint || selectedFields(context, backup) !== backup.expected) {
        throw new Error('Conversation changed while checking the server. Undo was not written.');
    }
    for (const { id, row } of backup.rows) {
        const current = context.chat[id];
        for (const key of ['mes', 'swipes', 'variables', 'variables_initialized', 'tableEditMatches']) {
            if (Object.hasOwn(row, key)) current[key] = clone(row[key]);
            else delete current[key];
        }
    }
    for (const previous of backup.tables) {
        context.chatMetadata.sheets.find(sheet => sheet.uid === previous.uid).hashSheet = clone(previous.hashSheet);
        const hashes = context.chat[previous.pieceIndex].hash_sheets;
        if (previous.pieceHashes) hashes[previous.uid] = clone(previous.pieceHashes);
        else delete hashes[previous.uid];
    }
    delete context.chatMetadata[BACKUP_KEY];
    await persistAndVerify(context, backup, storage);
    return backup;
}
