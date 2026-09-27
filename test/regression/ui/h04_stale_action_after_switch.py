"""An action on role A that answers after the founder switched to role B must not paint A's board under B's id.
'Find more people' on A is held by the test (then answered with A's current state, never reaching the server)."""
import json
import threading
from common import *

r = Result("h04 late response from previous role overwrites the new role")
a, b = role_a(), role_b()
title_a, title_b = title(a), title(b)
held = []
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/more", lambda route: held.append(route))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click("#find-more")
    page.wait_for_timeout(300)
    r.check(len(held) == 1, "find-more request for A is in flight")
    page.select_option("#role-select", b)
    page.wait_for_function(f"document.querySelector('#role-title').textContent === {title_b!r}")
    # now A's slow answer arrives
    held[0].fulfill(status=200, content_type="application/json", body=json.dumps({"result": {"added": 0}, "state": state(a)}))
    page.wait_for_timeout(700)
    shown = page.text_content("#role-title")
    url_role = page.evaluate("new URLSearchParams(location.search).get('role')")
    selected = page.eval_on_selector("#role-select", "s => s.value")
    nodes = page.locator("#nodes .node").count()
    r.check(shown == title_b, f"title still shows B ({title_b!r}); actual {shown!r} while URL role={url_role}, select={selected}")
    r.check(nodes == len([c for c in state(b)['candidates'] if c['tier'] in (100, 75, 50) and c['stage'] != 'closed']),
            f"orbit shows B's pool, not A's ({nodes} nodes)")
    reply = page.text_content("#agent-reply")
    r.check(not reply, f"A's 'find more' reply not shown on B (agent-reply: {reply!r})")
r.finish(console)
