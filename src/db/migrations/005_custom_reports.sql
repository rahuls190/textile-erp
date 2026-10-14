-- Custom reports: a saved report is only a description (dataset, columns, filters); it is checked against the caller's rights every time it runs.
CREATE TABLE saved_report (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES app_user(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  question   text,
  spec       jsonb NOT NULL,
  shared     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_report_owner_idx ON saved_report(owner_id);
