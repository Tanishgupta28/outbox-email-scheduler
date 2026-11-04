ALTER TABLE emails MODIFY COLUMN status ENUM('scheduled','processing','sent','failed','cancelled') NOT NULL DEFAULT 'scheduled';
