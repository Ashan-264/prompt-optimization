// Yields the payload of each "data: " frame in an SSE response.
//
// A chunk boundary can land anywhere, including mid-line and mid-character, so
// the tail of each chunk is buffered until the next newline arrives and the
// decoder is kept in streaming mode. Splitting each chunk on its own dropped
// or corrupted whatever straddled the boundary.
export async function* readSseData(
  response: Response
): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) yield line.slice(6);
      }
    }

    buffer += decoder.decode();
    if (buffer.startsWith("data: ")) yield buffer.slice(6);
  } finally {
    reader.releaseLock();
  }
}
