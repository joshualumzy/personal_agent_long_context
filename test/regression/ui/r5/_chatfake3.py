"""Scripted chat backend for the r5 chat checks (the page's fetch is replaced; no model, no database).
window.__chatScripts: queue of chunk arrays, one per chat request. A chunk "HOLD:<name>" pauses that stream
until window.__release(name). window.__chatBodies records each chat request body.
window.__conversations: list for GET /api/v1/conversations; window.__details[id]: detail body;
window.__detailStatus[id]: HTTP status for that detail (default 200); window.__deleteStatus: status for DELETE
(default 200); window.__deletes records deleted ids."""

INIT = r"""
(() => {
  const realFetch = window.fetch.bind(window);
  window.__chatScripts = [];
  window.__chatBodies = [];
  window.__conversations = [];
  window.__details = {};
  window.__detailStatus = {};
  window.__deleteStatus = 200;
  window.__deletes = [];
  const holds = {};
  const released = new Set();
  window.__release = (name) => { released.add(name); (holds[name] || []).forEach((r) => r()); holds[name] = []; };
  window.__streamsOpen = 0;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init && init.method) || 'GET';
    if (url.includes('/api/v1/agent/chat')) {
      window.__chatBodies.push(JSON.parse(init.body));
      const chunks = window.__chatScripts.shift() || [];
      const encoder = new TextEncoder();
      window.__streamsOpen += 1;
      const body = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            if (chunk.startsWith('HOLD:')) {
              const name = chunk.slice(5);
              if (!released.has(name)) await new Promise((resolve) => { (holds[name] = holds[name] || []).push(resolve); });
              continue;
            }
            controller.enqueue(encoder.encode(chunk));
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          window.__streamsOpen -= 1;
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const detail = url.match(/\/api\/v1\/conversations\/([^?]+)/);
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      if (method === 'DELETE') {
        window.__deletes.push(id);
        if (window.__deleteStatus === 200) window.__conversations = window.__conversations.filter((c) => c.conversationId !== id);
        return json(window.__deleteStatus === 200 ? { deleted: true } : { message: 'database unavailable' }, window.__deleteStatus);
      }
      const status = window.__detailStatus[id] || 200;
      return json(status === 200 ? (window.__details[id] || { messages: [] }) : { message: 'failed' }, status);
    }
    if (url.includes('/api/v1/conversations')) return json(window.__conversations);
    return realFetch(input, init);
  };
})();
"""
