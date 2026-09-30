-- Emails whose Human Review items were all resolved before the "reviewed"
-- state existed stayed "awaiting_review" / "routing". Move them on.
UPDATE "email" e
SET "state" = 'reviewed', "state_updated_at" = now()
WHERE e."state" IN ('awaiting_review', 'routing')
  AND EXISTS (SELECT 1 FROM "human_review_item" h WHERE h."email_id" = e."id" AND h."status" = 'resolved')
  AND NOT EXISTS (SELECT 1 FROM "human_review_item" h WHERE h."email_id" = e."id" AND h."status" = 'open');
