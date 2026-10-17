// Shrinks a photo in the browser before it's attached. A 5 MB phone picture would otherwise blow past
// the server's request limit (Vercel allows about 4.5 MB per request) and some AI providers cap inline
// images at roughly 180 KB — so everything is brought down to a size every provider accepts.

const MAX_BASE64_CHARS = 170_000;
const SIZES = [1280, 1024, 800, 640, 480, 360];
const QUALITIES = [0.82, 0.7, 0.55];
const PASS_THROUGH_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(blob);
  });
}

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close && bitmap.close() };
    } catch {
      // fall through to the <img> route, which handles a few formats createImageBitmap doesn't
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function toJpegBlob(decoded, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // JPEG has no transparency — a see-through PNG would turn black without this
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(decoded.source, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve({ blob, width, height }) : reject(new Error("encode failed"))), "image/jpeg", quality);
  });
}

const base64Length = (bytes) => Math.ceil(bytes / 3) * 4;

// → { mediaType, data (base64), name, width?, height?, shrunk }. Throws an Error with a plain message.
export async function prepareImage(file) {
  if (!file || !String(file.type).startsWith("image/")) throw new Error("That file isn't an image. Attach a JPEG, PNG, GIF or WebP picture.");

  // Already small and in a format every provider reads? Send it untouched.
  if (PASS_THROUGH_TYPES.has(file.type) && base64Length(file.size) <= MAX_BASE64_CHARS) {
    return { mediaType: file.type, data: await blobToBase64(file), name: file.name, shrunk: false };
  }

  let decoded;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error(`Couldn't open that image${file.type ? ` (${file.type})` : ""}. Try a JPEG or PNG — photos saved as HEIC may need converting first.`);
  }

  try {
    let best = null;
    for (const size of SIZES) {
      for (const quality of QUALITIES) {
        const out = await toJpegBlob(decoded, size, quality);
        best = out;
        if (base64Length(out.blob.size) <= MAX_BASE64_CHARS) {
          return { mediaType: "image/jpeg", data: await blobToBase64(out.blob), name: file.name, width: out.width, height: out.height, shrunk: true };
        }
      }
    }
    // Nothing got under the limit (extremely unlikely) — send the smallest attempt and let the server say if it's still too big.
    return { mediaType: "image/jpeg", data: await blobToBase64(best.blob), name: file.name, width: best.width, height: best.height, shrunk: true };
  } catch {
    throw new Error("Couldn't shrink that image. Try a different one.");
  } finally {
    decoded.release();
  }
}
