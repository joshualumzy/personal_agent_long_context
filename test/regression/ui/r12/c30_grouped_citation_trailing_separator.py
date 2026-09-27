"""Round 11 made the chat page turn a grouped tag ("[source:JIRA-1, CONF-2]") into a button per id, using its own
pattern: ids joined by separators, nothing else. The server reads a tag differently (CITATION_TAG takes
everything up to "]", then splits on [\\s,;，；]+ and drops empty pieces), so it accepts and saves a tag with a
trailing separator, "[source:JIRA-1, CONF-2,]" or "[source:JIRA-1；]", as citing JIRA-1 and CONF-2. The page's
pattern does not match such a tag at all: the answer shows the raw "[source:...]" text and no source can be
opened from it, although the server counted the answer as properly cited. The answer comes from scripted
conversation history (the same text a streamed answer ends with)."""
import _setup  # noqa: F401
from common import *
from _chatfake4 import INIT

ANSWER = ("The v1 API was deprecated in May [source:JIRA-1, CONF-2,]. "
          "迁移截止日期是六月 [source:PLAN-7；]. Control [source:JIRA-9].")
r = Result("c30 a grouped citation with a trailing separator shows as raw text with no buttons")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""a => {
      window.__conversations = [{ conversationId: 'cA', title: 'Chat A', updatedAt: new Date().toISOString() }];
      window.__details.cA = { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: a }] };
    }""", ANSWER)
    page.evaluate("() => loadConversations()")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_selector(".message-row.assistant .message-text")
    report = page.evaluate("""() => {
      const root = document.querySelector('.message-row.assistant .message-text');
      return { ids: [...root.querySelectorAll('.inline-citation')].map((b) => b.dataset.sourceId), text: root.textContent };
    }""")
    ids = report["ids"]
    r.check("JIRA-9" in ids, f"control: a plain tag becomes a button ({ids})")
    for wanted in ["JIRA-1", "CONF-2", "PLAN-7"]:
        r.check(wanted in ids, f"{wanted} can be opened from the answer (buttons: {ids})")
    r.check("[source:" not in report["text"].lower(), f"no raw citation tag is left in the text ({report['text']!r})")
r.finish(console, allow_console=True)
