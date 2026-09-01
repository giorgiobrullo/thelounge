export type FileTypeIcon =
	| "archive"
	| "audio"
	| "code"
	| "document"
	| "image"
	| "pdf"
	| "presentation"
	| "spreadsheet"
	| "video"
	| "file";

const extensionTypes: Record<string, FileTypeIcon> = {
	// Video
	avi: "video",
	flv: "video",
	m2ts: "video",
	m4v: "video",
	mkv: "video",
	mov: "video",
	mp4: "video",
	mpeg: "video",
	mpg: "video",
	mts: "video",
	ogv: "video",
	ts: "video",
	webm: "video",
	wmv: "video",

	// Audio
	aac: "audio",
	aiff: "audio",
	alac: "audio",
	flac: "audio",
	m4a: "audio",
	mp3: "audio",
	oga: "audio",
	ogg: "audio",
	opus: "audio",
	wav: "audio",
	wma: "audio",

	// Images
	avif: "image",
	bmp: "image",
	gif: "image",
	heic: "image",
	heif: "image",
	ico: "image",
	jpeg: "image",
	jpg: "image",
	png: "image",
	svg: "image",
	tif: "image",
	tiff: "image",
	webp: "image",

	// Archives and disk images
	"7z": "archive",
	bz2: "archive",
	dmg: "archive",
	gz: "archive",
	iso: "archive",
	rar: "archive",
	tar: "archive",
	tbz: "archive",
	tgz: "archive",
	txz: "archive",
	xz: "archive",
	zip: "archive",
	zst: "archive",

	// Documents
	doc: "document",
	docx: "document",
	epub: "document",
	md: "document",
	odt: "document",
	rtf: "document",
	txt: "document",
	pdf: "pdf",

	// Spreadsheets and presentations
	csv: "spreadsheet",
	ods: "spreadsheet",
	tsv: "spreadsheet",
	xls: "spreadsheet",
	xlsx: "spreadsheet",
	key: "presentation",
	odp: "presentation",
	ppt: "presentation",
	pptx: "presentation",

	// Source and structured text
	bash: "code",
	c: "code",
	cc: "code",
	cjs: "code",
	cpp: "code",
	cs: "code",
	css: "code",
	go: "code",
	h: "code",
	hpp: "code",
	html: "code",
	java: "code",
	js: "code",
	json: "code",
	jsx: "code",
	mjs: "code",
	php: "code",
	py: "code",
	rb: "code",
	rs: "code",
	sh: "code",
	sql: "code",
	svelte: "code",
	toml: "code",
	ts: "code",
	tsx: "code",
	vue: "code",
	xml: "code",
	yaml: "code",
	yml: "code",
	zsh: "code",
};

export default function fileTypeIcon(fileName: string): FileTypeIcon {
	const extension = fileName.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "";

	return extensionTypes[extension] ?? "file";
}
