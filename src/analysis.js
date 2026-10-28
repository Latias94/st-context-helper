import { enabledPrompts, resolveAdapter } from './adapters.js';
import { activeData } from './repair.js';
import { extractPatches, inspectTags, narrativeSegments } from './tags.js';
import { missingProtocolIssues } from './protocols.js';
import { isDepthSummaryRule, isDepthTrimRule, isLiteralWordFilter, retainsNarrative } from './regex.js';

export function traceRegexMessage(text, placement, depth, scripts, runRegex,
    { narrative = '', segments = [narrative], summaryTags = [], reasoningTags = [], bodyTags = [] } = {}) {
    const trace = [];
    let expectedNarrative = segments, retainedSummary = null;
    const length = values => values.reduce((sum, value) => sum + value.length, 0);
    for (const script of scripts) {
        if (script.disabled || !script.promptOnly || !script.placement?.includes(placement)) continue;
        if (script.minDepth != null && script.minDepth >= -1 && depth < script.minDepth) continue;
        if (script.maxDepth != null && script.maxDepth >= 0 && depth > script.maxDepth) continue;
        const before = text;
        text = runRegex(script, text);
        if (text === before) continue;
        const beforeNarrative = expectedNarrative;
        if (isLiteralWordFilter(script)) {
            const filtered = expectedNarrative.map(segment => runRegex(script, segment));
            // Small, explicit word substitutions are traceable formatting, not a missing scene.
            if (Math.abs(length(filtered) - length(expectedNarrative)) <= length(expectedNarrative) * .05
                && retainsNarrative(text, filtered)) expectedNarrative = filtered;
        }
        const narrativeLost = length(beforeNarrative) >= 30 && retainsNarrative(before, beforeNarrative)
            && !retainsNarrative(text, expectedNarrative);
        const summaryLost = retainedSummary && before.includes(retainedSummary.text) && !text.includes(retainedSummary.text);
        let summary;
        if (narrativeLost && isDepthSummaryRule(script)) {
            const summaries = inspectTags(before, { reasoningTags: [], bodyTags: summaryTags, updateTags: [] }).blocks;
            const excluded = inspectTags(before, { reasoningTags, bodyTags, updateTags: [] }).blocks;
            summary = summaries.find(block => block.closed
                && !excluded.some(region => region.start < block.start && region.end >= block.end)
                && before.slice(0, block.start).toLowerCase().lastIndexOf('<details')
                    <= before.slice(0, block.start).toLowerCase().lastIndexOf('</details')
                && before.slice(block.bodyStart, block.bodyEnd).trim()
                && text.includes(before.slice(block.bodyStart, block.bodyEnd)));
        }
        if (summary && narrativeLost) retainedSummary = { tag: summary.tag, text: before.slice(summary.bodyStart, summary.bodyEnd) };
        trace.push({ name: script.scriptName, source: script.contextHelperSource ?? 'unknown',
            before: before.length, after: text.length, removed: before.length - text.length,
            depth, minDepth: script.minDepth, maxDepth: script.maxDepth,
            ruleKey: script.contextHelperKey, narrativeLost, summaryLost: Boolean(summaryLost),
            policy: isDepthTrimRule(script) ? 'trim' : narrativeLost && summary ? 'summary' : null });
    }
    return { text, trace, expectedNarrative, summarySurvives: Boolean(retainedSummary && text.includes(retainedSummary.text)) };
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
        const segments = row.is_user ? [] : narrativeSegments(raw, { ...profile,
            updateTags: [...profile.updateTags, ...profile.summaryTags, ...profile.adviceTags,
                'tucao', 'options', 'current_event', 'disclaimer', 'guifan', 'danmu', 'htmlcontent'] });
        const narrative = segments.join('\n');
        const result = !included(row) ? { text: '', trace: [] } : traceMessage?.(raw, row.is_user ? 1 : 2, depths.get(id),
            { narrative, segments, summaryTags: profile.summaryTags, reasoningTags: profile.reasoningTags, bodyTags: profile.bodyTags })
            ?? { text: raw, trace: [] };
        const inspected = inspectTags(raw, profile);
        const rowIssues = inspected.issues.map(issue => ({ ...issue, messageId: id }));
        if (!row.is_user && !row.is_system && id > 0) rowIssues.push(
            ...missingProtocolIssues(raw, inspected, snapshot.cardProtocol).map(issue => ({ ...issue, messageId: id })));
        const lost = !row.is_system && narrative.length >= 30 && !retainsNarrative(result.text, result.expectedNarrative ?? segments);
        let responsible = result.trace.find(step => step.narrativeLost) ?? result.trace.at(-1);
        if (responsible?.policy === 'summary' && !result.summarySurvives) {
            responsible = result.trace.find(step => step.summaryLost) ?? result.trace.at(-1);
        }
        const erasing = result.trace.find(step => step.policy === 'trim' && step.after === 0);
        const policy = lost && responsible?.policy ? responsible
            : !result.text.trim() && erasing && (!responsible?.narrativeLost || responsible === erasing) ? erasing : null;
        if (policy) {
            rowIssues.push({ code: 'history-trim-policy', severity: 'info', messageId: id, localized: true,
                rule: policy.name, ruleKey: policy.ruleKey, category: 'policy', action: 'regex',
                detail: policy.policy === 'summary'
                    ? `消息深度 ${policy.depth} 达到规则下限 ${policy.minDepth}，该规则保留摘要并移除旧正文。`
                    : `消息深度 ${policy.depth} 达到规则下限 ${policy.minDepth}，发送内容被该规则清空。`,
                recommendation: '这是发送策略，标签修复不会改变它。要保留旧正文，请在设置中查看此规则，关闭或在酒馆正则编辑器调整深度后重新分析。' });
        } else if (lost) {
            rowIssues.push({ code: 'narrative-loss', severity: 'error', messageId: id, localized: true,
                rule: responsible?.name, ruleKey: responsible?.ruleKey, category: 'review', action: 'regex',
                detail: `正文未完整保留在发送模拟中。处理轨迹：${result.trace.map(step => step.name).join(' → ') || '未记录规则'}。`,
                recommendation: '先查看对应规则与消息原文。若非预期裁剪，请关闭或修正规则后重新分析；只有源消息标签也有问题时才需要会话修复。' });
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
        if (!row.is_system && raw && !result.text.trim() && !policy && !lost) rowIssues.push({
            code: 'history-erased', severity: 'warning', messageId: id, localized: true,
            rule: responsible?.name, ruleKey: responsible?.ruleKey, category: 'review', action: 'regex',
            detail: '发送处理后整条历史消息为空；没有足够证据将它判为按深度裁剪。',
            recommendation: '查看规则的生效范围和深度。若意外移除了近期用户指令，先关闭对应规则后重新分析。' });
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
        note: '这是原生提示词事件阶段的快照，后续扩展、后端及供应商转换仍可能改变请求。' }
        : { kind: 'simulated', messages: messages.filter(message => message.projected.trim())
            .map(message => ({ role: message.role, content: message.projected, origin: `history #${message.id}` })),
        note: '这里只模拟聊天历史的正则处理，不是完整请求；世界书激活、宏、token 预算裁剪、插件注入和后端转换未被完整复现。' };
    prompt.totalCharacters = prompt.messages.reduce((sum, message) =>
        sum + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length), 0);
    prompt.pipeline = [
        { name: '预设', detail: `${enabledPrompts(snapshot.preset).length} 项已启用提示词` },
        { name: '角色卡 / 世界书', detail: '由酒馆激活条目并求值模板' },
        { name: '聊天历史', detail: `共 ${snapshot.chat.length} 条消息；所选 ${snapshot.start}–${snapshot.end}` },
        { name: '正则', detail: '调用原生引擎，按消息位置和深度筛选' },
        { name: '扩展注入', detail: '表格记忆、MVU、建议和其他提示词注入' },
        { name: '请求事件', detail: prompt.kind === 'captured' ? prompt.stage : '尚未捕获请求' },
        { name: '后端 / 供应商', detail: '可能继续合并角色、转换工具及缓存元数据' },
    ];
    return { profile, cardProtocol: snapshot.cardProtocol,
        scope: { start: snapshot.start, end: snapshot.end, total: snapshot.chat.length },
        stats: { rawCharacters, promptCharacters, removedCharacters: rawCharacters - promptCharacters,
            hiddenMessages: snapshot.chat.filter(row => row.is_system).length,
            policyTrimmedMessages: messages.filter(message => message.issues.some(issue => issue.code === 'history-trim-policy')).length,
            contextLimit: snapshot.settings?.openai_max_context, maxOutputTokens: snapshot.settings?.openai_max_tokens },
        issues, messages, prompt, tables: snapshot.tables ?? [], regex: snapshot.regex ?? { enabled: true, rules: [] },
        automation: (() => {
            const enabled = Boolean(snapshot.metadata?.context_helper?.normalizeIncoming);
            const effective = enabled && profile.id !== 'generic';
            const lastId = snapshot.chat.findLastIndex(row => row.extra?.context_helper_original);
            return { enabled, effective, adapter: profile.id,
                configuredAdapter: snapshot.metadata?.context_helper?.adapter ?? snapshot.settings?.contextHelperAdapter ?? adapter,
                scope: 'chat', aiMode: 'manual', historyMode: 'preview',
                label: !enabled ? '新回复自动规范化已关闭' : effective ? '新回复自动规范化已开启' : '已开启但当前预设未匹配，实际不会自动修改',
                lastNormalization: lastId < 0 ? null : { id: lastId, at: snapshot.chat[lastId].send_date, status: '已规范化' } };
        })() };
}
