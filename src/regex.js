const sourceNames = { global: '全局', preset: '预设', character: '角色卡' };

export const regexSourceName = source => sourceNames[source] ?? '来源未确认';

export function regexDepthLabel(rule) {
    const lower = Number(rule.minDepth), upper = Number(rule.maxDepth);
    const min = rule.minDepth != null && Number.isFinite(lower) && lower >= 0 ? lower : 0;
    const max = rule.maxDepth != null && Number.isFinite(upper) && upper >= 0 ? upper : null;
    return max === null ? min ? `深度 ≥ ${min}` : '全部深度'
        : `深度 ${min}–${max}`;
}

export function describeRegexRules(groups, enabled = true) {
    return { enabled, rules: groups.flatMap(group => group.scripts.map((rule, index) => {
        const activeForPrompt = enabled && group.allowed && !rule.disabled && Boolean(rule.promptOnly)
            && rule.placement?.some(value => [1, 2].includes(value));
        const status = !enabled ? '正则扩展已关闭' : !group.allowed ? '此来源未获授权'
            : rule.disabled ? '规则已关闭' : !rule.promptOnly ? '不处理发送上下文'
                : !rule.placement?.some(value => [1, 2].includes(value)) ? '仅处理其他位置' : '参与发送处理';
        return { ...structuredClone(rule), key: `${group.source}:${index}:${rule.id ?? ''}`, index,
            name: rule.scriptName || '未命名规则', source: group.source, scriptType: group.scriptType,
            allowed: group.allowed, activeForPrompt, status, depthLabel: regexDepthLabel(rule),
            signature: JSON.stringify(rule) };
    })) };
}

export function isDepthTrimRule(rule) {
    if (rule.replaceString !== '' || rule.minDepth == null || !Number.isFinite(Number(rule.minDepth))
        || Number(rule.minDepth) < 1 || Number(rule.substituteRegex ?? 0) !== 0) return false;
    const regex = /^\/([\s\S]*)\/([a-z]*)$/i.exec(rule.findRegex ?? '');
    const pattern = regex?.[1] ?? rule.findRegex;
    const flags = regex?.[2] ?? '';
    return ['[\\s\\S]*', '[\\s\\S]+', '^[\\s\\S]*$', '^[\\s\\S]+$'].includes(pattern)
        || (pattern === '^([\\s\\S]*?)$' && !flags.includes('m'))
        || (flags.includes('s') && ['.*', '.+', '^.*$', '^.+$'].includes(pattern));
}

export function isDepthSummaryRule(rule) {
    if (rule.minDepth == null || !Number.isFinite(Number(rule.minDepth)) || rule.minDepth < 1
        || Number(rule.substituteRegex ?? 0) !== 0) return false;
    const regex = /^\/([\s\S]*)\/([a-z]*)$/i.exec(rule.findRegex ?? '');
    const pattern = regex?.[1] ?? rule.findRegex;
    return (pattern === '([\\s\\S]*?)(<progress>[\\s\\S]*?<\\/progress>)([\\s\\S]*?$)' && rule.replaceString === '$2')
        || (pattern === '^([\\s\\S]*?)<sumUp>([\\s\\S]*?)<\\/sumUp>([\\s\\S]*?)$'
            && rule.replaceString === '$2' && !regex?.[2].includes('m'))
        || (pattern === '[\\s\\S]*?(?<!<details>\\s*)<summary>([\\s\\S]*?)<\\/summary>[\\s\\S]*'
            && rule.replaceString?.replace(/\s+/g, '') === '<summary>$1</summary>');
}

export function isLiteralWordFilter(rule) {
    if (Number(rule.substituteRegex ?? 0) !== 0 || rule.trimStrings?.length
        || typeof rule.replaceString !== 'string' || /[$<>{}\r\n]/.test(rule.replaceString)) return false;
    const match = /^\/([\s\S]*)\/([a-z]*)$/i.exec(rule.findRegex ?? '');
    if (!match || /[^giu]/.test(match[2])) return false;
    const words = match[1].split('|');
    return words.length <= 10 && words.every(word => word.length > 0 && word.length <= 16 && /^[\p{L}\p{N} ]+$/u.test(word));
}

// This is a conservative lexical check, not a semantic judgment of the scene.
export function retainsNarrative(text, narrative) {
    if (Array.isArray(narrative)) return narrative.every(segment => retainsNarrative(text, segment));
    const compact = value => String(value ?? '').replace(/\s+/g, '');
    const story = compact(narrative), output = compact(text);
    if (!story) return true;
    if (output.includes(story)) return true;
    return false;
}

export function prepareRegexToggle(groups, requested, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('正则开关值无效。');
    const group = groups.find(group => group.source === requested.source && group.scriptType === requested.scriptType);
    if (!group) throw new Error('正则来源已改变，请重新分析。');
    const rule = group.scripts[requested.index];
    if (!rule || rule.id !== requested.id || JSON.stringify(rule) !== requested.signature) {
        throw new Error('正则已被其他操作修改，请重新分析后再切换。');
    }
    const scripts = structuredClone(group.scripts);
    scripts[requested.index].disabled = !enabled;
    return { scriptType: group.scriptType, scripts, source: group.source };
}
