import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorController, monitorDiagnosis, monitorSettings } from '../src/monitor.js';

test('monitor visibility is opt-in for new and existing installations', () => {
    assert.deepEqual(monitorSettings(), { showMonitor: false, tokenWarningPercent: 85 });
    assert.equal(monitorSettings({ normalizeIncoming: true }).showMonitor, false);
    assert.equal(monitorSettings({ showMonitor: 'true' }).showMonitor, false);
    assert.deepEqual(monitorSettings({ showMonitor: true, tokenWarningPercent: 90 }),
        { showMonitor: true, tokenWarningPercent: 90 });
    for (const tokenWarningPercent of [null, '', 0, 101, NaN, Infinity, 20.5]) {
        assert.equal(monitorSettings({ tokenWarningPercent }).tokenWarningPercent, 85);
    }
});

test('expected trim policies and informational diagnostics do not raise monitor alarms', () => {
    const policy = { code: 'history-trim-policy', severity: 'error', category: 'policy' };
    const result = monitorDiagnosis([policy, { code: 'unknown-preset', severity: 'info' }]);
    assert.equal(result.errors, 0);
    assert.equal(result.warnings, 0);
    assert.equal(result.policies, 1);
    assert.equal(result.first, null);
    const broken = monitorDiagnosis([{ code: 'narrative-loss', severity: 'error', messageId: 150 },
        { code: 'unclosed-reasoning', severity: 'warning', messageId: 151 }]);
    assert.equal(broken.errors, 1);
    assert.equal(broken.warnings, 1);
    assert.equal(broken.first.messageId, 150);
});

function fixture(enabled = false) {
    let options = { showMonitor: enabled }, listener, reads = 0;
    const tasks = new Map(), states = [], pending = [];
    let taskId = 0;
    const controller = createMonitorController({
        readSettings: () => options,
        read: () => { reads++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
        subscribe: callback => { listener = callback; return () => { listener = null; }; },
        render: value => states.push(value),
        schedule: callback => { tasks.set(++taskId, callback); return taskId; },
        cancel: id => tasks.delete(id),
    });
    return {
        controller, states, pending, tasks,
        get reads() { return reads; },
        get listener() { return listener; },
        setOptions(value) { options = value; listener?.(); },
        emit() { listener?.(); },
        async run() {
            const next = tasks.entries().next().value;
            if (next) { tasks.delete(next[0]); await next[1](); }
        },
    };
}

test('a hidden monitor does no inspection and coalesces bursts when enabled', async () => {
    const f = fixture();
    f.emit();
    assert.equal(f.reads, 0);
    assert.equal(f.tasks.size, 0);
    assert.deepEqual(f.states.at(-1), { enabled: false });
    f.setOptions({ showMonitor: true });
    f.emit(); f.emit();
    assert.equal(f.tasks.size, 1);
    const work = f.run();
    f.pending[0].resolve({ active: true, analysis: { issues: [] } });
    await work;
    assert.equal(f.reads, 1);
    assert.equal(f.states.at(-1).pending, false);
    f.controller.dispose();
    assert.equal(f.listener, null);
});

test('switching chats drops stale async results and schedules exactly one fresh read', async () => {
    const f = fixture(true);
    const old = f.run();
    f.emit(); f.emit();
    f.pending[0].resolve({ owner: 'old-chat', analysis: { issues: ['old'] } });
    await old;
    assert.equal(f.states.some(state => state.owner === 'old-chat'), false);
    assert.equal(f.tasks.size, 1);
    const fresh = f.run();
    f.pending[1].resolve({ owner: 'new-chat' });
    await fresh;
    assert.equal(f.states.at(-1).owner, 'new-chat');
    f.controller.dispose();
});

test('disabling or disposing during inspection cannot reopen the monitor', async () => {
    for (const dispose of [false, true]) {
        const f = fixture(true), work = f.run();
        if (dispose) f.controller.dispose();
        else f.setOptions({ showMonitor: false });
        f.pending[0].resolve({ owner: 'late' });
        await work;
        assert.equal(f.states.at(-1).enabled, false);
        assert.equal(f.tasks.size, 0);
        f.controller.dispose();
    }
});

test('read failures are bounded and are retried only after another event or user refresh', async () => {
    const f = fixture(true), work = f.run();
    f.pending[0].reject(new Error('private provider payload'));
    await work;
    assert.ok(f.states.at(-1).error.includes('重试'));
    assert.equal(JSON.stringify(f.states).includes('private'), false);
    assert.equal(f.tasks.size, 0);
    f.controller.refresh();
    assert.equal(f.tasks.size, 1);
    f.controller.dispose();
});

test('a long native save is rechecked after completion even without another event', async () => {
    const f = fixture(true), busy = f.run();
    f.pending[0].resolve({ active: true, diagnosisPending: true });
    await busy;
    assert.equal(f.tasks.size, 1);
    const idle = f.run();
    f.pending[1].resolve({ active: true, analysis: { issues: [{ code: 'narrative-loss', severity: 'error' }] } });
    await idle;
    assert.equal(f.tasks.size, 0);
    assert.equal(f.states.at(-1).analysis.issues[0].code, 'narrative-loss');
    f.controller.dispose();
});
