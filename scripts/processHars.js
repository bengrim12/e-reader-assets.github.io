import fs from "fs";
import path from "path";
import sharp from "sharp";

const INFO_JSON = process.env.INFO_JSON || 'info.json';
const IMPORT_DIR = process.env.IMPORT_DIR || 'hars';
const EXPORT_DIR = process.env.EXPORT_DIR || 'build';
const RELATIVE_URL = process.env.RELATIVE_URL || '/e-reader-assets.github.io';

// mapperfactoryimpl -------------------------------------
export const MapperFactoryImpl = {
    get: (har) => {
        if (har.log.pages[0].title.includes("webtoon.xyz")) {
            return WebtoonXYZMapper;
        }
        if (har.log.pages[0].title.includes("nhentai.net")) {
            return NHentaiMapper;
        }
        throw new Error("Missing Mapper for given Har");
    },
};

const WebtoonXYZMapper = {
    filter(e) {
        return (
            !!e.request.url.match("webtoon.xyz/manga_.*/((\\d+)\\.jpg)$")
        );
    },
    sort(e1, e2) {
        return (
            Number(e1.request.url.match("webtoon.xyz/manga_.*/((\\d+)\\.jpg)$")[2]) -
            Number(e2.request.url.match("webtoon.xyz/manga_.*/((\\d+)\\.jpg)$")[2])
        );
    },
    resolveChapter(EXPORT_DIR, page) {
        const [_, title, chapter] = page.title.match("webtoon.xyz/read/(.*)/chapter-(.*)/$");

        const outDir = `${EXPORT_DIR}/${title}/${formatWithZeros(100, Number(chapter))}/`; // out/orv/15/
        if (!fs.existsSync(outDir)) {
            console.log(`creating directory ${outDir}`);
            fs.mkdirSync(outDir, {recursive: true});
        }

        return outDir; // out/orv/15/
    }
};

const NHENTAI_URL_PATTERN = "nhentai.net/galleries/(\\d+)/(\\d+)";
const NHentaiMapper = {
    filter(e) {
        return (
            !!e.request.url.match(NHENTAI_URL_PATTERN)
        )
    },
    sort(e1, e2) {
        // nhentai.net/galleries/3502515/12t.webp.webp <- dafuq?
        return (
            Number(e1.request.url.match(NHENTAI_URL_PATTERN)[2]) -
            Number(e2.request.url.match(NHENTAI_URL_PATTERN)[2])
        );
    },
    resolveChapter(EXPORT_DIR, page, e) {
        const title = page.title.match("nhentai.net/g/(\\d+)/")[1];
        const storyPage = e.request.url.match(NHENTAI_URL_PATTERN)[2];

        const outDir = `${EXPORT_DIR}/${title}/000`; // out/567649/000
        if (!fs.existsSync(outDir)) {
            console.log(`creating directory ${outDir}`);
            fs.mkdirSync(outDir, {recursive: true});
        }

        return `${outDir}/${formatWithZeros(100, Number(storyPage))}-`; // out/567649/000/15-
    }
};

// main -----------------------------------
async function main() {
    const harFiles = readHarFilesSync(IMPORT_DIR);
    console.log("Har files found: ", harFiles);

    if (!harFiles.length) {
        console.log("No har files found.");
        return;
    }

    const imagesByChaptersOfHar = [];

    for (const har of harFiles) {
        console.log(`sorting entries for story ${har.log.pages[0].title}`);
        const mapper = MapperFactoryImpl.get(har);

        const pageMap = har.log.pages.reduce((obj, page) => Object.assign(obj, {[page.id]: page}), {});

        const imagesByChapters = har.log.entries.reduce((obj, e) => {
            if (mapper.filter(e)) {
                const chapter = mapper.resolveChapter(EXPORT_DIR, pageMap[e.pageref], e); // creates directory
                if (!obj[chapter]) {
                    obj[chapter] = [e];
                } else {
                    obj[chapter].push(e);
                    obj[chapter].sort(mapper.sort);
                }
            }
            return obj;
        }, {});

        if (Object.entries(imagesByChapters).length === 0) {
            throw new Error(`No images extracted for har ${har.log.pages[0].title}`);
        }

        imagesByChaptersOfHar.push(imagesByChapters);
    }

    for (const imagesByChapters of imagesByChaptersOfHar) {
        console.log(`start converting images to ${Object.keys(imagesByChapters)[0]}`);
        for (const [outDir, images] of Object.entries(imagesByChapters)) {
            console.log(`export images to ${outDir}`); // out/567649/15- / out/orv/15/
            const imgs = await cutAndExport(images, outDir, {
                tolerance: 50,
                minSegmentHeight: 100,
            });
            console.log(`exported images: ${JSON.stringify(imgs, null, 4)}`);
        }
    }

    const out = await generateInfoJson(EXPORT_DIR); // staticUrl
    console.log(`exported out: ${JSON.stringify(out)}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

// listFiles ---------------------------------------
export async function generateInfoJson(dirPath) {
    const files = {};
    if (fs.existsSync(INFO_JSON)) {
        console.log('merge existing info.json');
        Object.assign(files, JSON.parse(fs.readFileSync(INFO_JSON).toString()));
    }
    const root = path.resolve(dirPath);
    await walk(root, dirPath, files);

    const outPath = path.join(root, INFO_JSON);
    const infoJson = JSON.stringify(files, null, 4);
    console.log(`save info json: ${infoJson.length}`);
    await fs.writeFile(outPath, infoJson, 'utf8', console.error);
    return outPath;
}

async function walk(current, dirPath, files) {
    const entries = fs.readdirSync(current, {withFileTypes: true});
    for (const ent of entries) {
        const full = path.join(current, ent.name);
        if (ent.isDirectory()) {
            await walk(full, dirPath, files);
        } else if (ent.isFile() || ent.isSymbolicLink()) {
            const [story, chapter, fileName] = path.relative(dirPath, full).split(path.sep);

            if (story === 'info.json') {
                continue;
            }

            if (!files[story]) {
                files[story] = {};
            }

            if (!files[story].chapters) {
                files[story].chapters = {};
            }

            if (!files[story].chapters[chapter]) {
                files[story].chapters[chapter] = [];
            }

            const imagePath = `${RELATIVE_URL}/${story}/${chapter}/${fileName}`;
            if (!files[story].chapters[chapter].includes(imagePath)) {
                files[story].chapters[chapter].push(imagePath);
            }
            files[story].title = story;
        }
    }
}

// readHarFilesSync -----------------------------------
export function readHarFilesSync(importDir) {
    return fs.readdirSync(importDir)
        .filter(file => file.endsWith(".har"))
        .map((file) => {
                const buffer = fs.readFileSync(`${importDir}/${file}`);
                return JSON.parse(buffer.toString());
            }
        );
}

// splitting --------------------------------------------
export async function cutAndExport(base64Images, outDir, opts) {
    let compositeWidth = 0;
    let compositeHeight = 0;
    const layers = [];
    for (let i = 0; i < base64Images.length; i++) {
        const buffer = Buffer.from(base64Images[i].response.content.text, 'base64');

        const layer = {input: buffer, left: 0, top: compositeHeight};
        layers.push(layer);

        const meta = await sharp(buffer).metadata();
        compositeWidth = Math.max(compositeWidth, meta.width); // only needed once, but whatever
        compositeHeight += meta.height;
    }

    // Vertical composition
    const composite = sharp({
        create: {
            width: compositeWidth,
            height: compositeHeight,
            channels: 4,
            background: 'white'
        }
    });
    const bigImage = await composite.composite(layers).png().toBuffer(); // png, because for jpg too large
    const {data, info} = await sharp(bigImage).raw().toBuffer({resolveWithObject: true});

    // slice and save images
    const exportedImages = [];
    let imageCount = 0;
    let lastRowIdx = 0;
    let lastRowSameColor = rowHasSameColor(info, data, lastRowIdx, opts.tolerance);
    for (let rowIdx = 1; rowIdx <= info.height; rowIdx++) {
        const currentRowSameColor = rowHasSameColor(info, data, rowIdx, opts.tolerance);
        if (
            currentRowSameColor !== lastRowSameColor ||
            rowIdx === info.height // include last row as well
        ) {
            if ((rowIdx - lastRowIdx) >= opts.minSegmentHeight) {
                const fileName = `${outDir}${formatWithZeros(100, imageCount)}.jpg`; // out/567649/15
                await sharp(bigImage)
                    .extract({left: 0, width: info.width, top: lastRowIdx, height: rowIdx - lastRowIdx})
                    .jpeg()
                    .toFile(fileName);
                exportedImages.push(fileName);
                imageCount++;
                lastRowIdx = rowIdx;
            }
            lastRowSameColor = currentRowSameColor;
        }
    }
    return exportedImages;
}

/**
 * tolerance up to ca 400-ish
 */
function rowHasSameColor({width, channels}, buffer, y, tolerance) {
    const startIdx = y * width * channels;
    const referencePx = {
        r: buffer[startIdx],
        g: buffer[startIdx + 1],
        b: buffer[startIdx + 2],
        a: buffer[startIdx + 3],
    };
    for (let x = 1; x < width; x++) {
        const currentIdx = startIdx + x * channels;
        const currentPx = {
            r: buffer[currentIdx],
            g: buffer[currentIdx + 1],
            b: buffer[currentIdx + 2],
            a: buffer[currentIdx + 3],
        };

        if (colorDistance(referencePx, currentPx) > tolerance) {
            return false;
        }
    }
    return true;
}

/**
 * Using the Euclidean distance to determine if two pixels are the same
 */
function colorDistance(a, b) {
    const dr = a.r - b.r; // 250 - 253 = 3
    const dg = a.g - b.g;
    const db = a.b - b.b;
    const da = a.a - b.a;
    return Math.sqrt(dr * dr + dg * dg + db * db + da * da);
}


// utils -------------------------
export function formatWithZeros(max, value) {
    const width = String(max).length;
    return String(value).padStart(width, "0");
}