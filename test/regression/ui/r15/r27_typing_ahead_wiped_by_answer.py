"""The hiring box stays editable while an instruction is answered (the interpreter is a model call, seconds).
When the answer arrives, the submit handler clears the box unconditionally (`say.value = ""`), so whatever the
founder typed meanwhile (the next instruction, or a correction of the one in flight) is thrown away. The stale
path next to it already checks `say.value.trim() === text` before clearing; the normal path does not.
/say is answered by the test; the server is untouched.
Passes if the text typed while the first instruction was in flight is still in the box after its answer."""
import _setup  # noqa: F401
import json
from common import *

r = Result("r27 text typed into the hiring box while an instruction is answered is wiped")
a = "rolea"
base = state(a)
held = []

with browser_page(1440, 900) as (page, console):
    page.route(f"**/api/recruiting/roles/{a}/say", lambda route: held.append(route))
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.fill("#say", "pass on Bob, too corporate")
    page.press("#say", "Enter")
    page.wait_for_timeout(300)
    r.check(len(held) == 1, f"control: the first instruction is in flight ({len(held)})")
    # The founder writes the next instruction while waiting.
    page.fill("#say", "keep Cara, great TypeScript")
    typed = page.input_value("#say")
    held[0].fulfill(status=200, content_type="application/json",
                    body=json.dumps({"result": {"intent": "feedback", "message": "Noted: pass Bob Lim."}, "state": base}))
    page.wait_for_function("() => document.querySelector('#agent-reply').textContent.includes('Noted')", timeout=5000)
    page.wait_for_timeout(200)
    left = page.input_value("#say")
    r.check(typed == "keep Cara, great TypeScript", f"control: the next instruction was typed ({typed!r})")
    r.check(left == typed, f"the instruction typed while waiting is still in the box (box now: {left!r})")
r.finish(console, allow_console=True)
