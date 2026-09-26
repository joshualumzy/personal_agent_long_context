"""Shared steps for the round 14 panel checks: show one panel, let the test act in it, ask for a new
panel, then count the state polls the old panel still makes (a folded or idle panel makes none)."""
import json
from common import *
from chatfake import turn
from _chatfake4 import INIT


def with_drafted_alice(base, alice_id, created="2026-09-01T00:00:00Z", body="Hi Alice,", stage="drafted"):
    later = json.loads(json.dumps(base))
    for c in later["candidates"]:
        if c["id"] == alice_id:
            c["stage"] = stage
            c["contact"] = {"email": "alice@example.com", "provider": "founder", "status": "verified"}
            c["draft"] = {"kind": "intro", "subject": "Hello", "body": body, "warnings": [], "createdAt": created}
    return later


def open_panel(page, block, text="show me"):
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here it is.", [block], conversation_id="cA"))
    page.fill("#message-input", text)
    page.press("#message-input", "Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('.chat-block.live iframe')")
    return page.query_selector(".chat-block iframe").content_frame()


def new_panel_then_count_polls(page, old_frame, role_id, seconds=11):
    """Asks the agent something that answers with the pool; returns (state polls by the old panel, live panels)."""
    pool = {"type": "recruiting", "view": "pool", "roleId": role_id}
    page.evaluate("chunks => window.__chatScripts.push(chunks)", turn("Here is everyone.", [pool], conversation_id="cA"))
    page.click("#message-input")
    page.keyboard.type("who else is there?")
    page.keyboard.press("Enter")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && document.querySelector('#chat-messages').textContent.includes('Here is everyone.')")
    page.wait_for_timeout(500)
    polls = []
    page.on("request", lambda request: request.url.endswith("/state") and request.frame == old_frame and polls.append(request.url))
    page.wait_for_timeout(seconds * 1000)
    return len(polls), len(page.query_selector_all(".chat-block.live"))
