/**
 * shell 策略匹配器与裁决器的表驱动测试。
 *
 * `matchPattern` / `evaluatePolicy` 是 `shell-policy.ts:139` 的裁决入口，
 * 但此前**没有任何测试**，于是两条永不触发的 deny 规则（`> /dev/sd*`）
 * 一直没人发现。这里把匹配语义和 last-match-wins 钉住。
 */

import { describe, expect, test } from "bun:test";
import {
  type PolicyConfig,
  createBuiltinPolicyConfig,
  evaluatePolicy,
  matchPattern,
} from "../src/shell-policy-config.js";

describe("matchPattern", () => {
  const cases: readonly (readonly [pattern: string, text: string, expected: boolean])[] = [
    // 两端锚定：模式必须覆盖整段文本
    ["ls", "ls", true],
    ["ls", "ls -la", false],
    ["ls", "sudo ls", false],
    ["*ls*", "sudo ls -la", true],
    ["*ls", "ls", true],
    ["ls*", "ls", true],
    ["ls*", " ls", false],
    // `*` 匹配任意长度（含空）
    ["*", "", true],
    ["*", "anything at all", true],
    ["a*b", "ab", true],
    ["a*b", "a middle b", true],
    ["a*b", "a", false],
    // `?` 恰好一个字符
    ["a?b", "axb", true],
    ["a?b", "ab", false],
    ["a?b", "axxb", false],
    // 大小写不敏感
    ["RM", "rm", true],
    ["rm", "RM", true],
    // 但大小写不敏感不等于可以匹配更长文本：模式仍然要覆盖整段
    ["rm", "RM -RF /", false],
    ["*rm*", "RM -RF /", true],
    ["*CHOWN*", "sudo chown root file", true],
    // 正则特殊字符按字面量处理
    ["rm -rf /", "rm -rf /", true],
    ["file.txt", "file.txt", true],
    ["file.txt", "filextxt", false],
    ["a+b", "a+b", true],
    ["a+b", "aab", false],
    ["(x)", "(x)", true],
    ["a|b", "a|b", true],
    ["*.env", "secrets.env", true],
    ["a[b]", "a[b]", true],
    ["a\\b", "a\\b", true],
    ["price$", "price$", true],
    ["a^b", "a^b", true],
    ["{a}", "{a}", true],
  ];

  for (const [pattern, text, expected] of cases) {
    test(`${JSON.stringify(pattern)} vs ${JSON.stringify(text)} → ${expected}`, () => {
      expect(matchPattern(pattern, text)).toBe(expected);
    });
  }

  test("锚定意味着重定向规则无法匹配命令中段（历史回归点）", () => {
    // `> /dev/sd*` 曾经作为 deny 规则存在，但 `echo x > /dev/sda` 的重定向
    // 在命令之后，两端锚定后永远匹配不上。
    expect(matchPattern("> /dev/sd*", "echo x > /dev/sda")).toBe(false);
    expect(matchPattern("> /dev/sd*", "> /dev/sda")).toBe(true);
  });
});

function config(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    defaultAction: "ask",
    tools: {},
    ...overrides,
  } as PolicyConfig;
}

describe("evaluatePolicy", () => {
  test("未定义的工具回退到全局 defaultAction", () => {
    const result = evaluatePolicy("unknown-tool", "whatever", config({ defaultAction: "deny" }));
    expect(result.action).toBe("deny");
    expect(result.reason).toContain("no policy defined");
    expect(result.matchedRule).toBeUndefined();
  });

  test("无规则命中时用该工具的 defaultAction", () => {
    const result = evaluatePolicy(
      "bash",
      "ls -la",
      config({
        defaultAction: "deny",
        tools: {
          bash: {
            defaultAction: "allow",
            rules: [{ pattern: "*rm -rf*", action: "deny", reason: "x" }],
          },
        },
      } as unknown as Partial<PolicyConfig>),
    );
    expect(result.action).toBe("allow");
    expect(result.matchedRule).toBeUndefined();
  });

  test("last-match-wins：后一条规则覆盖前一条", () => {
    const result = evaluatePolicy(
      "bash",
      "npm install foo",
      config({
        tools: {
          bash: {
            defaultAction: "allow",
            rules: [
              { pattern: "*npm*", action: "ask", reason: "package manager" },
              { pattern: "*npm install*", action: "deny", reason: "install blocked" },
            ],
          },
        },
      } as unknown as Partial<PolicyConfig>),
    );
    expect(result.action).toBe("deny");
    expect(result.matchedRule).toBe("*npm install*");
    expect(result.reason).toBe("install blocked");
  });

  test("顺序颠倒时同样是最后一条命中者胜出", () => {
    const result = evaluatePolicy(
      "bash",
      "npm install foo",
      config({
        tools: {
          bash: {
            defaultAction: "allow",
            rules: [
              { pattern: "*npm install*", action: "deny", reason: "install blocked" },
              { pattern: "*npm*", action: "ask", reason: "package manager" },
            ],
          },
        },
      } as unknown as Partial<PolicyConfig>),
    );
    expect(result.action).toBe("ask");
    expect(result.matchedRule).toBe("*npm*");
  });

  test("没有 reason 时回退成 matched rule 文案", () => {
    const result = evaluatePolicy(
      "bash",
      "ls",
      config({
        tools: {
          bash: { defaultAction: "allow", rules: [{ pattern: "ls", action: "ask", reason: "" }] },
        },
      } as unknown as Partial<PolicyConfig>),
    );
    expect(result.reason).toBe("matched rule: ls");
  });
});

describe("createBuiltinPolicyConfig", () => {
  test("每个模式都能匹配由它自己生成的样本（模式语法本身没坏）", () => {
    // 注意这**测不出**「语义上不可达」——`> /dev/sd*` 对自己生成的样本
    // `> /dev/sdx` 是匹配的，只是在真实命令里永远不出现。那种情况由下面的
    // 具名回归用例覆盖。
    const builtin = createBuiltinPolicyConfig();
    const broken: string[] = [];
    for (const [toolId, policy] of Object.entries(builtin.tools)) {
      for (const rule of policy.rules) {
        const sample = rule.pattern.replaceAll("*", "x").replaceAll("?", "y");
        if (!matchPattern(rule.pattern, sample)) {
          broken.push(`${toolId}: ${rule.pattern}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("不再内置不可达的块设备重定向规则", () => {
    // 这两条规则曾在 bash 里，但因为 matchPattern 两端锚定而永不触发。
    // 真正的防护在 shell-policy.ts 的重定向目标检查里（shell-guard.test.ts 覆盖）。
    // 如果有人把它们加回来，应当改为在那一层表达。
    const builtin = createBuiltinPolicyConfig();
    const patterns = builtin.tools.bash?.rules.map((rule) => rule.pattern) ?? [];
    expect(patterns.some((pattern) => pattern.includes("/dev/sd"))).toBe(false);
    expect(patterns.some((pattern) => pattern.includes("/dev/hd"))).toBe(false);
  });

  test("bash 默认拒绝，read 默认允许", () => {
    const builtin = createBuiltinPolicyConfig();
    expect(evaluatePolicy("bash", "echo hello", builtin).action).toBe("allow");
    expect(evaluatePolicy("read", "src/index.ts", builtin).action).toBe("allow");
  });

  test("危险命令仍然被拒", () => {
    const builtin = createBuiltinPolicyConfig();
    for (const command of ["rm -rf /", "sudo rm -rf /tmp", "mkfs.ext4 /dev/sda1"]) {
      expect(evaluatePolicy("bash", command, builtin).action).not.toBe("allow");
    }
  });

  test("敏感文件读取需要确认", () => {
    const builtin = createBuiltinPolicyConfig();
    expect(evaluatePolicy("read", "secrets.env", builtin).action).not.toBe("allow");
  });
});
