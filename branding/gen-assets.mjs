#!/usr/bin/env node
// branding/gen-assets.mjs — SUNDAY(P-002)
// Generates all Sunday brand assets programmatically. Zero dependencies (node:fs, node:zlib only).
// Usage: node branding/gen-assets.mjs
// Outputs to branding/ and copies the needed files into the vscode/ tree
// (keeping upstream filenames so build scripts need no changes).

import { writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const VSCODE = join(ROOT, '..', 'vscode');
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------- CRC32 / PNG
const CRC_T = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
	return t;
})();
function crc32(buf) {
	let c = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
	return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const td = Buffer.from(type, 'ascii');
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([td, data])));
	return Buffer.concat([len, td, data, crc]);
}
// rgba: Buffer of w*h*4, NOT premultiplied
function encodePNG(w, h, rgba) {
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 4 + 1)] = 0;
		rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
	}
	return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- ICO (PNG-compressed entries)
function encodeICO(entries) { // entries: [{size, png: Buffer}]
	const n = entries.length;
	const head = Buffer.alloc(6 + n * 16);
	head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(n, 4);
	let off = 6 + n * 16;
	entries.forEach((e, i) => {
		const o = 6 + i * 16;
		head[o] = e.size >= 256 ? 0 : e.size;
		head[o + 1] = e.size >= 256 ? 0 : e.size;
		head[o + 2] = 0; head[o + 3] = 0;
		head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
		head.writeUInt32LE(e.png.length, o + 8); head.writeUInt32LE(off, o + 12);
		off += e.png.length;
	});
	return Buffer.concat([head, ...entries.map(e => e.png)]);
}

// ---------------------------------------------------------------- ICNS (PNG data in entries)
function encodeICNS(entries) { // entries: [{type: 'icp4', png: Buffer}]
	const parts = [];
	let total = 8;
	for (const e of entries) {
		const h = Buffer.alloc(8);
		h.write(e.type, 0, 'ascii'); h.writeUInt32BE(8 + e.png.length, 4);
		parts.push(h, e.png);
		total += 8 + e.png.length;
	}
	const head = Buffer.alloc(8);
	head.write('icns', 0, 'ascii'); head.writeUInt32BE(total, 4);
	return Buffer.concat([head, ...parts]);
}

// ---------------------------------------------------------------- BMP (uncompressed 24/32-bit)
function encodeBMP(w, h, rgba, bpp) {
	const rowSize = bpp === 24 ? ((w * 3 + 3) & ~3) : w * 4;
	const imgSize = rowSize * h;
	const buf = Buffer.alloc(54 + imgSize);
	buf.write('BM', 0);
	buf.writeUInt32LE(54 + imgSize, 2);
	buf.writeUInt32LE(54, 10);
	buf.writeUInt32LE(40, 14);
	buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
	buf.writeUInt16LE(1, 26); buf.writeUInt16LE(bpp, 28);
	buf.writeUInt32LE(0, 30);
	buf.writeUInt32LE(imgSize, 34);
	buf.writeInt32LE(3779, 38); buf.writeInt32LE(3779, 42); // ~96 dpi
	for (let y = 0; y < h; y++) {
		const srcY = h - 1 - y; // bottom-up
		for (let x = 0; x < w; x++) {
			const s = (srcY * w + x) * 4, d = 54 + y * rowSize + x * (bpp / 8);
			buf[d] = rgba[s + 2]; buf[d + 1] = rgba[s + 1]; buf[d + 2] = rgba[s]; // BGR
			if (bpp === 32) buf[d + 3] = rgba[s + 3];
		}
	}
	return buf;
}

// ---------------------------------------------------------------- XPM (for resources/linux/rpm/code.xpm)
function encodeXPM(w, h, rgba) {
	const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()-_=+[]{}|;:,.<>?/`~';
	const code = i => chars[Math.floor(i / 92)] + chars[i % 92];
	const pal = new Map();
	const rows = [];
	for (let y = 0; y < h; y++) {
		let row = '';
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			let key;
			if (rgba[i + 3] < 128) key = 'none';
			else {
				const r = Math.round(rgba[i] / 51) * 51, g = Math.round(rgba[i + 1] / 51) * 51, b = Math.round(rgba[i + 2] / 51) * 51;
				key = r + ',' + g + ',' + b;
			}
			if (!pal.has(key)) pal.set(key, pal.size);
			row += code(pal.get(key));
		}
		rows.push('"' + row + '",');
	}
	const keys = [...pal.keys()];
	const header = '"' + w + ' ' + h + ' ' + keys.length + ' 2",';
	const colors = keys.map((k, i) =>
		k === 'none'
			? '"' + code(i) + ' c None",'
			: '"' + code(i) + ' c #' + k.split(',').map(v => Number(v).toString(16).padStart(2, '0')).join('') + '",');
	return '/* XPM - Sunday app icon (generated by branding/gen-assets.mjs) */\nstatic char * sunday_xpm[] = {\n' +
		header + '\n' + colors.join('\n') + '\n' + rows.join('\n') + '\n};\n';
}

// ---------------------------------------------------------------- SDF art: "S" mark on dark rounded square
// Angles in math convention (y-up); canvas is y-down, converted in arcDist.
// A geometric "S" from two circular arcs that meet tangentially at the middle (M).
// Angles use y-down convention: phi = atan2(dy, dx), increasing = visually clockwise.
// Top arc:    center (0.50, 0.37), phi from -270° (= M, bottom of top bowl) to -30° (top-right terminal)
// Bottom arc: center (0.50, 0.63), phi from -90° (= M, top of bottom bowl) to 150° (bottom-left terminal)
// Both arcs pass through M = (0.5, 0.5) with a horizontal tangent -> smooth S spine.
const S_TOP = { cx: 0.5, cy: 0.37, a0: -270 * D2R, a1: -30 * D2R };
const S_BOT = { cx: 0.5, cy: 0.63, a0: -90 * D2R, a1: 150 * D2R };
const S_R = 0.14, S_HW = 0.042; // radius, stroke half-width (fractions of box)
const BG_TOP = [43, 47, 110], BG_BOT = [16, 18, 46];
const S_TOP_C = [255, 217, 122], S_BOT_C = [242, 165, 42];

function arcDist(px, py, cx, cy, r, a0, a1) {
	// y-down angle convention: phi = atan2(dy, dx), increasing = visually clockwise
	let ang = Math.atan2(py - cy, px - cx);
	while (ang < a0) ang += TAU;
	while (ang >= a0 + TAU) ang -= TAU;
	if (ang > a1) {
		const ex = cx + r * Math.cos(a1), ey = cy + r * Math.sin(a1);
		return Math.hypot(px - ex, py - ey);
	}
	return Math.abs(Math.hypot(px - cx, py - cy) - r);
}

function roundedBoxSDF(px, py, cx, cy, half, rad) {
	const qx = Math.abs(px - cx) - (half - rad), qy = Math.abs(py - cy) - (half - rad);
	const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
	return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - rad;
}

function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

// Render the app mark at `size` px, supersampled by ss. Returns {data: Buffer RGBA (premultiplied), w, h}.
function renderMark(size, ss) {
	const W = size * ss, H = size * ss;
	const out = Buffer.alloc(W * H * 4);
	const cx = 0.5 * W, cy = 0.5 * H, half = 0.5 * W, rad = 0.225 * W;
	const tcx = S_TOP.cx * W, tcyy = S_TOP.cy * H, bcx = S_BOT.cx * W, bcyy = S_BOT.cy * H;
	const rr = S_R * W, hw = S_HW * W;
	const sY0 = 0.23 * H, sY1 = 0.77 * H;
	const aa = 1.0;
	for (let y = 0; y < H; y++) {
		const yc = y + 0.5;
		const tBg = yc / H;
		const bg = lerp3(BG_TOP, BG_BOT, tBg);
		for (let x = 0; x < W; x++) {
			const xc = x + 0.5;
			const dBox = roundedBoxSDF(xc, yc, cx, cy, half, rad);
			const bgCov = Math.min(1, Math.max(0, 0.5 - dBox / (2 * aa)));
			if (bgCov <= 0) continue;
			const dS = Math.min(
				arcDist(xc, yc, tcx, tcyy, rr, S_TOP.a0, S_TOP.a1),
				arcDist(xc, yc, bcx, bcyy, rr, S_BOT.a0, S_BOT.a1));
			const sCov = Math.min(1, Math.max(0, 0.5 - (dS - hw) / (2 * aa)));
			let r = bg[0], g = bg[1], b = bg[2];
			if (sCov > 0) {
				const st = Math.min(1, Math.max(0, (yc - sY0) / (sY1 - sY0)));
				const sc = lerp3(S_TOP_C, S_BOT_C, st);
				r += (sc[0] - r) * sCov; g += (sc[1] - g) * sCov; b += (sc[2] - b) * sCov;
			}
			const i = (y * W + x) * 4;
			out[i] = r * bgCov; out[i + 1] = g * bgCov; out[i + 2] = b * bgCov; out[i + 3] = bgCov * 255;
		}
	}
	const ds = downsample(out, W, H, size, size);
	return { data: ds, w: size, h: size }; // premultiplied
}

// Render an Inno Setup bitmap: full-bleed dark gradient + centered mark.
function renderInno(w, h) {
	const ss = 2, W = w * ss, H = h * ss;
	const out = Buffer.alloc(W * H * 4);
	const m = Math.min(W, H) * 0.72; // mark box
	const ox = (W - m) / 2, oy = (H - m) / 2;
	const rad = 0.225 * m, hw = S_HW * m, rr = S_R * m;
	for (let y = 0; y < H; y++) {
		const yc = y + 0.5;
		const bg = lerp3(BG_TOP, BG_BOT, yc / H);
		for (let x = 0; x < W; x++) {
			const xc = x + 0.5;
			const lx = xc - ox, ly = yc - oy; // mark-local
			let r = bg[0], g = bg[1], b = bg[2], a = 1;
			if (lx >= 0 && ly >= 0 && lx < m && ly < m) {
				const dBox = roundedBoxSDF(lx, ly, m / 2, m / 2, m / 2, rad);
				const bgCov = Math.min(1, Math.max(0, 0.5 - dBox / 2));
				if (bgCov > 0) {
					const dS = Math.min(
						arcDist(lx, ly, S_TOP.cx * m, S_TOP.cy * m, rr, S_TOP.a0, S_TOP.a1),
						arcDist(lx, ly, S_BOT.cx * m, S_BOT.cy * m, rr, S_BOT.a0, S_BOT.a1));
					const sCov = Math.min(1, Math.max(0, 0.5 - (dS - hw) / 2));
					const st = Math.min(1, Math.max(0, (ly - 0.23 * m) / (0.54 * m)));
					const sc = lerp3(S_TOP_C, S_BOT_C, st);
					const mc = lerp3(BG_TOP, BG_BOT, ly / m);
					let mr = mc[0], mg = mc[1], mb = mc[2];
					if (sCov > 0) { mr += (sc[0] - mr) * sCov; mg += (sc[1] - mg) * sCov; mb += (sc[2] - mb) * sCov; }
					r = bg[0] + (mr - bg[0]) * bgCov; g = bg[1] + (mg - bg[1]) * bgCov; b = bg[2] + (mb - bg[2]) * bgCov;
				}
			}
			const i = (y * W + x) * 4;
			out[i] = r * a; out[i + 1] = g * a; out[i + 2] = b * a; out[i + 3] = 255;
		}
	}
	return { data: downsample(out, W, H, w, h), w, h };
}

// Box downsample on premultiplied RGBA, then unpremultiply.
function downsample(src, sw, sh, dw, dh) {
	const out = Buffer.alloc(dw * dh * 4);
	const rx = sw / dw, ry = sh / dh;
	for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
		let r = 0, g = 0, b = 0, a = 0, n = 0;
		const x0 = Math.floor(x * rx), x1 = Math.min(sw, Math.ceil((x + 1) * rx));
		const y0 = Math.floor(y * ry), y1 = Math.min(sh, Math.ceil((y + 1) * ry));
		for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
			const i = (sy * sw + sx) * 4;
			r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
		}
		const i = (y * dw + x) * 4;
		if (a > 0.5) { out[i] = r / a * 255; out[i + 1] = g / a * 255; out[i + 2] = b / a * 255; }
		out[i + 3] = a / n;
	}
	return out;
}

const unpremult = (pm, w, h) => {
	const out = Buffer.alloc(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const a = pm[i * 4 + 3] / 255;
		out[i * 4] = a > 0 ? Math.min(255, pm[i * 4] / a) : 0;
		out[i * 4 + 1] = a > 0 ? Math.min(255, pm[i * 4 + 1] / a) : 0;
		out[i * 4 + 2] = a > 0 ? Math.min(255, pm[i * 4 + 2] / a) : 0;
		out[i * 4 + 3] = pm[i * 4 + 3];
	}
	return out;
};

// ---------------------------------------------------------------- main
mkdirSync(ROOT, { recursive: true });
const pngs = {};
for (const s of [16, 32, 48, 64, 128, 256, 512, 1024]) {
	const m = renderMark(s, 2);
	pngs[s] = encodePNG(s, s, unpremult(m.data, s, s));
	console.log('rendered', s);
}

// 1. branding/ PNG set + about logo
for (const s of [16, 32, 48, 128, 256, 512]) writeFileSync(join(ROOT, 'sunday-' + s + '.png'), pngs[s]);
writeFileSync(join(ROOT, 'sunday-about.png'), pngs[512]);

// 2. ICO (Windows): 16/32/48/256, PNG-compressed entries
const ico = encodeICO([16, 32, 48, 256].map(s => ({ size: s, png: pngs[s] })));
writeFileSync(join(ROOT, 'sunday.ico'), ico);

// 3. ICNS (macOS)
const icns = encodeICNS([
	{ type: 'icp4', png: pngs[16] },
	{ type: 'ic05', png: pngs[32] },
	{ type: 'icp6', png: pngs[64] },
	{ type: 'ic07', png: pngs[128] },
	{ type: 'ic08', png: pngs[256] },
	{ type: 'ic09', png: pngs[512] },
	{ type: 'ic10', png: pngs[1024] },
]);
writeFileSync(join(ROOT, 'sunday.icns'), icns);

// 4. NSIS bitmaps at canonical sizes (branding copies)
const innoHdr = renderInno(150, 57);
writeFileSync(join(ROOT, 'nsis-header-150x57.bmp'), encodeBMP(150, 57, unpremult(innoHdr.data, 150, 57), 24));
const innoWiz = renderInno(164, 314);
writeFileSync(join(ROOT, 'nsis-wizard-164x314.bmp'), encodeBMP(164, 314, unpremult(innoWiz.data, 164, 314), 24));

// 5. Copy into the vscode/ tree (P-002) — keep upstream filenames
copyFileSync(join(ROOT, 'sunday.ico'), join(VSCODE, 'resources/win32/code.ico'));
copyFileSync(join(ROOT, 'sunday.icns'), join(VSCODE, 'resources/darwin/code.icns'));
copyFileSync(join(ROOT, 'sunday-256.png'), join(VSCODE, 'resources/linux/code.png'));
const m150 = renderMark(150, 2);
writeFileSync(join(VSCODE, 'resources/win32/code_150x150.png'), encodePNG(150, 150, unpremult(m150.data, 150, 150)));
const m70 = renderMark(70, 2);
writeFileSync(join(VSCODE, 'resources/win32/code_70x70.png'), encodePNG(70, 70, unpremult(m70.data, 70, 70)));
const m48 = renderMark(48, 2);
writeFileSync(join(VSCODE, 'resources/linux/rpm/code.xpm'), encodeXPM(48, 48, unpremult(m48.data, 48, 48)));

// Inno Setup DPI variants — same dimensions/bit-depth as the originals
const innoSizes = [
	['inno-big-100', 164, 314, 24], ['inno-big-125', 192, 386, 24], ['inno-big-150', 246, 459, 24],
	['inno-big-175', 273, 556, 24], ['inno-big-200', 328, 604, 24], ['inno-big-225', 355, 700, 24],
	['inno-big-250', 410, 797, 32],
	['inno-small-100', 55, 55, 24], ['inno-small-125', 64, 68, 24], ['inno-small-150', 83, 80, 24],
	['inno-small-175', 92, 97, 24], ['inno-small-200', 110, 106, 24], ['inno-small-225', 119, 123, 24],
	['inno-small-250', 138, 140, 24],
];
for (const [name, w, h, bpp] of innoSizes) {
	const r = renderInno(w, h);
	writeFileSync(join(VSCODE, 'resources/win32', name + '.bmp'), encodeBMP(w, h, unpremult(r.data, w, h), bpp));
	console.log('inno', name);
}
console.log('done');
