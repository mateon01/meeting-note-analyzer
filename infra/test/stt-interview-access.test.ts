import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { expect, it } from "vitest";
import { SttStack } from "../lib/stt-stack.js";
import { loadConfig } from "../lib/config.js";

it("lets the shared STT endpoint read interview audio without granting access to resumes", () => {
  const app = new App({ context: { sttDeployEndpoint: true } });
  const env = { account: "000000000000", region: "us-east-1" };
  const resources = new Stack(app, "InterviewSttResources", { env });
  const dataBucket = new s3.Bucket(resources, "Data");
  const alarmTopic = new sns.Topic(resources, "Alarm");
  const stack = new SttStack(app, "InterviewStt", { env, config: loadConfig(app), dataBucket, alarmTopic });
  const policies = JSON.stringify(Template.fromStack(stack).findResources("AWS::IAM::Policy"));
  expect(policies).toContain("/interview-uploads/*/audio.mp3");
  expect(policies).not.toContain('/interview-uploads/*"');
  expect(policies).not.toContain("resume.pdf");
});
