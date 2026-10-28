/**
 * The reference memory extension caches Sheet instances independently of chat
 * metadata. Invalidate only affected instances so native reload builds fresh cells.
 */
export async function prepareMemoryReload(context, tableUids) {
    if (!tableUids.length || !context.getExtensionManifest?.('st-memory-enhancement')
        || context.extensionSettings.disabledExtensions?.includes('third-party/st-memory-enhancement')) return;
    const { DERIVED } = await import('/scripts/extensions/third-party/st-memory-enhancement/core/manager.js');
    const cache = DERIVED?.any?.chatSheetMap;
    if (cache) for (const uid of tableUids) delete cache[uid];
}
