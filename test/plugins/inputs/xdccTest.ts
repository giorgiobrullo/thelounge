import {expect} from "vitest";
import sinon from "ts-sinon";

import xdccInput from "../../../server/plugins/inputs/xdcc";
import Config from "../../../server/config";
import Chan from "../../../server/models/chan";
import {ChanType} from "../../../shared/types/chan";

describe("xdcc input", function () {
	const originalEnabled = Config.values.xdcc.enable;

	afterEach(function () {
		Config.values.xdcc.enable = originalEnabled;
	});

	it("requests a numbered pack from the bot", function () {
		Config.values.xdcc.enable = true;
		const chan = new Chan({name: "#thelounge", type: ChanType.CHANNEL});
		const say = sinon.stub();
		const pushMessage = sinon.stub(chan, "pushMessage");

		xdccInput.input.call({} as any, {irc: {say}} as any, chan, "xdcc", ["SomeBot", "#42"]);

		expect(say.calledOnceWithExactly("SomeBot", "XDCC SEND #42")).to.equal(true);
		expect(pushMessage.firstCall.args[1].text).to.equal(
			"Requested XDCC pack #42 from SomeBot."
		);
	});

	it("rejects invalid pack numbers", function () {
		Config.values.xdcc.enable = true;
		const chan = new Chan({name: "#thelounge", type: ChanType.CHANNEL});
		const say = sinon.stub();
		const pushMessage = sinon.stub(chan, "pushMessage");

		xdccInput.input.call({} as any, {irc: {say}} as any, chan, "xdcc", ["SomeBot", "latest"]);

		expect(say.called).to.equal(false);
		expect(pushMessage.firstCall.args[1].text).to.equal(
			"Usage: /xdcc <bot> <pack number> [tls]"
		);
	});

	it("requests a TLS-encrypted pack from the bot", function () {
		Config.values.xdcc.enable = true;
		const chan = new Chan({name: "#thelounge", type: ChanType.CHANNEL});
		const say = sinon.stub();
		const pushMessage = sinon.stub(chan, "pushMessage");

		xdccInput.input.call({} as any, {irc: {say}} as any, chan, "xdcc", [
			"SomeBot",
			"42",
			"tls",
		]);

		expect(say.calledOnceWithExactly("SomeBot", "XDCC SSEND #42")).to.equal(true);
		expect(pushMessage.firstCall.args[1].text).to.equal(
			"Requested TLS XDCC pack #42 from SomeBot."
		);
	});
});
