import { describe, it, expect } from "vitest";

import { parseSseFrames } from "@/lib/sse";

describe("parseSseFrames", () => {
  it("parses two complete frames in one buffer", () => {
    const { messages, rest } = parseSseFrames(
      "data: {one}\n\ndata: {two}\n\n",
    );
    expect(messages).toEqual(["{one}", "{two}"]);
    expect(rest).toBe("");
  });

  it("carries a frame split across two calls (the footgun)", () => {
    const first = parseSseFrames("data: {par");
    expect(first.messages).toEqual([]);
    expect(first.rest).toBe("data: {par");

    const second = parseSseFrames(first.rest + "tial}\n\n");
    expect(second.messages).toEqual(["{partial}"]);
    expect(second.rest).toBe("");
  });

  it("joins multi-line data fields in one frame", () => {
    const { messages, rest } = parseSseFrames("data: {\ndata: }\n\n");
    expect(messages).toEqual(["{\n}"]);
    expect(rest).toBe("");
  });

  it("ignores comment / heartbeat lines and parses the frame", () => {
    const { messages, rest } = parseSseFrames(": keep-alive\ndata: {ok}\n\n");
    expect(messages).toEqual(["{ok}"]);
    expect(rest).toBe("");
  });

  it("returns a trailing partial with no blank line as rest", () => {
    const { messages, rest } = parseSseFrames("data: {partial}");
    expect(messages).toEqual([]);
    expect(rest).toBe("data: {partial}");
  });

  it("treats CRLF frame separators the same as LF", () => {
    const { messages, rest } = parseSseFrames(
      "data: {one}\r\n\r\ndata: {two}\r\n\r\n",
    );
    expect(messages).toEqual(["{one}", "{two}"]);
    expect(rest).toBe("");
  });
});
