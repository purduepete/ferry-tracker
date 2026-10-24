-- Explicit reviewed deployment step. Runtime startup never executes DDL.
BEGIN;
DO $$
BEGIN
    PERFORM 1 FROM public.solutiondeploy_schema WHERE app_id = 'ferry-tracker' AND version = 1 FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ferry schema ledger must be version 1 before migration';
    END IF;
END $$;
CREATE TABLE public.notification_subscriptions (
    scope TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    settings_json TEXT NOT NULL,
    state_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
CREATE TABLE public.notification_events (
    event_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL REFERENCES public.notification_subscriptions(scope),
    status TEXT NOT NULL CHECK (status IN ('claimed', 'accepted', 'failed', 'uncertain')),
    claimed_at TEXT NOT NULL,
    finished_at TEXT,
    retry_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    detail TEXT
);
CREATE INDEX ix_notification_events_scope ON public.notification_events(scope, claimed_at);
UPDATE public.solutiondeploy_schema SET version = 2 WHERE app_id = 'ferry-tracker' AND version = 1;
COMMIT;
