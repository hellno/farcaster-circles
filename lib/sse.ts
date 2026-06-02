// Pure, DOM-free SSE (Server-Sent Events) frame parser. No browser APIs, so it
// is trivially unit-testable in a node env. The onboarding client feeds it the
// running text buffer; it hands back the complete frame payloads plus the
// leftover partial text to prepend to the next network chunk.

export interface SseParseResult {
  /** Complete frame payloads — each frame's joined `data:` lines. */
  messages: string[];
  /** Leftover text with no terminating blank line yet; feed back in next call. */
  rest: string;
}

/**
 * Accumulate streamed `text/event-stream` text and split it into complete
 * frames on a blank line ("\n\n"). For each complete frame, the `data:` field
 * lines are joined (per the SSE spec, with "\n") into one payload string.
 * Comment lines (starting with ":") and non-`data` fields are ignored.
 *
 * The trailing text after the last blank line is returned as `rest` so a frame
 * split across two network reads still parses: the caller prepends `rest` to
 * the next chunk before calling again.
 */
export function parseSseFrames(buffer: string): SseParseResult {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  // The last element is the unterminated remainder (empty if the buffer ended
  // on a blank line). Everything before it is a complete frame.
  const rest = parts.pop() ?? "";

  const messages: string[] = [];
  for (const frame of parts) {
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue; // comment / heartbeat
      if (line.startsWith("data:")) {
        // Strip the field name and an optional single leading space.
        data.push(line.slice(5).replace(/^ /, ""));
      }
      // Other fields (event:, id:, retry:) are ignored.
    }
    if (data.length > 0) messages.push(data.join("\n"));
  }

  return { messages, rest };
}
