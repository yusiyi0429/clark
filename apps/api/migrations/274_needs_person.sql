-- 要本人补（主循环第 61 条，契约 CardHandbackOutcome）：交回的结论多一种 needs_person，不算没过。
ALTER TABLE card_handbacks DROP CONSTRAINT card_handbacks_outcome_check;
ALTER TABLE card_handbacks ADD CONSTRAINT card_handbacks_outcome_check CHECK (outcome IN ('pass', 'fail', 'needs_person'));
