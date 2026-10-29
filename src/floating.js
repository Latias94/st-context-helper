import { monitorDiagnosis } from './monitor.js';
import { renderTokenUsage } from './token-view.js';

const make = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
};

export function createFloatingMonitor({ onOpen, onHide, onRefresh }) {
    const element = make('aside', 'context-helper ch-floating');
    element.id = 'context-helper-monitor';
    element.hidden = true;
    element.setAttribute('aria-label', '上下文监测浮窗');
    // All changing values below are rendered as text.
    element.innerHTML = `
        <header class="ch-float-header">
            <span class="ch-float-grip" title="拖动浮窗" aria-hidden="true"><i class="fa-solid fa-grip-vertical"></i></span>
            <button type="button" class="ch-float-title" data-float="open">上下文监测<span data-float="badge">等待检查</span></button>
            <button type="button" class="ch-float-icon" data-float="settings" aria-label="打开监测设置" title="监测设置"><i class="fa-solid fa-sliders" aria-hidden="true"></i></button>
            <button type="button" class="ch-float-icon" data-float="collapse" aria-label="收起浮窗" title="收起" aria-expanded="true"><i class="fa-solid fa-minus" aria-hidden="true"></i></button>
            <button type="button" class="ch-float-icon" data-float="hide" aria-label="隐藏浮窗，可在设置中重新开启" title="隐藏，可在设置中重新开启"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </header>
        <div class="ch-float-body" data-float="body">
            <button type="button" class="ch-float-diagnosis" data-float="diagnosis"><strong data-float="health">等待检查</strong><span data-float="detail"></span></button>
            <button type="button" class="ch-float-tokens" data-float="tokens" aria-label="打开完整提示词用量详情"></button>
            <p class="ch-float-automation" data-float="automation"></p>
            <footer class="ch-float-footer"><span data-float="scope"></span><button type="button" class="ch-text-button" data-float="refresh" title="重新检查上下文">刷新</button></footer>
        </div>`;
    document.body.append(element);
    const field = name => element.querySelector(`[data-float="${name}"]`);
    let collapsed = false, disposed = false, position = null, drag = null, hidePending = false;
    const bodyId = `${element.id}-body`;
    field('body').id = bodyId;
    field('collapse').setAttribute('aria-controls', bodyId);
    field('open').addEventListener('click', () => onOpen('diagnosis'));
    field('settings').addEventListener('click', () => onOpen('settings'));
    field('diagnosis').addEventListener('click', () => onOpen('diagnosis'));
    field('tokens').addEventListener('click', () => onOpen('inspector'));
    field('refresh').addEventListener('click', () => onRefresh());
    field('hide').addEventListener('click', async () => {
        if (hidePending) return;
        hidePending = true;
        field('hide').disabled = true;
        try { await onHide(); }
        finally { hidePending = false; if (!disposed) field('hide').disabled = false; }
    });
    field('collapse').addEventListener('click', () => {
        collapsed = !collapsed;
        field('body').hidden = collapsed;
        field('collapse').setAttribute('aria-expanded', String(!collapsed));
        field('collapse').setAttribute('aria-label', collapsed ? '展开浮窗' : '收起浮窗');
        field('collapse').title = collapsed ? '展开' : '收起';
        field('collapse').querySelector('i').className = `fa-solid fa-${collapsed ? 'plus' : 'minus'}`;
        clamp();
    });

    function viewport() {
        const visual = window.visualViewport;
        return { x: visual?.offsetLeft ?? 0, y: visual?.offsetTop ?? 0,
            width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight };
    }

    function clamp() {
        if (element.hidden || disposed) return;
        const view = viewport(), rect = element.getBoundingClientRect();
        const next = position ?? { x: view.x + view.width - rect.width - 16,
            y: view.y + view.height - rect.height - 100 };
        position = {
            x: Math.max(view.x + 8, Math.min(next.x, view.x + view.width - rect.width - 8)),
            y: Math.max(view.y + 8, Math.min(next.y, view.y + view.height - rect.height - 8)),
        };
        element.style.left = `${position.x}px`;
        element.style.top = `${position.y}px`;
    }

    const grip = element.querySelector('.ch-float-grip');
    grip.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        const rect = element.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
        grip.setPointerCapture(event.pointerId);
        element.classList.add('is-dragging');
        event.preventDefault();
    });
    grip.addEventListener('pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        position = { x: event.clientX - drag.x, y: event.clientY - drag.y };
        clamp();
    });
    const finishDrag = () => { drag = null; element.classList.remove('is-dragging'); };
    grip.addEventListener('lostpointercapture', finishDrag);
    grip.addEventListener('pointerup', finishDrag);
    grip.addEventListener('pointercancel', finishDrag);
    window.addEventListener('resize', clamp);
    window.visualViewport?.addEventListener('resize', clamp);
    window.visualViewport?.addEventListener('scroll', clamp);

    function update(state) {
        if (disposed) return;
        element.hidden = !state.enabled;
        if (element.hidden) return;
        const analysis = state.analysis;
        const diagnosis = monitorDiagnosis(analysis?.issues);
        const tokens = state.tokens ?? analysis?.tokens;
        const alarms = diagnosis.errors + diagnosis.warnings;
        const tone = state.error || diagnosis.errors || tokens?.utilizationPercent >= 100 ? 'error'
            : diagnosis.warnings || tokens?.thresholdReached ? 'warning' : analysis ? 'ok' : 'pending';
        element.dataset.tone = tone;
        field('badge').textContent = state.error ? '检查失败' : alarms ? `${alarms} 项待处理`
            : tokens?.thresholdReached ? 'Token 提醒' : state.pending ? '更新中' : state.diagnosisPending ? '生成 / 编辑中'
                : state.active === false ? '未打开聊天' : '未发现异常';
        field('health').textContent = state.error ? '监测暂不可用'
            : state.pending ? '正在更新上下文'
                : state.active === false ? '打开聊天后开始监测'
                    : state.diagnosisPending ? '等待完整消息'
                        : alarms ? `${diagnosis.errors} 项错误 · ${diagnosis.warnings} 项警告` : '最近消息未发现异常';
        field('detail').textContent = state.error ?? (state.pending ? '正在读取当前聊天和配置。'
            : state.active === false ? '可在助手设置中管理浮窗。'
                : state.diagnosisPending ? '生成、保存或编辑结束后检查标签，避免半截内容误报。'
                    : diagnosis.first ? `${diagnosis.first.messageId != null ? `#${diagnosis.first.messageId} · ` : ''}${diagnosis.first.title || diagnosis.first.code}；点击查看下一步。`
                        : diagnosis.policies ? `${diagnosis.policies} 项正则裁剪 / 摘要策略，点击可核对。` : '点击查看诊断与处理建议。');
        renderTokenUsage(field('tokens'), tokens);
        field('tokens').hidden = state.pending || state.active === false || Boolean(state.error);
        field('automation').textContent = analysis?.automation
            ? `自动规范化：${analysis.automation.effective ? '开启' : analysis.automation.enabled ? '暂停' : '关闭'} · AI / 历史修复：手动`
            : '';
        field('scope').textContent = analysis?.scope
            ? `#${analysis.scope.start}–#${analysis.scope.end} · ${new Date(state.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : '最近 12 条 · 当前表格';
        clamp();
    }

    return {
        element, update,
        dispose() {
            if (disposed) return;
            disposed = true;
            window.removeEventListener('resize', clamp);
            window.visualViewport?.removeEventListener('resize', clamp);
            window.visualViewport?.removeEventListener('scroll', clamp);
            element.remove();
        },
    };
}
