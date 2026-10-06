import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function calcMbps(prev: number[], curr: number[]) {
	const [t1, rx1, , tx1] = prev;
	const [t2, rx2, , tx2] = curr;

	const dt = t2 - t1;
	const drx = rx2 - rx1;
	const dtx = tx2 - tx1;

	if (dt <= 0) return { rxMbps: 0, txMbps: 0 };

	const rxMbps = (drx * 8) / dt / 1_000_000;
	const txMbps = (dtx * 8) / dt / 1_000_000;

	return {
		rxMbps: Number(rxMbps.toFixed(2)) <= 0 ? 0 : rxMbps,
		txMbps: Number(txMbps.toFixed(2)) <= 0 ? 0 : txMbps
	};
}

export function secondsToHumanReadable(seconds: number) {
	const days = Math.floor(seconds / (60 * 60 * 24));
	seconds %= 60 * 60 * 24;
	const hours = Math.floor(seconds / (60 * 60));
	seconds %= 60 * 60;
	const minutes = Math.floor(seconds / 60);
	seconds %= 60;
	return [days, hours, minutes, seconds]
		.map((value, index) => {
			if (value === 0) return null;
			return `${value.toFixed(0)}${['d', 'h', 'm', 's'][index]}`;
		})
		.filter((value) => value !== null)
		.join(' ');
}

export function formatBytes(bytes: number, decimals = 2) {
	if (bytes === 0) return '0 Bytes';

	const k = 1024;
	const dm = decimals < 0 ? 0 : decimals;
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}

export function ipToSortableNumber(ip: string) {
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return 0;
	return parts[0] * 2 ** 24 + parts[1] * 2 ** 16 + parts[2] * 2 ** 8 + parts[3];
}

export function formatBitrate(bytesPerSecond: number) {
	const bitsPerSecond = bytesPerSecond * 8;
	if (bitsPerSecond < 1000) return `${bitsPerSecond.toFixed(0)} bps`;
	if (bitsPerSecond < 1_000_000) return `${(bitsPerSecond / 1000).toFixed(1)} Kbps`;
	if (bitsPerSecond < 1_000_000_000)
		return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
	return `${(bitsPerSecond / 1_000_000_000).toFixed(2)} Gbps`;
}

// Radios that have no htmode (802.11ah HaLow, band 's1g': width follows the
// channel) get 'S1G' so they still render; anything else unknown stays visible
// as such rather than being silently dropped.
export function radioHtmode(band: string, htmode: string | undefined): string {
	return htmode ?? (band === 's1g' ? 'S1G' : 'unknown');
}

export function wifiGenerationLabel(htmode: string | undefined, band?: string) {
	if (!htmode) return undefined;
	if (htmode === 'S1G') return 'HaLow';
	if (htmode.startsWith('EHT')) return '7';
	if (htmode.startsWith('HE')) return band === '6g' ? '6E' : '6';
	if (htmode.startsWith('VHT')) return '5';
	if (htmode.startsWith('HT')) return '4';
	return undefined;
}

export function wifiGenerationFullLabel(htmode: string | undefined) {
	if (!htmode) return 'Unknown';
	if (htmode === 'S1G') return 'Wi-Fi HaLow (ah)';
	if (htmode.startsWith('EHT')) return 'Wi-Fi 7 (be)';
	if (htmode.startsWith('HE')) return 'Wi-Fi 6/6E (ax)';
	if (htmode.startsWith('VHT')) return 'Wi-Fi 5 (ac)';
	if (htmode.startsWith('HT')) return 'Wi-Fi 4 (n)';
	return htmode || 'Unknown';
}

export const formatBand = (band: string | string[]): string => {
	if (Array.isArray(band)) {
		if (band.includes('s1g')) return band.map((b) => formatBand(b)).join(' / ');
		return `${band.map((b) => b.replaceAll('2g', '2.4').replaceAll('5g', '5').replaceAll('6g', '6')).join(' / ')} GHz`;
	}
	switch (band) {
		case '2g':
			return '2.4 GHz';
		case '5g':
			return '5 GHz';
		case '6g':
			return '6 GHz';
		case 's1g':
			return '900 MHz';
		default:
			return band;
	}
};
