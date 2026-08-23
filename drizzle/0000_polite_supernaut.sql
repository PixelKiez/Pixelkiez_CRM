CREATE TABLE `activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` text NOT NULL,
	`type` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'Neu' NOT NULL,
	`priority` text DEFAULT 'Mittel' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`street` text,
	`zip` text,
	`city` text,
	`phone` text,
	`email` text,
	`website` text,
	`website_status` text DEFAULT 'Prüfen' NOT NULL,
	`website_class` text,
	`age_score` integer DEFAULT 0 NOT NULL,
	`problems` text,
	`pitch` text,
	`source` text,
	`last_contact` text,
	`next_action` text,
	`follow_up` text,
	`notes` text,
	`updated_at` text NOT NULL
);
