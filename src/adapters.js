import { withCardProtocol } from './protocols.js';

const profiles = {
    izumi: {
        id: 'izumi', label: 'Izumi',
        reasoningTag: 'konatan_planning~', reasoningTags: ['konatan_planning~', 'thinking', 'think'],
        bodyTags: ['content', 'game'], updateTags: ['UpdateVariable', 'IzumiEdit'],
        summaryTags: ['progress', 'summary'], adviceTags: ['advice'],
    },
    'cat-god': {
        id: 'cat-god', label: '小猫之神 / 喵赛亚',
        reasoningTag: 'think_nya~', reasoningTags: ['think_nya~', 'think_nya', 'report_nya~', 'report_nya', 'thinking', 'think'],
        bodyTags: ['game', 'content'], updateTags: ['UpdateVariable'], statusTags: ['summary', 'comment', 'options'],
        summaryTags: ['summary'], adviceTags: ['advice', 'options'],
    },
    kunlun: {
        id: 'kunlun', label: '昆仑 / Kunlun IDE',
        reasoningTag: 'talk', reasoningTags: ['talk', 'thinking', 'think'],
        reasoningCommentMarker: '[IDE_AST_TRACE]',
        bodyTags: ['content', 'game', 'hidden'], transparentTags: ['hidden'],
        updateTags: ['UpdateVariable'], statusTags: ['sumUp', 'pose', 'choices'],
        summaryTags: ['sumUp'], adviceTags: ['choices'],
    },
    generic: {
        id: 'generic', label: 'Generic / observe only',
        reasoningTag: 'thinking', reasoningTags: ['thinking', 'think'],
        bodyTags: ['content', 'game'], updateTags: ['UpdateVariable', 'IzumiEdit'],
        summaryTags: ['summary'], adviceTags: ['advice'],
    },
};

export function enabledPrompts(preset = {}) {
    const order = preset.prompt_order?.find(group => group.character_id === 100001)
        ?? preset.prompt_order?.at(-1);
    const enabled = new Set(order?.order?.filter(row => row.enabled).map(row => row.identifier));
    return (preset.prompts ?? []).filter(prompt => order ? enabled.has(prompt.identifier) : prompt.enabled !== false);
}

export function resolveAdapter({ presetName = '', preset = {}, adapter = 'auto', cardProtocol } = {}) {
    const promptText = enabledPrompts(preset).map(prompt => prompt.content ?? '').join('\n');
    const recognize = (source, name = false) => /kunlun/i.test(source) || (name && /昆仑/.test(source)) ? 'kunlun'
        : /izumi|lzumi|konatan_planning|泉此方/i.test(source) ? 'izumi'
        : /小猫之神|喵赛亚|think_nya~|meowssiah|<<<\|catgodml\||<\/?(?:think_nya|report_nya)~?\s*>/i.test(source) ? 'cat-god' : null;
    const id = adapter !== 'auto' && profiles[adapter] ? adapter : recognize(presetName, true)
        ?? recognize(promptText) ?? 'generic';
    const profile = structuredClone(profiles[id]);
    // Follow the enabled native format; mixed or missing evidence keeps the legacy preference.
    if (id === 'cat-god' && /<think_nya\s*>/i.test(promptText) && !/<think_nya~\s*>/i.test(promptText)) {
        profile.reasoningTag = 'think_nya';
    }
    return withCardProtocol(profile, cardProtocol);
}
