# Paw UI5 Figma MCP Handoff

Use Figma MCP to inspect and implement this editable prototype.

## Figma Source

- File: https://www.figma.com/design/thsDMEQKBsASiOzbX8Yk5U
- File key: `thsDMEQKBsASiOzbX8Yk5U`

## Frames

- Changes: https://www.figma.com/design/thsDMEQKBsASiOzbX8Yk5U?node-id=8-2
- Plan: https://www.figma.com/design/thsDMEQKBsASiOzbX8Yk5U?node-id=8-203
- Context: https://www.figma.com/design/thsDMEQKBsASiOzbX8Yk5U?node-id=8-406
- Memory: https://www.figma.com/design/thsDMEQKBsASiOzbX8Yk5U?node-id=8-621

## Suggested Claude Code Prompt

```text
Use Figma MCP to inspect the file:
https://www.figma.com/design/thsDMEQKBsASiOzbX8Yk5U

Implement a static interactive prototype based on these frames:
- Editable / Changes, node-id 8:2
- Editable / Plan, node-id 8:203
- Editable / Context, node-id 8:406
- Editable / Memory, node-id 8:621

Do not use screenshots as the UI.
Implement real layout/components in code.

Required behavior:
- Three-column app layout: sidebar, main conversation, right panel.
- Right panel tabs switch between Plan, Changes, Context, and Memory.
- Sidebar and composer can be static.
- Open in Editor can be a stub button.

Prioritize:
- Layout fidelity.
- Spacing and alignment.
- Typography and colors.
- No text overflow or broken wrapping.
- Reuse existing project components/styles if available.
- Do not add a new UI library unless the repo already uses one.
```

## Notes

The Figma file is editable, but it is reconstructed from screenshots, so use it as a visual/structural reference rather than a perfect design-system source.
