import { buildTextDiff, diffText, splitUnchanged } from './diff.js';

let nativeDiff;
const loadDiff = () => nativeDiff ??= import('/lib.js').then(module => module.DiffMatchPatch).catch(error => {
    nativeDiff = undefined;
    throw error;
});

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

export function createDiffView(before, after, renderFullText) {
    const element = node('section', 'ch-diff');
    element.setAttribute('aria-label', '修复差异预览');
    const heading = node('div', 'ch-diff-heading');
    const legend = node('div', 'ch-diff-legend');
    const toggle = node('button', 'ch-text-button', '展开全部未改动内容');
    toggle.type = 'button'; toggle.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    heading.append(legend, toggle);
    const content = node('div', 'ch-diff-content');
    content.setAttribute('tabindex', '0');
    content.setAttribute('aria-label', '差异正文：删除有删除线，新增有下划线');
    const status = node('p', 'ch-help', '展开此项后计算差异。');
    const fullText = node('details', 'ch-disclosure ch-diff-originals');
    fullText.append(node('summary', '', '查看修改前 / 修改后全文'));
    let fullTextRendered = false, rendering;
    fullText.addEventListener('toggle', () => {
        if (fullText.open && !fullTextRendered) {
            fullTextRendered = true;
            fullText.append(renderFullText(diffText(before), diffText(after)));
        }
    });
    element.append(heading, status, content, fullText);
    const folded = [];
    const updateToggle = () => {
        const expanded = folded.every(details => details.open);
        toggle.textContent = expanded ? '折叠未改动内容' : '展开全部未改动内容';
        toggle.setAttribute('aria-expanded', String(expanded));
    };
    toggle.addEventListener('click', () => {
        const expand = !folded.every(details => details.open);
        folded.forEach(details => { details.open = expand; });
        updateToggle();
    });

    function unchanged(text) {
        const split = splitUnchanged(text);
        if (!split) { content.append(node('span', '', text)); return; }
        content.append(node('span', '', split.head));
        const details = node('details', 'ch-diff-context');
        const count = Array.from(split.hidden).length.toLocaleString();
        details.append(node('summary', '', `… ${count} 个字符未改动，展开查看`), node('span', '', split.hidden));
        details.addEventListener('toggle', updateToggle);
        folded.push(details);
        content.append(details, node('span', '', split.tail));
    }

    function render() {
        rendering ??= (async () => {
            status.textContent = '正在计算差异…';
            try {
                const Diff = await loadDiff();
                const model = buildTextDiff(diffText(before), diffText(after), new Diff());
                legend.append(node('span', 'ch-diff-removed', `− 删除 ${model.removed.toLocaleString()} 字符`),
                    node('span', 'ch-diff-added', `+ 新增 ${model.added.toLocaleString()} 字符`));
                status.textContent = model.coarse ? '内容较大，显示整体替换；完整内容仍可核对。'
                    : model.added || model.removed ? '已高亮改动；长段未改动内容默认折叠。' : '两份内容相同。';
                for (const [kind, text] of model.parts) {
                    if (kind === 0) unchanged(text);
                    else {
                        const mark = node(kind < 0 ? 'del' : 'ins', kind < 0 ? 'ch-diff-delete' : 'ch-diff-insert', text);
                        if (/^\s+$/.test(text)) {
                            mark.classList.add('ch-diff-whitespace');
                            mark.dataset.whitespace = text.replaceAll('\r', '␍').replaceAll('\n', '↵').replaceAll('\t', '⇥').replaceAll(' ', '·');
                            mark.setAttribute('aria-label', `${kind < 0 ? '删除' : '新增'}空白字符`);
                        }
                        content.append(mark);
                    }
                }
                toggle.hidden = !folded.length;
            } catch {
                status.textContent = '差异计算暂不可用，请查看下方完整对照。';
                content.hidden = true;
                fullText.open = true;
            }
        })();
        return rendering;
    }

    return { element, render };
}
