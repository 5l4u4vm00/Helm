// ESLint flat config：typescript-eslint recommended + react-hooks。
// 格式（縮排/引號等）不在此管——沒有引入 formatter，維持既有風格；
// 型別層級的檢查交給 tsc（npm run typecheck / build）。
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // .claude/ 底下可能有平行開發用的 git worktree（整份 repo 的複本）：那些檔案
  // 不在本專案的 tsconfig 內，type-aware 規則會對每一個都報錯。
  { ignores: ["dist/", "src-tauri/", "node_modules/", ".claude/"] },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      // 底線前綴 = 刻意不使用（如解構丟棄值），沿用社群慣例。
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
);
