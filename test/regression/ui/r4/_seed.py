import json, os, sys
d = sys.argv[1]; os.makedirs(d, exist_ok=True)
now = "2026-09-20T00:00:00.000Z"
def crit(i, text, kind="must"):
    return {"id": f"c{i}", "text": text, "kind": kind, "origin": "stated", "active": True, "createdAt": now}
def cand(pid, name, crits, sat="yes"):
    return {"profile": {"id": pid, "name": name, "headline": "Engineer", "location": "Singapore", "profileUrl": "https://example.com/" + pid,
            "workHistory": [{"title": "Dev", "company": "Acme", "from": "2020-01"}], "educationHistory": [], "summary": "## About\nBuilds things."},
            "poolRound": 1, "origin": "search", "discoveredAt": now, "stage": "scored", "kept": False,
            "verdicts": {c["id"]: {"criterionId": c["id"], "satisfied": sat, "reasoning": "fits"} for c in crits},
            "messages": [], "followUps": 0}
def role(rid, title, confirmed, names, crits):
    s = {"version": 1, "role": {"title": title, "requirement": title, "confirmed": confirmed, "createdAt": now},
         "criteria": crits, "candidates": {f"{rid}p{i}": cand(f"{rid}p{i}", n, crits) for i, n in enumerate(names)},
         "feedback": [], "proposals": [], "rounds": [{"round": 1, "query": "q", "at": now, "found": len(names), "added": len(names)}] if confirmed else [],
         "expansionStep": 0, "clockOffsetDays": 0, "events": []}
    json.dump(s, open(os.path.join(d, rid + ".json"), "w"))
cr = [crit(1, "TypeScript"), crit(2, "Singapore based", "nice")]
role("rolea", "Backend engineer", True, ["Alice Tan", "Bob Lim", "Cara Ng"], cr)
role("roleb", "Designer", True, ["Dan Koh", "Eve Ong"], [crit(1, "Figma")])
role("roledraft", "Data analyst", False, [], [crit(1, "SQL"), crit(2, "Python", "nice")])
