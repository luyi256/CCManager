/** Matches the context block the server appends to a handed-off prompt. */
const HANDOFF_CONTEXT = /\n\n---\nContext: this continues CCManager task #(\d+)[\s\S]*$/;

/** Splits a handed-off prompt into the user's message and its source task. */
export function splitHandoffPrompt(prompt: string): { message: string; sourceTaskId?: number } {
  const match = prompt.match(HANDOFF_CONTEXT);
  if (!match || match.index === undefined) return { message: prompt };
  return { message: prompt.slice(0, match.index), sourceTaskId: Number(match[1]) };
}
