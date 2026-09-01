import contentDisposition from "content-disposition";
import crypto from "crypto";
import type {Application, Request, Response} from "express";
import {Address4, Address6} from "ip-address";
import net from "net";
import tls from "tls";

import Config from "../config";
import type {
	XdccFile,
	XdccTransfer,
	XdccTransferStatus,
	XdccTransferUpdate,
} from "../../shared/types/msg";

type DccSend = {
	fileName: string;
	address: string;
	port: number;
	size?: number;
	secure: boolean;
	turbo: boolean;
};

type XdccOfferOwner = {
	id: string;
	sender: string;
	network: string;
	notify: (update: XdccTransferUpdate) => void;
};

type StoredOffer = DccSend & {
	id: string;
	url: string;
	offeredAt: number;
	expiresAt: number;
	timeout?: ReturnType<typeof setTimeout>;
	ownerId?: string;
	sender: string;
	network: string;
	status: XdccTransferStatus;
	received: number;
	speed: number;
	error?: string;
	active: boolean;
	notify?: XdccOfferOwner["notify"];
	cancel?: () => void;
};

export type XdccRegistration = {offer: XdccFile; error?: never} | {offer?: never; error: string};

const offers = new Map<string, StoredOffer>();
let activeDownloads = 0;

// Some cloud providers expose metadata or control-plane services at fixed IPs.
// Keep them unreachable even when private-network downloads are explicitly enabled.
const blockedControlPlaneAddresses = new Set([
	"100.100.100.200",
	"168.63.129.16",
	"169.254.169.254",
	"169.254.170.2",
	"fd00:ec2::254",
]);

function parseIpLiteral(value: string): Address4 | Address6 | undefined {
	try {
		if (value.includes(":")) {
			const address = new Address6(value);

			return address.parsedSubnet || address.zone ? undefined : address;
		}

		const address = new Address4(value);
		return address.parsedSubnet ? undefined : address;
	} catch {
		return undefined;
	}
}

function isBlockedControlPlaneAddress(address: Address4 | Address6): boolean {
	if (blockedControlPlaneAddresses.has(address.correctForm())) {
		return true;
	}

	const embeddedIpv4 = address instanceof Address6 ? address.embeddedIPv4() : null;

	return embeddedIpv4 !== null && blockedControlPlaneAddresses.has(embeddedIpv4.correctForm());
}

function parseAddress(value: string): string | undefined {
	if (/^\d+$/.test(value)) {
		try {
			const numericAddress = BigInt(value);

			if (numericAddress < 0n || numericAddress > 0xffffffffn) {
				return undefined;
			}

			return Address4.fromBigInt(numericAddress).correctForm();
		} catch {
			return undefined;
		}
	}

	return parseIpLiteral(value)?.correctForm();
}

function cleanFileName(value: string): string | undefined {
	const fileName = value
		.replace(/\\/g, "/")
		.split("/")
		.pop()!
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim();

	if (!fileName || fileName === "." || fileName === ".." || fileName.length > 255) {
		return undefined;
	}

	return fileName;
}

function parseArguments(value: string): {fileName: string; args: string[]} | undefined {
	const quoted = value.match(/^"((?:\\.|[^"\\])*)"\s+(.+)$/);
	const unquoted = value.match(/^(\S+)\s+(.+)$/);
	const match = quoted || unquoted;

	if (!match) {
		return undefined;
	}

	const rawFileName = quoted ? match[1].replace(/\\(["\\])/g, "$1") : match[1];
	const remainder = match[2];

	const fileName = cleanFileName(rawFileName);
	const args = remainder.split(/\s+/);

	return fileName ? {fileName, args} : undefined;
}

export function parseDccSend(message: string): DccSend | undefined {
	const match = message.match(/^DCC\s+(SEND|TSEND|SSEND|TSSEND|STSEND)\s+(.+?)\s*$/i);

	if (!match) {
		return undefined;
	}

	const parsed = parseArguments(match[2]);

	if (!parsed || parsed.args.length < 2 || parsed.args.length > 4) {
		return undefined;
	}

	const address = parseAddress(parsed.args[0]);
	const port = Number(parsed.args[1]);
	const size = parsed.args[2] === undefined ? undefined : Number(parsed.args[2]);
	const reverseToken = parsed.args[3];
	const flags = match[1].slice(0, -4).toUpperCase();

	if (
		!address ||
		!/^[0-9]+$/.test(parsed.args[1]) ||
		!Number.isInteger(port) ||
		port < 0 ||
		port > 65535 ||
		(size !== undefined &&
			(!/^[0-9]+$/.test(parsed.args[2]) || !Number.isSafeInteger(size) || size < 0)) ||
		(reverseToken !== undefined && !/^[0-9]+$/.test(reverseToken))
	) {
		return undefined;
	}

	return {
		fileName: parsed.fileName,
		address,
		port,
		size,
		secure: flags.includes("S"),
		turbo: flags.includes("T"),
	};
}

export function isBlockedAddress(address: string, allowPrivateAddresses = false): boolean {
	const parsed = parseIpLiteral(address);

	if (!parsed) {
		return true;
	}

	return isBlockedControlPlaneAddress(parsed) || (!allowPrivateAddresses && !parsed.isGlobal());
}

function getMaxFileSize(): number {
	const configuredSize = Config.values.xdcc.maxFileSize;
	return configuredSize < 0 ? Infinity : configuredSize * 1024;
}

function toXdccFile(offer: StoredOffer): XdccFile {
	return {
		id: offer.id,
		fileName: offer.fileName,
		size: offer.size,
		url: offer.url,
		offeredAt: offer.offeredAt,
		expiresAt: offer.expiresAt,
		secure: offer.secure,
	};
}

function toXdccTransfer(offer: StoredOffer): XdccTransfer {
	return {
		...toXdccFile(offer),
		sender: offer.sender,
		network: offer.network,
		status: offer.status,
		received: offer.received,
		speed: offer.speed,
		error: offer.error,
	};
}

function updateTransfer(offer: StoredOffer, status: XdccTransferStatus, error?: string): void {
	offer.status = status;
	offer.error = error;
	offer.notify?.({
		id: offer.id,
		status,
		received: offer.received,
		speed: offer.speed,
		error,
	});
}

function expireOffer(offer: StoredOffer): void {
	if (offer.active) {
		return;
	}

	if (offer.timeout) {
		clearTimeout(offer.timeout);
	}

	offers.delete(offer.id);
	offer.timeout = undefined;
	updateTransfer(offer, "expired");
}

function scheduleExpiry(offer: StoredOffer): void {
	if (offer.timeout) {
		clearTimeout(offer.timeout);
	}

	const remaining = offer.expiresAt - Date.now();

	if (remaining <= 0) {
		expireOffer(offer);
		return;
	}

	offer.timeout = setTimeout(() => expireOffer(offer), remaining);
	offer.timeout.unref();
}

function removeOffer(offer: StoredOffer): void {
	if (offer.timeout) {
		clearTimeout(offer.timeout);
	}

	offer.timeout = undefined;
	offers.delete(offer.id);
}

function registerOffer(message: string, owner?: XdccOfferOwner): XdccRegistration | undefined {
	if (!/^DCC\s+(?:SEND|TSEND|SSEND|TSSEND|STSEND)\b/i.test(message)) {
		return undefined;
	}

	if (!Config.values.xdcc.enable) {
		return {error: "XDCC downloads are disabled by the server administrator."};
	}

	const parsed = parseDccSend(message);

	if (!parsed) {
		return {error: "Received a malformed DCC SEND offer."};
	}

	if (parsed.port === 0) {
		return {error: "Reverse DCC SEND offers are not supported."};
	}

	if (parsed.port < Config.values.xdcc.minPort) {
		return {error: "Blocked an XDCC offer to a restricted TCP port."};
	}

	if (isBlockedAddress(parsed.address, Config.values.xdcc.allowPrivateAddresses)) {
		return {error: "Blocked an XDCC offer to a private or reserved address."};
	}

	const maxFileSize = getMaxFileSize();

	if (parsed.size !== undefined && parsed.size > maxFileSize) {
		return {error: "The offered XDCC file exceeds the configured size limit."};
	}

	const id = crypto.randomUUID();
	const offeredAt = Date.now();
	const offer: StoredOffer = {
		...parsed,
		id,
		url: `xdcc/${id}/${encodeURIComponent(parsed.fileName)}`,
		offeredAt,
		expiresAt: offeredAt + Config.values.xdcc.offerTimeout,
		ownerId: owner?.id,
		sender: owner?.sender || "Unknown sender",
		network: owner?.network || "",
		status: "offered",
		received: 0,
		speed: 0,
		active: false,
		notify: owner?.notify,
	};
	offers.set(id, offer);
	scheduleExpiry(offer);

	return {
		offer: toXdccFile(offer),
	};
}

function getOffer(id: string): StoredOffer | undefined {
	const offer = offers.get(id);

	if (!offer || offer.expiresAt <= Date.now()) {
		if (offer) {
			expireOffer(offer);
		}

		return undefined;
	}

	return offer;
}

function getTransfers(ownerId: string): XdccTransfer[] {
	const transfers: XdccTransfer[] = [];

	for (const offer of offers.values()) {
		if (!offer.active && offer.expiresAt <= Date.now()) {
			expireOffer(offer);
			continue;
		}

		if (offer.ownerId === ownerId) {
			transfers.push(toXdccTransfer(offer));
		}
	}

	return transfers.sort((a, b) => b.offeredAt - a.offeredAt);
}

function cancelTransfer(id: string, ownerId: string): boolean {
	const offer = offers.get(id);

	if (!offer?.active || offer.ownerId !== ownerId || !offer.cancel) {
		return false;
	}

	offer.cancel();
	return true;
}

function routeDownload(req: Request, res: Response): Response | void {
	if (!Config.values.xdcc.enable) {
		return res.status(404).send("Not found");
	}

	if (!/^[0-9a-f-]{36}$/i.test(req.params.token)) {
		return res.status(404).send("Not found");
	}

	const offer = getOffer(req.params.token);

	if (!offer) {
		return res.status(404).send("This XDCC offer is invalid or has expired");
	}

	if (offer.active) {
		return res.status(409).send("This XDCC offer is already being downloaded");
	}

	if (activeDownloads >= Config.values.xdcc.maxConcurrentDownloads) {
		return res.status(429).send("Too many XDCC downloads are already active");
	}

	if (isBlockedAddress(offer.address, Config.values.xdcc.allowPrivateAddresses)) {
		return res.status(403).send("This XDCC address is not allowed");
	}

	if (offer.port < Config.values.xdcc.minPort) {
		return res.status(403).send("This XDCC port is not allowed");
	}

	let received = 0;
	let finished = false;
	let upstreamEnded = false;
	let lastProgressAt = 0;
	const startedAt = Date.now();
	const maxFileSize = getMaxFileSize();
	const connectionOptions = {
		host: offer.address,
		port: offer.port,
		localAddress: Config.values.bind,
	};
	const source = offer.secure
		? tls.connect({...connectionOptions, rejectUnauthorized: false})
		: net.createConnection(connectionOptions);

	activeDownloads++;
	offer.active = true;

	if (offer.timeout) {
		clearTimeout(offer.timeout);
		offer.timeout = undefined;
	}

	const updateSpeed = () => {
		const elapsed = Date.now() - startedAt;
		offer.received = received;
		offer.speed = elapsed > 0 ? Math.round((received * 1000) / elapsed) : 0;
	};

	const finishTransfer = (
		status: Extract<XdccTransferStatus, "completed" | "failed" | "cancelled">,
		error?: string
	) => {
		if (finished) {
			return;
		}

		finished = true;
		activeDownloads--;
		offer.active = false;
		offer.cancel = undefined;
		updateSpeed();
		updateTransfer(offer, status, error);
		source.destroy();

		if (status === "completed") {
			removeOffer(offer);
		} else {
			scheduleExpiry(offer);
		}
	};

	const fail = (status: number, message: string) => {
		if (finished) {
			return;
		}

		if (!res.headersSent) {
			res.status(status).send(message);
		} else {
			res.destroy(Error(message));
		}

		finishTransfer("failed", message);
	};

	offer.cancel = () => {
		const message = "The XDCC download was cancelled.";

		if (!res.headersSent) {
			res.status(409).send(message);
		} else {
			res.destroy();
		}

		finishTransfer("cancelled", message);
	};

	updateTransfer(offer, "connecting");

	source.setNoDelay(true);
	source.setTimeout(Config.values.xdcc.timeout);

	const validateConnectedAddress = () => {
		const remoteAddress = source.remoteAddress;

		if (
			!remoteAddress ||
			isBlockedAddress(remoteAddress, Config.values.xdcc.allowPrivateAddresses)
		) {
			fail(403, "The connected XDCC address is not allowed");
			return false;
		}

		return true;
	};

	if (offer.secure) {
		source.once("connect", validateConnectedAddress);
	}

	source.once(offer.secure ? "secureConnect" : "connect", () => {
		if (!validateConnectedAddress()) {
			return;
		}

		updateTransfer(offer, "transferring");

		res.setHeader(
			"Content-Disposition",
			contentDisposition(offer.fileName, {type: "attachment", fallback: false})
		);
		res.setHeader("Content-Type", "application/octet-stream");
		res.setHeader("Cache-Control", "no-store");

		if (offer.size !== undefined) {
			res.setHeader("Content-Length", offer.size.toString());
		}

		res.flushHeaders();
	});

	source.on("data", (chunk: Buffer) => {
		received += chunk.length;

		if (received > maxFileSize || (offer.size !== undefined && received > offer.size)) {
			fail(502, "The XDCC sender exceeded the advertised file size");
			return;
		}

		const canContinue = res.write(chunk);

		if (!offer.turbo || (offer.size !== undefined && received === offer.size)) {
			const acknowledgement = Buffer.allocUnsafe(4);
			acknowledgement.writeUInt32BE(received % 0x100000000);
			source.write(acknowledgement);
		}

		if (!canContinue) {
			source.pause();
			res.once("drain", () => source.resume());
		}

		const now = Date.now();

		if (now - lastProgressAt >= 500 || received === offer.size) {
			lastProgressAt = now;
			updateSpeed();
			updateTransfer(offer, "transferring");
		}
	});

	source.once("end", () => {
		upstreamEnded = true;

		if (offer.size !== undefined && received !== offer.size) {
			fail(502, "The XDCC sender closed the connection before the file was complete");
			return;
		}

		res.end();
		finishTransfer("completed");
	});

	source.once("timeout", () => fail(504, "The XDCC sender timed out"));
	source.once("error", () => fail(502, "Could not connect to the XDCC sender"));
	source.once("close", (hadError) => {
		if (!finished && !upstreamEnded && !hadError) {
			fail(502, "The XDCC sender closed the connection unexpectedly");
		}
	});

	res.once("close", () => {
		if (!finished && !res.writableEnded) {
			finishTransfer("cancelled", "The browser stopped the XDCC download.");
		}
	});
}

export default {
	cancelTransfer,
	getTransfers,
	registerOffer,
	router(app: Application) {
		app.get("/xdcc/:token/:slug?", routeDownload);
	},
};
