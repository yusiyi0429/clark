CREATE TABLE monthly_review_comments (
  id UUID PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES monthly_review_items (id),
  author_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (author_id, client_id)
);
CREATE INDEX monthly_review_comments_item ON monthly_review_comments (item_id, created_at);
