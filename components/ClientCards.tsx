'use client';
import { DhcpDevices } from '@/lib/server/dhcpDevices';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from './ui/card';
import {
	ArrowDownAZ,
	ArrowUpAZ,
	LoaderCircle,
	RouterIcon,
	SearchIcon,
	UserIcon,
	WifiIcon
} from 'lucide-react';
import { WifiClients, WifiClientsTraffic } from '@/lib/server/wifiAPs';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
	calcMbps,
	cn,
	formatBand,
	formatBytes,
	ipToSortableNumber,
	secondsToHumanReadable,
	wifiGenerationLabel
} from '@/lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from './ui/select';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useActiveRouter } from '@/providers/activeRouterContext';
import { ClientHistoryDialog } from './ClientHistoryDialog';
import { ClientProtocolHoverCard } from './ClientProtocolHoverCard';
import { ClientSparkline } from './ClientSparkline';
import { ClientBandwidthSummary, ClientLatestRates, ClientRecentSeries } from '@/lib/server/metrics';
import { WifiRadio } from '@/lib/server/wifiAPs';

type WifiDataEntry = {
	signal: number;
	noise?: number;
	connected_time?: number;
	rx: { packets: number; bytes: number };
	tx: { packets: number; bytes: number };
	displayName: string;
	ssid: string;
	band: string;
	htmode: string;
	channel: number;
};

const BAND_ICON_COLOR: Record<string, string> = {
	'2g': 'text-sky-400',
	'5g': 'text-violet-400',
	'6g': 'text-emerald-400'
};

function ClientIcon({ wifiData }: { wifiData: WifiDataEntry | undefined }) {
	if (!wifiData) return <UserIcon className="h-7 w-7" />;
	const generation = wifiGenerationLabel(wifiData.htmode, wifiData.band);
	return (
		<div className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center">
			<WifiIcon
				className={cn('h-6 w-6', BAND_ICON_COLOR[wifiData.band] || 'text-white')}
			/>
			{generation && (
				<span className="bg-background text-muted-foreground ring-border absolute -bottom-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-bold leading-none ring-1">
					{generation}
				</span>
			)}
		</div>
	);
}

type Rate = { rxMbps: number; txMbps: number };

type SortKey = 'name' | 'ip' | 'signal' | 'bandwidth1h' | 'bandwidth1d' | 'bandwidth1mo';

const BANDWIDTH_WINDOW_SECONDS: Partial<Record<SortKey, number>> = {
	bandwidth1h: 60 * 60,
	bandwidth1d: 24 * 60 * 60,
	bandwidth1mo: 30 * 24 * 60 * 60
};

export default function ClientCards({
	presenceEnabled
}: {
	presenceEnabled: boolean;
}) {
	const { allRouters } = useActiveRouter();
	const [search, setSearch] = useState('');
	const [apFilter, setApFilter] = useState('all');
	const [bandFilter, setBandFilter] = useState('all');
	const [sortKey, setSortKey] = useState<SortKey>('name');
	const [sortAsc, setSortAsc] = useState(true);

	const dhcpDevicesQuery = useQuery({
		queryKey: ['dhcpDevices'],
		queryFn: async () => {
			const dhcpDevices = await fetch('/api/routers/all/dhcp-devices').then(
				(res) => res.json() as Promise<DhcpDevices>
			);
			if (!dhcpDevices.success) {
				throw new Error(dhcpDevices.errorMessage);
			}

			return dhcpDevices.data;
		},
		refetchInterval: false,
		retry: 1
	});

	// Sourced from the cached radio snapshot (fast, no live ubus round-trip)
	// rather than calling getWifiAPs() live on every load.
	const radiosQuery = useQuery({
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

	const wifiAPsIfname = useMemo(() => {
		const ifnames: {
			[displayName: string]: {
				ifname: string;
				ssid: string;
				band: string;
				htmode: string;
				channel: number;
			}[];
		} = {};
		for (const radio of radiosQuery.data || []) {
			if (radio.mode === 'mesh' || !radio.ssid) continue;
			if (!ifnames[radio.displayName]) ifnames[radio.displayName] = [];
			ifnames[radio.displayName].push({
				ifname: radio.ifname,
				ssid: radio.ssid,
				band: radio.band,
				htmode: radio.htmode,
				channel: radio.channel
			});
		}
		return ifnames;
	}, [radiosQuery.data]);

	// Lets the protocol hover card label *historical* presence segments (which
	// only record router+band, not htmode) with a Wi-Fi generation, on the
	// assumption a given router+band's radio config is roughly stable over time.
	const htmodeByRouterBand = useMemo(() => {
		const map = new Map<string, string>();
		for (const [displayName, radios] of Object.entries(wifiAPsIfname)) {
			for (const radio of radios) {
				map.set(`${displayName}|${radio.band}`, radio.htmode);
			}
		}
		return map;
	}, [wifiAPsIfname]);

	const wifiClientsQuery = useQuery({
		queryKey: ['wifiClients'],
		queryFn: async () => {
			const wifiClients = await fetch('/api/routers/all/wifi/clients', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ ifnames: wifiAPsIfname })
			}).then((res) => res.json() as Promise<WifiClients>);
			if (!wifiClients.success) {
				throw new Error(wifiClients.errorMessage);
			}

			return wifiClients.data;
		},
		enabled: Object.keys(wifiAPsIfname).length > 0
	});
	const wifiClientsTrafficQuery = useQuery({
		queryKey: ['wifiClientsTraffic'],
		queryFn: async () => {
			const wifiClientsTraffic = await fetch(
				'/api/routers/all/wifi/clients/traffic',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({ ifnames: wifiAPsIfname })
				}
			).then((res) => res.json() as Promise<WifiClientsTraffic>);
			if (!wifiClientsTraffic.success) {
				throw new Error(wifiClientsTraffic.errorMessage);
			}
			return wifiClientsTraffic.data;
		},
		refetchInterval: 3000,
		enabled: Object.keys(wifiAPsIfname).length > 0
	});

	const bandwidthWindowSeconds = BANDWIDTH_WINDOW_SECONDS[sortKey];
	const bandwidthSummaryQuery = useQuery({
		queryKey: ['clientBandwidthSummary', bandwidthWindowSeconds],
		queryFn: async () => {
			const res = await fetch(
				`/api/metrics/client-bandwidth-summary?windowSeconds=${bandwidthWindowSeconds}`
			);
			const data = (await res.json()) as ClientBandwidthSummary;
			if (!data.success) throw new Error(data.errorMessage);
			return data.data;
		},
		enabled: bandwidthWindowSeconds !== undefined,
		refetchInterval: 30_000
	});

	// Wired (and any other non-wifi) clients only get a new number once per
	// collector tick (~5s) - there's no sub-5s "live" data for them even in
	// principle, so this polls the most recent collected sample instead of
	// computing a delta client-side the way the true-live wifi poll does.
	const clientLatestRatesQuery = useQuery({
		queryKey: ['clientLatestRates'],
		queryFn: async () => {
			const res = await fetch('/api/metrics/client-latest-rates');
			const data = (await res.json()) as ClientLatestRates;
			if (!data.success) throw new Error(data.errorMessage);
			return data.data;
		},
		refetchInterval: 5000
	});

	const clientRecentSeriesQuery = useQuery({
		queryKey: ['clientRecentSeries'],
		queryFn: async () => {
			const res = await fetch('/api/metrics/client-recent-series');
			const data = (await res.json()) as ClientRecentSeries;
			if (!data.success) throw new Error(data.errorMessage);
			return data.data;
		},
		refetchInterval: 5000
	});

	// Rates are computed here (not per-card) so the list can sort by bandwidth.
	const prevTrafficRef = useRef<
		Map<string, { rxBytes: number; txBytes: number; time: number }>
	>(new Map());
	const [wifiRates, setWifiRates] = useState<Map<string, Rate>>(new Map());

	const rates = useMemo(() => {
		const merged = new Map<string, Rate>(wifiRates);
		if (clientLatestRatesQuery.data) {
			for (const [mac, data] of Object.entries(clientLatestRatesQuery.data)) {
				if (merged.has(mac)) continue; // true-live wifi rate wins if present
				merged.set(mac, {
					rxMbps: (data.rxAvg * 8) / 1_000_000,
					txMbps: (data.txAvg * 8) / 1_000_000
				});
			}
		}
		return merged;
	}, [wifiRates, clientLatestRatesQuery.data]);

	useEffect(() => {
		if (!wifiClientsTrafficQuery.data) return;
		const prevMap = prevTrafficRef.current;
		const newRates = new Map<string, Rate>();
		Object.entries(wifiClientsTrafficQuery.data).forEach(([mac, data]) => {
			const prev = prevMap.get(mac);
			if (prev) {
				const traffic = calcMbps(
					[prev.time, prev.rxBytes, 0, prev.txBytes],
					[data.time, data.rxBytes, 0, data.txBytes]
				);
				newRates.set(mac, { rxMbps: traffic.rxMbps, txMbps: traffic.txMbps });
			}
			prevMap.set(mac, data);
		});
		setWifiRates(newRates);
	}, [wifiClientsTrafficQuery.data]);

	const filteredSortedDevices = useMemo(() => {
		if (!dhcpDevicesQuery.data) return [];
		const searchLower = search.trim().toLowerCase();

		let devices = dhcpDevicesQuery.data.filter((device) => {
			const wifiData = wifiClientsQuery.data?.[device.macAddress.toUpperCase()];

			if (searchLower) {
				const matches =
					device.deviceName.toLowerCase().includes(searchLower) ||
					device.ipAddress.toLowerCase().includes(searchLower) ||
					device.macAddress.toLowerCase().includes(searchLower);
				if (!matches) return false;
			}

			if (apFilter !== 'all') {
				if (!wifiData || wifiData.displayName !== apFilter) return false;
			}

			if (bandFilter !== 'all') {
				if (!wifiData || wifiData.band !== bandFilter) return false;
			}

			return true;
		});

		devices = devices.sort((a, b) => {
			let diff = 0;
			switch (sortKey) {
				case 'name':
					diff = a.deviceName.localeCompare(b.deviceName);
					break;
				case 'ip':
					diff =
						ipToSortableNumber(a.ipAddress) - ipToSortableNumber(b.ipAddress);
					break;
				case 'signal': {
					const sigA =
						wifiClientsQuery.data?.[a.macAddress.toUpperCase()]?.signal ?? -999;
					const sigB =
						wifiClientsQuery.data?.[b.macAddress.toUpperCase()]?.signal ?? -999;
					diff = sigA - sigB;
					break;
				}
				case 'bandwidth1h':
				case 'bandwidth1d':
				case 'bandwidth1mo': {
					const totalA = bandwidthSummaryQuery.data?.[a.macAddress.toUpperCase()] || 0;
					const totalB = bandwidthSummaryQuery.data?.[b.macAddress.toUpperCase()] || 0;
					diff = totalA - totalB;
					break;
				}
			}
			return sortAsc ? diff : -diff;
		});

		return devices;
	}, [
		dhcpDevicesQuery.data,
		wifiClientsQuery.data,
		rates,
		bandwidthSummaryQuery.data,
		search,
		apFilter,
		bandFilter,
		sortKey,
		sortAsc
	]);

	function handleSortKeyChange(value: string) {
		const nextKey = value as SortKey;
		setSortKey(nextKey);
		if (BANDWIDTH_WINDOW_SECONDS[nextKey] !== undefined) {
			setSortAsc(false);
		}
	}

	if (dhcpDevicesQuery.isError) {
		return (
			<div className="w-full py-4">
				<div className="grid h-44 w-full place-items-center text-xl">
					<div className="flex h-full w-full flex-col items-center justify-center">
						<div>Error: {dhcpDevicesQuery.error?.message}</div>
					</div>
				</div>
			</div>
		);
	}

	if (dhcpDevicesQuery.isLoading) {
		return (
			<div className="w-full py-4">
				<div className="grid h-44 w-full place-items-center text-xl">
					<div className="flex h-full w-full flex-col items-center justify-center">
						<LoaderCircle className="h-12 w-12 animate-spin" />
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="w-full space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative w-full sm:w-64">
					<SearchIcon className="text-muted-foreground absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2" />
					<Input
						placeholder="Search name, IP, or MAC"
						className="pl-8"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
				<Select value={apFilter} onValueChange={setApFilter}>
					<SelectTrigger className="w-[160px]">
						<SelectValue placeholder="AP" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All APs</SelectItem>
						{(allRouters || []).map((router) => (
							<SelectItem key={router.displayName} value={router.displayName}>
								{router.displayName}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={bandFilter} onValueChange={setBandFilter}>
					<SelectTrigger className="w-[140px]">
						<SelectValue placeholder="Band" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All bands</SelectItem>
						<SelectItem value="2g">2.4 GHz</SelectItem>
						<SelectItem value="5g">5 GHz</SelectItem>
						<SelectItem value="6g">6 GHz</SelectItem>
					</SelectContent>
				</Select>
				<Select value={sortKey} onValueChange={handleSortKeyChange}>
					<SelectTrigger className="w-[180px]">
						<SelectValue placeholder="Sort by" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="name">Sort: Name</SelectItem>
						<SelectItem value="ip">Sort: IP address</SelectItem>
						<SelectItem value="signal">Sort: Signal</SelectItem>
						<SelectItem value="bandwidth1h">Sort: Bandwidth (1h)</SelectItem>
						<SelectItem value="bandwidth1d">Sort: Bandwidth (1d)</SelectItem>
						<SelectItem value="bandwidth1mo">Sort: Bandwidth (1mo)</SelectItem>
					</SelectContent>
				</Select>
				<Button
					variant="outline"
					size="icon"
					onClick={() => setSortAsc((prev) => !prev)}
					title={sortAsc ? 'Ascending' : 'Descending'}
				>
					{sortAsc ? (
						<ArrowUpAZ className="h-4 w-4" />
					) : (
						<ArrowDownAZ className="h-4 w-4" />
					)}
				</Button>
				<span className="text-muted-foreground ml-auto text-xs">
					{filteredSortedDevices.length} of {dhcpDevicesQuery.data?.length || 0}
				</span>
			</div>
			<div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
				{filteredSortedDevices.map((device) => (
					<ClientCard
						device={device}
						key={device.macAddress}
						wifiData={wifiClientsQuery.data?.[device.macAddress.toUpperCase()]}
						rate={rates.get(device.macAddress.toUpperCase())}
						recentSeries={clientRecentSeriesQuery.data?.[device.macAddress.toUpperCase()]}
						presenceEnabled={presenceEnabled}
						htmodeByRouterBand={htmodeByRouterBand}
					/>
				))}
			</div>
		</div>
	);
}

function ClientCard({
	device,
	wifiData,
	rate,
	recentSeries,
	presenceEnabled,
	htmodeByRouterBand
}: {
	device: {
		deviceName: string;
		macAddress: string;
		ipAddress: string;
		leaseTime: number | boolean;
	};
	rate: Rate | undefined;
	recentSeries?: { timestamp: number; rxAvg: number; txAvg: number }[];
	wifiData: WifiDataEntry | undefined;
	presenceEnabled: boolean;
	htmodeByRouterBand: Map<string, string>;
}) {
	return (
		<Card className="w-full gap-2">
			<CardHeader className="relative pb-2 pt-1">
				<span className="absolute -top-5 right-7 text-[13.2px] font-medium text-white/70">
					{rate?.rxMbps || rate?.txMbps ? (
						<>
							↓ {rate?.rxMbps.toFixed(2) || '0.00'} / ↑{' '}
							{rate?.txMbps.toFixed(2) || '0.00'} Mbps
						</>
					) : (
						<></>
					)}
				</span>
				<div className="flex items-center overflow-hidden">
					{wifiData ? (
						<ClientProtocolHoverCard
							clientMac={device.macAddress}
							wifiData={wifiData}
							presenceEnabled={presenceEnabled}
							htmodeByRouterBand={htmodeByRouterBand}
						>
							<ClientIcon wifiData={wifiData} />
						</ClientProtocolHoverCard>
					) : (
						<ClientIcon wifiData={wifiData} />
					)}
					<h3 className="mx-2 overflow-hidden text-ellipsis whitespace-nowrap text-lg font-semibold">
						{device.deviceName || 'Unknown Device'}
					</h3>
				</div>
			</CardHeader>
			<CardContent>
				<div className="space-y-2 text-sm">
					<ClientHistoryDialog
						clientMac={device.macAddress}
						clientName={device.deviceName}
						presenceEnabled={presenceEnabled}
					>
						<div className="-m-1 cursor-pointer space-y-1.5 rounded-md p-1 pb-1 transition-colors hover:bg-white/5">
							<ClientSparkline points={recentSeries} />
						</div>
					</ClientHistoryDialog>
					<p className="flex justify-between">
						<span className="text-muted-foreground">IP Address:</span>
						<span>{device.ipAddress}</span>
					</p>
					<p className="flex justify-between">
						<span className="text-muted-foreground">MAC Address:</span>
						<span>{device.macAddress}</span>
					</p>
					<p className="flex justify-between">
						<span className="text-muted-foreground">Traffic Stats:</span>
						<span>
							{wifiData ? (
								<>
									{/* AP-side station counters: tx = to the client (download) */}
									↓ {formatBytes(wifiData.tx.bytes)} / ↑{' '}
									{formatBytes(wifiData.rx.bytes)}
								</>
							) : (
								<>- - - -</>
							)}
						</span>
					</p>
					{wifiData && (
						<Popover>
							<PopoverTrigger asChild>
								<button
									type="button"
									className="hover:text-foreground -mx-1 flex w-[calc(100%+0.5rem)] items-center justify-between rounded-sm px-1 text-left"
								>
									<span className="text-muted-foreground">Router:</span>
									<span className="flex items-center gap-1.5">
										{wifiData.displayName}
										<RouterIcon className="h-3.5 w-3.5" />
									</span>
								</button>
							</PopoverTrigger>
							<PopoverContent className="w-80" align="end">
								<div className="space-y-2">
									<h4 className="mb-2 font-medium">WiFi Connection Details</h4>
									<div className="space-y-1">
										<p className="mt-2 flex justify-between text-sm">
											<span className="text-muted-foreground">Router:</span>
											<span>{wifiData.displayName}</span>
										</p>
										<p className="flex justify-between text-sm">
											<span className="text-muted-foreground">SSID:</span>
											<span>{wifiData.ssid}</span>
										</p>
										<p className="flex justify-between text-sm">
											<span className="text-muted-foreground">Band:</span>
											<span>{formatBand(wifiData.band)}</span>
										</p>
										<p className="flex justify-between text-sm">
											<span className="text-muted-foreground">
												Signal Strength:
											</span>
											<span>{wifiData.signal} dBm</span>
										</p>
										<p className="flex justify-between text-sm">
											<span className="text-muted-foreground">
												Noise Level:
											</span>
											<span>{wifiData.noise || 0} dBm</span>
										</p>
										<p className="flex justify-between text-sm">
											<span className="text-muted-foreground">
												Connected Time:
											</span>
											<span>
												{wifiData.connected_time
													? secondsToHumanReadable(wifiData.connected_time)
													: '- - - -'}
											</span>
										</p>
									</div>
								</div>
							</PopoverContent>
						</Popover>
					)}
					<p className="flex justify-between">
						<span className="text-muted-foreground">Lease Time:</span>
						<span>
							{secondsToHumanReadable(Number(device.leaseTime)) || 'Infinite'}
						</span>
					</p>
				</div>
			</CardContent>
		</Card>
	);
}
