'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import {
	ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent
} from './ui/chart';
import {
	RANGE_OPTIONS,
	RangePicker,
	estimateBucketSeconds
} from './BandwidthHistoryChart';
import { formatBitrate, formatBytes } from '@/lib/utils';
import { MetricHistory } from '@/lib/server/metrics';
import { InterfaceDevices } from '@/lib/server/metrics';
import { LoaderCircle } from 'lucide-react';

const PALETTE = [
	'var(--chart-1)',
	'var(--chart-2)',
	'var(--chart-3)',
	'var(--chart-4)',
	'var(--chart-5)',
	'#e879f9',
	'#38bdf8',
	'#facc15'
];

function timeTickFormat(timestamp: number, rangeSeconds: number) {
	const date = new Date(timestamp * 1000);
	if (rangeSeconds > 24 * 60 * 60) {
		return date.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
	return date.toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: rangeSeconds <= 600 ? '2-digit' : undefined
	});
}

export function InterfaceBreakdownChart({
	displayName,
	className = 'aspect-auto h-[220px] w-full'
}: {
	displayName: string;
	className?: string;
}) {
	const [rangeSeconds, setRangeSeconds] = useState<number>(
		RANGE_OPTIONS[1].seconds
	);

	const devicesQuery = useQuery({
		queryKey: ['interfaceDevices', displayName],
		queryFn: async () => {
			const res = await fetch(
				`/api/metrics/devices?displayName=${encodeURIComponent(displayName)}`
			);
			const data = (await res.json()) as InterfaceDevices;
			if (!data.success) throw new Error(data.errorMessage);
			return data.data;
		},
		refetchOnWindowFocus: false,
		staleTime: 60_000
	});

	const devices = devicesQuery.data || [];

	const breakdownQuery = useQuery({
		queryKey: ['interfaceBreakdown', displayName, devices, rangeSeconds],
		queryFn: async () => {
			const now = Math.floor(Date.now() / 1000);
			const results = await Promise.all(
				devices.map(async (device) => {
					const params = new URLSearchParams({
						scope: 'interface',
						key: device,
						displayName,
						from: String(now - rangeSeconds),
						to: String(now)
					});
					const res = await fetch(`/api/metrics/history?${params.toString()}`);
					const data = (await res.json()) as MetricHistory;
					return { device, points: data.success ? data.data : [] };
				})
			);
			return results;
		},
		enabled: devices.length > 0,
		refetchInterval: rangeSeconds <= 3600 ? 5000 : 60_000
	});

	const chartConfig: ChartConfig = {};
	devices.forEach((device, i) => {
		chartConfig[device] = { label: device, color: PALETTE[i % PALETTE.length] };
	});

	const byTimestamp = new Map<number, Record<string, number>>();
	(breakdownQuery.data || []).forEach(({ device, points }) => {
		points.forEach((point) => {
			const throughput = point.rxAvg + point.txAvg;
			if (!byTimestamp.has(point.timestamp)) {
				byTimestamp.set(point.timestamp, {});
			}
			byTimestamp.get(point.timestamp)![device] = throughput;
		});
	});
	const chartData = Array.from(byTimestamp.entries())
		.sort(([a], [b]) => a - b)
		.map(([timestamp, values]) => ({
			time: timeTickFormat(timestamp, rangeSeconds),
			...values
		}));

	const isLoading = devicesQuery.isLoading || breakdownQuery.isLoading;
	const error = devicesQuery.error || breakdownQuery.error;

	const totalsByDevice = new Map<string, number>();
	(breakdownQuery.data || []).forEach(({ device, points }) => {
		const bucketSeconds = estimateBucketSeconds(points.map((p) => p.timestamp));
		const total =
			points.reduce((sum, p) => sum + p.rxAvg + p.txAvg, 0) * bucketSeconds;
		totalsByDevice.set(device, total);
	});

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-end">
				<RangePicker
					rangeSeconds={rangeSeconds}
					setRangeSeconds={setRangeSeconds}
				/>
			</div>
			{isLoading ? (
				<div className={`flex items-center justify-center ${className}`}>
					<LoaderCircle className="h-6 w-6 animate-spin" />
				</div>
			) : error ? (
				<div
					className={`text-muted-foreground flex items-center justify-center text-sm ${className}`}
				>
					{error.message}
				</div>
			) : devices.length === 0 || chartData.length === 0 ? (
				<div
					className={`text-muted-foreground flex items-center justify-center text-sm ${className}`}
				>
					No data yet
				</div>
			) : (
				<ChartContainer config={chartConfig} className={className}>
					<LineChart data={chartData}>
						<CartesianGrid vertical={false} />
						<XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={30} />
						<YAxis
							tickFormatter={(v) => formatBitrate(v)}
							width={70}
							tick={{ fontSize: 10 }}
						/>
						<ChartTooltip
							content={
								<ChartTooltipContent
									formatter={(value, name) => (
										<div className="flex w-full justify-between gap-4">
											<span className="text-muted-foreground">{name}</span>
											<span className="font-medium">
												{formatBitrate(Number(value))}
											</span>
										</div>
									)}
								/>
							}
						/>
						{devices.map((device, i) => (
							<Line
								key={device}
								type="monotone"
								dataKey={device}
								stroke={PALETTE[i % PALETTE.length]}
								strokeWidth={2}
								dot={false}
								isAnimationActive={false}
								connectNulls
							/>
						))}
					</LineChart>
				</ChartContainer>
			)}
			{devices.length > 0 && chartData.length > 0 && (
				<div className="text-muted-foreground flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
					{devices.map((device, i) => (
						<span key={device} className="flex items-center gap-1.5">
							<span
								className="inline-block h-2 w-2 rounded-full"
								style={{ background: PALETTE[i % PALETTE.length] }}
							/>
							{device}:{' '}
							<span className="text-foreground">
								{formatBytes(totalsByDevice.get(device) || 0)}
							</span>
						</span>
					))}
				</div>
			)}
		</div>
	);
}
