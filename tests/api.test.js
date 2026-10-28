import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createRepairApi, getRepairConnections, getRepairModels, refreshRepairModels, requestContextRepair,
} from '../src/api.js';

function fixture({ profiles = [], presets = {}, models = [], settings = {}, mainApi = 'openai' } = {}) {
    const sent = [];
    const converted = [];
    const queried = [];
    const current = {
        chat_completion_source: 'custom', custom_url: 'https://current.invalid/v1',
        custom_model: 'current-model', openai_max_tokens: 256, temp_openai: 1.5,
        reverse_proxy: 'https://current-proxy.invalid/v1', proxy_password: 'synthetic-current-password',
        n: 5, stream_openai: true, openrouter_providers: ['configured-provider'], ...settings,
    };
    const context = { extensionSettings: { disabledExtensions: [], connectionManager: { profiles } } };
    const state = {
        status: { data: [{ id: 'listed-chat' }] },
        response: { choices: [{ finish_reason: 'stop', message: { content: 'complete' } }] },
    };
    const host = {
        openai: {
            oai_settings: current, proxies: [], model_list: models,
            settingsToUpdate: Object.fromEntries([
                ['temperature', 'temp_openai'], ['openai_max_tokens', 'openai_max_tokens'],
                ['chat_completion_source', 'chat_completion_source'], ['custom_url', 'custom_url'],
                ['custom_include_headers', 'custom_include_headers'], ['bias_presets', 'bias_presets'],
                ['bias_preset_selected', 'bias_preset_selected'], ['openrouter_providers', 'openrouter_providers'],
                ['azure_base_url', 'azure_base_url'], ['azure_deployment_name', 'azure_deployment_name'],
                ['azure_api_version', 'azure_api_version'],
            ].map(([key, field]) => [key, ['', field]])),
            getChatCompletionModel: value => value[`${value.chat_completion_source}_model`] || 'current-model',
            createGenerationParameters: async (value, model, type, messages) => {
                converted.push({ settings: structuredClone(value), model, type, messages: structuredClone(messages) });
                if (state.convert) return state.convert(value, model, type, messages);
                return { generate_data: {
                    model, messages, chat_completion_source: value.chat_completion_source,
                    max_tokens: value.openai_max_tokens, temperature: value.temp_openai,
                    stream: true, stop: ['global-chat-stop'],
                } };
            },
        },
        requests: {
            ChatCompletionService: { sendRequest: async (payload, extractData, signal) => {
                sent.push({ payload: structuredClone(payload), extractData, signal });
                return state.send ? state.send(payload, signal) : state.response;
            } },
        },
        shared: {
            ConnectionManagerRequestService: {
                getProfile: id => {
                    const profile = profiles.find(row => row.id === id);
                    if (!profile) throw new Error(`Profile not found: ${id}`);
                    return profile;
                },
                validateProfile: profile => profile.api === 'text'
                    ? { selected: 'textgenerationwebui', type: 'koboldcpp' }
                    : { selected: 'openai', source: profile.api },
            },
        },
        script: {
            main_api: mainApi, getRequestHeaders: () => ({ 'X-Test-CSRF': 'synthetic' }),
            substituteParams: value => value.replaceAll('{{test}}', 'expanded'),
            extractMessageFromData: (data, api) => {
                assert.equal(api, 'openai');
                return data?.choices?.[0]?.message?.content ?? data?.content?.[0]?.text ?? '';
            },
        },
        presets: { getPresetManager: () => ({ getCompletionPresetByName: name => presets[name] }) },
    };
    const dependencies = {
        loadHost: async () => host, context: () => context,
        fetch: async (url, request) => {
            queried.push({ url, request, payload: JSON.parse(request.body) });
            return state.fetch ? state.fetch(url, request) : { ok: true, json: async () => state.status };
        },
    };
    return {
        api: createRepairApi(dependencies), dependencies, host, current, context, state,
        profiles, presets, sent, converted, queried,
    };
}

test('the public module imports in Node without loading browser host modules', () => {
    for (const method of [getRepairConnections, getRepairModels, refreshRepairModels, requestContextRepair]) {
        assert.equal(typeof method, 'function');
    }
});

test('connection descriptors expose only hosts and omit unsupported or broken saved profiles', async () => {
    const h = fixture({
        settings: { custom_url: 'https://user:synthetic-password@current.invalid:8443/private?token=synthetic#secret' },
        profiles: [
            { id: 'saved', name: 'Saved', api: 'custom', model: 'saved-model', 'api-url': 'https://saved.invalid/v1?key=synthetic' },
            { id: 'text', api: 'text' },
            { id: 'missing-preset', api: 'custom', preset: 'deleted' },
        ],
    });
    assert.deepEqual(await h.api.getRepairConnections(), [
        { id: 'current', name: 'Current connection', source: 'custom', model: 'current-model', endpoint: 'current.invalid:8443', available: true },
        { id: 'saved', name: 'Saved', source: 'custom', model: 'saved-model', endpoint: 'saved.invalid', available: true },
    ]);
    h.context.extensionSettings.disabledExtensions.push('connection-manager');
    assert.equal((await h.api.getRepairConnections()).length, 1);
    await assert.rejects(h.api.requestContextRepair([], { connectionId: 'saved' }), /connection manager/i);
    assert.equal(h.sent.length, 0);
});

test('the default context dependency reads SillyTavern.getContext at call time', async t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'SillyTavern');
    t.after(() => previous
        ? Object.defineProperty(globalThis, 'SillyTavern', previous)
        : Reflect.deleteProperty(globalThis, 'SillyTavern'));
    const h = fixture({ profiles: [{ id: 'saved', api: 'openai', model: 'o3' }] });
    const api = createRepairApi({ loadHost: h.dependencies.loadHost, fetch: h.dependencies.fetch });
    globalThis.SillyTavern = { getContext: () => h.context };
    assert.equal((await api.getRepairConnections()).length, 2);
    h.context.extensionSettings.disabledExtensions.push('connection-manager');
    assert.equal((await api.getRepairConnections()).length, 1);
});

test('current requests use repair defaults, native conversion and the supplied abort signal', async () => {
    const h = fixture();
    const before = structuredClone(h.current);
    const messages = [{ role: 'system', content: 'Repair only the selected range.' }];
    const signal = new AbortController().signal;
    assert.equal(await h.api.requestContextRepair(messages, {}, signal), 'complete');
    assert.equal(h.converted[0].settings.openai_max_tokens, 8192);
    assert.equal(h.converted[0].settings.temp_openai, 0.2);
    assert.equal(h.converted[0].settings.n, 1);
    assert.equal(h.converted[0].settings.stream_openai, false);
    assert.equal(h.converted[0].settings.reverse_proxy, '');
    assert.equal(h.converted[0].type, 'quiet');
    assert.deepEqual(h.sent[0], {
        payload: { model: 'current-model', messages, chat_completion_source: 'custom', max_tokens: 8192, temperature: 0.2, stream: false },
        extractData: false, signal,
    });
    assert.deepEqual(h.current, before);
});

test('saved presets and caller messages stay isolated while native model filtering is preserved', async () => {
    const h = fixture({
        profiles: [{ id: 'saved', api: 'openai', model: 'o3', preset: 'reasoning', 'secret-id': 'synthetic-secret-id' }],
        presets: { reasoning: {
            chat_completion_source: 'custom', openai_max_tokens: 1200, temperature: 1.8,
            bias_preset_selected: 'missing-bias', openrouter_providers: ['saved-provider'],
        } },
    });
    const before = structuredClone({ current: h.current, presets: h.presets, profiles: h.profiles });
    const messages = [{ role: 'system', content: 'Keep the original input.' }];
    h.state.convert = (settings, model, type, input) => {
        assert.equal(settings.bias_preset_selected, undefined);
        settings.openrouter_providers.push('mutated by host');
        input[0].role = 'user';
        return { generate_data: {
            model, messages: input, chat_completion_source: settings.chat_completion_source,
            max_completion_tokens: settings.openai_max_tokens, stream: true, stop: ['chat-stop'],
        } };
    };
    await h.api.requestContextRepair(messages, { connectionId: 'saved', model: 'o1', maxTokens: 4096, temperature: 0.4 });
    assert.equal(h.converted[0].settings.chat_completion_source, 'openai');
    assert.equal(h.converted[0].settings.temp_openai, 0.4);
    assert.equal(h.sent[0].payload.model, 'o1');
    assert.equal(h.sent[0].payload.max_completion_tokens, 4096);
    assert.equal(h.sent[0].payload.secret_id, 'synthetic-secret-id');
    for (const field of ['max_tokens', 'n', 'stop', 'temperature', 'reverse_proxy', 'proxy_password']) {
        assert.equal(field in h.sent[0].payload, false);
    }
    assert.deepEqual(messages, [{ role: 'system', content: 'Keep the original input.' }]);
    assert.deepEqual({ current: h.current, presets: h.presets, profiles: h.profiles }, before);
});

test('current and saved repairs bypass native global bias calculation without changing stored settings', async () => {
    const h = fixture({
        settings: { bias_preset_selected: 'live', bias_presets: { live: [{ text: 'live-bias', value: 10 }] } },
        profiles: [{ id: 'saved', api: 'custom', model: 'saved-model', preset: 'biased' }],
        presets: { biased: { bias_preset_selected: 'saved', bias_presets: { saved: [{ text: 'saved-bias', value: -10 }] } } },
    });
    const before = structuredClone({ current: h.current, presets: h.presets });
    let globalBiasReads = 0;
    h.state.convert = (settings, model, type, messages) => {
        const payload = { model, messages, stream: false };
        // The native converter reads global settings/cache whenever the cloned selection is enabled.
        if (settings.bias_preset_selected && settings.bias_presets[settings.bias_preset_selected]?.length) {
            globalBiasReads++;
            payload.logit_bias = { 123: h.current.bias_presets[h.current.bias_preset_selected][0].value };
        }
        return { generate_data: payload };
    };
    for (const connectionId of ['current', 'saved']) {
        assert.equal(await h.api.requestContextRepair([], { connectionId }), 'complete');
    }
    assert.equal(globalBiasReads, 0);
    assert.ok(h.sent.every(({ payload }) => payload.logit_bias === undefined));
    assert.deepEqual({ current: h.current, presets: h.presets }, before);
});

test('explicit proxies and selected secret IDs follow saved requests and model-list requests', async () => {
    const h = fixture({ profiles: [{ id: 'saved', api: 'openai', model: 'o3', proxy: 'Saved proxy', 'secret-id': 'saved-secret-id' }] });
    h.host.openai.proxies.push({ name: 'Saved proxy', url: 'https://proxy.invalid/private?key=synthetic', password: 'saved-proxy-password' });
    await h.api.requestContextRepair([], { connectionId: 'saved' });
    await h.api.refreshRepairModels('saved');
    for (const payload of [h.sent[0].payload, h.queried[0].payload]) {
        assert.equal(payload.reverse_proxy, 'https://proxy.invalid/private?key=synthetic');
        assert.equal(payload.proxy_password, 'saved-proxy-password');
        assert.equal(payload.secret_id, 'saved-secret-id');
    }
    assert.equal(h.converted[0].settings.reverse_proxy, '');
    assert.equal((await h.api.getRepairConnections())[1].endpoint, 'proxy.invalid');
    assert.equal(h.queried[0].url, '/api/backends/chat-completions/status');
    assert.deepEqual(h.queried[0].request.headers, { 'X-Test-CSRF': 'synthetic' });
});

test('saved direct routes and sources without proxy support ignore a stale global proxy', async () => {
    const h = fixture({ profiles: [
        { id: 'direct', api: 'openai', model: 'o3' },
        { id: 'custom', api: 'custom', model: 'custom-model', proxy: 'deleted proxy', 'api-url': 'https://custom.invalid/v1' },
        { id: 'none', api: 'openai', model: 'o3', proxy: 'None' },
    ] });
    h.host.openai.proxies.push({ name: 'None', url: '', password: '' });
    for (const connectionId of ['direct', 'custom', 'none']) {
        await h.api.requestContextRepair([], { connectionId });
        await h.api.refreshRepairModels(connectionId);
    }
    for (const { payload } of [...h.sent, ...h.queried]) {
        assert.equal('reverse_proxy' in payload, false);
        assert.equal('proxy_password' in payload, false);
    }
});

test('current supported proxies are retained without adding a saved secret ID', async () => {
    const h = fixture({ settings: { chat_completion_source: 'openai', openai_model: 'o3' } });
    await h.api.requestContextRepair([]);
    await h.api.refreshRepairModels();
    for (const { payload } of [...h.sent, ...h.queried]) {
        assert.equal(payload.reverse_proxy, 'https://current-proxy.invalid/v1');
        assert.equal(payload.proxy_password, 'synthetic-current-password');
        assert.equal('secret_id' in payload, false);
    }
});

test('model-list routing preserves custom headers, regional selectors and Azure settings', async () => {
    const h = fixture({
        profiles: [
            { id: 'custom', api: 'custom', preset: 'headers', 'api-url': 'https://saved.invalid/v1',
                'secret-id': 'selected-id', 'prompt-post-processing': 'strict' },
            { id: 'regional', api: 'siliconflow', 'api-url': 'cn' },
            { id: 'azure', api: 'azure_openai', preset: 'azure' },
        ],
        presets: {
            headers: { custom_url: 'https://preset.invalid/v1', custom_include_headers: 'X-Test: {{test}}' },
            azure: { azure_base_url: 'https://azure.invalid', azure_deployment_name: 'deployment', azure_api_version: 'version' },
        },
    });
    await h.api.refreshRepairModels('custom');
    await h.api.refreshRepairModels('regional');
    await h.api.refreshRepairModels('azure');
    assert.deepEqual(h.queried.map(row => row.payload), [
        { chat_completion_source: 'custom', custom_url: 'https://saved.invalid/v1', custom_include_headers: 'X-Test: expanded', secret_id: 'selected-id' },
        { chat_completion_source: 'siliconflow', siliconflow_endpoint: 'cn' },
        { chat_completion_source: 'azure_openai', azure_base_url: 'https://azure.invalid', azure_deployment_name: 'deployment', azure_api_version: 'version' },
    ]);
    await h.api.requestContextRepair([], { connectionId: 'custom' });
    assert.equal(h.converted[0].settings.custom_url, 'https://saved.invalid/v1');
    assert.equal(h.converted[0].settings.custom_include_headers, 'X-Test: {{test}}');
    assert.equal(h.converted[0].settings.custom_prompt_post_processing, 'strict');
});

test('model caches stay isolated, copy provider rows and invalidate when a saved route changes', async () => {
    const h = fixture({
        profiles: [
            { id: 'first', api: 'cohere', model: 'first-configured' },
            { id: 'second', api: 'cohere', model: 'second-configured' },
        ],
        models: [{ id: 'unrelated-current-model' }],
    });
    h.state.status = { models: [{ name: 'command-chat', endpoints: ['chat'] }, { name: 'embed-only', endpoints: ['embed'] }] };
    assert.deepEqual(await h.api.refreshRepairModels('first'), ['command-chat']);
    assert.deepEqual(await h.api.getRepairModels('second'), ['second-configured']);
    h.state.status.models[0].name = 'changed-after-response';
    assert.deepEqual(await h.api.getRepairModels('first'), ['first-configured', 'command-chat']);
    h.profiles[0]['secret-id'] = 'different-secret-id';
    assert.deepEqual(await h.api.getRepairModels('first'), ['first-configured']);
    h.profiles.splice(0, 1);
    await assert.rejects(h.api.getRepairModels('first'), /profile|connection/i);
});

test('custom URL and custom-header changes invalidate cached model lists', async () => {
    const h = fixture({ profiles: [{ id: 'saved', api: 'custom', model: 'manual', 'api-url': 'https://first.invalid/v1', preset: 'headers' }],
        presets: { headers: { custom_include_headers: 'X-Account: first' } } });
    await h.api.refreshRepairModels('saved');
    h.profiles[0]['api-url'] = 'https://second.invalid/v1';
    assert.deepEqual(await h.api.getRepairModels('saved'), ['manual']);
    await h.api.refreshRepairModels('saved');
    h.presets.headers.custom_include_headers = 'X-Account: second';
    assert.deepEqual(await h.api.getRepairModels('saved'), ['manual']);
});

test('expanded custom-header changes invalidate current and saved model caches without editing templates', async () => {
    for (const connectionId of ['current', 'saved']) {
        const h = fixture({
            settings: { custom_include_headers: 'X-Account: {{account}}' },
            profiles: [{ id: 'saved', api: 'custom', model: 'saved-model', preset: 'headers' }],
            presets: { headers: { custom_include_headers: 'X-Account: {{account}}' } },
        });
        const configuredModel = connectionId === 'current' ? 'current-model' : 'saved-model';
        const before = structuredClone({ current: h.current, presets: h.presets });
        let account = 'first';
        h.host.script.substituteParams = value => value.replace('{{account}}', account);
        h.state.status = { data: [{ id: 'first-account-model' }] };
        assert.deepEqual(await h.api.refreshRepairModels(connectionId), ['first-account-model']);
        assert.equal(h.queried[0].payload.custom_include_headers, 'X-Account: first');
        assert.deepEqual(await h.api.getRepairModels(connectionId), [configuredModel, 'first-account-model']);
        account = 'second';
        assert.deepEqual(await h.api.getRepairModels(connectionId), [configuredModel]);
        h.state.status = { data: [{ id: 'second-account-model' }] };
        await h.api.refreshRepairModels(connectionId);
        assert.equal(h.queried[1].payload.custom_include_headers, 'X-Account: second');
        assert.deepEqual(await h.api.getRepairModels(connectionId), [configuredModel, 'second-account-model']);
        assert.deepEqual({ current: h.current, presets: h.presets }, before);
    }
});

test('model refresh shares its header expansion with the cache key and rejects late macro changes', async () => {
    const h = fixture({
        profiles: [{ id: 'saved', api: 'custom', model: 'manual', preset: 'headers' }],
        presets: { headers: { custom_include_headers: 'X-Account: {{account}}' } },
    });
    let account = 'first';
    h.host.script.substituteParams = value => {
        const expanded = value.replace('{{account}}', account);
        account = 'second';
        return expanded;
    };
    h.state.status = { data: [{ id: 'old-account-model' }] };
    await assert.rejects(h.api.refreshRepairModels('saved'), /changed|stale/i);
    assert.equal(h.queried[0].payload.custom_include_headers, 'X-Account: first');
    assert.deepEqual(await h.api.getRepairModels('saved'), ['manual']);
});

test('provider chat metadata filters non-chat models without reinserting a rejected configured model', async () => {
    const cases = [
        ['mistralai', [{ id: 'chat', capabilities: { completion_chat: true } }, { id: 'rejected', capabilities: { completion_chat: false } }]],
        ['aimlapi', [{ id: 'chat', type: 'chat-completion' }, { id: 'rejected', type: 'image' }]],
        ['electronhub', [{ id: 'chat', endpoints: ['/v1/chat/completions'] }, { id: 'rejected', endpoints: ['/v1/images/generations'] }]],
        ['cohere', [{ name: 'chat', endpoints: ['chat'] }, { name: 'rejected', endpoints: ['embed'] }]],
        ['custom', [{ id: 'chat' }, { id: 'rejected', kind: 'EMBEDDING_MODEL' }]],
    ];
    for (const [source, models] of cases) {
        const h = fixture({ settings: { chat_completion_source: source, [`${source}_model`]: 'rejected' },
            models: [...models, { id: 'embedding-v3' }, { id: 'reranker' }, { id: 'chat' }, null] });
        assert.deepEqual(await h.api.getRepairModels(), ['chat'], source);
    }
});

test('manual models work when a provider has no model-list endpoint', async () => {
    const h = fixture({ profiles: [{ id: 'manual', api: 'claude', model: 'manual-model' }] });
    assert.deepEqual(await h.api.getRepairModels('manual'), ['manual-model']);
    await assert.rejects(h.api.refreshRepairModels('manual'), /manual|model name/i);
    assert.equal(h.queried.length, 0);
    assert.equal(await h.api.requestContextRepair([], { connectionId: 'manual', model: 'manually-entered' }), 'complete');
    assert.equal(h.sent[0].payload.model, 'manually-entered');
});

test('a model-list response for an edited connection is rejected without populating its cache', async () => {
    const h = fixture({ profiles: [{ id: 'saved', api: 'custom', model: 'manual', 'api-url': 'https://before.invalid' }] });
    h.state.fetch = async () => {
        h.profiles[0]['api-url'] = 'https://after.invalid';
        return { ok: true, json: async () => ({ data: [{ id: 'old-route-model' }] }) };
    };
    await assert.rejects(h.api.refreshRepairModels('saved'), /changed|stale/i);
    assert.deepEqual(await h.api.getRepairModels('saved'), ['manual']);
});

test('unavailable current connections and invalid request options never send a repair request', async () => {
    const unavailable = fixture({ mainApi: 'textgenerationwebui', profiles: [{ id: 'saved', api: 'custom', model: 'manual' }] });
    assert.equal((await unavailable.api.getRepairConnections())[0].available, false);
    await assert.rejects(unavailable.api.requestContextRepair([]), /chat completion/i);
    await assert.rejects(unavailable.api.refreshRepairModels(), /chat completion/i);
    assert.equal(unavailable.sent.length + unavailable.queried.length, 0);
    await unavailable.api.requestContextRepair([], { connectionId: 'saved' });
    const h = fixture();
    for (const maxTokens of [0, -1, 1.5, NaN, Infinity]) {
        await assert.rejects(h.api.requestContextRepair([], { maxTokens }), /token|budget/i);
    }
    for (const temperature of [NaN, Infinity, -1]) {
        await assert.rejects(h.api.requestContextRepair([], { temperature }), /temperature/i);
    }
    assert.equal(h.sent.length, 0);
});

test('truncated and empty outputs are rejected before callers can apply them', async () => {
    const h = fixture();
    for (const response of [
        { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] },
        { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] },
        { candidates: [{ finishReason: 'MAX_TOKENS' }], choices: [{ message: { content: 'partial' } }] },
    ]) {
        h.state.response = response;
        await assert.rejects(h.api.requestContextRepair([]), /limit|truncated|budget/i);
    }
    h.state.response = { choices: [{ message: { content: '  ' } }] };
    await assert.rejects(h.api.requestContextRepair([]), /empty|no.*text/i);
});

test('cancellation is forwarded and exposes neither custom abort reasons nor late results', async () => {
    const h = fixture();
    const controller = new AbortController();
    controller.abort(new Error('synthetic-sensitive-reason'));
    const isSafeAbort = error => error.name === 'AbortError' && !String(error).includes('synthetic-sensitive');
    await assert.rejects(h.api.requestContextRepair([], {}, controller.signal), isSafeAbort);
    await assert.rejects(h.api.refreshRepairModels('current', controller.signal), isSafeAbort);
    assert.equal(h.sent.length + h.queried.length, 0);
    const duringConversion = new AbortController();
    h.state.convert = () => {
        duringConversion.abort('synthetic-sensitive-reason');
        return { generate_data: { stream: false } };
    };
    await assert.rejects(h.api.requestContextRepair([], {}, duringConversion.signal), isSafeAbort);
    assert.equal(h.sent.length, 0);
    const duringFetch = new AbortController();
    h.state.fetch = async () => {
        duringFetch.abort('synthetic-sensitive-reason');
        return { ok: true, json: async () => ({ data: [{ id: 'cancelled-model' }] }) };
    };
    await assert.rejects(h.api.refreshRepairModels('current', duringFetch.signal), isSafeAbort);
    assert.equal(h.queried[0].request.signal, duringFetch.signal);
    assert.deepEqual(await h.api.getRepairModels(), ['current-model']);
});

test('host, transport and backend errors never expose upstream details or nested causes', async () => {
    const isSanitized = error => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(String(error) + error.stack + JSON.stringify(error), /synthetic-private/);
        assert.equal(error.cause, undefined);
        return true;
    };
    const failedHost = createRepairApi({ loadHost: async () => { throw new Error('synthetic-private-host'); } });
    await assert.rejects(failedHost.getRepairConnections(), isSanitized);
    const h = fixture();
    await assert.rejects(h.api.requestContextRepair([], { connectionId: 'synthetic-private-id' }), isSanitized);
    h.state.send = () => { throw new Error('synthetic-private-key at https://user:pass@proxy.invalid?key=synthetic-private'); };
    await assert.rejects(h.api.requestContextRepair([]), isSanitized);
    h.state.fetch = () => { throw new Error('synthetic-private-network'); };
    await assert.rejects(h.api.refreshRepairModels(), isSanitized);
    h.state.fetch = async () => ({ ok: false, json: async () => ({ error: { message: 'synthetic-private-backend' } }) });
    await assert.rejects(h.api.refreshRepairModels(), isSanitized);
    h.state.fetch = async () => ({ ok: true, json: async () => { throw new Error('synthetic-private-json'); } });
    await assert.rejects(h.api.refreshRepairModels(), isSanitized);
    h.state.convert = () => { throw new Error('synthetic-private-conversion'); };
    await assert.rejects(h.api.requestContextRepair([]), isSanitized);
});

test('transport rejection with a custom abort reason remains a sanitized AbortError', async () => {
    const h = fixture();
    const fetching = new AbortController();
    h.state.fetch = async () => {
        fetching.abort(new Error('synthetic-sensitive-reason'));
        throw fetching.signal.reason;
    };
    const isSafeAbort = error => error.name === 'AbortError' && !String(error).includes('synthetic-sensitive');
    await assert.rejects(h.api.refreshRepairModels('current', fetching.signal), isSafeAbort);
    const generating = new AbortController();
    h.state.send = async () => {
        generating.abort(new Error('synthetic-sensitive-reason'));
        throw generating.signal.reason;
    };
    await assert.rejects(h.api.requestContextRepair([], {}, generating.signal), isSafeAbort);
});

test('missing or invalid selected proxy presets fail before any network request', async () => {
    const h = fixture({ profiles: [{ id: 'saved', api: 'openai', model: 'o3', proxy: 'selected' }] });
    await assert.rejects(h.api.requestContextRepair([], { connectionId: 'saved' }), /proxy/i);
    h.host.openai.proxies.push({ name: 'selected', url: 'file:///synthetic-private', password: 'synthetic-password' });
    await assert.rejects(h.api.requestContextRepair([], { connectionId: 'saved' }), /proxy/i);
    await assert.rejects(h.api.refreshRepairModels('saved'), /proxy/i);
    assert.equal(h.sent.length + h.queried.length, 0);
});
