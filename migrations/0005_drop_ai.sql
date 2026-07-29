DROP TABLE `flow_drafts`;--> statement-breakpoint
DROP TABLE `ai_analyses`;--> statement-breakpoint
-- Flows approved from an AI draft were authored (and owned) by the human who
-- approved them, so they land as 'manual'. This must run BEFORE the rebuild
-- below, whose CHECK no longer admits 'ai'.
UPDATE `flows` SET `origin` = 'manual' WHERE `origin` = 'ai';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`current_version_id` text,
	`kind` text DEFAULT 'steps' NOT NULL,
	`engines` text DEFAULT '[]' NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "flows_origin_check" CHECK("__new_flows"."origin" in ('manual', 'recorder', 'import'))
);
--> statement-breakpoint
INSERT INTO `__new_flows`("id", "project_id", "name", "description", "current_version_id", "kind", "engines", "origin", "created_by", "created_at", "updated_at", "deleted_at") SELECT "id", "project_id", "name", "description", "current_version_id", "kind", "engines", "origin", "created_by", "created_at", "updated_at", "deleted_at" FROM `flows`;--> statement-breakpoint
DROP TABLE `flows`;--> statement-breakpoint
ALTER TABLE `__new_flows` RENAME TO `flows`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_flows_name` ON `flows` (`project_id`,`name`) WHERE "flows"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `idx_flows_project` ON `flows` (`project_id`);