'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from './ui/card';
import { BandwidthHistoryChart } from './BandwidthHistoryChart';
import { InterfaceBreakdownChart } from './InterfaceBreakdownChart';
import { ActivityIcon, RouterIcon } from 'lucide-react';
import { useActiveRouter } from '@/providers/activeRouterContext';
import { Button } from './ui/button';
import { AvailableKeys } from '@/lib/server/metrics';

type Tab = 'wan' | 'lan' | 'breakdown';
const TABS: { id: Tab; label: string }[] = [
	{ id: 'wan', label: 'WAN' },
	{ id: 'lan', label: 'Aggregate LAN' },
	{ id: 'breakdown', label: 'Per interface' }
];

function RouterBandwidthCard({
	displayName,
	isPrimary
}: {
	displayName: string;
	isPrimary: boolean;
}) {
	const [tab, setTab] = useState<Tab>(isPrimary ? 'wan' : 'lan');

	return (
		<Card className="w-full">
			<CardHeader>
				<div className="flex h-4 w-full items-center justify-between">
					<h3 className="text-lg font-semibold">
						<RouterIcon className="mb-1 mr-2 inline-block h-5 w-5" />
						{displayName}
					</h3>
				</div>
				<div className="flex items-center gap-1 pt-2">
					{TABS.map((t) => (
						<Button
							key={t.id}
							size="sm"
							variant={tab === t.id ? 'default' : 'outline'}
							onClick={() => setTab(t.id)}
						>
							{t.label}
						</Button>
					))}
				</div>
			</CardHeader>
			<CardContent>
				{tab === 'wan' && (
					<BandwidthHistoryChart
						scope="interface"
						metricKey="wan"
						displayName={displayName}
					/>
				)}
				{tab === 'lan' && (
					<BandwidthHistoryChart
						scope="interface"
						metricKey="br-lan"
						displayName={displayName}
					/>
				)}
				{tab === 'breakdown' && (
					<InterfaceBreakdownChart displayName={displayName} />
				)}
			</CardContent>
		</Card>
	);
}

function WholeNetworkCard({
	title,
	metricKey
}: {
	title: string;
	metricKey: string;
}) {
	return (
		<Card className="w-full">
			<CardHeader>
				<h3 className="text-lg font-semibold">
					<ActivityIcon className="mb-1 mr-2 inline-block h-5 w-5" />
					{title}
				</h3>
			</CardHeader>
			<CardContent>
				<BandwidthHistoryChart scope="interface" metricKey={metricKey} combined />
			</CardContent>
		</Card>
	);
}

function useAvailableKeys() {
	return useQuery({
		queryKey: ['availableCombinedKeys'],
		queryFn: async () => {
			const res = await fetch('/api/metrics/available-keys');
			const data = (await res.json()) as AvailableKeys;
			if (!data.success) throw new Error(data.errorMessage);
			return data.data;
		},
		refetchInterval: 60_000
	});
}

export function BandwidthHistory() {
	const { allRouters } = useActiveRouter();
	const availableKeys = useAvailableKeys();

	if (!allRouters || allRouters.length === 0) {
		return null;
	}

	return (
		<div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-2">
			{availableKeys.data?.wan && (
				<WholeNetworkCard title="Combined WAN" metricKey="wan" />
			)}
			{availableKeys.data?.['br-lan'] && (
				<WholeNetworkCard title="Combined LAN" metricKey="br-lan" />
			)}
			{availableKeys.data?.bat0 && (
				<WholeNetworkCard title="Combined Mesh" metricKey="bat0" />
			)}
			{allRouters.map((router) => (
				<RouterBandwidthCard
					key={router.displayName}
					displayName={router.displayName}
					isPrimary={router.isPrimary === 1}
				/>
			))}
		</div>
	);
}
