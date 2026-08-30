CREATE TABLE `metric_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seriesId` integer NOT NULL,
	`tier` text NOT NULL,
	`timestamp` integer NOT NULL,
	`rxAvg` real NOT NULL,
	`rxMax` real NOT NULL,
	`txAvg` real NOT NULL,
	`txMax` real NOT NULL,
	`signalAvg` real,
	`signalMin` real,
	FOREIGN KEY (`seriesId`) REFERENCES `metric_series`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `metric_sample_lookup` ON `metric_sample` (`seriesId`,`tier`,`timestamp`);--> statement-breakpoint
CREATE TABLE `metric_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`routerId` integer,
	`key` text NOT NULL,
	FOREIGN KEY (`routerId`) REFERENCES `routers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_series_scope_routerId_key_unique` ON `metric_series` (`scope`,`routerId`,`key`);