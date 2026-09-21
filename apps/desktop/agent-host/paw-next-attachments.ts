import { createHash } from "node:crypto";
import type { InputAttachmentV1 } from "@paw/protocol";
import type { DesktopAttachment } from "../src/agent/attachments.js";

export function desktopAttachments(value: unknown): readonly InputAttachmentV1[] | undefined {
  if (value === undefined || (Array.isArray(value) && !value.length)) return undefined;
  if (!Array.isArray(value) || value.length > 4) throw new Error("每条消息最多 4 个附件。");
  let total = 0;
  const ids = new Set<string>();
  return value.map((raw) => {
    const a = raw as DesktopAttachment;
    if (
      !a ||
      typeof a.id !== "string" ||
      !/^[\w-]{1,100}$/.test(a.id) ||
      ids.has(a.id) ||
      typeof a.name !== "string" ||
      !a.name.trim() ||
      a.name.length > 255 ||
      [...a.name].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      typeof a.content !== "string" ||
      !["file", "image"].includes(a.type)
    )
      throw new Error("附件格式无效。");
    ids.add(a.id);
    if (a.type === "image") {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        a.content,
      );
      const base64 = match?.[2];
      if (!match || match[1] !== a.mimeType || base64 === undefined) {
        throw new Error("图片格式无效。");
      }
      const bytes = Buffer.from(base64, "base64");
      const valid =
        a.mimeType === "image/png"
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : a.mimeType === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : a.mimeType === "image/gif"
              ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
              : bytes.subarray(0, 4).toString() === "RIFF" &&
                bytes.subarray(8, 12).toString() === "WEBP";
      if (!valid || bytes.length > 2 * 1024 * 1024) throw new Error("图片内容无效或超过 2 MB。");
    } else if (Buffer.byteLength(a.content) > 256 * 1024 || a.content.includes("\0"))
      throw new Error("文本附件无效或超过 256 KB。");
    total += Buffer.byteLength(a.content);
    if (total > 6 * 1024 * 1024) throw new Error("本条消息附件总大小超过 6 MB。");
    return {
      attachmentId: a.id,
      type: a.type,
      name: a.name,
      mimeType: a.type === "file" ? "text/plain" : a.mimeType,
      content: {
        kind: "inline",
        value: a.content,
        hash: createHash("sha256").update(JSON.stringify(a.content)).digest("hex"),
      },
    };
  });
}
