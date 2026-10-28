import { analyzeSnapshot, traceRegexMessage } from './analysis.js';
import { resolveAdapter } from './adapters.js';
import { normalizeMessage } from './tags.js';
import { applyPlan, canUndoRepair, takeSnapshot, undoRepair, verifyRepairState } from './persistence.js';
import { deriveCardProtocol } from './protocols.js';
import { prepareMemoryReload } from './memory.js';

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
        const chatKey = key(current);
        const manager = native.presets.getPresetManager('openai');
        const settings = native.openai.oai_settings;
        const protocol = await readCardProtocol(current);
        if (key(getContext()) !== chatKey) throw new Error('Conversation changed during inspection.');
        cardProtocol = protocol;
        return takeSnapshot(current, options, {
            presetName: manager?.getSelectedPresetName?.() ?? '',
            cardProtocol: protocol,
            preset: { prompts: structuredClone(settings.prompts ?? []),
                prompt_order: structuredClone(settings.prompt_order ?? []) },
            settings: { openai_max_context: settings.openai_max_context, openai_max_tokens: settings.openai_max_tokens },
        });
    }

    async function inspect(options) {
        const source = await snapshot(options);
        const regexDisabled = getContext().extensionSettings.disabledExtensions?.includes('regex');
        const scripts = regexDisabled ? [] : native.regex.getRegexScripts({ allowedOnly: true });
        const owned = [
            ...native.regex.getScriptsByType(native.regex.SCRIPT_TYPES.GLOBAL).map(rule => [rule, 'global']),
            ...native.regex.getScriptsByType(native.regex.SCRIPT_TYPES.PRESET, { allowedOnly: true }).map(rule => [rule, 'preset']),
            ...native.regex.getScriptsByType(native.regex.SCRIPT_TYPES.SCOPED, { allowedOnly: true }).map(rule => [rule, 'character']),
        ];
        const sources = new Map(owned.map(([rule, source]) => [rule.id, source]));
        const labeled = scripts.map(rule => ({ ...rule, contextHelperSource: sources.get(rule.id) ?? 'unknown' }));
        const analysis = analyzeSnapshot(source, {
            adapter: options.adapter, promptCapture: captureKey === key(getContext()) ? capture : null,
            canUseTools: (await import('/scripts/tool-calling.js')).ToolManager.isToolCallingSupported(),
            traceMessage: (text, placement, depth) =>
                traceRegexMessage(text, placement, depth, labeled, native.regex.runRegexScript),
        });
        if (!capture) {
            const prompts = await import('/scripts/itemized-prompts.js');
            const record = [...(prompts.itemizedPrompts ?? [])].reverse().find(record => record.rawPrompt);
            if (record && typeof record.rawPrompt === 'string') {
                analysis.prompt.savedRawPrompt = record.rawPrompt;
                analysis.prompt.note += ' Native saved raw-prompt text is also available below; its exact hook stage is unknown.';
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

    function storage(context) {
        const chatKey = key(context);
        return {
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
    return {
        native, inspect, snapshot,
        async apply(source, plan) {
            const current = getContext();
            assertIdle(native, current);
            const fresh = await snapshot({ start: source.start, end: source.end });
            if (fresh.presetName !== source.presetName || JSON.stringify(fresh.preset) !== JSON.stringify(source.preset)
                || JSON.stringify(fresh.cardProtocol) !== JSON.stringify(source.cardProtocol)) {
                throw new Error('预设或角色卡输出协议已改变，请重新分析并生成修复预览。');
            }
            const backup = await applyPlan(current, source, plan, storage(current));
            await prepareMemoryReload(current, plan.tables.map(table => table.uid));
            await current.reloadCurrentChat();
            await verifyRepairState(getContext(), backup, storage(getContext()));
        },
        async undo() {
            const current = getContext();
            assertIdle(native, current);
            const backup = await undoRepair(current, storage(current));
            await prepareMemoryReload(current, backup.tables.map(table => table.uid));
            await current.reloadCurrentChat();
            await verifyRepairState(getContext(), backup, storage(getContext()));
        },
        async saveOptions(options) {
            const current = getContext();
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
            }
        },
        hasBackup: () => canUndoRepair(getContext()),
    };
}
