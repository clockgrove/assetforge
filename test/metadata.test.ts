import assert from "node:assert/strict";
import test from "node:test";
import { createRaster, encodePng, decodePng, opaqueBox } from "../src/image/raster.ts";
import { encodeWebpLossless } from "../src/image/webp.ts";
import { decodeWebpLossless } from "./fixtures/webp-decode.ts";
import {
  DIGITAL_SOURCE_TYPES as types,
  combineDigitalSourceTypes,
  embedDigitalSourceType,
  readDigitalSourceType,
  metadataStep,
} from "../src/metadata.ts";

function chunks(bytes: Uint8Array, png = false) {
  const b = Buffer.from(bytes);
  const out: { type: string; data: Buffer }[] = [];
  for (let i = png ? 8 : 12; i < b.length;) {
    const length = png ? b.readUInt32BE(i) : b.readUInt32LE(i + 4);
    out.push({
      type: b.toString("ascii", i + (png ? 4 : 0), i + (png ? 8 : 4)),
      data: b.subarray(i + 8, i + 8 + length),
    });
    i += length + (png ? 12 : 8 + (length & 1));
  }
  return out;
}
const raster = createRaster(3, 2);
raster.data.set([200, 80, 42, 255, 0, 0, 0, 0, 12, 34, 56, 128]);

for (const value of Object.values(types)) {
  test(`PNG iTXt XMP round-trip preserves pixels: ${value.split("/").at(-1)}`, () => {
    const original = encodePng(raster);
    const encoded = embedDigitalSourceType(original, "image/png", value);
    assert.equal(readDigitalSourceType(encoded, "image/png"), value);
    const metadata = chunks(encoded, true).filter((c) => c.type === "iTXt");
    assert.equal(metadata.length, 1);
    const orderedChunks = chunks(encoded, true).map((c) => c.type);
    assert.ok(orderedChunks.indexOf("iTXt") < orderedChunks.indexOf("IDAT"));
    assert.ok(metadata[0]!.data.subarray(0, 22).equals(Buffer.from("XML:com.adobe.xmp\0\0\0\0\0")));
    assert.match(
      metadata[0]!.data.toString(),
      /xmlns:Iptc4xmpExt="http:\/\/iptc.org\/std\/Iptc4xmpExt\/2008-02-29\/"/,
    );
    assert.ok(
      metadata[0]!.data
        .toString()
        .includes(`<Iptc4xmpExt:DigitalSourceType>${value}</Iptc4xmpExt:DigitalSourceType>`),
    );
    assert.deepEqual(decodePng(encoded), raster);
    assert.deepEqual(opaqueBox(decodePng(encoded)), opaqueBox(raster));
    assert.deepEqual(embedDigitalSourceType(encoded, "image/png", value), encoded);
    assert.deepEqual(
      chunks(encoded, true).filter((c) => c.type !== "iTXt"),
      chunks(original, true),
    );
  });
}

test("JPEG XMP reader skips unrelated APP1 and stops before scan data", () => {
  const segment = (payload: Buffer) => {
    const header = Buffer.from([0xff, 0xe1, 0, 0]);
    header.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([header, payload]);
  };
  const xml = `<rdf:Description xmlns:i="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" i:DigitalSourceType="${types.generated}"/>`;
  const xmp = segment(Buffer.from(`http://ns.adobe.com/xap/1.0/\0${xml}`));
  const soi = Buffer.from([0xff, 0xd8]);
  const unrelated = segment(Buffer.from(`Exif\0\0${xml}`));
  assert.equal(
    readDigitalSourceType(
      Buffer.concat([soi, unrelated, xmp, Buffer.from([0xff, 0xd9])]),
      "image/jpeg",
    ),
    types.generated,
  );
  assert.equal(
    readDigitalSourceType(
      Buffer.concat([soi, unrelated, Buffer.from([0xff, 0xda]), xmp]),
      "image/jpeg",
    ),
    undefined,
  );
  for (const tail of [[0xff], [0xff, 0xe1, 0], [0xff, 0xe1, 0, 1], [0xff, 0xe1, 0, 20, 0]]) {
    assert.throws(
      () => readDigitalSourceType(Buffer.concat([soi, Buffer.from(tail)]), "image/jpeg"),
      /JPEG/,
    );
  }
});

test("WebP uses extended container with XMP flag and unchanged VP8L pixels", () => {
  const original = encodeWebpLossless(raster);
  const encoded = embedDigitalSourceType(original, "image/webp", types.generated);
  const parts = chunks(encoded);
  assert.deepEqual(
    parts.map((c) => c.type),
    ["VP8X", "VP8L", "XMP "],
  );
  const header = parts[0]!.data;
  assert.equal(header[0]! & 4, 4);
  assert.equal(header.readUIntLE(4, 3) + 1, raster.width);
  assert.equal(header.readUIntLE(7, 3) + 1, raster.height);
  assert.equal(Buffer.from(encoded).readUInt32LE(4), encoded.length - 8);
  assert.deepEqual(parts[1]!.data, chunks(original)[0]!.data);
  // The existing test decoder accepts the simple VP8L subset, so decode the unchanged payload.
  assert.deepEqual(decodeWebpLossless(original), raster);
  assert.equal(readDigitalSourceType(encoded, "image/webp"), types.generated);
  assert.ok(parts[2]!.data.toString().includes(types.generated));
  assert.deepEqual(embedDigitalSourceType(encoded, "image/webp", types.generated), encoded);
  const changed = embedDigitalSourceType(encoded, "image/webp", types.composite);
  assert.equal(chunks(changed).filter((c) => c.type === "XMP ").length, 1);
  assert.equal(readDigitalSourceType(changed, "image/webp"), types.composite);
});

test("metadata replacement preserves unrelated XMP", () => {
  const first = embedDigitalSourceType(encodePng(raster), "image/png", types.generated);
  // Build a valid PNG with an unrelated property using the existing chunk's CRC algorithm via codec.
  const webp = Buffer.from(
    embedDigitalSourceType(encodeWebpLossless(raster), "image/webp", types.generated),
  );
  const parts = chunks(webp);
  const xml = parts[2]!.data
    .toString()
    .replace(
      "</rdf:RDF>",
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:source="synthetic"/></rdf:RDF>',
    );
  const payload = Buffer.from(xml);
  const chunk = Buffer.alloc(8 + payload.length + (payload.length & 1));
  chunk.write("XMP ");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  const prior = webp.subarray(
    0,
    webp.length - parts[2]!.data.length - 8 - (parts[2]!.data.length & 1),
  );
  const custom = Buffer.concat([prior, chunk]);
  custom.writeUInt32LE(custom.length - 8, 4);
  const updated = embedDigitalSourceType(custom, "image/webp", types.composite);
  assert.ok(
    chunks(updated)
      .find((c) => c.type === "XMP ")!
      .data.toString()
      .includes('dc:source="synthetic"'),
  );
  assert.equal(readDigitalSourceType(updated, "image/webp"), types.composite);
  assert.equal(
    readDigitalSourceType(embedDigitalSourceType(first, "image/png", types.human), "image/png"),
    types.human,
  );
});

test("glTF attaches an XMP JSON-LD packet to the asset and preserves other packets", () => {
  const document = {
    asset: { version: "2.0" },
    nodes: [{ name: "synthetic" }],
    extensionsUsed: ["OTHER"],
    extensions: {
      OTHER: { value: true },
      KHR_xmp_json_ld: {
        packets: [
          {
            "@context": { dc: "http://purl.org/dc/elements/1.1/" },
            "dc:source": "keep",
            "Iptc4xmpExt:DigitalSourceType": types.human,
          },
        ],
      },
    },
  };
  assert.equal(
    readDigitalSourceType(Buffer.from(JSON.stringify(document)), "model/gltf+json"),
    undefined,
  );
  const encoded = embedDigitalSourceType(
    Buffer.from(JSON.stringify(document)),
    "model/gltf+json",
    types.generated,
  );
  const actual = JSON.parse(Buffer.from(encoded).toString());
  assert.deepEqual(actual.extensionsUsed, ["OTHER", "KHR_xmp_json_ld"]);
  assert.deepEqual(actual.nodes, document.nodes);
  assert.deepEqual(
    actual.extensions.KHR_xmp_json_ld.packets[0],
    document.extensions.KHR_xmp_json_ld.packets[0],
  );
  assert.equal(actual.asset.extensions.KHR_xmp_json_ld.packet, 1);
  assert.deepEqual(actual.extensions.KHR_xmp_json_ld.packets[1], {
    "@id": "",
    "@context": { Iptc4xmpExt: "http://iptc.org/std/Iptc4xmpExt/2008-02-29/" },
    "Iptc4xmpExt:DigitalSourceType": types.generated,
  });
  assert.equal(readDigitalSourceType(encoded, "model/gltf+json"), types.generated);
  assert.deepEqual(embedDigitalSourceType(encoded, "model/gltf+json", types.generated), encoded);
});

test("origin mapping and recorded embedding step are deterministic", () => {
  assert.equal(combineDigitalSourceTypes([types.generated]), types.generated);
  assert.equal(combineDigitalSourceTypes([types.generated, types.human]), types.composite);
  assert.equal(combineDigitalSourceTypes([types.composite, types.generated]), types.composite);
  assert.equal(combineDigitalSourceTypes([types.human]), types.human);
  const step = metadataStep(types.generated, ["pixels"]);
  assert.equal(step.op, "embed-digital-source-type");
  assert.deepEqual(step.inputs, step.outputs);
  assert.deepEqual(step.params, { digitalSourceType: types.generated });
});

test("glTF does not alter a packet shared by asset and mesh", () => {
  const doc = {
    asset: { version: "2.0", extensions: { KHR_xmp_json_ld: { packet: 0 } } },
    meshes: [{ primitives: [], extensions: { KHR_xmp_json_ld: { packet: 0 } } }],
    extensions: { KHR_xmp_json_ld: { packets: [{ "@context": {}, "dc:source": "original" }] } },
  };
  const encoded = embedDigitalSourceType(
    Buffer.from(JSON.stringify(doc)),
    "model/gltf+json",
    types.composite,
  );
  const actual = JSON.parse(Buffer.from(encoded).toString());
  assert.equal(actual.asset.extensions.KHR_xmp_json_ld.packet, 1);
  assert.equal(actual.meshes[0].extensions.KHR_xmp_json_ld.packet, 0);
  assert.deepEqual(
    actual.extensions.KHR_xmp_json_ld.packets[0],
    doc.extensions.KHR_xmp_json_ld.packets[0],
  );
  assert.equal(actual.extensions.KHR_xmp_json_ld.packets[1]["dc:source"], "original");
  assert.deepEqual(embedDigitalSourceType(encoded, "model/gltf+json", types.composite), encoded);
});
