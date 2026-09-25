"""'Delete this role' awaits fetch() outside any try: when the request fails at the network level
(server down, connection reset) the promise rejects unhandled and the founder sees nothing, with the
button already disarmed. Other actions show "The server did not answer". The DELETE is aborted by the test."""
import _setup  # noqa: F401
from common import *

r = Result("r05 a failed delete request is swallowed")
a = role_a()
with browser_page() as (page, console):
    page.route(f"**/api/recruiting/roles/{a}", lambda route: route.abort("connectionreset") if route.request.method == "DELETE" else route.continue_())
    page.goto(f"{BASE}/recruiting?role={a}")
    wait_board(page)
    page.click("#reset")
    page.click("#reset")
    page.wait_for_timeout(600)
    visible = page.is_visible("#error")
    text = page.text_content("#error") if visible else ""
    r.check(visible and bool(text.strip()), f"an error banner tells the founder the delete did not happen (banner: {text!r})")
    unhandled = [e for e in console.errors if e.startswith("pageerror")]
    r.check(not unhandled, f"no unhandled rejection ({unhandled})")
r.finish(console, allow_console=True)
