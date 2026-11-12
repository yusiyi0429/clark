-- 「就到这里」在本人推翻过的通过上（那次算没过、连着前一次没过成了受阻）：照样记成有缺口通过，不再算一次推翻。原因和时间记在这两列，老的为 NULL。
ALTER TABLE card_handbacks ADD COLUMN gap_closed_at TIMESTAMPTZ, ADD COLUMN gap_close_reason TEXT;
