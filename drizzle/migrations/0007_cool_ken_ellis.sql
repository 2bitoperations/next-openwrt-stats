CREATE TABLE `wan_failover_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`routerId` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`activeInterface` text NOT NULL,
	FOREIGN KEY (`routerId`) REFERENCES `routers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `wan_failover_state` (
	`routerId` integer PRIMARY KEY NOT NULL,
	`activeInterface` text NOT NULL,
	`since` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`routerId`) REFERENCES `routers`(`id`) ON UPDATE no action ON DELETE no action
);
