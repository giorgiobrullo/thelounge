import {expect} from "vitest";

import Uploader from "../../server/plugins/uploader";
import Utils from "../../server/command-line/utils";

describe("uploader", function () {
	it("detects file types with the current file-type API", async function () {
		const filePath = Utils.getFileFromRelativeToRoot(
			"client",
			"public",
			"img",
			"logo-grey-bg-120x120px.png"
		);

		expect(await Uploader.getFileType(filePath)).to.equal("image/png");
	});
});
