import got from "got";
import colors from "chalk";
import log from "../log";
import pkg from "../../package.json";
import Helper from "../helper";
import ClientManager from "../clientManager";
import Config from "../config";
import {SharedChangelogData} from "../../shared/types/changelog";

const TIME_TO_LIVE = 15 * 60 * 1000; // 15 minutes, in milliseconds

const GITHUB_REPO = "giorgiobrullo/thelounge";

export default {
	isUpdateAvailable: false,
	fetch: fetchVersionData,
	checkForUpdates,
};

const versions: SharedChangelogData = {
	current: {
		commit: Helper.getGitCommit() || "unknown",
		url: `https://github.com/${GITHUB_REPO}/commit/${Helper.getGitCommit() || "master"}`,
	},
	expiresAt: -1,
	latest: undefined,
	packages: undefined,
};

async function fetchVersionData() {
	const time = Date.now();

	// Serving information from cache
	if (versions.expiresAt > time) {
		return versions;
	}

	try {
		const response = await got(
			`https://api.github.com/repos/${GITHUB_REPO}/commits/master`,
			{
				headers: {
					Accept: "application/vnd.github.v3+json",
					"User-Agent": pkg.name + "; +" + pkg.repository.url,
				},
				localAddress: Config.values.bind,
			}
		);

		if (response.statusCode !== 200) {
			return versions;
		}

		const data = JSON.parse(response.body);
		const remoteSha = data.sha as string;
		const remoteShort = remoteSha.substring(0, 7);
		const localCommit = Helper.getGitCommit();

		// If we can't determine local commit, we can't compare
		if (!localCommit) {
			versions.expiresAt = time + TIME_TO_LIVE;
			return versions;
		}

		// Check if the remote commit matches the local one
		const isMatch =
			remoteSha.startsWith(localCommit) || localCommit.startsWith(remoteShort);

		if (!isMatch) {
			module.exports.isUpdateAvailable = true;

			versions.latest = {
				commit: remoteShort,
				url: `https://github.com/${GITHUB_REPO}/compare/${localCommit}...${remoteShort}`,
			};
		}

		versions.expiresAt = time + TIME_TO_LIVE;
	} catch (error) {
		// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
		log.error(`Failed to fetch version info: ${error}`);
	}

	return versions;
}

function checkForUpdates(manager: ClientManager) {
	fetchVersionData()
		.then((versionData) => {
			if (!module.exports.isUpdateAvailable) {
				// Check for updates every 24 hours + random jitter of <3 hours
				setTimeout(
					() => checkForUpdates(manager),
					24 * 3600 * 1000 + Math.floor(Math.random() * 10000000)
				);
			}

			if (!versionData.latest) {
				return;
			}

			log.info(
				`The Lounge ${colors.green(
					versionData.latest.commit
				)} is available. See what changed: ${versionData.latest.url}`
			);

			// Notify all connected clients about the new version
			manager.clients.forEach((client) => client.emit("changelog:newversion"));
		})
		.catch((error: Error) => {
			log.error(`Failed to check for updates: ${error.message}`);
		});
}
