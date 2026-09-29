import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      "authentication/authentication": "src/authentication/authentication.ts",
      "authorization/authorization": "src/authorization/authorization.ts",
      "cors/cors": "src/cors/cors.ts",
      "csrf/csrf": "src/csrf/csrf.ts",
      "secure-headers/secure-headers": "src/secure-headers/secure-headers.ts",
    },
    format: "esm",
    dts: true,
    fixedExtension: false,
    clean: true,
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**"],
    printWidth: 120,
    singleQuote: false,
    semi: true,
  },
});
