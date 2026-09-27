"""Replaces fetch('/api/v1/agent/chat') in the chat page with a scripted SSE stream.
window.__chatScripts is a queue of arrays of string chunks; each chat request consumes one."""
import json

INIT = r"""
(() => {
  const realFetch = window.fetch.bind(window);
  window.__chatScripts = [];
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v1/agent/chat')) {
      const chunks = window.__chatScripts.shift() || [];
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          controller.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    }
    if (url.includes('/api/v1/conversations')) {
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };
})();
"""


def event(name, data):
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


def turn(answer, blocks=None, split_done_at=None, conversation_id=None):
    """Chunks for one agent turn. split_done_at cuts the done event's data line after N characters."""
    chunks = [event("token", {"delta": answer})]
    done = {"answer": answer, "model": "soclaas", "sources": [], "blocks": blocks or []}
    if conversation_id:
        done["conversationId"] = conversation_id
    text = event("done", done)
    if split_done_at:
        chunks += [text[:split_done_at], text[split_done_at:]]
    else:
        chunks.append(text)
    return chunks


def send(page, message, chunks):
    page.evaluate("chunks => window.__chatScripts.push(chunks)", chunks)
    page.fill("#message-input", message)
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled")
    page.wait_for_timeout(300)
