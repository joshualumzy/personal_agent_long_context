#!/usr/bin/env python3
"""Build the deterministic property graph, five kinds of node instead of two.

No language model is involved. Every node and edge comes from a field the
corpus already states.

The old graph had 'document' and 'actor' covering everything: a slack message
sat beside a confluence design, and an event that produced an artifact was a
'document' too, distinguished only by a category prop nobody reading an edge
would think to check. This build reads the actual shape instead: incidents,
tickets, and discussions are events; domains and work items are concepts;
confluence pages are documents; the other twenty thousand rows — slack, email,
zoom, datadog metrics, deep-work logs — are evidence, cited from a node's props,
never nodes of their own. See issue #11 for the reasoning.

  person      actor_identity resolved names, so "Ethan" and "Ethan Patel"
              are the same node rather than two half-populated ones
  item        the 10 domains, plus jira tickets, PRs, and the smaller
              artifact types (invoices, sf_opp, zd_ticket, nps_survey)
  event       the 12 incidents (incident_opened + incident_resolved +
              postmortem_created merged into one node each), escalation
              chains, design discussions, and jira/PR lifecycle events
  document    confluence pages — the only artifact type left as a document,
              because a person genuinely cites "CONF-ENG-022" by name

organization also covers the seven departments that have a daily plan
(subtype 'department'), with person -> department member_of / leads edges read
from dept_plan_created, and domain -> department belongs_to from the registry.

organization covers the seven customer accounts named in crm_touchpoint,
proactive_outreach_initiated, and zd_ticket_opened — actors the corpus had
already recorded, but with actor_kind left at its 'employee' default (migration
010 corrects it to 'customer', keyed by name rather than guessed). sf_account,
the fuller vendor/customer registry, still has zero rows in this corpus.

Traversal is plain SQL, same recursive-CTE shape as before, now over 'produced'
and 'caused_by' rather than one undifferentiated 'references':

    WITH RECURSIVE chain AS (
        SELECT node_id, label, 0 AS depth, ARRAY[node_id] AS path
        FROM graph_nodes WHERE node_type = 'event' AND ref_key = :seed
      UNION ALL
        SELECT e.dst_node_id, n.label, c.depth + 1, c.path || e.dst_node_id
        FROM chain c
        JOIN graph_edges e ON e.src_node_id = c.node_id
                           AND e.edge_type IN ('produced', 'caused_by')
        JOIN graph_nodes n ON n.node_id = e.dst_node_id
        WHERE c.depth < 8 AND NOT e.dst_node_id = ANY(c.path)
    )
    SELECT DISTINCT node_id, label, depth FROM chain ORDER BY depth;

ref_key is a natural key throughout: a domain's registry key, a jira/PR/
confluence source_id, an incident's jira id, or an actor's canonical name from
actor_identity. Re-running is safe: nodes upsert on (node_type, ref_key), edges
on (src, dst, edge_type).

Usage
-----
    DATABASE_URL=postgresql://... python3 build_graph.py --reset
"""

from __future__ import annotations

import argparse
import os
import sys

import psycopg

# Reads the repository's .env, so DATABASE_URL does not have to be exported by
# hand. Must precede any use of os.environ.
import _env  # noqa: F401  (imported for its side effect)

# doc_types that become 'item' nodes directly, one node per artifact, beyond
# jira and pr which get their own node builder (they also anchor 'event' rows).
SMALL_ITEM_TYPES = ("invoice", "sf_opp", "zd_ticket", "nps_survey")

# sim_event doc_types that become 'event' nodes on their own, one per row.
# incident_opened / incident_resolved / postmortem_created are handled
# separately: three rows merge into one event node per incident.
STANDALONE_EVENT_TYPES = (
    "design_discussion", "jira_ticket_created", "ticket_progress",
    "pr_review", "sprint_planned", "confluence_created",
    "dept_plan_created",
)

# The edge types that name what a person did. 'involves' is defined against
# this list — it is what is left when none of these applies — so the two stay
# in step from one place rather than two.
PERSON_ROLE_EDGE_TYPES = (
    "authored_by", "reviewed_by", "led_by", "assigned_to", "raised_by", "received_by",
)

# The same partition for organizations: a document naming a customer or
# vendor in its actors list gets 'involves' only where no typed edge already
# says how it relates to that organization.
ORGANIZATION_EDGE_TYPES = ("for_customer", "from_vendor")


# Who belongs to which department, and when, straight from the department
# plans: every dept_plan_created row lists the department's people in
# facts.engineer_plans[] for that day. One row per (person, department), with
# the first and last day they were listed. Names resolve through
# actor_identity to the canonical actor, as every other name lookup here does.
# Verified against the corpus: nobody is listed under two departments, and the
# first/last days agree with employee_hired / employee_departed.
MEMBERSHIP_SQL = """
    SELECT canon.name AS person, d.facts->>'dept' AS dept,
           min(d.simulation_day) AS first_day, max(d.simulation_day) AS last_day,
           count(DISTINCT d.simulation_day) AS days
    FROM source_documents d
    CROSS JOIN LATERAL jsonb_array_elements(d.facts->'engineer_plans') AS ep
    JOIN actor_identity ai ON ai.alias = ep->>'name'
    JOIN actors canon ON canon.actor_id = ai.actor_id
    WHERE d.source_type = 'dept_plan_created'
    GROUP BY 1, 2
"""

# Who led each department, and when: dept_plan_created.facts.lead, the same
# rows as above. In this corpus every department keeps one lead for all 60
# days, but the first/last day are kept so a change of lead would show.
LEADERSHIP_SQL = """
    SELECT canon.name AS person, d.facts->>'dept' AS dept,
           min(d.simulation_day) AS first_day, max(d.simulation_day) AS last_day
    FROM source_documents d
    JOIN actor_identity ai ON ai.alias = d.facts->>'lead'
    JOIN actors canon ON canon.actor_id = ai.actor_id
    WHERE d.source_type = 'dept_plan_created'
    GROUP BY 1, 2
"""


def reset_graph(cursor) -> None:
    cursor.execute("TRUNCATE graph_edges, graph_nodes RESTART IDENTITY CASCADE")


# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------
def build_person_nodes(cursor) -> int:
    """One node per resolved actor identity, not per actors row.

    Reading through actor_identity rather than actors.name directly is what
    makes 'Ethan' and 'Ethan Patel' one node: the view already resolves an
    alias to the actor it was merged into (migration 008).

    Restricted to people — actor_kind 'employee', and 'external_contact' for
    someone who writes in on behalf of a vendor or customer (migration 017),
    kept apart by node_subtype — so a customer organization named in actors,
    'Metro United FC' for instance, becomes an 'organization' node below
    instead of a 'person' one.

    dept comes from the department plans when actors.dept is empty, which it
    is for nearly everyone: the plans list each department's people every day
    (see department_membership). hired_day / departed_day come from the
    corpus's own employee_hired / employee_departed events, so the org view
    can tell a current member from a former one.
    """
    cursor.execute(
        f"""
        WITH membership AS ({MEMBERSHIP_SQL}),
        latest AS (
            SELECT DISTINCT ON (person) person, dept
            FROM membership ORDER BY person, last_day DESC
        ),
        hr AS (
            SELECT facts->>'name' AS name,
                   min(simulation_day) FILTER (WHERE source_type = 'employee_hired')    AS hired_day,
                   max(simulation_day) FILTER (WHERE source_type = 'employee_departed') AS departed_day
            FROM source_documents
            WHERE source_type IN ('employee_hired', 'employee_departed')
            GROUP BY 1
        )
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT DISTINCT
            'person', a.actor_kind, a.name, a.name,
            jsonb_build_object('role', a.role, 'dept', coalesce(a.dept, latest.dept))
            || jsonb_strip_nulls(jsonb_build_object(
                'hired_day', hr.hired_day,
                'departed_day', hr.departed_day
            ))
        FROM actor_identity ai
        JOIN actors a ON a.actor_id = ai.actor_id
        LEFT JOIN latest ON latest.person = a.name
        LEFT JOIN hr ON hr.name = a.name
        WHERE a.actor_kind IN ('employee', 'external_contact')
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    return cursor.rowcount


def build_organization_nodes(cursor) -> int:
    """The customer/vendor organizations named in actors, keyed by actor_kind
    rather than a hard-coded name list (migration 010 fixes actor_kind on the
    seven customer accounts this corpus names; the query does not need its own
    copy of that list to stay in sync with it).
    """
    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT DISTINCT
            'organization', a.actor_kind, a.name, a.name,
            jsonb_build_object('actor_kind', a.actor_kind)
        FROM actor_identity ai
        JOIN actors a ON a.actor_id = ai.actor_id
        WHERE a.actor_kind IN ('customer', 'vendor')
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    return cursor.rowcount


def build_department_nodes(cursor) -> int:
    """One organization node per department that has a plan — the departments
    the corpus actually staffs. ref_key is the corpus's own department key
    ("Engineering_Backend"), which is what source_documents.department and
    domains.dept already use, so anything carrying a department can be joined
    to its node by that string.

    'CEO' and 'Finance' also appear in source_documents.department (four
    standups and eight invoices) but never have a plan, a member, a lead, or a
    domain, so they would be nodes with nothing to connect to and are left out.
    """
    cursor.execute(
        f"""
        WITH plans AS (
            SELECT facts->>'dept' AS dept, max(simulation_day) AS last_day
            FROM source_documents
            WHERE source_type = 'dept_plan_created'
            GROUP BY 1
        ),
        membership AS ({MEMBERSHIP_SQL})
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT
            'organization', 'department', p.dept, replace(p.dept, '_', ' '),
            jsonb_build_object(
                'dept', p.dept,
                'current_members', (
                    SELECT count(*) FROM membership m
                    WHERE m.dept = p.dept AND m.last_day = p.last_day
                ),
                'all_members', (SELECT count(*) FROM membership m WHERE m.dept = p.dept)
            )
        FROM plans p
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    return cursor.rowcount


def build_department_edges(cursor) -> tuple[int, int, int]:
    """member_of and leads (person -> department), each carrying the first and
    last day the plans list it, and belongs_to (domain -> department) from the
    registry's own domains.dept."""
    counts = []
    for edge_type, source in (("member_of", MEMBERSHIP_SQL), ("leads", LEADERSHIP_SQL)):
        cursor.execute(
            f"""
            WITH rel AS ({source})
            INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type, props)
            SELECT pn.node_id, dn.node_id, %s,
                   jsonb_build_object('first_day', rel.first_day, 'last_day', rel.last_day)
            FROM rel
            JOIN graph_nodes pn ON pn.node_type = 'person' AND pn.ref_key = rel.person
            JOIN graph_nodes dn ON dn.node_type = 'organization'
                                AND dn.node_subtype = 'department'
                                AND dn.ref_key = rel.dept
            ON CONFLICT (src_node_id, dst_node_id, edge_type) DO UPDATE SET
                props = EXCLUDED.props
            """,
            (edge_type,),
        )
        counts.append(cursor.rowcount)

    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT dom.node_id, dn.node_id, 'belongs_to'
        FROM domains d
        JOIN graph_nodes dom ON dom.node_type = 'item' AND dom.node_subtype = 'domain'
                             AND dom.ref_key = d.domain_key
        JOIN graph_nodes dn ON dn.node_type = 'organization'
                            AND dn.node_subtype = 'department'
                            AND dn.ref_key = d.dept
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    counts.append(cursor.rowcount)
    return counts[0], counts[1], counts[2]


def build_domain_item_nodes(cursor) -> int:
    """The 10 knowledge domains, keyed by the registry's own id."""
    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT
            'item', 'domain', d.domain_key, d.name,
            jsonb_build_object(
                'dept', d.dept,
                'primary_owner', d.primary_owner,
                'former_owner', d.former_owner,
                'documentation_coverage', d.documentation_coverage,
                'is_genesis_gap', d.is_genesis_gap
            )
        FROM domains d
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    return cursor.rowcount


def build_work_item_nodes(cursor) -> int:
    """jira, pr, and the smaller artifact types — one node per artifact.

    jira and pr also anchor 'event' nodes (ticket lifecycle, PR review), which
    is a real distinction, not a duplicate: the ticket is a thing that exists,
    and a review of it is something that happened.
    """
    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT
            -- Three rows (PR-101, PR-111, PR-117) are filed as source_type
            -- 'jira' under a PR id, with a gap_areas stub for a body; no pr
            -- row exists for them, and ticket threads cite them as the PR
            -- that closed the ticket. They are PRs, so they are built as one.
            'item',
            CASE WHEN d.source_type = 'jira' AND d.source_id LIKE 'PR-%'
                 THEN 'pr' ELSE d.source_type END,
            d.source_id,
            coalesce(nullif(d.title, ''), d.source_id),
            jsonb_build_object(
                'source_type', d.source_type,
                'department', d.department,
                'is_incident', d.is_incident,
                'occurred_at', d.occurred_at
            )
        FROM source_documents d
        WHERE d.category = 'artifact'
          AND d.source_type IN ('jira', 'pr')
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    jira_pr = cursor.rowcount

    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT
            'item', d.source_type, d.source_id,
            coalesce(nullif(d.title, ''), d.source_id),
            jsonb_build_object('source_type', d.source_type,
                               'occurred_at', d.occurred_at)
        FROM source_documents d
        WHERE d.category = 'artifact' AND d.source_type = ANY(%s)
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """,
        (list(SMALL_ITEM_TYPES),),
    )
    return jira_pr + cursor.rowcount


def build_confluence_document_nodes(cursor) -> int:
    """The only artifact type left as 'document': people cite these by name."""
    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT
            'document', 'confluence', d.source_id,
            coalesce(nullif(d.title, ''), d.source_id),
            jsonb_build_object('department', d.department,
                               'occurred_at', d.occurred_at)
        FROM source_documents d
        WHERE d.category = 'artifact' AND d.source_type = 'confluence'
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    return cursor.rowcount


def build_zd_ticket_event_nodes(cursor) -> int:
    """One node per Zendesk ticket, merging zd_ticket_opened, zd_tickets_escalated,
    and zd_tickets_resolved — the same three-rows-one-thing shape as the incident
    merge above, keyed by the ticket id each of the three names directly
    (zd_ticket_opened.facts.ticket_id; the other two list it in ticket_ids).

    Only one of the two tickets in this corpus (ZD-101) is ever escalated or
    resolved; ZD-102 stays open with no incident and no postmortem, and gets a
    node with those two fields null rather than being skipped.

    This node is distinct from item(zd_ticket): the item is the ticket as a
    thing that exists, already built above; this is the event of it moving
    through its lifecycle, the same distinction build_incident_event_nodes
    already draws against item(jira).
    """
    cursor.execute(
        """
        WITH opened AS (
            SELECT facts->>'ticket_id' AS ticket_id, source_id, title, occurred_at,
                   facts->>'org_name' AS org_name
            FROM source_documents WHERE source_type = 'zd_ticket_opened'
        ),
        escalated AS (
            SELECT jsonb_array_elements_text(facts->'ticket_ids') AS ticket_id,
                   facts->>'incident_id' AS incident_id
            FROM source_documents WHERE source_type = 'zd_tickets_escalated'
        ),
        resolved AS (
            SELECT jsonb_array_elements_text(facts->'ticket_ids') AS ticket_id,
                   facts->>'postmortem_link' AS postmortem_link
            FROM source_documents WHERE source_type = 'zd_tickets_resolved'
        )
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT
            'event', 'zd_ticket', o.ticket_id,
            coalesce(nullif(o.title, ''), o.ticket_id),
            jsonb_build_object(
                'occurred_at', o.occurred_at,
                'org_name', o.org_name,
                'incident_id', e.incident_id,
                'postmortem_link', r.postmortem_link
            )
        FROM opened o
        LEFT JOIN escalated e ON e.ticket_id = o.ticket_id
        LEFT JOIN resolved r ON r.ticket_id = o.ticket_id
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    return cursor.rowcount


def build_standalone_event_nodes(cursor) -> int:
    """One node per row for the sim_event types that are not part of the
    incident merge below."""
    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT
            'event', d.source_type, d.source_id,
            coalesce(nullif(d.title, ''), d.source_id),
            jsonb_build_object(
                'source_type', d.source_type,
                'occurred_at', d.occurred_at,
                'department', d.department,
                'facts', d.facts
            )
        FROM source_documents d
        WHERE d.category = 'sim_event' AND d.source_type = ANY(%s)
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """,
        (list(STANDALONE_EVENT_TYPES),),
    )
    return cursor.rowcount


def build_incident_event_nodes(cursor) -> int:
    """One node per incident, merging incident_opened, incident_resolved, and
    postmortem_created — three sim_event rows about the same thing, not three
    things. ref_key is the jira id incidents.incident_key already carries.

    Six of the twelve incident ids are never their own artifact row (migration
    007), so the label falls back to the incident_key itself when no jira title
    exists to use.

    The escalation narrative joins it here rather than living on a node of its
    own. escalation_chain used to be 14 event nodes all labelled the literal
    string "Escalation Chain", joining a pair of people to an incident and
    carrying nothing else; being told an incident was escalated is a fact about
    that incident, so it is one of its props, and the two people get
    raised_by/received_by edges (build_escalation_role_edges).
    """
    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT
            'event', 'incident', i.incident_key,
            coalesce(nullif(j.title, ''), i.incident_key),
            jsonb_build_object(
                'opened_at', i.opened_at,
                'resolved_at', i.resolved_at,
                'root_cause', i.root_cause,
                'root_domain', dm.domain_key,
                'escalation', esc.facts->>'escalation_narrative'
            )
        FROM incidents i
        LEFT JOIN source_documents j ON j.source_id = i.incident_key
        LEFT JOIN domains dm ON dm.domain_id = i.root_domain
        LEFT JOIN source_documents esc
               ON esc.source_type = 'escalation_chain'
              AND esc.original_links->>'jira' = i.incident_key
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    return cursor.rowcount


# ---------------------------------------------------------------------------
# Edges
# ---------------------------------------------------------------------------
# A vendor's own name in inbound mail (facts.org, "Kafka") is not the name its
# organization node has (actors.name, "Confluent"). The corpus gives the
# mapping itself: external_contact_summarized names both, as facts.org and
# facts.external_party. A customer writes under its own account name, which is
# its node's name already.
ORGANIZATION_OF_MAIL_SQL = """
    SELECT DISTINCT e.facts->>'source' AS contact,
           e.facts->>'category'       AS category,
           coalesce(s.facts->>'external_party', e.facts->>'org') AS organization
    FROM source_documents e
    LEFT JOIN source_documents s
           ON s.source_type = 'external_contact_summarized'
          AND s.facts->>'org' = e.facts->>'org'
    WHERE e.source_type = 'inbound_external_email'
      AND e.facts->>'category' IN ('vendor', 'customer')
      AND e.facts->>'source' <> e.facts->>'org'
"""


def build_customer_vendor_edges(cursor) -> dict[str, int]:
    """Typed relationships to customer and vendor organizations, each from a
    field that names the organization:

      contact_for   person(external_contact) -> organization: inbound mail's
                    facts.source writing for facts.org. "Ethan" writes for both
                    Firebase and Metro United FC, and gets both edges.
      from_vendor   item(jira) -> organization(vendor): the 110 tickets opened
                    from vendor mail name the contact in facts.vendor, whose
                    vendor is found as above.
      for_customer  -> organization(customer):
                      sf_opp item        facts.account_name
                      jira item          facts.account (sales outreach)
                      zd_ticket item     facts.org_name
                      zd_ticket event    props.org_name (from zd_ticket_opened)
                      invoice/nps item   its actors list, which names the account
                                         and nothing else ("Invoice INV-... -
                                         Metro United FC")
    """
    counts: dict[str, int] = {}
    cursor.execute(
        f"""
        WITH mail AS ({ORGANIZATION_OF_MAIL_SQL})
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type, props)
        SELECT DISTINCT pn.node_id, onode.node_id, 'contact_for',
               jsonb_build_object('as', mail.category)
        FROM mail
        JOIN graph_nodes pn ON pn.node_type = 'person' AND pn.ref_key = mail.contact
        JOIN graph_nodes onode ON onode.node_type = 'organization'
                               AND onode.node_subtype = mail.category
                               AND onode.ref_key = mail.organization
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    counts["contact_for"] = cursor.rowcount

    cursor.execute(
        f"""
        WITH mail AS ({ORGANIZATION_OF_MAIL_SQL})
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT tn.node_id, onode.node_id, 'from_vendor'
        FROM source_documents d
        JOIN mail ON mail.contact = d.facts->>'vendor' AND mail.category = 'vendor'
        JOIN graph_nodes tn ON tn.node_type = 'item' AND tn.ref_key = d.source_id
        JOIN graph_nodes onode ON onode.node_type = 'organization'
                               AND onode.node_subtype = 'vendor'
                               AND onode.ref_key = mail.organization
        WHERE d.source_type = 'jira' AND d.facts ? 'vendor'
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    counts["from_vendor"] = cursor.rowcount

    cursor.execute(
        """
        WITH named AS (
            SELECT 'item' AS node_type, source_id AS ref_key,
                   coalesce(facts->>'account_name', facts->>'account', facts->>'org_name') AS account
            FROM source_documents
            WHERE source_type IN ('sf_opp', 'jira', 'zd_ticket')
              AND coalesce(facts->>'account_name', facts->>'account', facts->>'org_name') IS NOT NULL
          UNION
            SELECT 'event', ref_key, props->>'org_name'
            FROM graph_nodes
            WHERE node_type = 'event' AND node_subtype = 'zd_ticket'
              AND props->>'org_name' IS NOT NULL
          UNION
            SELECT 'item', d.source_id, a.name
            FROM source_documents d
            JOIN document_actors da ON da.source_id = d.source_id
            JOIN actors a ON a.actor_id = da.actor_id AND a.actor_kind = 'customer'
            WHERE d.source_type IN ('invoice', 'nps_survey')
        )
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT sn.node_id, onode.node_id, 'for_customer'
        FROM named
        JOIN graph_nodes sn ON sn.node_type = named.node_type AND sn.ref_key = named.ref_key
        JOIN graph_nodes onode ON onode.node_type = 'organization'
                               AND onode.node_subtype = 'customer'
                               AND onode.ref_key = named.account
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    counts["for_customer"] = cursor.rowcount
    return counts


def build_involves_edges(cursor) -> int:
    """event/document -> person/organization, from the normalized actor
    junction — but only where no role edge has already said what the person
    did.

    Resolved through actor_identity so a document naming "Ethan" links to the
    same person node a document naming "Ethan Patel" does. Both 'person' and
    'organization' are valid targets: the same actors list that names an
    employee also names a customer account like "Metro United FC" wherever a
    document is about that account, and those are graph_nodes of node_type
    'organization' now, not 'person'.

    This is a partition, not a leftover. document_actors is exactly the
    flattened union of the role fields the builders above read, so every pair
    it holds either has a role edge naming what the person did, or genuinely
    has no role to name — a participant in a design discussion, someone
    mentioned in a thread. 'involves' is now that second case and only that
    case, which is why it must run after the role builders: it asks them what
    they already covered.
    """
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT sn.node_id, an.node_id, 'involves'
        FROM document_actors da
        JOIN actor_identity ai ON ai.actor_id = da.actor_id
        JOIN graph_nodes an ON an.node_type IN ('person', 'organization')
                            AND an.ref_key = (
            SELECT name FROM actors WHERE actor_id = ai.actor_id
        )
        JOIN graph_nodes sn ON sn.ref_key = da.source_id
                            AND sn.node_type IN ('event', 'document', 'item')
        WHERE NOT EXISTS (
            SELECT 1 FROM graph_edges covered
            WHERE covered.src_node_id = sn.node_id
              AND covered.dst_node_id = an.node_id
              AND covered.edge_type = ANY(%s)
        )
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """,
        (list(PERSON_ROLE_EDGE_TYPES + ORGANIZATION_EDGE_TYPES),),
    )
    return cursor.rowcount


def build_dept_plan_involves_edges(cursor) -> int:
    """dept_plan event -> person, for names dept_plan_created carries inside
    its own facts rather than in document_actors.

    document_actors already links each dept_plan_created row to its lead, and
    the lead now has a 'led_by' edge naming that role, so this skips any pair a
    role edge already covers for the same reason build_involves_edges does. It
    does not reach facts.engineer_plans[].name (every engineer the plan covers,
    not just the lead) or agenda[].collaborator[] (who else a specific agenda
    item names), so those need their own resolution here, through
    actor_identity for the same alias-merging reason every other name lookup
    in this file goes through it rather than actors.name directly.

    related_id inside each agenda item (229 distinct values, all of which
    resolve to existing item/event nodes) is deliberately not built into an
    edge here: it names a work item on someone's plan for the day, not a
    person or organization, and none of this graph's edge types describe
    that relationship without stretching 'involves' past the event/document
    -> person/organization meaning it has everywhere else it is used.
    """
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT sn.node_id, pn.node_id, 'involves'
        FROM source_documents d
        CROSS JOIN LATERAL jsonb_array_elements(d.facts->'engineer_plans') AS ep
        JOIN actors a ON a.name = ep->>'name'
        JOIN actor_identity ai ON ai.actor_id = a.actor_id
        JOIN graph_nodes pn ON pn.node_type = 'person'
                            AND pn.ref_key = (SELECT name FROM actors WHERE actor_id = ai.actor_id)
        JOIN graph_nodes sn ON sn.node_type = 'event' AND sn.ref_key = d.source_id
        WHERE d.source_type = 'dept_plan_created'
          AND NOT EXISTS (
              SELECT 1 FROM graph_edges covered
              WHERE covered.src_node_id = sn.node_id
                AND covered.dst_node_id = pn.node_id
                AND covered.edge_type = ANY(%s)
          )
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """,
        (list(PERSON_ROLE_EDGE_TYPES),),
    )
    engineers = cursor.rowcount

    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT sn.node_id, pn.node_id, 'involves'
        FROM source_documents d
        CROSS JOIN LATERAL jsonb_array_elements(d.facts->'engineer_plans') AS ep
        CROSS JOIN LATERAL jsonb_array_elements(ep->'agenda') AS agenda_item
        CROSS JOIN LATERAL jsonb_array_elements_text(agenda_item->'collaborator') AS collaborator_name
        JOIN actors a ON a.name = collaborator_name
        JOIN actor_identity ai ON ai.actor_id = a.actor_id
        JOIN graph_nodes pn ON pn.node_type = 'person'
                            AND pn.ref_key = (SELECT name FROM actors WHERE actor_id = ai.actor_id)
        JOIN graph_nodes sn ON sn.node_type = 'event' AND sn.ref_key = d.source_id
        WHERE d.source_type = 'dept_plan_created'
          AND NOT EXISTS (
              SELECT 1 FROM graph_edges covered
              WHERE covered.src_node_id = sn.node_id
                AND covered.dst_node_id = pn.node_id
                AND covered.edge_type = ANY(%s)
          )
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """,
        (list(PERSON_ROLE_EDGE_TYPES),),
    )
    collaborators = cursor.rowcount
    return engineers, collaborators


# Which facts field on which event type names a person in which role. Each of
# these was a plain 'involves' edge until now: document_actors is exactly the
# flattened union of these fields with the role dropped, so naming the role is
# a relabelling and not a second edge alongside the old one.
#
# The edge attaches to the event, because the event is where the role field
# lives and where both people on a two-role event (an author and a reviewer)
# are already attached. Putting 'reviewed_by' on the PR item instead would
# invent an edge where 'involves' never had one — PRs average 1.09 actors —
# which would make this an addition rather than a partition.
PERSON_ROLE_FIELDS = (
    # (edge type, source_type, facts field)
    ("authored_by", "confluence_created", "author"),
    ("authored_by", "pr_review", "author"),
    ("authored_by", "knowledge_gap_detected", "author"),
    ("reviewed_by", "pr_review", "reviewer"),
    ("reviewed_by", "knowledge_gap_detected", "reviewer"),
    ("led_by", "dept_plan_created", "lead"),
    ("assigned_to", "ticket_progress", "new_assignee"),
)


def build_person_role_edges(cursor) -> dict[str, int]:
    """event -> person, named for what the person did rather than only the fact
    that they were there.

    Resolved through actor_identity for the same alias-merging reason every
    other name lookup in this file goes through it. Counted per source, so a
    field whose rows all dedupe against another's shows up as contributing
    nothing rather than looking like it worked.
    """
    counts: dict[str, int] = {}
    for edge_type, source_type, field in PERSON_ROLE_FIELDS:
        cursor.execute(
            """
            INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
            SELECT DISTINCT en.node_id, pn.node_id, %s
            FROM source_documents d
            JOIN actors a ON a.name = d.facts->>%s
            JOIN actor_identity ai ON ai.actor_id = a.actor_id
            JOIN graph_nodes pn ON pn.node_type = 'person'
                                AND pn.ref_key = (
                                    SELECT name FROM actors WHERE actor_id = ai.actor_id
                                )
            JOIN graph_nodes en ON en.node_type = 'event' AND en.ref_key = d.source_id
            WHERE d.source_type = %s AND d.facts->>%s IS NOT NULL
            ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
            """,
            (edge_type, field, source_type, field),
        )
        counts[f"{edge_type} <- {source_type}.{field}"] = cursor.rowcount
    return counts


def build_knows_about_edges(cursor) -> int:
    """person -> item(domain), from the registry's known_by.

    The one new person relationship rather than a relabelling: known_by lists
    15-42 people per domain and has never been in the graph, so "who
    understands this" could not be asked of it. Distinct from owns_domain,
    which is the one or two people accountable for a domain rather than
    everyone who knows their way around it.
    """
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT pn.node_id, dn.node_id, 'knows_about'
        FROM domains d
        CROSS JOIN LATERAL jsonb_array_elements_text(d.known_by) AS known(name)
        JOIN actors a ON a.name = known.name
        JOIN actor_identity ai ON ai.actor_id = a.actor_id
        JOIN graph_nodes pn ON pn.node_type = 'person'
                            AND pn.ref_key = (
                                SELECT name FROM actors WHERE actor_id = ai.actor_id
                            )
        JOIN graph_nodes dn ON dn.node_type = 'item' AND dn.node_subtype = 'domain'
                            AND dn.ref_key = d.domain_key
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return cursor.rowcount


def build_escalation_role_edges(cursor) -> tuple[int, int]:
    """event(incident) -> person, for the two ends of an escalation.

    Replaces the escalation_chain node, which was 14 rows all carrying the
    literal label "Escalation Chain" — a contentless hub whose only job was
    joining a pair of people to an incident, and indistinguishable from the
    other thirteen on a diagram. An escalation is a fact about the incident,
    so its narrative goes into the incident's own props and the two people
    attach here.

    chain_detail is [[name, role], [name, role]]: the first raised it, the
    second received it. Two of the fourteen rows are
    trigger=post_departure_reroute with neither chain_detail nor an incident —
    a change to who escalates to whom after someone left, not an escalation of
    anything — and are deliberately left out of the graph.
    """
    counts = []
    for position, edge_type in ((0, "raised_by"), (1, "received_by")):
        cursor.execute(
            """
            INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
            SELECT DISTINCT en.node_id, pn.node_id, %s
            FROM source_documents d
            JOIN actors a ON a.name = d.facts->'chain_detail'->%s->>0
            JOIN actor_identity ai ON ai.actor_id = a.actor_id
            JOIN graph_nodes pn ON pn.node_type = 'person'
                                AND pn.ref_key = (
                                    SELECT name FROM actors WHERE actor_id = ai.actor_id
                                )
            JOIN graph_nodes en ON en.node_type = 'event'
                                AND en.node_subtype = 'incident'
                                AND en.ref_key = d.original_links->>'jira'
            WHERE d.source_type = 'escalation_chain' AND d.facts ? 'chain_detail'
            ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
            """,
            (edge_type, position),
        )
        counts.append(cursor.rowcount)
    return counts[0], counts[1]


def build_produced_edges(cursor) -> int:
    """event -> item/document it resulted in, from each event's own facts.

    Four sources, each a different shape of "this event made that":
      - jira_ticket_created / ticket_progress / pr_review name the jira/pr id
        they are about, in original_links
      - design_discussion names a confluence page only when facts.spawned_doc
        is true — 158 of 462 rows, not the rest
      - confluence_created names the page it made directly, in original_links —
        unlike knowledge_gap_detected, which also carries a confluence link but
        to a page that already existed, not one it produced
      - the incident's postmortem (a confluence page, when one exists) is
        produced by the merged incident node
    """
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, tn.node_id, 'produced'
        FROM source_documents d
        JOIN graph_nodes en ON en.node_type = 'event' AND en.ref_key = d.source_id
        JOIN graph_nodes tn ON tn.node_type = 'item'
                            AND tn.ref_key = coalesce(
                                d.original_links->>'jira', d.original_links->>'pr'
                            )
        WHERE d.source_type IN ('jira_ticket_created', 'ticket_progress', 'pr_review')
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    tickets = cursor.rowcount

    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, dn.node_id, 'produced'
        FROM source_documents d
        JOIN graph_nodes en ON en.node_type = 'event' AND en.ref_key = d.source_id
        JOIN graph_nodes dn ON dn.node_type = 'document'
                            AND dn.ref_key = d.original_links->>'confluence'
        WHERE d.source_type = 'design_discussion'
          AND (d.facts->>'spawned_doc')::boolean IS TRUE
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    discussions = cursor.rowcount

    # confluence_created names the page it made directly, the same shape as
    # the ticket/PR block above with a different key. knowledge_gap_detected
    # also carries original_links.confluence, on all 264 of its rows, but it
    # is naming a page that already existed when the gap was found — every one
    # of those pages was created before the detecting event's own timestamp —
    # so it is deliberately excluded here rather than folded in.
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, dn.node_id, 'produced'
        FROM source_documents d
        JOIN graph_nodes en ON en.node_type = 'event' AND en.ref_key = d.source_id
        JOIN graph_nodes dn ON dn.node_type = 'document'
                            AND dn.ref_key = d.original_links->>'confluence'
        WHERE d.source_type = 'confluence_created'
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    created = cursor.rowcount

    # An incident's postmortem, found the same way import_registries.py finds
    # the incident's own timing: the postmortem_created row whose causal_chain
    # starts with this incident's jira id.
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, dn.node_id, 'produced'
        FROM incidents i
        JOIN source_documents pm ON pm.source_type = 'postmortem_created'
                                  AND pm.facts->'causal_chain'->>0 = i.incident_key
        JOIN graph_nodes en ON en.node_type = 'event' AND en.ref_key = i.incident_key
        JOIN graph_nodes dn ON dn.node_type = 'document'
                            AND dn.ref_key = (
                                SELECT value FROM jsonb_array_elements_text(pm.facts->'causal_chain') v(value)
                                WHERE v.value LIKE 'CONF-%'
                                LIMIT 1
                            )
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return tickets + discussions + created + cursor.rowcount


def build_zd_ticket_edges(cursor) -> tuple[int, int, int]:
    """The merged zd_ticket event's three edges, each from a field the node
    already carries in props (built above from the corpus's own ticket_id/
    incident_id/postmortem_link, not inferred):

      produced       -> item(zd_ticket): the ticket itself
      caused_by      -> event(incident): only when this ticket was escalated
      documented_by  -> document(confluence): only when it was resolved with
                        a postmortem on record

    ZD-102 never escalated or was resolved, so it gets a 'produced' edge and
    nothing else — not a caused_by/documented_by edge pointing at null.
    """
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, tn.node_id, 'produced'
        FROM graph_nodes en
        JOIN graph_nodes tn ON tn.node_type = 'item' AND tn.node_subtype = 'zd_ticket'
                            AND tn.ref_key = en.ref_key
        WHERE en.node_type = 'event' AND en.node_subtype = 'zd_ticket'
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    produced = cursor.rowcount

    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, cn.node_id, 'caused_by'
        FROM graph_nodes en
        JOIN graph_nodes cn ON cn.node_type = 'event'
                            AND cn.ref_key = en.props->>'incident_id'
        WHERE en.node_type = 'event' AND en.node_subtype = 'zd_ticket'
          AND en.props->>'incident_id' IS NOT NULL
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    caused_by = cursor.rowcount

    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, dn.node_id, 'documented_by'
        FROM graph_nodes en
        JOIN graph_nodes dn ON dn.node_type = 'document'
                            AND dn.ref_key = en.props->>'postmortem_link'
        WHERE en.node_type = 'event' AND en.node_subtype = 'zd_ticket'
          AND en.props->>'postmortem_link' IS NOT NULL
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    documented_by = cursor.rowcount
    return produced, caused_by, documented_by


def build_incident_recurrence_edges(cursor) -> int:
    """incident event -> incident event, from incident_opened's own
    facts.recurrence_of — the corpus names which earlier incident this one is
    a repeat of directly, no keyword or root_cause-prose matching involved.

    This is a second, distinct source of caused_by edges alongside the
    zd_ticket ones above: those connect a zd_ticket event to the incident it
    escalated into; these connect two incident events to each other. Both use
    edge_type='caused_by' but never share a node pair.
    """
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, cn.node_id, 'caused_by'
        FROM source_documents d
        JOIN graph_nodes en ON en.node_type = 'event'
                            AND en.ref_key = d.facts->'causal_chain'->>0
        JOIN graph_nodes cn ON cn.node_type = 'event'
                            AND cn.ref_key = d.facts->>'recurrence_of'
        WHERE d.source_type = 'incident_opened'
          AND d.facts ? 'recurrence_of'
          AND d.facts->>'recurrence_of' <> ''
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return cursor.rowcount


def build_thread_edges(cursor) -> dict[str, int]:
    """Edges read off facts.causal_chain, which is an artifact's thread rather
    than a chain of events: a ticket, its comments, the PR that closed it, the
    page that wrote it up, repeated and extended on every later row that
    carries it. Comments and slack messages are not graph nodes, so only the
    thread's root and the graph nodes later in it are connected:

      tracked_in      event(incident) -> item(jira), same key: the ticket the
                      incident was tracked in
      fixed_by        event(incident) -> item(pr) in the incident's thread
      implemented_by  item(jira) -> item(pr) in the ticket's thread
      documented_by   item(jira) -> document in the ticket's thread

    Verified on the corpus: each of the 57 PRs appears in exactly one ticket's
    thread.
    """
    counts: dict[str, int] = {}

    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT en.node_id, tn.node_id, 'tracked_in'
        FROM graph_nodes en
        JOIN graph_nodes tn ON tn.node_type = 'item' AND tn.node_subtype = 'jira'
                            AND tn.ref_key = en.ref_key
        WHERE en.node_type = 'event' AND en.node_subtype = 'incident'
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    counts["tracked_in"] = cursor.rowcount

    # Every (thread root, later member) pair, where the root is a jira ticket
    # node. Positions start at 1; the root is position 1.
    later_members = """
        SELECT DISTINCT d.facts->'causal_chain'->>0 AS root, member.id
        FROM source_documents d
        CROSS JOIN LATERAL jsonb_array_elements_text(d.facts->'causal_chain')
             WITH ORDINALITY AS member(id, position)
        WHERE jsonb_typeof(d.facts->'causal_chain') = 'array'
          AND member.position > 1
    """
    for edge_type, source_filter, target_filter in (
        ("fixed_by",
         "src.node_type = 'event' AND src.node_subtype = 'incident'",
         "dst.node_type = 'item' AND dst.node_subtype = 'pr'"),
        ("implemented_by",
         "src.node_type = 'item' AND src.node_subtype = 'jira'",
         "dst.node_type = 'item' AND dst.node_subtype = 'pr'"),
        ("documented_by",
         "src.node_type = 'item' AND src.node_subtype = 'jira'",
         "dst.node_type = 'document'"),
    ):
        cursor.execute(
            f"""
            WITH pairs AS ({later_members})
            INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
            SELECT DISTINCT src.node_id, dst.node_id, %s
            FROM pairs
            JOIN graph_nodes src ON src.ref_key = pairs.root AND {source_filter}
            JOIN graph_nodes dst ON dst.ref_key = pairs.id AND {target_filter}
            ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
            """,
            (edge_type,),
        )
        counts[edge_type] = cursor.rowcount
    return counts


def build_owns_domain_edges(cursor) -> int:
    """person -> item(domain), from the registry's primary/former owner."""
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT pn.node_id, dn.node_id, 'owns_domain'
        FROM domains d
        JOIN graph_nodes dn ON dn.node_type = 'item' AND dn.ref_key = d.domain_key
        JOIN graph_nodes pn ON pn.node_type = 'person'
                            AND pn.ref_key IN (d.primary_owner, d.former_owner)
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return cursor.rowcount


# Distinctive terms that name a domain in a title or a root cause. Only terms
# that belong to one domain: the registry's own system_tags include words like
# "auth", "service", "cost", "project" and "flow", which would tie half the
# corpus to every domain. auth-service excludes "legacy auth service", which is
# a different domain. "cost‑tag" appears with a non-breaking hyphen in the
# corpus (ENG-112's root cause), hence the character class. Postgres ARE
# syntax: \m / \M are word boundaries.
DOMAIN_MENTIONS = (
    ("titandb", r"\mtitan ?db\M"),
    ("project_titan", r"\mproject titan\M"),
    ("kubernetes-deploy", r"\m(kubernetes|k8s|eks)\M"),
    ("terraform-infra", r"\mterraform\M"),
    ("redis-cache", r"\mredis\M"),
    ("oauth2-flow", r"\moauth2?\M"),
    ("auth-service", r"(?<!legacy )\mauth[-‑ ]service\M"),
    ("legacy_auth_service", r"\mlegacy auth\M"),
    ("aws_cost_structure", r"\maws cost\M|\mcost[-‑– ]?tag"),
    ("mobile_analytics", r"\mmobile analytics\M"),
)

# Incident titles carry a bracketed list — "[TitanDB, legacy auth service, AWS
# cost structure, Project Titan undocumented]", "[recurrence of ENG-112]" —
# that is the departed employee's whole domain list, the same on every
# incident it is attached to, so it says nothing about this one. Stripped
# before matching.
STRIP_BRACKETS = r"\s*\[[^]]*\]"


def build_updates_domain_edges(cursor) -> int:
    """document -> item(domain), from confluence_created.facts.domains_updated:
    the domains whose documentation the new page counted toward. Names resolve
    against the registry's name or key, case-insensitively ("AWS cost
    structure" -> aws_cost_structure)."""
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT dn.node_id, dom.node_id, 'updates_domain'
        FROM source_documents d
        CROSS JOIN LATERAL jsonb_array_elements_text(d.facts->'domains_updated') AS v(name)
        JOIN domains reg ON lower(reg.name) = lower(v.name) OR reg.domain_key = v.name
        JOIN graph_nodes dn ON dn.node_type = 'document'
                            AND dn.ref_key = d.original_links->>'confluence'
        JOIN graph_nodes dom ON dom.node_type = 'item' AND dom.node_subtype = 'domain'
                             AND dom.ref_key = reg.domain_key
        WHERE d.source_type = 'confluence_created'
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return cursor.rowcount


def build_about_domain_edges(cursor) -> tuple[int, int, int]:
    """-> item(domain) when the thing names the domain itself.

    Three sources, each recorded on the edge as props.source with the term that
    matched as props.term, so an edge can always be traced back to the words
    that made it:
      registry    an incident's incidents.root_domain, when set (it is not in
                  this corpus: nothing states it, and it is not guessed)
      root_cause  an incident event's own root_cause names the domain
      title       a jira/PR item's or confluence page's title does, bracketed
                  gap lists removed first (see STRIP_BRACKETS)
    """
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type, props)
        SELECT DISTINCT en.node_id, dn.node_id, 'about_domain',
               jsonb_build_object('source', 'registry')
        FROM incidents i
        JOIN graph_nodes en ON en.node_type = 'event' AND en.ref_key = i.incident_key
        JOIN domains d ON d.domain_id = i.root_domain
        JOIN graph_nodes dn ON dn.node_type = 'item' AND dn.ref_key = d.domain_key
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    registry = cursor.rowcount

    keys = [key for key, _ in DOMAIN_MENTIONS]
    patterns = [pattern for _, pattern in DOMAIN_MENTIONS]

    cursor.execute(
        """
        WITH mention AS (SELECT * FROM unnest(%s::text[], %s::text[]) AS m(domain_key, pattern)),
        incident AS (
            SELECT node_id, props->>'root_cause' AS text
            FROM graph_nodes
            WHERE node_type = 'event' AND node_subtype = 'incident'
              AND props->>'root_cause' IS NOT NULL
        )
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type, props)
        SELECT i.node_id, dn.node_id, 'about_domain',
               jsonb_build_object('source', 'root_cause',
                                  'term', (regexp_match(i.text, '(' || m.pattern || ')', 'i'))[1])
        FROM incident i
        JOIN mention m ON i.text ~* m.pattern
        JOIN graph_nodes dn ON dn.node_type = 'item' AND dn.node_subtype = 'domain'
                            AND dn.ref_key = m.domain_key
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """,
        (keys, patterns),
    )
    root_cause = cursor.rowcount

    cursor.execute(
        """
        WITH mention AS (SELECT * FROM unnest(%s::text[], %s::text[]) AS m(domain_key, pattern)),
        work AS (
            SELECT node_id, regexp_replace(label, %s, '', 'g') AS text
            FROM graph_nodes
            WHERE (node_type = 'item' AND node_subtype IN ('jira', 'pr'))
               OR (node_type = 'document' AND node_subtype = 'confluence')
        )
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type, props)
        SELECT w.node_id, dn.node_id, 'about_domain',
               jsonb_build_object('source', 'title',
                                  'term', (regexp_match(w.text, '(' || m.pattern || ')', 'i'))[1])
        FROM work w
        JOIN mention m ON w.text ~* m.pattern
        JOIN graph_nodes dn ON dn.node_type = 'item' AND dn.node_subtype = 'domain'
                            AND dn.ref_key = m.domain_key
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """,
        (keys, patterns, STRIP_BRACKETS),
    )
    return registry, root_cause, cursor.rowcount


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--reset", action="store_true",
        help="empty graph_nodes and graph_edges before building",
    )
    arguments = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required.")

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            if arguments.reset:
                reset_graph(cursor)
                print("Cleared the existing graph.", file=sys.stderr)

            print(f"person nodes:      {build_person_nodes(cursor)}", file=sys.stderr)
            print(f"organization nodes: {build_organization_nodes(cursor)}", file=sys.stderr)
            print(f"department nodes:  {build_department_nodes(cursor)}", file=sys.stderr)
            print(f"domain item nodes: {build_domain_item_nodes(cursor)}", file=sys.stderr)
            print(f"work item nodes:   {build_work_item_nodes(cursor)}", file=sys.stderr)
            print(f"document nodes:    {build_confluence_document_nodes(cursor)}", file=sys.stderr)
            print(f"standalone events: {build_standalone_event_nodes(cursor)}", file=sys.stderr)
            print(f"incident events:   {build_incident_event_nodes(cursor)}", file=sys.stderr)
            print(f"zd_ticket events:  {build_zd_ticket_event_nodes(cursor)}", file=sys.stderr)

            # Role edges first: 'involves' is defined as what they do not
            # cover, so it has to be able to ask them.
            for label, count in build_person_role_edges(cursor).items():
                print(f"  {label}: {count}", file=sys.stderr)
            esc_raised, esc_received = build_escalation_role_edges(cursor)
            print(f"  raised_by <- escalation_chain: {esc_raised}", file=sys.stderr)
            print(f"  received_by <- escalation_chain: {esc_received}", file=sys.stderr)
            print(f"knows_about edges:   {build_knows_about_edges(cursor)}", file=sys.stderr)
            members, leads, domain_depts = build_department_edges(cursor)
            print(f"member_of edges:     {members}", file=sys.stderr)
            print(f"leads edges:         {leads}", file=sys.stderr)
            print(f"belongs_to edges:    {domain_depts}", file=sys.stderr)

            # Before 'involves', which is what the typed edges leave uncovered.
            for label, count in build_customer_vendor_edges(cursor).items():
                print(f"{label} edges: {count}", file=sys.stderr)
            print(f"involves edges:      {build_involves_edges(cursor)}", file=sys.stderr)
            dp_engineers, dp_collaborators = build_dept_plan_involves_edges(cursor)
            print(f"dept_plan engineer involves:     {dp_engineers}", file=sys.stderr)
            print(f"dept_plan collaborator involves: {dp_collaborators}", file=sys.stderr)
            print(f"produced edges:      {build_produced_edges(cursor)}", file=sys.stderr)
            zd_produced, zd_caused_by, zd_documented_by = build_zd_ticket_edges(cursor)
            print(f"zd_ticket produced:      {zd_produced}", file=sys.stderr)
            print(f"zd_ticket caused_by:     {zd_caused_by}", file=sys.stderr)
            print(f"zd_ticket documented_by: {zd_documented_by}", file=sys.stderr)
            print(f"incident recurrence caused_by: {build_incident_recurrence_edges(cursor)}", file=sys.stderr)
            for label, count in build_thread_edges(cursor).items():
                print(f"{label} edges: {count}", file=sys.stderr)
            print(f"owns_domain edges:   {build_owns_domain_edges(cursor)}", file=sys.stderr)
            print(f"updates_domain edges: {build_updates_domain_edges(cursor)}", file=sys.stderr)
            from_registry, from_root_cause, from_title = build_about_domain_edges(cursor)
            print(f"about_domain <- registry:   {from_registry}", file=sys.stderr)
            print(f"about_domain <- root_cause: {from_root_cause}", file=sys.stderr)
            print(f"about_domain <- title:      {from_title}", file=sys.stderr)

            cursor.execute("SELECT node_type, count(*) FROM graph_nodes GROUP BY 1 ORDER BY 1")
            print("\nnodes by type:", file=sys.stderr)
            for node_type, count in cursor.fetchall():
                print(f"  {node_type:12} {count}", file=sys.stderr)

            cursor.execute("SELECT edge_type, count(*) FROM graph_edges GROUP BY 1 ORDER BY 1")
            print("edges by type:", file=sys.stderr)
            for edge_type, count in cursor.fetchall():
                print(f"  {edge_type:14} {count}", file=sys.stderr)
        connection.commit()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
