import {describe, expect, it} from "vitest";
import fileTypeIcon from "../../../../client/js/helpers/fileTypeIcon";

describe("fileTypeIcon", () => {
	it.each([
		["movie.MKV", "video"],
		["album.flac", "audio"],
		["cover.webp", "image"],
		["release.tar.gz", "archive"],
		["manual.pdf", "pdf"],
		["notes.txt", "document"],
		["budget.xlsx", "spreadsheet"],
		["slides.pptx", "presentation"],
		["script.ts", "code"],
		["README", "file"],
		["payload.unknown", "file"],
	])("maps %s to the %s icon", (fileName, expected) => {
		expect(fileTypeIcon(fileName)).to.equal(expected);
	});
});
