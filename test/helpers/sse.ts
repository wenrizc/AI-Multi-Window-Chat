/**
 * Helpers for exercising the provider SSE parser with realistic byte chunks.
 */

export function encodeSse(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    }
  });
}

export function createSseResponse(lines: string[]): Response {
  return new Response(encodeSse(lines), {
    headers: {
      'Content-Type': 'text/event-stream'
    }
  });
}

/** Build a chunked SSE stream where each entry is delivered as its own chunk. */
export function createChunkedSseResponse(chunks: string[]): Response {
  return createSseResponse(chunks);
}
