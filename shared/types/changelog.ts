export type SharedChangelogData = {
	current: {
		commit: string;
		url: string;
	};
	expiresAt: number;
	latest?: {
		commit: string;
		url: string;
	};
	packages?: boolean;
};
