"""Round 8 reports a cut-off or failed answer once the founder is back in its conversation. When the failure
lands while that history is loading, the history load shows it only if the history does not already answer the
question (alreadyDrawn). When the history has already loaded, the catch block appends the error with no such
check. The server saves the answer before it writes `done`, so a stream cut between the two (a proxy dropping
the connection) leaves: history showing the full answer, then "The answer was cut off ... Please try again"
under it. Trying again repeats whatever the tools did (drafts, sends). The chat and conversation API are
scripted in the page."""
import _setup  # noqa: F401
from common import *
from chatfake import event
from _chatfake4 import INIT

r = Result("c23 a cut stream is reported as unanswered under an answer the history already shows")
with browser_page(1440, 900) as (page, console):
    page.add_init_script(INIT)
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
      const now = new Date().toISOString();
      window.__conversations = [
        { conversationId: 'cA', title: 'Chat A', updatedAt: now },
        { conversationId: 'cB', title: 'Chat B', updatedAt: now } ];
      window.__details.cA = { messages: [{ role: 'user', content: 'old question A' }, { role: 'assistant', content: 'old answer A' }] };
      window.__details.cB = { messages: [{ role: 'user', content: 'question B' }, { role: 'assistant', content: 'answer B' }] };
    }""")
    page.evaluate("() => loadConversations()")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('old answer A')")
    # Tokens, then the connection drops before `done`.
    page.evaluate("chunks => window.__chatScripts.push(chunks)", [
        event("status", {"phrase": "Thinking"}), "HOLD:a", event("token", {"delta": "Drafted the intro to Alice"})])
    page.fill("#message-input", "draft an intro to Alice")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => window.__chatBodies.length === 1")
    page.click(".conversation-item[data-conversation-id='cB']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('answer B')")
    # The server has saved the question and the full answer; the page has not read `done`.
    page.evaluate("""() => { window.__details.cA.messages.push(
        { role: 'user', content: 'draft an intro to Alice' },
        { role: 'assistant', content: 'Drafted the intro to Alice. It is waiting in her panel.' }); }""")
    page.click(".conversation-item[data-conversation-id='cA']")
    page.wait_for_function("() => document.querySelector('#chat-messages').textContent.includes('It is waiting in her panel')")
    page.evaluate("() => window.__release('a')")
    page.wait_for_function("() => !document.querySelector('#message-input').disabled && window.__streamsOpen === 0")
    page.wait_for_timeout(300)
    rows = page.eval_on_selector_all("#chat-messages .message-row", "rows => rows.map(r => r.innerText.trim())")
    r.check(any("It is waiting in her panel" in t for t in rows), f"control: the saved answer is on screen ({[t[:40] for t in rows]})")
    r.check(not any("cut off" in t or "Unable to complete" in t for t in rows),
            f"no failure is reported under a question the history shows answered (rows: {[t[:40] for t in rows]})")
r.finish(console, allow_console=True)
