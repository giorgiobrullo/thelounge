import {expect} from "vitest";
import express from "express";
import http from "http";
import net from "net";

import Config from "../../server/config";
import Xdcc, {isBlockedAddress, parseDccSend} from "../../server/plugins/xdcc";

describe("XDCC", function () {
	const originalConfig = {...Config.values.xdcc};

	afterEach(function () {
		Object.assign(Config.values.xdcc, originalConfig);
	});

	it("parses quoted names and legacy integer IPv4 addresses", function () {
		expect(parseDccSend('DCC SEND "example file.bin" 2130706433 5000 1234')).to.deep.equal({
			fileName: "example file.bin",
			address: "127.0.0.1",
			port: 5000,
			size: 1234,
		});
	});

	it("removes path components from offered file names", function () {
		expect(parseDccSend("DCC SEND ../../example.bin 203.0.113.1 5000 12")?.fileName).to.equal(
			"example.bin"
		);
	});

	it("blocks private and reserved address ranges", function () {
		expect(isBlockedAddress("127.0.0.1")).to.equal(true);
		expect(isBlockedAddress("192.168.1.1")).to.equal(true);
		expect(isBlockedAddress("203.0.113.1")).to.equal(true);
		expect(isBlockedAddress("1.1.1.1")).to.equal(false);
	});

	it("streams a download and acknowledges the received byte count", async function () {
		Config.values.xdcc.enable = true;
		Config.values.xdcc.allowPrivateAddresses = true;
		const payload = Buffer.from("hello XDCC");
		let resolveAcknowledgement!: (value: number) => void;
		const acknowledgement = new Promise<number>((resolve) => {
			resolveAcknowledgement = resolve;
		});
		const dccServer = net.createServer((socket) => {
			socket.write(payload);
			socket.once("data", (data) => {
				resolveAcknowledgement(data.readUInt32BE(0));
				socket.end();
			});
		});

		await new Promise<void>((resolve) => dccServer.listen(0, "127.0.0.1", resolve));
		const dccAddress = dccServer.address();

		if (!dccAddress || typeof dccAddress === "string") {
			throw new Error("DCC test server did not bind to a TCP port");
		}

		const registration = Xdcc.registerOffer(
			`DCC SEND test.bin 2130706433 ${dccAddress.port} ${payload.length}`
		);

		if (!registration?.offer) {
			throw new Error(registration?.error || "DCC offer was not registered");
		}

		const app = express();
		Xdcc.router(app);
		const webServer = http.createServer(app);
		await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
		const webAddress = webServer.address();

		if (!webAddress || typeof webAddress === "string") {
			throw new Error("XDCC web test server did not bind to a TCP port");
		}

		try {
			const response = await fetch(
				`http://127.0.0.1:${webAddress.port}/${registration.offer.url}`
			);
			const body = Buffer.from(await response.arrayBuffer());

			expect(response.status).to.equal(200);
			expect(response.headers.get("content-disposition")).to.contain("test.bin");
			expect(body).to.deep.equal(payload);
			expect(await acknowledgement).to.equal(payload.length);
		} finally {
			await Promise.all([
				new Promise<void>((resolve) => dccServer.close(() => resolve())),
				new Promise<void>((resolve) => webServer.close(() => resolve())),
			]);
		}
	});
});
