import { App, Tags } from "aws-cdk-lib";
import { loadConfig } from "../lib/config.js";
import { DataStack } from "../lib/data-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { SttStack } from "../lib/stt-stack.js";
import { AgentStack } from "../lib/agent-stack.js";
import { PipelineStack } from "../lib/pipeline-stack.js";
import { ApiStack } from "../lib/api-stack.js";
import { ChatStack } from "../lib/chat-stack.js";
import { WebStack } from "../lib/web-stack.js";
import { LectureStack } from "../lib/lecture-stack.js";

const app = new App();
const config = loadConfig(app);
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };
const prefix = config.stackPrefix;

const data = new DataStack(app, `${prefix}-Data`, { env, config });
const auth = new AuthStack(app, `${prefix}-Auth`, { env, config });
const stt = new SttStack(app, `${prefix}-Stt`, { env, config, dataBucket: data.dataBucket, alarmTopic: data.alarmTopic });
const agent = new AgentStack(app, `${prefix}-Agent`, { env, config, dataBucket: data.dataBucket, table: data.table });
const lecture = new LectureStack(app, `${prefix}-Lecture`, {
  env, config, dataBucket: data.dataBucket, table: data.table, sttEndpointName: stt.endpointName,
  sttEndpointArn: stt.endpointArn, sttSuccessTopic: stt.successTopic, sttErrorTopic: stt.errorTopic, alarmTopic: data.alarmTopic,
});
const chat = new ChatStack(app, `${prefix}-Chat`, {
  env,
  config,
  dataBucket: data.dataBucket,
  table: data.table,
  pipelineMemoryId: agent.memoryId,
  pipelineMemoryArn: agent.memoryArn,
  alarmTopic: data.alarmTopic,
  lectureTable: lecture.table,
});
const pipeline = new PipelineStack(app, `${prefix}-Pipeline`, {
  env,
  config,
  dataBucket: data.dataBucket,
  table: data.table,
  sttEndpointName: stt.endpointName,
  sttEndpointArn: stt.endpointArn,
  sttSuccessTopic: stt.successTopic,
  sttErrorTopic: stt.errorTopic,
  agentRuntimeArn: agent.runtimeArn,
  memoryId: agent.memoryId,
  memoryArn: agent.memoryArn,
  alarmTopic: data.alarmTopic,
});
const api = new ApiStack(app, `${prefix}-Api`, {
  env,
  config,
  dataBucket: data.dataBucket,
  table: data.table,
  lectureTable: lecture.table,
  issuerUrl: auth.issuerUrl,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
  stateMachineArn: pipeline.stateMachine.stateMachineArn,
  memoryId: agent.memoryId,
  memoryArn: agent.memoryArn,
  chatMemoryId: chat.chatMemoryId,
  chatMemoryArn: chat.chatMemoryArn,
  lectureApiFunction: lecture.apiFunction,
  interviewApiFunction: lecture.interviewApiFunction,
  guestApiFunction: lecture.guestApiFunction,
});
new WebStack(app, `${prefix}-Web`, {
  env,
  config,
  apiDomain: api.apiDomain,
  table: data.table,
  userPoolId: auth.userPool.userPoolId,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
  chatRuntimeArn: chat.chatRuntimeArn,
  chatRuntimeVersion: chat.chatRuntimeVersion,
  alarmTopic: data.alarmTopic,
  dataBucket: data.dataBucket,
  webConfig: {
    cognitoAuthority: auth.issuerUrl,
    cognitoClientId: auth.userPoolClient.userPoolClientId,
    cognitoDomain: auth.hostedUiBaseUrl,
    apiBase: "/api",
  },
});

Tags.of(app).add("Project", config.projectName);
