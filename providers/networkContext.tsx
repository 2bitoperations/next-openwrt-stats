'use client';
import { NetworkInterface } from '@/types/ubusCalls';
import { NetworkInterfaces } from '@/lib/server/routerInterfaces';
import { useQuery } from '@tanstack/react-query';
import {
	createContext,
	useContext,
	useState,
	ReactNode,
	useEffect,
	useRef
} from 'react';
import { usePathname } from 'next/navigation';
import { useActiveRouter } from './activeRouterContext';

type NetworkContextType = {
	networkInterfaces?: NetworkInterface[];
	activeDevice?: NetworkInterface;
	setActiveDevice: (device: NetworkInterface) => void;
	isLoading: boolean;
	error?: Error;
};

const NetworkContext = createContext<NetworkContextType | undefined>(undefined);

function pickDefaultDevice(networkInterfaces: NetworkInterface[]) {
	const hasAddress = (device: NetworkInterface) =>
		device.up && (device['ipv4-address']?.length ?? 0) > 0;
	return (
		networkInterfaces.find((device) => device.interface === 'wan' && hasAddress(device)) ||
		networkInterfaces.find(hasAddress) ||
		networkInterfaces.find((device) => device.up) ||
		networkInterfaces[0]
	);
}

export function NetworkProvider({ children }: { children: ReactNode }) {
	const [activeDevice, setActiveDevice] = useState<NetworkInterface>();
	const pathname = usePathname();
	const { activeRouter } = useActiveRouter();
	const {
		data: networkInterfaces,
		isLoading,
		error,
		dataUpdatedAt
	} = useQuery({
		queryKey: ['networkInterfaces', activeRouter],
		queryFn: async () => {
			const networkInterfaces = await fetch(
				`/api/routers/primary/interfaces?displayName=${activeRouter}`
			).then((res) => res.json() as Promise<NetworkInterfaces>);
			if (!networkInterfaces.success) {
				throw new Error(networkInterfaces.errorMessage);
			}
			if (networkInterfaces.data.length === 0) {
				throw new Error('No network interfaces found');
			}
			return networkInterfaces.data;
		},
		refetchInterval: false,
		retry: 1,
		enabled: pathname !== '/register' && !!activeRouter
	});

	const prevActiveRouterRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (!networkInterfaces) return;

		const routerChanged =
			prevActiveRouterRef.current !== undefined &&
			prevActiveRouterRef.current !== activeRouter;
		prevActiveRouterRef.current = activeRouter;

		if (routerChanged) {
			// Different routers commonly expose an interface with the same name
			// (e.g. every router has a "lan"), so name-based matching below would
			// otherwise keep showing the PREVIOUS router's device. Always pick a
			// fresh default when the router itself changes.
			setActiveDevice(pickDefaultDevice(networkInterfaces));
			return;
		}

		if (
			!activeDevice ||
			// This is in case the selected interface went away (e.g. reconfigured on the router).
			networkInterfaces.findIndex(
				(device) =>
					device.device === activeDevice?.device &&
					device.interface === activeDevice?.interface
			) === -1
		) {
			const localStorageActiveDevice = localStorage.getItem('activeDevice');
			if (localStorageActiveDevice) {
				const localStorageActiveDeviceParsed = JSON.parse(
					localStorageActiveDevice
				);
				const activeDevice = networkInterfaces?.find(
					(device) =>
						device.device === localStorageActiveDeviceParsed.device &&
						device.interface === localStorageActiveDeviceParsed.interface &&
						device.up
				);
				if (!activeDevice) {
					setActiveDevice(pickDefaultDevice(networkInterfaces));
					return;
				}
				setActiveDevice(activeDevice);
			} else {
				setActiveDevice(pickDefaultDevice(networkInterfaces));
			}
		}
	}, [dataUpdatedAt, activeDevice, activeRouter, networkInterfaces]);

	useEffect(() => {
		if (activeDevice) {
			localStorage.setItem('activeDevice', JSON.stringify(activeDevice));
		}
	}, [activeDevice]);

	return (
		<NetworkContext.Provider
			value={{
				networkInterfaces,
				activeDevice,
				setActiveDevice,
				isLoading,
				error: error as Error | undefined
			}}
		>
			{children}
		</NetworkContext.Provider>
	);
}

export function useNetwork() {
	const context = useContext(NetworkContext);
	if (context === undefined) {
		throw new Error('useNetwork must be used within a NetworkProvider');
	}
	return context;
}
