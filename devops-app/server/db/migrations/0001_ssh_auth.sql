-- Replace sshKeyPath with sshAuthMethod + sshPrivateKey + sshPassword
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "ssh_auth_method" text NOT NULL DEFAULT 'key';
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "ssh_private_key" text;
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "ssh_password" text;

-- Migrate existing data: copy key path content to private key field (manual step needed)
-- DROP old column after migration is verified
ALTER TABLE "servers" DROP COLUMN IF EXISTS "ssh_key_path";
