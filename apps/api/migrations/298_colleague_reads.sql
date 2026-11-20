-- 读取记录（补充条款 A3）：谁的伙伴（reader_id）读了谁的（owner_id）哪一份（item_id，同 colleagueScope.ts 的 itemId）、什么时候。
-- 同一读者、同一主人、同一份、同一天（公司时区）只留一行，再读只更新时间；只在读全文成功时记，不存正文。
CREATE TABLE colleague_reads (
  reader_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  read_on DATE NOT NULL,
  read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (reader_id, owner_id, item_id, read_on)
);
