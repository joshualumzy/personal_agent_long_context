"""draftDirty (the founder touched the draft criteria) is cleared only by this panel's own "Confirm and search"
button or a role switch. A founder who adjusts a criterion in the review panel and then says "looks good, go"
in the chat has the role confirmed by the agent: the panel's next poll shows the board and the review is gone
for good, but draftDirty stays true. Round 13 made hasUnsavedText answer draftDirty, so this board panel
never folds and keeps polling for as long as the chat is open. (Toggling a kind and toggling it back does
the same while the review is still up.)
The panel's state is answered by the test: the draft role becomes confirmed after the edit.
Passes if, once the board shows and a new panel arrives, the old panel no longer polls."""
import _setup  # noqa: F401
import json
from common import *
from _r14 import open_panel, new_panel_then_count_polls, INIT

r = Result("c38 criteria touched before the role was confirmed from the chat keep the panel live and polling forever")
d = "roledraft"
draft_state = state(d)
confirmed = json.loads(json.dumps(state("rolea")))
confirmed["role"] = {**draft_state["role"], "confirmed": True}
current = {"body": json.dumps(draft_state)}

with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.route(f"**/api/recruiting/roles/{d}/state", lambda route: route.fulfill(status=200, content_type="application/json", body=current["body"]))
    page.goto(f"{BASE}/")
    old_frame = open_panel(page, {"type": "recruiting", "view": "criteria", "roleId": d}, "set up a data analyst role")
    old_frame.wait_for_selector("#review:not([hidden]) .kind-toggle", timeout=15000)
    old_frame.click("#draft-criteria li:nth-child(2) .kind-toggle")
    # The founder then confirms in the chat; the agent confirms the role and the next poll shows the board.
    current["body"] = json.dumps(confirmed)
    page.click("#message-input")
    old_frame.wait_for_selector("#board:not([hidden]) #nodes .node", timeout=12000)
    review_hidden = old_frame.eval_on_selector("#review", "e => e.hidden")
    r.check(review_hidden, f"control: the panel now shows the board and the review is gone (review hidden: {review_hidden})")
    polls, live = new_panel_then_count_polls(page, old_frame, "rolea")
    r.check(polls == 0, f"the old panel, with no review left to lose, stops polling ({polls} state requests from it in 11 s; live panels: {live})")
r.finish(console, allow_console=True)
