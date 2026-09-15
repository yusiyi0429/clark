import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // 第二台 dev 的产出目录（`NEXT_DIST_DIR`，见 next.config.ts）。和 `.next/**` 同一条
    // 理由，只是名字由那个环境变量定 —— 漏了它，`pnpm lint` 会去 lint 一份编译产物，
    // 一次几百条报错，而它们跟源码没有任何关系。
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Archived pre-project prototypes and specs. Reference material, not build input.
    "docs/**",
    // 工具自己的目录。里面会出现整份仓库的副本（agent worktree），照 lint 的话同一个
    // 文件会被报两遍，而且门会被一份不进构建的副本别住 —— 上面那条 `docs/**` 也管不到
    // 副本里的 `docs/`，因为它是相对配置文件根目录的。
    ".claude/**",
  ]),
]);

export default eslintConfig;
