-- Per-user appearance settings (theme, colour, layout, density). Follows the person across devices.
ALTER TABLE app_user ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}'::jsonb;
