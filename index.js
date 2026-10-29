import { createHost, getContext } from './src/host.js';
import { createContextHelperView } from './src/ui.js';
import { buildLocalPlan, buildRepairMessages, DEFAULT_REPAIR_PROMPT, parseRepairResponse } from './src/repair.js';
import { repairOutcome } from './src/diagnostics.js';
import { getRepairConnections, getRepairModels, refreshRepairModels, requestContextRepair } from './src/api.js';
import { createMonitorController } from './src/monitor.js';
import { createFloatingMonitor } from './src/floating.js';

let hostPromise, dialogOpen = false, activeView;

async function initializeHost() {
    const host = await createHost();
    const floating = createFloatingMonitor({
        onOpen: tab => openContextHelper({ tab }),
        onHide: async () => {
            try { await host.saveMonitorOptions({ ...host.getMonitorSettings(), showMonitor: false }); }
            catch (error) { globalThis.toastr?.error(error.message, 'Context Helper'); }
        },
        onRefresh: () => monitor.refresh(),
    });
    const monitor = createMonitorController({
        readSettings: host.getMonitorSettings, read: host.inspectMonitor, subscribe: host.subscribe,
        render: floating.update,
    });
    return host;
}

function exportReport(report) {
    if (!report) return;
    const file = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file), link = document.createElement('a');
    link.href = url;
    link.download = `context-report-${new Date().toISOString().replaceAll(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function openContextHelper({ tab = 'inspector' } = {}) {
    if (dialogOpen) { activeView?.selectTab(tab, true); return; }
    dialogOpen = true;
    let controller, view;
    try {
        let host = await (hostPromise ??= initializeHost());
        if (!host) host = await (hostPromise = initializeHost());
        const context = getContext(), preferences = context.extensionSettings.context_helper ?? {};
        const options = { start: Math.max(0, context.chat.length - 12), end: context.chat.length - 1,
            adapter: 'auto', connectionId: 'current', model: '', maxTokens: 8192, prompt: DEFAULT_REPAIR_PROMPT,
            ...preferences, ...context.chatMetadata.context_helper, ...host.getMonitorSettings() };
        let current, pending;
        const inspect = async () => {
            const context = getContext();
            if (!context.chatId || !context.chat.length) {
                current = pending = null;
                view.showAnalysis(null);
                view.setStatus('请先打开已保存的聊天以分析上下文；现在仍可配置浮窗和其他全局设置。');
                return null;
            }
            current = await host.inspect(view.getOptions());
            pending = null;
            view.showAnalysis(current.analysis);
            view.showPlan(null);
            view.setBackupAvailable(host.hasBackup());
            return current;
        };
        const run = callback => async (...args) => {
            view.setBusy(true);
            try { await callback(...args); }
            catch (error) { view.setStatus(error.name === 'AbortError' ? '已取消，未应用修复。' : error.message, true); }
            finally { view.setBusy(false); view.setBackupAvailable(host.hasBackup()); }
        };
        view = createContextHelperView({
            options,
            onInspect: run(async () => { if (await inspect()) view.setStatus('分析完成。发送预处理模拟与捕获的提示词会分别标注。'); }),
            onNormalize: run(async () => {
                await inspect();
                pending = buildLocalPlan(current.snapshot, view.getOptions());
                view.showPlan(pending);
                view.setStatus(pending.changes.length ? '已生成本地修复预览；尚未修改会话。' : '没有可确定的本地修复。');
            }),
            onAiRepair: run(async () => {
                await inspect();
                controller = new AbortController();
                try {
                    const text = await requestContextRepair(
                        buildRepairMessages(current.snapshot, current.analysis, view.getOptions()),
                        view.getOptions(), controller.signal,
                    );
                    controller.signal.throwIfAborted();
                    pending = parseRepairResponse(text, current.snapshot, view.getOptions());
                    view.showPlan(pending);
                    view.setStatus('AI 建议已生成。请检查差异，再应用到当前会话。');
                } finally { controller = null; }
            }),
            onApply: run(async () => {
                if (!pending?.changes.length) throw new Error('请先生成并检查修复预览。');
                await host.apply(current.snapshot, pending);
                await inspect();
                view.setStatus(`修复已保存并通过服务器读回校验，可撤销本次修复。${repairOutcome(current.analysis.issues)}`);
            }),
            onUndo: run(async () => { await host.undo(); await inspect(); view.setStatus('已恢复修复前的数据。'); }),
            onRegexToggle: async (rule, enabled) => {
                view.setBusy(true);
                try {
                    await host.toggleRegex(rule, enabled);
                    await inspect();
                    view.setStatus(`已保存并核对${enabled ? '开启' : '关闭'}正则“${rule.name || '未命名规则'}”，诊断已更新。`);
                    return { analysis: current.analysis };
                } catch (error) {
                    try { await inspect(); error.analysis = current.analysis; } catch { /* Keep the original save error. */ }
                    throw error;
                } finally { view.setBusy(false); view.setBackupAvailable(host.hasBackup()); }
            },
            onExport: () => exportReport(current?.analysis),
            onOptionsChange: async value => {
                try {
                    await host.saveOptions(value);
                    await inspect();
                    return { analysis: current?.analysis };
                } catch (error) {
                    error.monitorSettings = host.getMonitorSettings();
                    try { await inspect(); error.analysis = current?.analysis; } catch { /* Preserve the settings error. */ }
                    throw error;
                }
            },
            onModels: async (id, refresh, signal) => refresh ? refreshRepairModels(id, signal) : getRepairModels(id),
            onCancel: () => controller?.abort(),
        });
        activeView = view;
        view.selectTab(tab);
        const { Popup, POPUP_TYPE } = host.native.popup;
        const popup = new Popup(view.element, POPUP_TYPE.TEXT, '', {
            wide: true, large: true, allowVerticalScrolling: true, okButton: '关闭',
            onClose: () => { controller?.abort(); view.dispose?.(); },
        });
        const shown = popup.show();
        await run(async () => {
            await inspect();
            try { view.setConnections(await getRepairConnections()); }
            catch (error) { view.setStatus(`本地分析可用；API 配置读取失败：${error.message}`, true); }
        })();
        await shown;
    } catch (error) {
        globalThis.toastr?.error(error.message, 'Context Helper');
    } finally {
        controller?.abort();
        view?.dispose?.();
        activeView = null;
        dialogOpen = false;
    }
}

function installButton() {
    if (document.getElementById('context-helper-launcher')) return;
    const parent = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!parent) return;
    const panel = document.createElement('div');
    panel.className = 'context-helper-launcher inline-drawer';
    const button = document.createElement('button');
    button.id = 'context-helper-launcher';
    button.type = 'button';
    button.className = 'menu_button menu_button_icon';
    button.innerHTML = '<i class="fa-solid fa-magnifying-glass-chart"></i><span>上下文助手</span>';
    button.addEventListener('click', () => openContextHelper());
    const note = document.createElement('small');
    note.textContent = '查看发送上下文、诊断标签和记忆、预览并修复会话。';
    panel.append(button, note);
    parent.append(panel);
}

if (globalThis.SillyTavern?.getContext) {
    installButton();
    const context = getContext();
    if (context.eventTypes.APP_READY) context.eventSource.on(context.eventTypes.APP_READY, installButton);
    // Capture the next native request even if the inspector has never been opened.
    hostPromise = initializeHost().catch(error => {
        console.warn('[Context Helper] Initialization failed:', error.message);
        hostPromise = null;
        return null;
    });
}
