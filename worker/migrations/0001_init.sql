-- 黏土捏地形：班級測驗資料表。時間一律存 Unix 毫秒（INTEGER）。
-- 學號（SSO uid）是所有資料的主鍵，永遠不用姓名當鍵。

-- 登入過的人（每次驗證 token 後 upsert）
CREATE TABLE players (
  uid TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  no INTEGER,
  role TEXT NOT NULL DEFAULT 'student',
  updated_at INTEGER NOT NULL
);

-- 班級名單（老師匯入）；目前只有一個班級 main
CREATE TABLE roster (
  class_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  no INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (class_id, uid)
);

-- 測驗：status = draft | published | closed | settled
CREATE TABLE quizzes (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('solo', 'team')),
  team_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  closed_at INTEGER,
  settled_at INTEGER
);

-- 概念題題庫（答案只存在這裡，不會傳給學生）
CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  stem TEXT NOT NULL,
  options_json TEXT NOT NULL,
  answer INTEGER NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

-- 每一次作答：status = active | finished
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  stars INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX attempts_quiz_uid ON attempts (quiz_id, uid);

-- 每次作答的 5 題：kind = terrain | mc
-- target：地形名稱或題號；option_order：這次打亂後的選項順序（JSON 陣列）
CREATE TABLE attempt_items (
  attempt_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  option_order TEXT,
  served_at INTEGER,
  deadline INTEGER,
  checks_used INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER,
  answer TEXT,
  correct INTEGER,
  score INTEGER,
  terrain TEXT,
  PRIMARY KEY (attempt_id, idx)
);

-- 分組賽的分組（老師拖曳時即時寫入）
CREATE TABLE team_members (
  quiz_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  team_no INTEGER NOT NULL,
  PRIMARY KEY (quiz_id, uid)
);

-- 結算結果（凍結，可重播）
CREATE TABLE settlements (
  quiz_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  settled_at INTEGER NOT NULL
);
