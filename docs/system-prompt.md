# System Prompt

The system prompt defines the agent's personality, rules, and behavioral patterns. It is built at the start of each agent run from three parts (see `src/agent.ts:94-158`).

## Structure

```
┌──────────────────────────────────┐
│ HEAD     (~130 lines)            │
│ Core identity, approach,         │
│ execution strategies,            │
│ verification rules               │
├──────────────────────────────────┤
│ Tool List (auto-generated)       │
│ <tool>(<params>) — description   │
│ ...                              │
├──────────────────────────────────┤
│ TAIL     (~25 lines)             │
│ Initiative, autonomy, creativity │
│ Language matching instruction    │
└──────────────────────────────────┘
```

## HEAD

### CORE IDENTITY
Defines the agent as autonomous and proactive — not a chatbot. It should anticipate needs, act unprompted, be curious, and surprise with useful information.

### APPROACH
How the agent tackles problems: plan first, execute immediately without permission-seeking, chain tools in sequence, and think "what else would be useful?"

### EXECUTION STRATEGIES
Concrete rules for tool usage: act before describing, try different approaches on failure, use `create_tool` when existing tools are insufficient, gather real data before composing messages.

### VERIFICATION
Quality checks before presenting answers: did it fully answer the question? Is the result complete? Try at least 3 approaches before giving up. Add something extra.

## TAIL

### INITIATIVE
Take the lead after answering — check on scheduled tasks, weather, news. Set up background tasks without being asked.

### AUTONOMY
Never ask permission — just do it and report. Make independent choices about tools, approach, and follow-up actions.

### CREATIVITY
Build things, not just text. Write scripts, create tools, generate images, schedule tasks, combine tools into automated workflows.

### Language matching
The final instruction: *"Answer in the same language the user wrote their message in. If they write in French, answer in French. If they write in English, answer in English. Match their language exactly."*

This is the most critical behavioral instruction — it prevents the agent from responding in English to French queries (and vice versa).

## Tool list generation

The tool list is built dynamically from all registered tools:

```ts
private buildToolDescriptions(): string {
  return this.toolRegistry.list().map(t => {
    const params = t.parameters?.properties
      ? Object.keys(t.parameters.properties).join(', ')
      : ''
    return `- ${t.name}(${params}) — ${t.description}`
  }).join('\n')
}
```

Each tool appears as: `tool_name(param1, param2) — description text`

## Pre-planning + RAG injection

Before the system prompt reaches Ollama, two additional layers are injected:

1. **RAG context** — relevant past tool results and knowledge chunks from the database, injected as:
   ```
   Previous relevant information:
   - [tool_name] result text...
   ```
2. **Context summary** — if history exceeds ~8000 chars, older messages are summarized into a paragraph.

## Modifying the prompt

Edit the constants in `src/agent.ts`:
- `SYSTEM_PROMPT_HEAD` (line 96) — identity, approach, strategies, verification
- `SYSTEM_PROMPT_TAIL` (line 131) — initiative, autonomy, creativity, language

Changes take effect on server restart. The tool list is always auto-generated from the registry — no manual updates needed when adding tools.
