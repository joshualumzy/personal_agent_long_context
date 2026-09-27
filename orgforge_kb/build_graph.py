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

organization has no data yet: actor_kind is 'employee' for all 76 actors, and
sf_account (the vendor/customer registry) has zero rows in this corpus. The
type is declared and left empty rather than populated with a guess.

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
    "pr_review", "sprint_planned", "escalation_chain", "confluence_created",
)


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
    """
    cursor.execute(
        """
        INSERT INTO graph_nodes (node_type, node_subtype, ref_key, label, props)
        SELECT DISTINCT
            'person', 'employee', a.name, a.name,
            jsonb_build_object('role', a.role, 'dept', a.dept)
        FROM actor_identity ai
        JOIN actors a ON a.actor_id = ai.actor_id
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    return cursor.rowcount


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
            'item', d.source_type, d.source_id,
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
                'root_domain', dm.domain_key
            )
        FROM incidents i
        LEFT JOIN source_documents j ON j.source_id = i.incident_key
        LEFT JOIN domains dm ON dm.domain_id = i.root_domain
        ON CONFLICT (node_type, ref_key) DO UPDATE SET
            label = EXCLUDED.label, props = EXCLUDED.props
        """
    )
    return cursor.rowcount


# ---------------------------------------------------------------------------
# Edges
# ---------------------------------------------------------------------------
def build_involves_edges(cursor) -> int:
    """event/document -> person, from the normalized actor junction.

    Resolved through actor_identity so a document naming "Ethan" links to the
    same person node a document naming "Ethan Patel" does.
    """
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT sn.node_id, pn.node_id, 'involves'
        FROM document_actors da
        JOIN actor_identity ai ON ai.actor_id = da.actor_id
        JOIN graph_nodes pn ON pn.node_type = 'person' AND pn.ref_key = (
            SELECT name FROM actors WHERE actor_id = ai.actor_id
        )
        JOIN graph_nodes sn ON sn.ref_key = da.source_id
                            AND sn.node_type IN ('event', 'document', 'item')
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return cursor.rowcount


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


def build_escalated_via_edges(cursor) -> int:
    """incident event -> escalation_chain event, from the escalation's own
    original_links.jira — it already names which incident it belongs to."""
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, xn.node_id, 'escalated_via'
        FROM source_documents d
        JOIN graph_nodes en ON en.node_type = 'event'
                            AND en.ref_key = d.original_links->>'jira'
        JOIN graph_nodes xn ON xn.node_type = 'event' AND xn.ref_key = d.source_id
        WHERE d.source_type = 'escalation_chain'
          AND d.original_links ? 'jira'
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return cursor.rowcount


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


def build_about_domain_edges(cursor) -> int:
    """item/document -> item(domain), from an incident's own root_domain."""
    cursor.execute(
        """
        INSERT INTO graph_edges (src_node_id, dst_node_id, edge_type)
        SELECT DISTINCT en.node_id, dn.node_id, 'about_domain'
        FROM incidents i
        JOIN graph_nodes en ON en.node_type = 'event' AND en.ref_key = i.incident_key
        JOIN domains d ON d.domain_id = i.root_domain
        JOIN graph_nodes dn ON dn.node_type = 'item' AND dn.ref_key = d.domain_key
        ON CONFLICT (src_node_id, dst_node_id, edge_type) DO NOTHING
        """
    )
    return cursor.rowcount


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
            print(f"domain item nodes: {build_domain_item_nodes(cursor)}", file=sys.stderr)
            print(f"work item nodes:   {build_work_item_nodes(cursor)}", file=sys.stderr)
            print(f"document nodes:    {build_confluence_document_nodes(cursor)}", file=sys.stderr)
            print(f"standalone events: {build_standalone_event_nodes(cursor)}", file=sys.stderr)
            print(f"incident events:   {build_incident_event_nodes(cursor)}", file=sys.stderr)

            print(f"involves edges:      {build_involves_edges(cursor)}", file=sys.stderr)
            print(f"produced edges:      {build_produced_edges(cursor)}", file=sys.stderr)
            print(f"escalated_via edges: {build_escalated_via_edges(cursor)}", file=sys.stderr)
            print(f"owns_domain edges:   {build_owns_domain_edges(cursor)}", file=sys.stderr)
            print(f"about_domain edges:  {build_about_domain_edges(cursor)}", file=sys.stderr)

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
