'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Line, LineChart, ReferenceArea, XAxis, YAxis } from 'recharts';
import {
	ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent
} from './ui/chart';
import { LoaderCircle } from 'lucide-react';
import { RANGE_OPTIONS, RangePicker, useMetricHistory } from './BandwidthHistoryChart';
import { formatBand } from '@/lib/utils';
import { PresenceSegments } from '@/app/api/presence/[mac]/segments/route';

const chartConfig = {
	signalAvg: { label: 'Signal (avg)', color: 'var(--chart-3)' },
	signalMin: { label: 'Signal (worst)', color: 'var(--chart-4)' }
} satisfies ChartConfig;

const SEGMENT_PALETTE = [
	'#f97316',
	'#22d3ee',
	'#a3e635',
	'#e879f9',
	'#facc15',
	'#60a5fa',
	'#fb7185',
	'#34d399'
];

// Shared between the chart shading and the legend swatches so the legend
// shows exactly what the chart shows, instead of a fully-solid color next
// to a diffuse tinted region.
const SEGMENT_FILL_OPACITY = 0.22;

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

export function SignalHistoryChart({
	clientMac,
	presenceEnabled = false,
	className = 'aspect-auto h-[180px] w-full'
}: {
	clientMac: string;
	presenceEnabled?: boolean;
	className?: string;
}) {
	const [rangeSeconds, setRangeSeconds] = useState<number>(
		RANGE_OPTIONS[1].seconds
	);

	const query = useMetricHistory({
		scope: 'client',
		metricKey: clientMac,
		rangeSeconds
	});

	const now = Math.floor(Date.now() / 1000);
	const from = now - rangeSeconds;

	const segmentsQuery = useQuery({
		queryKey: ['presenceSegments', clientMac, rangeSeconds],
		queryFn: async () => {
			const params = new URLSearchParams({
				from: String(from),
				to: String(now)
			});
			const res = await fetch(
				`/api/presence/${encodeURIComponent(clientMac)}/segments?${params.toString()}`
			);
			const data = (await res.json()) as PresenceSegments;
			if (!data.success) throw new Error(data.errorMessage);
			return data.data;
		},
		enabled: presenceEnabled,
		refetchInterval: rangeSeconds <= 3600 ? 15000 : 60_000
	});

	const chartData = (query.data || [])
		.filter((point) => point.signalAvg !== null && point.signalAvg !== undefined)
		.map((point) => ({
			timestamp: point.timestamp,
			signalAvg: point.signalAvg,
			signalMin: point.signalMin
		}));

	function getSegmentAt(timestamp: number) {
		return (segmentsQuery.data || []).find(
			(segment) =>
				timestamp >= segment.startTimestamp && timestamp <= segment.endTimestamp
		);
	}

	const segmentColors = useMemo(() => {
		const colors = new Map<string, string>();
		(segmentsQuery.data || []).forEach((segment) => {
			const key = `${segment.router}::${segment.band}`;
			if (!colors.has(key)) {
				colors.set(key, SEGMENT_PALETTE[colors.size % SEGMENT_PALETTE.length]);
			}
		});
		return colors;
	}, [segmentsQuery.data]);

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-end">
				<RangePicker
					rangeSeconds={rangeSeconds}
					setRangeSeconds={setRangeSeconds}
				/>
			</div>
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
					No data yet
				</div>
			) : (
				<ChartContainer config={chartConfig} className={className}>
					<LineChart data={chartData}>
						<CartesianGrid vertical={false} />
						{(segmentsQuery.data || []).map((segment, i) => (
							<ReferenceArea
								key={i}
								x1={segment.startTimestamp}
								x2={segment.endTimestamp}
								fill={segmentColors.get(`${segment.router}::${segment.band}`)}
								fillOpacity={SEGMENT_FILL_OPACITY}
								stroke="none"
								ifOverflow="visible"
							/>
						))}
						<XAxis
							dataKey="timestamp"
							type="number"
							domain={['dataMin', 'dataMax']}
							tickFormatter={(ts) => timeTickFormat(Number(ts), rangeSeconds)}
							tick={{ fontSize: 10 }}
							minTickGap={30}
						/>
						<YAxis unit=" dBm" width={60} tick={{ fontSize: 10 }} />
						<ChartTooltip
							content={
								<ChartTooltipContent
									indicator="line"
									labelFormatter={(_, payload) => {
										if (!payload?.[0]) return '';
										const timestamp = Number(payload[0].payload.timestamp);
										const segment = getSegmentAt(timestamp);
										return (
											<div className="flex flex-col gap-0.5">
												<span>{timeTickFormat(timestamp, rangeSeconds)}</span>
												{segment && (
													<span className="text-muted-foreground text-xs font-normal">
														{segment.router} ({formatBand(segment.band)})
													</span>
												)}
											</div>
										);
									}}
									formatter={(value, name) => (
										<div className="flex w-full justify-between gap-4">
											<span className="text-muted-foreground">
												{name === 'signalAvg' ? 'Avg signal' : 'Worst signal'}
											</span>
											<span className="font-medium">{Number(value)} dBm</span>
										</div>
									)}
								/>
							}
						/>
						<Line
							type="monotone"
							dataKey="signalAvg"
							stroke="var(--chart-3)"
							strokeWidth={2}
							dot={false}
							isAnimationActive={false}
						/>
						<Line
							type="monotone"
							dataKey="signalMin"
							stroke="var(--chart-4)"
							strokeWidth={2}
							strokeDasharray="4 3"
							dot={false}
							isAnimationActive={false}
						/>
					</LineChart>
				</ChartContainer>
			)}
			{presenceEnabled && segmentColors.size > 0 && (
				<div className="text-muted-foreground flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
					{Array.from(segmentColors.entries()).map(([key, color]) => {
						const [router, band] = key.split('::');
						return (
							<span key={key} className="flex items-center gap-1.5">
								<span className="relative inline-block h-2.5 w-2.5 overflow-hidden rounded-sm bg-black">
									<span
										className="absolute inset-0"
										style={{ backgroundColor: color, opacity: SEGMENT_FILL_OPACITY }}
									/>
								</span>
								{router} ({formatBand(band)})
							</span>
						);
					})}
				</div>
			)}
		</div>
	);
}
