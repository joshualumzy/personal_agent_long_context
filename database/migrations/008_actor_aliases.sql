-- Reversible, evidenced actor merging.
--
-- actors.name UNIQUE means a false split ("Ethan" / "Ethan Patel", 481
-- documents between them) cannot be fixed by editing actors — there is no
-- column to say "these are the same actor" — and a wrong merge could not be
-- told apart from a right one after the fact. This table makes a merge an
-- assertion with evidence, not a fait accompli baked into actors.name.
--
-- confidence distinguishes what domain_registry.json states outright from
-- what is inferred from department overlap and a prefix match: the registry
-- names "Ethan Patel" as knowing five domains and never once names "Ethan",
-- which is stronger evidence than department overlap alone gives for
-- "Nisha"/"Nisha Rao" or "Isabel"/"Isabel Garcia".

BEGIN;

CREATE TABLE IF NOT EXISTS actor_aliases (
    alias      TEXT PRIMARY KEY,
    actor_id   BIGINT NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
    confidence TEXT NOT NULL CHECK (confidence IN ('asserted', 'inferred')),
    evidence   TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS actor_aliases_actor_idx ON actor_aliases (actor_id);

-- A canonical actor resolves through itself, so a caller can look up "any name
-- that refers to this actor" without a special case for the actor's own name.
--
-- A name can have both: it is some actor's own recorded name in `actors`, and
-- separately asserted as an alias of a different actor in `actor_aliases` — as
-- "Ethan" is, once "Ethan" is aliased to "Ethan Patel". Left unresolved that is
-- two rows for one alias, and code joining on it would double-count the
-- documents naming "Ethan". The alias wins: once the corpus is asserted or
-- inferred to mean a different actor, that is what "Ethan" now resolves to,
-- and the self-identity row is redundant, not additional information.
CREATE OR REPLACE VIEW actor_identity AS
    SELECT alias, actor_id, confidence, evidence FROM actor_aliases
    UNION ALL
    SELECT a.name, a.actor_id, 'asserted'::text, 'is its own recorded name'::text
    FROM actors a
    WHERE NOT EXISTS (
        SELECT 1 FROM actor_aliases WHERE actor_aliases.alias = a.name
    );

COMMIT;
