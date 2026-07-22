ALTER TABLE `flow_versions` ADD `code_spec` text;--> statement-breakpoint
ALTER TABLE `flows` ADD `kind` text DEFAULT 'steps' NOT NULL;