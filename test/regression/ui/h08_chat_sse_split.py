"""Chat SSE loop: a 'done' event whose data line arrives in a later network chunk than its 'event:' line
must still attach the panel (blocks) and message meta. Stream is scripted in the page (no model call)."""
from common import *
from chatfake import INIT, turn, send

r = Result("h08 SSE event split across chunks")
a = role_a()
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    block = {"type": "recruiting", "view": "pool", "roleId": a}
    # control: unsplit
    send(page, "show candidates", turn("Here they are.", [block]))
    r.check(page.locator(".chat-block").count() == 1, "control: unsplit done event renders the panel")
    # split 'done' in the middle of its data line (as TCP may deliver a large payload)
    send(page, "show candidates again", turn("Here they are again.", [block], split_done_at=40))
    count = page.locator(".chat-block").count()
    tags = page.locator(".message-row.assistant").last.locator(".context-tag").count()
    r.check(count == 2, f"split done event still renders the panel (panels: {count})")
    r.check(tags > 0, f"split done event still attaches model/runtime tags (tags: {tags})")
r.finish(console, allow_console=True)
