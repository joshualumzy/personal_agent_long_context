"""The hiring box offers the example "Pass on this one, too corporate". "This one" is the person whose drawer is
open, but the page sends /say only { text }: nothing says who is open. The server's interpreter gets the text
plus every candidate's id and name and must guess; the best case is "I could not tell ...", the worst is a pass
(which closes the person) landing on someone else. A founder who opens Bob and presses that hint has no way
to know. The say request is answered by the test and records what the page sent.
Passes if the request identifies the open candidate in any way (an id field, or the name written into the text)."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r26 'Pass on this one' is sent without saying who 'this one' is")
a = "rolea"
base = state(a)
said = []


def handler(route):
    said.append(route.request.post_data or "")
    route.fulfill(status=200, content_type="application/json",
                  body=json.dumps({"result": {"intent": "unknown", "message": "ok"}, "state": base}))


# A wide screen: the drawer leaves the hiring box and its hints uncovered (at 1440 px it overlaps them).
with browser_page(1920, 1080) as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/say", handler)
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    # Open someone who is not first in the list, so a guess of "the first one" is not right by luck.
    bob = next(c for c in base["candidates"] if c["profile"]["name"] == "Bob Lim")
    node = page.locator("#nodes .node[aria-label^='Bob Lim']")
    node.click()
    page.wait_for_selector("#drawer:not([hidden]) h3")
    opened = page.inner_text("#drawer h3")
    page.click(".hint:has-text('Pass on this one')")
    hint_text = page.input_value("#say")
    page.press("#say", "Enter")
    page.wait_for_function("() => !document.querySelector('#say').value", timeout=5000)
    page.wait_for_timeout(300)
    r.check(opened == "Bob Lim", f"control: Bob's drawer is open ({opened!r})")
    r.check(hint_text.startswith("Pass on this one"), f"control: the hint filled the box ({hint_text!r})")
    r.check(len(said) == 1, f"control: one say request went out ({said})")
    body = said[0] if said else ""
    r.check(bob["id"] in body or "Bob Lim" in body or "Bob" in body,
            f"the request says who 'this one' is (open: Bob Lim, id {bob['id']}; sent {body})")
r.finish(console, allow_console=True)
