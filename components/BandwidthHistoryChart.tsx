'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import {
	ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent
} from './ui/chart';
import { formatBitrate, formatBytes } from '@/lib/utils';
import { MetricHistory } from '@/lib/server/metrics';
import { useTimeRange } from '@/providers/timeRangeContext';
import { LoaderCircle } from 'lucide-react';

export function estimateBucketSeconds(timestamps: number[]) {
	if (timestamps.length < 2) return 0;
	return (
		(timestamps[timestamps.length - 1] - timestamps[0]) / (timestamps.length - 1)
	);
}

export const RANGE_OPTIONS = [
	{ label: '5m', seconds: 5 * 60 },
	{ label: '1h', seconds: 60 * 60 },
	{ label: '1d', seconds: 24 * 60 * 60 },
	{ label: '1w', seconds: 7 * 24 * 60 * 60 },
	{ label: '1m', seconds: 30 * 24 * 60 * 60 },
	{ label: '1y', seconds: 365 * 24 * 60 * 60 }
] as const;

export const chartConfig = {
	rxAvg: { label: 'Download', color: 'var(--chart-1)' },
	txAvg: { label: 'Upload', color: 'var(--chart-2)' }
} satisfies ChartConfig;

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

export function RangePicker({
	rangeSeconds,
	setRangeSeconds
}: {
	rangeSeconds: number;
	setRangeSeconds: (seconds: number) => void;
}) {
	return (
		<div className="flex items-center gap-1">
			{RANGE_OPTIONS.map((opt) => (
				<button
					key={opt.label}
					onClick={() => setRangeSeconds(opt.seconds)}
					className={`rounded px-2 py-0.5 text-xs ${
						rangeSeconds === opt.seconds
							? 'bg-muted text-foreground'
							: 'text-muted-foreground hover:bg-muted/50'
					}`}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}

export function useMetricHistory({
	scope,
	metricKey,
	displayName,
	combined,
	rangeSeconds
}: {
	scope: 'interface' | 'client' | 'client_lan' | 'client_wan' | 'radio' | 'network';
	metricKey: string;
	displayName?: string;
	combined?: boolean;
	rangeSeconds: number;
}) {
	return useQuery({
		queryKey: [
			'metricHistory',
			scope,
			metricKey,
			displayName,
			combined,
			rangeSeconds
		],
		queryFn: async () => {
			const now = Math.floor(Date.now() / 1000);
			const params = new URLSearchParams({
				scope,
				key: metricKey,
				from: String(now - rangeSeconds),
				to: String(now)
			});
			if (displayName) params.set('displayName', displayName);
			if (combined) params.set('combined', 'true');
			const res = await fetch(`/api/metrics/history?${params.toString()}`);
			const data = (await res.json()) as MetricHistory;
			if (!data.success) {
				throw new Error(data.errorMessage);
			}
			return data.data;
		},
		refetchInterval: rangeSeconds <= 3600 ? 5000 : 60_000
	});
}

export function BandwidthHistoryChart({
	scope,
	metricKey,
	displayName,
	combined,
	className = 'aspect-auto h-[180px] w-full',
	rangeSeconds: controlledRange,
	emptyMessage = 'No data yet',
	towardDevices = false,
	seriesLabels,
	stacked = false
}: {
	scope: 'interface' | 'client' | 'client_lan' | 'client_wan' | 'network';
	metricKey: string;
	displayName?: string;
	combined?: boolean;
	className?: string;
	// When given, the range is controlled by the parent (which renders its own
	// RangePicker, e.g. to keep several charts on the same window) and this
	// chart shows no picker of its own.
	rangeSeconds?: number;
	emptyMessage?: string;
	// Interface counters are from the router's side. For a LAN-side interface
	// (br-lan) its rx is what the devices sent, so to keep Download = data
	// delivered to devices (as for clients and the WAN), swap rx/tx.
	towardDevices?: boolean;
	// Replace Download/Upload in tooltip + legend (e.g. Combined LAN: LAN-local /
	// Internet); the legend then also shows tx's share of the total.
	seriesLabels?: { rx: string; tx: string };
	// Draw rx and tx as stacked areas (top edge = total) instead of two lines -
	// for series whose two parts add up to something meaningful (Combined LAN).
	stacked?: boolean;
}) {
	const [ownRange, setRangeSeconds] = useState<number>(RANGE_OPTIONS[1].seconds);
	const timeRange = useTimeRange();
	const rangeSeconds = controlledRange ?? timeRange?.rangeSeconds ?? ownRange;
	const showOwnPicker = controlledRange === undefined && !timeRange;

	const query = useMetricHistory({
		scope,
		metricKey,
		displayName,
		combined,
		rangeSeconds
	});

	const chartData = (query.data || []).map((point) => ({
		timestamp: point.timestamp,
		time: timeTickFormat(point.timestamp, rangeSeconds),
		rxAvg: towardDevices ? point.txAvg : point.rxAvg,
		txAvg: towardDevices ? point.rxAvg : point.txAvg
	}));

	const bucketSeconds = estimateBucketSeconds(chartData.map((p) => p.timestamp));
	const totalRxBytes = chartData.reduce((sum, p) => sum + p.rxAvg, 0) * bucketSeconds;
	const totalTxBytes = chartData.reduce((sum, p) => sum + p.txAvg, 0) * bucketSeconds;

	return (
		<div className="space-y-2">
			{showOwnPicker && (
				<div className="flex items-center justify-end">
					<RangePicker
						rangeSeconds={rangeSeconds}
						setRangeSeconds={setRangeSeconds}
					/>
				</div>
			)}
			{query.isLoading ? (
				<div className={`flex items-center justify-center ${className}`}>
					<LoaderCircle className="h-6 w-6 animate-spin" />
				</div>
			) : query.error ? (
				<div
					className={`text-muted-foreground flex items-center justify-center text-sm ${className}`}
				>
					{query.error.message}
				</div>
			) : chartData.length === 0 ? (
				<div
					className={`text-muted-foreground flex items-center justify-center text-sm ${className}`}
				>
					{emptyMessage}
				</div>
			) : (
				<ChartContainer config={chartConfig} className={className}>
					<ComposedChart data={chartData}>
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
											<span className="text-muted-foreground">
												{name === 'rxAvg' ? (seriesLabels?.rx ?? 'Download') : (seriesLabels?.tx ?? 'Upload')}
											</span>
											<span className="font-medium">
												{formatBitrate(Number(value))}
											</span>
										</div>
									)}
								/>
							}
						/>
						{stacked ? (
							<>
								<Area
									type="monotone"
									dataKey="rxAvg"
									stackId="total"
									stroke="var(--chart-1)"
									fill="var(--chart-1)"
									fillOpacity={0.35}
									isAnimationActive={false}
								/>
								<Area
									type="monotone"
									dataKey="txAvg"
									stackId="total"
									stroke="var(--chart-2)"
									fill="var(--chart-2)"
									fillOpacity={0.35}
									isAnimationActive={false}
								/>
							</>
						) : (
							<>
								<Line
									type="monotone"
									dataKey="rxAvg"
									stroke="var(--chart-1)"
									strokeWidth={2}
									dot={false}
									isAnimationActive={false}
								/>
								<Line
									type="monotone"
									dataKey="txAvg"
									stroke="var(--chart-2)"
									strokeWidth={2}
									dot={false}
									isAnimationActive={false}
								/>
							</>
						)}
					</ComposedChart>
				</ChartContainer>
			)}
			{chartData.length > 0 && (
				<div className="text-muted-foreground flex justify-center gap-6 text-xs">
					<span className="flex items-center gap-1.5">
						<span
							className="inline-block h-2 w-2 rounded-full"
							style={{ background: 'var(--chart-1)' }}
						/>
						{seriesLabels ? `${seriesLabels.rx}:` : 'Total down:'}{' '}
						<span className="text-foreground">{formatBytes(totalRxBytes)}</span>
					</span>
					<span className="flex items-center gap-1.5">
						<span
							className="inline-block h-2 w-2 rounded-full"
							style={{ background: 'var(--chart-2)' }}
						/>
						{seriesLabels ? `${seriesLabels.tx}:` : 'Total up:'}{' '}
						<span className="text-foreground">{formatBytes(totalTxBytes)}</span>
					</span>
					{seriesLabels && totalRxBytes + totalTxBytes > 0 && (
						<span>
							{seriesLabels.tx} share:{' '}
							<span className="text-foreground">
								{((totalTxBytes / (totalRxBytes + totalTxBytes)) * 100).toFixed(0)}%
							</span>
						</span>
					)}
				</div>
			)}
		</div>
	);
}
