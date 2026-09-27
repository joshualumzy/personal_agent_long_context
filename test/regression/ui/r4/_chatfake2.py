"""Scripted chat backend for the r4 chat checks (the page's fetch is replaced; no model, no database).
window.__chatScripts: queue of chunk arrays, one per chat request. A chunk equal to "HOLD" pauses the stream
until window.__release() is called. window.__chatBodies records each chat request body.
window.__conversations: list for GET /api/v1/conversations; window.__details[id]: GET detail body;
window.__detailGates[id]: when set, that detail answers only after window.__openGate(id)."""

INIT = r"""
(() => {
  const realFetch = window.fetch.bind(window);
  window.__chatScripts = [];
  window.__chatBodies = [];
  window.__conversations = [];
  window.__details = {};
  window.__detailGates = {};
  let release = null;
  window.__release = () => { if (release) { const r = release; release = null; r(); } };
  const gates = {};
  window.__openGate = (id) => { (gates[id] || []).forEach((r) => r()); gates[id] = []; };
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v1/agent/chat')) {
      window.__chatBodies.push(JSON.parse(init.body));
      const chunks = window.__chatScripts.shift() || [];
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            if (chunk === 'HOLD') { await new Promise((resolve) => { release = resolve; }); continue; }
            controller.enqueue(encoder.encode(chunk));
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const detail = url.match(/\/api\/v1\/conversations\/([^?]+)/);
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      if (window.__detailGates[id]) await new Promise((resolve) => { (gates[id] = gates[id] || []).push(resolve); });
      return json(window.__details[id] || { messages: [] });
    }
    if (url.includes('/api/v1/conversations')) return json(window.__conversations);
    return realFetch(input, init);
  };
})();
"""
