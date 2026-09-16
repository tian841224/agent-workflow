# Stage 1: Context Gathering

## Initial questions

Ask only for missing meta-context that would change the document: type, audience, desired reader action, required template, or material constraints. If the brief already supplies these, start from it.

If they mention a template or doc type: ask for a template document to share; fetch it via integration if it's a link, read it if it's a file.

If they mention editing an existing shared document: read the current state via integration. Check for images without alt-text — if any exist, explain that Claude won't be able to see them when someone pastes the doc in later, and offer to generate alt-text if they paste each image into chat.

## Info dumping

Once the needed basics are clear, invite the user to add relevant background, decisions, constraints, architecture, and stakeholder concerns. They can provide it in any order.

If integrations are available (Slack, Teams, Drive, SharePoint, other MCP servers), mention they can be used to pull context directly. If none are detected and this is claude.ai/the Claude app, suggest enabling connectors. If the user mentions an unknown entity/project, ask before searching connected tools for it — wait for confirmation.

Track what's being learned and what's still unclear as context comes in.

## Clarifying questions

Once the user signals they're done (or has provided substantial context), ask only the questions that close material gaps. Use as many as the document needs, including none; accept shorthand answers, links, or more context.

**Exit condition:** edge cases and trade-offs can be discussed without re-explaining the basics. Move on when the stated goal and audience are sufficient for the next stage.
