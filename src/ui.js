import { diagnosisSummary, presentIssue } from './diagnostics.js';
import { regexDepthLabel, regexSourceName } from './regex.js';
import { monitorSettings } from './monitor.js';
import { renderTokenUsage } from './token-view.js';

let viewSequence = 0;

const asArray = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(value) ? value.toLocaleString() : '—';
const severityNames = { error: '错误', warning: '警告', info: '提示' };
const confidenceNames = { declared: '明确声明', observed: '历史观察', conditional: '条件适用', template: '生成模板' };
const categoryNames = { repair: '可修复', policy: '规则策略', review: '需要核对' };

function text(value) {
    if (value === undefined || value === null) return '（空）';
    if (typeof value === 'string') return value || '（空）';
    return JSON.stringify(value, null, 2) ?? String(value);
}

function excerpt(value, limit = 1600) {
    const content = text(value);
    return content.length > limit
        ? `${content.slice(0, limit)}\n…（仅显示前 ${number(limit)} / ${number(content.length)} 字符）`
        : content;
}

function node(tag, className, content) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (content !== undefined) result.textContent = content;
    return result;
}

function comparison(before, after, beforeLabel = '修改前', afterLabel = '修改后') {
    const result = node('div', 'ch-comparison');
    for (const [label, value, tone] of [[beforeLabel, before, 'before'], [afterLabel, after, 'after']]) {
        const column = node('section', `ch-compare-column ch-${tone}`);
        column.append(node('h4', 'ch-content-label', label), node('pre', 'ch-fulltext', text(value)));
        result.append(column);
    }
    return result;
}

/**
 * Builds the popup content. The controller owns data access and mutations.
 */
export function createContextHelperView(config = {}) {
    const id = `context-helper-${++viewSequence}`;
    const element = node('section', 'context-helper');
    element.setAttribute('aria-label', '上下文助手');
    // Only this static template uses HTML; all supplied content is rendered as text.
    element.innerHTML = `
        <header class="ch-heading">
            <span class="ch-mark" aria-hidden="true"><i class="fa-solid fa-layer-group"></i></span>
            <div class="ch-title"><span class="ch-eyebrow">CONTEXT HELPER</span><h2>上下文助手</h2><p>看清上下文如何构建，再决定如何修复。</p></div>
            <span class="ch-badge" data-field="capture-kind">等待分析</span>
        </header>
        <div class="ch-scope">
            <div class="ch-range">
                <label>起始消息<input class="text_pole" name="start" type="number" min="0" step="1" placeholder="最早" data-lock></label>
                <span class="ch-range-divider" aria-hidden="true">→</span>
                <label>结束消息<input class="text_pole" name="end" type="number" min="0" step="1" placeholder="最新" data-lock></label>
            </div>
            <label class="ch-adapter">标签适配<select class="text_pole" name="adapter" data-lock>
                <option value="auto">自动识别预设</option><option value="izumi">Izumi</option><option value="cat-god">小猫之神 / 喵赛亚</option><option value="kunlun">昆仑 / Kunlun IDE</option><option value="generic">通用 · 仅观察</option>
            </select></label>
            <button type="button" class="menu_button ch-primary" data-action="inspect"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> 分析上下文</button>
            <p class="ch-help ch-scope-note" data-field="scope">消息编号从 0 开始；留空表示全部范围。</p>
        </div>
        <section class="ch-automation-strip" data-field="automation-strip" role="status" aria-live="polite">
            <div class="ch-automation-mark" aria-hidden="true"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
            <div class="ch-automation-copy"><strong data-field="automation-state">自动化状态：等待分析</strong><span data-field="automation-detail">分析后显示当前聊天的自动规范化是否生效。</span></div>
            <div class="ch-automation-modes"><span data-field="automation-scope">范围：当前聊天</span><span data-field="automation-history">历史：手动预览</span><span data-field="automation-ai">AI：手动</span><span data-field="automation-last"></span></div>
            <button type="button" class="ch-text-button" data-action="go-settings">查看设置 →</button>
        </section>
        <div class="ch-stats" aria-label="所选聊天范围统计">
            <div><span>原始消息字符</span><strong data-field="raw">—</strong></div>
            <div><span>正则模拟字符</span><strong data-field="projected">—</strong></div>
            <div><span>模拟移除字符</span><strong data-field="removed">—</strong></div>
            <div><span>系统 / 隐藏消息</span><strong data-field="hidden">—</strong></div>
        </div>
        <div class="ch-tabs" role="tablist" aria-label="上下文工作区">
            <button type="button" role="tab" data-tab="inspector" aria-selected="true"><span>01</span> 上下文检查</button>
            <button type="button" role="tab" data-tab="diagnosis" aria-selected="false" tabindex="-1"><span>02</span> 诊断 <small data-field="issue-count">0</small></button>
            <button type="button" role="tab" data-tab="repair" aria-selected="false" tabindex="-1"><span>03</span> 修复预览</button>
            <button type="button" role="tab" data-tab="settings" aria-selected="false" tabindex="-1"><span>04</span> 设置</button>
        </div>
        <section class="ch-panel" data-panel="inspector" role="tabpanel">
            <div class="ch-provenance" data-field="provenance"><strong>先查看，再处理</strong><p>分析当前聊天，查看提示词事件快照或本地正则模拟。两种结果会分别标注。</p></div>
            <section class="ch-token-summary" aria-label="完整提示词 token 统计" data-field="token-summary"></section>
            <details class="ch-disclosure ch-pipeline" open>
                <summary>上下文如何构建 <small>构建路径</small></summary>
                <ol class="ch-pipeline-list" data-field="pipeline"></ol>
                <p class="ch-help">环节说明不代表可验证的最终执行顺序。事件捕获后的扩展处理、后端与供应商转换仍可能改变请求。</p>
            </details>
            <details class="ch-disclosure" data-field="sources-panel" open hidden>
                <summary>上下文来源 <small>当前配置与注入记录</small></summary>
                <div class="ch-sources" data-field="sources"></div>
            </details>
            <details class="ch-disclosure" data-field="saved-raw-prompt" hidden>
                <summary>原生已保存提示词文本 <small>历史记录 · 事件阶段未知</small></summary>
                <p class="ch-help">来自酒馆保存的 rawPrompt 记录，可能对应较早请求；确切事件阶段、保存时间及与本次范围的对应关系未确认。请与本次事件快照分开核对。</p>
                <pre class="ch-fulltext" data-field="saved-raw-prompt-text"></pre>
            </details>
            <details class="ch-disclosure" data-field="protocol-inspector" hidden>
                <summary>角色卡协议证据 <small>标签要求与来源片段</small></summary>
                <div class="ch-protocol" data-field="protocol-inspector-content"></div>
            </details>
            <div class="ch-inspector-toolbar">
                <div class="ch-segmented" role="group" aria-label="消息来源">
                    <button type="button" data-source="prompt" aria-pressed="true">提示词预览</button>
                    <button type="button" data-source="history" aria-pressed="false">原始消息 / 正则</button>
                </div>
                <span class="ch-help" data-field="prompt-size">尚未读取消息</span>
            </div>
            <div class="ch-inspector">
                <nav class="ch-message-list" data-field="messages" aria-label="按顺序选择消息"></nav>
                <div class="ch-message-detail" data-field="message-detail"><div class="ch-empty">点击「分析上下文」，开始查看消息。</div></div>
            </div>
        </section>
        <section class="ch-panel" data-panel="diagnosis" role="tabpanel" hidden>
            <div class="ch-section-heading"><div><h3>定位异常，保留证据</h3><p class="ch-help">按严重程度查看标签、正文、变量与表格问题。</p></div><span class="ch-badge" data-field="profile">尚未识别预设</span></div>
            <div class="ch-diagnosis-summary" data-field="diagnosis-summary"></div>
            <details class="ch-disclosure" data-field="protocol-diagnosis" open hidden>
                <summary>角色卡协议证据 <small>对照缺失标签的诊断</small></summary>
                <div class="ch-protocol" data-field="protocol-diagnosis-content"></div>
            </details>
            <div class="ch-filters" role="group" aria-label="按严重程度筛选">
                <button type="button" data-filter="all" aria-pressed="true">全部</button>
                <button type="button" data-filter="error" aria-pressed="false">错误</button>
                <button type="button" data-filter="warning" aria-pressed="false">警告</button>
                <button type="button" data-filter="info" aria-pressed="false">提示</button>
            </div>
            <div class="ch-issues" data-field="issues"><div class="ch-empty">分析后显示诊断结果。</div></div>
            <aside class="ch-repair-guidance" data-field="boundary-guidance" hidden>
                <strong>标签边界仍待确认时</strong>
                <p class="ch-help">先核对协议证据和对应消息原文。如果本地预览无法确定正文边界或补齐必需标签，可编辑修复提示词后生成 AI 建议，再逐项检查差异。</p>
                <button type="button" class="ch-text-button" data-action="review-ai">前往 AI 修复预览 →</button>
            </aside>
            <details class="ch-disclosure" open><summary>MVU / 表格与标签事实 <small>仅显示已解析数据</small></summary><div class="ch-facts" data-field="facts"><p class="ch-help">尚无解析数据。</p></div></details>
        </section>
        <section class="ch-panel" data-panel="repair" role="tabpanel" hidden>
            <div class="ch-section-heading"><div><h3>每一项修复，先看差异</h3><p class="ch-help">本地规则与 AI 都只生成预览；应用需要单独确认。</p></div><span class="ch-badge" data-field="plan-count">尚无预览</span></div>
            <div class="ch-repair-methods">
                <div><strong>本地确定性修复</strong><p class="ch-help">按已识别的适配规则生成标签、变量和表格修复建议。</p><button type="button" class="menu_button" data-action="normalize">生成本地修复预览</button></div>
                <div><strong>AI 辅助修复</strong><p class="ch-help">使用所选连接和提示词生成建议，逐项核对后再应用。</p><p class="ch-help ch-ai-data-use" id="${id}-ai-data-use">点击后，将向所选连接的 LLM 发送选中消息楼层、限制长度的预设与角色卡协议片段、相关变量快照和表格，以及诊断与修复提示词，用于生成修复预览。</p><button type="button" class="menu_button" data-action="ai" aria-describedby="${id}-ai-data-use">生成 AI 修复预览</button></div>
            </div>
            <details class="ch-disclosure" open>
                <summary>AI 连接与生成设置 <small>沿用酒馆连接</small></summary>
                <div class="ch-fields">
                    <label>API 连接<select class="text_pole" name="connectionId" data-lock><option value="current">当前酒馆连接</option></select></label>
                    <label>模型<div class="ch-model-field"><input class="text_pole" name="model" placeholder="跟随所选连接，可直接填写" autocomplete="off" data-lock><button type="button" class="menu_button" data-action="models" aria-label="刷新模型列表" title="刷新所选连接的模型列表"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button></div><datalist data-field="models"></datalist></label>
                    <label>最大输出 token<input class="text_pole" name="maxTokens" type="number" min="1" step="1" data-lock></label>
                </div>
            </details>
            <details class="ch-disclosure">
                <summary>修复提示词 <small>可查看与编辑</small></summary>
                <textarea class="text_pole ch-prompt" name="prompt" rows="8" spellcheck="false" aria-label="修复提示词" data-lock></textarea>
            </details>
            <div class="ch-plan" data-field="plan"><div class="ch-empty">先生成修复预览，再逐项核对原文与修改内容。</div></div>
        </section>
        <section class="ch-panel" data-panel="settings" role="tabpanel" hidden>
            <div class="ch-section-heading"><div><h3>监测、自动化与规则设置</h3><p class="ch-help">浮窗是全局显示设置；新消息规范化按聊天保存。</p></div><span class="ch-badge" data-field="settings-status">等待分析</span></div>
            <div class="ch-settings-monitor">
                <label class="ch-incoming"><input type="checkbox" name="showMonitor" data-lock><span><strong>显示上下文浮窗</strong><small>默认关闭。开启后随聊天变化检查最近 12 条消息及当前记忆表格；可拖动、收起，或点击进入诊断。</small></span></label>
                <label class="ch-threshold">Token 提醒阈值（%）<input class="text_pole" name="tokenWarningPercent" type="number" min="1" max="100" step="1" data-lock></label>
                <p class="ch-help">达到阈值时，浮窗会提示。占用率 =（上次捕获的完整输入估算 token + 输出预留）÷ 当时配置的上下文上限；默认 85%。未捕获请求时不推算完整用量。浮窗只监测，不会自动请求 AI 或应用历史修复。</p>
            </div>
            <div class="ch-settings-automation">
                <label class="ch-incoming"><input type="checkbox" name="normalizeIncoming" data-lock><span><strong>规范新助手消息的标签边界</strong><small>范围：当前聊天。仅对之后收到的新助手消息生效；不会回写历史消息，也不会自动应用修复预览。</small></span></label>
                <p class="ch-help">通用适配器下自动规范化会暂停；请在上方选择可识别的适配器后再分析。切换后会保存并重新分析；保存失败会显示实际状态和原因。</p>
            </div>
            <div class="ch-regex-heading"><div><h3>正则规则清单</h3><p class="ch-help">列出全局、预设和角色卡规则，包括关闭、未获允许及当前不作用于提示词的规则。</p></div><span class="ch-badge" data-field="regex-status">尚未读取</span></div>
            <div class="ch-regex-filters">
                <label class="ch-regex-search">搜索规则<input class="text_pole" type="search" data-regex-search placeholder="名称、来源、查找或替换文本" autocomplete="off"></label>
                <label>来源<select class="text_pole" data-regex-source><option value="all">全部来源</option></select></label>
            </div>
            <p class="ch-help" data-field="regex-scope-help">规则作用范围会影响实际聊天：全局规则影响所有聊天，预设规则随预设，角色卡规则随当前角色卡。0 深度表示最新楼层；开关只更改配置，实际生效状态以分析结果为准。</p>
            <div class="ch-regex-list" data-field="regex-rules"><div class="ch-empty">分析后显示正则规则。</div></div>
        </section>
        <div class="ch-status" role="status" aria-live="polite" aria-atomic="true" data-field="status" hidden></div>
        <footer class="ch-footer">
            <p class="ch-help" data-field="footer-note">字符数不等同于 token；模拟不代表完整发送请求。</p>
            <div class="ch-actions">
                <button type="button" class="menu_button ch-quiet" data-action="export">导出报告</button>
                <button type="button" class="menu_button ch-quiet" data-action="undo">撤销上次修复</button>
                <button type="button" class="menu_button" data-action="cancel" hidden>停止操作</button>
                <button type="button" class="menu_button ch-primary" data-action="apply" disabled>应用预览</button>
            </div>
        </footer>`;

    const field = name => element.querySelector(`[data-field="${name}"]`);
    const control = name => element.querySelector(`[name="${name}"]`);
    const action = name => element.querySelector(`[data-action="${name}"]`);
    const tabs = [...element.querySelectorAll('[data-tab]')];
    const panels = [...element.querySelectorAll('[data-panel]')];
    const options = { adapter: 'auto', connectionId: 'current', model: '', maxTokens: 8192, prompt: '', normalizeIncoming: false,
        ...config.options, ...monitorSettings(config.options) };
    let analysis = null;
    let plan = null;
    let externalBusy = false;
    let pendingAction = null;
    let backupAvailable = false;
    let source = 'prompt';
    let selectedIndex = 0;
    let variant = 'compare';
    let issueFilter = 'all';
    let modelRequest = null;
    let modelRevision = 0;
    let optionRevision = 0;
    let optionSaving = false;
    let regexSaving = false;
    let savedOptions = { ...options };
    let disposed = false;
    let regexSearch = '';
    let regexSource = 'all';

    for (const name of ['start', 'end', 'adapter', 'connectionId', 'model', 'maxTokens', 'prompt', 'tokenWarningPercent']) {
        const value = options[name];
        if (control(name).tagName === 'SELECT' && value != null && ![...control(name).options].some(item => item.value === String(value))) {
            control(name).append(new Option(name === 'connectionId' ? '已保存的连接（等待加载）' : String(value), String(value)));
        }
        control(name).value = name === 'end' && value === -1 ? '' : value ?? '';
    }
    control('normalizeIncoming').checked = Boolean(options.normalizeIncoming);
    control('showMonitor').checked = options.showMonitor;
    field('models').id = `${id}-models`;
    control('model').setAttribute('list', field('models').id);
    tabs.forEach(tab => {
        tab.id = `${id}-${tab.dataset.tab}-tab`;
        const panel = element.querySelector(`[data-panel="${tab.dataset.tab}"]`);
        panel.id = `${id}-${tab.dataset.tab}-panel`;
        panel.setAttribute('aria-labelledby', tab.id);
        tab.setAttribute('aria-controls', panel.id);
    });

    function setStatus(message = '', isError = false) {
        if (disposed) return;
        field('status').hidden = !message;
        field('status').textContent = String(message);
        field('status').classList.toggle('is-error', Boolean(isError));
    }

    function reportError(error) {
        setStatus(error?.name === 'AbortError' ? '操作已停止。' : error?.message || String(error), error?.name !== 'AbortError');
    }

    function getOptions() {
        const integer = (name, label, minimum, fallback) => {
            const value = control(name).value;
            if (control(name).validity.badInput) throw new Error(`${label}必须是整数。`);
            if (value === '') return fallback;
            const result = Number(value);
            if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`${label}必须是至少 ${minimum} 的整数。`);
            return result;
        };
        const start = integer('start', '起始消息', 0, 0);
        const end = integer('end', '结束消息', 0, null);
        if (end !== null && end < start) throw new Error('结束消息不能早于起始消息。');
        const tokenWarningPercent = integer('tokenWarningPercent', 'Token 提醒阈值', 1, 85);
        if (tokenWarningPercent > 100) throw new Error('Token 提醒阈值不能大于 100%。');
        return {
            start, end,
            adapter: control('adapter').value || 'auto',
            connectionId: control('connectionId').value || 'current',
            model: control('model').value.trim(),
            maxTokens: integer('maxTokens', '最大输出 token', 1, 8192),
            prompt: control('prompt').value,
            normalizeIncoming: control('normalizeIncoming').checked,
            showMonitor: control('showMonitor').checked,
            tokenWarningPercent,
        };
    }

    function updateAvailability() {
        const busy = disposed || externalBusy || pendingAction !== null || modelRequest !== null || optionSaving || regexSaving;
        element.setAttribute('aria-busy', String(!disposed && busy));
        element.setAttribute('aria-disabled', String(disposed));
        element.querySelectorAll('[data-lock]').forEach(item => { item.disabled = busy || item.dataset.unavailable === 'true'; });
        const hasAnalysis = Boolean(analysis);
        action('inspect').disabled = busy || typeof config.onInspect !== 'function';
        action('normalize').disabled = busy || !hasAnalysis || typeof config.onNormalize !== 'function';
        action('ai').disabled = busy || !hasAnalysis || typeof config.onAiRepair !== 'function'
            || Boolean(control('connectionId').selectedOptions[0]?.disabled);
        action('models').disabled = busy || typeof config.onModels !== 'function'
            || Boolean(control('connectionId').selectedOptions[0]?.disabled);
        action('apply').disabled = busy || !asArray(plan?.changes).length || typeof config.onApply !== 'function';
        action('undo').disabled = busy || !backupAvailable || typeof config.onUndo !== 'function';
        action('export').disabled = busy || !analysis || typeof config.onExport !== 'function';
        action('cancel').hidden = disposed || (!modelRequest
            && (typeof config.onCancel !== 'function' || (!externalBusy && pendingAction === null)));
        element.querySelectorAll('[data-issue-action="local"]').forEach(button => {
            button.disabled = busy || !analysis || typeof config.onNormalize !== 'function';
        });
    }

    function setBusy(busy) {
        if (disposed) return;
        externalBusy = Boolean(busy);
        updateAvailability();
    }

    function selectTab(name, focus = false) {
        if (disposed) return;
        if (!tabs.some(tab => tab.dataset.tab === name)) return;
        tabs.forEach(tab => {
            const active = tab.dataset.tab === name;
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            if (active && focus) tab.focus();
        });
        panels.forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
    }

    function showPlan(next) {
        if (disposed) return;
        plan = next || null;
        const container = field('plan');
        container.replaceChildren();
        const changes = asArray(plan?.changes);
        field('plan-count').textContent = plan ? `${number(changes.length)} 项变更 · 未应用` : '尚无预览';
        action('apply').textContent = changes.length ? `应用预览（${changes.length}）` : '应用预览';
        if (!plan) {
            container.append(node('div', 'ch-empty', '先生成修复预览，再逐项核对原文与修改内容。'));
        } else {
            container.append(node('h3', '', '修复预览'), node(typeof plan.summary === 'string' ? 'p' : 'pre', 'ch-plan-summary', text(plan.summary)));
            if (!changes.length) container.append(node('p', 'ch-help', '本次没有可应用的变更。'));
            changes.forEach((change, index) => {
                const details = node('details', 'ch-change ch-disclosure');
                details.open = changes.length === 1;
                const type = { message: '消息', variables: 'MVU 变量', table: '表格' }[change.type] || '数据';
                const target = change.id != null ? ` #${change.id}` : change.uid != null ? ` · ${change.uid}` : '';
                details.append(node('summary', '', `${index + 1}. ${type}${target}`), node('p', 'ch-change-reason', text(change.reason)),
                    comparison(change.before, change.after));
                container.append(details);
            });
            if (asArray(plan.issues).length) {
                const notes = node('div', 'ch-issues');
                renderIssues(notes, plan.issues, false);
                container.append(notes);
            }
            selectTab('repair');
        }
        updateAvailability();
    }

    async function runAction(name, callback) {
        if (disposed || action(name).disabled || typeof callback !== 'function') return;
        try {
            if (['inspect', 'normalize', 'ai'].includes(name)) getOptions();
            pendingAction = name;
            updateAvailability();
            if (name === 'apply') await callback(plan);
            else if (['inspect', 'normalize', 'ai'].includes(name)) await callback(getOptions());
            else await callback();
        } catch (error) {
            reportError(error);
        } finally {
            if (!disposed) {
                pendingAction = null;
                updateAvailability();
            }
        }
    }

    function messageRows() {
        return asArray(source === 'prompt' ? analysis?.prompt?.messages : analysis?.messages);
    }

    function renderMessages() {
        if (disposed) return;
        const rows = messageRows();
        selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, rows.length - 1));
        element.querySelectorAll('[data-source]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.source === source));
        });
        field('messages').replaceChildren();
        rows.forEach((message, index) => {
            const button = node('button', 'ch-message');
            button.type = 'button';
            button.dataset.messageIndex = String(index);
            button.setAttribute('aria-current', String(index === selectedIndex));
            const meta = node('span', 'ch-message-meta');
            meta.append(node('span', 'ch-message-order', String(index + 1).padStart(2, '0')),
                node('span', 'ch-role', message.role || 'unknown'));
            const content = source === 'prompt' ? message.content : message.projected;
            const length = source === 'prompt' ? (typeof content === 'string' ? content.length : text(content).length)
                : message.promptChars ?? (typeof content === 'string' ? content.length : 0);
            meta.append(node('small', '', `${number(length)} 字符`));
            button.append(meta, node('strong', 'ch-message-name', source === 'history'
                ? `#${message.id ?? index} · ${message.name || '未命名消息'}` : message.name || `提示词消息 ${index + 1}`));
            if (source === 'prompt') button.append(node('small', 'ch-origin', message.origin ? `来源：${text(message.origin)}` : '来源未标注'));
            if (asArray(message.issues).length) button.append(node('span', 'ch-issue-dot', `${message.issues.length} 项诊断`));
            button.addEventListener('click', () => selectMessage(index));
            field('messages').append(button);
        });
        field('prompt-size').textContent = source === 'prompt'
            ? `${analysis?.prompt?.kind === 'captured' ? '事件快照' : '本地模拟'} · ${number(rows.length)} 条 · ${number(analysis?.prompt?.totalCharacters)} 字符`
            : `所选聊天范围 · ${number(rows.length)} 条 · 正则结果为模拟`;
        renderMessageDetail();
    }

    function selectMessage(index) {
        if (disposed) return;
        selectedIndex = index;
        field('messages').querySelectorAll('[data-message-index]').forEach(button => {
            button.setAttribute('aria-current', String(Number(button.dataset.messageIndex) === index));
        });
        renderMessageDetail();
    }

    function renderMessageDetail() {
        const detail = field('message-detail');
        detail.replaceChildren();
        const message = messageRows()[selectedIndex];
        if (!message) {
            detail.append(node('div', 'ch-empty', analysis ? '此来源没有可显示的消息。' : '点击「分析上下文」，开始查看消息。'));
            return;
        }
        const heading = node('div', 'ch-detail-heading');
        heading.append(node('h3', '', source === 'history' ? `消息 #${message.id}` : `提示词消息 ${selectedIndex + 1}`),
            node('span', 'ch-badge', `${message.role || 'unknown'}${message.name ? ` · ${message.name}` : ''}`));
        detail.append(heading);
        if (source === 'prompt') {
            detail.append(node('p', 'ch-help', message.origin ? `来源标注：${text(message.origin)}` : '此消息未提供来源标注，不根据角色推断预设、角色卡或世界书归属。'),
                node('pre', 'ch-fulltext', text(message.content)));
            return;
        }
        detail.append(node('p', 'ch-help', `原始 ${number(message.rawChars)} → 模拟 ${number(message.promptChars)} 字符 · swipe ${message.swipeId ?? '未提供'}`));
        const switcher = node('div', 'ch-segmented ch-variants');
        switcher.setAttribute('role', 'group');
        switcher.setAttribute('aria-label', '消息内容视图');
        for (const [value, label] of [['raw', '原始全文'], ['projected', '正则模拟'], ['compare', '并排对照']]) {
            const button = node('button', '', label);
            button.type = 'button';
            button.setAttribute('aria-pressed', String(variant === value));
            button.addEventListener('click', () => { variant = value; renderMessageDetail(); });
            switcher.append(button);
        }
        detail.append(switcher);
        if (variant === 'compare') detail.append(comparison(message.raw, message.projected, '聊天原文', '正则处理模拟'));
        else detail.append(node('pre', 'ch-fulltext', text(message[variant])));
        const trace = node('details', 'ch-disclosure');
        trace.open = true;
        trace.append(node('summary', '', `正则规则轨迹 · ${asArray(message.trace).length} 条`));
        if (!asArray(message.trace).length) trace.append(node('p', 'ch-help', '未记录到改变内容的规则；这不表示没有规则执行。'));
        asArray(message.trace).forEach(step => {
            const row = node('div', 'ch-trace-row');
            const policy = step.policy === 'trim' ? '深度裁剪' : step.policy === 'summary' ? '摘要策略' : '';
            const status = step.narrativeLost ? '正文可能丢失' : policy || '内容有变化';
            row.append(node('strong', '', step.name || step.ruleKey || '未命名规则'),
                node('small', 'ch-help', `来源：${step.source && step.source !== 'unknown' ? text(step.source) : '未标注'} · ${step.ruleKey ? `规则键：${text(step.ruleKey)} · ` : ''}深度 ${step.depth ?? '未标注'}（范围 ${step.minDepth ?? '未设'}–${step.maxDepth ?? '未设'}）`),
                node('span', '', `${number(step.before)} → ${number(step.after)} 字符 · 移除 ${number(step.removed)} · ${status}`));
            trace.append(row);
        });
        detail.append(trace);
        if (asArray(message.blocks).length) {
            const blocks = node('details', 'ch-disclosure');
            blocks.append(node('summary', '', '已解析的标签块'), node('pre', 'ch-fulltext', text(message.blocks)));
            detail.append(blocks);
        }
        if (asArray(message.issues).length) {
            const issues = node('div', 'ch-issues');
            renderIssues(issues, message.issues, false);
            detail.append(issues);
        }
    }

    function issuePresentation(issue) {
        try {
            const result = presentIssue(issue);
            return { ...result, severity: result.category === 'policy' ? 'info' : result.severity || 'info' };
        } catch (error) {
            return { ...issue, title: '需要核对的诊断', detail: text(issue.detail || issue.title || issue.code),
                recommendation: '展开原始诊断数据，确认来源和处理范围。', action: 'none', category: 'review', sourceError: error.message };
        }
    }

    function issueActionButton(item, presentation) {
        const actionType = presentation.action || 'none';
        if (!['regex', 'local', 'ai', 'settings'].includes(actionType)) return;
        const button = node('button', 'ch-text-button');
        button.type = 'button';
        button.dataset.issueAction = actionType;
        if (actionType === 'regex') {
            button.textContent = '查看对应规则 →';
            button.addEventListener('click', () => {
                if (presentation.ruleKey) showRegexRule(presentation.ruleKey);
                else selectTab('settings', true);
            });
        } else if (actionType === 'local') {
            button.textContent = '生成本地修复预览 →';
            button.disabled = !analysis || typeof config.onNormalize !== 'function';
            button.addEventListener('click', () => { void runAction('normalize', config.onNormalize); });
        } else if (actionType === 'ai') {
            button.textContent = '前往 AI 修复预览 →';
            button.disabled = !analysis || typeof config.onAiRepair !== 'function';
            button.addEventListener('click', () => {
                selectTab('repair', true);
                if (!button.disabled) action('ai').focus();
            });
        } else {
            button.textContent = '前往设置 →';
            button.addEventListener('click', () => {
                if (presentation.ruleKey) showRegexRule(presentation.ruleKey);
                else selectTab('settings', true);
            });
        }
        item.append(button);
    }

    function renderIssues(container, issues, navigable = true, actions = false) {
        container.replaceChildren();
        if (!issues.length) {
            container.append(node('div', 'ch-empty', analysis ? '当前筛选下没有需要处理的问题；仍可查看消息与解析事实。' : '分析后显示诊断结果。'));
            return;
        }
        const order = { error: 0, warning: 1, info: 2 };
        [...issues].map(issue => ({ issue, presentation: issuePresentation(issue) }))
            .sort((a, b) => (order[a.presentation.severity ?? a.issue.severity] ?? 2) - (order[b.presentation.severity ?? b.issue.severity] ?? 2))
            .forEach(({ issue, presentation }) => {
                const category = presentation.category;
                const categoryClass = categoryNames[category] ? category : 'review';
                const severity = category === 'policy' ? 'info' : severityNames[presentation.severity] ? presentation.severity : 'info';
                const item = node('article', `ch-issue ch-severity-${severity} ch-issue-category-${categoryClass}`);
                const heading = node('div', 'ch-issue-heading');
                heading.append(node('span', 'ch-severity', severityNames[severity]), node('span', 'ch-issue-category', categoryNames[categoryClass]),
                    node('strong', '', presentation.title || '需要核对的诊断'));
                item.append(heading, node('p', '', text(presentation.detail || '请展开原始诊断数据确认。')));
                if (presentation.recommendation) item.append(node('p', 'ch-recommendation', text(presentation.recommendation)));
                const metadata = [presentation.code || issue.code,
                    presentation.rule ? `规则：${text(presentation.rule)}` : presentation.ruleKey ? `规则：${text(presentation.ruleKey)}` : '',
                    presentation.source ? `来源：${text(presentation.source)}` : ''].filter(Boolean);
                if (metadata.length) item.append(node('small', 'ch-help', metadata.join(' · ')));
                if (issue.messageId != null) {
                    const index = asArray(analysis?.messages).findIndex(message => String(message.id) === String(issue.messageId));
                    if (navigable && index >= 0) {
                        const link = node('button', 'ch-text-button', `查看消息 #${issue.messageId} →`);
                        link.type = 'button';
                        link.addEventListener('click', () => {
                            source = 'history';
                            selectedIndex = index;
                            renderMessages();
                            selectTab('inspector', true);
                            field('message-detail').scrollIntoView({ block: 'nearest' });
                        });
                        item.append(link);
                    } else item.append(node('small', 'ch-help', `消息 #${issue.messageId}`));
                }
                if (actions) issueActionButton(item, presentation);
                const rawDetails = node('details', 'ch-issue-raw');
                rawDetails.append(node('summary', '', '展开原始诊断数据'), node('pre', 'ch-fulltext', excerpt(issue, 3600)));
                item.append(rawDetails);
                container.append(item);
            });
    }

    function renderSources() {
        const container = field('sources');
        container.replaceChildren();
        field('sources-panel').hidden = !analysis;
        const savedRawPrompt = analysis?.prompt?.savedRawPrompt;
        const hasSavedPrompt = typeof savedRawPrompt === 'string' && savedRawPrompt.length > 0;
        field('saved-raw-prompt').hidden = !hasSavedPrompt;
        field('saved-raw-prompt-text').textContent = hasSavedPrompt ? savedRawPrompt : '';
        if (!analysis) return;
        const sources = analysis.sources;
        if (!sources) {
            container.append(node('p', 'ch-help', '本次分析未提供来源信息，不根据消息内容推断预设、角色卡或世界书。'));
            return;
        }
        const facts = node('dl', 'ch-source-facts');
        for (const [label, value] of [['预设', sources.presetName], ['角色', sources.character], ['关联世界书 · 激活未证实', sources.linkedWorld]]) {
            const fact = node('div', '');
            fact.append(node('dt', '', label), node('dd', '', value ? excerpt(value, 240) : '未提供'));
            facts.append(fact);
        }
        container.append(facts, node('p', 'ch-help', '这些是当前配置与注册记录。世界书即使已关联或启用，其条件是否触发、内容是否实际进入本次请求仍未证实；请结合事件快照核对。'));
        const injections = asArray(sources.injectedPrompts);
        const details = node('details', 'ch-disclosure');
        details.append(node('summary', '', `插件注入记录 · ${number(injections.length)} 项`),
            node('p', 'ch-help', '按注册记录展示，不表示发送顺序。最多显示 24 项，每项文本最多 2,000 字符；位置编号保留原始值。'));
        const entries = node('div', 'ch-source-entries');
        injections.slice(0, 24).forEach((entry, index) => {
            const item = node('details', 'ch-disclosure');
            item.append(node('summary', '', `${index + 1}. ${entry.name ? excerpt(entry.name, 160) : '未命名注入'}`));
            const metadata = [
                `角色：${entry.role != null ? excerpt(entry.role, 80) : '未标注'}`,
                `位置编号：${entry.position != null ? excerpt(entry.position, 80) : '未标注'}`,
                `深度：${entry.depth != null ? excerpt(entry.depth, 80) : '未标注'}`,
            ];
            item.append(node('p', 'ch-help', metadata.join(' · ')), node('pre', 'ch-fulltext ch-excerpt', excerpt(entry.text, 2000)));
            entries.append(item);
        });
        if (!injections.length) entries.append(node('p', 'ch-help', '本次分析没有提供插件注入记录。'));
        if (injections.length > 24) entries.append(node('p', 'ch-help', `另有 ${number(injections.length - 24)} 项未展开，可导出报告查看。`));
        details.append(entries);
        container.append(details);
    }

    function renderCardProtocol() {
        const protocol = analysis?.cardProtocol;
        for (const location of ['inspector', 'diagnosis']) {
            const container = field(`protocol-${location}-content`);
            container.replaceChildren();
            field(`protocol-${location}`).hidden = !analysis;
            if (!analysis) continue;
            if (!protocol) {
                container.append(node('p', 'ch-help', '本次分析尚未提供角色卡协议证据。请结合已识别的标签适配器和消息原文核对。'));
                continue;
            }
            container.append(node('strong', 'ch-protocol-name', protocol.name ? excerpt(protocol.name, 240) : '未命名角色卡协议'),
                node('p', 'ch-help', `协议来源：${protocol.source && protocol.source !== 'unknown' ? excerpt(protocol.source, 240) : '未标注'}`));
            const groups = node('div', 'ch-tag-groups');
            for (const [label, tags] of [['正文候选标签', protocol.bodyTags], ['必需标签 · 解析结果', protocol.requiredTags], ['状态候选标签', protocol.statusTags]]) {
                const group = node('div', 'ch-tag-group');
                group.append(node('h4', 'ch-content-label', label));
                const tokens = node('div', 'ch-tag-list');
                asArray(tags).slice(0, 24).forEach(tag => tokens.append(node('code', 'ch-tag', excerpt(tag, 120))));
                if (!asArray(tags).length) tokens.append(node('small', 'ch-help', '未提供'));
                if (asArray(tags).length > 24) tokens.append(node('small', 'ch-help', `另有 ${number(tags.length - 24)} 项，见导出报告。`));
                group.append(tokens);
                groups.append(group);
            }
            container.append(groups, node('p', 'ch-help', '正文与状态候选标签不自动构成必需输出；请结合要求的适用条件与诊断核对。世界书来源即使已启用，其条件激活也尚未证实。'),
                node('p', 'ch-help', 'Maintext、Status_block 若仅用于描述生成模板，不构成角色卡编写者当前聊天的必需输出。模板、历史观察与条件证据均不自动升级为当前聊天的无条件要求。'));
            const requirements = asArray(protocol.requirements);
            const requirementDetails = node('details', 'ch-disclosure');
            requirementDetails.open = requirements.length > 0;
            requirementDetails.append(node('summary', '', `标签要求与适用条件 · ${number(requirements.length)} 项`));
            const requirementList = node('div', 'ch-requirement-list');
            requirements.slice(0, 24).forEach(requirement => {
                const item = node('article', 'ch-requirement');
                const heading = node('div', 'ch-evidence-heading');
                const condition = requirement.conditional === true ? '条件适用'
                    : requirement.conditional === false ? '未标为条件要求' : '适用条件未标注';
                heading.append(node('code', 'ch-tag', requirement.tag ? excerpt(requirement.tag, 120) : '标签未标注'),
                    node('span', 'ch-badge', `类型：${requirement.kind ? excerpt(requirement.kind, 120) : '未标注'}`),
                    node('span', 'ch-badge', condition));
                item.append(heading, node('p', 'ch-help', `要求来源：${requirement.source && requirement.source !== 'unknown' ? excerpt(requirement.source, 240) : '未标注'}`));
                if (requirement.conditional === true) item.append(node('p', 'ch-help', '仅在对应条件成立时适用；此记录不证明条件已触发。'));
                requirementList.append(item);
            });
            if (!requirements.length) requirementList.append(node('p', 'ch-help', '未提供逐项要求及其适用条件，无法据此确认当前消息必须包含哪些标签。'));
            if (requirements.length > 24) requirementList.append(node('p', 'ch-help', `另有 ${number(requirements.length - 24)} 项要求，见导出报告。`));
            requirementDetails.append(requirementList);
            container.append(requirementDetails);
            const evidence = asArray(protocol.evidence);
            const details = node('details', 'ch-disclosure');
            details.append(node('summary', '', `协议证据 · ${number(evidence.length)} 条`));
            const entries = node('div', 'ch-evidence-list');
            evidence.slice(0, 24).forEach(entry => {
                const item = node('article', 'ch-evidence');
                const heading = node('div', 'ch-evidence-heading');
                const confidence = Object.hasOwn(confidenceNames, entry.confidence)
                    ? `${confidenceNames[entry.confidence]} · ${entry.confidence}` : entry.confidence != null ? excerpt(entry.confidence, 80) : '未提供';
                heading.append(node('code', 'ch-tag', entry.tag ? excerpt(entry.tag, 120) : '标签未标注'),
                    node('span', 'ch-badge', `类型：${entry.kind ? excerpt(entry.kind, 120) : '未标注'}`),
                    node('span', 'ch-badge', `证据依据：${confidence}`));
                item.append(heading, node('p', 'ch-help', `证据来源：${entry.source && entry.source !== 'unknown' ? excerpt(entry.source, 240) : '未标注'}`),
                    node('pre', 'ch-fulltext ch-excerpt', excerpt(entry.excerpt)));
                if (entry.confidence === 'template') item.append(node('p', 'ch-help', '生成模板的输出示例；不直接约束编写者当前聊天。'));
                if (entry.confidence === 'conditional') item.append(node('p', 'ch-help', '条件证据；是否适用于本次消息尚未证实。'));
                if (entry.confidence === 'observed') item.append(node('p', 'ch-help', '历史输出中的观察记录；不直接证明这是必需标签。'));
                entries.append(item);
            });
            if (!evidence.length) entries.append(node('p', 'ch-help', '未提供证据片段，无法在此核对标签要求的出处。'));
            if (evidence.length > 24) entries.append(node('p', 'ch-help', `另有 ${number(evidence.length - 24)} 条证据，见导出报告。`));
            details.append(node('p', 'ch-help', '最多显示 24 条证据，每条片段最多 1,600 字符。证据依据区分声明、观察、条件与模板，并保留原始枚举值。'), entries);
            container.append(details);
            const warnings = asArray(protocol.warnings);
            if (warnings.length) {
                const notes = node('div', 'ch-protocol-warnings');
                notes.append(node('strong', '', '协议识别提示'));
                const list = node('div', 'ch-issues');
                renderIssues(list, warnings.slice(0, 24));
                notes.append(list);
                if (warnings.length > 24) notes.append(node('p', 'ch-help', `另有 ${number(warnings.length - 24)} 条提示，见导出报告。`));
                container.append(notes);
            }
        }
    }

    function ruleSource(rule) {
        return regexSourceName(rule.source || rule.scriptType);
    }

    function ruleKey(rule) {
        return String(rule.key ?? rule.id ?? rule.name ?? '');
    }

    function ruleEnabled(rule) {
        return rule.enabled !== false && rule.disabled !== true;
    }

    function ruleFloors(rule) {
        const key = ruleKey(rule);
        const floors = asArray(analysis?.messages).flatMap(message => asArray(message.trace)
            .filter(step => String(step.ruleKey ?? '') === key).map(() => message.id));
        return number(new Set(floors).size);
    }

    function ruleActivity(rule, regex) {
        if (regex?.enabled === false) return { label: '正则总开关关闭 · 当前不生效', className: 'inactive' };
        if (rule.disabled === true || rule.enabled === false) return { label: '规则已关闭 · 当前不生效', className: 'inactive' };
        if (rule.allowed === false) return { label: '未获允许 · 当前不生效', className: 'inactive' };
        if (!rule.promptOnly) return { label: '显示 / 其他位置规则 · 不处理提示词', className: 'inactive' };
        if (rule.activeForPrompt === false) return { label: rule.status || '提示词未激活 · 当前不生效', className: 'inactive' };
        if (rule.activeForPrompt === true) return { label: rule.status || '当前提示词有效', className: 'active' };
        return { label: rule.status || '已配置 · 实际作用需结合宿主策略', className: 'conditional' };
    }

    function ruleMatches(rule) {
        const query = regexSearch.trim().toLocaleLowerCase();
        if (regexSource !== 'all' && ruleSource(rule) !== regexSource && rule.source !== regexSource && rule.scriptType !== regexSource) return false;
        if (!query) return true;
        return [rule.key, rule.id, rule.name, rule.source, rule.scriptType, rule.findRegex, rule.replaceString, rule.placement]
            .some(value => String(value ?? '').toLocaleLowerCase().includes(query));
    }

    async function toggleRegexRule(rule, checkbox) {
        if (disposed || regexSaving || externalBusy || optionSaving || pendingAction || modelRequest || typeof config.onRegexToggle !== 'function') return;
        const previous = ruleEnabled(rule);
        const enabled = checkbox.checked;
        if (enabled === previous) return;
        checkbox.checked = previous;
        regexSaving = true;
        checkbox.disabled = true;
        updateAvailability();
        setStatus('正在保存规则设置并重新分析；以新的分析结果为准…');
        try {
            const result = await config.onRegexToggle(rule, enabled);
            if (disposed) return;
            if (result?.analysis) showAnalysis(result.analysis);
            const current = asArray(analysis?.regex?.rules).find(item => ruleKey(item) === ruleKey(rule));
            checkbox.checked = current ? ruleEnabled(current) : previous;
        } catch (error) {
            if (!disposed) {
                if (error.analysis) showAnalysis(error.analysis);
                const current = asArray(analysis?.regex?.rules).find(item => ruleKey(item) === ruleKey(rule));
                checkbox.checked = current ? ruleEnabled(current) : previous;
                if (error.analysis) reportError(error);
                else setStatus(`${error?.message || String(error)}\n未能刷新实际规则状态，请重新分析后核对。`, true);
            }
        } finally {
            if (!disposed) {
                regexSaving = false;
                updateAvailability();
            }
        }
    }

    function showRegexRule(key) {
        if (disposed) return;
        selectTab('settings', true);
        const target = asArray(analysis?.regex?.rules).find(rule => ruleKey(rule) === key);
        regexSearch = target?.name ?? String(key ?? '');
        regexSource = target ? ruleSource(target) : 'all';
        const search = element.querySelector('[data-regex-search]');
        const sourceSelect = element.querySelector('[data-regex-source]');
        search.value = regexSearch;
        sourceSelect.value = regexSource;
        renderRegexRules();
        const match = [...field('regex-rules').querySelectorAll('[data-rule-key]')]
            .find(item => item.dataset.ruleKey === key);
        if (match) {
            match.open = true;
            match.scrollIntoView({ block: 'nearest' });
        }
    }

    function renderRegexRules() {
        const container = field('regex-rules');
        const regex = analysis?.regex;
        container.replaceChildren();
        const rules = asArray(regex?.rules);
        field('regex-status').textContent = !analysis ? '尚未读取' : regex ? `${number(rules.length)} 条规则 · ${regex.enabled === false ? '总开关关闭' : '总开关开启'}` : '未提供规则清单';
        field('regex-scope-help').textContent = regex
            ? `规则作用范围：全局规则影响所有聊天，预设规则随预设，角色卡规则随当前角色卡。0 深度表示最新楼层；“修改楼层”只统计所选范围内实际改变内容的轨迹。开关更改的是配置，不代表当前实际生效。${regex.enabled === false ? '当前正则总开关关闭，单条规则切换不会让它立即参与提示词。' : ''}`
            : '规则作用范围会影响实际聊天：全局规则影响所有聊天，预设规则随预设，角色卡规则随当前角色卡。0 深度表示最新楼层。';
        const sourceSelect = element.querySelector('[data-regex-source]');
        const sources = [...new Set(rules.map(ruleSource))];
        const selected = regexSource;
        sourceSelect.replaceChildren(new Option('全部来源', 'all'), ...sources.map(value => new Option(value, value)));
        sourceSelect.value = sources.includes(selected) || selected === 'all' ? selected : 'all';
        regexSource = sourceSelect.value;
        const visible = rules.filter(ruleMatches);
        if (!regex) {
            container.append(node('div', 'ch-empty', analysis ? '主线程未提供正则规则清单。' : '分析后显示正则规则。'));
            return;
        }
        if (!visible.length) {
            container.append(node('div', 'ch-empty', rules.length ? '当前搜索和来源筛选没有匹配规则。' : '本次分析没有可展示的正则规则。'));
            return;
        }
        visible.forEach(rule => {
            const key = ruleKey(rule);
            const activity = ruleActivity(rule, regex);
            const details = node('details', 'ch-regex-rule');
            details.dataset.ruleKey = key;
            const summary = node('summary', 'ch-regex-summary');
            const main = node('span', 'ch-regex-main');
            const title = node('strong', '', rule.name || key || '未命名规则');
            const meta = node('small', 'ch-help', `${ruleSource(rule)} · ${rule.promptOnly ? '提示词' : '非提示词'} · ${rule.depthLabel || regexDepthLabel(rule)} · 修改楼层 ${ruleFloors(rule)}`);
            main.append(title, meta);
            const status = node('span', `ch-regex-activity ch-regex-${activity.className}`, activity.label);
            const toggle = node('input', 'ch-regex-toggle');
            toggle.type = 'checkbox';
            toggle.checked = ruleEnabled(rule);
            toggle.dataset.lock = '';
            toggle.dataset.unavailable = String(typeof config.onRegexToggle !== 'function');
            toggle.setAttribute('aria-label', `切换规则 ${rule.name || key || '未命名规则'}`);
            toggle.addEventListener('click', event => event.stopPropagation());
            toggle.addEventListener('change', () => { void toggleRegexRule(rule, toggle); });
            summary.append(main, status, toggle);
            details.append(summary);
            const body = node('div', 'ch-regex-body');
            const info = [
                `规则键：${key || '未标注'}`,
                `类型：${rule.scriptType ?? '未标注'}`,
                `配置开关：${ruleEnabled(rule) ? '开启' : '关闭'}`,
                `深度：${rule.depthLabel || regexDepthLabel(rule)}（0 为最新）`,
                `位置：${asArray(rule.placement).map(position => ({ 1: '用户', 2: '助手', 5: '世界书', 6: '独立推理' })[position] || String(position)).join('、') || '未标注'}`,
                `允许：${rule.allowed === false ? '否' : rule.allowed === true ? '是' : '未标注'}`,
                `提示词处理：${rule.promptOnly ? '是' : '否'} · Markdown 显示处理：${rule.markdownOnly ? '是' : '否'}`,
                `当前状态：${rule.status || activity.label}`,
            ];
            body.append(node('p', 'ch-help', info.join(' · ')));
            const patterns = node('details', 'ch-disclosure');
            patterns.append(node('summary', '', '查找与替换'));
            const findCode = node('div', 'ch-regex-code');
            const replaceCode = node('div', 'ch-regex-code');
            findCode.append(node('div', '', `查找：${excerpt(rule.findRegex, 2400)}`));
            replaceCode.append(node('div', '', `替换：${excerpt(rule.replaceString, 2400)}`));
            patterns.append(findCode, replaceCode);
            body.append(patterns);
            const policy = [];
            if (rule.trimStrings) policy.push(`trimStrings：${excerpt(rule.trimStrings, 400)}`);
            policy.push(rule.source === 'global' ? '修改全局规则会影响所有聊天。'
                : rule.source === 'preset' ? '修改预设规则会影响使用该预设的聊天。'
                    : rule.source === 'character' ? '修改角色卡规则会影响使用该角色卡的聊天。' : '规则作用范围未确认，请核对来源。');
            if (rule.allowed === false) policy.push('该规则未获允许，切换配置仍不会使它当前生效。');
            if (rule.disabled === true || rule.enabled === false) policy.push('该规则配置为关闭。');
            if (regex.enabled === false) policy.push('正则总开关关闭，所有规则当前都不参与提示词。');
            if (policy.length) body.append(node('p', 'ch-regex-policy', policy.join(' ')));
            details.append(body);
            container.append(details);
        });
        updateAvailability();
    }

    function renderAutomation() {
        const automation = analysis?.automation;
        const state = field('automation-state');
        const detail = field('automation-detail');
        const strip = field('automation-strip');
        const settingsStatus = field('settings-status');
        const enabled = automation?.enabled === true;
        const effective = automation?.effective === true;
        strip.classList.toggle('is-on', effective);
        strip.classList.toggle('is-paused', enabled && !effective);
        strip.classList.toggle('is-off', !enabled);
        if (!analysis || !automation) {
            state.textContent = '新回复自动规范化：等待分析';
            detail.textContent = '分析后显示当前聊天的新消息自动规范化是否生效。';
            settingsStatus.textContent = '等待分析';
        } else if (!enabled) {
            state.textContent = '新回复自动规范化：已关闭';
            detail.textContent = '历史消息仍可手动预览和修复；新助手消息不会自动规范化。';
            settingsStatus.textContent = '已关闭';
        } else if (!effective) {
            const adapter = automation.adapter || 'generic';
            state.textContent = '新回复自动规范化：已开启 · 当前暂停';
            detail.textContent = adapter === 'generic' ? '通用适配器仅观察；请在上方选择匹配的标签适配器，或使用手动修复预览。' : automation.label || '当前适配器未生效，请重新分析后核对。';
            settingsStatus.textContent = '已开启 · 当前暂停';
        } else {
            state.textContent = '新回复自动规范化：已开启 · 生效中';
            detail.textContent = `标签适配：${analysis.profile?.label || automation.adapter || '已识别适配器'}；仅处理之后收到的新助手消息。`;
            settingsStatus.textContent = '已开启 · 生效中';
        }
        field('automation-scope').textContent = `范围：${automation?.scope === 'chat' || !automation ? '当前聊天' : text(automation.scope)}`;
        field('automation-history').textContent = `历史：${automation?.historyMode === 'preview' || !automation ? '手动预览' : text(automation.historyMode)}`;
        field('automation-ai').textContent = `AI：${automation?.aiMode === 'manual' || !automation ? '手动' : text(automation.aiMode)}`;
        const last = automation?.lastNormalization;
        field('automation-last').textContent = last ? `最近${last.id != null ? ` #${last.id}` : ''}：${last.status || '已记录'}${last.at ? ` · ${last.at}` : ''}` : '';
        if (optionSaving) {
            state.textContent = '新回复自动规范化：正在保存并更新状态…';
            settingsStatus.textContent = '正在保存并重新分析';
        }
    }

    function renderDiagnosisSummary(issues) {
        const container = field('diagnosis-summary');
        container.replaceChildren();
        if (!analysis) return;
        let counts;
        try {
            counts = diagnosisSummary(issues);
        } catch {
            counts = { repair: 0, policy: 0, review: issues.length };
        }
        const items = [
            ['repair', '可处理', '本地或 AI 可生成下一步预览'],
            ['policy', '规则策略', '正则按深度裁剪或摘要，未必是修复失败'],
            ['review', '需要核对', '查看来源、证据或配置状态'],
        ];
        items.forEach(([key, label, detail]) => {
            const item = node('div', `ch-diagnosis-count ch-count-${key}`);
            item.append(node('strong', '', number(counts[key] ?? 0)), node('span', '', label), node('small', '', detail));
            container.append(item);
        });
        if (!issues.length) container.append(node('p', 'ch-help ch-diagnosis-clear', '当前分析没有诊断项。'));
    }

    function renderDiagnosis() {
        if (disposed) return;
        const issues = asArray(analysis?.issues);
        field('issue-count').textContent = number(issues.length);
        renderDiagnosisSummary(issues);
        let counts;
        try {
            counts = diagnosisSummary(issues);
        } catch {
            counts = { repair: 0, policy: 0, review: issues.length };
        }
        field('boundary-guidance').hidden = !analysis || counts.repair === 0;
        element.querySelectorAll('[data-filter]').forEach(button => {
            const severity = button.dataset.filter;
            const count = severity === 'all' ? issues.length : issues.filter(issue => issuePresentation(issue).severity === severity).length;
            button.textContent = `${severity === 'all' ? '全部' : severityNames[severity]} ${count}`;
            button.setAttribute('aria-pressed', String(severity === issueFilter));
        });
        renderIssues(field('issues'), issues.filter(issue => issueFilter === 'all' || issuePresentation(issue).severity === issueFilter), true, true);
        const facts = field('facts');
        facts.replaceChildren();
        if (!analysis) return;
        const tables = asArray(analysis.tables);
        const withBlocks = asArray(analysis.messages).filter(message => asArray(message.blocks).length);
        facts.append(node('p', 'ch-help', `${tables.length} 张表 · ${tables.reduce((sum, table) => sum + asArray(table.rows).length, 0)} 行 · ${withBlocks.length} 条消息含解析块。是否包含 MVU 更新以解析结果为准。`));
        facts.append(node('p', 'ch-help', `思维标签：${asArray(analysis.profile?.reasoningTags).join(' / ') || '未提供'}；正文标签：${asArray(analysis.profile?.bodyTags).join(' / ') || '未提供'}`));
        if (analysis.profile?.reasoningCommentMarker) facts.append(node('p', 'ch-help',
            `原生预检格式：<!-- ${analysis.profile.reasoningCommentMarker} … -->；完整注释原样保留。上方思维标签用于兼容旧版 XML 输出。`));
        for (const table of tables) {
            const details = node('details', 'ch-disclosure');
            details.append(node('summary', '', `${table.name || '未命名表格'} · ${asArray(table.rows).length} 行`),
                node('pre', 'ch-fulltext', text({ uid: table.uid, headers: table.headers, rows: table.rows })));
            facts.append(details);
        }
        for (const message of withBlocks) {
            const details = node('details', 'ch-disclosure');
            details.append(node('summary', '', `消息 #${message.id} · 标签与变量块`), node('pre', 'ch-fulltext', text(message.blocks)));
            facts.append(details);
        }
    }

    function showAnalysis(next) {
        if (disposed) return;
        analysis = next || null;
        if (analysis?.automation?.enabled !== undefined) {
            control('normalizeIncoming').checked = Boolean(analysis.automation.enabled);
            savedOptions.normalizeIncoming = Boolean(analysis.automation.enabled);
        }
        if (analysis?.monitorSettings) {
            const monitor = monitorSettings(analysis.monitorSettings);
            control('showMonitor').checked = monitor.showMonitor;
            control('tokenWarningPercent').value = monitor.tokenWarningPercent;
            Object.assign(savedOptions, monitor);
        }
        renderTokenUsage(field('token-summary'), analysis?.tokens);
        showPlan(null);
        renderAutomation();
        renderRegexRules();
        const captured = analysis?.prompt?.kind === 'captured';
        field('capture-kind').textContent = analysis ? captured ? '提示词事件 · 已捕获' : '正则模拟 · 非完整请求' : '等待分析';
        field('capture-kind').classList.toggle('is-captured', captured);
        element.querySelector('[data-source="prompt"]').textContent = captured ? '捕获的提示词' : '提示词模拟';
        for (const [name, value] of [['raw', 'rawCharacters'], ['projected', 'promptCharacters'], ['removed', 'removedCharacters'], ['hidden', 'hiddenMessages']]) {
            field(name).textContent = number(analysis?.stats?.[value]);
        }
        field('profile').textContent = analysis?.profile?.label || '尚未识别预设';
        const scope = analysis?.scope;
        field('scope').textContent = scope ? `分析消息 #${scope.start}–#${scope.end} / 共 ${number(scope.total)} 条；编号从 0 开始。` : '消息编号从 0 开始；留空表示全部范围。';
        const provenance = field('provenance');
        provenance.classList.toggle('is-captured', captured);
        provenance.replaceChildren(node('strong', '', !analysis ? '先查看，再处理' : captured ? '已捕获提示词事件快照' : '当前显示本地正则模拟'));
        provenance.append(node('p', '', !analysis ? '分析当前聊天，查看提示词事件快照或本地正则模拟。两种结果会分别标注。' : captured ? '来自原生提示词事件；这是该事件阶段的快照，后续扩展或后端仍可能修改内容。'
            : '仅模拟所选聊天消息的正则处理；不完整复现世界书激活、宏、预算裁剪、插件注入或最终请求。'));
        const prompt = analysis?.prompt;
        if (prompt?.note) provenance.append(node('p', 'ch-help', text(prompt.note)));
        const metadata = [prompt?.stage ? `事件：${prompt.stage}` : '', prompt?.capturedAt ? `捕获时间：${prompt.capturedAt}` : '', prompt?.model ? `模型：${prompt.model}` : ''].filter(Boolean);
        if (metadata.length) provenance.append(node('small', 'ch-capture-meta', metadata.join(' · ')));
        const pipeline = asArray(prompt?.pipeline);
        const steps = pipeline.length ? pipeline : [
            { name: '预设', detail: '系统指令与格式 · 来源未确认' }, { name: '角色卡 / 世界书', detail: '原生模板与激活条目 · 来源未确认' },
            { name: '聊天历史', detail: '所选消息范围' }, { name: '正则', detail: '本地发送处理模拟' },
            { name: '插件注入', detail: '未确认具体注入内容' }, { name: '请求事件', detail: captured ? '已捕获事件阶段快照' : '尚无捕获快照' },
        ];
        field('pipeline').replaceChildren(...steps.map((step, index) => {
            const item = node('li', '');
            item.append(node('span', 'ch-step-number', String(index + 1).padStart(2, '0')), node('strong', '', text(step.name)), node('small', '', step.detail ? text(step.detail) : '未提供细节'));
            return item;
        }));
        field('footer-note').textContent = `字符数不等同于 token · 上下文上限 ${number(analysis?.stats?.contextLimit)} · 输出预算 ${number(analysis?.stats?.maxOutputTokens)} token`;
        if (!messageRows().length && asArray(analysis?.messages).length) source = 'history';
        renderSources();
        renderCardProtocol();
        renderMessages();
        renderDiagnosis();
        updateAvailability();
    }

    function setConnections(connections) {
        if (disposed) return;
        const select = control('connectionId');
        const selected = select.value || 'current';
        const entries = asArray(connections);
        select.replaceChildren();
        if (!entries.some(connection => String(connection.id) === 'current')) select.append(new Option('当前酒馆连接', 'current'));
        entries.forEach((connection, index) => {
            if (connection.id == null) return;
            const option = new Option(connection.name || connection.label || `连接 ${index + 1}`, String(connection.id));
            option.disabled = connection.available === false || connection.disabled === true;
            select.append(option);
        });
        if (![...select.options].some(option => option.value === selected)) {
            const missing = new Option('已保存的连接不可用，请重新选择', selected);
            missing.disabled = true;
            select.append(missing);
        }
        select.value = selected;
        updateAvailability();
    }

    function setModels(models) {
        if (disposed) return;
        field('models').replaceChildren(...asArray(models).map(model => {
            const value = typeof model === 'string' ? model : model?.id || model?.name;
            return value ? new Option(String(value), String(value)) : null;
        }).filter(Boolean));
    }

    async function refreshModels() {
        if (disposed || action('models').disabled) return;
        const request = modelRequest = new AbortController();
        const revision = ++modelRevision;
        const connection = control('connectionId').value;
        updateAvailability();
        setStatus('正在读取所选连接的模型列表…');
        try {
            const models = await config.onModels(connection, true, request.signal);
            if (disposed || request.signal.aborted || revision !== modelRevision || connection !== control('connectionId').value) return;
            setModels(models);
            setStatus('模型列表已更新，也可以直接填写模型名称。');
        } catch (error) {
            if (!disposed && !request.signal.aborted && revision === modelRevision) reportError(error);
        } finally {
            if (!disposed) {
                if (modelRequest === request) modelRequest = null;
                updateAvailability();
            }
        }
    }

    function invalidateOptions(event) {
        if (disposed || !event.target.matches('[name]')) return;
        const hadPlan = Boolean(plan);
        showPlan(null);
        if (hadPlan) setStatus('设置已变更，请重新生成修复预览。');
    }

    async function changed(event) {
        if (disposed || optionSaving || !event.target.matches('[name]')) return;
        invalidateOptions(event);
        if (event.target === control('connectionId')) {
            modelRequest?.abort();
            modelRevision++;
            control('model').value = '';
            setModels([]);
        }
        const revision = ++optionRevision;
        optionSaving = true;
        updateAvailability();
        renderAutomation();
        try {
            const next = getOptions();
            if (typeof config.onOptionsChange === 'function') {
                setStatus('正在保存设置…');
                const result = await config.onOptionsChange({ ...next });
                if (!disposed && revision === optionRevision) {
                    if (result?.analysis) showAnalysis(result.analysis);
                    setStatus('设置已保存；自动化状态以最新分析结果为准。');
                }
            }
            if (!disposed && revision === optionRevision) savedOptions = { ...next };
        } catch (error) {
            if (!disposed && revision === optionRevision) {
                if (error.analysis) {
                    showAnalysis(error.analysis);
                    const actualAdapter = error.analysis.automation?.configuredAdapter;
                    if (actualAdapter && [...control('adapter').options].some(option => option.value === actualAdapter)) {
                        control('adapter').value = actualAdapter;
                        savedOptions.adapter = actualAdapter;
                    }
                } else {
                    control('adapter').value = savedOptions.adapter || 'auto';
                    control('normalizeIncoming').checked = Boolean(savedOptions.normalizeIncoming);
                    control('showMonitor').checked = Boolean(savedOptions.showMonitor);
                    control('tokenWarningPercent').value = savedOptions.tokenWarningPercent;
                }
                if (error.monitorSettings) {
                    const actual = monitorSettings(error.monitorSettings);
                    control('showMonitor').checked = actual.showMonitor;
                    control('tokenWarningPercent').value = actual.tokenWarningPercent;
                    Object.assign(savedOptions, actual);
                }
                reportError(error);
            }
        } finally {
            if (!disposed && revision === optionRevision) {
                optionSaving = false;
                renderAutomation();
                updateAvailability();
            }
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        optionRevision++;
        modelRevision++;
        modelRequest?.abort();
        modelRequest = null;
        optionSaving = false;
        regexSaving = false;
        pendingAction = null;
        externalBusy = false;
        updateAvailability();
    }

    element.addEventListener('input', event => {
        if (event.target.matches('input:not([type="checkbox"]), textarea')) invalidateOptions(event);
    });
    element.addEventListener('change', event => {
        if (event.target.matches('select, input, textarea')) void changed(event);
    });
    tabs.forEach(tab => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
    element.querySelector('.ch-tabs').addEventListener('keydown', event => {
        const index = tabs.indexOf(document.activeElement);
        if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        selectTab(tabs[next].dataset.tab, true);
    });
    field('messages').addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !messageRows().length) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? messageRows().length - 1 : Math.min(messageRows().length - 1, Math.max(0, selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)));
        selectMessage(next);
        field('messages').querySelector(`[data-message-index="${next}"]`)?.focus();
    });
    element.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => {
        source = button.dataset.source;
        selectedIndex = 0;
        renderMessages();
    }));
    element.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
        issueFilter = button.dataset.filter;
        renderDiagnosis();
    }));
    for (const [name, callback] of [['inspect', config.onInspect], ['normalize', config.onNormalize], ['ai', config.onAiRepair], ['apply', config.onApply], ['undo', config.onUndo], ['export', config.onExport]]) {
        action(name).addEventListener('click', () => { void runAction(name, callback); });
    }
    action('models').addEventListener('click', () => { void refreshModels(); });
    action('go-settings').addEventListener('click', () => selectTab('settings', true));
    action('review-ai').addEventListener('click', () => {
        selectTab('repair', true);
        if (!action('ai').disabled) action('ai').focus();
    });
    action('cancel').addEventListener('click', async () => {
        if (disposed) return;
        try {
            if (modelRequest) {
                modelRequest.abort();
                modelRequest = null;
                modelRevision++;
                setStatus('已停止读取模型列表。');
                updateAvailability();
            } else if (typeof config.onCancel === 'function') {
                await config.onCancel();
                setStatus('已请求停止操作，等待当前任务结束。');
            }
        } catch (error) {
            reportError(error);
        }
    });
    const regexSearchControl = element.querySelector('[data-regex-search]');
    const regexSourceControl = element.querySelector('[data-regex-source]');
    regexSearchControl.addEventListener('input', () => {
        regexSearch = regexSearchControl.value;
        renderRegexRules();
    });
    regexSourceControl.addEventListener('change', () => {
        regexSource = regexSourceControl.value;
        renderRegexRules();
    });
    showAnalysis(null);

    return {
        element, getOptions, setBusy, showAnalysis, showPlan, showRegexRule, setStatus, setConnections, setModels, dispose, selectTab,
        setBackupAvailable(available) {
            if (disposed) return;
            backupAvailable = Boolean(available);
            action('undo').title = backupAvailable ? '恢复上次修复前的数据' : '当前聊天没有可撤销的修复备份';
            updateAvailability();
        },
    };
}
