'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { LoaderCircle } from 'lucide-react';
import { ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from './ui/chart';
import { RANGE_OPTIONS, RangePicker, estimateBucketSeconds } from './BandwidthHistoryChart';
import { formatBitrate, formatBytes } from '@/lib/utils';
import { useTimeRange } from '@/providers/timeRangeContext';
import type { MeshHistory } from '@/lib/server/metrics';

// Combined Mesh: one stacked area per router = what that router's mesh radios
// transmit (bytes/s). The stack height is the total airtime load on the mesh.
export function MeshHistoryChart({ rangeSeconds: controlledRange }: { rangeSeconds?: number }) {
	const [ownRange, setRangeSeconds] = useState<number>(RANGE_OPTIONS[1].seconds);
	const timeRange = useTimeRange();
	const rangeSeconds = controlledRange ?? timeRange?.rangeSeconds ?? ownRange;
	const showOwnPicker = controlledRange === undefined && !timeRange;

	const query = useQuery({
		queryKey: ['meshHistory', rangeSeconds],
		queryFn: async () => {
			const now = Math.floor(Date.now() / 1000);
			const res = await fetch(`/api/metrics/mesh-history?from=${now - rangeSeconds}&to=${now}`);
			const data = (await res.json()) as MeshHistory;
			if (!data.success) throw new Error(data.errorMessage);
			return data.data;
		},
		refetchInterval: rangeSeconds <= 3600 ? 5000 : 60_000
	});

	// Routers with mesh radios but no samples in range (e.g. offline) are left out.
	const routers = (query.data?.routers ?? []).filter((r) => r.points.length > 0);
	const names = routers.map((r) => r.displayName);
	const config: ChartConfig = Object.fromEntries(
		names.map((n, i) => [n, { label: n, color: `var(--chart-${(i % 5) + 1})` }])
	);
	const byTs = new Map<number, Record<string, number>>();
	for (const r of routers) {
		for (const p of r.points) {
			const row = byTs.get(p.timestamp) ?? {};
			row[r.displayName] = p.txAvg;
			byTs.set(p.timestamp, row);
		}
	}
	const chartData = [...byTs.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([timestamp, row]) => ({
			timestamp,
			...Object.fromEntries(names.map((n) => [n, row[n] ?? 0]))
		}));
	const bucketSeconds = estimateBucketSeconds(chartData.map((p) => p.timestamp));
	const totals = names.map((n) => ({
		name: n,
		bytes: chartData.reduce((sum, p) => sum + ((p as Record<string, number>)[n] ?? 0), 0) * bucketSeconds
	}));
	const timeLabel = (ts: number) =>
		new Date(ts * 1000).toLocaleString(undefined,
			rangeSeconds > 24 * 60 * 60
				? { month: 'short', day: 'numeric', hour: '2-digit' }
				: { hour: '2-digit', minute: '2-digit' });

	return (
		<div className="space-y-2">
			{showOwnPicker && (
				<div className="flex items-center justify-end">
					<RangePicker rangeSeconds={rangeSeconds} setRangeSeconds={setRangeSeconds} />
				</div>
			)}
			<p className="text-muted-foreground text-xs">Sum of what every mesh radio transmits</p>
			{query.isLoading ? (
				<div className="flex h-[180px] items-center justify-center">
					<LoaderCircle className="h-6 w-6 animate-spin" />
				</div>
			) : query.error ? (
				<div className="text-muted-foreground flex h-[180px] items-center justify-center text-sm">
					{query.error.message}
				</div>
			) : chartData.length === 0 ? (
				<div className="text-muted-foreground flex h-[180px] items-center justify-center text-sm">
					No mesh data yet
				</div>
			) : (
				<ChartContainer config={config} className="aspect-auto h-[180px] w-full">
					<AreaChart data={chartData}>
						<CartesianGrid vertical={false} />
						<XAxis dataKey="timestamp" tickFormatter={(ts) => timeLabel(Number(ts))} tick={{ fontSize: 10 }} minTickGap={30} />
						<YAxis tickFormatter={(v) => formatBitrate(v)} width={70} tick={{ fontSize: 10 }} />
						<ChartTooltip
							content={
								<ChartTooltipContent
									labelFormatter={(_, payload) => timeLabel(Number(payload?.[0]?.payload?.timestamp))}
									formatter={(value, name) => (
										<div className="flex w-full justify-between gap-4">
											<span className="text-muted-foreground">{String(name)}</span>
											<span className="font-medium">{formatBitrate(Number(value))}</span>
										</div>
									)}
								/>
							}
						/>
						{names.map((n, i) => (
							<Area
								key={n}
								dataKey={n}
								stackId="mesh"
								type="monotone"
								stroke={`var(--chart-${(i % 5) + 1})`}
								fill={`var(--chart-${(i % 5) + 1})`}
								fillOpacity={0.35}
								isAnimationActive={false}
							/>
						))}
					</AreaChart>
				</ChartContainer>
			)}
			{chartData.length > 0 && (
				<div className="text-muted-foreground flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
					{totals.map((t, i) => (
						<span key={t.name} className="flex items-center gap-1.5">
							<span className="inline-block h-2 w-2 rounded-full" style={{ background: `var(--chart-${(i % 5) + 1})` }} />
							{t.name}: <span className="text-foreground">{formatBytes(t.bytes)}</span>
						</span>
					))}
					<span>
						Total: <span className="text-foreground">{formatBytes(totals.reduce((s, t) => s + t.bytes, 0))}</span>
					</span>
				</div>
			)}
		</div>
	);
}
