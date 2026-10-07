import { relations } from 'drizzle-orm/relations';
import {
	index,
	int,
	real,
	sqliteTable,
	text,
	unique
} from 'drizzle-orm/sqlite-core';

export const routersTable = sqliteTable('routers', {
	id: int().primaryKey({ autoIncrement: true }),
	displayName: text().notNull().unique(),
	routerIP: text().notNull().unique(),
	username: text().notNull(),
	password: text().notNull(),
	session: text().notNull(),
	lastAccessed: int().notNull().default(0),
	isPrimary: int().notNull().default(0)
});

export const clientsTable = sqliteTable(
	'clients',
	{
		id: int().primaryKey({ autoIncrement: true }),
		clientName: text().notNull(),
		clientMacAddress: text().notNull()
	},
	(table) => [unique().on(table.clientMacAddress)]
);

export const wifisTable = sqliteTable(
	'wifis',
	{
		id: int().primaryKey({ autoIncrement: true }),
		displayName: text().notNull(),
		ssid: text().notNull(),
		band: text().notNull()
	},
	(table) => [unique().on(table.displayName, table.ssid, table.band)]
);

export const presencesEventTable = sqliteTable('presences_event', {
	id: int().primaryKey({ autoIncrement: true }),
	timestamp: int().notNull(),
	clientId: int()
		.notNull()
		.references(() => clientsTable.id),
	eventType: int().notNull().$type<1 | 2 | 3>(),
	fromWifiId: int().references(() => wifisTable.id),
	toWifiId: int().references(() => wifisTable.id)
});

export const eventTypeIdMap = {
	client_connected: 1,
	client_updated: 2,
	client_disconnected: 3
} as const;

export const presencesRelations = relations(presencesEventTable, ({ one }) => ({
	client: one(clientsTable, {
		fields: [presencesEventTable.clientId],
		references: [clientsTable.id]
	}),
	fromWifi: one(wifisTable, {
		fields: [presencesEventTable.fromWifiId],
		references: [wifisTable.id]
	}),
	toWifi: one(wifisTable, {
		fields: [presencesEventTable.toWifiId],
		references: [wifisTable.id]
	})
}));

export const prevClientsTable = sqliteTable('prev_clients', {
	id: int().primaryKey({ autoIncrement: true }),
	data: text().notNull()
});

export const metricScope = {
	interface: 'interface',
	client: 'client',
	// Per-client LAN / Internet breakdown of `client` (macacct >= 2 only).
	client_lan: 'client_lan',
	client_wan: 'client_wan',
	radio: 'radio',
	// Network-wide aggregates computed by the collector (routerId null), e.g.
	// key 'lan': rxAvg = LAN-local B/s, txAvg = internet B/s.
	network: 'network'
} as const;
export type MetricScope = (typeof metricScope)[keyof typeof metricScope];

export const metricTier = {
	raw: 'raw',
	'1m': '1m',
	'5m': '5m',
	'1h': '1h'
} as const;
export type MetricTier = (typeof metricTier)[keyof typeof metricTier];

export const metricSeriesTable = sqliteTable(
	'metric_series',
	{
		id: int().primaryKey({ autoIncrement: true }),
		scope: text().notNull().$type<MetricScope>(),
		// Null routerId is reserved for future router-independent series;
		// every series today (interface or client) belongs to a router.
		routerId: int().references(() => routersTable.id),
		key: text().notNull() // device name (e.g. "br-lan", "wan") or client MAC
	},
	(table) => [unique().on(table.scope, table.routerId, table.key)]
);

export const metricSeriesRelations = relations(metricSeriesTable, ({ one }) => ({
	router: one(routersTable, {
		fields: [metricSeriesTable.routerId],
		references: [routersTable.id]
	})
}));

export const metricSampleTable = sqliteTable(
	'metric_sample',
	{
		id: int().primaryKey({ autoIncrement: true }),
		seriesId: int()
			.notNull()
			.references(() => metricSeriesTable.id),
		tier: text().notNull().$type<MetricTier>(),
		timestamp: int().notNull(), // bucket start, epoch seconds
		rxAvg: real().notNull(), // bytes/sec
		rxMax: real().notNull(),
		txAvg: real().notNull(),
		txMax: real().notNull(),
		signalAvg: real(), // client/radio scope, dBm (radio: avg across clients)
		signalMin: real(), // client/radio scope, dBm (worst case)
		clientCountAvg: real(), // radio scope only
		clientCountMax: real(), // radio scope only
		noiseAvg: real() // radio scope only, dBm
	},
	(table) => [
		index('metric_sample_lookup').on(
			table.seriesId,
			table.tier,
			table.timestamp
		)
	]
);

export const metricSampleRelations = relations(metricSampleTable, ({ one }) => ({
	series: one(metricSeriesTable, {
		fields: [metricSampleTable.seriesId],
		references: [metricSeriesTable.id]
	})
}));

// Periodically-refreshed JSON snapshot caches, populated by the collector
// so API routes never need a live ubus round-trip on the request path.
export const routerSnapshotTable = sqliteTable('router_snapshot', {
	routerId: int()
		.primaryKey()
		.references(() => routersTable.id),
	data: text().notNull(), // JSON: routerInfoSchema shape
	updatedAt: int().notNull()
});

export const wifiRadioSnapshotTable = sqliteTable('wifi_radio_snapshot', {
	routerId: int()
		.primaryKey()
		.references(() => routersTable.id),
	data: text().notNull(), // JSON: array of per-radio config for this router
	updatedAt: int().notNull()
});

export const dhcpLeaseSnapshotTable = sqliteTable('dhcp_lease_snapshot', {
	id: int().primaryKey({ autoIncrement: true }),
	data: text().notNull(), // JSON: deduped array of all leases, all routers
	updatedAt: int().notNull()
});

// Current WAN-failover state per router (only meaningful for a router
// running the wan-failover.sh watchdog - see this project's NOTES.md). One
// row per router, upserted every poll.
export const wanFailoverStateTable = sqliteTable('wan_failover_state', {
	routerId: int()
		.primaryKey()
		.references(() => routersTable.id),
	activeInterface: text().notNull().$type<'primary' | 'backup'>(),
	since: int().notNull(), // epoch seconds - when this interface became active
	updatedAt: int().notNull()
});

// History of WAN-failover state transitions per router - one row per
// change, not a dense time series. Mirrors presencesEventTable's role for
// client roaming history.
export const wanFailoverEventTable = sqliteTable('wan_failover_event', {
	id: int().primaryKey({ autoIncrement: true }),
	routerId: int()
		.notNull()
		.references(() => routersTable.id),
	timestamp: int().notNull(), // epoch seconds
	activeInterface: text().notNull().$type<'primary' | 'backup'>()
});
