'use client';
import {
	createContext,
	useContext,
	useState,
	ReactNode
} from 'react';
import { DEFAULT_RANGE_SECONDS } from '@/components/BandwidthHistoryChart';

type TimeRangeContextType = {
	rangeSeconds: number;
	setRangeSeconds: (seconds: number) => void;
};

const TimeRangeContext = createContext<TimeRangeContextType | undefined>(
	undefined
);

export function TimeRangeProvider({ children }: { children: ReactNode }) {
	const [rangeSeconds, setRangeSeconds] = useState<number>(
		DEFAULT_RANGE_SECONDS
	);

	return (
		<TimeRangeContext.Provider value={{ rangeSeconds, setRangeSeconds }}>
			{children}
		</TimeRangeContext.Provider>
	);
}

// Returns undefined (instead of throwing) when there is no provider, so that
// charts rendered outside the provider tree can fall back to their own
// internal range state.
export function useTimeRange() {
	return useContext(TimeRangeContext);
}
