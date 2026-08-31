-- Add provider and provider_config to whatsapp_config
ALTER TABLE whatsapp_config 
ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta', 'evolution')),
ADD COLUMN IF NOT EXISTS provider_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- phone_number_id and access_token were originally created as NOT NULL for meta,
-- Evolution doesn't use phone_number_id or access_token the same way.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

-- Ensure that if provider is 'meta', phone_number_id and access_token are present
ALTER TABLE whatsapp_config 
ADD CONSTRAINT meta_provider_requirements 
CHECK (
  (provider = 'meta' AND phone_number_id IS NOT NULL AND access_token IS NOT NULL) OR 
  (provider = 'evolution')
);
