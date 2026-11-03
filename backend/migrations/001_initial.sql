CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(200) NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS emails (
  id CHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  recipient VARCHAR(254) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  scheduled_at DATETIME(3) NOT NULL,
  status ENUM('scheduled','processing','sent','failed') NOT NULL DEFAULT 'scheduled',
  attempts INT NOT NULL DEFAULT 0,
  sent_at DATETIME(3) NULL,
  preview_url VARCHAR(1000) NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX user_created (user_id, created_at),
  INDEX recovery (status, scheduled_at)
);
