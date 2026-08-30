import 'server-only';
import { ubusBatchCall } from './ubusCalls';
import { dhcpDevicesSchema } from '@/types/ubusCalls';
import { getRouters } from './router';
import { logError } from '../client/errorLog';

type Lease = {
	deviceName: string;
	macAddress: string;
	ipAddress: string;
	leaseTime: number | boolean;
};

const REAL_MAC_PATTERN = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

function leaseScore(lease: Lease) {
	let score = 0;
	if (REAL_MAC_PATTERN.test(lease.macAddress)) score += 2;
	if (typeof lease.leaseTime === 'number') score += 1;
	return score;
}

// The same host can be reported by more than one router (e.g. a static
// reservation configured on both, or a lease momentarily visible to more
// than one router's dnsmasq) - keep the most complete entry per IP.
function dedupeLeasesByIp(leases: Lease[]) {
	const byIp = new Map<string, Lease>();
	for (const lease of leases) {
		const existing = byIp.get(lease.ipAddress);
		if (!existing || leaseScore(lease) > leaseScore(existing)) {
			byIp.set(lease.ipAddress, lease);
		}
	}
	return Array.from(byIp.values());
}

export type DhcpDevices = Awaited<ReturnType<typeof getDhcpDevices>>;
export async function getDhcpDevices() {
	const allRouters = await getRouters();
	if (!allRouters.success) {
		return {
			success: false,
			errorMessage: allRouters.errorMessage
		} as const;
	}

	const perRouterLeases = await Promise.all(
		allRouters.data.map(async (router) => {
			// Each router's leases are collected into their own local array so
			// the static-lease dedup check below never races against another
			// router's concurrently-running lookup.
			const leases: Lease[] = [];

			const dhcpDevicesResponse = await ubusBatchCall({
				displayName: router.displayName,
				calls: [
					{ id: 1, params: ['luci-rpc', 'getDHCPLeases', {}] },
					{
						id: 2,
						params: [
							'uci',
							'get',
							{
								config: 'dhcp'
							}
						]
					}
				]
			});
			if (!dhcpDevicesResponse.success) {
				logError({
					displayName: router.displayName,
					errorMessage: 'Failed to get dhcp devices',
					...dhcpDevicesResponse
				});
				return leases;
			}
			const parsedDhcpDevicesResponse = dhcpDevicesSchema.safeParse(
				dhcpDevicesResponse.data.find((response) => response.id === 1)
			);
			if (!parsedDhcpDevicesResponse.success) {
				logError({
					displayName: router.displayName,
					errorMessage: 'Failed to parse dhcp devices response',
					zodError: parsedDhcpDevicesResponse.error,
					...dhcpDevicesResponse
				});
				return leases;
			}
			if (parsedDhcpDevicesResponse.data.result) {
				for (const device of parsedDhcpDevicesResponse.data.result[1]
					.dhcp_leases) {
					leases.push({
						deviceName: device.hostname || 'Unknown Device',
						macAddress: device.macaddr.toUpperCase(),
						ipAddress: device.ipaddr,
						leaseTime: device.expires
					});
				}
			}
			try {
				// We don't want to crash the whole app in case something goes wrong with static leases
				// hence we're catching the error and just moving on
				const dhcpConfig = dhcpDevicesResponse.data.find(
					(response) => response.id === 2
				);
				if (!dhcpConfig || !dhcpConfig.success) {
					return leases;
				}
				const dhcpStaticLeases = Object.values(
					dhcpConfig?.result?.[1].values
				).filter((device: any) => device['.type'] === 'host') as {
					name: string;
					mac: string[];
					ip: string;
					leasetime: string;
				}[];
				const allMacsInLeases = leases.map((lease) =>
					lease.macAddress.toUpperCase()
				);
				for (const device of dhcpStaticLeases) {
					if (allMacsInLeases.includes(device.mac[0].toUpperCase())) {
						continue;
					}
					leases.push({
						deviceName: device.name || 'Unknown Device',
						macAddress: device.mac[0].toUpperCase(),
						ipAddress: device.ip,
						leaseTime: false
					});
				}
			} catch {}
			return leases;
		})
	);

	const deduped = dedupeLeasesByIp(perRouterLeases.flat());

	return {
		success: true,
		data: deduped.sort((a, b) => a.ipAddress.localeCompare(b.ipAddress))
	} as const;
}
