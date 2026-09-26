"""Same hole as c31, in the criteria review. renderReview builds each criterion box with its (edited) text as
the value attribute, so once the list is redrawn (the founder flips another criterion between must and nice,
or removes one) every edit made so far is the box's defaultValue and holdsUnsavedText sees nothing unsaved.
The founder then asks the agent something; the new panel folds the review, and the edited criteria (kept only
in the iframe's draftCriteria) are gone: reopening shows the server's draft.
The chat stream is scripted in the page; the review reads the seeded draft role, and nothing is saved.
Passes if the edited criterion is still on screen afterwards, or comes back when the old panel is reopened."""
import _setup  # noqa: F401
from common import *
from chatfake import turn
from _chatfake4 import INIT

EDIT = " and PostgreSQL tuning"

r = Result("c32 a criteria edit is thrown away when the list was redrawn before a new panel arrives")
d = "roledraft"


def typed_values(page):
    values = []
    for f in page.query_selector_all(".chat-block iframe"):
        content = f.content_frame()
        if content:
            values += content.eval_on_selector_all("input, textarea", "els => els.map(e => e.value)")
    return values


def edited(values):
    return any(EDIT.strip() in value for value in values)


with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    block = {"type": "recruiting", "view": "criteria", "roleId": d}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Check these criteria.", [block], conversation_id="cA"))
    page.fill("#message-input", "hire a data analyst")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('.chat-block.live iframe')")
    panel = page.frame_locator(".chat-block.live iframe")
    first = panel.locator("#draft-criteria input[aria-label='Criterion 1']")
    first.wait_for(timeout=15000)
    # The founder sharpens the first criterion...
    first.click()
    page.keyboard.press("End")
    page.keyboard.type(EDIT)
    # ...and makes the second one a must (the list is redrawn, the edit kept).
    panel.locator("#draft-criteria li:nth-child(2) .kind-toggle").click()
    page.wait_for_timeout(200)
    r.check(edited(typed_values(page)), f"control: the edit is still in the review after the redraw ({typed_values(page)})")
    # Then asks the agent something before confirming; the answer brings another panel.
    other = {"type": "recruiting", "view": "pool", "roleId": "rolea"}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is the backend role.", [other], conversation_id="cA"))
    page.click("#message-input")
    page.keyboard.type("how is the backend role going?")
    page.keyboard.press("Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Here is the backend role.')")
    page.wait_for_timeout(800)
    values = typed_values(page)
    folded = page.query_selector_all(".chat-block-reopen")
    if not edited(values) and folded:
        for button in folded:
            button.click()
        page.wait_for_timeout(300)
        for f in page.query_selector_all(".chat-block.live iframe"):
            content = f.content_frame()
            if content:
                try:
                    content.wait_for_selector("#review:not([hidden]) input, #board:not([hidden])", timeout=10000)
                except Exception:
                    pass
        page.wait_for_timeout(2500)
        values = typed_values(page)
    r.check(edited(values), f"the edited criterion is still on screen, or back once its panel is reopened (values in frames: {values})")
r.finish(console, allow_console=True)
