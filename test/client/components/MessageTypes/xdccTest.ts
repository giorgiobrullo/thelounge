// @vitest-environment jsdom
import {mount} from "@vue/test-utils";
import {afterEach, describe, expect, it, vi} from "vitest";
import MessageTypeXdcc from "../../../../client/components/MessageTypes/xdcc.vue";
import type {ClientNetwork} from "../../../../client/js/types";
import type {XdccTransfer, XdccTransferStatus} from "../../../../shared/types/msg";

const mockStore = vi.hoisted(() => ({
	state: {xdccTransfers: [] as XdccTransfer[]},
}));

vi.mock("../../../../client/js/store", () => ({
	useStore: () => mockStore,
}));

const offer = {
	id: "offer-1",
	fileName: "movie.mkv",
	size: 1024,
	url: "xdcc/offer-1/movie.mkv",
	offeredAt: Date.now(),
	expiresAt: Date.now() + 60_000,
	secure: false,
};

function mountOffer(status: XdccTransferStatus) {
	mockStore.state.xdccTransfers = [
		{
			...offer,
			sender: "TestBot",
			network: "Test Network",
			status,
			received: 0,
			speed: 0,
		} as XdccTransfer,
	];

	return mount(MessageTypeXdcc, {
		global: {
			stubs: {
				Username: {template: "<span>TestBot</span>"},
			},
		},
		props: {
			network: {} as ClientNetwork,
			message: {
				id: 1,
				time: new Date(),
				users: [],
				from: {nick: "TestBot", mode: ""},
				xdcc: offer,
			},
		},
	});
}

afterEach(() => {
	mockStore.state.xdccTransfers = [];
});

describe("XDCC offer message", () => {
	it("shows a download link while the offer is available", () => {
		const wrapper = mountOffer("offered");

		expect(wrapper.get("a.xdcc-download").text()).to.equal("Download");
		expect(wrapper.find(".xdcc-status").exists()).to.equal(false);
	});

	it("removes the link and marks an expired offer", () => {
		const wrapper = mountOffer("expired");

		expect(wrapper.find("a.xdcc-download").exists()).to.equal(false);
		expect(wrapper.get(".xdcc-status").text()).to.equal("Expired");
		expect(wrapper.classes()).to.include("xdcc-offer-expired");
	});

	it("shows live non-downloadable transfer states", () => {
		const wrapper = mountOffer("transferring");

		expect(wrapper.find("a.xdcc-download").exists()).to.equal(false);
		expect(wrapper.get(".xdcc-status").text()).to.equal("Downloading");
	});
});
