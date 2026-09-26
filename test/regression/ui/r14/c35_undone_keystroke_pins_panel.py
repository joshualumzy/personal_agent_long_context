"""Round 13's window.hasUnsavedText counts any non-empty entry in typedDrafts as unsaved. An entry is written on
every keystroke and holds the box's whole value, so a stray key the founder takes back (types a letter, presses
Backspace) leaves an entry equal to the saved draft. Nothing differs from what the server holds, yet the panel
reports unsaved text for as long as it exists: every later panel leaves it live and it keeps polling the server.
Passes if, after the undone keystroke and a new panel, the old panel no longer polls."""
import _setup  # noqa: F401
import json
from common import *
from _r14 import with_drafted_alice, open_panel, new_panel_then_count_polls, INIT

r = Result("c35 a keystroke taken back leaves the panel live and polling forever")
a = "rolea"
base = state(a)
alice = base["candidates"][0]
STATE = json.dumps(with_drafted_alice(base, alice["id"]))

with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.route(f"**/api/recruiting/roles/{a}/state", lambda route: route.fulfill(status=200, content_type="application/json", body=STATE))
    page.goto(f"{BASE}/")
    old_frame = open_panel(page, {"type": "recruiting", "view": "candidate", "roleId": a, "candidateId": alice["id"]})
    panel = page.frame_locator(".chat-block.live iframe")
    body = panel.locator("#drawer textarea[aria-label='Message']")
    body.wait_for(timeout=15000)
    body.click()
    page.keyboard.press("End")
    page.keyboard.type("x")
    page.keyboard.press("Backspace")
    r.check(body.input_value() == "Hi Alice,", f"control: the message is back to the saved draft ({body.input_value()!r})")
    polls, live = new_panel_then_count_polls(page, old_frame, a)
    r.check(polls == 0, f"the old panel, identical to what is saved, stops polling ({polls} state requests from it in 11 s; live panels: {live})")
r.finish(console, allow_console=True)
