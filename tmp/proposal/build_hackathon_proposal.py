from build_business_proposal import *


def build():
    doc = setup_document()

    # Cover
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(66)
    p = doc.add_paragraph(style="Title")
    r = p.add_run("SME Operating Agent")
    set_run_font(r, name="Aptos Display", size=32, bold=True)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(20)
    r = p.add_run("Business Proposal")
    set_run_font(r, name="Aptos Display", size=21, bold=True, color=NAVY)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(30)
    r = p.add_run("Know the company. Act on meetings. Grow the team.")
    set_run_font(r, name="Aptos Display", size=16, color=GRAY)

    cover_table = doc.add_table(rows=5, cols=2)
    cover_table.alignment = WD_TABLE_ALIGNMENT.LEFT
    cover_table.autofit = False
    labels = ["Company", "Team code", "Hackathon", "Repository", "Date"]
    values = [
        "Stellar Ark AI",
        "Pending confirmation",
        "Show Me Your Agents",
        "github.com/joshualumzy/personal_agent_long_context",
        "27 September 2026",
    ]
    for idx, (label, value) in enumerate(zip(labels, values)):
        a, b = cover_table.rows[idx].cells
        a.width = Inches(1.35)
        b.width = Inches(5.15)
        for cell in (a, b):
            set_cell_margins(cell, top=65, start=0, bottom=65, end=80)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        a.text = ""
        b.text = ""
        ar = a.paragraphs[0].add_run(label)
        set_run_font(ar, size=9.5, bold=True, color=GRAY)
        br = b.paragraphs[0].add_run(value)
        set_run_font(br, size=10.5)

    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(48)
    p.paragraph_format.space_after = Pt(0)
    r = p.add_run("Hackathon proposition")
    set_run_font(r, size=10, bold=True, color=NAVY)
    add_body(
        doc,
        "Stellar Ark AI applies its own context-to-action principle internally: one operating agent that carries company evidence into meeting follow-up and structured hiring.",
        after=0,
    )

    # Page 2
    page_break(doc)
    heading(doc, "Executive Summary")
    add_body(
        doc,
        "Stellar Ark AI builds AI-native wearables and a proactive agent system that turn everyday conversations into persistent memory and action. Yet inside a growing company, work can still fragment across company records, meeting notes, and founder-led hiring. Every manual handoff competes with product development, customer delivery, and leadership time.",
    )
    add_body(
        doc,
        "The SME Operating Agent closes that internal gap. It carries work through one connected loop: recover reliable context, turn meeting decisions into accountable follow-up, and open a structured recruiting workflow when the company needs additional capacity.",
    )
    add_body(
        doc,
        "Company Context answers questions from inspectable evidence while Personal Memory retains employee-specific context across interactions without becoming factual evidence. Meeting Actions converts text transcripts into reviewable commitments and decisions. Recruiting turns an approved hiring need into criteria, candidate review, and outreach drafts. Employees remain responsible for consequential external actions.",
    )

    heading(doc, "One Operating Loop", 2)
    add_table(
        doc,
        ["Context", "Decision", "Action", "Growth"],
        [[
            "Recover inspectable company evidence",
            "Extract commitments and decisions",
            "Prepare owned follow-up",
            "Start structured hiring when needed",
        ]],
        widths=[1.62, 1.62, 1.62, 1.62],
        font_size=9.3,
    )

    heading(doc, "Why It Fits Stellar Ark AI", 2)
    add_body(
        doc,
        "The proposal applies Stellar Ark AI's own product principle to internal operations. The same idea that serves customers - captured context becoming useful memory and action - becomes an operating advantage for the team building it.",
    )

    # Page 3
    page_break(doc)
    heading(doc, "Problem and Opportunity")
    heading(doc, "Who Experiences the Problem", 2)
    add_body(
        doc,
        "The primary users are Stellar Ark AI employees and founders who must turn fragmented company information into daily work while continuing to build products and serve customers. In a small team, time spent reconstructing history, rewriting meeting notes, or coordinating hiring directly reduces execution capacity.",
    )

    heading(doc, "Current Workflow and Consequence", 2)
    add_table(
        doc,
        ["Current task", "Manual friction", "Business consequence"],
        [
            ["Answer a company question", "Search several systems and reconstruct the history", "Slower answers and decisions based on incomplete context"],
            ["Follow up a meeting decision", "Interpret notes, gather details, draft work, and remember ownership", "Actions may be delayed, duplicated, or missed"],
            ["Run founder-led hiring", "Define criteria, search profiles, compare candidates, and chase replies", "Recruiting competes with product, customer, and leadership work"],
        ],
        widths=[1.55, 2.55, 2.4],
        font_size=9.2,
    )

    heading(doc, "Why This Opportunity Matters", 2)
    add_bullets(doc, [
        "Employees can move from a supported answer to meeting follow-up without reconstructing the same context twice.",
        "Decisions, owners, and due dates become visible work rather than information left in notes.",
        "Founder-led hiring becomes a repeatable process instead of another workflow rebuilt for every role.",
    ])

    heading(doc, "Evidence Used for the Hackathon", 2)
    add_body(
        doc,
        "The workflows reflect the team's first-hand experience at Stellar Ark AI. To protect confidential company and customer information, the demonstration uses OrgForge synthetic workplace records rather than private business data. OrgForge is demonstration data, not a customer, dependency, deployment target, or integration.",
    )

    # Page 4
    page_break(doc)
    heading(doc, "Proposed Solution")
    add_table(
        doc,
        ["Workflow", "Employee experience", "Business result"],
        [
            ["Company Context", "An employee asks a company question and receives a concise answer with inspectable Company Evidence. Personal Memory carries employee-specific context across interactions without becoming factual evidence", "Less time searching across systems and greater confidence in the source of an answer"],
            ["Meeting Actions", "An employee provides a text transcript. The agent identifies commitments, questions, and decisions, checks relevant context and conflicts, and prepares follow-up for review", "Faster follow through, clearer ownership, and fewer actions lost after a meeting"],
            ["Recruiting", "A founder defines a role, reviews scored public profiles and feedback, and receives outreach and follow-up drafts before completing the handoff", "Less recruiting administration and more founder time for product, customers, and leadership"],
        ],
        widths=[1.25, 3.35, 1.9],
        font_size=8.8,
    )
    add_body(
        doc,
        "The workflows connect through the work itself. Company context can support meeting follow-up, and an approved hiring need can become a recruiting draft. Employees can inspect the supporting information and decide whether to complete each consequential handoff.",
    )

    # Page 5
    page_break(doc)
    heading(doc, "Business Value and Outcomes")
    add_table(
        doc,
        ["Workflow", "Business value", "Initial success target"],
        [
            ["Company Context", "Employees spend less time reconstructing history and can inspect the records supporting an answer", "At least 30 percent reduction in median time to an evidence-backed answer"],
            ["Meeting Actions", "Decisions become owned, reviewable follow-up instead of remaining in meeting notes", "At least 50 percent reduction in time to a reviewable draft, with 90 percent of accepted actions completed by their due date"],
            ["Recruiting", "The founder can compare candidates and prepare outreach without rebuilding the process for each role", "At least 25 percent reduction in founder administration time per active role"],
        ],
        widths=[1.35, 2.65, 2.5],
        font_size=9.0,
    )

    heading(doc, "How Impact Will Be Measured", 2)
    add_body(
        doc,
        "The targets are working assumptions based on the team's SME context, not achieved results. Before deployment, Stellar Ark AI would record baseline handling time, manual steps, overdue actions, and founder administration time for representative work. The same measures would then be collected after introduction of the agent so that business impact is attributable and comparable.",
    )
    add_body(
        doc,
        "Human control is a non-negotiable operating measure: the solution should produce zero unauthorised outbound sends or executed escalated actions.",
        italic=True,
    )

    # Page 6
    page_break(doc)
    heading(doc, "Feasibility and Scalability")
    heading(doc, "Prototype Proof", 2)
    add_table(
        doc,
        ["Workflow", "What the prototype demonstrates", "Why it is feasible"],
        [
            ["Company Context", "A browser workflow searches 4,966 employee-visible synthetic artifacts across eight workplace record types and returns inspectable citations or an insufficient-evidence response", "PostgreSQL, pgvector, explicit artifact links, source validation, and employee-scoped Personal Memory are already implemented"],
            ["Meeting Actions", "A text transcript becomes structured commitments, questions, decisions, conflict checks, and reviewable follow-up", "Deterministic policy checks, evidence lookup, exact-payload approval, and action logs provide a controlled execution path"],
            ["Recruiting", "A founder can define criteria, review and score public profiles, record feedback, and prepare outreach", "The implemented service supports search, scoring, proposals, outreach drafts, retention, and user-controlled handoff"],
        ],
        widths=[1.25, 3.35, 1.9],
        font_size=8.7,
    )

    heading(doc, "Path to Scale", 2)
    add_numbered(doc, [
        "Start with one Stellar Ark AI team, approved company sources, a recurring meeting workflow, and one active hiring role.",
        "Connect sanctioned workplace systems and add tenant permissions, retention, monitoring, and operating support.",
        "Expand across teams and transaction volumes after the solution meets the business success measures.",
    ])
    add_body(
        doc,
        "Company Evidence remains separate from employee Personal Memory, and consequential outbound actions continue to require a visible employee decision. Access controls and monitoring can be strengthened as usage expands.",
    )

    heading(doc, "Closing Case")
    add_body(
        doc,
        "Stellar Ark AI already believes that conversations should become durable memory and action. This proposal turns that belief into an internal operating advantage. The SME Operating Agent carries inspectable context into meeting follow-up and structured hiring, giving a small team more execution capacity without removing employee judgment. The working prototype demonstrates the core loop today and provides a practical foundation for expansion as the company grows.",
    )

    # Footer
    for section in doc.sections:
        footer = section.footer
        p = footer.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(6)
        r = p.add_run("Stellar Ark AI | SME Operating Agent Business Proposal   |   ")
        set_run_font(r, size=8, color=GRAY)
        fld_char1 = OxmlElement("w:fldChar")
        fld_char1.set(qn("w:fldCharType"), "begin")
        instr_text = OxmlElement("w:instrText")
        instr_text.set(qn("xml:space"), "preserve")
        instr_text.text = " PAGE "
        fld_char2 = OxmlElement("w:fldChar")
        fld_char2.set(qn("w:fldCharType"), "end")
        field_run = p.add_run()
        field_run._r.append(fld_char1)
        field_run._r.append(instr_text)
        field_run._r.append(fld_char2)
        set_run_font(field_run, size=8, color=GRAY)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc.core_properties.title = "SME Operating Agent Business Proposal"
    doc.core_properties.subject = "Show Me Your Agents Hackathon business proposal"
    doc.core_properties.author = "Stellar Ark AI Hackathon Team"
    doc.core_properties.keywords = "Stellar Ark AI, SME, agent, business proposal, hackathon"
    doc.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build()
