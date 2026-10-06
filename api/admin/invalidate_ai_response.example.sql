-- Administrative procedure; do not place a response ID here until the invalidation
-- has been explicitly approved. This preserves the historical row while preventing
-- the response from being returned by FilingLens cache/read paths.
INSERT INTO ai_response_invalidations
  (response_id, reason_code, detail, invalidated_at, invalidated_by)
VALUES
  ('REPLACE_WITH_APPROVED_RESPONSE_ID', 'DERIVED_VALUE_PRECISION_DEFECT',
   'A derived financial value was calculated from rounded display inputs.',
   CURRENT_TIMESTAMP, 'approved-administrator')
ON CONFLICT(response_id) DO UPDATE SET
  reason_code = excluded.reason_code,
  detail = excluded.detail,
  invalidated_at = excluded.invalidated_at,
  invalidated_by = excluded.invalidated_by;
