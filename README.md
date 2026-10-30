# Context Helper

A SillyTavern extension for inspecting context construction and repairing saved
conversations. Preset adapters cover **Izumi**, **Cat God / Meowssiah**
(`小猫之神 / 喵赛亚`), and **Kunlun IDE** (`昆仑`). Unknown presets remain available for inspection.

Open **Extensions → 上下文助手** after installation.

## Optional floating monitor

The floating monitor is **hidden by default**, including existing installations.
Enable **Settings → 显示上下文浮窗** to show it. This preference and its token
warning threshold apply across chats. Drag the grip to move it, collapse it to
keep a compact status, or close it to save the hidden preference. Settings can
show it again.

The monitor checks the latest 12 chat messages and current memory tables after
chat changes, complete replies, edits, and configuration changes. It waits during
generation, saving, and message editing rather than diagnosing streamed fragments.
Click a warning to open diagnosis and its suggested next steps. Verified history
trimming and summary policies are shown separately and do not raise an error.
Monitoring does not request AI repairs or apply history changes.

Token utilization is `(estimated full input + reserved output) / configured full
context limit`. The default warning threshold is **85%**, configurable from 1%
to 100%. This uses the most recent captured complete text request, rather than
the 12-message diagnosis range or a character count.
OpenAI text counts include estimated message framing; other recognized native
tokenizers use SillyTavern's text serialization and may omit provider-specific
chat-template overhead. The inspector shows this information even when the
floating monitor is hidden.
Counts describe the captured event stage and configured budget, not provider
billing or a guaranteed prediction for the next request. The next response,
world-info activation, later extensions, and provider transformations can change
usage. Unsupported or unverifiable requests show unknown usage instead of a
misleading percentage.

## Settings and next steps

The status strip stays visible across all four tabs. It shows whether automatic
normalization is enabled **for the current chat**, whether the selected adapter
can apply it, and the latest recorded normalized message. History repairs always
require a preview and an explicit apply. AI requests are always manual.

Open **Settings** to change future-message normalization and inspect the complete
regex inventory. The list includes global, preset, and character rules, including
disabled rules, unapproved sources, and display-only rules. Each entry shows its
scope, configured switch, actual prompt eligibility, depth range, affected-floor
count, and expandable pattern/replacement. Depth zero is the newest included
message. A rule's switch does not grant permission to an entire preset or card.

Switching a regex updates its existing native owner; a global rule affects other
chats too. It is a separate settings action, not a chat-repair preview. The helper
checks that the owner and rule have not changed, saves through native APIs,
verifies the stored switch, refreshes diagnosis, and invalidates pending previews.
Pattern and depth editing remain in SillyTavern's native regex editor.

Diagnosis separates repair candidates, verified history-processing policies, and
items requiring review. Each item explains the next step and can link directly to
its rule. For example, an enabled `上下文限制[10]` with a full-content erase pattern,
an empty replacement, and `minDepth: 10` intentionally empties messages at depth
10 or greater. This is reported as an informational history policy, rather than
a failed tag repair. Keep it if the limit is desired; disable or adjust it if you
need older story text in the request. Applying a chat repair does not change that
regex policy. A reassuring rule name alone never exempts accidental story loss.

The two reference presets' known summary-retention patterns are recognized only
when real source summary content survives. Small, explicit literal-word filters
are traced separately from scene loss; significant truncation and malformed
source tags remain visible. After applying a repair, the status explains whether
remaining items are policies, configuration checks, or unresolved errors.

## What the inspector shows

- The order, roles, content, and character counts of the most recently captured
  native prompt event.
- The context pipeline: preset prompts, character/world information, history,
  regex processing, extension injection, and backend/provider conversion.
- Saved source versus native prompt-regex output for each selected floor, with
  the names, sources, depth constraints, and size changes of applied rules.
- Missing narrative, malformed reasoning boundaries, suspiciously unchanged MVU
  state, and duplicate memory-table rows.
- Current preset, linked worldbook, registered extension injections, and bounded
  character-protocol evidence with its source and applicability.

**A capture is not a network trace.** The inspector labels the exact event stage.
Other listeners can run later; the server/provider can merge roles and transform
tools or caching metadata. A capture is retained in memory for its current chat,
not written into chat metadata or the browser's persistent storage.

Before a capture exists, the inspector shows a **history-regex simulation**.
It does not claim to reproduce world-info activation, macro evaluation, token
budget trimming, all extension hooks, or the full final request. Character
counts are not token counts. Native saved raw-prompt text, when available, is
separately identified because its hook stage is unknown.
Simulation uses the native normal-send depth convention; continue/swipe requests,
tool configuration, and new messages can change the applicable depth.

## Repair workflow

1. Select a message range and inspect it.
2. Generate a local repair preview, or select a chat-completion connection and
   request an AI repair preview.
3. Review the complete before/after sources and reasons.
4. Apply the preview. The extension checks both in-memory and existing server
   state, saves a one-step undo backup, and verifies the saved chat by reading it
   back from the server. It checks affected fields again after native chat reload.
5. Undo is available while the affected state and conversation length still match
   the applied repair.

Only the selected swipe is edited. Other swipes, source metadata, variable
schemas, and historical table cells are preserved. Local state recovery only
replays explicit commands when the stored state still matches the preceding
snapshot. Already-applied deltas are not replayed. Ambiguous recovery is reported
for review. Local table cleanup removes exact duplicates; a familiar table name
alone never justifies deleting distinct rows. Missing historical cells or hash
references make a table inspection-only.

AI output is data, never executed JavaScript. The accepted JSON format restricts
edits to the selected message IDs/swipes, existing MVU state, and known tables.
An AI preview cannot silently apply itself or change API credentials, a preset,
or a character definition.

When local rules cannot locate a safe reasoning/story boundary, AI can propose
the missing terminator and a known body wrapper. Every original word and literal
tag example must survive validation, and already-established body blocks must
remain narrative. Existing data payloads are checked separately. An unfinished
data block can gain missing trailing terminators; AI cannot rewrite its existing
JSON, invent lost text, or turn literal examples into hidden reasoning.
Malformed, truncated, out-of-scope, or schema-shape-changing proposals are rejected.
This validates structure and preservation, not the truth of an AI's state inference.

An optional **per-chat** setting normalizes new assistant-message delimiters at
the beginning of `MESSAGE_RECEIVED`, before ordinary MVU listeners run. It is
off by default. The original generated source is retained in the message's
`extra.context_helper_original` field. An extension that later registers an
earlier listener can still affect ordering; inspect the result when combining
multiple source-mutating extensions.

## Preset-specific boundaries

Izumi uses one `konatan_planning~` reasoning block and accepts legacy
`thinking` / `think` wrappers. Cat God / Meowssiah covers both the 1.6 and
`Meowssiah_1.9.12` formats. Detection accepts the family names,
native `think_nya` / `report_nya` tag markers with or without `~`, and the
`<<<|catgodml|` format marker in enabled prompt content. Disabled or unselected
prompts and prompt names alone do not identify the family.

Cat God defaults to `think_nya~`. When enabled prompts declare `<think_nya>`
without a competing `<think_nya~>` declaration, normalization and AI repair use
the modern `think_nya` preference. Both native `report_nya` variants and legacy
`thinking` / `think` wrappers are accepted as reasoning. `<game>` narrative,
`<summary>`, `<comment>`, `<options><option>...</option></options>`, and variable
update payloads remain outside reasoning. Footer payloads are protected during
AI delimiter repair. This adapter does not execute SPreset tool bindings or its
request/output transformations; request captures retain their documented event
stage limits.

Kunlun is detected by the case-insensitive `kunlun` marker in a preset name or
enabled prompt content; `昆仑` also identifies a preset name. It can be selected
manually in the adapter menu. The `kunlun_IDE_1.2r` format uses an opaque
`<!-- [IDE_AST_TRACE] ... -->` precheck comment, `<content>` narrative, and
`<sumUp>`, `<pose>`, and `<choices>` footer blocks. Intact top-level native comments remain
unchanged. Legacy `<talk>`, `<thinking>`, and `<think>` reasoning can be normalized
to `<talk>` without moving story or data into reasoning.

Real, balanced `<hidden>` wrappers are transparent to narrative comparisons,
matching the preset's native unwrap rule. Their payload and original source are
retained; quoted and fenced examples remain significant. Unbalanced wrappers
inside a complete body are reported for manual correction.
An unclosed native precheck comment is retained locally. An AI preview can only
insert its missing `-->` directly before an existing, complete body opener; all
other source bytes and payloads must remain unchanged.

The native 80-depth erase and 40-depth summary-retention patterns are recognized
as policies only with matching execution evidence. Summary retention returns
bare `$2` text, so the later tag-based summary cleanup does not erase it at depth
40. A later rule that actually removes that retained text is still reported as
loss. The helper does not change the preset or its regex settings.

The scanner recognizes protocol names and treats inline/fenced code and quoted
strings as literals, including single-quoted table-action strings. It is not a
general HTML parser. XML comments and CDATA sections are opaque as well, so
example terminators inside them cannot close the surrounding reasoning. If bare
terminators conflict with later closes, local normalization is withheld for that
message and the inspector suggests AI boundary review. A closed inner reasoning
block or an explicit narrative opener can delimit a broken legacy wrapper. A later data block alone cannot
prove where unwrapped story starts. Unfinished text without a reliable boundary
is retained and reported, never deleted to end-of-message.

Normalization escapes tag examples inside reasoning and keeps narrative and
updates outside it. It does not globally impose one preset's preferences on
another. To support another preset, add a small profile in `src/adapters.js`
and regression tests for that preset's actual output.

Character evidence is layered over preset preferences. The active linked
worldbook is preferred over its embedded copy. Only a small output-tag allowlist
affects parsing: for example, `maintext` and `Status_block` in a generated card
can complement Izumi's or Cat God's reasoning convention. `CharacterCard`,
`user`, and input-state wrappers never become story delimiters automatically.
Enabled keyword entries are conditional candidates, not proof of activation.
Optional or prohibited output blocks are not treated as unconditional requirements.

For `萧谴写卡助手版_V4.5.1`, `maintext`, `Status_block`,
`character_design_complex`, `character_design_simple`, `rule_setting_complex`,
`rule_setting_simple`, and `world_view` describe generated artifacts. They are
shown as template evidence rather than mandatory wrappers for every assistant
reply. Fenced artifacts remain literal to the runtime parser. The adapter also
reports the greeting template's repeated `version` opener and the world-building
template's conflicting label. It does not silently edit the authoring worldbook.

Regex configuration remains under the preset/character owner's control. The
inspector uses SillyTavern's native regex engine rather than implementing another
regex dialect. If a rule still removes valid narrative, repair its boundaries
at the source; normalizing history cannot make every arbitrary rule safe.

## Connections and data

The connection adapter follows the reference implementation in
`st-memory-enhancement/services/optimizationApi.js`: current chat-completion
settings, saved Connection Manager profiles, native parameter conversion,
native request service, secret IDs, explicitly selected proxies, and model lists.
It clones settings and never switches the active connection.

Local analysis makes no AI request. Clicking AI repair sends the selected
conversation sources, relevant preset excerpts, bounded card-protocol evidence,
variables, diagnostics, and memory tables to the selected connection. Provider credentials
remain in the native request path and are not included in reports. Exported
reports contain conversation text and should be treated as private.

If server verification is unavailable, the extension reports that uncertainty
and retains the in-memory change and backup. It does not silently claim success
or overwrite a potentially newer server state.
The native chat endpoint does not offer atomic content-version conditional
writes: a simultaneous edit between the preflight read and save remains a host
limitation. Server conflicts already present before saving are rejected.

The reference `st-memory-enhancement` integration synchronizes `tableEditMatches`
when repaired state already represents those commands, preventing a render from
replaying them. Affected cached Sheet instances are invalidated before reload so
new or restored historical cells are rebuilt. Unsupported extension versions or
later independent source mutations can still require inspection; post-reload
verification reports a mismatch instead of declaring success.

## Install and develop

In SillyTavern, open **Extensions → Install extension**, enter
`https://github.com/Latias94/st-context-helper`, and install it for your user.
Refresh SillyTavern, then open **Extensions → 上下文助手**.

For development from a local checkout, use the installer below.
No bundler or dependencies are required.

```console
python tools/install.py --sillytavern /path/to/SillyTavern --user default-user
npm test
npm run check
```

The installer copies runtime files into the selected user's
`data/<user>/extensions/st-context-helper` directory. It does not modify other
extensions. Refresh SillyTavern to load a new or updated installation.

The native host integration uses `SillyTavern.getContext()`, its chat array,
selected swipe/variable slots, `saveChat()`, and the standard chat-read endpoints.
This is the same persisted message structure used by Tavern Helper's
`setChatMessages`; Tavern Helper is not a runtime dependency.

## Source map

| Module | Responsibility |
| --- | --- |
| `adapters.js` | Preset recognition and protocol preferences |
| `protocols.js` | Bounded card evidence and conditional output requirements |
| `tags.js` | Bounded protocol inspection and normalization |
| `analysis.js` | Native regex tracing and context diagnostics |
| `regex.js` | Rule inventory, native toggle validation, and bounded policy recognition |
| `diagnostics.js` | Chinese next-step guidance and repair outcome summaries |
| `repair.js` | Local recovery and validated AI proposals |
| `persistence.js` | Snapshots, selected-swipe updates, table cells, verified save, undo |
| `host.js` | SillyTavern APIs, prompt capture, and optional incoming normalization |
| `memory.js` | Optional reference-memory cache invalidation before native reload |
| `api.js` | Native connections and repair requests |
| `ui.js` | Inspector, diagnosis, repair previews |

Licensed under AGPL-3.0-only, consistent with the host project and derived
reference integration.
