-- Tell the people who write in from outside apart from the people who work
-- here, and connect customers and vendors to the work that is about them.
--
-- Nine actors are external senders, not employees: every
-- inbound_external_email names its sender in facts.source and the sender's
-- company in facts.org, and these nine only ever appear on external mail —
-- seven vendor contacts (Nora at AWS, Lena at Datadog, Ethan at Firebase, Ravi
-- at GitHub Enterprise, Yara at Jenkins, Mona at Kafka, Arun at Terraform) and
-- customer contacts (Ethan at Metro United FC, Nisha at the National Olympic
-- Training Center, Isabel at Velox Pro Cycling). They kept migration 005's
-- default actor_kind 'employee', and so were drawn as employees with no
-- department.
--
-- Three of them were also merged into employees by disambiguate_actors.py
-- (migration 008): "Ethan" into Ethan Patel, "Nisha" into Nisha Rao, "Isabel"
-- into Isabel Garcia. Its department check read the department of the
-- documents a name appears on, and a vendor's mail is routed to a department,
-- so a Firebase sales contact writing from day 2 was merged into an engineer
-- hired on day 26. Those three aliases are removed here, and the script now
-- refuses any short form that is an external sender.
--
-- 'external_contact' is a new actor_kind, not 'vendor' or 'customer': those
-- two make an organization node, and these are people.
--
-- migrate.ts replays every migration on each run, so this is idempotent.

BEGIN;

ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_actor_kind_check;
ALTER TABLE actors ADD CONSTRAINT actors_actor_kind_check
    CHECK (actor_kind IN ('employee', 'vendor', 'customer', 'external_contact', 'unknown'));

-- A person who sends external mail on behalf of an organization other than
-- themselves (an organization writing as itself, "Metro United FC" from
-- "Metro United FC", is already actor_kind 'customer').
UPDATE actors SET actor_kind = 'external_contact'
WHERE actor_kind = 'employee'
  AND name IN (
      SELECT facts->>'source'
      FROM source_documents
      WHERE source_type = 'inbound_external_email'
        AND facts->>'category' IN ('vendor', 'customer')
        AND facts->>'source' <> facts->>'org'
  );

DELETE FROM actor_aliases
WHERE alias IN (SELECT name FROM actors WHERE actor_kind = 'external_contact');

ALTER TABLE graph_edges DROP CONSTRAINT IF EXISTS graph_edges_edge_type_check;
ALTER TABLE graph_edges ADD CONSTRAINT graph_edges_edge_type_check
    CHECK (edge_type IN (
        'produced',        -- event -> document/item it resulted in
        'caused_by',       -- event -> the event that caused it
        'escalated_via',   -- retired by 013's rebuild, kept legal
        'documented_by',   -- event -> the document recording it
        'involves',        -- event/document -> person, role unknown
        'about_domain',    -- document/item -> item(domain)
        'owns_domain',     -- person -> item(domain), from the registry
        'knows_about',     -- person -> item(domain), from the registry's known_by
        'authored_by',     -- event -> the person who wrote the thing it produced
        'reviewed_by',     -- event -> the person who reviewed it
        'led_by',          -- event -> the person leading it
        'assigned_to',     -- event -> the person work moved to
        'raised_by',       -- event(incident) -> who escalated it
        'received_by',     -- event(incident) -> who it was escalated to
        'member_of',       -- person -> organization(department)
        'leads',           -- person -> organization(department)
        'belongs_to',      -- item(domain) -> organization(department)
        'updates_domain',  -- document -> item(domain), from confluence_created.domains_updated
        'tracked_in',      -- event(incident) -> item(jira) it was tracked in
        'fixed_by',        -- event(incident) -> item(pr) in its resolution thread
        'implemented_by',  -- item(jira) -> item(pr) in the ticket's own thread
        'for_customer',    -- item/event -> organization(customer) it is for
        'from_vendor',     -- item(jira) -> organization(vendor) whose email opened it
        'contact_for'      -- person(external_contact) -> organization they write for
    ));

COMMIT;
