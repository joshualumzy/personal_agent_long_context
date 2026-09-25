"""Board at 1440x900 and 1600x900 with two open proposals and eight criteria: still one screen, and the composer,
'Find more people' and the proposal buttons all on screen. State rewritten in the browser."""
import json
from common import *

r = Result("h22 rail overflow with proposals")
a = role_a()

def rewrite(route):
    response = route.fetch()
    data = response.json()
    base = data["criteria"][0]
    data["criteria"] = [dict(base, id=f"c{i}", text=f"Criterion number {i} with some realistic length text", kind="must" if i < 4 else "nice") for i in range(8)]
    data["proposals"] = [
        {"id": "p1", "type": "criterion", "rationale": "You passed on four people who only worked at large banks. Should I avoid that background?", "kind": "nice", "text": "Has worked at a company under 200 people"},
        {"id": "p2", "type": "expansion", "stepName": "Widen to remote", "rationale": "No one has replied in two weeks and the Singapore pool is thin.", "query": "backend engineers in Southeast Asia open to relocation"},
    ]
    route.fulfill(response=response, body=json.dumps(data))

for w, h in [(1440, 900), (1600, 900)]:
    with browser_page(w, h) as (page, console):
        page.route(f"**/api/recruiting/roles/{a}/state", rewrite)
        page.goto(f"{BASE}/recruiting?role={a}")
        wait_board(page)
        m = page.evaluate("""() => ({ sh: document.scrollingElement.scrollHeight, ih: innerHeight,
          off: [...document.querySelectorAll('.rail button, .rail textarea')].filter(e => e.getClientRects().length)
            .map(e => [e.id || e.className || e.textContent.trim().slice(0, 20), e.getBoundingClientRect().bottom])
            .filter(([, b]) => b > innerHeight + 1) })""")
        r.check(m["sh"] <= m["ih"], f"{w}x{h}: no page scroll ({m['sh']} vs {m['ih']})")
        r.check(not m["off"], f"{w}x{h}: rail controls on screen, off-screen: {m['off']}")
        r.check(not console.errors, f"no console errors {console.errors}")
r.finish()
