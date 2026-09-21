export interface DesktopAttachment {
  id: string;
  name: string;
  type: "file" | "image";
  mimeType: string;
  content: string;
}
export const MAX_ATTACHMENTS = 4;
export async function readDesktopFile(file: File): Promise<DesktopAttachment> {
  const image = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type);
  if (file.size > (image ? 2 * 1024 * 1024 : 256 * 1024))
    throw new Error(`${file.name} 过大：图片最多 2 MB，文本最多 256 KB。`);
  const bytes = await file.arrayBuffer();
  let content: string;
  if (image) {
    const view = new Uint8Array(bytes);
    const chunks: string[] = [];
    for (let offset = 0; offset < view.length; offset += 32768)
      chunks.push(String.fromCharCode(...view.subarray(offset, offset + 32768)));
    content = `data:${file.type};base64,${btoa(chunks.join(""))}`;
  } else {
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|exe)$/i.test(file.name))
      throw new Error(`${file.name} 暂不支持，请使用 UTF-8 文本、代码或 PNG/JPEG/WebP/GIF 图片。`);
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${file.name} 不是 UTF-8 文本。`);
    }
    if (content.includes("\0")) throw new Error(`${file.name} 是二进制文件，无法作为文本读取。`);
  }
  return {
    id: crypto.randomUUID(),
    name: file.name,
    type: image ? "image" : "file",
    mimeType: image ? file.type : "text/plain",
    content,
  };
}
