import { analyzeSnapshot, traceRegexMessage } from './analysis.js';
import { resolveAdapter } from './adapters.js';
import { normalizeMessage } from './tags.js';
import { applyPlan, canUndoRepair, takeSnapshot, undoRepair, verifyRepairState } from './persistence.js';
import { deriveCardProtocol } from './protocols.js';
import { prepareMemoryReload } from './memory.js';
import { describeRegexRules, prepareRegexToggle } from './regex.js';
import { monitorSettings, MONITOR_RECENT_MESSAGES } from './monitor.js';
import { calculateTokenBudget, countEncodedMessages, estimateContextUsage } from './tokens.js';

const key = context => JSON.stringify([context.chatId, context.characterId, context.groupId]);
// A group's active speaker is cleared after generation; the conversation stays the same.
const promptKey = context => JSON.stringify(context.groupId != null
    ? ['group', context.groupId, context.chatId] : ['character', context.characterId, context.chatId]);
let nativePromise;
export function loadNative() {
    nativePromise ??= Promise.all([
        import('/script.js'), import('/scripts/openai.js'), import('/scripts/preset-manager.js'),
        import('/scripts/extensions/regex/engine.js'), import('/scripts/popup.js'), import('/scripts/tokenizers.js'),
    ]).then(([script, openai, presets, regex, popup, tokenizers]) => ({ script, openai, presets, regex, popup, tokenizers }));
    return nativePromise;
}

export function getContext() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) throw new Error('SillyTavern extension context is unavailable.');
    return context;
}

async function readCardProtocol(context) {
    const card = context.characters?.[context.characterId];
    const data = card?.data ?? card ?? {};
    const worldName = data.extensions?.world ?? card?.world;
    let entries = data.character_book?.entries ?? [], loadError = '';
    if (worldName) {
        try {
            const world = await context.loadWorldInfo(worldName);
            if (!world?.entries) throw new Error('No worldbook entries were returned');
            entries = Object.values(world.entries);
        } catch {
            loadError = 'Native worldbook loading failed';
        }
    }
    return deriveCardProtocol({
        name: card?.name ?? data.name ?? '', source: worldName || 'embedded character book',
        fields: Object.fromEntries(['first_mes', 'description', 'scenario', 'personality', 'system_prompt', 'post_history_instructions']
            .map(field => [field, data[field] ?? card?.[field] ?? ''])),
        entries, loadError,
    });
}

function regexGroups(native, context) {
    const types = native.regex.SCRIPT_TYPES;
    const presetApi = native.regex.getCurrentPresetAPI?.();
    const presetName = native.regex.getCurrentPresetName?.();
    const card = context.characters?.[context.characterId];
    return [
        { source: 'global', scriptType: types.GLOBAL, allowed: true,
            scripts: native.regex.getScriptsByType(types.GLOBAL) },
        { source: 'preset', scriptType: types.PRESET,
            allowed: native.regex.isPresetScriptsAllowed?.(presetApi, presetName) ?? true,
            scripts: native.regex.getScriptsByType(types.PRESET) },
        { source: 'character', scriptType: types.SCOPED,
            allowed: native.regex.isScopedScriptsAllowed?.(card) ?? true,
            scripts: native.regex.getScriptsByType(types.SCOPED) },
    ];
}

const regexOwner = (native, context) => JSON.stringify([key(context), context.characters?.[context.characterId]?.avatar,
    native.regex.getCurrentPresetAPI?.(), native.regex.getCurrentPresetName?.()]);

async function readStoredRegex(native, context, rule) {
    const character = rule.source === 'character';
    const response = await fetch(character ? '/api/characters/get' : '/api/settings/get', {
        method: 'POST', headers: context.getRequestHeaders(), cache: 'no-store',
        body: JSON.stringify(character ? { avatar_url: context.characters[context.characterId]?.avatar } : {}),
    });
    if (!response.ok) throw new Error('正则开关已在本页更新，但无法从服务器确认保存；请检查连接后重新分析。');
    const data = await response.json();
    if (character) return data.data?.extensions?.regex_scripts ?? [];
    const settings = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
    if (rule.source === 'global') return settings?.extension_settings?.regex ?? [];
    const api = native.regex.getCurrentPresetAPI?.();
    const fields = { openai: ['openai_setting_names', 'openai_settings'],
        textgenerationwebui: ['textgenerationwebui_preset_names', 'textgenerationwebui_presets'],
        novel: ['novelai_setting_names', 'novelai_settings'], kobold: ['koboldai_setting_names', 'koboldai_settings'] }[api];
    if (!fields) throw new Error('当前预设类型不支持保存读回校验，请在酒馆正则编辑器核对。');
    const index = data[fields[0]]?.indexOf(native.regex.getCurrentPresetName?.());
    const preset = index >= 0 ? data[fields[1]][index] : null;
    return (typeof preset === 'string' ? JSON.parse(preset) : preset)?.extensions?.regex_scripts ?? [];
}

export function assertIdle(native, context = getContext()) {
    if (native.script.isGenerating() || native.script.isChatSaving || context.streamingProcessor
        || document.querySelector('#chat .edit_textarea, #chat .reasoning_edit_textarea')) {
        throw new Error('请先完成当前生成、保存或消息编辑，再应用修复。');
    }
}

function safeCapture(messages, stage, model) {
    if (!Array.isArray(messages)) return null;
    return { stage, capturedAt: new Date().toISOString(), model,
        messages: messages.map(message => {
            const safe = {};
            for (const [field, value] of Object.entries(message)) {
                if (['role', 'name', 'content', 'tool_calls', 'tool_call_id'].includes(field) && value !== undefined) {
                    safe[field] = structuredClone(value);
                }
            }
            return safe;
        }) };
}

export async function createHost(dependencies = {}) {
    const native = dependencies.native ?? await loadNative();
    let capture = null, captureKey = '', processingIncoming = false, cardProtocol = null;
    let tokenCount = null, tokenAbort = null;
    const context = getContext();
    const subscribers = new Set();
    const notify = () => { for (const callback of subscribers) callback(); };
    const watch = (eventName, callback, first = false) => {
        if (!eventName) return;
        const method = first && context.eventSource.makeFirst ? 'makeFirst' : context.eventSource.makeLast ? 'makeLast' : 'on';
        context.eventSource[method](eventName, callback);
    };
    function storeCapture(next, data) {
        tokenAbort?.abort();
        tokenCount = null;
        const settings = native.openai.oai_settings;
        let tokenizerModel;
        try { tokenizerModel = native.tokenizers.getTokenizerModel(); } catch { /* Counting must not interrupt generation. */ }
        if (tokenizerModel === 'gpt-3.5-turbo' && !String(next.model ?? '').includes('gpt-3.5-turbo')) {
            tokenizerModel = undefined;
        }
        capture = {
            ...next, kind: 'captured', scope: 'full',
            contextLimit: Number(settings.openai_max_context),
            reservedOutputTokens: Number(data?.max_completion_tokens ?? data?.max_tokens ?? settings.openai_max_tokens),
            tokenizerModel,
            source: settings.chat_completion_source,
            unsupportedExtras: Boolean(data?.json_schema || data?.response_format?.type && data.response_format.type !== 'text'
                || [data?.tools, data?.functions].some(value => value != null && (!Array.isArray(value) || value.length))
                || (data?.messages ?? []).some(message => Object.keys(message)
                    .some(field => !['role', 'name', 'content'].includes(field)))),
        };
        captureKey = promptKey(getContext());
        notify();
    }
    watch(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, data => {
        if (data?.dryRun) return;
        const next = safeCapture(data?.chat, 'CHAT_COMPLETION_PROMPT_READY', native.openai.getChatCompletionModel?.());
        if (next) storeCapture(next, data);
    });
    watch(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, data => {
        if (data?.dryRun) return;
        const next = safeCapture(data?.messages, 'CHAT_COMPLETION_SETTINGS_READY', data?.model);
        if (next) storeCapture(next, data);
    });
    watch(context.eventTypes.CHAT_CHANGED, () => {
        if (captureKey !== promptKey(getContext())) {
            capture = null;
            tokenAbort?.abort();
            tokenCount = null;
        }
        cardProtocol = null;
    });
    for (const name of ['APP_READY', 'CHAT_CHANGED', 'CHAT_LOADED', 'GENERATION_STARTED',
        'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED',
        'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED',
        'MESSAGE_REASONING_EDITED', 'MESSAGE_REASONING_DELETED', 'CHARACTER_EDITED',
        'SETTINGS_UPDATED', 'OAI_PRESET_CHANGED_AFTER', 'CHATCOMPLETION_MODEL_CHANGED',
        'CHATCOMPLETION_SOURCE_CHANGED', 'CONNECTION_PROFILE_LOADED', 'MAIN_API_CHANGED',
        'WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED']) {
        watch(context.eventTypes[name], notify);
    }
    watch(context.eventTypes.MESSAGE_RECEIVED, async id => {
        const current = getContext(), row = current.chat[Number(id)];
        if (processingIncoming || !current.chatMetadata.context_helper?.normalizeIncoming || !row || row.is_user) return;
        const currentKey = key(current);
        cardProtocol ??= await readCardProtocol(current);
        if (key(getContext()) !== currentKey) return;
        const manager = native.presets.getPresetManager('openai');
        const preset = native.openai.oai_settings;
        const profile = resolveAdapter({ presetName: manager?.getSelectedPresetName?.() ?? '', cardProtocol,
            preset, adapter: current.chatMetadata.context_helper?.adapter ?? 'auto' });
        const result = normalizeMessage(row.mes, profile);
        if (!result.changed) return;
        processingIncoming = true;
        try {
            // Only delimiters are changed, before MVU's MESSAGE_RECEIVED handler parses the update.
            const swipe = row.swipe_id ?? 0;
            row.extra ??= {};
            row.extra.context_helper_original = row.mes;
            row.mes = result.text;
            if (row.swipes) row.swipes[swipe] = result.text;
        } finally { processingIncoming = false; }
    }, true);

    async function snapshot(options = {}) {
        const current = getContext();
        const owner = regexOwner(native, current);
        const manager = native.presets.getPresetManager('openai');
        const settings = native.openai.oai_settings;
        const protocol = await readCardProtocol(current);
        if (regexOwner(native, getContext()) !== owner) throw new Error('聊天、角色或预设在分析期间改变，请重新分析。');
        cardProtocol = protocol;
        return takeSnapshot(current, options, {
            presetName: manager?.getSelectedPresetName?.() ?? '',
            cardProtocol: protocol,
            preset: { prompts: structuredClone(settings.prompts ?? []),
                prompt_order: structuredClone(settings.prompt_order ?? []) },
            settings: { openai_max_context: settings.openai_max_context, openai_max_tokens: settings.openai_max_tokens,
                contextHelperAdapter: current.extensionSettings.context_helper?.adapter ?? 'auto' },
        });
    }

    async function inspect(options) {
        const source = await snapshot(options);
        const regexDisabled = getContext().extensionSettings.disabledExtensions?.includes('regex');
        const groups = regexGroups(native, getContext());
        const regexReport = describeRegexRules(groups, !regexDisabled);
        for (const rule of regexReport.rules) rule.owner = regexOwner(native, getContext());
        source.regex = regexReport;
        const scripts = regexDisabled ? [] : groups.filter(group => group.allowed).flatMap(group =>
            group.scripts.filter(rule => !rule.disabled).map(rule => ({ ...rule,
                contextHelperSource: group.source,
                contextHelperKey: `${group.source}:${group.scripts.indexOf(rule)}:${rule.id ?? ''}` })));
        const analysis = analyzeSnapshot(source, {
            adapter: options.adapter, promptCapture: captureKey === promptKey(getContext()) ? capture : null,
            canUseTools: (await import('/scripts/tool-calling.js')).ToolManager.isToolCallingSupported(),
            traceMessage: (text, placement, depth, evidence) =>
                traceRegexMessage(text, placement, depth, scripts, native.regex.runRegexScript, evidence),
        });
        if (!capture) {
            const prompts = await import('/scripts/itemized-prompts.js');
            const record = [...(prompts.itemizedPrompts ?? [])].reverse().find(record => record.rawPrompt);
            if (record && typeof record.rawPrompt === 'string') {
                analysis.prompt.savedRawPrompt = record.rawPrompt;
                analysis.prompt.note += ' 下方还可查看酒馆已保存的原始提示词；它的确切事件阶段未知。';
            }
        }
        analysis.sources = {
            presetName: source.presetName,
            character: getContext().characters?.[getContext().characterId]?.name,
            linkedWorld: getContext().characters?.[getContext().characterId]?.data?.extensions?.world,
            injectedPrompts: Object.entries(getContext().extensionPrompts ?? {}).map(([name, entry]) => ({
                name, position: entry.position, depth: entry.depth, role: entry.role,
                text: entry.value ?? entry.prompt ?? '',
            })),
        };
        analysis.monitorSettings = monitorSettings(getContext().extensionSettings.context_helper);
        analysis.tokens = await tokenUsage();
        return { snapshot: source, analysis };
    }

    async function tokenUsage() {
        const current = getContext(), captured = capture;
        const unknown = reason => ({ status: 'unavailable', source: 'unavailable', reason });
        if (current.mainApi !== 'openai' || captureKey !== promptKey(current)
            || !captured || captured.stage !== 'CHAT_COMPLETION_SETTINGS_READY' || captured.unsupportedExtras) {
            return unknown('unsupported-capture');
        }
        const thresholdPercent = monitorSettings(current.extensionSettings.context_helper).tokenWarningPercent;
        const cached = tokenCount;
        if (!cached || cached.capture !== captured) {
            tokenAbort = new AbortController();
            const signal = AbortSignal.any([tokenAbort.signal, AbortSignal.timeout(15000)]);
            const entry = { capture: captured };
            entry.promise = estimateContextUsage({
                capture: captured, contextLimit: captured.contextLimit,
                reservedOutputTokens: captured.reservedOutputTokens, thresholdPercent,
            }, { countMessages: messages => countEncodedMessages(messages, {
                tokenizerModel: captured.tokenizerModel,
                async encode(text) {
                    const response = await fetch(`/api/tokenizers/openai/encode?model=${encodeURIComponent(captured.tokenizerModel)}`, {
                        method: 'POST', headers: current.getRequestHeaders(), body: JSON.stringify({ text }), signal,
                    });
                    if (!response.ok) throw new Error('Local token encoding failed.');
                    return response.json();
                },
            }) });
            tokenCount = entry;
        }
        const entry = tokenCount, result = await entry.promise;
        if (result.status !== 'available' && tokenCount === entry) tokenCount = null;
        if (capture !== captured || captureKey !== promptKey(getContext())) return unknown('unsupported-capture');
        if (result.status !== 'available') return result;
        const budget = calculateTokenBudget({ inputTokens: result.inputTokens,
            contextLimit: captured.contextLimit, reservedOutputTokens: captured.reservedOutputTokens,
            thresholdPercent: monitorSettings(getContext().extensionSettings.context_helper).tokenWarningPercent });
        const settings = native.openai.oai_settings;
        const changed = getContext().mainApi !== 'openai' || settings.chat_completion_source !== captured.source
            || native.openai.getChatCompletionModel?.() !== captured.model
            || Number(settings.openai_max_context) !== captured.contextLimit;
        return { ...result, ...budget, capturedAt: captured.capturedAt, stage: captured.stage,
            ...(changed ? { reason: 'configuration-changed' } : {}) };
    }

    async function inspectMonitor() {
        const current = getContext();
        if (!current.chatId || !current.chat?.length) return { active: false };
        const owner = regexOwner(native, current);
        const busy = native.script.isGenerating() || native.script.isChatSaving || current.streamingProcessor
            || document.querySelector('#chat .edit_textarea, #chat .reasoning_edit_textarea');
        if (busy) return { active: true, diagnosisPending: true, tokens: await tokenUsage() };
        const { analysis } = await inspect({
            start: Math.max(0, current.chat.length - MONITOR_RECENT_MESSAGES), end: current.chat.length - 1,
            adapter: current.chatMetadata.context_helper?.adapter ?? current.extensionSettings.context_helper?.adapter ?? 'auto',
        });
        if (owner !== regexOwner(native, getContext())) throw new Error('Conversation changed.');
        return { active: true, analysis };
    }

    async function savePreferences(preferences) {
        const current = getContext();
        current.extensionSettings.context_helper = { ...current.extensionSettings.context_helper, ...preferences };
        notify();
        await native.script.saveSettings();
        const response = await fetch('/api/settings/get', {
            method: 'POST', headers: current.getRequestHeaders(), cache: 'no-store', body: '{}',
        });
        if (!response.ok) throw new Error('本页设置已更新，但服务器保存未确认；请检查连接后重新打开设置。');
        const data = await response.json();
        const stored = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
        const saved = stored?.extension_settings?.context_helper ?? {};
        for (const [name, value] of Object.entries(preferences)) {
            if (saved[name] !== value) throw new Error('本页设置已更新，但服务器读回不一致；请检查连接后重新保存。');
        }
    }

    function storage(context, assertWritable) {
        const chatKey = key(context);
        return {
            assertWritable,
            async save() {
                if (key(getContext()) !== chatKey) throw new Error('Conversation changed before saving.');
                await context.saveChat();
            },
            async read() {
                const group = context.groupId;
                const response = await fetch(group ? '/api/chats/group/get' : '/api/chats/get', {
                    method: 'POST', headers: context.getRequestHeaders(), cache: 'no-store',
                    body: JSON.stringify(group ? { id: context.chatId }
                        : { avatar_url: context.characters[context.characterId].avatar, file_name: context.chatId }),
                });
                if (!response.ok) throw new Error('Unable to verify the saved conversation.');
                return response.json();
            },
        };
    }

    function assertRepairConfiguration(source, owner) {
        if (regexOwner(native, getContext()) !== owner) throw new Error('聊天、角色或预设已改变，请重新生成修复预览。');
        assertIdle(native);
        const settings = native.openai.oai_settings;
        const preset = { prompts: settings.prompts ?? [], prompt_order: settings.prompt_order ?? [] };
        if (native.presets.getPresetManager('openai')?.getSelectedPresetName?.() !== source.presetName
            || JSON.stringify(preset) !== JSON.stringify(source.preset)) {
            throw new Error('预设配置已改变，请重新分析并生成修复预览。');
        }
        if (source.regex) {
            const regex = describeRegexRules(regexGroups(native, getContext()),
                !getContext().extensionSettings.disabledExtensions?.includes('regex'));
            const signature = value => JSON.stringify([value.enabled, value.rules.map(rule => [rule.key, rule.signature, rule.allowed])]);
            if (signature(regex) !== signature(source.regex)) throw new Error('正则配置已改变，请重新分析后生成修复预览。');
        }
    }

    function assertSavedChatIdle(owner) {
        if (regexOwner(native, getContext()) !== owner) {
            throw new Error('修复已保存到原聊天，但当前聊天、角色或预设已切换；已停止后续刷新，请重新打开原聊天核对。');
        }
        try { assertIdle(native); }
        catch { throw new Error('修复已保存，但当前开始了生成、保存或消息编辑；已停止聊天重载，请完成操作后重新分析。'); }
    }
    return {
        native, inspect, snapshot, inspectMonitor,
        subscribe(callback) {
            subscribers.add(callback);
            return () => subscribers.delete(callback);
        },
        getMonitorSettings: () => monitorSettings(getContext().extensionSettings.context_helper),
        async saveMonitorOptions(options) {
            await savePreferences(monitorSettings(options));
        },
        async apply(source, plan) {
            const current = getContext();
            const owner = regexOwner(native, current);
            assertIdle(native, current);
            const fresh = await snapshot({ start: source.start, end: source.end });
            if (fresh.presetName !== source.presetName || JSON.stringify(fresh.preset) !== JSON.stringify(source.preset)
                || JSON.stringify(fresh.cardProtocol) !== JSON.stringify(source.cardProtocol)) {
                throw new Error('预设或角色卡输出协议已改变，请重新分析并生成修复预览。');
            }
            const backup = await applyPlan(current, source, plan, storage(current, () => assertRepairConfiguration(source, owner)));
            assertSavedChatIdle(owner);
            await prepareMemoryReload(current, plan.tables.map(table => table.uid));
            assertSavedChatIdle(owner);
            await current.reloadCurrentChat();
            assertSavedChatIdle(owner);
            await verifyRepairState(getContext(), backup, storage(getContext()));
        },
        async undo() {
            const current = getContext();
            const owner = regexOwner(native, current);
            assertIdle(native, current);
            const backup = await undoRepair(current, storage(current, () => {
                if (regexOwner(native, getContext()) !== owner) throw new Error('聊天或配置已切换，撤销未写入。');
                assertIdle(native);
            }));
            assertSavedChatIdle(owner);
            await prepareMemoryReload(current, backup.tables.map(table => table.uid));
            assertSavedChatIdle(owner);
            await current.reloadCurrentChat();
            assertSavedChatIdle(owner);
            await verifyRepairState(getContext(), backup, storage(getContext()));
        },
        async toggleRegex(rule, enabled) {
            const current = getContext();
            assertIdle(native, current);
            const owner = regexOwner(native, current);
            if (rule.owner !== owner) throw new Error('聊天、角色或预设已切换，请重新分析后再调整正则。');
            const unchanged = () => {
                if (regexOwner(native, getContext()) !== owner) throw new Error('聊天、角色或预设已切换，请重新分析并核对保存结果。');
            };
            const groups = regexGroups(native, current);
            const change = prepareRegexToggle(groups, rule, enabled);
            await native.regex.saveScriptsByType(change.scripts, change.scriptType);
            unchanged();
            if (change.source === 'global') {
                await native.script.saveSettings();
                unchanged();
            }
            const after = regexGroups(native, getContext()).find(group => group.source === change.source);
            const saved = after?.scripts[rule.index];
            if (!saved || saved.id !== rule.id || Boolean(!saved.disabled) !== Boolean(enabled)) {
                throw new Error('正则开关保存结果无法确认，请重新分析。');
            }
            const stored = await readStoredRegex(native, getContext(), rule);
            unchanged();
            if (!stored[rule.index] || stored[rule.index].id !== rule.id || Boolean(!stored[rule.index].disabled) !== enabled) {
                throw new Error('正则开关在本页已更新，但服务器保存未通过校验；请检查连接并重新分析。');
            }
            notify();
            return { source: change.source, id: rule.id, enabled: !saved.disabled };
        },
        async saveOptions(options) {
            const current = getContext();
            const chatKey = key(current);
            const next = { adapter: options.adapter, normalizeIncoming: Boolean(options.normalizeIncoming) };
            const before = current.chatMetadata.context_helper;
            const beforeState = JSON.stringify(before);
            const chatChanged = current.chatId && current.chatMetadata
                && (next.adapter !== (before?.adapter ?? current.extensionSettings.context_helper?.adapter ?? 'auto')
                    || next.normalizeIncoming !== Boolean(before?.normalizeIncoming));
            if (chatChanged) assertIdle(native, current);
            await savePreferences({
                connectionId: options.connectionId, model: options.model, maxTokens: options.maxTokens,
                prompt: options.prompt, adapter: options.adapter,
                ...monitorSettings(options),
            });
            if (chatChanged) {
                if (key(getContext()) !== chatKey) throw new Error('聊天已切换，请重新核对当前聊天的自动处理设置。');
                if (JSON.stringify(current.chatMetadata.context_helper) !== beforeState) {
                    throw new Error('聊天的自动处理设置在保存期间改变，请重新分析后再设置。');
                }
                assertIdle(native, current);
                current.chatMetadata.context_helper = next;
                await current.saveChat();
                if (key(getContext()) !== chatKey) throw new Error('聊天已切换，请重新核对当前聊天的自动处理设置。');
                const saved = await storage(current).read();
                if (key(getContext()) !== chatKey) throw new Error('聊天已切换，请重新分析。');
                if (JSON.stringify(saved[0]?.chat_metadata?.context_helper) !== JSON.stringify(next)) {
                    throw new Error('本页自动处理设置已更新，但服务器保存未确认；请检查连接并重新分析。');
                }
            }
            notify();
        },
        hasBackup: () => canUndoRepair(getContext()),
    };
}
