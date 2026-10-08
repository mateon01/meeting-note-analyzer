import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { expect, it } from "vitest";
import { dataLifecycleRules } from "../lib/data-stack.js";

it("tiers user media automatically from day zero and keeps the STT scratch expiry", () => {
  const stack = new Stack(new App(), "LifecycleTest");
  new s3.Bucket(stack, "Bucket", { lifecycleRules: dataLifecycleRules() });
  const rules = Template.fromStack(stack).findResources("AWS::S3::Bucket")["Bucket83908E77"]!.Properties.LifecycleConfiguration.Rules as { Prefix?: string; Transitions?: { StorageClass: string; TransitionInDays: number }[]; ExpirationInDays?: number; Status: string }[];
  const tiered = rules.filter((r) => r.Transitions?.some((t) => t.StorageClass === "INTELLIGENT_TIERING" && t.TransitionInDays === 0)).map((r) => r.Prefix);
  expect(tiered.sort()).toEqual(["interview-results/", "interview-uploads/", "lecture-results/", "lecture-uploads/", "uploads/"]);
  expect(rules.find((r) => r.Prefix === "stt/")).toMatchObject({ ExpirationInDays: 30, Status: "Enabled" });
  // Meeting documents, transcripts and model files are outside the transition rules.
  for (const prefix of ["results/", "transcripts/", "models/"]) {
    expect(rules.map((r) => r.Prefix)).not.toContain(prefix);
  }
  expect(rules).toContainEqual({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 }, Status: "Enabled" });
  expect(rules).toContainEqual({ NoncurrentVersionExpiration: { NoncurrentDays: 30 }, Status: "Enabled" });
});
