'use client';
import { useState } from 'react';
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger
} from '@/components/ui/dialog';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import {
	ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent
} from './ui/chart';
import { LoaderCircle } from 'lucide-react';
import {
	RANGE_OPTIONS,
	RangePicker,
	useMetricHistory,
	BandwidthHistoryChart
} from './BandwidthHistoryChart';
import { WifiRadio } from '@/lib/server/wifiAPs';

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
	return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const clientCountConfig = {
	clientCountAvg: { label: 'Clients (avg)', color: 'var(--chart-1)' },
	clientCountMax: { label: 'Clients (peak)', color: 'var(--chart-2)' }
} satisfies ChartConfig;

function ClientCountChart({
	displayName,
	ifname
}: {
	displayName: string;
	ifname: string;
}) {
	const [rangeSeconds, setRangeSeconds] = useState<number>(
		RANGE_OPTIONS[1].seconds
	);
	const query = useMetricHistory({
		scope: 'radio',
		metricKey: ifname,
		displayName,
		rangeSeconds
	});

	const chartData = (query.data || []).map((point) => ({
		time: timeTickFormat(point.timestamp, rangeSeconds),
		clientCountAvg: point.clientCountAvg,
		clientCountMax: point.clientCountMax
	}));

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<h4 className="text-muted-foreground text-sm font-medium">
					Client Count
				</h4>
				<RangePicker rangeSeconds={rangeSeconds} setRangeSeconds={setRangeSeconds} />
			</div>
			{query.isLoading ? (
				<div className="flex h-[200px] items-center justify-center">
					<LoaderCircle className="h-6 w-6 animate-spin" />
				</div>
			) : chartData.length === 0 ? (
				<div className="text-muted-foreground flex h-[200px] items-center justify-center text-sm">
					No data yet
				</div>
			) : (
				<ChartContainer
					config={clientCountConfig}
					className="aspect-auto h-[200px] w-full"
				>
					<LineChart data={chartData}>
						<CartesianGrid vertical={false} />
						<XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={30} />
						<YAxis allowDecimals={false} width={30} tick={{ fontSize: 10 }} />
						<ChartTooltip content={<ChartTooltipContent indicator="line" />} />
						<Line
							type="stepAfter"
							dataKey="clientCountAvg"
							stroke="var(--chart-1)"
							strokeWidth={2}
							dot={false}
							isAnimationActive={false}
						/>
						<Line
							type="stepAfter"
							dataKey="clientCountMax"
							stroke="var(--chart-2)"
							strokeWidth={2}
							strokeDasharray="4 3"
							dot={false}
							isAnimationActive={false}
						/>
					</LineChart>
				</ChartContainer>
			)}
		</div>
	);
}

const signalNoiseConfig = {
	signalAvg: { label: 'Signal (avg)', color: 'var(--chart-3)' },
	signalMin: { label: 'Signal (worst)', color: 'var(--chart-4)' },
	noiseAvg: { label: 'Noise (avg)', color: 'var(--chart-5)' }
} satisfies ChartConfig;

function SignalNoiseChart({
	displayName,
	ifname
}: {
	displayName: string;
	ifname: string;
}) {
	const [rangeSeconds, setRangeSeconds] = useState<number>(
		RANGE_OPTIONS[1].seconds
	);
	const query = useMetricHistory({
		scope: 'radio',
		metricKey: ifname,
		displayName,
		rangeSeconds
	});

	const chartData = (query.data || [])
		.filter((point) => point.signalAvg !== null && point.signalAvg !== undefined)
		.map((point) => ({
			time: timeTickFormat(point.timestamp, rangeSeconds),
			signalAvg: point.signalAvg,
			signalMin: point.signalMin,
			noiseAvg: point.noiseAvg
		}));

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<h4 className="text-muted-foreground text-sm font-medium">
					Signal / Noise
				</h4>
				<RangePicker rangeSeconds={rangeSeconds} setRangeSeconds={setRangeSeconds} />
			</div>
			{query.isLoading ? (
				<div className="flex h-[200px] items-center justify-center">
					<LoaderCircle className="h-6 w-6 animate-spin" />
				</div>
			) : chartData.length === 0 ? (
				<div className="text-muted-foreground flex h-[200px] items-center justify-center text-sm">
					No clients seen on this radio yet
				</div>
			) : (
				<ChartContainer
					config={signalNoiseConfig}
					className="aspect-auto h-[200px] w-full"
				>
					<LineChart data={chartData}>
						<CartesianGrid vertical={false} />
						<XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={30} />
						<YAxis unit=" dBm" width={50} tick={{ fontSize: 10 }} />
						<ChartTooltip content={<ChartTooltipContent indicator="line" />} />
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
						<Line
							type="monotone"
							dataKey="noiseAvg"
							stroke="var(--chart-5)"
							strokeWidth={2}
							dot={false}
							isAnimationActive={false}
						/>
					</LineChart>
				</ChartContainer>
			)}
		</div>
	);
}

export function RadioHistoryDialog({
	radio,
	children
}: {
	radio: WifiRadio;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [rangeSeconds, setRangeSeconds] = useState<number>(
		RANGE_OPTIONS[1].seconds
	);
	const isMesh = radio.mode === 'mesh';

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="w-full max-w-[95vw] sm:max-w-2xl md:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						{radio.displayName} — {radio.ssid || radio.meshId || radio.ifname}
					</DialogTitle>
				</DialogHeader>
				<div className="space-y-6">
					{isMesh ? (
						<div>
							<div className="flex items-center justify-between">
								<h4 className="text-muted-foreground text-sm font-medium">
									Bandwidth
								</h4>
								<RangePicker
									rangeSeconds={rangeSeconds}
									setRangeSeconds={setRangeSeconds}
								/>
							</div>
							<BandwidthHistoryChart
								scope="interface"
								metricKey={radio.ifname}
								displayName={radio.displayName}
								rangeSeconds={rangeSeconds}
								className="aspect-auto h-[220px] w-full"
							/>
						</div>
					) : (
						<>
							<ClientCountChart
								displayName={radio.displayName}
								ifname={radio.ifname}
							/>
							<SignalNoiseChart
								displayName={radio.displayName}
								ifname={radio.ifname}
							/>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
