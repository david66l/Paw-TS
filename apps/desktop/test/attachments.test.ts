import { expect, test } from "bun:test";
import { desktopAttachments } from "../agent-host/paw-next-attachments";
import { readDesktopFile } from "../src/agent/attachments";

test("desktop attachments validate binary content, count, sizes and MIME before model dispatch", async () => {
  const text = {
    id: "file",
    name: "source.ts",
    type: "file",
    mimeType: "text/plain",
    content: "const x = 1;",
  };
  expect(desktopAttachments([text])?.[0]?.type).toBe("file");
  expect(() =>
    desktopAttachments([{ ...text, content: "x".repeat(256 * 1024 + 1) }]),
  ).toThrow();
  expect(() => desktopAttachments([text, text])).toThrow();
  expect(() =>
    desktopAttachments([
      {
        ...text,
        type: "image",
        mimeType: "image/png",
        content: "data:image/png;base64,dGV4dA==",
      },
    ]),
  ).toThrow();
  expect(() =>
    desktopAttachments(
      Array.from({ length: 5 }, (_, i) => ({ ...text, id: `f${i}` })),
    ),
  ).toThrow();
  await expect(
    readDesktopFile(new File([new Uint8Array([0, 255])], "binary.bin")),
  ).rejects.toThrow();
  await expect(readDesktopFile(new File(["pdf"], "notes.pdf"))).rejects.toThrow(
    "暂不支持",
  );
  expect((await readDesktopFile(new File(["你好"], "notes.txt"))).content).toBe(
    "你好",
  );
});
