import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_THRESHOLD_PERCENT, calculateTokenBudget, countEncodedMessages, estimateContextUsage,
} from '../src/tokens.js';

const limits = { contextLimit: 1000, reservedOutputTokens: 100 };
const captured = () => ({
    kind: 'captured', scope: 'full',
    messages: [{ role: 'system', content: 'World.' }, { role: 'user', name: 'User', content: 'Now.' }],
});
const count = inputTokens => ({
    inputTokens, source: 'native-local-estimate', includesFraming: true, fallback: false,
});

test('the budget includes the output reserve once against the full context limit', () => {
    assert.equal(DEFAULT_THRESHOLD_PERCENT, 85);
    assert.deepEqual(calculateTokenBudget({ ...limits, inputTokens: 750 }), {
        status: 'available', inputTokens: 750, reservedOutputTokens: 100,
        totalTokens: 850, contextLimit: 1000, remainingTokens: 150,
        utilizationPercent: 85, thresholdPercent: 85, thresholdReached: true,
    });
});

test('the warning threshold is inclusive and compared before display rounding', () => {
    for (const [inputTokens, thresholdReached] of [[749, false], [750, true], [751, true]]) {
        const result = calculateTokenBudget({ ...limits, inputTokens });
        assert.equal(result.thresholdReached, thresholdReached);
    }
    const custom = calculateTokenBudget({ ...limits, inputTokens: 800, thresholdPercent: 90 });
    assert.equal(custom.thresholdReached, true);
    assert.equal(custom.utilizationPercent, 90);
    const exact = calculateTokenBudget({
        contextLimit: 100, reservedOutputTokens: 0, inputTokens: 29, thresholdPercent: 29,
    });
    assert.equal(exact.thresholdReached, true);
    assert.equal(exact.utilizationPercent, 29);
    const below = calculateTokenBudget({
        contextLimit: 100000, reservedOutputTokens: 100, inputTokens: 84899,
    });
    assert.equal(below.thresholdReached, false);
});

test('over-budget input is visible without clipping the percentage or remaining tokens', () => {
    const result = calculateTokenBudget({ ...limits, inputTokens: 1000 });
    assert.equal(result.status, 'available');
    assert.equal(result.totalTokens, 1100);
    assert.equal(result.utilizationPercent, 110);
    assert.equal(result.remainingTokens, -100);
    assert.equal(result.thresholdReached, true);
});

test('zero reserve and zero input are valid explicit budget values', () => {
    const empty = calculateTokenBudget({ contextLimit: 1000, reservedOutputTokens: 0, inputTokens: 0 });
    assert.equal(empty.status, 'available');
    assert.equal(empty.utilizationPercent, 0);
    assert.equal(empty.thresholdReached, false);
    const allReserved = calculateTokenBudget({ contextLimit: 1000, reservedOutputTokens: 1000, inputTokens: 0 });
    assert.equal(allReserved.status, 'available');
    assert.equal(allReserved.utilizationPercent, 100);
});

test('missing, nonnumeric, fractional, negative and unsafe limits are unavailable', () => {
    for (const contextLimit of [undefined, null, '', '1000', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(calculateTokenBudget({ ...limits, contextLimit, inputTokens: 10 }).reason, 'invalid-context-limit');
    }
    for (const reservedOutputTokens of [undefined, null, '', '100', -1, 0.5, NaN, Infinity, 1001]) {
        assert.equal(calculateTokenBudget({ ...limits, reservedOutputTokens, inputTokens: 10 }).reason, 'invalid-output-reserve');
    }
    for (const inputTokens of [undefined, null, '', '10', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(calculateTokenBudget({ ...limits, inputTokens }).reason, 'invalid-input-tokens');
    }
    for (const options of [undefined, null, {}]) {
        assert.equal(calculateTokenBudget(options).status, 'unavailable');
    }
});

test('unknown thresholds and unsafe sums are unavailable', () => {
    for (const thresholdPercent of [null, '', '85', 0, -1, 101, NaN, Infinity]) {
        assert.equal(calculateTokenBudget({ ...limits, inputTokens: 10, thresholdPercent }).reason, 'invalid-threshold');
    }
    assert.equal(calculateTokenBudget({
        contextLimit: Number.MAX_SAFE_INTEGER, inputTokens: Number.MAX_SAFE_INTEGER, reservedOutputTokens: 1,
    }).reason, 'invalid-total-tokens');
});

test('the async counter receives all captured messages with framing requested', async () => {
    const capture = captured();
    let calls = 0;
    const result = await estimateContextUsage({ capture, ...limits }, {
        countMessages: async (messages, full) => {
            calls++;
            assert.equal(full, true);
            assert.deepEqual(messages, capture.messages);
            await Promise.resolve();
            return count(750);
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'available');
    assert.equal(result.source, 'native-local-estimate');
    assert.equal(result.scope, 'full-chat-completion-messages');
    assert.equal(result.inputTokens, 750);
    assert.equal(result.totalTokens, 850);
    assert.equal(result.utilizationPercent, 85);
    assert.equal(result.thresholdReached, true);
});

test('synchronous injected counters work without adding framing or reserve twice', async () => {
    const result = await estimateContextUsage({ capture: captured(), ...limits, thresholdPercent: 90 }, {
        countMessages: () => count(800),
    });
    assert.equal(result.inputTokens, 800);
    assert.equal(result.totalTokens, 900);
    assert.equal(result.thresholdPercent, 90);
    assert.equal(result.thresholdReached, true);
});

test('simulated, partial and unmarked captures never invoke the full-context counter', async () => {
    let calls = 0;
    const captures = [
        undefined, null, {},
        { ...captured(), kind: 'simulated' },
        { ...captured(), scope: 'selection' },
        { ...captured(), scope: undefined },
        { ...captured(), kind: undefined },
    ];
    for (const capture of captures) {
        const result = await estimateContextUsage({ capture, ...limits }, {
            countMessages: () => { calls++; return count(750); },
        });
        assert.equal(result.status, 'unavailable');
        assert.equal(result.reason, 'unsupported-capture');
    }
    assert.equal(calls, 0);
    assert.equal((await estimateContextUsage(null)).status, 'unavailable');
});

test('malformed messages and unsupported multimedia or tool input are unavailable', async () => {
    let calls = 0;
    const messageSets = [
        undefined, null, {}, [], new Array(1), [null], ['Text'], [{}],
        [{ role: 'unknown', content: 'Text' }],
        [{ role: 'user', content: null }],
        [{ role: 'user', content: ['Text'] }],
        [{ role: 'user', name: 5, content: 'Text' }],
        [{ role: 'assistant', content: '', tool_calls: [{ type: 'function' }] }],
        [{ role: 'tool', tool_call_id: 'tool-1', content: 'Result' }],
        [{ role: 'user', content: 'Text', unknown: 'Uncounted field' }],
    ];
    for (const messages of messageSets) {
        const result = await estimateContextUsage({ capture: { ...captured(), messages }, ...limits }, {
            countMessages: () => { calls++; return count(750); },
        });
        assert.equal(result.status, 'unavailable');
        assert.equal(result.reason, 'unsupported-messages');
    }
    for (const extraInput of [
        { tools: [{ type: 'function' }] }, { functions: [{ name: 'lookup' }] },
        { response_format: { type: 'json_schema', json_schema: {} } },
    ]) {
        const result = await estimateContextUsage({ capture: { ...captured(), ...extraInput }, ...limits }, {
            countMessages: () => { calls++; return count(750); },
        });
        assert.equal(result.status, 'unavailable');
    }
    assert.equal(calls, 0);
});

test('invalid budget settings do not start tokenization', async () => {
    let calls = 0;
    for (const options of [
        { contextLimit: 0 }, { reservedOutputTokens: -1 }, { thresholdPercent: null },
    ]) {
        const result = await estimateContextUsage({ capture: captured(), ...limits, ...options }, {
            countMessages: () => { calls++; return count(750); },
        });
        assert.equal(result.status, 'unavailable');
    }
    assert.equal(calls, 0);
});

test('missing counters, rejected counts and synchronous failures return unavailable without error text', async () => {
    const options = { capture: captured(), ...limits };
    for (const dependencies of [undefined, null, {}, { countMessages: 'not a function' }]) {
        assert.equal((await estimateContextUsage(options, dependencies)).reason, 'counter-unavailable');
    }
    for (const countMessages of [
        () => { throw new Error('Private prompt must not appear in the result'); },
        async () => { throw new Error('Private prompt must not appear in the result'); },
    ]) {
        assert.deepEqual(await estimateContextUsage(options, { countMessages }), {
            status: 'unavailable', source: 'unavailable', reason: 'token-count-failed',
        });
    }
});

test('bare native numbers and unverified or heuristic counts are not promoted to token estimates', async () => {
    for (const result of [
        undefined, null, 750, {}, { inputTokens: 750 },
        { ...count(750), source: 'character-estimate' },
        { ...count(750), source: 'provider-actual' },
        { ...count(750), includesFraming: false },
        { ...count(750), includesFraming: undefined },
        { ...count(750), fallback: true },
        { ...count(750), fallback: undefined },
    ]) {
        const usage = await estimateContextUsage({ capture: captured(), ...limits }, {
            countMessages: () => result,
        });
        assert.deepEqual(usage, {
            status: 'unavailable', source: 'unavailable', reason: 'unverified-token-count',
        });
    }
});

test('invalid or zero counts for a nonempty framed request are unavailable', async () => {
    for (const inputTokens of [undefined, null, '750', 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const result = await estimateContextUsage({ capture: captured(), ...limits }, {
            countMessages: () => count(inputTokens),
        });
        assert.equal(result.status, 'unavailable');
        assert.equal(result.reason, 'invalid-input-tokens');
        assert.equal(result.source, 'unavailable');
        assert.equal('utilizationPercent' in result, false);
    }
});

test('unavailable counters do not fall back to character ratios for other providers', async () => {
    for (const provider of ['claude', 'makersuite', 'custom']) {
        const capture = captured();
        capture.provider = provider;
        capture.messages[1].content = 'Long text '.repeat(1000);
        const result = await estimateContextUsage({ capture, ...limits }, {
            countMessages: async () => null,
        });
        assert.equal(result.status, 'unavailable');
        assert.equal('inputTokens' in result, false);
        assert.equal('totalTokens' in result, false);
    }
});

test('message, capture and budget inputs remain isolated even if the injected counter mutates its copy', async () => {
    const capture = captured();
    const options = { capture, ...limits };
    const before = structuredClone(options);
    const result = await estimateContextUsage(options, {
        countMessages: async messages => {
            messages[0].content = 'Changed by counter';
            messages.push({ role: 'assistant', content: 'Added by counter' });
            return count(750);
        },
    });
    assert.equal(result.totalTokens, 850);
    assert.deepEqual(options, before);
    calculateTokenBudget({ ...limits, inputTokens: 750 });
    assert.deepEqual(limits, { contextLimit: 1000, reservedOutputTokens: 100 });
});

test('verified local encoding adds native OpenAI framing and a single reply primer', async () => {
    const messages = [
        { role: 'system', content: 'World.' }, { role: 'user', name: 'User', content: 'Now.' },
    ];
    const encoded = new Map([
        ['system', [9125]], ['World.', [10343, 13]], ['user', [882]],
        ['User', [1502]], ['Now.', [7184, 13]],
    ]);
    const before = structuredClone(messages);
    const result = await countEncodedMessages(messages, {
        tokenizerModel: 'gpt-4o',
        encode: async text => ({ ids: encoded.get(text), count: encoded.get(text)?.length }),
    });
    // Seven field tokens, three per-message tokens, one name token and three reply tokens.
    assert.deepEqual(result, {
        inputTokens: 17, source: 'native-local-estimate', includesFraming: true, fallback: false,
        tokenizerModel: 'gpt-4o', framing: 'openai-chat',
    });
    assert.deepEqual(messages, before);
});

test('legacy OpenAI framing follows the native 0301 message and name adjustment', async () => {
    const result = await countEncodedMessages([{ role: 'user', name: 'User', content: 'Now.' }], {
        tokenizerModel: 'gpt-3.5-turbo-0301',
        encode: async () => ({ ids: [123], count: 1 }),
    });
    // Three field tokens + four message tokens - one name token + three reply tokens + nine legacy tokens.
    assert.equal(result.inputTokens, 18);
    assert.equal(result.framing, 'openai-chat');
});

test('recognized native tokenizers use the native text estimate without claiming provider framing', async () => {
    for (const tokenizerModel of ['claude', 'gemma', 'deepseek', 'qwen2', 'llama3', 'mistral',
        'claude-sonnet-4-5', 'google/gemini-2.5-pro']) {
        let serialized;
        const result = await countEncodedMessages(captured().messages, {
            tokenizerModel,
            encode: async text => { serialized = text; return { ids: [1, 2, 3, 4], count: 4 }; },
        });
        assert.equal(result.inputTokens, 4);
        assert.equal(result.framing, 'native-text-serialization');
        assert.equal(result.source, 'native-local-estimate');
        assert.equal(serialized, captured().messages.flatMap(message => Object.values(message)).join('\n\n'));
    }
});

test('unknown tokenizer models never use the server default OpenAI tokenizer', async () => {
    let calls = 0;
    for (const tokenizerModel of [undefined, null, '', 'unlisted-provider-model', 'gpt2', 'o1-pro', 'o4', 'gpt-6']) {
        const result = await countEncodedMessages(captured().messages, {
            tokenizerModel, encode: () => { calls++; return { ids: [1], count: 1 }; },
        });
        assert.equal(result.status, 'unavailable');
        assert.equal(result.reason, 'unsupported-tokenizer');
    }
    assert.equal(calls, 0);
});

test('failed encoders and fallback-shaped encode results are unavailable', async () => {
    for (const encoding of [
        undefined, null, {}, 4, { count: 4 }, { ids: [], count: 4 }, { ids: [], count: 0 },
        { ids: [1, 2], count: 1 }, { ids: [1], count: '1' },
        { ids: [-1], count: 1 }, { ids: [0.5], count: 1 }, { ids: ['1'], count: 1 },
        { ids: new Array(1), count: 1 },
    ]) {
        const result = await countEncodedMessages(captured().messages, {
            tokenizerModel: 'gpt-4o', encode: async () => encoding,
        });
        assert.equal(result.status, 'unavailable');
    }
    const result = await countEncodedMessages(captured().messages, {
        tokenizerModel: 'gpt-4o', encode: async () => { throw new Error('Private local error'); },
    });
    assert.deepEqual(result, { status: 'unavailable', source: 'unavailable', reason: 'token-encoding-failed' });
    assert.equal((await countEncodedMessages(captured().messages)).status, 'unavailable');
    assert.equal((await countEncodedMessages([{ role: 'user', content: [] }], {
        tokenizerModel: 'gpt-4o', encode: async () => ({ ids: [1], count: 1 }),
    })).status, 'unavailable');
});

test('the local encoding adapter feeds the budget estimator without opaque count-endpoint results', async () => {
    const result = await estimateContextUsage({ capture: captured(), ...limits }, {
        countMessages: messages => countEncodedMessages(messages, {
            tokenizerModel: 'gpt-4o', encode: async () => ({ ids: [42], count: 1 }),
        }),
    });
    assert.equal(result.status, 'available');
    assert.equal(result.inputTokens, 15);
    assert.equal(result.totalTokens, 115);
    assert.equal(result.tokenizerModel, 'gpt-4o');
    assert.equal(result.framing, 'openai-chat');
    assert.equal(result.source, 'native-local-estimate');
    const unavailable = await estimateContextUsage({ capture: captured(), ...limits }, {
        countMessages: messages => countEncodedMessages(messages, { tokenizerModel: 'unknown' }),
    });
    assert.equal(unavailable.reason, 'unsupported-tokenizer');
});
