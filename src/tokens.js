export const DEFAULT_THRESHOLD_PERCENT = 85;

const unavailable = reason => ({ status: 'unavailable', source: 'unavailable', reason });
const isTokenCount = value => Number.isSafeInteger(value) && value >= 0;

/**
 * Calculate usage against the configured FULL context limit, not the input-only
 * budget returned by some host APIs. The output reservation is added once.
 * This function does arithmetic only and makes no claim about count provenance.
 */
export function calculateTokenBudget(options = {}) {
    const {
        inputTokens, contextLimit, reservedOutputTokens, thresholdPercent = DEFAULT_THRESHOLD_PERCENT,
    } = options ?? {};
    if (!isTokenCount(contextLimit) || contextLimit === 0) return unavailable('invalid-context-limit');
    if (!isTokenCount(reservedOutputTokens) || reservedOutputTokens > contextLimit) {
        return unavailable('invalid-output-reserve');
    }
    if (!isTokenCount(inputTokens)) return unavailable('invalid-input-tokens');
    if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 100) {
        return unavailable('invalid-threshold');
    }
    const totalTokens = inputTokens + reservedOutputTokens;
    if (!isTokenCount(totalTokens)) return unavailable('invalid-total-tokens');
    const utilizationPercent = totalTokens * 100 / contextLimit;
    return {
        status: 'available', inputTokens, reservedOutputTokens, totalTokens, contextLimit,
        remainingTokens: contextLimit - totalTokens, utilizationPercent, thresholdPercent,
        thresholdReached: utilizationPercent >= thresholdPercent,
    };
}

function supportsMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    for (const message of messages) {
        if (!message || typeof message !== 'object' || Array.isArray(message)
            || !['system', 'developer', 'user', 'assistant'].includes(message.role)
            || typeof message.content !== 'string'
            || (message.name !== undefined && typeof message.name !== 'string')
            || Object.keys(message).some(field => !['role', 'content', 'name'].includes(field))) {
            return false;
        }
    }
    return true;
}

/**
 * A concrete adapter for the local encode endpoint. Supply the native
 * getTokenizerModel() result and encode(text), which returns { ids, count }
 * from /api/tokenizers/openai/encode?model=<tokenizerModel>. No count-only
 * response is accepted: SentencePiece's character fallback has no token IDs.
 *
 * OpenAI framing matches the native count endpoint's ChatML estimates, with
 * reply priming added once for the whole array. Other recognized native
 * tokenizers use the host's text serialization; their provider-specific chat
 * template overhead remains unknown. Unknown tokenizer models are rejected
 * instead of silently using the server's default Turbo tokenizer.
 */
export async function countEncodedMessages(messages, options = {}) {
    const { tokenizerModel, encode } = options ?? {};
    const model = typeof tokenizerModel === 'string' ? tokenizerModel.split('/').at(-1) : '';
    const openai = (
        /^(?:gpt-(?:3\.5-turbo|4o?|5)|o3)(?:[-.]|$)/.test(model)
        || model.startsWith('gpt-6-') || model === 'chatgpt-4o-latest'
        || /^(?:o1(?:-(?:preview|mini))?|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
    );
    const nativeText = ['claude', 'llama3', 'llama', 'mistral', 'yi', 'gemma', 'jamba',
        'qwen2', 'command-r', 'command-a', 'nemo', 'deepseek'].includes(model)
        || /^(?:claude-|gemini-|gemma-|deepseek-|llama-3|llama3-|mistral-|qwen2[.-])/.test(model);
    if (!openai && !nativeText) return unavailable('unsupported-tokenizer');
    if (!supportsMessages(messages)) return unavailable('unsupported-messages');
    if (typeof encode !== 'function') return unavailable('counter-unavailable');

    // Repeated role/name values only need one encode request during this count.
    const counts = new Map();
    const encodeCount = async text => {
        if (text === '') return 0;
        if (counts.has(text)) return counts.get(text);
        const data = await encode(text);
        if (!Array.isArray(data?.ids) || data.ids.length === 0 || data.count !== data.ids.length) {
            throw new Error('Unverified local token encoding');
        }
        for (const id of data.ids) {
            if (!isTokenCount(id)) throw new Error('Invalid local token ID');
        }
        counts.set(text, data.ids.length);
        return data.ids.length;
    };

    let inputTokens = 0;
    try {
        if (openai) {
            const legacy = tokenizerModel.includes('gpt-3.5-turbo-0301');
            inputTokens = 3 + (legacy ? 9 : 0);
            for (const message of messages) {
                inputTokens += legacy ? 4 : 3;
                for (const [field, value] of Object.entries(message)) {
                    if (value === undefined) continue;
                    inputTokens += await encodeCount(value);
                    if (field === 'name') inputTokens += legacy ? -1 : 1;
                }
            }
        } else {
            inputTokens = await encodeCount(messages.flatMap(message => Object.values(message)).join('\n\n'));
        }
    } catch {
        return unavailable('token-encoding-failed');
    }
    if (!isTokenCount(inputTokens) || inputTokens === 0) return unavailable('invalid-input-tokens');
    return {
        inputTokens, source: 'native-local-estimate', includesFraming: true, fallback: false,
        tokenizerModel, framing: openai ? 'openai-chat' : 'native-text-serialization',
    };
}

/**
 * Estimate full captured, text-only Chat Completion messages. The host must mark
 * capture as { kind: 'captured', scope: 'full', messages }; simulated or selected
 * chat history is not a full capture. Tool schemas and multimodal input are not
 * supported. The host must ensure no other token-bearing input was omitted.
 *
 * countMessages(messages, true) may be async and receives an isolated copy.
 * It must return { inputTokens, source: 'native-local-estimate',
 * includesFraming: true, fallback: false }, counting input plus framing only.
 * Framing follows the host convention identified by the returned framing field.
 * It must use the captured model and fail when tokenization cannot be verified.
 * Do not add this metadata blindly to a raw native count: SillyTavern's
 * /openai/count endpoint can silently return a character-based fallback.
 *
 * Returns a budget with source/scope, or { status: 'unavailable', source:
 * 'unavailable', reason }. This module imports no browser host and performs no
 * network requests, character estimation, retries, or provider usage accounting.
 */
export async function estimateContextUsage(options = {}, dependencies = {}) {
    const {
        capture, contextLimit, reservedOutputTokens, thresholdPercent = DEFAULT_THRESHOLD_PERCENT,
    } = options ?? {};
    if (capture?.kind !== 'captured' || capture.scope !== 'full') {
        return unavailable('unsupported-capture');
    }
    for (const field of ['tools', 'functions']) {
        if (capture[field] !== undefined
            && (!Array.isArray(capture[field]) || capture[field].length > 0)) {
            return unavailable('unsupported-capture');
        }
    }
    if (capture.response_format != null && capture.response_format.type !== 'text') {
        return unavailable('unsupported-capture');
    }
    if (!supportsMessages(capture.messages)) return unavailable('unsupported-messages');
    const budgetOptions = { contextLimit, reservedOutputTokens, thresholdPercent };
    const validation = calculateTokenBudget({ ...budgetOptions, inputTokens: 0 });
    if (validation.status !== 'available') return validation;
    const countMessages = dependencies?.countMessages;
    if (typeof countMessages !== 'function') return unavailable('counter-unavailable');

    let count;
    try {
        count = await countMessages(structuredClone(capture.messages), true);
    } catch {
        return unavailable('token-count-failed');
    }
    if (count?.status === 'unavailable' && count.source === 'unavailable'
        && ['unsupported-tokenizer', 'unsupported-messages', 'counter-unavailable',
            'token-encoding-failed', 'invalid-input-tokens'].includes(count.reason)) {
        return unavailable(count.reason);
    }
    if (!count || typeof count !== 'object' || Array.isArray(count)
        || count.source !== 'native-local-estimate'
        || count.includesFraming !== true || count.fallback !== false) {
        return unavailable('unverified-token-count');
    }
    if (!isTokenCount(count.inputTokens) || count.inputTokens === 0) return unavailable('invalid-input-tokens');
    const budget = calculateTokenBudget({ ...budgetOptions, inputTokens: count.inputTokens });
    if (budget.status !== 'available') return budget;
    return {
        ...budget, source: 'native-local-estimate', scope: 'full-chat-completion-messages',
        ...(typeof count.tokenizerModel === 'string' ? { tokenizerModel: count.tokenizerModel } : {}),
        ...(typeof count.framing === 'string' ? { framing: count.framing } : {}),
    };
}
