UPDATE "public"."todo"
SET "status" = CASE
  WHEN "status" = 'not_started' THEN 'todo'
  WHEN "status" = 'partial' THEN 'doing'
  WHEN "status" = 'pending' THEN 'todo'
  WHEN "status" IN ('in_progress', 'in progress') THEN 'doing'
  WHEN "status" = 'completed' THEN 'done'
  ELSE "status"
END
WHERE "status" IN ('not_started', 'partial', 'pending', 'in_progress', 'in progress', 'completed');

UPDATE "public"."todo_history"
SET "status" = CASE
  WHEN "status" = 'not_started' THEN 'todo'
  WHEN "status" = 'partial' THEN 'doing'
  WHEN "status" = 'pending' THEN 'todo'
  WHEN "status" IN ('in_progress', 'in progress') THEN 'doing'
  WHEN "status" = 'completed' THEN 'done'
  ELSE "status"
END
WHERE "status" IN ('not_started', 'partial', 'pending', 'in_progress', 'in progress', 'completed');

ALTER TABLE "public"."todo"
  DROP CONSTRAINT IF EXISTS "todo_status_check";

ALTER TABLE "public"."todo"
  ADD CONSTRAINT "todo_status_check"
  CHECK (status IS NULL OR status = ANY (ARRAY['todo'::text, 'doing'::text, 'done'::text, 'blocked'::text, 'skipped'::text]));

ALTER TABLE "public"."todo_history"
  DROP CONSTRAINT IF EXISTS "todo_history_status_check";

ALTER TABLE "public"."todo_history"
  ADD CONSTRAINT "todo_history_status_check"
  CHECK (status IS NULL OR status = ANY (ARRAY['todo'::text, 'doing'::text, 'done'::text, 'blocked'::text, 'skipped'::text]));
