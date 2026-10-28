import { analyzeSnapshot, traceRegexMessage } from './analysis.js';
import { resolveAdapter } from './adapters.js';
import { normalizeMessage } from './tags.js';
import { applyPlan, canUndoRepair, takeSnapshot, undoRepair, verifyRepairState } from './persistence.js';
import { deriveCardProtocol } from './protocols.js';
import { prepareMemoryReload } from './memory.js';
import { describeRegexRules, prepareRegexToggle } from './regex.js';

const key = context => JSON.stringify([context.chatId, context.characterId, context.groupId]);
let nativePromise;
export function loadNative() {
    nativePromise ??= Promise.all([
        import('/script.js'), import('/scripts/openai.js'), import('/scripts/preset-manager.js'),
        import('/scripts/extensions/regex/engine.js'), import('/scripts/popup.js'),
    ]).then(([script, openai, presets, regex, popup]) => ({ script, openai, presets, regex, popup }));
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
            for (const field of ['role', 'name', 'content', 'tool_calls', 'tool_call_id']) {
                if (message[field] !== undefined) safe[field] = structuredClone(message[field]);
            }
            return safe;
        }) };
}

export async function createHost() {
    const native = await loadNative();
    let capture = null, captureKey = '', processingIncoming = false, cardProtocol = null;
    const context = getContext();
    const watch = (eventName, callback, first = false) => {
        if (!eventName) return;
        const method = first && context.eventSource.makeFirst ? 'makeFirst' : context.eventSource.makeLast ? 'makeLast' : 'on';
        context.eventSource[method](eventName, callback);
    };
    watch(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, data => {
        if (data?.dryRun) return;
        const next = safeCapture(data?.chat, 'CHAT_COMPLETION_PROMPT_READY', native.openai.getChatCompletionModel?.());
        if (next) { capture = next; captureKey = key(getContext()); }
    });
    watch(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, data => {
        if (data?.dryRun) return;
        const next = safeCapture(data?.messages, 'CHAT_COMPLETION_SETTINGS_READY', data?.model);
        if (next) { capture = next; captureKey = key(getContext()); }
    });
    watch(context.eventTypes.CHAT_CHANGED, () => {
        if (captureKey !== key(getContext())) capture = null;
        cardProtocol = null;
    });
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
            adapter: options.adapter, promptCapture: captureKey === key(getContext()) ? capture : null,
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
        return { snapshot: source, analysis };
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
        native, inspect, snapshot,
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
            return { source: change.source, id: rule.id, enabled: !saved.disabled };
        },
        async saveOptions(options) {
            const current = getContext();
            const chatKey = key(current);
            const next = { adapter: options.adapter, normalizeIncoming: Boolean(options.normalizeIncoming) };
            const chatChanged = current.chatId && current.chatMetadata
                && JSON.stringify(next) !== JSON.stringify(current.chatMetadata.context_helper);
            if (chatChanged) assertIdle(native, current);
            current.extensionSettings.context_helper = {
                connectionId: options.connectionId, model: options.model, maxTokens: options.maxTokens,
                prompt: options.prompt, adapter: options.adapter,
            };
            current.saveSettingsDebounced();
            if (chatChanged) {
                current.chatMetadata.context_helper = next;
                await current.saveChat();
                if (key(getContext()) !== chatKey) throw new Error('聊天已切换，请重新核对当前聊天的自动处理设置。');
                const saved = await storage(current).read();
                if (key(getContext()) !== chatKey) throw new Error('聊天已切换，请重新分析。');
                if (JSON.stringify(saved[0]?.chat_metadata?.context_helper) !== JSON.stringify(next)) {
                    throw new Error('本页自动处理设置已更新，但服务器保存未确认；请检查连接并重新分析。');
                }
            }
        },
        hasBackup: () => canUndoRepair(getContext()),
    };
}
