// This scans only the adapters' protocol delimiters, not arbitrary HTML.
function tokens(text) {
    const result = [];
    const issues = [];
    const comments = [];
    let at = 0;
    while (at < text.length) {
        if (at === 0 || text[at - 1] === '\n') {
            const fence = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(text.slice(at));
            if (fence) {
                const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
                closing.lastIndex = at + fence[0].length;
                const end = closing.exec(text);
                if (!end) issues.push({ code: 'unclosed-code-fence', severity: 'warning',
                    title: 'Code fence has no matching terminator',
                    detail: 'Tags after this fence are treated as examples. Close the fence before parsing protocol blocks.' });
                at = end ? end.index + end[0].length : text.length;
                continue;
            }
        }
        if (text[at] === '`') {
            const run = /^`+/.exec(text.slice(at))[0];
            const closing = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
            closing.lastIndex = at + run.length;
            const end = closing.exec(text);
            // An unmatched inline run is literal Markdown, not an endless code span.
            at = end ? end.index + end[0].length : at + run.length;
            continue;
        }
        if (text[at] === '"' || (text[at] === "'" && !/[\w]/.test(text[at - 1] ?? ''))
            || text[at] === '\u201c' || text[at] === '\u2018') {
            const patterns = { '"': /^"(?:[^"\\\r\n]|\\.)*"/, "'": /^'(?:[^'\\\r\n]|\\.)*'/,
                '\u201c': /^\u201c[^\u201d\r\n]*\u201d/, '\u2018': /^\u2018[^\u2019\r\n]*\u2019/ };
            const quoted = patterns[text[at]].exec(text.slice(at));
            if (quoted) { at += quoted[0].length; continue; }
        }
        const literalEnd = text.startsWith('<!--', at) ? '-->' : text.startsWith('<![CDATA[', at) ? ']]>' : null;
        if (literalEnd) {
            const end = text.indexOf(literalEnd, at + (literalEnd === '-->' ? 4 : 9));
            if (end < 0) issues.push({ code: 'unclosed-xml-literal', severity: 'warning',
                title: 'XML comment or CDATA section has no terminator',
                start: at, expected: literalEnd,
                detail: `Missing ${literalEnd}. Following tags remain literal; close this region or request AI boundary review.` });
            else if (literalEnd === '-->') comments.push({ start: at, end: end + 3, bodyStart: at + 4, bodyEnd: end });
            at = end < 0 ? text.length : end + literalEnd.length;
            continue;
        }
        if (text[at] === '<' && text[at - 1] !== '\\') {
            const match = /^<\/?([A-Za-z][\w~.-]*)\s*>/.exec(text.slice(at));
            if (match) {
                result.push({ tag: match[1], lower: match[1].toLowerCase(), closing: match[0][1] === '/',
                    start: at, end: at + match[0].length });
                at += match[0].length;
                continue;
            }
        }
        at++;
    }
    return { tokens: result, issues, comments };
}

// Wrapper syntax may be removed by native prompt rules, but quoted examples stay significant.
function transparentWrappers(text, profile) {
    const known = new Set((profile.transparentTags ?? []).map(tag => tag.toLowerCase()));
    const stack = [], delimiters = [], issues = [];
    if (!known.size && !profile.reasoningCommentMarker) return { delimiters, issues, comments: [] };
    const scanned = tokens(text);
    const comments = profile.reasoningCommentMarker ? scanned.comments.filter(comment =>
        text.slice(comment.bodyStart, comment.bodyEnd).trimStart().startsWith(profile.reasoningCommentMarker)) : [];
    for (const token of scanned.tokens.filter(token => known.has(token.lower))) {
        if (!token.closing) stack.push(token);
        else if (stack.at(-1)?.lower === token.lower) delimiters.push(stack.pop(), token);
        else issues.push({ code: 'orphan-transparent', severity: 'warning',
            title: 'Narrative wrapper has no opener', detail: token.tag });
    }
    for (const token of stack) issues.push({ code: 'unclosed-transparent', severity: 'warning',
        title: 'Narrative wrapper has no terminator', detail: token.tag });
    return { delimiters, issues, comments };
}

function visibleNarrative(text, profile) {
    let result = text;
    const { delimiters, comments } = transparentWrappers(text, profile);
    for (const token of [...delimiters, ...comments].sort((a, b) => b.start - a.start)) {
        result = result.slice(0, token.start) + result.slice(token.end);
    }
    return result;
}

function narrativeBodies(blocks, profile) {
    const transparent = new Set((profile.transparentTags ?? []).map(tag => tag.toLowerCase()));
    return blocks.filter(block => block.kind === 'body' && !transparent.has(block.lower));
}

export function inspectTags(text, profile) {
    text = String(text ?? '');
    const reasoning = new Set(profile.reasoningTags.map(tag => tag.toLowerCase()));
    const dataTags = new Set([...profile.updateTags, ...profile.statusTags ?? [], 'tableEdit', 'JSONPatch']
        .map(tag => tag.toLowerCase()));
    const bodies = new Set(profile.bodyTags.map(tag => tag.toLowerCase()));
    const scanned = tokens(text), stack = [], blocks = [], issues = [...scanned.issues], structural = [];
    let opaque = null, lastInnerClose = null;
    const boundary = token => {
        const left = text.slice(text.lastIndexOf('\n', token.start - 1) + 1, token.start);
        return /^(?:\s|<\/?[\w~.-]+\s*>)*$/.test(left)
            || (lastInnerClose !== null && /^(?:\s|<\/?[\w~.-]+\s*>)*$/.test(text.slice(lastInnerClose, token.start)));
    };
    const recover = token => {
        for (const open of stack.splice(0)) {
            const end = lastInnerClose && lastInnerClose > open.start ? lastInnerClose : token.start;
            blocks.push({ ...open, bodyEnd: end, end, closed: false,
                recoverable: bodies.has(token.lower) || (lastInnerClose !== null && lastInnerClose > open.start) });
        }
        lastInnerClose = null;
    };
    for (const token of scanned.tokens) {
        if (opaque) {
            if (token.closing && token.lower === opaque.lower) {
                blocks.push({ ...opaque, bodyEnd: token.start, end: token.end, closed: true });
                structural.push({ ...token, kind: opaque.kind });
                opaque = null;
            }
            continue;
        }
        if (reasoning.has(token.lower)) {
            if (!token.closing) {
                if (stack.length && !boundary(token)) {
                    issues.push({ code: 'literal-protocol-in-reasoning', severity: 'warning',
                        title: 'Inline tag inside reasoning is ambiguous',
                        detail: `${token.tag}: quote or escape this example. Local repair preserves its text; use AI preview if the boundary is unclear.` });
                    continue;
                }
                if (!stack.length) lastInnerClose = null;
                if (stack.length) issues.push({ code: 'nested-reasoning', severity: 'warning',
                    title: 'Nested reasoning formats', detail: `${stack.at(-1).tag} / ${token.tag}` });
                stack.push({ ...token, kind: 'reasoning', bodyStart: token.end, nested: stack.length > 0 });
                structural.push({ ...token, kind: 'reasoning' });
            } else {
                const restOfLine = text.slice(token.end, text.indexOf('\n', token.end) < 0 ? text.length : text.indexOf('\n', token.end));
                if (stack.length && restOfLine.trim() && !/^\s*</.test(restOfLine)) {
                    issues.push({ code: 'literal-protocol-in-reasoning', severity: 'warning',
                        title: 'Inline reasoning terminator is ambiguous',
                        detail: `${token.tag}: same-line prose follows this tag. It was retained as an example; inspect the source or request AI boundary repair.` });
                    continue;
                }
                const index = stack.findLastIndex(open => open.lower === token.lower);
                if (index < 0) {
                    issues.push({ code: 'orphan-close', severity: 'warning', title: 'Unpaired reasoning terminator',
                        detail: `${token.tag}: an earlier terminator may have been a literal example. Local normalization is withheld; inspect the source or request AI boundary repair.` });
                    if (boundary(token)) structural.push({ ...token, kind: 'reasoning', orphan: true });
                } else {
                    while (stack.length > index) {
                        const open = stack.pop();
                        const matched = open.lower === token.lower;
                        const block = { ...open, bodyEnd: token.start, end: token.end,
                            closed: matched, recoverable: !matched };
                        blocks.push(block);
                    }
                    structural.push({ ...token, kind: 'reasoning' });
                    lastInnerClose = stack.length ? token.end : null;
                }
            }
            continue;
        }
        if (!token.closing && (dataTags.has(token.lower) || bodies.has(token.lower))) {
            if (stack.length && !boundary(token)) {
                issues.push({ code: 'literal-protocol-in-reasoning', severity: 'warning',
                    title: 'Protocol opener is embedded in reasoning prose',
                    detail: `${token.tag}: not used as an automatic story boundary. Escape examples or request AI review.` });
                continue;
            }
            if (stack.length) recover(token);
            const kind = bodies.has(token.lower) ? 'body' : 'data';
            opaque = { ...token, kind, bodyStart: token.end };
            structural.push({ ...token, kind });
        } else if (token.closing && (dataTags.has(token.lower) || bodies.has(token.lower))) {
            issues.push({ code: 'orphan-protocol-close', severity: 'warning', title: 'Protocol terminator has no opener',
                detail: token.tag });
        }
    }
    for (const open of stack) {
        const end = lastInnerClose && lastInnerClose > open.start ? lastInnerClose : null;
        blocks.push({ ...open, bodyEnd: end ?? text.length, end: end ?? text.length,
            closed: false, recoverable: end !== null });
    }
    for (const block of blocks.filter(block => block.kind === 'reasoning' && !block.closed)) {
        issues.push({ code: 'unclosed-reasoning', severity: 'error', title: 'Reasoning wrapper is not closed',
            detail: block.recoverable ? 'A protocol boundary is available for normalization.'
                : 'No safe story boundary. Source retained; provide the missing body marker or request AI repair preview.' });
    }
    if (opaque) {
        blocks.push({ ...opaque, bodyEnd: text.length, end: text.length, closed: false });
        issues.push({ code: opaque.kind === 'body' ? 'unclosed-body' : 'unclosed-data', severity: 'error',
            title: `${opaque.kind === 'body' ? 'Narrative' : 'Data'} block is not closed`,
            detail: `${opaque.tag}: missing </${opaque.tag}>. No payload or ending is invented locally.` });
    }
    for (const block of blocks.filter(block => block.kind === 'body')) {
        issues.push(...transparentWrappers(text.slice(block.bodyStart, block.bodyEnd), profile).issues);
    }
    return { blocks: blocks.sort((a, b) => a.start - b.start), issues, structural };
}

export function normalizeMessage(text, profile) {
    const inspected = inspectTags(text, profile);
    if (profile.id === 'generic' || inspected.issues.some(issue => issue.code === 'orphan-close')) {
        return { text, issues: inspected.issues, changed: false };
    }
    const ranges = inspected.blocks.filter(block => block.kind === 'reasoning' && (block.closed || block.recoverable));
    const outer = ranges.filter(block => !ranges.some(other => other !== block
        && other.start < block.start && other.end >= block.end));
    let output = text;
    for (const block of outer.toReversed()) {
        let body = text.slice(block.bodyStart, block.bodyEnd);
        for (const token of inspected.structural.filter(token => token.kind === 'reasoning'
            && token.start >= block.bodyStart && token.end <= block.bodyEnd).toReversed()) {
            body = body.slice(0, token.start - block.bodyStart) + body.slice(token.end - block.bodyStart);
        }
        // Quoted protocol examples must remain inert to MVU and downstream regex scripts.
        body = body.replaceAll('<', '&lt;').replaceAll('>', '&gt;').trim();
        const replacement = `<${profile.reasoningTag}>\n${body}\n</${profile.reasoningTag}>`;
        output = output.slice(0, block.start) + replacement + output.slice(block.end);
    }
    return { text: output, issues: inspected.issues, changed: output !== text };
}

export function extractNarrative(text, profile) {
    const normalized = normalizeMessage(text, profile).text;
    const inspected = inspectTags(normalized, profile);
    const bodies = narrativeBodies(inspected.blocks, profile);
    if (bodies.length) return bodies.map(block => visibleNarrative(normalized.slice(block.bodyStart, block.bodyEnd), profile).trim()).join('\n');
    const ranges = inspected.blocks
        .filter(block => (block.kind === 'reasoning' && (block.closed || block.recoverable)) || block.kind === 'data');
    let body = normalized;
    for (const block of ranges.filter(block => !ranges.some(other => other.start < block.start && other.end >= block.end)).toReversed()) {
        body = body.slice(0, block.start) + body.slice(block.end);
    }
    return visibleNarrative(body, profile).replace(/<StatusPlaceHolderImpl\/>/g, '').trim();
}

// Keep disjoint story spans separate: removing a table between two paragraphs
// must not make their concatenation look absent from the original source.
export function narrativeSegments(text, profile) {
    const normalized = normalizeMessage(text, profile).text;
    const blocks = inspectTags(normalized, profile).blocks;
    const bodies = narrativeBodies(blocks, profile);
    const split = value => {
        const { delimiters, comments } = transparentWrappers(value, profile);
        const spans = [];
        let at = 0;
        for (const range of [...delimiters, ...comments].sort((a, b) => a.start - b.start)) {
            spans.push(value.slice(at, range.start));
            at = range.end;
        }
        spans.push(value.slice(at));
        return spans.flatMap(span => span.split(/<StatusPlaceHolderImpl\s*\/?>/gi))
            .map(span => span.trim()).filter(Boolean);
    };
    if (bodies.length) return bodies.flatMap(block => split(normalized.slice(block.bodyStart, block.bodyEnd)));
    const removed = blocks.filter(block => block.kind === 'data'
        || (block.kind === 'reasoning' && (block.closed || block.recoverable)))
        .filter(block => !blocks.some(other => other !== block && other.start < block.start && other.end >= block.end));
    const segments = [];
    let at = 0;
    for (const block of removed) {
        segments.push(...split(normalized.slice(at, block.start)));
        at = block.end;
    }
    segments.push(...split(normalized.slice(at)));
    return segments;
}

export function extractPatches(text, profile) {
    const normalized = normalizeMessage(text, profile).text;
    const blocks = inspectTags(normalized, profile).blocks.filter(block => block.kind === 'data'
        && block.lower === 'updatevariable' && block.closed);
    const patches = [];
    for (const block of blocks) {
        const source = normalized.slice(block.bodyStart, block.bodyEnd);
        const delimiters = tokens(source).tokens.filter(token => token.lower === 'jsonpatch');
        const open = delimiters.find(token => !token.closing);
        const close = delimiters.find(token => token.closing && token.start > open?.end);
        if (!open) throw new Error('No JSONPatch opener. Missing output or legacy MVU commands require state review.');
        if (!close) throw new Error('Missing </JSONPatch>. The update is incomplete; no state changes were inferred.');
        const data = JSON.parse(source.slice(open.end, close.start).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
        if (!Array.isArray(data)) throw new Error('JSONPatch must be an array.');
        patches.push(...data);
    }
    return patches;
}

// Only confirmed framing is ignorable. Literal examples stay significant, even in reasoning.
export function delimiterContent(text, profile) {
    const inspected = inspectTags(text, profile);
    const data = inspected.blocks.filter(block => block.kind === 'data');
    const edits = [
        ...data.map(block => ({ start: block.start, end: block.end, text: ` CONTEXT_HELPER_DATA_${block.lower} ` })),
        ...inspected.structural.filter(token => !data.some(block => token.start >= block.start && token.end <= block.end))
            .map(token => ({ ...token, text: ' ' })),
    ];
    let source = text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    }
    return source.replaceAll('<', '&lt;').replaceAll('>', '&gt;').trim().split(/\s+/);
}
