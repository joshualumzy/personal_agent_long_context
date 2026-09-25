"""Chat history: panels in a reloaded conversation arrive folded, and 'Show this panel' mounts a live, correctly sized iframe."""
import json
from common import *

r = Result("h19 history panels fold and reopen")
a = role_a()
detail = {"messages": [
    {"role": "user", "content": "show pool"},
    {"role": "assistant", "content": "Here.", "metadata": {"blocks": [{"type": "recruiting", "view": "pool", "roleId": a}]}},
    {"role": "user", "content": "show criteria"},
    {"role": "assistant", "content": "Here too.", "metadata": {"blocks": [{"type": "recruiting", "view": "criteria", "roleId": a}]}},
]}
with browser_page(1440, 900) as (page, console):
    page.route("**/api/v1/conversations?userId=jax", lambda route: route.fulfill(status=200, content_type="application/json",
               body=json.dumps([{"conversationId": "c1", "title": "Hiring", "updatedAt": "2026-09-26T00:00:00Z"}])))
    page.route("**/api/v1/conversations/c1?userId=jax", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(detail)))
    page.goto(f"{BASE}/")
    page.click(".conversation-item")
    page.wait_for_selector(".chat-block")
    r.check(page.locator(".chat-block iframe").count() == 0 and page.locator(".chat-block-reopen").count() == 2, "history panels folded")
    page.locator(".chat-block-reopen").nth(1).click()
    r.check(page.locator(".chat-block.live iframe").count() == 1, "reopened")
    page.locator(".chat-block-reopen").first.click()
    r.check(page.locator(".chat-block.live").count() == 1 and page.locator(".chat-block iframe").count() == 1, "only one live after reopening another")
    src = page.get_attribute(".chat-block.live iframe", "src")
    r.check(f"role={a}" in src and "embed=1" in src, f"iframe src {src}")
    page.wait_for_timeout(500)
    r.check(not [e for e in console.errors if "404" not in e], f"no console errors {console.errors}")
r.finish()
