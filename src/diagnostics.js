const definitions = {
    'unclosed-reasoning': ['思考块未闭合', '无法确认哪些文字属于思考、哪些属于正文。', '先生成本地预览；没有可靠正文边界时使用 AI 预览，原文会保留。', 'local'],
    'nested-reasoning': ['混用了多层思考格式', '同一回复出现了嵌套思考标签，可能影响 MVU 和预设清理规则。', '生成本地预览，统一为当前预设的思考格式。', 'local'],
    'nested-protocol': ['正文或数据块出现同名嵌套标签', '未转义的同名开标签使真实边界不明确，读取器不能安全选择数据。', '核对并转义字面示例或修正缺失边界；不会自动选择、合并或删除嵌套内容。', 'none'],
    'literal-protocol-in-reasoning': ['思考文字中混入了协议标签', '标签可能只是示例，也可能被其他正则当作真实分隔符。', '生成本地预览；无法确定边界的部分再交给 AI 预览。', 'local'],
    'unescaped-protocol-example': ['思考里的标签示例可能被前端误读', '状态栏等前端可能重新读取原始消息，把思考中的标签示例当成真正输出；显示阶段的转义不能保护原文。', '生成并应用本地修复预览，将思考里的标签示例转义后保存，再重新加载消息。真正的正文、状态栏和表格内容会保留；边界不明确时先使用 AI 预览。', 'local'],
    'raw-reader-collision': ['前端的原文读取边界与真实状态块不一致', '已启用的已知前端直接读取消息原文，可能先读到正文、代码或注释中的示例，或提前结束匹配。', '查看对应渲染规则及其前端读取逻辑，让读取器排除示例并使用真实协议边界。正文、代码和原生注释不会由本地修复重写。', 'regex'],
    'render-boundary-mismatch': ['标签可解析，但不符合已知美化规则', '当前已启用的已知显示规则对大小写、空格或正文容器有更严格的要求。', '查看对应规则，核对标签格式与角色卡输出模板。该提示不会自动修改规则或重命名数据标签。', 'regex'],
    'duplicate-protocol-block': ['同一消息存在多个真实状态块', '前端可能只读取第一块，忽略后续状态；目前无法确定应该采用哪一块。', '对照生成来源和状态时间线，手动确认应保留的块。不会自动取最后一块、合并或删除状态数据。', 'none'],
    'consumer-delimiter-collision': ['表格字段中的结束标签可能截断指令', '真实表格块内部含有字面的结束标签；采用普通正则的表格插件可能过早结束提取。', '核对表格插件的读取边界和字段编码；本地修复保留完整指令与字段值。此提示不执行表格更新，也不推断先前数据是否受影响。', 'none'],
    'repeated-reasoning': ['当前预设偏好一段前置思考', '检测到多段独立思考。', '相邻思考可在本地预览中合并；被正文或数据分隔的思考需要核对来源。', 'none'],
    'misplaced-reasoning': ['思考块出现在正文之后', '当前预设偏好前置思考，这段思考位于已经出现的正文之后。', '核对预设或插件的输出阶段，调整模板或手动整理；不会自动跨正文移动思考。', 'none'],
    'orphan-close': ['思考结束标签存在冲突', '结束标签没有对应起点，或较早的示例被当成了结束位置。', '核对原文；使用 AI 预览建议边界，不会自动删除正文。', 'ai'],
    'orphan-protocol-close': ['正文或数据标签缺少起点', '发现无法配对的结束标签。', '核对缺失的起始标签；可使用 AI 预览补边界。', 'ai'],
    'unclosed-body': ['正文块缺少结束标签', '正文内容保留，但协议边界不完整。', '检查回复是否被截断；AI 可以建议补标签，不能编造丢失的正文。', 'ai'],
    'unclosed-transparent': ['正文内部的包裹标签未闭合', '正文容器内的隐藏 / 展示包裹缺少结束标签；原文已保留。', '对照消息原文，手动补齐包裹标签后重新分析；完整正文内的包裹不会由本地规则猜测修改。', 'none'],
    'orphan-transparent': ['正文内部的包裹标签缺少起点', '正文容器内发现了无法配对的隐藏 / 展示结束标签。', '核对消息原文中的包裹起点并手动修正，再重新分析。', 'none'],
    'unclosed-data': ['变量或表格数据块未闭合', '数据边界不完整，本地规则不会猜测缺失值。', '检查生成是否截断；AI 可补齐已有数据的结束标签，缺失 JSON 需要重新生成或手动补全。', 'ai'],
    'unclosed-code-fence': ['代码围栏没有闭合', '后续标签被作为代码示例处理，避免误解析。', '核对代码围栏终点；可使用 AI 预览建议边界。', 'ai'],
    'unclosed-xml-literal': ['XML 注释或 CDATA 没有闭合', '后续标签仍视为字面内容，无法可靠判断正文位置。', '补齐注释或 CDATA 终点，再重新分析；可使用 AI 预览。', 'ai'],
    'stalled-mvu': ['有变量更新指令，但状态快照没有变化', '可能有更新被漏解析，也可能更新值本来就相同。', '生成本地预览，对照当前场景和变量差异；不要重复应用已执行的数值增量。', 'local'],
    'invalid-patch': ['变量更新指令无法解析', 'JSONPatch 可能缺失、不完整，或使用了尚不支持的旧格式。', '查看消息的数据块；可用 AI 预览补边界，缺失变量值需要明确证据。', 'ai'],
    'duplicate-table-rows': ['记忆表格存在完全重复行', '重复内容会占用上下文，也可能强化旧信息。', '生成本地预览以合并完全重复行；不同内容的行不会仅凭表名被删除。', 'local'],
    'incomplete-table': ['表格引用或历史单元格不完整', '当前表格只能查看，不能可靠自动写回。', '在表格记忆插件中检查数据引用或恢复备份，然后重新分析。', 'none'],
    'unknown-preset': ['未匹配到专用预设适配', '当前可检查上下文，但自动标签规范化不会执行。', '在设置中选择实际使用的 Izumi、小猫之神或昆仑；其他预设保持观察模式。', 'settings'],
    'missing-required-protocol': ['缺少角色卡要求的输出块', '卡片声明的必需标签未出现在这条回复中。', '核对角色卡协议证据和回复是否截断；AI 可建议边界，不能凭空补剧情或变量值。', 'ai'],
    'state-review-required': ['变量恢复需要核对', '本地规则无法确定该如何恢复变量快照。', '对照最新正文、前后状态和更新指令；必要时生成 AI 修复预览。', 'ai'],
    'history-trim-policy': ['历史消息被正则裁剪', '这条规则按消息深度清空较早消息；它不是标签修复失败。', '在“设置 → 正则规则”查看生效深度。需要保留旧剧情时关闭该规则或调整深度，然后重新分析。', 'regex'],
    'history-erased': ['整条历史消息被正则移除', '当前消息经过发送处理后没有剩余内容。', '查看对应规则轨迹和深度；如果这是预期裁剪，可以保留，否则在设置中关闭规则后重新分析。', 'regex'],
    'narrative-loss': ['正文被正则处理删除', '原始消息里的剧情正文没有出现在发送模拟中。', '先查看规则轨迹；如果不是预期裁剪，关闭或修正规则，再生成本地或 AI 修复预览。', 'regex'],
    'table-outside-scope': ['表格快照在所选范围之外', '这次预览不会修改范围外的表格数据。', '扩大分析范围覆盖表格快照，再生成预览。', 'none'],
    'worldbook-unavailable': ['关联世界书读取失败', '当前协议证据使用了可能过期的卡片内嵌副本。', '检查关联世界书是否存在，再重新分析。', 'none'],
    'conditional-card-protocol': ['部分标签要求依赖世界书激活条件', '启用条目不代表本轮实际注入。', '结合捕获的提示词核对；条件未触发时不必补出这些标签。', 'none'],
    'writer-template-protocol': ['写卡模板不等于当前聊天输出格式', '这些标签用于生成卡片产物。', '要检查生成卡的实际协议，请打开生成后的角色卡。', 'none'],
    'source-template-unclosed-tag': ['开场白模板的 version 标签未配对', '模板重复了起始标签，可能被带入新生成的卡片。', '在写卡助手世界书中核对开场白模板；本工具不会自动修改模板。', 'none'],
    'source-template-conflict': ['世界观模板与说明使用了不同标签', '来源规则之间存在命名冲突。', '核对生成产物和世界书说明后选择实际标签，不自动重写原模板。', 'none'],
};

export function presentIssue(issue) {
    const definition = definitions[issue.code];
    const action = issue.action ?? definition?.[3] ?? 'none';
    const category = issue.category ?? (issue.code === 'history-trim-policy' ? 'policy'
        : ['local', 'ai'].includes(action) ? 'repair' : 'review');
    return { ...issue,
        title: definition?.[0] ?? issue.title,
        detail: issue.localized ? issue.detail : definition?.[1] ?? issue.detail,
        recommendation: issue.recommendation ?? definition?.[2],
        action,
        category,
        originalDetail: issue.localized ? undefined : issue.detail,
    };
}

export function diagnosisSummary(issues) {
    const counts = { repair: 0, policy: 0, review: 0 };
    for (const issue of issues) counts[presentIssue(issue).category]++;
    return counts;
}

export function repairOutcome(issues) {
    const counts = diagnosisSummary(issues);
    const errors = issues.filter(issue => issue.severity === 'error').length;
    const loss = issues.some(issue => issue.code === 'narrative-loss');
    return errors ? `仍有 ${errors} 项错误${loss ? '，包括正文丢失' : ''}需要处理，请查看诊断中的对应规则或下一步。`
        : counts.repair ? `仍有 ${counts.repair} 项需要处理，请查看诊断中的下一步。`
        : counts.policy ? `标签和数据修复已完成；另有 ${counts.policy} 项来自正则的历史裁剪或摘要策略，可保留或在设置中调整。`
            : counts.review ? `另有 ${counts.review} 项配置提示可供核对。` : '当前没有报告需要继续处理的问题。';
}
