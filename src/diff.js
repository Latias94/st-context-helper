const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const segments = value => segmenter ? Array.from(segmenter.segment(value), part => part.segment) : Array.from(value);

export function diffText(value) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2) ?? String(value);
}

export function splitUnchanged(text) {
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (lines.length > 8) return {
        head: lines.slice(0, 3).join(''), hidden: lines.slice(3, -3).join(''), tail: lines.slice(-3).join(''),
    };
    if (text.length <= 1200) return null;
    const parts = segments(text);
    if (parts.length <= 360) return null;
    return { head: parts.slice(0, 160).join(''), hidden: parts.slice(160, -160).join(''), tail: parts.slice(-160).join('') };
}

export function buildTextDiff(before, after, engine) {
    if (before === after) return { parts: [[0, before]], added: 0, removed: 0, coarse: false };
    const replacement = () => ({ parts: [[-1, before], [1, after]].filter(([, text]) => text),
        added: Array.from(after).length, removed: Array.from(before).length, coarse: true });
    if (before.length + after.length > 200000) return replacement();

    // The native engine compares UTF-16 units. Encode graphemes so emoji and combining
    // characters cannot be split across differently styled DOM nodes.
    const symbols = new Map(), values = [''];
    const encode = text => segments(text).map(part => {
        if (!symbols.has(part)) {
            if (values.length > 0xffff) return null;
            symbols.set(part, String.fromCharCode(values.length));
            values.push(part);
        }
        return symbols.get(part);
    });
    const left = encode(before), right = encode(after);
    if (left.includes(null) || right.includes(null)) return replacement();
    engine.Diff_Timeout = .15;
    const parts = engine.diff_main(left.join(''), right.join(''), false).map(([kind, encoded]) => {
        let text = '';
        for (let i = 0; i < encoded.length; i++) text += values[encoded.charCodeAt(i)];
        return [kind, text];
    });
    const count = kind => parts.filter(([op]) => op === kind).reduce((total, [, text]) => total + Array.from(text).length, 0);
    return { parts, added: count(1), removed: count(-1), coarse: false };
}
