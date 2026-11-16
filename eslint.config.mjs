import eslint from "@eslint/js"
import stylistic from "@stylistic/eslint-plugin"
import prettier from "eslint-config-prettier"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/lib/**", "**/node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  prettier,
  stylistic.configs.customize({
    arrowParens: true,
    blockSpacing: true,
    braceStyle: "1tbs",
    commaDangle: "always-multiline",
    indent: 2,
    jsx: true,
    quoteProps: "as-needed",
    quotes: "double",
    semi: false,
  }),
  {
    rules: {
      "@stylistic/indent": [
        "error",
        2,
        {
          SwitchCase: 1,
          ignoredNodes: [
            "ConditionalExpression",
            "ConditionalExpression *",
            "TSIntersectionType",
            "TSIntersectionType *",
            "TSUnionType",
            "TSUnionType *",
          ],
        },
      ],
      "@stylistic/generator-star-spacing": "off",
      "@stylistic/indent-binary-ops": "off",
      "@stylistic/member-delimiter-style": [
        "error",
        {
          multiline: {
            delimiter: "none",
            requireLast: false,
          },
          multilineDetection: "brackets",
          singleline: {
            delimiter: "semi",
            requireLast: false,
          },
        },
      ],
      "@stylistic/operator-linebreak": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          disallowTypeAnnotations: false,
          fixStyle: "inline-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      curly: ["error", "all"],
      eqeqeq: ["error", "always"],
      "no-duplicate-imports": [
        "error",
        {
          allowSeparateTypeImports: true,
          includeExports: true,
        },
      ],
      "object-shorthand": ["error", "always"],
      "prefer-template": "error",
    },
  },
)
