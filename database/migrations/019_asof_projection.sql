-- The date-view planner's projection: what each employee had planned on each
-- simulated day, and what state each ticket was in over time.
--
-- Both tables are built offline by orgforge_kb/build_timeline.py from two kinds
-- of simulation event — daily department plans (dept_plan_created) and ticket
-- progress (ticket_progress) — plus the jira artifacts themselves. Only these
-- projected rows are deployed; the raw sim_event rows are not. A projected row
-- is never Company Evidence (see docs/mvp.md, "Date-view planner projection"):
--
--   derived_from  the simulation events the row was read from, for audit;
--                 never shown as a citation
--   sources       the employee-visible Company Artifacts the row is about
--                 (a jira ticket, a PR), which an answer may cite
--
-- migrate.ts replays every migration on each run, so this is idempotent.

BEGIN;

-- One item of one person's plan for one day, in the order the plan lists it.
CREATE TABLE IF NOT EXISTS day_plan_entry (
    person         text        NOT NULL,
    day            date        NOT NULL,
    seq            integer     NOT NULL,
    department     text,
    title          text        NOT NULL,
    activity_type  text,
    est_hours      numeric(4, 1),
    collaborators  text[]      NOT NULL DEFAULT '{}',
    deferred       boolean     NOT NULL DEFAULT false,
    defer_reason   text,
    item_key       text,
    derived_from   text[]      NOT NULL DEFAULT '{}',
    sources        text[]      NOT NULL DEFAULT '{}',
    PRIMARY KEY (person, day, seq)
);
CREATE INDEX IF NOT EXISTS day_plan_entry_day_idx ON day_plan_entry (day);

-- One interval over which a ticket's status and assignee held. assignee is
-- empty until the corpus names someone working on it (see build_timeline.py). valid_to is
-- the day the next interval starts (exclusive), or NULL for the latest one, so
-- "the state on day D" is: valid_from <= D AND (valid_to IS NULL OR valid_to > D).
CREATE TABLE IF NOT EXISTS work_item_state (
    item_key      text     NOT NULL,
    valid_from    date     NOT NULL,
    valid_to      date,
    status        text     NOT NULL,
    assignee      text,
    title         text,
    department    text,
    points        integer,
    sprint_no     integer,
    -- who raised the ticket (usually a department lead), never who works on it
    reporter      text,
    derived_from  text[]   NOT NULL DEFAULT '{}',
    sources       text[]   NOT NULL DEFAULT '{}',
    PRIMARY KEY (item_key, valid_from),
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS work_item_state_assignee_idx ON work_item_state (assignee, valid_from);

COMMIT;
