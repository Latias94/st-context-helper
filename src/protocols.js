import { inspectTags } from './tags.js';

const supported = [
    { tag: 'maintext', kind: 'body' }, { tag: 'content', kind: 'body' }, { tag: 'game', kind: 'body' },
    { tag: 'UpdateVariable', kind: 'update' }, { tag: 'JSONPatch', kind: 'update' },
    { tag: 'Status_block', kind: 'status' }, { tag: 'StatusPlaceHolderImpl', kind: 'placeholder' },
];
const outputFormat = /输出|回复|正文|格式|状态栏|output|format|response/i;
const mandatory = /必须|务必|每次|每轮|始终|包裹|务须|always|must|required|wrap/i;
const artifacts = ['character_design_complex', 'character_design_simple', 'rule_setting_complex',
    'rule_setting_simple', 'world_view'];

/**
 * Only a small allowlist of output protocols is actionable. Worldbook XML and
 * writer templates are evidence, not automatically new parser delimiters.
 */
export function deriveCardProtocol({ name = '', source = 'character', fields = {}, entries = [], loadError = '' } = {}) {
    const result = { name, source, bodyTags: [], statusTags: [], requiredTags: [], requirements: [], evidence: [], warnings: [] };
    const writer = /萧谴.*写卡助手|character.card.writer/i.test(name);
    const sources = [
        ...Object.entries(fields).filter(([, text]) => typeof text === 'string' && text)
            .map(([field, text]) => ({ source: `${name || 'character'} / ${field}`, text, first: field === 'first_mes',
                format: field !== 'first_mes' && outputFormat.test(text), conditional: false })),
        ...entries.filter(entry => (entry.enabled !== false && !entry.disable)
            || (writer && /格式增强Plus/.test(entry.comment || entry.name || ''))).map(entry => ({
            source: `${source} / ${entry.comment || entry.name || entry.uid || entry.id || 'entry'}`,
            text: entry.content ?? '', format: outputFormat.test(entry.comment || entry.name || '')
                || (writer && /开场白|创作|角色生成|世界观|生成/.test(entry.comment || entry.name || '')),
            conditional: !entry.constant,
            disabled: entry.enabled === false || Boolean(entry.disable),
        })),
    ];
    for (const entry of sources) {
        if ((!entry.first && !entry.format) || typeof entry.text !== 'string') continue;
        const candidates = writer ? [...supported, ...artifacts.map(tag => ({ tag, kind: 'generated-artifact' }))] : supported;
        for (const { tag, kind } of candidates) {
            const match = new RegExp(`<${tag}(?:\\s|/?>)`, 'i').exec(entry.text);
            if (!match) continue;
            const excerpt = entry.text.slice(Math.max(0, match.index - 180), match.index + 500);
            const before = entry.text.slice(Math.max(0, match.index - 140), match.index);
            const clause = before.split(/[。\n.;；]/).at(-1) + entry.text.slice(match.index, match.index + tag.length + 45);
            const negative = /(?:never|do not|must not|不要|不得|禁止|无需|不必)[^。\n.;；]{0,100}$/i.test(before);
            const optional = kind === 'status' && /(?:如果|若|没有|无需|可选|if|optional)[\s\S]{0,100}(?:状态栏|Status_block|status)|(?:Status_block|状态栏)[\s\S]{0,100}(?:移除|省略|remove|optional)/i.test(excerpt);
            const required = !writer && !entry.first && entry.format && mandatory.test(clause) && !negative && !optional;
            const confidence = writer ? 'template' : entry.first ? 'observed' : entry.conditional ? 'conditional' : 'declared';
            const evidenceKind = writer && ['body', 'status'].includes(kind) ? `generated-${kind}` : kind;
            if (result.evidence.length < 24) result.evidence.push({
                tag, kind: evidenceKind, source: entry.source, excerpt, confidence, disabled: Boolean(entry.disabled),
            });
            if (writer) {
                if (kind === 'status') result.statusTags.push(tag);
                if (!entry.disabled && mandatory.test(excerpt)) result.requirements.push({
                    tag, kind: evidenceKind, source: entry.source, conditional: true,
                });
                continue;
            }
            if (kind === 'body') result.bodyTags.push(tag);
            if (kind === 'status') result.statusTags.push(tag);
            if (required && kind !== 'placeholder') {
                result.requirements.push({ tag, kind, source: entry.source, conditional: entry.conditional });
                if (!entry.conditional) result.requiredTags.push(tag);
            }
        }
        if (writer && /<version>[\s\S]*<version>/i.test(entry.text) && !/<\/version>/i.test(entry.text)) {
            result.warnings.push({ code: 'source-template-unclosed-tag', severity: 'warning',
                title: 'Card template contains an unmatched version tag',
                detail: 'The greeting template repeats <version> instead of closing it. This is source evidence; it does not delimit current story text.',
                source: entry.source });
        }
        if (writer && /<world_view>/i.test(entry.text) && /rule_setting_complex/i.test(entry.text)) {
            result.warnings.push({ code: 'source-template-conflict', severity: 'warning',
                title: 'World-building template and instructions name different tags',
                detail: 'The template uses world_view while its prose references rule_setting_complex. Inspect the generated artifact before choosing a repair.',
                source: entry.source });
        }
    }
    for (const key of ['bodyTags', 'statusTags', 'requiredTags']) result[key] = [...new Set(result[key])];
    if (loadError) result.warnings.push({ code: 'worldbook-unavailable', severity: 'warning',
        title: 'Linked worldbook could not be read',
        detail: `${source}: ${loadError}. Embedded card evidence is a fallback and may be stale.`, source });
    if (writer) result.warnings.push({ code: 'writer-template-protocol', severity: 'info',
        title: 'Card-writing templates are not current reply delimiters',
        detail: 'maintext / Status_block describe generated cards. Open the generated card to diagnose its actual output contract.' });
    if (result.requirements.some(entry => entry.conditional)) result.warnings.push({
        code: 'conditional-card-protocol', severity: 'info', title: 'Some output rules are conditionally activated',
        detail: 'Enabled worldbook entries are candidates, not proof of inclusion in a request. Missing conditional tags are not reported as mandatory failures.',
    });
    return result;
}

export function withCardProtocol(profile, cardProtocol) {
    if (!cardProtocol) return profile;
    return { ...profile, bodyTags: [...new Set([...cardProtocol.bodyTags, ...profile.bodyTags])],
        statusTags: [...new Set([...(profile.statusTags ?? []), ...cardProtocol.statusTags])] };
}

export function missingProtocolIssues(text, inspected, protocol) {
    if (!protocol) return [];
    const present = new Set(inspected.blocks.map(block => block.lower));
    // JSONPatch is nested inside an opaque UpdateVariable block.
    const hasPatch = inspected.blocks.some(block => block.lower === 'updatevariable'
        && inspectTags(text.slice(block.bodyStart, block.bodyEnd),
            { reasoningTags: [], bodyTags: [], updateTags: ['JSONPatch'] }).blocks
            .some(inner => inner.lower === 'jsonpatch' && inner.closed));
    return protocol.requiredTags.filter(tag => !present.has(tag.toLowerCase())
        && !(tag === 'JSONPatch' && hasPatch)).map(tag => ({
        code: 'missing-required-protocol', severity: 'warning', title: 'Expected card output block is missing',
        detail: `${tag}: required by ${protocol.requirements.find(entry => entry.tag === tag && !entry.conditional)?.source}. `
            + 'Local repair cannot invent missing story or variable values; compare established events in AI preview or regenerate the missing block.',
        source: protocol.source,
    }));
}
