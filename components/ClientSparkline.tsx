'use client';

import { Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartContainer } from './ui/chart';
import { chartConfig } from './BandwidthHistoryChart';

export function ClientSparkline({
	points
}: {
	points?: { timestamp: number; rxAvg: number; txAvg: number }[];
}) {
	const data = (points || []).map((point) => ({
		timestamp: point.timestamp,
		rxAvg: point.rxAvg * 8,
		txAvg: point.txAvg * 8
	}));

	if (data.length === 0) {
		return (
			<div className="text-muted-foreground flex h-12 items-center justify-center text-xs">
				no recent traffic
			</div>
		);
	}

	return (
		<ChartContainer config={chartConfig} className="h-12 w-full">
			<LineChart
				data={data}
				margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
			>
				<XAxis dataKey="timestamp" type="number" hide />
				<YAxis type="number" hide domain={[0, 'auto']} width={0} />
				<Line
					type="monotone"
					dataKey="rxAvg"
					stroke={chartConfig.rxAvg.color}
					strokeWidth={2}
					dot={false}
					isAnimationActive={false}
				/>
				<Line
					type="monotone"
					dataKey="txAvg"
					stroke={chartConfig.txAvg.color}
					strokeWidth={2}
					dot={false}
					isAnimationActive={false}
				/>
			</LineChart>
		</ChartContainer>
	);
}
