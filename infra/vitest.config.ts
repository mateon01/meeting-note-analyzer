import { defineConfig } from "vitest/config";

// Each test synthesizes CDK constructs; loading aws-cdk-lib and synthesizing takes several seconds on a busy runner.
export default defineConfig({ test: { testTimeout: 60_000 } });
