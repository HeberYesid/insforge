-- Keep auth-aware ownership available for every todo record.
CREATE OR REPLACE FUNCTION public.requesting_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::text;
$$;

-- Create the todo table if it doesn't exist.
CREATE TABLE IF NOT EXISTS todo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_completed boolean NOT NULL DEFAULT false,
  file_url text,
  file_key text,
  user_id text NOT NULL DEFAULT public.requesting_user_id()
);

-- Backfill existing shared rows to the built-in admin account so they keep an owner.
ALTER TABLE todo ADD COLUMN IF NOT EXISTS user_id text;
UPDATE todo
SET user_id = '00000000-0000-0000-0000-000000000001'
WHERE user_id IS NULL;
ALTER TABLE todo ALTER COLUMN user_id SET DEFAULT public.requesting_user_id();
ALTER TABLE todo ALTER COLUMN user_id SET NOT NULL;

-- Restrict rows to the signed-in owner.
ALTER TABLE todo ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS todo_select_own ON todo;
DROP POLICY IF EXISTS todo_insert_own ON todo;
DROP POLICY IF EXISTS todo_update_own ON todo;
DROP POLICY IF EXISTS todo_delete_own ON todo;

CREATE POLICY todo_select_own
ON todo
FOR SELECT
USING (user_id = public.requesting_user_id());

CREATE POLICY todo_insert_own
ON todo
FOR INSERT
WITH CHECK (user_id = public.requesting_user_id());

CREATE POLICY todo_update_own
ON todo
FOR UPDATE
USING (user_id = public.requesting_user_id())
WITH CHECK (user_id = public.requesting_user_id());

CREATE POLICY todo_delete_own
ON todo
FOR DELETE
USING (user_id = public.requesting_user_id());

CREATE INDEX IF NOT EXISTS todo_user_id_created_at_idx
ON todo (user_id, created_at DESC);

-- Create the storage bucket for todo attachments.
INSERT INTO storage.buckets (name, public)
VALUES ('todo-attachments', true)
ON CONFLICT (name) DO UPDATE
SET public = excluded.public,
    updated_at = now();
