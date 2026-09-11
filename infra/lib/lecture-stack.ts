import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as assets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import type * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import { repoPath, type ProjectConfig } from "./config.js";
import { nodeFn } from "./lambda-fn.js";
import { CONSTRAINTS } from "@meeting-notes/shared";
import { lambdaErrorsAlarm, notifyOn } from "./alarms.js";
import { retainRuntimeLogs } from "./runtime-logs.js";
import { sttNotificationFilter } from "./stt-notification-filter.js";

interface LectureStackProps extends StackProps {
  config: ProjectConfig; dataBucket: s3.IBucket; table: ddb.ITable; sttEndpointName: string; sttEndpointArn: string;
  sttSuccessTopic: sns.ITopic; sttErrorTopic: sns.ITopic; alarmTopic: sns.ITopic;
}

/** Additive lecture service: isolated metadata, runtime, search Gateway, and workflow. */
export class LectureStack extends Stack {
  readonly apiFunction: lambda.IFunction;
  /** Lecture metadata; the chat runtime reads it for list_lectures / get_lecture. */
  readonly table: ddb.ITable;
  constructor(scope: Construct, id: string, props: LectureStackProps) {
    super(scope, id, props);
    const { config, dataBucket } = props;
    const modelCallLimit = String(config.lectureMaxModelCalls);
    const searchCallLimit = String(config.lectureMaxSearchCalls);
    const table = this.table = new ddb.Table(this, "LectureTable", {
      partitionKey: { name: "PK", type: ddb.AttributeType.STRING }, sortKey: { name: "SK", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST, timeToLiveAttribute: "ttl", removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    table.addGlobalSecondaryIndex({ indexName: "GSI1", partitionKey: { name: "GSI1PK", type: ddb.AttributeType.STRING }, sortKey: { name: "GSI1SK", type: ddb.AttributeType.STRING } });
    const servicePrincipal = (resource: string) => new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": this.account }, ArnLike: { "aws:SourceArn": `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:${resource}/*` } } });
    const gatewayRole = new iam.Role(this, "SearchRole", { assumedBy: servicePrincipal("gateway") });
    gatewayRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeWebSearch"], resources: [`arn:${this.partition}:bedrock-agentcore:${this.region}:aws:tool/web-search.v1`] }));
    gatewayRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeGateway"], resources: [`arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:gateway/*`] }));
    const gateway = new agentcore.CfnGateway(this, "SearchGateway", { name: `${config.projectName}-lecture-search`, protocolType: "MCP", authorizerType: "AWS_IAM", roleArn: gatewayRole.roleArn });
    gateway.node.addDependency(gatewayRole);
    const searchTarget = new agentcore.CfnGatewayTarget(this, "WebSearch", {
      gatewayIdentifier: gateway.attrGatewayIdentifier, name: "academic-search", credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      // The live CloudFormation ConnectorSource schema exposes ConnectorId only (verified 2026-09-06).
      // The API requires a configuration entry per enabled tool, but nothing may be pinned: a pinned maxResults
      // reached the managed tool as the string "8" through CloudFormation ("integer expected" on every call).
      // Empty parameterValues + a visible query override keeps the tool's own schema; the client sends only that.
      targetConfiguration: { mcp: { connector: { source: { connectorId: "web-search" }, enabled: ["WebSearch"], configurations: [{ name: "WebSearch", parameterValues: {}, parameterOverrides: [{ path: "$.query", visible: true }] }] } } },
    });
    const image = new assets.DockerImageAsset(this, "LectureImage", { directory: repoPath("lecture"), platform: assets.Platform.LINUX_ARM64, exclude: ["tests", ".venv", "__pycache__", ".pytest_cache"] });
    const runtimeRole = new iam.Role(this, "RuntimeRole", { assumedBy: servicePrincipal("runtime") });
    image.repository.grantPull(runtimeRole);
    table.grantReadWriteData(runtimeRole);
    dataBucket.grantRead(runtimeRole, "lecture-uploads/*");
    dataBucket.grantReadWrite(runtimeRole, "lecture-results/*");
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock:InvokeModel"], resources: [`arn:${this.partition}:bedrock:*::foundation-model/${config.sonnetModel.replace(/^(global|us|eu|au|jp)\./, "")}*`, `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/${config.sonnetModel}`] }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeGateway"], resources: [gateway.attrGatewayArn] }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ["states:SendTaskSuccess", "states:SendTaskFailure", "states:SendTaskHeartbeat"], resources: ["*"] }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({ actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "ecr:GetAuthorizationToken"], resources: ["*"] }));
    const runtime = new agentcore.CfnRuntime(this, "Runtime", {
      agentRuntimeName: `${config.projectName.replace(/-/g, "_")}_lecture_study`, agentRuntimeArtifact: { containerConfiguration: { containerUri: image.imageUri } }, roleArn: runtimeRole.roleArn,
      protocolConfiguration: "HTTP", networkConfiguration: { networkMode: "PUBLIC" },
      environmentVariables: { AWS_REGION: this.region, DATA_BUCKET: dataBucket.bucketName, LECTURE_TABLE_NAME: table.tableName, LECTURE_MODEL: config.sonnetModel, LECTURE_SEARCH_GATEWAY_URL: gateway.attrGatewayUrl, LECTURE_MAX_MODEL_CALLS: modelCallLimit, LECTURE_MAX_SEARCH_CALLS: searchCallLimit },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
    });
    retainRuntimeLogs(this, "RuntimeLogRetention", runtime.attrAgentRuntimeId);
    runtime.node.addDependency(runtimeRole, searchTarget);
    const environment = { TABLE_NAME: table.tableName, LECTURE_TABLE_NAME: table.tableName, DATA_BUCKET: dataBucket.bucketName,
      STT_ENDPOINT_NAME: props.sttEndpointName, LECTURE_RUNTIME_ARN: runtime.attrAgentRuntimeArn, WEB_ORIGIN: config.siteUrl, VAPID_SECRET_NAME: config.vapidSecretName };
    const processor = nodeFn(this, "Processor", { entry: "services/pipeline/src/handlers/lecture.ts", environment, timeout: Duration.minutes(3), memorySize: 1024 });
    const completeFn = nodeFn(this, "Complete", { entry: "services/pipeline/src/handlers/lecture.ts", environment: { ...environment, TABLE_NAME: props.table.tableName }, timeout: Duration.minutes(2) });
    const callback = nodeFn(this, "SttCallback", { entry: "services/pipeline/src/handlers/transcription-callback.ts", environment: { ...environment, STT_CALLBACK_KIND: "lecture" } });
    for (const fn of [processor, completeFn, callback]) table.grantReadWriteData(fn);
    dataBucket.grantReadWrite(processor);
    // Complete writes the knowledge-base sidecar next to the published run and deletes the superseded run.
    dataBucket.grantReadWrite(completeFn, "lecture-results/*");
    props.table.grantReadWriteData(completeFn); // Shared push subscriptions only; existing meeting API is untouched.
    secrets.Secret.fromSecretNameV2(this, "Vapid", config.vapidSecretName).grantRead(completeFn);
    processor.addToRolePolicy(new iam.PolicyStatement({ actions: ["sagemaker:InvokeEndpointAsync"], resources: [props.sttEndpointArn] }));
    processor.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeAgentRuntime"], resources: [runtime.attrAgentRuntimeArn, `${runtime.attrAgentRuntimeArn}/runtime-endpoint/DEFAULT`] }));
    for (const fn of [processor, callback]) fn.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:SendTaskSuccess", "states:SendTaskFailure"], resources: ["*"] }));
    props.sttSuccessTopic.addSubscription(new subscriptions.LambdaSubscription(callback, { filterPolicyWithMessageBody: sttNotificationFilter("lecture") }));
    props.sttErrorTopic.addSubscription(new subscriptions.LambdaSubscription(callback, { filterPolicyWithMessageBody: sttNotificationFilter("lecture") }));

    const fields = { lectureId: "{% $job.lectureId %}", runId: "{% $job.runId %}" };
    const initialize = sfn.Pass.jsonata(this, "Input", { assign: { job: "{% $states.input %}" } });
    const register = tasks.LambdaInvoke.jsonata(this, "Register", { lambdaFunction: processor,
      payload: sfn.TaskInput.fromObject({ op: "register", lectureId: "{% $states.input.lectureId %}", runId: "{% $states.input.runId %}" }),
      outputs: "{% $states.result.Payload %}",
    });
    const transcribe = tasks.LambdaInvoke.jsonata(this, "Transcribe", { lambdaFunction: processor, integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({ op: "transcribe", ...fields, taskToken: "{% $states.context.Task.Token %}" }), assign: { stt: "{% $states.result %}" }, taskTimeout: sfn.Timeout.duration(Duration.seconds(CONSTRAINTS.sttQueueTtlSec + CONSTRAINTS.sttInvocationTimeoutSec + 900)),
    });
    const prepare = tasks.LambdaInvoke.jsonata(this, "PrepareVideo", { lambdaFunction: processor, integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({ op: "prepare", ...fields, taskToken: "{% $states.context.Task.Token %}", attempt: "{% $states.context.State.RetryCount %}" }),
      taskTimeout: sfn.Timeout.duration(Duration.hours(2)), heartbeatTimeout: sfn.Timeout.duration(Duration.minutes(10)),
    });
    transcribe.addRetry({ errors: ["SttTransient"], interval: Duration.seconds(90), maxAttempts: 1 });
    const normalize = tasks.LambdaInvoke.jsonata(this, "Normalize", { lambdaFunction: processor, payload: sfn.TaskInput.fromObject({ op: "normalize", ...fields, stt: "{% $stt %}" }) });
    const analyze = tasks.LambdaInvoke.jsonata(this, "AnalyzeSlides", { lambdaFunction: processor, integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({ op: "analyze", ...fields, taskToken: "{% $states.context.Task.Token %}", attempt: "{% $states.context.State.RetryCount %}" }), assign: { result: "{% $states.result %}" },
      // Allow extra callback time for long lectures with many visual sections.
      taskTimeout: sfn.Timeout.duration(Duration.hours(12)), heartbeatTimeout: sfn.Timeout.duration(Duration.minutes(10)),
    });
    // Bedrock outages longer than the runtime's own backoff (~1.5 min) come back as LectureTransient: run the step
    // again after 3 and 6 minutes. Completed scenes and pages are cached, so a retried step resumes where it stopped.
    for (const step of [prepare, analyze]) step.addRetry({ errors: ["LectureTransient"], interval: Duration.minutes(3), backoffRate: 2, maxAttempts: 2 });
    const complete = tasks.LambdaInvoke.jsonata(this, "CompleteLecture", { lambdaFunction: completeFn, payload: sfn.TaskInput.fromObject({ op: "complete", ...fields, result: "{% $result %}" }) });
    const failed = tasks.LambdaInvoke.jsonata(this, "MarkFailed", { lambdaFunction: processor, payload: sfn.TaskInput.fromObject({ op: "failed", ...fields, error: "{% $states.input.error %}" }) });
    failed.next(sfn.Fail.jsonata(this, "LectureFailed"));
    const process = sfn.Parallel.jsonata(this, "Process");
    process.branch(register.next(prepare).next(transcribe).next(normalize).next(analyze).next(complete));
    process.addCatch(failed, { outputs: { error: "{% $states.errorOutput %}" } });
    const machine = new sfn.StateMachine(this, "Pipeline", { stateMachineName: `${config.projectName}-lecture-pipeline`, queryLanguage: sfn.QueryLanguage.JSONATA,
      definitionBody: sfn.DefinitionBody.fromChainable(initialize.next(process)), timeout: Duration.hours(24), tracingEnabled: true,
      logs: { destination: new logs.LogGroup(this, "PipelineLogs", { retention: logs.RetentionDays.ONE_MONTH }), level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });
    notifyOn(this, "LectureFailedAlarm", machine.metricFailed(), props.alarmTopic, "Lecture processing failed");
    notifyOn(this, "LectureTimeoutAlarm", machine.metricTimedOut(), props.alarmTopic, "Lecture processing timed out");
    lambdaErrorsAlarm(this, "LectureCallbackErrors", callback, props.alarmTopic, "Lecture STT callback failed");
    const api = nodeFn(this, "Api", { entry: "services/api/src/handlers/lectures.ts", environment: { LECTURE_TABLE_NAME: table.tableName, DATA_BUCKET: dataBucket.bucketName, UPLOAD_BASE_URL: config.siteUrl, LECTURE_STATE_MACHINE_ARN: machine.stateMachineArn }, timeout: Duration.seconds(29), memorySize: 1024 });
    table.grantReadWriteData(api);
    for (const prefix of ["lecture-uploads/*", "lecture-results/*"]) { dataBucket.grantReadWrite(api, prefix); dataBucket.grantDelete(api, prefix); }
    machine.grantStartExecution(api);
    this.apiFunction = api;
    new CfnOutput(this, "StateMachineArn", { value: machine.stateMachineArn });
    new CfnOutput(this, "RuntimeArn", { value: runtime.attrAgentRuntimeArn });
    new CfnOutput(this, "SearchGatewayUrl", { value: gateway.attrGatewayUrl });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
