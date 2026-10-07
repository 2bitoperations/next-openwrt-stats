'use client';
import { useState } from 'react';
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger
} from '@/components/ui/dialog';
import { BandwidthHistoryChart, RANGE_OPTIONS, RangePicker } from './BandwidthHistoryChart';
import { SignalHistoryChart } from './SignalHistoryChart';

export function ClientHistoryDialog({
	clientMac,
	clientName,
	presenceEnabled,
	children
}: {
	clientMac: string;
	clientName: string;
	presenceEnabled?: boolean;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [rangeSeconds, setRangeSeconds] = useState<number>(RANGE_OPTIONS[1].seconds);
	const chartClass = 'aspect-auto h-[160px] w-full sm:h-[200px]';
	const noSplit =
		'No LAN / Internet breakdown yet - needs macacct 2+ on the node this client is attached to';

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="w-full max-w-[95vw] max-h-[90dvh] overflow-y-auto sm:max-w-2xl md:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{clientName || clientMac} — History</DialogTitle>
					<div className="flex justify-end">
						<RangePicker
							rangeSeconds={rangeSeconds}
							setRangeSeconds={setRangeSeconds}
						/>
					</div>
				</DialogHeader>
				<div className="space-y-6">
					<div className="space-y-4">
						<h4 className="text-muted-foreground text-sm font-medium">Traffic</h4>
						<div>
							<h5 className="text-muted-foreground mb-1 text-xs">Total</h5>
							<BandwidthHistoryChart
								scope="client"
								metricKey={clientMac}
								rangeSeconds={rangeSeconds}
								className={chartClass}
							/>
						</div>
						<div>
							<h5 className="text-muted-foreground mb-1 text-xs">
								LAN (to/from other devices on the network)
							</h5>
							<BandwidthHistoryChart
								scope="client_lan"
								metricKey={clientMac}
								rangeSeconds={rangeSeconds}
								emptyMessage={noSplit}
								className={chartClass}
							/>
						</div>
						<div>
							<h5 className="text-muted-foreground mb-1 text-xs">
								Internet (to/from the router)
							</h5>
							<BandwidthHistoryChart
								scope="client_wan"
								metricKey={clientMac}
								rangeSeconds={rangeSeconds}
								emptyMessage={noSplit}
								className={chartClass}
							/>
						</div>
					</div>
					<div>
						<h4 className="text-muted-foreground mb-1 text-sm font-medium">
							Signal Strength
						</h4>
						<SignalHistoryChart
							clientMac={clientMac}
							presenceEnabled={presenceEnabled}
							rangeSeconds={rangeSeconds}
							className="aspect-auto h-[200px] w-full sm:h-[260px]"
						/>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
