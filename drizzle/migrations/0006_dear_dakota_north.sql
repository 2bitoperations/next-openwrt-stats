CREATE TABLE `dhcp_lease_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`data` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `router_snapshot` (
	`routerId` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`routerId`) REFERENCES `routers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `wifi_radio_snapshot` (
	`routerId` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`routerId`) REFERENCES `routers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `metric_sample` ADD `clientCountAvg` real;--> statement-breakpoint
ALTER TABLE `metric_sample` ADD `clientCountMax` real;--> statement-breakpoint
ALTER TABLE `metric_sample` ADD `noiseAvg` real;