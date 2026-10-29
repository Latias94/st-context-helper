const reasons = {
    'unsupported-capture': '尚未捕获可计数的完整文本请求，或请求包含工具 / 结构化输出。',
    'unsupported-messages': '请求包含图片、工具调用或其他暂不支持的输入，完整用量未知。',
    'counter-unavailable': '当前连接没有可验证的本地分词器，完整用量未知。',
    'token-count-failed': '本地分词未完成；可点击刷新重试。',
    'token-encoding-failed': '本地分词未完成；可点击刷新重试。',
    'unsupported-tokenizer': '当前模型没有可识别的本地分词器，完整用量未知。',
    'unverified-token-count': '分词结果无法核实，暂不据此提醒。',
    'invalid-context-limit': '当前请求的上下文上限未知，请核对连接配置。',
    'invalid-output-reserve': '输出预留无效或超过上下文上限，请核对连接配置。',
    'configuration-changed': '连接或模型已变化，等待下一次请求以更新完整用量。',
};

const part = (className, text) => {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
};
const count = value => value.toLocaleString();

export function renderTokenUsage(container, usage) {
    container.replaceChildren();
    container.removeAttribute('title');
    const available = usage?.status === 'available';
    container.dataset.tokenState = !available ? 'unknown'
        : usage.utilizationPercent >= 100 ? 'error' : usage.thresholdReached ? 'warning' : 'ok';
    container.append(part('ch-token-label', '上次请求 · 完整输入与输出预留'));
    if (!available) {
        container.append(part('ch-token-value', 'Token 用量未知'),
            part('ch-token-note', reasons[usage?.reason] ?? '正常发送后捕获完整提示词，再估算用量。'));
        return;
    }
    container.append(part('ch-token-value',
        `${usage.utilizationPercent.toFixed(1)}%${usage.thresholdReached ? ` · 达到 ${usage.thresholdPercent}% 提醒线` : ''}`));
    const meter = part('ch-token-meter', '');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', '完整上下文占用率');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', '100');
    meter.setAttribute('aria-valuenow', String(Math.min(100, usage.utilizationPercent)));
    meter.setAttribute('aria-valuetext', `${usage.utilizationPercent.toFixed(1)}%`);
    meter.style.setProperty('--ch-token-fill', `${Math.min(100, usage.utilizationPercent)}%`);
    container.append(meter, part('ch-token-count',
        `输入约 ${count(usage.inputTokens)} + 预留 ${count(usage.reservedOutputTokens)} / ${count(usage.contextLimit)} token`));
    const captured = usage.capturedAt ? new Date(usage.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const caution = usage.reason === 'configuration-changed'
        ? '配置已变化；此为旧请求，下次发送可能不同。' : '本地估算；下次发送可能不同。';
    const serialization = usage.framing === 'native-text-serialization';
    container.append(part('ch-token-note', `${captured ? `${captured} · ` : ''}${caution}${serialization ? '供应商封装开销未确认。' : ''}`));
    container.title = `本地分词器：${usage.tokenizerModel ?? '原生'}；${serialization ? '使用酒馆文本序列化估算，供应商聊天模板可能额外占用 token' : '包括 OpenAI 消息封装估算'}；输出预留只计一次。${usage.stage ? `捕获阶段：${usage.stage}。` : ''}后续扩展及供应商转换可能改变实际用量。`;
}
