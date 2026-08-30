'use client';
import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { formatBand, wifiGenerationFullLabel, wifiGenerationLabel } from '@/lib/utils';
import { PresenceSegments } from '@/app/api/presence/[mac]/segments/route';

const HISTORY_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const CLOSE_DELAY_MS = 100;

type WifiDataForHover = {
	band: string;
	htmode: string;
	channel: number;
};

async function fetchClientSegments(clientMac: string) {
	const to = Math.floor(Date.now() / 1000);
	const from = to - HISTORY_WINDOW_SECONDS;
	const params = new URLSearchParams({ from: String(from), to: String(to) });
	const res = await fetch(
		`/api/presence/${encodeURIComponent(clientMac)}/segments?${params.toString()}`
	);
	const data = (await res.json()) as PresenceSegments;
	if (!data.success) throw new Error(data.errorMessage);
	return data.data;
}

export function ClientProtocolHoverCard({
	clientMac,
	wifiData,
	presenceEnabled,
	htmodeByRouterBand,
	children
}: {
	clientMac: string;
	wifiData: WifiDataForHover;
	presenceEnabled: boolean;
	htmodeByRouterBand: Map<string, string>;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	function openNow() {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		setOpen(true);
	}
	function closeSoon() {
		closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
	}

	const segmentsQuery = useQuery({
		queryKey: ['clientProtocolHistory', clientMac],
		queryFn: () => fetchClientSegments(clientMac),
		enabled: open && presenceEnabled,
		staleTime: 60_000
	});

	const breakdown = useMemo(() => {
		if (!segmentsQuery.data) return null;
		const totals = new Map<string, { router: string; band: string; seconds: number }>();
		let totalSeconds = 0;
		for (const segment of segmentsQuery.data) {
			const duration = segment.endTimestamp - segment.startTimestamp;
			if (duration <= 0) continue;
			totalSeconds += duration;
			const key = `${segment.router}|${segment.band}`;
			const existing = totals.get(key);
			if (existing) {
				existing.seconds += duration;
			} else {
				totals.set(key, { router: segment.router, band: segment.band, seconds: duration });
			}
		}
		return {
			totalSeconds,
			groups: Array.from(totals.values()).sort((a, b) => b.seconds - a.seconds)
		};
	}, [segmentsQuery.data]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<div
					className="inline-flex cursor-default"
					onMouseEnter={openNow}
					onMouseLeave={closeSoon}
				>
					{children}
				</div>
			</PopoverTrigger>
			<PopoverContent
				className="w-96"
				align="start"
				onMouseEnter={openNow}
				onMouseLeave={closeSoon}
			>
				<div className="space-y-2">
					<h4 className="mb-2 font-medium">Wi-Fi Protocol</h4>
					<div className="space-y-1">
						<p className="flex justify-between text-sm">
							<span className="text-muted-foreground">Current:</span>
							<span>{wifiGenerationFullLabel(wifiData.htmode)}</span>
						</p>
						<p className="flex justify-between text-sm">
							<span className="text-muted-foreground">Band:</span>
							<span>{formatBand(wifiData.band)}</span>
						</p>
						<p className="flex justify-between text-sm">
							<span className="text-muted-foreground">Channel:</span>
							<span>{wifiData.channel || 'Unknown'}</span>
						</p>
					</div>
					{presenceEnabled && (
						<div className="pt-2">
							<h4 className="text-muted-foreground mb-1.5 text-xs font-medium uppercase tracking-wide">
								Last 30 Days
							</h4>
							{segmentsQuery.isLoading ? (
								<p className="text-muted-foreground text-sm">Loading…</p>
							) : segmentsQuery.isError ||
							  !breakdown ||
							  breakdown.groups.length === 0 ? (
								<p className="text-muted-foreground text-sm">No history yet</p>
							) : (
								<div className="space-y-1">
									{breakdown.groups.map((group) => (
										<div
											key={`${group.router}|${group.band}`}
											className="flex items-center justify-between gap-2 text-sm"
										>
											<span className="truncate">
												{group.router} · {formatBand(group.band)} · Wi-Fi{' '}
												{wifiGenerationLabel(
													htmodeByRouterBand.get(`${group.router}|${group.band}`),
													group.band
												) || '?'}
											</span>
											<span className="text-muted-foreground shrink-0">
												{((group.seconds / breakdown.totalSeconds) * 100).toFixed(0)}%
											</span>
										</div>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
