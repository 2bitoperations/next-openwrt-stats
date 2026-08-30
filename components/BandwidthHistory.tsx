'use client';
import { useState } from 'react';
import { Card, CardContent, CardHeader } from './ui/card';
import { BandwidthHistoryChart } from './BandwidthHistoryChart';
import { InterfaceBreakdownChart } from './InterfaceBreakdownChart';
import { ActivityIcon, RouterIcon } from 'lucide-react';
import { useActiveRouter } from '@/providers/activeRouterContext';
import { Button } from './ui/button';

type Tab = 'wan' | 'lan' | 'breakdown';
const TABS: { id: Tab; label: string }[] = [
	{ id: 'wan', label: 'WAN' },
	{ id: 'lan', label: 'Aggregate LAN' },
	{ id: 'breakdown', label: 'Per interface' }
];

function RouterBandwidthCard({ displayName }: { displayName: string }) {
	const [tab, setTab] = useState<Tab>('wan');

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

function WholeNetworkCard() {
	return (
		<Card className="w-full">
			<CardHeader>
				<h3 className="text-lg font-semibold">
					<ActivityIcon className="mb-1 mr-2 inline-block h-5 w-5" />
					Whole Network (all APs combined)
				</h3>
			</CardHeader>
			<CardContent>
				<BandwidthHistoryChart scope="interface" metricKey="br-lan" combined />
			</CardContent>
		</Card>
	);
}

export function BandwidthHistory() {
	const { allRouters } = useActiveRouter();

	if (!allRouters || allRouters.length === 0) {
		return null;
	}

	return (
		<div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-2">
			<WholeNetworkCard />
			{allRouters.map((router) => (
				<RouterBandwidthCard
					key={router.displayName}
					displayName={router.displayName}
				/>
			))}
		</div>
	);
}
