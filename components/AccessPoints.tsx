'use client';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from './ui/card';
import { Badge } from '@/components/ui/badge';
import { LoaderCircle, RouterIcon } from 'lucide-react';
import { useActiveRouter } from '@/providers/activeRouterContext';
import { formatBand, secondsToHumanReadable, wifiGenerationFullLabel } from '@/lib/utils';
import { getRouterInfo } from '@/app/api/routers/info/route';
import { GetWanFailoverState } from '@/app/api/wan-failover/state/route';
import { WifiRadio } from '@/lib/server/wifiAPs';
import { RadioHistoryDialog } from './RadioHistoryDialog';
import { WanFailoverHistoryDialog } from './WanFailoverHistoryDialog';

function radioModeLabel(radio: WifiRadio) {
	if (radio.mode === 'mesh') return 'Mesh';
	return wifiGenerationFullLabel(radio.htmode);
}

function useRadiosQuery() {
	return useQuery({
		queryKey: ['radios'],
		queryFn: async () => {
			const res = await fetch('/api/radios');
			const data = (await res.json()) as {
				success: boolean;
				data?: WifiRadio[];
				errorMessage?: string;
			};
			if (!data.success || !data.data) {
				throw new Error(data.errorMessage || 'Failed to load radios');
			}
			return data.data;
		},
		refetchInterval: 30_000
	});
}

function secondsSince(timestamp: number) {
	return Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
}

export function AccessPoints() {
	const { allRouters } = useActiveRouter();
	const radiosQuery = useRadiosQuery();

	const routerInfoQueries = useQueries({
		queries: (allRouters || []).map((router) => ({
			queryKey: ['getRouterInfo', router.displayName],
			queryFn: async () => {
				const response = await fetch(
					`/api/routers/info?displayName=${router.displayName}`
				);
				const data = (await response.json()) as getRouterInfo;
				if (!data.success) throw new Error(data.errorMessage);
				return data.data;
			}
		}))
	});

	const wanFailoverQueries = useQueries({
		queries: (allRouters || []).map((router) => ({
			queryKey: ['wanFailoverState', router.displayName],
			queryFn: async () => {
				const response = await fetch(
					`/api/wan-failover/state?displayName=${router.displayName}`
				);
				const data = (await response.json()) as GetWanFailoverState;
				if (!data.success) throw new Error(data.errorMessage);
				return data.data;
			},
			refetchInterval: 15_000
		}))
	});

	if (!allRouters || allRouters.length === 0) {
		return null;
	}

	if (radiosQuery.isLoading) {
		return (
			<div className="grid h-32 w-full place-items-center">
				<LoaderCircle className="h-8 w-8 animate-spin" />
			</div>
		);
	}

	const radiosByRouter: { [displayName: string]: WifiRadio[] } = {};
	for (const radio of radiosQuery.data || []) {
		if (!radiosByRouter[radio.displayName]) radiosByRouter[radio.displayName] = [];
		radiosByRouter[radio.displayName].push(radio);
	}

	return (
		<div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
			{allRouters.map((router, i) => {
				const info = routerInfoQueries[i];
				const wanFailover = wanFailoverQueries[i];
				const radios = (radiosByRouter[router.displayName] || []).sort((a, b) =>
					a.band.localeCompare(b.band)
				);

				return (
					<Card key={router.displayName} className="w-full gap-4">
						<CardHeader>
							<h3 className="flex items-center justify-between text-lg font-semibold">
								<span className="flex items-center gap-2">
									<RouterIcon className="h-5 w-5" />
									{router.displayName}
								</span>
								<span className="flex items-center gap-1.5">
									{router.isPrimary === 1 && (
										<Badge variant="secondary" className="text-xs">
											Primary
										</Badge>
									)}
									{wanFailover?.data && (
										<WanFailoverHistoryDialog displayName={router.displayName}>
											<button>
												<Badge
													variant={
														wanFailover.data.activeInterface === 'primary'
															? 'default'
															: 'destructive'
													}
													className="text-xs"
													title={`Active for ${secondsToHumanReadable(
														secondsSince(wanFailover.data.since)
													)}`}
												>
													{wanFailover.data.activeInterface === 'primary'
														? 'WAN: Starlink'
														: 'WAN: T-Mobile'}
												</Badge>
											</button>
										</WanFailoverHistoryDialog>
									)}
								</span>
							</h3>
						</CardHeader>
						<CardContent>
							<div className="space-y-3 text-sm">
								<p className="flex justify-between">
									<span className="text-muted-foreground">Model:</span>
									<span>
										{info?.isLoading ? '- - - -' : info?.data?.model || 'Unknown'}
									</span>
								</p>
								<p className="flex justify-between">
									<span className="text-muted-foreground">Uptime:</span>
									<span>
										{info?.isLoading || !info?.data
											? '- - - -'
											: secondsToHumanReadable(info.data.uptime)}
									</span>
								</p>
								{radios.length === 0 ? (
									<p className="text-muted-foreground text-xs">
										No wireless interfaces
									</p>
								) : (
									<div className="space-y-1 border-t pt-2">
										{radios.map((radio, idx) => (
											<RadioHistoryDialog
												key={`${radio.ifname}-${idx}`}
												radio={radio}
											>
												<button className="hover:bg-muted flex w-full items-center justify-between gap-2 rounded-md px-1 py-1.5 text-left text-xs">
													<div className="flex min-w-0 items-center gap-1.5">
														<Badge variant="outline" className="shrink-0 text-xs">
															{formatBand(radio.band)}
														</Badge>
														<Badge
															variant={radio.mode === 'mesh' ? 'default' : 'secondary'}
															className="shrink-0 text-xs"
														>
															{radioModeLabel(radio)}
														</Badge>
														<span className="truncate">
															{radio.ssid || radio.meshId}
														</span>
														{radio.disabled && (
															<Badge variant="destructive" className="shrink-0 text-xs">
																Off
															</Badge>
														)}
													</div>
													<span className="text-muted-foreground shrink-0">
														ch {radio.channel || '?'} · {radio.txpower || '?'} dBm
													</span>
												</button>
											</RadioHistoryDialog>
										))}
									</div>
								)}
							</div>
						</CardContent>
					</Card>
				);
			})}
		</div>
	);
}
