'use client';
import { Routers } from '@/lib/server/router';
import { useQuery } from '@tanstack/react-query';
import {
	createContext,
	useContext,
	useEffect,
	useState,
	ReactNode
} from 'react';
import { usePathname } from 'next/navigation';

type ActiveRouterContextType = {
	allRouters?: { displayName: string; isPrimary: number }[];
	activeRouter?: string;
	setActiveRouter: (displayName: string) => void;
	isLoading: boolean;
	error?: Error;
};

const ActiveRouterContext = createContext<ActiveRouterContextType | undefined>(
	undefined
);

export function ActiveRouterProvider({ children }: { children: ReactNode }) {
	const [activeRouter, setActiveRouterState] = useState<string | undefined>(
		undefined
	);
	const pathname = usePathname();

	const allRoutersQuery = useQuery({
		queryKey: ['getRouters'],
		queryFn: async () => {
			const response = await fetch('/api/routers/all');
			const data = (await response.json()) as Routers;
			if (!data.success) {
				throw new Error(data.errorMessage);
			}
			if (!data.data || data.data.length === 0) {
				throw new Error('No routers found');
			}
			return data.data;
		},
		refetchOnWindowFocus: false,
		refetchOnMount: false,
		enabled: pathname !== '/register'
	});

	useEffect(() => {
		if (!allRoutersQuery.data) return;
		const savedRouter = localStorage.getItem('activeRouter');
		const savedRouterIsValid = allRoutersQuery.data.find(
			(router) => router.displayName === savedRouter
		);
		if (savedRouter && savedRouterIsValid) {
			setActiveRouterState(savedRouter);
		} else {
			// No usable saved choice (first load, or the saved router is gone) -
			// there's no picker for this anymore, so default to the primary router.
			const defaultRouter =
				allRoutersQuery.data.find((router) => router.isPrimary === 1) ||
				allRoutersQuery.data[0];
			setActiveRouterState(defaultRouter.displayName);
			localStorage.setItem('activeRouter', defaultRouter.displayName);
		}
	}, [allRoutersQuery.dataUpdatedAt]);

	const setActiveRouter = (displayName: string) => {
		setActiveRouterState(displayName);
		localStorage.setItem('activeRouter', displayName);
	};

	return (
		<ActiveRouterContext.Provider
			value={{
				allRouters: allRoutersQuery.data,
				activeRouter,
				setActiveRouter,
				isLoading: allRoutersQuery.isLoading,
				error: allRoutersQuery.error as Error | undefined
			}}
		>
			{children}
		</ActiveRouterContext.Provider>
	);
}

export function useActiveRouter() {
	const context = useContext(ActiveRouterContext);
	if (context === undefined) {
		throw new Error(
			'useActiveRouter must be used within an ActiveRouterProvider'
		);
	}
	return context;
}
