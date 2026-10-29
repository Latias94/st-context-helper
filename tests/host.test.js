import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../src/host.js';

async function fixture(t) {
    const originals = { SillyTavern: globalThis.SillyTavern, document: globalThis.document, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, originals));
    const listeners = new Map(), counts = { encodes: 0, chatWrites: 0, settingsWrites: 0 };
    const state = { mainApi: 'openai', chatId: 'first', characterId: 0, characters: [{ avatar: 'card.png' }],
        chat: [{ mes: 'Saved story.' }], chatMetadata: {},
        extensionSettings: { context_helper: { connectionId: 'saved-profile' }, unrelated: { enabled: true } },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        async saveChat() { counts.chatWrites++; },
    };
    let disk, rejectReadback = false, deferEncode;
    state.eventTypes = Object.fromEntries(['CHAT_COMPLETION_PROMPT_READY', 'CHAT_COMPLETION_SETTINGS_READY',
        'CHAT_CHANGED', 'MESSAGE_RECEIVED'].map(name => [name, name]));
    state.eventSource = { on(name, callback) { listeners.set(name, [...listeners.get(name) ?? [], callback]); } };
    const emit = async (name, data) => { for (const callback of listeners.get(name) ?? []) await callback(data); };
    const settings = { openai_max_context: 1000, openai_max_tokens: 100, chat_completion_source: 'openai' };
    const native = {
        script: { isGenerating: () => true, isChatSaving: false,
            async saveSettings() { counts.settingsWrites++; disk = structuredClone(state.extensionSettings); } },
        openai: { oai_settings: settings, getChatCompletionModel: () => 'gpt-4o' },
        tokenizers: { getTokenizerModel: () => 'gpt-4o' }, regex: {},
    };
    globalThis.SillyTavern = { getContext: () => state };
    globalThis.document = { querySelector: () => null };
    globalThis.fetch = async (url, options) => {
        if (String(url).startsWith('/api/tokenizers/openai/encode?')) {
            counts.encodes++;
            options.signal?.throwIfAborted();
            if (deferEncode) await deferEncode;
            options.signal?.throwIfAborted();
            return Response.json({ ids: [42], count: 1 });
        }
        assert.equal(url, '/api/settings/get', 'Only native local tokenization and settings readback may be called');
        return Response.json({ settings: JSON.stringify({ extension_settings: rejectReadback ? {} : disk }) });
    };
    const host = await createHost({ native });
    return { host, state, settings, native, counts, emit,
        get disk() { return disk; },
        set rejectReadback(value) { rejectReadback = value; },
        deferEncoding() { return new Promise(resolve => { deferEncode = new Promise(done => resolve(done)); }); },
        async capture(overrides = {}) {
            await emit('CHAT_COMPLETION_SETTINGS_READY', { model: 'gpt-4o', max_tokens: 837,
                messages: [{ role: 'system', content: 'World.' }, { role: 'user', content: 'Next.' }], ...overrides });
        },
    };
}

test('final full-request capture counts once and changing the threshold reuses the tokenization', async t => {
    const f = await fixture(t);
    await f.emit('CHAT_COMPLETION_PROMPT_READY', { chat: [{ role: 'user', content: 'Preliminary.' }] });
    assert.equal((await f.host.inspectMonitor()).tokens.status, 'unavailable');
    assert.equal(f.counts.encodes, 0);
    await f.capture();
    const first = (await f.host.inspectMonitor()).tokens;
    assert.equal(first.inputTokens, 13);
    assert.equal(first.totalTokens, 850);
    assert.equal(first.contextLimit, 1000);
    assert.equal(first.thresholdReached, true);
    assert.equal(first.stage, 'CHAT_COMPLETION_SETTINGS_READY');
    const encoded = f.counts.encodes;
    await f.host.saveMonitorOptions({ showMonitor: true, tokenWarningPercent: 90 });
    const next = (await f.host.inspectMonitor()).tokens;
    assert.equal(next.thresholdReached, false);
    assert.equal(next.thresholdPercent, 90);
    assert.equal(f.counts.encodes, encoded);
    assert.equal(f.counts.chatWrites, 0);
});

test('unknown token-bearing message fields, tool schemas and multimedia cannot be silently dropped', async t => {
    const f = await fixture(t);
    for (const data of [
        { tools: [{ type: 'function' }] }, { tools: { schema: 'unsupported' } }, { json_schema: { type: 'object' } },
        { messages: [{ role: 'assistant', content: '', function_call: { name: 'example', arguments: '{}' } }] },
        { messages: [{ role: 'assistant', content: 'Visible', reasoning_content: 'More tokens.' }] },
        { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:fixture' } }] }] },
    ]) {
        await f.capture(data);
        assert.equal((await f.host.inspectMonitor()).tokens.status, 'unavailable');
    }
    assert.equal(f.counts.encodes, 0);
});

test('an unknown provider cannot silently inherit the native generic Turbo fallback', async t => {
    const f = await fixture(t);
    f.native.tokenizers.getTokenizerModel = () => 'gpt-3.5-turbo';
    await f.capture({ model: 'unlisted-provider-model' });
    const usage = (await f.host.inspectMonitor()).tokens;
    assert.equal(usage.status, 'unavailable');
    assert.equal(usage.reason, 'unsupported-tokenizer');
    assert.equal(f.counts.encodes, 0);
});

test('dry runs do not replace a real capture and chat changes cannot reuse its count', async t => {
    const f = await fixture(t);
    await f.capture();
    await f.capture({ dryRun: true, max_tokens: 999 });
    assert.equal((await f.host.inspectMonitor()).tokens.reservedOutputTokens, 837);
    f.state.chatId = 'second';
    await f.emit('CHAT_CHANGED');
    assert.equal((await f.host.inspectMonitor()).tokens.status, 'unavailable');
});

test('group captures remain valid after the active speaker is cleared', async t => {
    const f = await fixture(t);
    f.state.groupId = 'group-one';
    await f.capture();
    assert.equal((await f.host.inspectMonitor()).tokens.status, 'available');
    f.state.characterId = undefined;
    assert.equal((await f.host.inspectMonitor()).tokens.status, 'available');
    f.state.groupId = 'group-two';
    await f.emit('CHAT_CHANGED');
    assert.equal((await f.host.inspectMonitor()).tokens.status, 'unavailable');
});

test('an asynchronous count that finishes after a chat switch cannot publish the old chat budget', async t => {
    const f = await fixture(t), release = await f.deferEncoding();
    await f.capture();
    const pending = f.host.inspectMonitor();
    f.state.chatId = 'second';
    await f.emit('CHAT_CHANGED');
    release();
    assert.equal((await pending).tokens.status, 'unavailable');
});

test('monitor preferences save globally without changing chat metadata or unrelated settings', async t => {
    const f = await fixture(t), metadata = structuredClone(f.state.chatMetadata);
    assert.equal(f.host.getMonitorSettings().showMonitor, false);
    await f.host.saveMonitorOptions({ showMonitor: true, tokenWarningPercent: 92 });
    assert.equal(f.disk.context_helper.connectionId, 'saved-profile');
    assert.equal(f.disk.context_helper.showMonitor, true);
    assert.equal(f.disk.context_helper.tokenWarningPercent, 92);
    assert.deepEqual(f.disk.unrelated, { enabled: true });
    assert.deepEqual(f.state.chatMetadata, metadata);
    assert.equal(f.counts.chatWrites, 0);
    f.rejectReadback = true;
    await assert.rejects(f.host.saveMonitorOptions({ showMonitor: false, tokenWarningPercent: 92 }), /读回/);
    assert.equal(f.host.getMonitorSettings().showMonitor, false);
});
