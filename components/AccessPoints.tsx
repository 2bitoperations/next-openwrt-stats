'use client';
import { useQueries } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from './ui/card';
import { Badge } from '@/components/ui/badge';
import { LoaderCircle, RouterIcon } from 'lucide-react';
import { useActiveRouter } from '@/providers/activeRouterContext';
import { useWifiAPsQuery } from '@/providers/wifiAPsContext';
import { formatBand, secondsToHumanReadable } from '@/lib/utils';
import { getRouterInfo } from '@/app/api/routers/info/route';

export function AccessPoints() {
	const { allRouters } = useActiveRouter();
	const wifiAPs = useWifiAPsQuery();

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

	if (!allRouters || allRouters.length === 0) {
		return null;
	}

	if (wifiAPs.isLoading) {
		return (
			<div className="grid h-32 w-full place-items-center">
				<LoaderCircle className="h-8 w-8 animate-spin" />
			</div>
		);
	}

	const wifiInterfacesByRouter: {
		[displayName: string]: {
			ssid: string;
			band: string;
			channel: number;
			htmode: string;
			txpower: number;
			bitrate?: number;
			disabled?: boolean;
		}[];
	} = {};
	if (wifiAPs.data) {
		Object.entries(wifiAPs.data.wifiAPsPerSSID).forEach(([ssid, entries]) => {
			entries.forEach((entry) => {
				if (!wifiInterfacesByRouter[entry.displayName]) {
					wifiInterfacesByRouter[entry.displayName] = [];
				}
				wifiInterfacesByRouter[entry.displayName].push({ ...entry, ssid });
			});
		});
	}

	return (
		<div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
			{allRouters.map((router, i) => {
				const info = routerInfoQueries[i];
				const interfaces = (
					wifiInterfacesByRouter[router.displayName] || []
				).sort((a, b) => a.band.localeCompare(b.band));

				return (
					<Card key={router.displayName} className="w-full gap-4">
						<CardHeader>
							<h3 className="flex items-center justify-between text-lg font-semibold">
								<span className="flex items-center gap-2">
									<RouterIcon className="h-5 w-5" />
									{router.displayName}
								</span>
								{router.isPrimary === 1 && (
									<Badge variant="secondary" className="text-xs">
										Primary
									</Badge>
								)}
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
								{interfaces.length === 0 ? (
									<p className="text-muted-foreground text-xs">
										No wireless interfaces
									</p>
								) : (
									<div className="space-y-2 border-t pt-2">
										{interfaces.map((iface, idx) => (
											<div
												key={`${iface.ssid}-${iface.band}-${idx}`}
												className="flex items-center justify-between gap-2 text-xs"
											>
												<div className="flex items-center gap-1.5 truncate">
													<Badge variant="outline" className="shrink-0 text-xs">
														{formatBand(iface.band)}
													</Badge>
													<span className="truncate">{iface.ssid}</span>
													{iface.disabled && (
														<Badge variant="destructive" className="shrink-0 text-xs">
															Off
														</Badge>
													)}
												</div>
												<span className="text-muted-foreground shrink-0">
													ch {iface.channel || '?'} · {iface.txpower || '?'} dBm
												</span>
											</div>
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
