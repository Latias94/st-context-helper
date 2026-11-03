import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { resolveAdapter } from '../src/adapters.js';
import { readProtocolBlock } from '../src/reader.js';

const marker = '/* context-helper-status-reader:v1 */';

function replaceKnown(template, before, after) {
    if (template.split(before).length !== 2) throw new Error('Unsupported status renderer template; nothing was written.');
    return template.replace(before, () => after);
}

export function patchStatusRenderer(template) {
    for (const name of ['extractMaintext', 'extractStatusBlock', 'renderPageFromMessage']) {
        if ((template.match(new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g')) ?? []).length !== 1) {
            throw new Error('Unsupported status renderer declarations; nothing was written.');
        }
    }
    if (template.includes(marker)) {
        if (template.split(marker).length !== 2 || template.split('const contextHelperReadBlock =').length !== 2
            || template.split('const messageContent = actualMessageData.message;').length !== 2
            || !template.includes("return cleanYamlContent(contextHelperReadBlock(message, 'Status_block'));")
            || !template.includes('new StoryRenderer(\'yaml-data-source\').handleError(error);')) {
            throw new Error('Unsupported modified status reader; nothing was written.');
        }
        return template;
    }
    const source = fs.readFileSync(new URL('../src/tags.js', import.meta.url), 'utf8');
    const parts = source.split('export function normalizeMessage');
    if (parts.length !== 2) throw new Error('Unsupported scanner source.');
    // Embed the existing scanner, not a second parser or a runtime extension dependency.
    const scanner = parts[0].replace(/^export /gm, '');
    const profiles = ['izumi', 'cat-god', 'kunlun', 'generic'].map(adapter => resolveAdapter({ adapter }));
    const union = field => [...new Set(profiles.flatMap(profile => profile[field] ?? []))];
    const profile = { reasoningTags: union('reasoningTags'), bodyTags: ['maintext', ...union('bodyTags')],
        updateTags: union('updateTags'), statusTags: ['Status_block', ...union('statusTags')],
        transparentTags: union('transparentTags'), reasoningCommentMarker: '[IDE_AST_TRACE]' };
    const helper = `${marker}
        const contextHelperReadBlock = (() => {
${scanner}
${readProtocolBlock.toString()}
            const profile = ${JSON.stringify(profile)};
            return (message, tag) => {
                const result = readProtocolBlock(message, tag, profile);
                if (result.status === 'missing') return '';
                if (result.status !== 'ok') throw new Error(tag + ': ' + result.reason + '; ambiguous protocol data was not selected.');
                return result.text.trim();
            };
        })();
        `;
    if (/<\/script|\$\d|\$<|```|\{\{/i.test(helper)) throw new Error('Scanner cannot be embedded safely in this renderer.');
    let result = replaceKnown(template, String.raw`function extractMaintext(message) {
          if (!message || typeof message !== 'string') return '';
          const match = message.match(/<maintext>([\s\S]*?)<\/maintext>/i);
          return match ? match[1].trim() : '';
        }`, `${helper}function extractMaintext(message) {
          return contextHelperReadBlock(message, 'maintext');
        }`);
    result = replaceKnown(result, String.raw`function extractStatusBlock(message) {
          if (!message || typeof message !== 'string') return '';

          const match = message.match(/<Status_block>\s*([\s\S]*?)\s*<\/Status_block>/i);
          return match ? cleanYamlContent(match[1].trim()) : '';
        }`, `function extractStatusBlock(message) {
          return cleanYamlContent(contextHelperReadBlock(message, 'Status_block'));
        }`);
    result = replaceKnown(result, 'const messageContent = actualMessageData.message;',
        'const messageContent = actualMessageData.message;\n          try {');
    result = replaceKnown(result, `if (statusContent) {
            updateYamlDataSource(statusContent);
            setTimeout(() => reRenderStatusBar(), 100);
          }`, `updateYamlDataSource(statusContent);
            reRenderStatusBar();
          } catch (error) {
            document.getElementById('yaml-data-source').textContent = '';
            new StoryRenderer('yaml-data-source').handleError(error);
          }`);
    const guard = 'if (!this.yamlData || Object.keys(this.yamlData).length === 0) {';
    if (result.includes(guard)) result = replaceKnown(result, guard,
        `if (this.yamlData == null) throw new Error('Status YAML is empty; no data was selected.');
          if (typeof this.yamlData !== 'object' || Array.isArray(this.yamlData)) throw new Error('Status YAML must be an object, not a scalar or array.');
          ${guard}`);
    const emptyGuard = 'if (!yamlScript || !yamlScript.textContent) return;';
    if (result.includes(emptyGuard)) result = replaceKnown(result, emptyGuard, 'if (!yamlScript) return;');
    return result;
}

export function patchStatusDocument(document) {
    const next = structuredClone(document), data = next.data ?? next;
    let changed = false, readers = 0, templates = 0;
    for (const rule of data.extensions?.regex_scripts ?? []) {
        if (!rule.replaceString?.includes('function extractStatusBlock(message)')) continue;
        const replacement = patchStatusRenderer(rule.replaceString);
        changed ||= replacement !== rule.replaceString;
        rule.replaceString = replacement;
        readers++;
    }
    const names = ['一体式美化状态栏[元数据模板,勿动]', '美化状态栏[元数据模板,勿动]'];
    for (const entries of [data.character_book?.entries, next.entries, next.originalData?.entries]) {
        for (const entry of Object.values(entries ?? {})) {
            if (!names.includes(entry.comment ?? entry.name)) continue;
            let rule;
            try { rule = JSON.parse(entry.content); }
            catch { throw new Error('Invalid JSON in a named writer status template; nothing was written.'); }
            if (typeof rule?.replaceString !== 'string') throw new Error('Unsupported writer status template; nothing was written.');
            const replacement = patchStatusRenderer(rule.replaceString);
            if (replacement !== rule.replaceString) {
                entry.content = replaceKnown(entry.content, JSON.stringify(rule.replaceString), JSON.stringify(replacement));
                changed = true;
            }
            templates++;
        }
    }
    return { document: next, changed, readers, templates };
}

async function main() {
    const { values } = parseArgs({ options: { sillytavern: { type: 'string' }, card: { type: 'string' }, world: { type: 'string' } } });
    if (!values.sillytavern || !values.card) throw new Error('Usage: node tools/patch-status-reader.js --sillytavern PATH --card PATH.png [--world PATH.json]');
    const root = fs.realpathSync(values.sillytavern), cardPath = fs.realpathSync(values.card);
    const require = createRequire(path.join(root, 'package.json'));
    const extract = require('png-chunks-extract'), pngText = require('png-chunk-text');
    const { default: encode } = await import(pathToFileURL(path.join(root, 'src/png/encode.js')));
    const original = fs.readFileSync(cardPath), chunks = extract(original);
    let changed = 0, found = 0, readers = 0, templates = 0;
    for (let index = 0; index < chunks.length; index++) {
        if (chunks[index].name !== 'tEXt') continue;
        const metadata = pngText.decode(chunks[index].data);
        if (!['chara', 'ccv3'].includes(metadata.keyword.toLowerCase())) continue;
        found++;
        const card = JSON.parse(Buffer.from(metadata.text, 'base64').toString('utf8'));
        const result = patchStatusDocument(card);
        if (!result.readers && !result.templates) throw new Error('No observed status renderer or writer template was found in a card metadata chunk.');
        readers += result.readers;
        templates += result.templates;
        if (!result.changed) continue;
        chunks[index] = pngText.encode(metadata.keyword, Buffer.from(JSON.stringify(result.document)).toString('base64'));
        changed++;
    }
    if (!found) throw new Error('No character card metadata was found; nothing was written.');
    const files = changed ? [{ target: cardPath, original, output: Buffer.from(encode(chunks)) }] : [];
    if (values.world) {
        const target = fs.realpathSync(values.world), source = fs.readFileSync(target);
        if (target === cardPath) throw new Error('The card and worldbook must be different files; nothing was written.');
        const result = patchStatusDocument(JSON.parse(source.toString('utf8')));
        if (!result.templates) throw new Error('No named writer templates were found in the supplied worldbook; nothing was written.');
        templates += result.templates;
        if (result.changed) files.push({ target, original: source, output: Buffer.from(JSON.stringify(result.document, null, 4) + '\n') });
    }
    if (!files.length) { console.log('No changes: the readers and supplied writer templates are already installed.'); return; }
    for (const file of files) {
        if (!fs.readFileSync(file.target).equals(file.original)) throw new Error('A target changed during preparation; nothing was written.');
    }
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const backupRoot = fs.realpathSync(path.join(root, 'backups'));
    if (path.relative(root, backupRoot).startsWith('..') || path.isAbsolute(path.relative(root, backupRoot))) {
        throw new Error('The backup directory must stay inside the SillyTavern checkout.');
    }
    const backup = path.join(backupRoot, 'context-helper', `status-reader-${stamp}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const file of files) {
        fs.writeFileSync(path.join(backup, path.basename(file.target)), file.original, { flag: 'wx' });
        file.temporary = `${file.target}.context-helper-${process.pid}.tmp`;
        fs.writeFileSync(file.temporary, file.output, { flag: 'wx' });
    }
    for (const file of files) {
        if (!fs.readFileSync(file.target).equals(file.original)) throw new Error('A target changed before replacement; prepared files and backups were retained.');
    }
    console.log(`Backup: ${backup}`);
    for (const file of files) {
        if (!fs.readFileSync(file.target).equals(file.original)) throw new Error('A target changed before its replacement; stop and inspect the retained backups.');
        fs.renameSync(file.temporary, file.target);
        if (!fs.readFileSync(file.target).equals(file.output)) throw new Error('Saved data did not match the prepared patch; retain the backups.');
        console.log(`Saved and verified: ${file.target}`);
    }
    console.log(`Verified ${readers} reader copies and ${templates} writer templates; updated ${files.length} files. Backup: ${backup}`);
    console.log('Reload the character card and linked worldbook. No chats, presets, variables or table data were modified.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error.code ? `Status reader patch failed (${error.code}); retain any backup.` : error.message);
        process.exitCode = 1;
    });
}
