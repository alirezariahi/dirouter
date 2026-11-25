/**
 * Tool-call pairing checks (card 31.1). Real providers answer 400 to a history with a tool call
 * that has no result, a result without its call, or a repeated call id; the mock does the same,
 * with the providers' own wording, so the gateway's repair can be tested end to end.
 */
type Json = Record<string, unknown>;

const list = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((v): v is Json => !!v && typeof v === 'object') : [];

/** Anthropic Messages: the first violation, or undefined when the history is valid. */
export function anthropicToolPairingError(body: Json): string | undefined {
  const messages = list(body.messages);
  const seen = new Set<string>();
  for (const [i, message] of messages.entries()) {
    const blocks = list(message.content);
    const uses = blocks.filter((b) => b.type === 'tool_use').map((b) => String(b.id));
    for (const id of uses) {
      if (seen.has(id)) return `messages.${String(i)}: \`tool_use\` ids must be unique: ${id}`;
      seen.add(id);
    }
    const previousUses = new Set(
      list(messages[i - 1]?.content)
        .filter((b) => b.type === 'tool_use')
        .map((b) => String(b.id)),
    );
    for (const result of blocks.filter((b) => b.type === 'tool_result'))
      if (!previousUses.has(String(result.tool_use_id)))
        return `messages.${String(i)}.content: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${String(result.tool_use_id)}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`;
    if (message.role === 'assistant' && uses.length > 0 && i < messages.length - 1) {
      const answered = new Set(
        list(messages[i + 1]?.content)
          .filter((b) => b.type === 'tool_result')
          .map((b) => String(b.tool_use_id)),
      );
      const missing = uses.filter((id) => !answered.has(id));
      if (missing.length > 0)
        return `messages.${String(i)}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
    }
  }
  return undefined;
}

/** OpenAI Chat Completions: the first violation, or undefined when the history is valid. */
export function openAIToolPairingError(body: Json): string | undefined {
  const messages = list(body.messages);
  for (const [i, message] of messages.entries()) {
    if (message.role === 'tool') {
      let j = i - 1;
      while (j >= 0 && messages[j]?.role === 'tool') j--;
      const calls = list(messages[j]?.tool_calls).map((c) => String(c.id));
      if (!calls.includes(String(message.tool_call_id)))
        return "Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.";
    }
    const calls = list(message.tool_calls).map((c) => String(c.id));
    if (calls.length > 0 && i < messages.length - 1) {
      const answered = new Set<string>();
      for (let j = i + 1; messages[j]?.role === 'tool'; j++)
        answered.add(String(messages[j]?.tool_call_id));
      const missing = calls.filter((id) => !answered.has(id));
      if (missing.length > 0)
        return `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${missing.join(', ')}`;
    }
  }
  return undefined;
}
