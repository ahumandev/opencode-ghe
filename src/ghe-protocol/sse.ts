import { GheProtocolError, MalformedResponseError, NetworkError, StreamTerminationError } from "./errors.ts";
import { asObject, normalizeChatEvent, normalizeResponsesEvent } from "./normalize.ts";
import type { NormalizedStreamEvent } from "./types.ts";

interface SseEvent { readonly event: string; readonly data: string; }

export async function* parseStream(body: ReadableStream<Uint8Array> | null, endpoint: "chat" | "responses", requestId: string): AsyncGenerator<NormalizedStreamEvent> {
  if (body === null) throw new MalformedResponseError(requestId);
  let completed = false;
  const toolIds = new Map<number, string>();
  try {
    for await (const event of parseSse(body)) {
      if (event.data === "[DONE]" && event.event === "") { completed = true; break; }
      let value: unknown;
      try { value = JSON.parse(event.data) as unknown; } catch { throw new MalformedResponseError(requestId); }
      const payload = asObject(value); if (payload === undefined) throw new MalformedResponseError(requestId);
      const type = event.event || (typeof payload.type === "string" ? payload.type : "");
      if (type.endsWith("failed") || type.endsWith("error")) throw new MalformedResponseError(requestId);
      if (endpoint === "chat") {
        for (const normalized of normalizeChatEvent(payload, toolIds)) yield normalized;
      } else {
        for (const normalized of normalizeResponsesEvent(type, payload)) yield normalized;
        if (type === "response.completed") completed = true;
      }
    }
  } catch (error: unknown) {
    if (error instanceof GheProtocolError) throw error;
    throw new NetworkError(requestId);
  }
  if (!completed) throw new StreamTerminationError(requestId);
}
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder(); let buffer = ""; let data: string[] = []; let event = "";
  const emit = (): SseEvent | undefined => { if (data.length === 0) return undefined; const value = { event, data: data.join("\n") }; data = []; event = ""; return value; };
  const reader = body.getReader();
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) { completed = true; break; }
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split(/\r\n|\n|\r/); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") { const value = emit(); if (value !== undefined) yield value; continue; }
        if (line.startsWith(":")) continue;
        const separator = line.indexOf(":"); const field = separator < 0 ? line : line.slice(0, separator); const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "data") data.push(value); else if (field === "event") event = value;
      }
    }
    buffer += decoder.decode();
    if (buffer !== "") {
      const separator = buffer.indexOf(":"); const field = separator < 0 ? buffer : buffer.slice(0, separator); const lineValue = separator < 0 ? "" : buffer.slice(separator + 1).replace(/^ /, "");
      if (field === "data") data.push(lineValue); else if (field === "event") event = lineValue;
    }
    const value = emit(); if (value !== undefined) yield value;
  } finally {
    if (!completed) {
      try { await reader.cancel(); } catch {}
    }
    try { reader.releaseLock(); } catch {}
  }
}
