CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expires_at` integer,
	`token_type` text,
	`scope` text,
	`id_token` text,
	`session_state` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_accounts_provider` ON `accounts` (`provider`,`provider_account_id`);--> statement-breakpoint
CREATE INDEX `idx_accounts_user` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `verification_token` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`identifier`, `token`)
);
--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
DROP INDEX `idx_users_google_sub`;--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified` integer;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `google_sub`;