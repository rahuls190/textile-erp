-- AI model registry: providers (with sealed API keys), models, which model does which job, and a call log.
CREATE TABLE ai_provider (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('anthropic','openai','google','openai_compatible')),
  base_url   text,
  api_key_sealed text,                 -- AES-GCM sealed; never returned by any read
  key_last4  text,
  enabled    boolean NOT NULL DEFAULT false,
  version    int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_model (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES ai_provider(id),
  model_id    text NOT NULL,           -- the provider's own model name
  label       text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  max_tokens  int NOT NULL DEFAULT 1024 CHECK (max_tokens BETWEEN 64 AND 32000),
  temperature numeric(3,2) NOT NULL DEFAULT 0.2 CHECK (temperature BETWEEN 0 AND 2),
  UNIQUE (provider_id, model_id)
);
CREATE TABLE ai_assignment (
  purpose     text PRIMARY KEY CHECK (purpose IN ('assistant','reports')),
  model_id    uuid REFERENCES ai_model(id),
  fallback_id uuid REFERENCES ai_model(id)
);
INSERT INTO ai_assignment(purpose) VALUES ('assistant'), ('reports');
CREATE TABLE ai_call_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   uuid,
  purpose   text NOT NULL,
  model     text,
  ok        boolean NOT NULL,
  ms        int,
  error     text
);
CREATE TRIGGER ai_call_log_ro BEFORE UPDATE OR DELETE ON ai_call_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
