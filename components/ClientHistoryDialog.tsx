'use client';
import { useState } from 'react';
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ChartAreaIcon } from 'lucide-react';
import { BandwidthHistoryChart } from './BandwidthHistoryChart';
import { SignalHistoryChart } from './SignalHistoryChart';

export function ClientHistoryDialog({
	clientMac,
	clientName,
	presenceEnabled
}: {
	clientMac: string;
	clientName: string;
	presenceEnabled?: boolean;
}) {
	const [open, setOpen] = useState(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					<ChartAreaIcon className="h-4 w-4" />
				</Button>
			</DialogTrigger>
			<DialogContent className="w-full max-w-[95vw] sm:max-w-2xl md:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{clientName || clientMac} — History</DialogTitle>
				</DialogHeader>
				<div className="space-y-6">
					<div>
						<h4 className="text-muted-foreground mb-1 text-sm font-medium">
							Traffic
						</h4>
						<BandwidthHistoryChart
							scope="client"
							metricKey={clientMac}
							className="aspect-auto h-[200px] w-full sm:h-[260px]"
						/>
					</div>
					<div>
						<h4 className="text-muted-foreground mb-1 text-sm font-medium">
							Signal Strength
						</h4>
						<SignalHistoryChart
							clientMac={clientMac}
							presenceEnabled={presenceEnabled}
							className="aspect-auto h-[200px] w-full sm:h-[260px]"
						/>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
