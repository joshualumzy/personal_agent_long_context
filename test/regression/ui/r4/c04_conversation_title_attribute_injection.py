"""The sidebar builds each conversation with innerHTML and puts the title into title="${escapeHtml(title)}".
escapeHtml (textContent -> innerHTML) escapes < > & but not the double quote, so a title containing '"'
closes the attribute: a title such as  x" onmouseover="window.__xss=1  becomes a real attribute on the element. The page's
CSP (script-src 'self') keeps the inline handler from running in production (this check bypasses CSP
only to show the handler is live markup); the tooltip is truncated at the first quote either way.
Titles are the first 47 characters of the first message, which is often pasted text (a job description,
a candidate's reply), and POST /api/v1/conversations takes any title. The list is scripted in the page."""
import _setup  # noqa: F401
from common import *
from _chatfake2 import INIT

r = Result("c04 conversation title breaks out of its title attribute (markup injection)")
title = 'Hiring x" onmouseover="window.__xss=1" data-x="'
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("t => { window.__conversations = [{ conversationId: 'c1', title: t, updatedAt: new Date().toISOString() }]; }", title)
    page.evaluate("() => loadConversations()")
    page.wait_for_selector(".conversation-item .conv-title")
    page.hover(".conversation-item .conv-title")
    page.wait_for_timeout(200)
    fired = page.evaluate("() => window.__xss === 1")
    handler = page.eval_on_selector(".conversation-item .conv-title", "e => e.hasAttribute('onmouseover')")
    tooltip = page.eval_on_selector(".conversation-item .conv-title", "e => e.getAttribute('title')")
    r.check(not handler and not fired, f"no attribute injected from the title (onmouseover attribute present: {handler}; ran with CSP bypassed: {fired})")
    r.check(tooltip == title, f"tooltip holds the whole title (tooltip: {tooltip!r})")
r.finish(console, allow_console=True)
