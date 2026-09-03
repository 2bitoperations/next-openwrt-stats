'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger
} from './ui/dialog';
import { Badge } from '@/components/ui/badge';
import { LoaderCircle } from 'lucide-react';
import { RANGE_OPTIONS, RangePicker } from './BandwidthHistoryChart';
import {
	WanFailoverSegment,
	WanFailoverSegments
} from '@/app/api/wan-failover/[displayName]/segments/route';
import { secondsToHumanReadable } from '@/lib/utils';

const INTERFACE_LABEL: Record<'primary' | 'backup', string> = {
	primary: 'Primary (Starlink)',
	backup: 'Backup (T-Mobile)'
};

async function fetchSegments(displayName: string, rangeSeconds: number) {
	const to = Math.floor(Date.now() / 1000);
	const from = to - rangeSeconds;
	const params = new URLSearchParams({ from: String(from), to: String(to) });
	const res = await fetch(
		`/api/wan-failover/${encodeURIComponent(displayName)}/segments?${params.toString()}`
	);
	const data = (await res.json()) as WanFailoverSegments;
	if (!data.success) throw new Error(data.errorMessage);
	return data.data;
}

function timeLabel(timestamp: number, rangeSeconds: number) {
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

function SegmentTimeline({
	segments,
	rangeStart,
	rangeEnd
}: {
	segments: WanFailoverSegment[];
	rangeStart: number;
	rangeEnd: number;
}) {
	const totalDuration = rangeEnd - rangeStart;
	if (totalDuration <= 0) return null;
	return (
		<div className="flex h-4 w-full overflow-hidden rounded-full border">
			{segments.map((segment, i) => {
				const widthPct =
					((segment.endTimestamp - segment.startTimestamp) / totalDuration) * 100;
				return (
					<div
						key={i}
						title={`${INTERFACE_LABEL[segment.activeInterface]}: ${timeLabel(
							segment.startTimestamp,
							totalDuration
						)} - ${timeLabel(segment.endTimestamp, totalDuration)}`}
						style={{ width: `${widthPct}%` }}
						className={
							segment.activeInterface === 'primary' ? 'bg-chart-1' : 'bg-chart-4'
						}
					/>
				);
			})}
		</div>
	);
}

export function WanFailoverHistoryDialog({
	displayName,
	children
}: {
	displayName: string;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [rangeSeconds, setRangeSeconds] = useState<number>(RANGE_OPTIONS[3].seconds);

	const segmentsQuery = useQuery({
		queryKey: ['wanFailoverSegments', displayName, rangeSeconds],
		queryFn: () => fetchSegments(displayName, rangeSeconds),
		enabled: open,
		staleTime: 15_000
	});

	const now = Math.floor(Date.now() / 1000);
	const rangeStart = now - rangeSeconds;

	const breakdown = useMemo(() => {
		if (!segmentsQuery.data) return null;
		let primarySeconds = 0;
		let backupSeconds = 0;
		let flips = 0;
		for (const segment of segmentsQuery.data) {
			const duration = segment.endTimestamp - segment.startTimestamp;
			if (duration <= 0) continue;
			if (segment.activeInterface === 'primary') primarySeconds += duration;
			else backupSeconds += duration;
		}
		flips = Math.max(0, segmentsQuery.data.length - 1);
		const total = primarySeconds + backupSeconds;
		return { primarySeconds, backupSeconds, total, flips };
	}, [segmentsQuery.data]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="w-full max-w-[95vw] sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{displayName} — WAN Failover History</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					<div className="flex items-center justify-between">
						<h4 className="text-muted-foreground text-sm font-medium">Timeline</h4>
						<RangePicker rangeSeconds={rangeSeconds} setRangeSeconds={setRangeSeconds} />
					</div>
					{segmentsQuery.isLoading ? (
						<div className="flex h-[100px] items-center justify-center">
							<LoaderCircle className="h-6 w-6 animate-spin" />
						</div>
					) : segmentsQuery.isError ||
					  !segmentsQuery.data ||
					  segmentsQuery.data.length === 0 ? (
						<p className="text-muted-foreground py-6 text-center text-sm">
							No failover history in this range
						</p>
					) : (
						<div className="space-y-4">
							<SegmentTimeline
								segments={segmentsQuery.data}
								rangeStart={rangeStart}
								rangeEnd={now}
							/>
							<div className="flex justify-between text-xs">
								<span>{timeLabel(rangeStart, rangeSeconds)}</span>
								<span>now</span>
							</div>

							{breakdown && breakdown.total > 0 && (
								<div className="grid grid-cols-2 gap-3 border-t pt-3">
									<div className="space-y-1">
										<div className="flex items-center gap-1.5 text-sm">
											<span className="bg-chart-1 inline-block h-2.5 w-2.5 rounded-full" />
											{INTERFACE_LABEL.primary}
										</div>
										<div className="text-muted-foreground text-xs">
											{secondsToHumanReadable(breakdown.primarySeconds)} (
											{((breakdown.primarySeconds / breakdown.total) * 100).toFixed(1)}%)
										</div>
									</div>
									<div className="space-y-1">
										<div className="flex items-center gap-1.5 text-sm">
											<span className="bg-chart-4 inline-block h-2.5 w-2.5 rounded-full" />
											{INTERFACE_LABEL.backup}
										</div>
										<div className="text-muted-foreground text-xs">
											{secondsToHumanReadable(breakdown.backupSeconds)} (
											{((breakdown.backupSeconds / breakdown.total) * 100).toFixed(1)}%)
										</div>
									</div>
									<div className="col-span-2 text-xs text-muted-foreground">
										{breakdown.flips} failover event{breakdown.flips === 1 ? '' : 's'} in
										this range
									</div>
								</div>
							)}

							<div className="max-h-[240px] space-y-1 overflow-y-auto border-t pt-3">
								{[...segmentsQuery.data].reverse().map((segment, i) => (
									<div
										key={i}
										className="flex items-center justify-between gap-2 text-sm"
									>
										<span className="flex items-center gap-1.5">
											<Badge
												variant={
													segment.activeInterface === 'primary'
														? 'secondary'
														: 'outline'
												}
												className="text-xs"
											>
												{INTERFACE_LABEL[segment.activeInterface]}
											</Badge>
										</span>
										<span className="text-muted-foreground text-xs">
											{timeLabel(segment.startTimestamp, rangeSeconds)} –{' '}
											{segment.endTimestamp >= now
												? 'now'
												: timeLabel(segment.endTimestamp, rangeSeconds)}{' '}
											(
											{secondsToHumanReadable(
												segment.endTimestamp - segment.startTimestamp
											)}
											)
										</span>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
