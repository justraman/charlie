CREATE TABLE `ai_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`provider_id` text,
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
	FOREIGN KEY (`provider_id`) REFERENCES `ai_providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_analyses_status_check" CHECK("ai_analyses"."status" in ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_ai_analyses_project` ON `ai_analyses` (`project_id`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `ai_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`api_key_ciphertext` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ai_providers_name_check" CHECK("ai_providers"."name" in ('anthropic', 'openai', 'workers_ai'))
);
--> statement-breakpoint
CREATE INDEX `idx_ai_providers_org` ON `ai_providers` (`org_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`project_scope` text,
	`expires_at` text,
	`created_by` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_api_keys_org` ON `api_keys` (`org_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text,
	`actor_kind` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`before` text,
	`after` text,
	`ip` text,
	`user_agent` text,
	`created_at` text NOT NULL,
	CONSTRAINT "audit_log_actor_kind_check" CHECK("audit_log"."actor_kind" in ('user', 'api_key', 'system'))
);
--> statement-breakpoint
CREATE INDEX `idx_audit_org_created` ON `audit_log` (`org_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_actor` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`secrets_ciphertext` text,
	`auth_config` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_environments_name` ON `environments` (`project_id`,`name`) WHERE "environments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `idx_environments_project` ON `environments` (`project_id`);--> statement-breakpoint
CREATE TABLE `flow_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`analysis_id` text,
	`name` text NOT NULL,
	`description` text,
	`engines` text DEFAULT '["playwright"]' NOT NULL,
	`steps` text NOT NULL,
	`load_profile` text,
	`reasoning` text,
	`source_refs` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`origin` text DEFAULT 'ai' NOT NULL,
	`approved_flow_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`analysis_id`) REFERENCES `ai_analyses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "flow_drafts_status_check" CHECK("flow_drafts"."status" in ('draft', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_flow_drafts_project` ON `flow_drafts` (`project_id`,`status`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `flow_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`version` integer NOT NULL,
	`steps` text NOT NULL,
	`load_profile` text,
	`author_id` text NOT NULL,
	`diff_summary` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_flow_versions_version` ON `flow_versions` (`flow_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_flow_versions_flow` ON `flow_versions` (`flow_id`,"version" desc);--> statement-breakpoint
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`current_version_id` text,
	`engines` text DEFAULT '[]' NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "flows_origin_check" CHECK("flows"."origin" in ('manual', 'recorder', 'ai'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_flows_name` ON `flows` (`project_id`,`name`) WHERE "flows"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `idx_flows_project` ON `flows` (`project_id`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text,
	`config_ciphertext` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "integrations_kind_check" CHECK("integrations"."kind" in ('slack', 'github'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integrations_org_kind` ON `integrations` (`org_id`,`kind`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`allowed_email_domains` text DEFAULT '[]' NOT NULL,
	`default_ai_provider_id` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`source_repo` text,
	`default_environment_id` text,
	`slack_channel` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_slug` ON `projects` (`org_id`,`slug`) WHERE "projects"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `idx_projects_org` ON `projects` (`org_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`totals` text,
	`load_summary` text,
	`e2e_summary` text,
	`html_report_key` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_run_id_unique` ON `reports` (`run_id`);--> statement-breakpoint
CREATE TABLE `run_shards` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`shard_index` integer NOT NULL,
	`status` text NOT NULL,
	`runner` text,
	`public_ip` text,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_shards_status_check" CHECK("run_shards"."status" in ('pending', 'running', 'passed', 'failed', 'errored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_shards_run_index` ON `run_shards` (`run_id`,`shard_index`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`flow_selection` text DEFAULT '[]' NOT NULL,
	`engine` text NOT NULL,
	`profile` text DEFAULT 'smoke' NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`triggered_by` text,
	`expected_shards` integer DEFAULT 1 NOT NULL,
	`gha_run_id` text,
	`commit_sha` text,
	`error` text,
	`summary` text,
	`schedule_id` text,
	`slack_channel` text,
	`queued_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`triggered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_engine_check" CHECK("runs"."engine" in ('playwright', 'k6')),
	CONSTRAINT "runs_status_check" CHECK("runs"."status" in ('queued', 'running', 'passed', 'failed', 'cancelled')),
	CONSTRAINT "runs_trigger_check" CHECK("runs"."trigger" in ('manual', 'slack', 'cron', 'merge', 'ci'))
);
--> statement-breakpoint
CREATE INDEX `idx_runs_project_status` ON `runs` (`project_id`,`status`,"queued_at" desc);--> statement-breakpoint
CREATE INDEX `idx_runs_org_queued` ON `runs` (`org_id`,"queued_at" desc);--> statement-breakpoint
CREATE INDEX `idx_runs_status` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_runs_schedule` ON `runs` (`schedule_id`,"queued_at" desc);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`flow_selection` text DEFAULT '["all"]' NOT NULL,
	`engine` text NOT NULL,
	`profile` text DEFAULT 'smoke' NOT NULL,
	`trigger_type` text NOT NULL,
	`cron_expr` text,
	`watch_branch` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`last_fired_at` text,
	`next_due_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "schedules_engine_check" CHECK("schedules"."engine" in ('playwright', 'k6')),
	CONSTRAINT "schedules_trigger_type_check" CHECK("schedules"."trigger_type" in ('cron', 'on_merge'))
);
--> statement-breakpoint
CREATE INDEX `idx_schedules_due` ON `schedules` (`enabled`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `idx_schedules_project` ON `schedules` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_schedules_merge` ON `schedules` (`trigger_type`,`enabled`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`user_agent` text,
	`ip` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `shard_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`shard_id` text NOT NULL,
	`flow_results` text,
	`metrics` text,
	`runtime_issues` text,
	`events` text,
	`artifact_keys` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shard_id`) REFERENCES `run_shards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_shard_results_run` ON `shard_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`avatar_url` text,
	`role` text NOT NULL,
	`google_sub` text NOT NULL,
	`last_login_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "users_role_check" CHECK("users"."role" in ('owner', 'admin', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_google_sub` ON `users` (`google_sub`);--> statement-breakpoint
CREATE INDEX `idx_users_org` ON `users` (`org_id`);