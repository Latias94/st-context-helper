import { presentIssue } from './diagnostics.js';

export const MONITOR_DEFAULTS = Object.freeze({ showMonitor: false, tokenWarningPercent: 85 });
export const MONITOR_RECENT_MESSAGES = 12;

export function monitorSettings(settings = {}) {
    settings ??= {};
    const percent = settings.tokenWarningPercent;
    return {
        showMonitor: settings.showMonitor === true,
        tokenWarningPercent: Number.isInteger(percent) && percent >= 1 && percent <= 100
            ? percent : MONITOR_DEFAULTS.tokenWarningPercent,
    };
}

export function monitorDiagnosis(issues = []) {
    const presented = issues.map(presentIssue);
    const actionable = presented
        .filter(issue => issue.category !== 'policy' && ['error', 'warning'].includes(issue.severity));
    return {
        errors: actionable.filter(issue => issue.severity === 'error').length,
        warnings: actionable.filter(issue => issue.severity === 'warning').length,
        policies: presented.filter(issue => issue.category === 'policy').length,
        first: actionable.find(issue => issue.severity === 'error') ?? actionable[0] ?? null,
    };
}

/**
 * Coalesces native events without blocking generation or inspecting streamed fragments.
 * A revision invalidates results immediately, including while the next read is debounced.
 */
export function createMonitorController({ readSettings, read, subscribe, render,
    schedule = (callback, delay = 350) => setTimeout(callback, delay), cancel = clearTimeout }) {
    let revision = 0, timer = null, running = false, disposed = false;
    let state = { enabled: false };

    const publish = value => { state = value; render(value); };
    const settings = () => monitorSettings(readSettings());

    async function refresh() {
        timer = null;
        if (disposed || running || !settings().showMonitor) return;
        running = true;
        const current = revision;
        let retry = false;
        try {
            const result = await read();
            if (!disposed && current === revision && settings().showMonitor) {
                publish({ enabled: true, ...result, checkedAt: new Date().toISOString(), pending: false });
                retry = result.diagnosisPending === true;
            }
        } catch {
            if (!disposed && current === revision && settings().showMonitor) {
                // Never put native error bodies (which can include prompt data) in the floating UI.
                publish({ enabled: true, error: '监测暂不可用，请点击重试或打开助手重新分析。', pending: false });
            }
        } finally {
            running = false;
            if (!disposed && settings().showMonitor && timer === null && (current !== revision || retry)) {
                timer = schedule(refresh, current !== revision ? 350 : 1000);
            }
        }
    }

    function invalidate() {
        if (disposed) return;
        revision++;
        if (timer !== null) { cancel(timer); timer = null; }
        if (!settings().showMonitor) {
            publish({ enabled: false });
            return;
        }
        // Old issues and counts must not appear to belong to a newly selected conversation.
        publish({ enabled: true, pending: true });
        if (!running) timer = schedule(refresh);
    }

    const unsubscribe = subscribe(invalidate);
    invalidate();
    return {
        refresh: invalidate,
        getState: () => state,
        dispose() {
            if (disposed) return;
            disposed = true;
            revision++;
            if (timer !== null) cancel(timer);
            unsubscribe?.();
            publish({ enabled: false });
        },
    };
}
