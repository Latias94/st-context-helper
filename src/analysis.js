import { enabledPrompts, resolveAdapter } from './adapters.js';
import { activeData } from './repair.js';
import { extractNarrative, extractPatches, inspectTags } from './tags.js';
import { missingProtocolIssues } from './protocols.js';

export function traceRegexMessage(text, placement, depth, scripts, runRegex) {
    const trace = [];
    for (const script of scripts) {
        if (script.disabled || !script.promptOnly || !script.placement?.includes(placement)) continue;
        if (script.minDepth != null && script.minDepth >= -1 && depth < script.minDepth) continue;
        if (script.maxDepth != null && script.maxDepth >= 0 && depth > script.maxDepth) continue;
        const before = text;
        text = runRegex(script, text);
        if (text !== before) trace.push({ name: script.scriptName, source: script.contextHelperSource ?? 'unknown',
            before: before.length, after: text.length, removed: before.length - text.length,
            depth, minDepth: script.minDepth, maxDepth: script.maxDepth });
    }
    return { text, trace };
}

export function analyzeSnapshot(snapshot, { traceMessage, promptCapture, adapter = 'auto', canUseTools = false } = {}) {
    const profile = resolveAdapter({ ...snapshot, adapter });
    const issues = [...snapshot.cardProtocol?.warnings ?? []], messages = [];
    const included = row => !row.is_system || (canUseTools && Array.isArray(row.extra?.tool_invocations));
    const history = snapshot.chat.map((row, id) => ({ row, id })).filter(({ row }) => included(row));
    const depths = new Map(history.map(({ id }, index) => [id, history.length - index - 1]));
    let rawCharacters = 0, promptCharacters = 0;
    for (let id = snapshot.start; id <= snapshot.end; id++) {
        const row = snapshot.chat[id], raw = row.mes ?? '';
        const result = !included(row) ? { text: '', trace: [] } : traceMessage?.(raw, row.is_user ? 1 : 2, depths.get(id))
            ?? { text: raw, trace: [] };
        const inspected = inspectTags(raw, profile);
        const rowIssues = inspected.issues.map(issue => ({ ...issue, messageId: id }));
        if (!row.is_user && !row.is_system && id > 0) rowIssues.push(
            ...missingProtocolIssues(raw, inspected, snapshot.cardProtocol).map(issue => ({ ...issue, messageId: id })));
        const narrative = row.is_user ? '' : extractNarrative(raw, profile);
        if (!row.is_system && narrative.length >= 30 && !result.text.includes(narrative.slice(0, Math.min(120, narrative.length)))) {
            rowIssues.push({ code: 'narrative-loss', severity: 'error', messageId: id,
                title: 'Narrative is missing after prompt regex processing',
                detail: `Story text is absent after ${result.trace.map(step => step.name).join(' → ') || 'processing'}.` });
        }
        try {
            const patches = row.is_user ? [] : extractPatches(raw, profile);
            const prior = activeData(snapshot.chat[id - 1]), current = activeData(row);
            if (patches.length && current.stat_data && prior.stat_data
                && JSON.stringify(current.stat_data) === JSON.stringify(prior.stat_data)) {
                rowIssues.push({ code: 'stalled-mvu', severity: 'warning', messageId: id,
                    title: 'MVU snapshot did not change despite update commands',
                    detail: `${patches.length} operations found. Compare the preview before recovering state.` });
            }
        } catch (error) {
            rowIssues.push({ code: 'invalid-patch', severity: 'warning', messageId: id,
                title: 'Variable update cannot be parsed', detail: error.message });
        }
        if (!row.is_system && raw && !result.text.trim()) rowIssues.push({ code: 'history-erased', severity: 'info', messageId: id,
            title: 'This floor is empty after regex processing', detail: 'Check depth limits in the rule trace.' });
        issues.push(...rowIssues);
        rawCharacters += raw.length;
        promptCharacters += result.text.length;
        messages.push({ id, role: row.is_user ? 'user' : row.is_system ? 'system' : 'assistant',
            name: row.name ?? '', swipeId: row.swipe_id ?? 0, raw, projected: result.text,
            rawChars: raw.length, promptChars: result.text.length, trace: result.trace,
            blocks: inspected.blocks, issues: rowIssues });
    }
    for (const table of snapshot.tables ?? []) {
        if (table.warning) issues.push({ code: 'incomplete-table', severity: 'warning',
            title: 'Table references or cells are missing', detail: `${table.name}: ${table.warning}` });
        const duplicates = table.rows.length - new Set(table.rows.map(row => JSON.stringify(row))).size;
        if (duplicates) issues.push({ code: 'duplicate-table-rows', severity: 'warning', title: 'Repeated table memory',
            detail: `${table.name}: ${duplicates} exact duplicate rows.` });
    }
    if (profile.id === 'generic') issues.push({ code: 'unknown-preset', severity: 'info',
        title: 'No specialized adapter matched', detail: 'Inspection is available; automatic delimiter repair is disabled.' });
    const prompt = promptCapture ? { ...structuredClone(promptCapture), kind: 'captured',
        note: 'Captured at a native prompt event. Later extensions or backend/provider conversion may still change it.' }
        : { kind: 'simulated', messages: messages.filter(message => message.projected.trim())
            .map(message => ({ role: message.role, content: message.projected, origin: `history #${message.id}` })),
        note: 'Regex history simulation only; this is not the complete request. World-info activation, macros, '
            + 'token-budget trimming, plugin injection and backend conversion are not reproduced.' };
    prompt.totalCharacters = prompt.messages.reduce((sum, message) =>
        sum + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length), 0);
    prompt.pipeline = [
        { name: 'Preset', detail: `${enabledPrompts(snapshot.preset).length} enabled prompt entries` },
        { name: 'Character / world info', detail: 'Native activation and template evaluation' },
        { name: 'History', detail: `${snapshot.chat.length} saved floors; selected ${snapshot.start}–${snapshot.end}` },
        { name: 'Regex', detail: 'Actual native engine when available; depth shown per floor' },
        { name: 'Extensions', detail: 'Memory tables, MVU, advice and other injection hooks' },
        { name: 'Request event', detail: prompt.kind === 'captured' ? prompt.stage : 'No captured request yet' },
        { name: 'Backend / provider', detail: 'Role merging, tools, cache metadata and provider conversion' },
    ];
    return { profile, cardProtocol: snapshot.cardProtocol,
        scope: { start: snapshot.start, end: snapshot.end, total: snapshot.chat.length },
        stats: { rawCharacters, promptCharacters, removedCharacters: rawCharacters - promptCharacters,
            hiddenMessages: snapshot.chat.filter(row => row.is_system).length,
            contextLimit: snapshot.settings?.openai_max_context, maxOutputTokens: snapshot.settings?.openai_max_tokens },
        issues, messages, prompt, tables: snapshot.tables ?? [] };
}
