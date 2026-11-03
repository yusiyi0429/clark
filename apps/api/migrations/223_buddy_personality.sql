-- 伙伴的性格：只改说话的样子，判断不随性格变。已有伙伴默认沉稳靠谱；取值清单只在契约里校验，加性格不用改表。
ALTER TABLE person_buddies ADD COLUMN personality TEXT NOT NULL DEFAULT 'steady';
