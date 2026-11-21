-- 项目「不给同事读」（补充条款 A2）：收起的项目，它的会话、报告、产出、交回结论都不进同事可读范围（colleagueScope.ts）。默认可读。
ALTER TABLE projects ADD COLUMN hidden_from_colleagues BOOLEAN NOT NULL DEFAULT false;
