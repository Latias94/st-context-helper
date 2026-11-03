import { inspectTags } from './tags.js';

export function readProtocolBlock(text, tag, profile) {
    if (typeof text !== 'string' || !text) return { status: 'missing', text: '' };
    const inspected = inspectTags(text, profile);
    const blocks = inspected.blocks.filter(block => block.lower === tag.toLowerCase()
        && ['body', 'data'].includes(block.kind));
    if (blocks.length > 1) return { status: 'ambiguous', reason: 'multiple', text: '' };
    const uncertain = new Set(['orphan-close', 'orphan-protocol-close', 'literal-protocol-in-reasoning',
        'nested-protocol',
        'unclosed-reasoning', 'unclosed-body', 'unclosed-data', 'unclosed-code-fence',
        'unclosed-xml-literal', 'unclosed-transparent', 'orphan-transparent']);
    if (inspected.issues.some(issue => uncertain.has(issue.code))) {
        return { status: 'ambiguous', reason: 'incomplete or conflicting boundaries', text: '' };
    }
    const block = blocks[0];
    if (!block) return { status: 'missing', text: '' };
    return { status: 'ok', text: text.slice(block.bodyStart, block.bodyEnd), start: block.start, end: block.end };
}
