-- Additive migration. Run against existing fe-journey DB before enabling /operations.
-- No existing tables or personal OS databases are modified. No automatic migration.
CREATE TABLE IF NOT EXISTS operations_content (
  id varchar(36) NOT NULL,
  title varchar(200) NOT NULL,
  platform varchar(40) NOT NULL,
  status varchar(24) NOT NULL,
  revision int unsigned NOT NULL,
  document json NOT NULL,
  updatedAt varchar(30) NOT NULL,
  PRIMARY KEY (id),
  KEY operations_status_updated (status, updatedAt),
  KEY operations_platform_updated (platform, updatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
