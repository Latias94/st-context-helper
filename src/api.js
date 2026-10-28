// Adapted from st-memory-enhancement/services/optimizationApi.js and SillyTavern's
// ConnectionManagerRequestService / ChatCompletionService preset adapter.
const proxySources = new Set([
    'claude', 'openai', 'mistralai', 'makersuite', 'vertexai',
    'deepseek', 'xai', 'zai', 'moonshot',
]);
const apiUrlFields = {
    custom: 'custom_url', vertexai: 'vertexai_region', zai: 'zai_endpoint',
    siliconflow: 'siliconflow_endpoint', minimax: 'minimax_endpoint', pollinations: 'pollinations_endpoint',
};
const endpointDefaults = { zai: 'common', siliconflow: 'global', minimax: 'global', pollinations: 'authenticated' };
const statusFields = {
    custom: ['custom_url', 'custom_include_headers'],
    azure_openai: ['azure_base_url', 'azure_deployment_name', 'azure_api_version'],
    workers_ai: ['workers_ai_account_id'],
    siliconflow: ['siliconflow_endpoint'],
    pollinations: ['pollinations_endpoint'],
};
const manualModelSources = new Set(['claude', 'ai21', 'vertexai', 'perplexity', 'zai', 'minimax', 'cometapi']);

let hostModules;
async function loadHostModules() {
    hostModules ??= Promise.all([
        import('/scripts/openai.js'),
        import('/scripts/custom-request.js'),
        import('/scripts/extensions/shared.js'),
        import('/script.js'),
        import('/scripts/preset-manager.js'),
    ]).then(([openai, requests, shared, script, presets]) => ({ openai, requests, shared, script, presets }));
    return hostModules;
}

class RepairError extends Error {}

function cancelled() {
    const error = new Error('Context repair was cancelled.');
    error.name = 'AbortError';
    return error;
}

function checkAbort(signal) {
    if (signal?.aborted) throw cancelled();
}

async function protect(operation, message, signal) {
    try {
        return await operation();
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw cancelled();
        if (error instanceof RepairError) throw error;
        // Host errors can contain provider responses, credentials or URLs; do not retain a cause.
        throw new Error(message);
    }
}

function modelId(model, source) {
    return typeof model === 'string' ? model : source === 'cohere' ? model?.name || model?.id : model?.id;
}

function isChatModel(model, source) {
    const id = modelId(model, source);
    if (typeof id !== 'string' || !id.trim()) return false;
    if (/(^|[/_.-])(embed(?:ding)?s?|rerank(?:er)?)([/_.-]|$)/i.test(id)) return false;
    if (model?.kind === 'EMBEDDING_MODEL') return false;
    if (source === 'mistralai') return model?.capabilities?.completion_chat === true;
    if (source === 'aimlapi') return model?.type === 'chat-completion';
    if (source === 'electronhub') return model?.endpoints?.includes('/v1/chat/completions') === true;
    if (source === 'cohere' && Array.isArray(model?.endpoints)) return model.endpoints.includes('chat');
    if (source === 'chutes') return !id.toLowerCase().includes('affine');
    return true;
}

function displayEndpoint({ source, settings, proxy }) {
    const value = proxy?.url || (source === 'custom' ? settings.custom_url
        : source === 'azure_openai' ? settings.azure_base_url : '');
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url.host : '';
    } catch {
        // Default provider endpoints are owned by the server; never display raw configuration.
        return '';
    }
}

function validateProxy(connection) {
    if (!connection.proxy) return null;
    try {
        const url = new URL(connection.proxy.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
        throw new RepairError('The selected proxy requires a valid HTTP or HTTPS URL.');
    }
    return connection.proxy;
}

function applyRouting(payload, connection, proxy) {
    if (connection.id !== 'current' && connection.secretId !== undefined) payload.secret_id = connection.secretId;
    if (proxy) {
        payload.reverse_proxy = proxy.url;
        payload.proxy_password = proxy.password;
    }
}

function requireAvailable(connection) {
    if (!connection.available) {
        throw new RepairError('The current API is not a chat completion connection. Select a saved chat completion connection.');
    }
}

function prepareModelStatus(connection) {
    const { source, settings, host } = connection;
    const payload = { chat_completion_source: source };
    for (const field of statusFields[source] || []) {
        payload[field] = field === 'custom_include_headers'
            ? host.script.substituteParams(settings[field] || '') : settings[field];
    }
    applyRouting(payload, connection, connection.proxy);
    // Use the exact expanded request for the key; routing data stays only in memory.
    return { payload, cacheKey: JSON.stringify([connection.model, connection.available, payload]) };
}

/**
 * The default exports use this same factory; injected dependencies let Node tests
 * exercise the browser boundary without loading SillyTavern or making real requests.
 */
export function createRepairApi({
    loadHost = loadHostModules,
    context = () => globalThis.SillyTavern.getContext(),
    fetch = (...args) => globalThis.fetch(...args),
} = {}) {
    const modelCache = new Map();

    async function resolveConnection(connectionId = 'current') {
        const host = await loadHost();
        const { openai, shared, presets, script } = host;
        const settings = structuredClone(openai.oai_settings);
        let profile;
        if (connectionId !== 'current') {
            if (context().extensionSettings?.disabledExtensions?.includes('connection-manager')) {
                throw new RepairError('Connection Manager is disabled. Use the current chat completion connection.');
            }
            profile = shared.ConnectionManagerRequestService.getProfile(connectionId);
            const mapping = shared.ConnectionManagerRequestService.validateProfile(profile);
            if (mapping.selected !== 'openai' || !mapping.source) {
                throw new RepairError('Select a saved chat completion connection.');
            }
            if (profile.preset) {
                const preset = presets.getPresetManager('openai')?.getCompletionPresetByName(profile.preset);
                if (!preset || typeof preset !== 'object') {
                    throw new RepairError('The selected connection preset no longer exists. Select another preset.');
                }
                const copy = structuredClone(preset);
                copy.bias_preset_selected = copy.bias_presets !== undefined ? copy.bias_preset_selected : undefined;
                for (const [key, value] of Object.entries(copy)) {
                    const field = openai.settingsToUpdate[key]?.[1];
                    if (field) settings[field] = value;
                }
            }
            settings.chat_completion_source = mapping.source;
            const urlField = apiUrlFields[mapping.source];
            if (urlField && profile['api-url']) settings[urlField] = profile['api-url'];
            if (profile['prompt-post-processing'] !== undefined) {
                settings.custom_prompt_post_processing = profile['prompt-post-processing'];
            }
            // A saved profile only uses a proxy when that profile explicitly selects one.
            settings.reverse_proxy = '';
            settings.proxy_password = '';
            if (profile.proxy && proxySources.has(mapping.source)) {
                const proxy = openai.proxies.find(row => row.name === profile.proxy);
                if (!proxy) throw new RepairError('The selected proxy preset no longer exists. Select another proxy.');
                settings.reverse_proxy = proxy.url || '';
                settings.proxy_password = proxy.password || '';
            }
        }
        const source = settings.chat_completion_source;
        if (endpointDefaults[source]) settings[apiUrlFields[source]] ||= endpointDefaults[source];
        const model = profile?.model || openai.getChatCompletionModel(settings) || '';
        const proxy = proxySources.has(source) && settings.reverse_proxy
            ? { url: settings.reverse_proxy, password: settings.proxy_password || '' } : null;
        return {
            id: connectionId, name: profile ? profile.name || 'Unnamed connection' : 'Current connection',
            source, settings, model, proxy, secretId: profile?.['secret-id'], host,
            available: connectionId !== 'current' || script.main_api === 'openai',
        };
    }

    async function getRepairConnections() {
        const connections = [await resolveConnection()];
        const extensionSettings = context().extensionSettings;
        if (!extensionSettings?.disabledExtensions?.includes('connection-manager')) {
            for (const profile of extensionSettings?.connectionManager?.profiles ?? []) {
                try {
                    connections.push(await resolveConnection(profile.id));
                } catch {
                    // Unsupported APIs and profiles with deleted presets cannot be used for repairs.
                }
            }
        }
        return connections.map(connection => ({
            id: connection.id, name: connection.name, source: connection.source, model: connection.model,
            endpoint: displayEndpoint(connection), available: connection.available,
        }));
    }

    async function getRepairModels(connectionId = 'current') {
        const connection = await resolveConnection(connectionId);
        const { cacheKey } = prepareModelStatus(connection);
        const cached = modelCache.get(connection.id);
        const rows = cached?.key === cacheKey ? cached.rows
            : connection.id === 'current' && connection.available ? connection.host.openai.model_list ?? [] : [];
        const models = rows.filter(model => isChatModel(model, connection.source))
            .map(model => modelId(model, connection.source));
        const knownModel = rows.some(model => modelId(model, connection.source) === connection.model);
        if (!knownModel && isChatModel(connection.model, 'manual')) models.unshift(connection.model);
        return [...new Set(models)];
    }

    async function refreshRepairModels(connectionId = 'current', signal) {
        checkAbort(signal);
        const connection = await resolveConnection(connectionId);
        requireAvailable(connection);
        if (manualModelSources.has(connection.source)) {
            throw new RepairError('This provider has no model-list endpoint. Enter the model name manually.');
        }
        validateProxy(connection);
        const { payload, cacheKey } = prepareModelStatus(connection);
        checkAbort(signal);
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST', headers: connection.host.script.getRequestHeaders(),
            body: JSON.stringify(payload), signal,
        });
        checkAbort(signal);
        if (!response.ok) throw new RepairError('Could not fetch models. Enter the model name manually.');
        const data = await response.json();
        checkAbort(signal);
        if (data?.error) throw new RepairError('Could not fetch models. Enter the model name manually.');
        const rows = connection.source === 'cohere' ? data?.models ?? data?.data : data?.data;
        const models = Array.isArray(rows) ? rows.filter(model => isChatModel(model, connection.source))
            .map(model => modelId(model, connection.source)) : [];
        if (!models.length) throw new RepairError('No chat models were returned. Enter the model name manually.');
        const latest = await resolveConnection(connectionId);
        checkAbort(signal);
        if (prepareModelStatus(latest).cacheKey !== cacheKey) {
            throw new RepairError('The connection changed while fetching models. Refresh the model list again.');
        }
        modelCache.set(connection.id, { key: cacheKey, rows: structuredClone(rows) });
        return [...new Set(models)];
    }

    async function requestContextRepair(messages, options = {}, signal) {
        checkAbort(signal);
        const connection = await resolveConnection(options.connectionId || 'current');
        requireAvailable(connection);
        const proxy = validateProxy(connection);
        const budget = Number(options.maxTokens ?? 8192);
        const temperature = Number(options.temperature ?? 0.2);
        if (!Number.isSafeInteger(budget) || budget <= 0) {
            throw new RepairError('The output token budget must be a positive integer.');
        }
        if (!Number.isFinite(temperature) || temperature < 0) {
            throw new RepairError('Temperature must be a finite, non-negative number.');
        }
        const model = options.model || connection.model;
        if (typeof model !== 'string' || !model.trim()) throw new RepairError('Select or enter a model name.');
        const { settings, host } = connection;
        settings.openai_max_tokens = budget;
        settings.temp_openai = temperature;
        settings.stream_openai = false;
        settings.n = 1;
        // Native bias calculation reads global settings and shares a tokenizer-dependent cache.
        settings.bias_preset_selected = undefined;
        // Native proxy validation reads globals and can change the main connection's status.
        settings.reverse_proxy = '';
        settings.proxy_password = '';
        checkAbort(signal);
        const { generate_data: payload } = await host.openai.createGenerationParameters(
            settings, model, 'quiet', structuredClone(messages),
        );
        checkAbort(signal);
        // Keep native provider/model filtering; chat stop strings can truncate a repair document.
        delete payload.stop;
        payload.stream = false;
        applyRouting(payload, connection, proxy);
        const response = await host.requests.ChatCompletionService.sendRequest(payload, false, signal);
        checkAbort(signal);
        const finishReason = response?.choices?.[0]?.finish_reason
            ?? response?.stop_reason ?? response?.candidates?.[0]?.finishReason;
        if (['length', 'max_tokens', 'MAX_TOKENS'].includes(finishReason)) {
            throw new RepairError('The model reached its output limit. Increase the token budget before applying a repair.');
        }
        const text = host.script.extractMessageFromData(response, 'openai');
        if (typeof text !== 'string' || !text.trim()) throw new RepairError('The model returned no repair text.');
        return text;
    }

    return {
        getRepairConnections: () => protect(getRepairConnections, 'Could not load repair connections.'),
        getRepairModels: connectionId => protect(
            () => getRepairModels(connectionId), 'Could not load models for the selected connection.',
        ),
        refreshRepairModels: (connectionId, signal) => protect(
            () => refreshRepairModels(connectionId, signal), 'Could not fetch models. Enter the model name manually.', signal,
        ),
        requestContextRepair: (messages, options, signal) => protect(
            () => requestContextRepair(messages, options, signal),
            'Context repair request failed. Check the selected connection and model.', signal,
        ),
    };
}

export const {
    getRepairConnections, getRepairModels, refreshRepairModels, requestContextRepair,
} = createRepairApi();
