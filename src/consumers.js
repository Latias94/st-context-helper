import { inspectTags } from './tags.js';

const statusPatterns = new Set([
    String.raw`.*?<Status_block>([\s\S]*?)</Status_block>`,
    String.raw`<Status_block>([\s\S]*?)</Status_block>`,
    String.raw`<maintext>[\s\S]*?</Status_block>`,
]);

// Recognize observed contracts only. Never execute a frontend script or infer the
// semantics of an arbitrary regex/JavaScript program.
export function describeConsumerRules(regex) {
    if (!regex || regex.enabled === false) return [];
    return (regex.rules ?? []).filter(rule => rule.allowed === true && !rule.disabled && rule.enabled !== false
        && rule.markdownOnly && rule.placement?.some(value => [2, 3].includes(value)) && Number(rule.substituteRegex ?? 0) === 0)
        .filter(rule => /status_block/i.test(rule.findRegex ?? '')).map(rule => {
            const literal = /^\/([\s\S]*)\/([a-z]*)$/.exec(rule.findRegex);
            const pattern = (literal?.[1] ?? rule.findRegex).replaceAll('\\/', '/');
            const flags = literal?.[2] ?? '';
            if (new Set(flags).size !== flags.length) return null;
            const known = statusPatterns.has(pattern) && /^[gimsu]*$/.test(flags);
            let trigger = null;
            try { if (known) trigger = new RegExp(pattern, flags.replaceAll('g', '')); }
            catch { return null; }
            return { rule, known, trigger, insensitive: flags.includes('i'),
                needsMaintext: pattern.startsWith('<maintext>'),
                rawReader: rule.replaceString?.includes('getChatMessages(')
                    && rule.replaceString.includes('actualMessageData.message')
                    && rule.replaceString.includes(String.raw`message.match(/<Status_block>\s*([\s\S]*?)\s*<\/Status_block>/i)`) };
        }).filter(Boolean);
}

const activeAtDepth = ({ rule }, depth) => !(rule.minDepth != null && rule.minDepth >= -1 && depth < rule.minDepth)
    && !(rule.maxDepth != null && rule.maxDepth >= 0 && depth > rule.maxDepth);
const lineAt = (text, at) => text.slice(0, at).split('\n').length;

export function inspectConsumerBoundaries(text, profile, inspected, { contracts = [], depth = 0, placement = 2 } = {}) {
    const issues = [];
    const active = contracts.filter(contract => activeAtDepth(contract, depth) && contract.rule.placement.includes(placement));
    const known = active.filter(contract => contract.known);
    // An active known renderer is evidence for this delimiter even if the card's
    // worldbook could not be read. It does not make the tag mandatory.
    const needsStatus = known.length && !profile.statusTags?.some(tag => tag.toLowerCase() === 'status_block');
    const needsBody = known.some(contract => contract.needsMaintext) && !profile.bodyTags.some(tag => tag.toLowerCase() === 'maintext');
    const structure = needsStatus || needsBody ? inspectTags(text, { ...profile,
        bodyTags: needsBody ? [...profile.bodyTags, 'maintext'] : profile.bodyTags,
        statusTags: needsStatus ? [...profile.statusTags ?? [], 'Status_block'] : profile.statusTags }) : inspected;
    const statuses = structure.blocks.filter(block => block.kind === 'data' && block.lower === 'status_block' && block.closed);
    if (statuses.length > 1) issues.push({ code: 'duplicate-protocol-block', severity: 'warning', action: 'none',
        title: 'Multiple real status blocks need review', tag: 'Status_block', count: statuses.length,
        lines: statuses.map(block => lineAt(text, block.start)), detail: 'A first-block reader may ignore later status data. No block was selected, merged, or removed.' });

    for (const block of structure.blocks.filter(block => block.lower === 'tableedit' && block.closed)) {
        const premature = text.indexOf('</tableEdit>', block.bodyStart);
        if (premature >= 0 && premature < block.bodyEnd) issues.push({ code: 'consumer-delimiter-collision', severity: 'warning', action: 'none',
            title: 'A raw table reader can terminate inside a literal value', tag: 'tableEdit', line: lineAt(text, premature),
            detail: 'The known tableEdit regex stops before the structurally verified terminator. The payload was retained.' });
    }

    const first = /<Status_block>\s*([\s\S]*?)\s*<\/Status_block>/i.exec(text);
    const rawReader = known.find(contract => contract.rawReader && contract.trigger.test(text));
    if (first && rawReader
        && !statuses.some(block => block.start === first.index && block.end === first.index + first[0].length)) {
        const inReasoning = structure.blocks.some(block => block.kind === 'reasoning'
            && first.index >= block.bodyStart && first.index < block.bodyEnd);
        const alreadyReported = inspected.issues.some(issue => issue.code === 'unescaped-protocol-example'
            && issue.tags?.some(tag => tag.toLowerCase() === 'status_block'));
        const supplemental = inReasoning && !alreadyReported && structure.issues.find(issue => issue.code === 'unescaped-protocol-example'
            && issue.tags?.some(tag => tag.toLowerCase() === 'status_block'));
        if (supplemental) {
            const root = inspected.blocks.find(block => block.kind === 'reasoning' && first.index >= block.bodyStart && first.index < block.bodyEnd);
            issues.push({ ...supplemental, action: profile.id === 'generic' ? 'settings' : root?.closed || root?.recoverable ? 'local' : 'ai' });
        } else if (!inReasoning || !alreadyReported) {
            issues.push({ code: 'raw-reader-collision', severity: 'warning', action: 'regex',
                title: 'A known frontend can read a literal example instead of status data', tag: 'Status_block',
                line: lineAt(text, first.index), rule: rawReader.rule.name, ruleKey: rawReader.rule.key,
                detail: 'The known direct raw-message selector disagrees with the structural status boundary. Story, code and native comments were retained.' });
        }
    }

    if (statuses.length && known.length && !active.some(contract => !contract.known)) {
        const block = statuses[0];
        const compatible = known.some(contract => {
            const normalize = value => contract.insensitive ? value.toLowerCase() : value;
            return normalize(text.slice(block.start, block.bodyStart)) === normalize('<Status_block>')
                && normalize(text.slice(block.bodyEnd, block.end)) === normalize('</Status_block>')
                && (!contract.needsMaintext || structure.blocks.some(body => body.lower === 'maintext' && body.closed && body.start < block.start
                    && normalize(text.slice(body.start, body.bodyStart)) === normalize('<maintext>')));
        });
        if (!compatible) issues.push({ code: 'render-boundary-mismatch', severity: 'warning', action: 'regex',
            title: 'Known display rules require different boundary syntax', tag: block.tag,
            line: lineAt(text, block.start), rule: known[0].rule.name, ruleKey: known[0].rule.key,
            detail: 'The structure is readable, but its case, whitespace, or body wrapper does not satisfy the enabled known display contracts.' });
    }

    if (profile.reasoningLayout === 'single-leading') {
        const roots = inspected.blocks.filter(block => block.kind === 'reasoning' && !block.nested);
        if (roots.length > 1) {
            const mergeable = roots.every(block => block.closed || block.recoverable)
                && !inspected.issues.some(issue => issue.code === 'orphan-close')
                && roots.slice(1).every((block, i) => /^\s*$/.test(text.slice(roots[i].end, block.start)));
            issues.push({ code: 'repeated-reasoning', severity: 'warning', action: mergeable ? 'local' : 'none',
                title: 'This preset prefers one leading reasoning block', count: roots.length, mergeable,
                lines: roots.map(block => lineAt(text, block.start)), localized: true,
                detail: mergeable ? `检测到 ${roots.length} 段相邻思考，本地预览可合并为一段并保留文字顺序。`
                    : `检测到 ${roots.length} 段思考，段间存在正文、数据或未确认边界。当前适配偏好一段前置思考；原位置与内容均保留。`,
                recommendation: mergeable ? '生成本地预览，核对合并后的思考和正文后再应用。'
                    : '核对预设和插件各自产生的思考阶段，调整输出模板或手动整理。不会跨过正文、状态栏或表格合并。' });
        } else if (roots.length && inspected.blocks.some(block => block.kind === 'body' && block.end <= roots[0].start)) {
            issues.push({ code: 'misplaced-reasoning', severity: 'warning', action: 'none',
                title: 'Reasoning appears after established narrative', line: lineAt(text, roots[0].start),
                detail: 'This preset prefers leading reasoning. No story or data was moved to change its position.' });
        }
    }
    return issues;
}
