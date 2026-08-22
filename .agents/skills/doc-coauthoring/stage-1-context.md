# Stage 1: Context Gathering

## Initial questions

Ask for meta-context: doc type, primary audience, desired impact when someone reads it, whether there's a template/format to follow, other constraints. Let them answer in shorthand or dump freely.

If they mention a template or doc type: ask for a template document to share; fetch it via integration if it's a link, read it if it's a file.

If they mention editing an existing shared document: read the current state via integration. Check for images without alt-text — if any exist, explain that Claude won't be able to see them when someone pastes the doc in later, and offer to generate alt-text if they paste each image into chat.

## Info dumping

Once initial questions are answered, encourage a full info dump: background on the project/problem, related team discussions, why alternatives aren't being used, organizational context, timeline pressures, technical architecture, stakeholder concerns. Tell them not to worry about organizing it.

If integrations are available (Slack, Teams, Drive, SharePoint, other MCP servers), mention they can be used to pull context directly. If none are detected and this is claude.ai/the Claude app, suggest enabling connectors. If the user mentions an unknown entity/project, ask before searching connected tools for it — wait for confirmation.

Track what's being learned and what's still unclear as context comes in.

## Clarifying questions

Once the user signals they're done dumping (or has provided substantial context), generate 5–10 numbered questions targeting the gaps. Let them answer in shorthand ("1: yes, 2: see #channel, 3: no because backwards compat"), link to more docs, or keep dumping.

**Exit condition:** you can ask about edge cases and trade-offs without needing the basics re-explained. Ask if they want to add more before moving to Stage 2.
