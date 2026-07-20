DROP TABLE `ai_providers`;--> statement-breakpoint
DROP TABLE `integrations`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`provider_name` text,
	`ref` text,
	`status` text NOT NULL,
	`error` text,
	`draft_count` integer DEFAULT 0 NOT NULL,
	`gha_run_id` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_analyses_status_check" CHECK("__new_ai_analyses"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_ai_analyses`("id", "org_id", "project_id", "provider_name", "ref", "status", "error", "draft_count", "gha_run_id", "created_by", "created_at", "finished_at") SELECT "id", "org_id", "project_id", NULL, "ref", "status", "error", "draft_count", "gha_run_id", "created_by", "created_at", "finished_at" FROM `ai_analyses`;--> statement-breakpoint
DROP TABLE `ai_analyses`;--> statement-breakpoint
ALTER TABLE `__new_ai_analyses` RENAME TO `ai_analyses`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_ai_analyses_project` ON `ai_analyses` (`project_id`,"created_at" desc);--> statement-breakpoint
ALTER TABLE `organization` DROP COLUMN `default_ai_provider_id`;