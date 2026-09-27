"""Embedded pool panel (chat frame 360px to 560px tall) with two proposals: both proposals' buttons and
'Find more people' must be reachable (the embed body does not scroll). State rewritten in the browser."""
import json
import os
from common import *

r = Result("h23 embedded rail clips proposals")
a = role_a()

def rewrite(route):
    response = route.fetch()
    data = response.json()
    data["proposals"] = [
        {"id": "p1", "type": "criterion", "rationale": "You passed on four people who only worked at large banks. Should I avoid that background?", "kind": "nice", "text": "Has worked at a company under 200 people"},
        {"id": "p2", "type": "expansion", "stepName": "Widen to remote", "rationale": "No one has replied in two weeks and the Singapore pool is thin.", "query": "backend engineers in Southeast Asia open to relocation"},
    ]
    data["proposals"] = data["proposals"][: int(os.environ.get("PROPOSALS", "2"))]
    route.fulfill(response=response, body=json.dumps(data))

for h in [360, 460, 560]:
    with browser_page(1440, 900) as (page, console):
        page.route(f"**/api/recruiting/roles/{a}/state", rewrite)
        frame = embed(page, f"embed=1&role={a}", 1100, h)
        wait_board(frame)
        m = frame.evaluate("""() => {
          const items = [...document.querySelectorAll('.proposal button, #find-more')];
          const out = [];
          // no programmatic scrolling: body.embed is overflow hidden, so the user cannot scroll the page.
          // An item inside the scrollable criteria list counts as reachable if that list can scroll to it.
          for (const e of items) {
            const b = e.getBoundingClientRect();
            const list = e.closest('.criteria-panel');
            if (list && list.scrollHeight > list.clientHeight && list.getBoundingClientRect().bottom <= innerHeight + 1) continue;
            if (b.bottom > innerHeight + 1 || b.top < -1) out.push([e.textContent.trim(), Math.round(b.top), Math.round(b.bottom)]);
          }
          return { out, ih: innerHeight, sh: document.scrollingElement.scrollHeight, overflow: getComputedStyle(document.body).overflowY };
        }""")
        r.check(not m["out"], f"{h}px frame: reachable, unreachable = {m['out']} (frame {m['ih']}, content {m['sh']}, body overflow-y {m['overflow']})")
r.finish()
