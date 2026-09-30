-- Correction to 20260928130000: an email whose review items were closed by
-- reprocessing (not by a person) got a newer routing decision afterwards; its
-- state belongs to that decision ("routing"), not "reviewed".
UPDATE "email" e
SET "state" = 'routing', "state_updated_at" = now()
WHERE e."state" = 'reviewed'
  AND EXISTS (
    SELECT 1 FROM "routing_decision" d
    WHERE d."email_id" = e."id" AND d."superseded_at" IS NULL
      AND d."created_at" > (SELECT max(h."resolved_at") FROM "human_review_item" h WHERE h."email_id" = e."id")
  );
